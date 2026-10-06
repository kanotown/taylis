package jp.chikuwachat.android

import jp.chikuwachat.android.api.AiAgentPublic
import jp.chikuwachat.android.api.AiRunOut
import jp.chikuwachat.android.api.AiRunUpdated
import jp.chikuwachat.android.api.AiStatusOut
import jp.chikuwachat.android.api.AiSummaryIn
import jp.chikuwachat.android.api.AiSummaryTargetOut
import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.ErrorMessages
import jp.chikuwachat.android.api.UserPublic
import jp.chikuwachat.android.sync.AiApi
import jp.chikuwachat.android.sync.AiHub
import jp.chikuwachat.android.sync.AiSummaryPhase
import jp.chikuwachat.android.sync.AiSummaryRequest
import jp.chikuwachat.android.sync.AiSummaryState
import jp.chikuwachat.android.sync.EngineOptions
import jp.chikuwachat.android.sync.EngineStatus
import jp.chikuwachat.android.sync.Store
import jp.chikuwachat.android.sync.SyncEngine
import jp.chikuwachat.android.ui.AiTexts
import jp.chikuwachat.android.ui.BarMenu
import jp.chikuwachat.android.ui.BarMenuItem
import jp.chikuwachat.android.ui.Mentions
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** M66 (docs/AI.md §5, §6): the AI status, the summary sheet's run, its errors, and the words around them. */
class AiTest {
    private class World(val server: FakeServer, val api: FakeServer.Api, val bob: String, val botId: String, val channelId: String, val store: Store, val engine: SyncEngine, val scope: CoroutineScope)

    private suspend fun settle(engine: SyncEngine) = repeat(3) { engine.idle() }

    private suspend fun world(status: AiStatusOut? = null, withBot: Boolean = true): World {
        val server = FakeServer()
        val alice = server.addUser("alice"); val bob = server.addUser("bob")
        val bot = server.addUser("ai-chikuwa", role = "bot")
        val channel = server.createChannel("general", alice.id)
        server.join(channel.id, bob.id)
        if (withBot) server.join(channel.id, bot.id)
        server.aiStatus = status ?: AiStatusOut(true, true, listOf(AiAgentPublic("agent-1", bot.id, "ちくわ", "claude-opus-5-5")))
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val store = Store()
        val api = server.api(bob.id)
        val engine = SyncEngine(api, server.connector(bob.id), "ws://fake", store, { "t" }, scope, EngineOptions(sleep = {}, reconnectMinMs = 0))
        engine.start(); settle(engine)
        return World(server, api, bob.id, bot.id, channel.id, store, engine, scope)
    }

    private fun World.finish() {
        engine.stop(); scope.cancel()
    }

    private suspend fun World.reconnect() {
        server.disconnect(bob)
        repeat(50) { if (engine.status.value != EngineStatus.ONLINE) settle(engine) }
        settle(engine)
        assertEquals(EngineStatus.ONLINE, engine.status.value)
    }

    // --- decoding ---------------------------------------------------------------------------------------

    @Test fun decodesLenientlyAndEncodesOnlyWhatIsSet() {
        val status = Codec.snake.decodeFromString(
            AiStatusOut.serializer(),
            """{"available":true,"summary_available":false,"agents":[{"id":"a","bot_user_id":"u","name":"ちくわ","model":"claude-opus-5-5","extra":1}],"future":"x"}""",
        )
        assertEquals(AiStatusOut(true, false, listOf(AiAgentPublic("a", "u", "ちくわ", "claude-opus-5-5"))), status)
        assertEquals(AiStatusOut(), Codec.snake.decodeFromString(AiStatusOut.serializer(), "{}"))

        val run = Codec.snake.decodeFromString(
            AiRunOut.serializer(),
            """{"id":"r","kind":"summary","status":"done","channel_id":"c","thread_id":null,"scope":"recent","days":7,"output":"# 要約\n- a","error":null,"omitted_count":3,"created_at":"t","finished_at":"t2","cost_usd":0.1}""",
        )
        assertEquals("# 要約\n- a", run.output)
        assertEquals(3, run.omittedCount)
        assertNull(run.threadId)
        assertTrue(run.finished)
        val bare = Codec.snake.decodeFromString(AiRunOut.serializer(), """{"id":"r"}""")
        assertEquals("pending", bare.status)
        assertFalse(bare.finished)

        val event = Codec.snake.decodeFromJsonElement(AiRunUpdated.serializer(), Codec.plain.parseToJsonElement("""{"run":{"id":"r","status":"running"}}"""))
        assertEquals("running", event.run.status)

        val body = Codec.snake.encodeToJsonElement(AiSummaryIn.serializer(), AiSummaryIn("c", "unread", tzOffsetMinutes = 540)).jsonObject
        assertEquals(setOf("channel_id", "scope", "tz_offset_minutes"), body.keys)
    }

