package jp.chikuwachat.android.sync

import android.util.Log
import jp.chikuwachat.android.api.AiRunOut
import jp.chikuwachat.android.api.AiRunUpdated
import jp.chikuwachat.android.api.AiStatusOut
import jp.chikuwachat.android.api.AiSummaryIn
import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.ErrorMessages
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject

/** M66: the AI endpoints everyone may call (docs/AI.md §5), apart from SyncApi like TaskApi (ApiClient and the test fakes). */
interface AiApi {
    suspend fun aiStatus(): AiStatusOut
    suspend fun createSummary(body: AiSummaryIn): AiRunOut
    suspend fun aiRun(runId: String): AiRunOut
}

/** What to summarize: `scope` "unread" / "recent" (with `days` 1 or 7) / "thread" (with `threadId`, the parent). */
data class AiSummaryRequest(val channelId: String, val scope: String, val threadId: String? = null, val days: Int? = null)

enum class AiSummaryPhase { REQUESTING, RUNNING, DONE, FAILED }

/** The summary sheet: the request, the run once the server took it, and the failure in words (refused, or the run failed). */
data class AiSummaryState(val request: AiSummaryRequest, val run: AiRunOut? = null, val error: String? = null) {
    val phase: AiSummaryPhase get() = when {
        error != null -> AiSummaryPhase.FAILED
        run == null -> AiSummaryPhase.REQUESTING
        run.status == "done" -> AiSummaryPhase.DONE
        run.status == "failed" -> AiSummaryPhase.FAILED
        else -> AiSummaryPhase.RUNNING
    }

    /** What the sheet says when it failed: the refusal, else the run's own error. */
    val failureText: String? get() = when {
        error != null -> error
        run?.status == "failed" -> "要約できませんでした" + (run.error?.takeIf { it.isNotBlank() }?.let { ": $it" } ?: "")
        else -> null
    }
}

/**
 * M66 (docs/AI.md §5, §6): what this device knows of AI. The status (read on every (re)connect: a 404 means a server
 * without AI, and every entry point stays hidden) names the AI bots, which get 「AI」 instead of 「BOT」; one summary sheet
 * at a time follows its run through ai.run_updated, and reads it again (GET /ai/runs/{id}) after reconnecting since the
 * event may have been missed. Runs on the app's main thread (the controller's scope), like TaskHub.
 */
