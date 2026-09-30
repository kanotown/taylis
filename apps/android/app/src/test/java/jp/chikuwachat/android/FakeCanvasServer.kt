package jp.chikuwachat.android

import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.CanvasConflict
import jp.chikuwachat.android.api.CanvasConflictDetails
import jp.chikuwachat.android.api.CanvasMeta
import jp.chikuwachat.android.api.CanvasOut
import jp.chikuwachat.android.api.CanvasSaveOut
import jp.chikuwachat.android.api.CanvasTemplateOut
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.sync.CanvasApi
import jp.chikuwachat.android.sync.CanvasCancel
import jp.chikuwachat.android.sync.CanvasTimers
import kotlinx.coroutines.CompletableDeferred

/**
 * M46: one canvas on a pretend server, with the save protocol of CANVAS.md §4.4 (versions, idempotency keys, side
 * versions, conflicts, an expired base). Its merge is a line-by-line stand-in for server/app/modules/canvases/merge.py
 * (the tests only need "different lines merge, the same line conflicts"); the real merge is the server's own tests'.
 */
class FakeCanvasServer(initial: String = "", val canvasId: String = "c1", val channelId: String = "ch1") {
    data class Save(val baseRevId: String, val body: String, val clientSaveId: String, val onConflict: String)

    private var revCounter = 1
    private val revisions = LinkedHashMap<String, String>()
    var head = "r1"
        private set
    var version = 1L
        private set
    var body = initial
        private set
    /** Every PUT that reached the server (retries included), in order. */
    val saves = ArrayList<Save>()
    /** GETs: the If-None-Match version each carried. */
    val reads = ArrayList<Long?>()
    private val answers = HashMap<String, CanvasSaveOut>()
    /** Failures for the next calls, in order (a network error, 429, 503, 403 …). */
    val failures = ArrayDeque<Throwable>()
    /** The answer to the next save is lost after the server applied it (the retry must get the same one). */
    var loseNextAnswer = false
    /** While set, answers wait for it (a save "on the wire" while the user types on). */
    var gate: CompletableDeferred<Unit>? = null

    init {
        revisions[head] = initial
    }

    private fun newRev(text: String): String {
        revCounter += 1
        val id = "r$revCounter"
        revisions[id] = text
        return id
    }

    fun canvas(): CanvasOut = CanvasOut(
        id = canvasId, channelId = channelId, title = "議事録", version = version, headRevId = head,
        createdBy = "u1", updatedBy = "u1", createdAt = "2026-09-30T00:00:00Z", updatedAt = "2026-09-30T00:00:00Z", body = body,
    )

    /** Someone else saves directly on the head (another device, android2). */
    fun otherSaves(text: String) {
        head = newRev(text)
        body = text
        version += 1
    }

    /** The versions of the last day are thinned away (the base of a long offline edit is gone). */
    fun forget(revId: String) {
        revisions.remove(revId)
    }

    private fun details(conflicts: List<CanvasConflict> = emptyList()) =
        Codec.snake.encodeToJsonElement(CanvasConflictDetails.serializer(), CanvasConflictDetails(canvas(), conflicts))

    /** Line by line: one side changed a line → that side; both the same → once; both differently → a conflict. */
    private fun merge(base: String, ours: String, theirs: String, onConflict: String): Pair<String, List<CanvasConflict>> {
        val b = base.split("\n")
        val o = ours.split("\n")
        val t = theirs.split("\n")
        if (b.size != o.size || b.size != t.size) {
            // Lines added or removed on one side only: take that side's shape (enough for these tests).
            return when {
                o == b -> theirs to emptyList()
                t == b -> ours to emptyList()
                else -> theirs to listOf(CanvasConflict(base, ours, theirs))
            }
        }
        val conflicts = ArrayList<CanvasConflict>()
        val out = b.indices.map { i ->
            when {
                o[i] == b[i] -> t[i]
                t[i] == b[i] || t[i] == o[i] -> o[i]
                else -> {
                    conflicts.add(CanvasConflict(b[i], o[i], t[i], i, i))
                    when (onConflict) {
                        "ours" -> o[i]
                        "both" -> t[i] + "\n> " + o[i]
                        else -> t[i]
                    }
                }
            }
        }
        return out.joinToString("\n") to conflicts
    }