    // --- status ----------------------------------------------------------------------------------------

    @Test fun statusIsReadOnStartAndAgainAfterReconnecting() = runBlocking {
        val w = world()
        assertEquals(1, w.api.aiStatusCalls)
        assertTrue(w.engine.ai.available)
        assertTrue(w.engine.ai.summaryAvailable)
        assertEquals(setOf(w.botId), w.engine.ai.botUserIds)
        assertEquals("ちくわ", w.engine.ai.agentName(w.botId))

        w.server.aiStatus = AiStatusOut(available = true, summaryAvailable = false, agents = w.server.aiStatus!!.agents) // budget spent
        w.reconnect()
        assertEquals(2, w.api.aiStatusCalls)
        assertTrue(w.engine.ai.available)
        assertFalse(w.engine.ai.summaryAvailable)
        w.finish()
    }

    @Test fun aServerWithoutAiHidesEverything() = runBlocking {
        val w = world()
        w.server.aiStatus = null // 404 from now on
        w.reconnect()
        assertEquals(AiStatusOut(), w.engine.ai.status)
        assertFalse(w.engine.ai.available)
        assertFalse(w.engine.ai.summaryAvailable)
        assertEquals(emptySet<String>(), w.engine.ai.botUserIds)
        w.finish()
    }

    @Test fun aFailedStatusReadKeepsWhatWasKnown() = runBlocking {
        val server = FakeServer()
        val hub = AiHub(server.api(server.addUser("bob").id).also { it.pendingFailure = ApiException.Network(RuntimeException("down")) }, CoroutineScope(Dispatchers.Unconfined))
        server.aiStatus = AiStatusOut(true, true)
        hub.loadStatus()
        assertNull(hub.status) // unknown: nothing shown
        hub.loadStatus()
        assertTrue(hub.summaryAvailable)
    }

    // --- the summary sheet ------------------------------------------------------------------------------

    @Test fun summaryFollowsItsRunThroughEvents() = runBlocking {
        val w = world()
        val hub = w.engine.ai
        hub.requestSummary(AiSummaryRequest(w.channelId, "recent", days = 7))
        val sent = w.api.summaryRequests.single()
        assertEquals("recent", sent.scope)
        assertEquals(7, sent.days)
        assertTrue(sent.tzOffsetMinutes != null)
        assertEquals(AiSummaryPhase.RUNNING, hub.summary!!.phase)
        assertEquals("順番を待っています…", AiTexts.progress(hub.summary!!))
        val runId = hub.summary!!.run!!.id

        w.server.advanceAiRun(runId, "running"); settle(w.engine)
        assertEquals("要約を作成しています…", AiTexts.progress(hub.summary!!))
        w.server.advanceAiRun(runId, "done", output = "## 決まったこと\n- 発表は金曜", omittedCount = 12); settle(w.engine)
        val done = hub.summary!!
        assertEquals(AiSummaryPhase.DONE, done.phase)
        assertEquals("## 決まったこと\n- 発表は金曜", done.run!!.output)
        assertEquals("古い 12 件は省きました", AiTexts.omittedNote(done.run!!.omittedCount))
        assertNull(AiTexts.progress(done))

        hub.closeSummary()
        assertNull(hub.summary)
        w.finish()
    }

    @Test fun threadSummarySendsTheParentAndNoZone() = runBlocking {
        val w = world()
        val (parent, _) = w.server.post(w.channelId, w.bob, "相談です")
        w.engine.ai.requestSummary(AiTexts.threadRequest(w.channelId, parent.id))
        val sent = w.api.summaryRequests.single()
        assertEquals("thread", sent.scope)
        assertEquals(parent.id, sent.threadId)
        assertNull(sent.tzOffsetMinutes)
        assertEquals(AiSummaryPhase.RUNNING, w.engine.ai.summary!!.phase)
        w.finish()
    }