class AiHub(
    private val api: AiApi?,
    private val scope: CoroutineScope,
    /** Minutes east of UTC now (JST +540): the server's 「直近 N 日」 and 「未読 (無ければ直近 1 日)」 count in my day. */
    private val tzOffsetMinutes: () -> Int = { java.util.TimeZone.getDefault().getOffset(System.currentTimeMillis()) / 60_000 },
) {
    /** Null until read (and when it could not be read): nothing AI is shown then. */
    var status: AiStatusOut? = null
        private set
    var summary: AiSummaryState? = null
        private set
    /** Runs seen in events, so one that arrives before its POST answer is not lost (the latest few only). */
    private val seen = LinkedHashMap<String, AiRunOut>()
    private var ticket = 0
    private val _version = MutableStateFlow(0)
    /** Bumped by every change: the screens read [status] and [summary] again. */
    val version: StateFlow<Int> = _version

    private fun changed() {
        _version.value = _version.value + 1
    }

    val available: Boolean get() = status?.available == true
    val summaryAvailable: Boolean get() = status?.let { it.available && it.summaryAvailable } == true

    /** The AI bots' user ids (their messages and mention candidates say 「AI」). */
    val botUserIds: Set<String> get() = status?.agents?.map { it.botUserId }?.toSet() ?: emptySet()

    /** The bot's AI name, or null when the user is not an AI bot. */
    fun agentName(userId: String): String? = status?.agents?.firstOrNull { it.botUserId == userId }?.name

    // --- status --------------------------------------------------------------------------------------

    suspend fun loadStatus() {
        val api = api ?: return
        try {
            status = api.aiStatus()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (serverLacksAi(e)) status = AiStatusOut()
            else Log.w("AiHub", "could not read the AI status", e) // kept as it was: the next reconnect reads it again
        }
        changed()
    }

    // --- the summary sheet ---------------------------------------------------------------------------

    /** Opens the sheet and asks the server; the run then moves on through ai.run_updated. */
    suspend fun requestSummary(request: AiSummaryRequest) {
        val api = api ?: return
        val mine = ++ticket
        summary = AiSummaryState(request)
        changed()
        val body = AiSummaryIn(
            channelId = request.channelId, scope = request.scope, threadId = request.threadId, days = request.days,
            tzOffsetMinutes = if (request.scope == "thread") null else tzOffsetMinutes(),
        )
        try {
            val run = api.createSummary(body)
            if (ticket != mine || summary == null) return
            summary = AiSummaryState(request, advance(seen[run.id], run))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (ticket != mine || summary == null) return
            summary = AiSummaryState(request, error = describe(e))
            // Turned off or out of budget since the status was read: the entry points follow the server again.
            if (e is ApiException.Api && (e.code == "ai_unavailable" || e.code == "ai_budget_exceeded")) scope.launch { loadStatus() }
        }
        changed()
    }

    /** The same request again (「もう一度」 after a failure). */
    suspend fun retry() {
        summary?.request?.let { requestSummary(it) }
    }

    fun closeSummary() {
        if (summary == null) return
        ticket += 1 // an answer still on its way is dropped
        summary = null
        changed()
    }

    /** Reads the open sheet's run again (after reconnecting: an ai.run_updated may have been missed). */
    suspend fun refreshRun() {
        val api = api ?: return
        val run = summary?.run ?: return
        if (run.finished) return
        val mine = ticket
        try {
            val now = api.aiRun(run.id)
            if (ticket != mine || summary?.run?.id != now.id) return
            put(now)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Log.w("AiHub", "could not read the summary run again", e) // the next reconnect or event tries again
        }
    }

    // --- events ---------------------------------------------------------------------------------------

    fun applyEvent(event: String, data: JsonObject) {
        if (event != "ai.run_updated") return
        val run = runCatching { Codec.snake.decodeFromJsonElement(AiRunUpdated.serializer(), data).run }
            .onFailure { Log.w("AiHub", "unreadable ai.run_updated", it) }.getOrNull() ?: return
        put(run)
    }

    private fun put(run: AiRunOut) {
        val kept = advance(seen[run.id], run)
        seen.remove(run.id)
        seen[run.id] = kept
        while (seen.size > SEEN_MAX) seen.remove(seen.keys.first())
        val open = summary ?: return
        if (open.run?.id != run.id || open.error != null) return
        summary = open.copy(run = advance(open.run, kept))
        changed()
    }

    // --- lifecycle --------------------------------------------------------------------------------------

    /** After (re)connecting: the status, and the open sheet's run (docs/AI.md §5). */
    fun online() {
        if (api == null) return
        scope.launch { loadStatus() }
        if (summary?.run?.finished == false) scope.launch { refreshRun() }
    }

    fun stop() {
        status = null
        summary = null
        seen.clear()
        ticket += 1
        changed()
    }

    companion object {
        private const val SEEN_MAX = 20

        /** A server from before M65 has no /ai routes: any 404 there means no AI (docs/AI.md §5). */
        fun serverLacksAi(e: Throwable): Boolean = e is ApiException.Api && e.status == 404

        private fun rank(status: String): Int = when (status) {
            "pending" -> 0
            "running" -> 1
            "done", "failed" -> 2
            else -> 0
        }

        /** The newer of two copies of a run: events may arrive late or twice, and a finished run never goes back. */
        fun advance(held: AiRunOut?, incoming: AiRunOut): AiRunOut =
            if (held == null || held.id != incoming.id || rank(incoming.status) >= rank(held.status)) incoming else held

        /** Japanese words for the AI codes (docs/AI.md §5); the shared table wins once it has them. */
        val texts: Map<String, String> = mapOf(
            "ai_unavailable" to "AI は今使えません。管理者に確認してください",
            "ai_budget_exceeded" to "今月の AI の予算の上限に達しました。来月まで要約は使えません",
            "ai_daily_limit" to "今日の AI の利用回数の上限に達しました。明日またお試しください",
            "ai_run_not_found" to "要約が見つかりません",
        )

        fun describe(e: Throwable): String = when (e) {
            is ApiException.Api -> ErrorMessages.byCode[e.code] ?: texts[e.code]
                ?: ErrorMessages.byStatus[if (e.status >= 500) "5xx" else e.status.toString()] ?: ErrorMessages.UNKNOWN
            is ApiException.Network -> ErrorMessages.NETWORK
            else -> ErrorMessages.UNKNOWN
        }
    }
}
