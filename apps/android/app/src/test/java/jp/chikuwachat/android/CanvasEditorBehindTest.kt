package jp.chikuwachat.android

import jp.chikuwachat.android.api.CanvasMeta
import jp.chikuwachat.android.api.CanvasOut
import jp.chikuwachat.android.api.CanvasSaveOut
import jp.chikuwachat.android.sync.CanvasSaveApi
import jp.chikuwachat.android.sync.CanvasSaveStatus
import jp.chikuwachat.android.sync.CanvasSaver
import jp.chikuwachat.android.sync.CanvasSaverOptions
import jp.chikuwachat.android.ui.CanvasSections
import jp.chikuwachat.android.ui.CanvasText
import jp.chikuwachat.android.ui.EditorLink
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * CANVAS.md §24: an editor behind its save loop — the desktop's canvasSave.test.ts 「an editor behind the loop」 on the
 * Android saver, the native editor's [EditorLink] (the keystroke that lands between the loop putting a body in and the
 * field taking it), a canvas.updated that comes while a save is on the wire, and the pane keeping the canvas it opened.
 *
 * The fake server merges line by line (same line counts), so the bodies here keep four lines.
 */
class CanvasEditorBehindTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
    private var ids = 0
    private val body = "# 議事録\n- alice\n- [ ] 練習\nend"
    private val carol = body.replace("- alice", "- alice, carol")
    private val mine = body.replace("- [ ] 練習", "- [ ] 練習!")

    private fun saver(api: CanvasSaveApi, timers: ManualTimers, remembered: MutableList<CanvasOut>? = null): CanvasSaver {
        val options = CanvasSaverOptions(newId = { "k${++ids}" }, timers = timers)
        return CanvasSaver("c1", "ch1", api, scope, options, null, remember = { got -> if (got != null) remembered?.add(got) }).also { it.load() }
    }

    @Test
    fun aTextTypedOnTheBodyShownBeforeTheMergedOneReachedTheEditorKeepsTheMerge() {
        val server = FakeCanvasServer(body)
        val timers = ManualTimers()
        val saver = saver(server.api, timers)
        val shown = saver.textLineage // the editor shows the first body
        server.otherSaves(carol)
        saver.edit(mine, basedOn = shown)
        saver.flush() // merged with carol; the loop puts the merged body in …
        assertEquals(carol.replace("- [ ] 練習", "- [ ] 練習!"), saver.text)
        assertNotEquals(shown, saver.textLineage)
        // … but a key reaches the editor first: its text is the body it shows plus the key.
        saver.edit(mine.replace("end", "end 予稿"), basedOn = shown)
        saver.flush()
        assertEquals(mine, server.revision(server.saves.last().baseRevId)) // written on the version holding what was sent
        assertEquals(carol.replace("- [ ] 練習", "- [ ] 練習!").replace("end", "end 予稿"), server.body) // carol stays
        assertEquals(server.body, saver.text)
    }

    @Test
    fun withoutSayingWhichBodyItWasWrittenOnTheSameTextIsSavedOverTheMerge() {
        val server = FakeCanvasServer(body)
        val timers = ManualTimers()
        val saver = saver(server.api, timers)
        server.otherSaves(carol)
        saver.edit(mine)
        saver.flush()
        saver.edit(mine.replace("end", "end 予稿")) // no generation: taken as written on the merged body (the bug)
        saver.flush()
        assertFalse(server.body.contains("carol"))
    }

    @Test
    fun someoneElsesVersionReadWhileIdleAKeyTypedBeforeTheEditorTookItKeepsThatVersion() {
        val server = FakeCanvasServer(body)
        val timers = ManualTimers()
        val saver = saver(server.api, timers)
        val shown = saver.textLineage
        server.otherSaves(carol)
        saver.remoteVersion(server.version)
        timers.advance(500)
        assertEquals(carol, saver.text)
        saver.edit(body.replace("end", "end 予稿"), basedOn = shown) // typed on the body the editor still showed
        saver.flush()
        assertEquals(carol.replace("end", "end 予稿"), server.body)
    }

    @Test
    fun anEditorThatTookTheNewerBodyWritesOnItAsBefore() {
        val server = FakeCanvasServer(body)
        val timers = ManualTimers()
        val saver = saver(server.api, timers)
        server.otherSaves(carol)
        saver.remoteVersion(server.version)
        timers.advance(500)
        val head = server.head
        saver.edit(carol.replace("carol", "carol!"), basedOn = saver.textLineage)
        saver.flush()
        assertEquals(head, server.saves.last().baseRevId)
        assertEquals(carol.replace("carol", "carol!"), server.body)
    }

    /** The answer to a save waits for [gate] after the server applied it (the save "reached the server first"). */
    private class SlowAnswers(private val server: FakeCanvasServer) : CanvasSaveApi {
        var gate: CompletableDeferred<Unit>? = null
        var readGate: CompletableDeferred<Unit>? = null
        override suspend fun getCanvas(canvasId: String, knownVersion: Long?): CanvasOut? {
            val answer = server.api.getCanvas(canvasId, knownVersion)
            readGate?.await()
            return answer
        }
        override suspend fun saveCanvas(canvasId: String, baseRevId: String, body: String, clientSaveId: String, onConflict: String): CanvasSaveOut {
            val answer = server.api.saveCanvas(canvasId, baseRevId, body, clientSaveId, onConflict)
            gate?.await()
            return answer
        }
    }

    @Test
    fun aCanvasUpdatedThatCameWhileASaveWasOnTheWireIsReadOnceTheSaveLands() {
        val server = FakeCanvasServer(body)
        val api = SlowAnswers(server)
        val timers = ManualTimers()
        val saver = saver(api, timers)
        val gate = CompletableDeferred<Unit>()
        api.gate = gate
        saver.edit(mine)
        saver.flush() // reaches the server first
        server.otherSaves(mine.replace("- alice", "- alice, carol")) // then alice
        saver.remoteVersion(server.version)
        timers.advance(600) // the read is skipped: a save is on the wire
        api.gate = null
        gate.complete(Unit)
        assertEquals(mine, saver.text)
        timers.advance(0)
        assertEquals(mine.replace("- alice", "- alice, carol"), saver.text)
        assertEquals(CanvasSaveStatus.SAVED, saver.status)
    }

    @Test
    fun anAnswerOlderThanASaveThatLandedMeanwhileIsNotTakenNorKeptAsTheCopy() {
        val server = FakeCanvasServer(body)
        val api = SlowAnswers(server)
        val timers = ManualTimers()
        val remembered = ArrayList<CanvasOut>()
        val saver = saver(api, timers, remembered)
        server.otherSaves(carol) // version 2
        val readGate = CompletableDeferred<Unit>()
        api.readGate = readGate
        saver.remoteVersion(server.version)
        timers.advance(500) // the read of version 2 is on the wire
        api.readGate = null
        // Meanwhile a tick here goes out and lands (written on version 1, merged: version 3).
        saver.edit(mine, external = true)
        saver.flush()
        assertEquals(3L, saver.canvas?.version)
        readGate.complete(Unit) // the read's answer (version 2) arrives late
        assertEquals(3L, saver.canvas?.version)
        assertEquals(3L, remembered.last().version) // the copy on this device stays the newer one
        assertEquals(server.body, saver.text)
    }

    // --- the native editor's link (CanvasEditorField) --------------------------------------------------------

    @Test
    fun aKeystrokeBetweenTheMergeAndTheFieldTakingItKeepsTheOthersEdits() {
        val server = FakeCanvasServer(body)
        val timers = ManualTimers()
        val saver = saver(server.api, timers)
        val link = EditorLink(saver.text, null, saver.textLineage)
        server.otherSaves(carol)
        var field = mine
        link.commit(saver, field, section = false)
        saver.flush() // the merge lands and the loop puts it in; the field has not taken it yet (next frame) …
        assertEquals(carol.replace("- [ ] 練習", "- [ ] 練習!"), saver.text)
        field = field.replace("end", "end 予稿") // … and a key reaches the field first
        link.commit(saver, field, section = false)
        // The LaunchedEffect: the loop's body is what the editor wrote: nothing to take.
        assertFalse(link.shouldTake(saver, composing = false))
        saver.flush()
        assertTrue(server.body.contains("carol")) // the others' edit stays
        assertTrue(server.body.contains("end 予稿") && server.body.contains("練習!"))
        assertEquals(server.body, saver.text)
        assertTrue(link.shouldTake(saver, composing = false)) // the merged body is shown next
    }

    @Test
    fun aSectionEditorWritesIntoTheBodyItShowsNotIntoANewerOne() {
        val start = "# A\na1\n# B\nb1"
        val server = FakeCanvasServer(start)
        val timers = ManualTimers()
        val saver = saver(server.api, timers)
        val key = CanvasSections.Key("# B", 0)
        val link = EditorLink(saver.text, CanvasSections.find(saver.text, key), saver.textLineage)
        server.otherSaves("# A\na1 other\n# B\nb1")
        link.commit(saver, "b1 mine", section = true)
        saver.flush()
        assertEquals("# A\na1 other\n# B\nb1 mine", saver.text)
        link.commit(saver, "b1 mine 2", section = true) // before the field took the merged body
        saver.flush()
        assertEquals("# A\na1 other\n# B\nb1 mine 2", server.body)
    }

    @Test
    fun theFieldTakesAMergedBodyOnlyOnceTheCompositionEnds() {
        val server = FakeCanvasServer(body)
        val timers = ManualTimers()
        val saver = saver(server.api, timers)
        val link = EditorLink(saver.text, null, saver.textLineage)
        server.otherSaves(carol)
        saver.remoteVersion(server.version)
        timers.advance(500)
        assertFalse(link.shouldTake(saver, composing = true))
        assertTrue(link.shouldTake(saver, composing = false))
        link.took(saver.text, saver.textLineage, null)
        assertFalse(link.shouldTake(saver, composing = false))
    }

    // --- the pane keeps the canvas it opened on ----------------------------------------------------------------

    private fun meta(id: String, tab: Boolean = false) = CanvasMeta(id = id, channelId = "ch1", title = id, version = 1, headRevId = "r", isChannelTab = tab, createdBy = "u", updatedBy = "u", createdAt = "t", updatedAt = "t")

    @Test
    fun theOpenTabKeepsItsCanvasWhenAnotherOneIsUpdated() {
        val first = listOf(meta("a"), meta("b"))
        assertEquals("a", CanvasText.keptDefault(first, null))
        // b saved by someone else: most recently updated now.
        val later = listOf(meta("b"), meta("a"))
        assertEquals("b", CanvasText.defaultCanvasId(later)) // what the pane used to switch to
        assertEquals("a", CanvasText.keptDefault(later, "a"))
        // Gone from the list (the trash): the default again.
        assertEquals("b", CanvasText.keptDefault(listOf(meta("b")), "a"))
    }
}