    @Test fun aMissedEventIsReadAgainAfterReconnecting() = runBlocking {
        val w = world()
        val hub = w.engine.ai
        hub.requestSummary(AiSummaryRequest(w.channelId, "unread"))
        val runId = hub.summary!!.run!!.id
        w.server.advanceAiRun(runId, "done", output = "要約", silent = true) // the event is lost
        assertEquals(AiSummaryPhase.RUNNING, hub.summary!!.phase)
        w.server.disconnect(w.bob)
        repeat(50) { if (w.engine.status.value != EngineStatus.ONLINE) settle(w.engine) }
        settle(w.engine)
        assertEquals(listOf(runId), w.api.aiRunCalls)
        assertEquals(AiSummaryPhase.DONE, hub.summary!!.phase)
        assertEquals("要約", hub.summary!!.run!!.output)

        w.reconnect() // finished: not read again
        assertEquals(listOf(runId), w.api.aiRunCalls)
        w.finish()
    }

    @Test fun aFailedRunSaysWhy() = runBlocking {
        val w = world()
        val hub = w.engine.ai
        hub.requestSummary(AiSummaryRequest(w.channelId, "unread"))
        w.server.advanceAiRun(hub.summary!!.run!!.id, "failed", error = "API のエラーが続きました"); settle(w.engine)
        assertEquals(AiSummaryPhase.FAILED, hub.summary!!.phase)
        assertEquals("要約できませんでした: API のエラーが続きました", hub.summary!!.failureText)
        hub.retry()
        assertEquals(2, w.api.summaryRequests.size)
        assertEquals(AiSummaryPhase.RUNNING, hub.summary!!.phase)
        w.finish()
    }

    @Test fun refusalsAreWordedInJapanese() = runBlocking {
        val w = world()
        val hub = w.engine.ai
        val request = AiSummaryRequest(w.channelId, "unread")
        for (code in listOf("ai_daily_limit", "ai_budget_exceeded")) {
            w.server.aiSummaryRefusals.add(ApiException.Api(429, code, "limit"))
            hub.requestSummary(request)
            assertEquals(AiSummaryPhase.FAILED, hub.summary!!.phase)
            assertEquals(ErrorMessages.byCode[code] ?: AiHub.texts.getValue(code), hub.summary!!.failureText)
        }
        val before = w.api.aiStatusCalls
        w.server.aiStatus = AiStatusOut(available = false, summaryAvailable = false)
        hub.requestSummary(request)
        assertEquals(ErrorMessages.byCode["ai_unavailable"] ?: AiHub.texts.getValue("ai_unavailable"), hub.summary!!.failureText)
        assertEquals(before + 1, w.api.aiStatusCalls) // turned off meanwhile: the status is read again
        assertFalse(w.engine.ai.summaryAvailable)

        w.api.pendingFailure = ApiException.Network(RuntimeException("offline"))
        hub.requestSummary(request)
        assertEquals(ErrorMessages.NETWORK, hub.summary!!.failureText)

        w.server.aiStatus = AiStatusOut(true, true)
        hub.requestSummary(AiSummaryRequest("00000000-0000-7000-8000-999999999999", "unread"))
        assertEquals(ErrorMessages.byCode["channel_not_found"], hub.summary!!.failureText)
        w.finish()
    }

    @Test fun describeMapsEveryKind() {
        for (code in listOf("ai_unavailable", "ai_budget_exceeded", "ai_daily_limit")) {
            val text = AiHub.describe(ApiException.Api(if (code == "ai_unavailable") 409 else 429, code, "x"))
            assertTrue(text != ErrorMessages.UNKNOWN && text.isNotBlank())
        }
        assertEquals(ErrorMessages.NETWORK, AiHub.describe(ApiException.Network(RuntimeException())))
        assertEquals(ErrorMessages.UNKNOWN, AiHub.describe(IllegalStateException("x")))
        assertEquals(ErrorMessages.byStatus["5xx"], AiHub.describe(ApiException.Api(503, "something_new", "x")))
    }

    // --- ordering and races -----------------------------------------------------------------------------

    private class GatedApi : AiApi {
        val gate = CompletableDeferred<AiRunOut>()
        override suspend fun aiStatus() = AiStatusOut(true, true)
        override suspend fun createSummary(body: AiSummaryIn): AiRunOut = gate.await()
        override suspend fun aiRun(runId: String): AiRunOut = throw ApiException.Api(404, "ai_run_not_found", "x")
        override suspend fun summaryTarget(channelId: String): AiSummaryTargetOut = throw ApiException.Api(404, "http_404", "x")
    }

    private fun event(run: AiRunOut): JsonObject = Codec.snake.encodeToJsonElement(AiRunUpdated.serializer(), AiRunUpdated(run)) as JsonObject