    val api: CanvasApi = object : CanvasApi {
        override suspend fun getCanvas(canvasId: String, knownVersion: Long?): CanvasOut? {
            gate?.await()
            failures.removeFirstOrNull()?.let { throw it }
            reads.add(knownVersion)
            return if (knownVersion != null && knownVersion == version) null else canvas()
        }

        override suspend fun saveCanvas(canvasId: String, baseRevId: String, body: String, clientSaveId: String, onConflict: String): CanvasSaveOut {
            saves.add(Save(baseRevId, body, clientSaveId, onConflict))
            gate?.await()
            failures.removeFirstOrNull()?.let { throw it }
            answers[clientSaveId]?.let { return it } // the same key again: the first answer (§4.4 再送)
            val base = revisions[baseRevId] ?: throw ApiException.Api(409, "canvas_base_expired", "Base expired", details())
            val answer: CanvasSaveOut
            if (baseRevId == head) {
                if (body == this@FakeCanvasServer.body) {
                    answer = CanvasSaveOut(canvas(), head, merged = false)
                } else {
                    otherSaves(body)
                    answer = CanvasSaveOut(canvas(), head, merged = false)
                }
            } else {
                val (merged, conflicts) = merge(base, body, this@FakeCanvasServer.body, onConflict)
                if (conflicts.isNotEmpty() && onConflict == "fail") throw ApiException.Api(409, "canvas_conflict", "Conflict", details(conflicts))
                val side = newRev(body)
                if (merged != this@FakeCanvasServer.body) otherSaves(merged)
                answer = CanvasSaveOut(canvas(), side, merged = true)
            }
            answers[clientSaveId] = answer
            if (loseNextAnswer) {
                loseNextAnswer = false
                throw ApiException.Network(java.io.IOException("answer lost"))
            }
            return answer
        }

        override suspend fun listCanvases(channelId: String, trashed: Boolean): List<CanvasMeta> = if (trashed) emptyList() else listOf(canvas().meta)
        override suspend fun createCanvas(channelId: String, clientSaveId: String, templateKey: String?, title: String?, asTab: Boolean, tz: String?): CanvasOut = canvas()
        override suspend fun updateCanvas(canvasId: String, title: String?, editPolicy: String?, isChannelTab: Boolean?): CanvasOut = canvas()
        override suspend fun deleteCanvas(canvasId: String) {}
        override suspend fun restoreCanvas(canvasId: String): CanvasOut = canvas()
        override suspend fun canvasTemplates(): List<CanvasTemplateOut> = emptyList()
    }
}

/** Timers on a hand-driven clock: [advance] runs what falls due, in order. */
class ManualTimers : CanvasTimers {
    private class Entry(val at: Long, val action: () -> Unit) {
        var cancelled = false
    }

    var now = 0L
        private set
    private val entries = ArrayList<Entry>()

    override fun schedule(delayMs: Long, action: () -> Unit): CanvasCancel {
        val entry = Entry(now + delayMs, action)
        entries.add(entry)
        return CanvasCancel { entry.cancelled = true }
    }

    /** Pending timers (not cancelled, not run). */
    val pending: Int get() = entries.count { !it.cancelled }

    fun advance(ms: Long) {
        val until = now + ms
        while (true) {
            val next = entries.filter { !it.cancelled && it.at <= until }.minByOrNull { it.at } ?: break
            entries.remove(next)
            now = next.at
            next.action()
        }
        now = until
        entries.removeAll { it.cancelled }
    }
}