    @Test fun anEventBeforeThePostAnswerIsKept() = runBlocking {
        val api = GatedApi()
        val scope = CoroutineScope(Dispatchers.Unconfined)
        val hub = AiHub(api, scope) { 540 }
        val job = scope.launch { hub.requestSummary(AiSummaryRequest("c", "unread")) }
        assertEquals(AiSummaryPhase.REQUESTING, hub.summary!!.phase)
        assertEquals("依頼しています…", AiTexts.progress(hub.summary!!))
        hub.applyEvent("ai.run_updated", event(AiRunOut("r1", status = "done", output = "早い")))
        api.gate.complete(AiRunOut("r1", status = "pending"))
        job.join()
        assertEquals(AiSummaryPhase.DONE, hub.summary!!.phase)
        assertEquals("早い", hub.summary!!.run!!.output)
    }

    @Test fun aFinishedRunNeverGoesBackAndOtherRunsAreIgnored() {
        val done = AiRunOut("r", status = "done", output = "x")
        assertEquals(done, AiHub.advance(done, AiRunOut("r", status = "running")))
        assertEquals("running", AiHub.advance(AiRunOut("r", status = "pending"), AiRunOut("r", status = "running")).status)
        assertEquals("failed", AiHub.advance(AiRunOut("r", status = "running"), AiRunOut("r", status = "failed")).status)

        runBlocking {
            val api = GatedApi()
            val scope = CoroutineScope(Dispatchers.Unconfined)
            val hub = AiHub(api, scope)
            scope.launch { hub.requestSummary(AiSummaryRequest("c", "unread")) }
            api.gate.complete(AiRunOut("r", status = "running"))
            hub.applyEvent("ai.run_updated", event(AiRunOut("other", status = "done", output = "別の")))
            assertEquals("r", hub.summary!!.run!!.id)
            assertEquals(AiSummaryPhase.RUNNING, hub.summary!!.phase)
            hub.applyEvent("ai.run_updated", JsonObject(emptyMap())) // unreadable: dropped
            assertEquals(AiSummaryPhase.RUNNING, hub.summary!!.phase)
        }
    }

    @Test fun closingDropsAnAnswerStillOnItsWay() = runBlocking {
        val api = GatedApi()
        val scope = CoroutineScope(Dispatchers.Unconfined)
        val hub = AiHub(api, scope)
        val job = scope.launch { hub.requestSummary(AiSummaryRequest("c", "unread")) }
        hub.closeSummary()
        api.gate.complete(AiRunOut("r", status = "pending"))
        job.join()
        assertNull(hub.summary)
    }

    @Test fun withoutTheApiNothingHappens() = runBlocking {
        val hub = AiHub(null, CoroutineScope(Dispatchers.Unconfined))
        hub.loadStatus(); hub.online()
        hub.requestSummary(AiSummaryRequest("c", "unread"))
        assertNull(hub.status)
        assertNull(hub.summary)
        assertFalse(hub.summaryAvailable)
    }

    // --- the words and the menus -------------------------------------------------------------------------

    @Test fun summaryStatePhases() {
        val request = AiSummaryRequest("c", "unread")
        assertEquals(AiSummaryPhase.REQUESTING, AiSummaryState(request).phase)
        assertEquals(AiSummaryPhase.RUNNING, AiSummaryState(request, AiRunOut("r", status = "pending")).phase)
        assertEquals(AiSummaryPhase.RUNNING, AiSummaryState(request, AiRunOut("r", status = "something_new")).phase)
        assertEquals(AiSummaryPhase.DONE, AiSummaryState(request, AiRunOut("r", status = "done")).phase)
        assertEquals(AiSummaryPhase.FAILED, AiSummaryState(request, AiRunOut("r", status = "failed")).phase)
        assertEquals("要約できませんでした", AiSummaryState(request, AiRunOut("r", status = "failed")).failureText)
        assertEquals(AiSummaryPhase.FAILED, AiSummaryState(request, error = "x").phase)
        assertNull(AiSummaryState(request, AiRunOut("r", status = "done")).failureText)
    }

    @Test fun titlesChoicesAndNotes() {
        assertEquals(listOf("未読を要約", "直近 1 日を要約", "直近 7 日を要約"), AiTexts.choices("c").map { it.first })
        assertEquals(listOf("unread" to null, "recent" to 1, "recent" to 7), AiTexts.choices("c").map { it.second.scope to it.second.days })
        assertEquals("未読の要約", AiTexts.title(AiSummaryRequest("c", "unread")))
        assertEquals("直近 7 日の要約", AiTexts.title(AiSummaryRequest("c", "recent", days = 7)))
        assertEquals("スレッドの要約", AiTexts.title(AiTexts.threadRequest("c", "p")))
        assertNull(AiTexts.omittedNote(0))

        val agents = listOf(AiAgentPublic("a", "bot1", "ちくわ"), AiAgentPublic("b", "bot2", "はんぺん"))
        assertNull(AiTexts.memberNotice(agents, listOf("me", "someone")))
        assertEquals(
            "AI（ちくわ）が参加しています。メンションしたときと要約のときに、会話の一部が Anthropic の API に送られます",
            AiTexts.memberNotice(agents, listOf("me", "bot1")),
        )
        assertTrue(AiTexts.memberNotice(agents, listOf("bot1", "bot2"))!!.startsWith("AI（ちくわ、はんぺん）"))
        val sol = listOf(AiAgentPublic("s", "bot3", "そる", "gpt-6.1-sol"), AiAgentPublic("o", "bot4", "ちくわ", "claude-opus-5-5"))
        assertTrue(AiTexts.memberNotice(sol, listOf("bot3"))!!.contains("OpenAI の API"))
        assertTrue(AiTexts.memberNotice(sol, listOf("bot3", "bot4"))!!.contains("Anthropic と OpenAI の API"))
    }

    /** AI.md §2.1: people and the AI bots only, marked 「AI」; with the status read, only the AI bots it lists. */
    @Test fun mentionCandidatesAreThePeopleAndTheAiBots() {
        val users = listOf(
            UserPublic("u1", "ai-chikuwa", "ちくわ", "bot", null, "t", "t", botKind = "ai"),
            UserPublic("u2", "hook", "Webhook", "bot", null, "t", "t"),
            UserPublic("u3", "alice", "Alice", "member", null, "t", "t"),
            UserPublic("u4", "ai-old", "止めたAI", "bot", null, "t", "t", botKind = "ai"),
            UserPublic("u5", "feed", "Feed", "bot", null, "t", "t", botKind = "feed"),
            UserPublic("u6", "reserve", "Reserve", "bot", null, "t", "t", botKind = "reservation"),
            UserPublic("u7", "gone", "Gone", "member", "2026-10-01T00:00:00Z", "t", "t"),
            UserPublic("u8", "guest1", "Guest", "guest", null, "t", "t"),
            UserPublic("u9", "admin1", "Admin", "admin", null, "t", "t"),
        )
        fun users(found: List<Mentions.Candidate>) = found.filter { it.kind == "user" }.map { it.username to it.ai }
        // Before /ai/status: by bot_kind.
        assertEquals(
            listOf("admin1" to false, "ai-chikuwa" to true, "ai-old" to true, "alice" to false, "guest1" to false),
            users(Mentions.candidates("", users, limit = 20)),
        )
        // Once read: only the AI bots it lists (a stopped or deleted one is left out).
        assertEquals(
            listOf("admin1" to false, "ai-chikuwa" to true, "alice" to false, "guest1" to false),
            users(Mentions.candidates("", users, limit = 20, aiBotIds = setOf("u1"))),
        )
        // A server without AI (an empty status): no bot at all.
        assertEquals(listOf("admin1", "alice", "guest1"), users(Mentions.candidates("", users, limit = 20, aiBotIds = emptySet())).map { it.first })
        // Groups and @channel / @here as before.
        assertEquals(listOf("channel", "here"), Mentions.candidates("", users, limit = 20).filter { it.kind == "all" }.map { it.username })
    }

    @Test fun summariesJoinTheMenusOnlyWhenTheServerTakesThem() {
        assertEquals(
            listOf(BarMenuItem.FAVORITE, BarMenuItem.NOTIFICATIONS, BarMenuItem.DETAILS, BarMenuItem.SUMMARIZE, BarMenuItem.ADD_MEMBER),
            BarMenu.items(conversation = true, channel = true, archived = false, activityFeed = false, summaries = true),
        )
        assertEquals(
            listOf(BarMenuItem.FAVORITE, BarMenuItem.NOTIFICATIONS, BarMenuItem.DETAILS, BarMenuItem.SUMMARIZE),
            BarMenu.items(conversation = true, channel = false, archived = false, activityFeed = false, summaries = true),
        )
        assertEquals(listOf(BarMenuItem.SUMMARIZE_THREAD), BarMenu.items(conversation = false, channel = true, archived = false, activityFeed = false, thread = true, summaries = true))
        assertEquals(emptyList<BarMenuItem>(), BarMenu.items(conversation = false, channel = true, archived = false, activityFeed = false, thread = true, summaries = false))
        assertFalse(BarMenuItem.SUMMARIZE in BarMenu.items(conversation = true, channel = true, archived = false, activityFeed = false))
    }

    // --- review v0.1.18 #2: where the summary goes ---------------------------------------------------------------

    @Test fun targetAndRunProviderDecodeLeniently() {
        val target = Codec.snake.decodeFromString(AiSummaryTargetOut.serializer(),
            """{"available": false, "provider": "anthropic", "model": "claude-opus-5-5", "agent_name": "ちくわ", "reason": "ai_private_not_allowed", "extra": 1}""")
        assertEquals(AiSummaryTargetOut(false, "anthropic", "claude-opus-5-5", "ちくわ", "ai_private_not_allowed"), target)
        assertEquals(AiSummaryTargetOut(), Codec.snake.decodeFromString(AiSummaryTargetOut.serializer(), "{}"))
        val run = Codec.snake.decodeFromString(AiRunOut.serializer(), """{"id": "r1", "provider": "openai", "model": "gpt-6.1-sol"}""")
        assertEquals("openai" to "gpt-6.1-sol", run.provider to run.model)
        val old = Codec.snake.decodeFromString(AiRunOut.serializer(), """{"id": "r2"}""")
        assertNull(old.provider)
        assertNull(old.model)
    }

    @Test fun targetLineNamesTheBotAndProvider() {
        assertEquals("要約は ちくわ（Anthropic）に送られます", AiTexts.targetLine(AiSummaryTargetOut(true, "anthropic", "claude-opus-5-5", "ちくわ")))
        assertEquals("要約は そる（OpenAI）に送られます", AiTexts.targetLine(AiSummaryTargetOut(true, "openai", "gpt-6.1-sol", "そる")))
        assertEquals("要約は OpenAI に送られます", AiTexts.targetLine(AiSummaryTargetOut(true, "openai")))
        assertNull(AiTexts.targetLine(AiSummaryTargetOut(true)))
        assertNull(AiTexts.targetLine(null)) // an older server: no line
        assertFalse(AiTexts.choicesDisabled(null))
        assertFalse(AiTexts.choicesDisabled(AiSummaryTargetOut(true, "openai")))
    }

    @Test fun unavailableTargetsDisableTheChoicesWithTheReason() {
        for (reason in listOf("ai_unavailable", "ai_budget_exceeded", "ai_private_not_allowed")) {
            val target = AiSummaryTargetOut(false, if (reason == "ai_unavailable") null else "anthropic", reason = reason)
            assertTrue(reason, AiTexts.choicesDisabled(target))
            assertEquals(reason, ErrorMessages.byCode.getValue(reason), AiTexts.targetLine(target))
        }
        assertEquals("今は要約できません", AiTexts.targetLine(AiSummaryTargetOut(false, reason = "something_new")))
    }

    @Test fun runCaptionIsTheProviderAndModelUsed() {
        assertEquals("OpenAI · gpt-6.1-sol", AiTexts.runCaption(AiRunOut("r", provider = "openai", model = "gpt-6.1-sol")))
        assertEquals("Anthropic · claude-haiku-4-5", AiTexts.runCaption(AiRunOut("r", provider = "anthropic", model = "claude-haiku-4-5")))
        assertNull(AiTexts.runCaption(AiRunOut("r")))
        assertNull(AiTexts.runCaption(null))
    }

    @Test fun theHubReadsTheTargetAndFallsBackOnAnOlderServer() = runBlocking {
        val server = FakeServer()
        val api = server.Api("u1")
        val hub = AiHub(api, CoroutineScope(Dispatchers.Unconfined)) { 540 }
        hub.loadTarget("c1")
        assertNull(hub.target("c1")) // 404: the choices as before
        val sol = AiSummaryTargetOut(true, "openai", "gpt-6.1-sol", "そる")
        server.aiSummaryTarget = sol
        hub.loadTarget("c1")
        assertEquals(sol, hub.target("c1"))
        assertNull(hub.target("c2"))
        server.aiSummaryTarget = null
        hub.loadTarget("c1")
        assertNull(hub.target("c1")) // forgotten, not a stale line
    }
}
