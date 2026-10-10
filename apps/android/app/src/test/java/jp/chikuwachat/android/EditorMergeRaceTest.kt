package jp.chikuwachat.android

import jp.chikuwachat.android.editor.EDITOR_BRIDGE_VERSION
import jp.chikuwachat.android.editor.EditorSession
import jp.chikuwachat.android.editor.EditorSessionEnv
import jp.chikuwachat.android.editor.EditorTheme
import jp.chikuwachat.android.editor.NativeMessage
import jp.chikuwachat.android.editor.WebMessage
import jp.chikuwachat.android.sync.CanvasCancel
import jp.chikuwachat.android.sync.CanvasSaveStatus
import jp.chikuwachat.android.sync.CanvasSaver
import jp.chikuwachat.android.sync.CanvasSaverOptions
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
 * Review v0.1.49 #1 (docs/WIKI.md §30.5): a merge that lands while more typing is still inside the WebView. The real
 * CanvasSaver and EditorSession on FakeCanvasServer, with a stand-in for the editor's side of the bridge that keeps
 * BridgeSink's rules (apps/desktop/src/mobileEditor/bridgeEnv.tsx, PageEditor.tsx): an edit is written as `changed`
 * 300 ms after the last keystroke; a `replace` is held while a composition is open or an edit waits to be written, and
 * dropped when that edit is written; `requestBody` writes at once and answers in the same task; a blur writes at once
 * and then sends `caret`; bridge version 2's `baseGen` is the `gen` of the last `load` / `replace` it took (a dropped
 * one does not move it) and `bodyRequested` carries the request's `id`.
 *
 * Each case runs focused (the merge kept back while the editor may be typing) and, where the review asked, with the
 * session taking the editor for quiet (the focus not seen): the merge then goes out as `replace` and is dropped, and the
 * text written before it is saved on its own body's version (CanvasSaver.edit basedOn).
 *
 * Base `a\nb\nc`; I save `A\nb\nc`; before its answer `AA` is typed but not yet written; someone else saves
 * `a\nb\nREMOTE`; the answer is the merge `A\nb\nREMOTE`. Whatever the editor then does, the server must end with
 * `AA\nb\nREMOTE`, and the save after the merge must go on the version the editor's body was written on.
 */
class EditorMergeRaceTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)

    private object Env : EditorSessionEnv {
        override val title = "p"
        override val theme = EditorTheme.LIGHT
        override val locale: String? = null
        override val readOnly = false
        override val attachmentUrl = "https://appassets.androidplatform.net/attachment/{id}"
        override fun people() = emptyList<jp.chikuwachat.android.editor.BridgePerson>()
        override fun emoji() = emptyList<jp.chikuwachat.android.editor.BridgeEmoji>()
        override fun pages(query: String?) = emptyList<jp.chikuwachat.android.editor.BridgePage>()
        override fun pickImage() = Unit
        override fun openLink(url: String) = Unit
        override fun log(level: String, message: String, detail: String?) = Unit
        override fun unsupported(version: Int) = Unit
    }

    /** The editor in the WebView, as far as the bridge sees it. */
    private class WebEditor(private val timers: ManualTimers) {
        lateinit var post: (WebMessage) -> Unit
        /** What is on screen (the document). */
        var doc = ""
        /** BridgeSink.text: what was last written / loaded / replaced. */
        private var written = ""
        private var base = ""
        /** A `replace` held back (BridgeSink.pending), with its `gen`. */
        var held: String? = null
            private set
        private var heldGen: Int? = null
        val dropped = ArrayList<String>()
        var composing = false
        private var writeTimer: CanvasCancel? = null
        val writePending: Boolean get() = writeTimer != null
        /** The `gen` of the last `load` / `replace` taken (BridgeSink's baseGen): a dropped `replace` does not move it. */
        var gen: Int? = null
            private set
        /** Every `replace` that reached the page. */
        val replaces = ArrayList<NativeMessage.Replace>()

        fun receive(message: NativeMessage) {
            when (message) {
                is NativeMessage.Load -> {
                    doc = message.body
                    written = message.body
                    base = message.body
                    held = null
                    gen = message.gen
                }
                is NativeMessage.Replace -> {
                    replaces.add(message)
                    replace(message.body, message.gen)
                }
                is NativeMessage.RequestBody -> {
                    // Written now, without a `changed` (sink.quiet), and answered in the same task.
                    writeTimer?.cancel()
                    writeTimer = null
                    edit(doc, quiet = true)
                    post(WebMessage.BodyRequested(written, written != base, 0, baseGen = gen, id = message.id))
                }
                NativeMessage.Blur -> blur()
                else -> Unit
            }
        }

        /** A keystroke (or the IME's update of its composition): written 300 ms after the last one. */
        fun type(next: String) {
            doc = next
            writeTimer?.cancel()
            writeTimer = timers.schedule(300) {
                writeTimer = null
                edit(doc, quiet = false)
            }
        }

        /** compositionend: a held `replace` goes in after 50 ms if nothing waits to be written then. */
        fun endComposition() {
            composing = false
            if (held == null) return
            timers.schedule(50) { held?.let { if (canReplace()) apply(it, heldGen) } }
        }

        /** The editor loses the focus: the composition ends, the pending edit is written, then `caret`. */
        fun blur() {
            composing = false
            if (writeTimer != null) {
                writeTimer?.cancel()
                writeTimer = null
                edit(doc, quiet = false)
            }
            post(WebMessage.Caret(0))
        }

        private fun canReplace() = !composing && writeTimer == null

        private fun edit(text: String, quiet: Boolean) {
            if (text == written) return
            written = text
            held?.let { dropped.add(it) }
            held = null
            if (!quiet) post(WebMessage.Changed(text, text != base, baseGen = gen))
        }

        private fun replace(body: String, replaceGen: Int?) {
            if (body == written) {
                // Already the editor's body: it is on that generation now.
                base = body
                held = null
                gen = replaceGen
                return
            }
            if (!canReplace()) {
                held = body
                heldGen = replaceGen
                return
            }
            apply(body, replaceGen)
        }

        private fun apply(body: String, replaceGen: Int?) {
            held = null
            base = body
            written = body
            doc = body
            gen = replaceGen
        }
    }

    private class Harness {
        val server = FakeCanvasServer("a\nb\nc")
        val timers = ManualTimers()
        val web = WebEditor(timers)
        var focused = false
        lateinit var saver: CanvasSaver
        lateinit var session: EditorSession
        var lastRevision = -1

        /** What the screen's `LaunchedEffect(revision)` does: the loop's new text goes to the editor. */
        fun pump() {
            if (saver.revision.value == lastRevision) return
            lastRevision = saver.revision.value
            session.saverChanged()
        }

        fun advance(ms: Long) {
            var left = ms
            while (left > 0) {
                val step = minOf(left, 10L)
                timers.advance(step)
                pump()
                left -= step
            }
        }
    }

    private fun harness(): Harness {
        val h = Harness()
        var ids = 0
        h.saver = CanvasSaver(h.server.canvasId, h.server.channelId, h.server.api, scope, CanvasSaverOptions(newId = { "k${++ids}" }, timers = h.timers)).also { it.load() }
        h.session = EditorSession(h.saver, { h.web.receive(it) }, Env, autoFocus = false, timers = h.timers, now = { h.timers.now })
        h.session.editorFocused = { h.focused }
        h.web.post = { message ->
            h.session.onWeb(message)
            h.pump()
        }
        h.session.start()
        h.session.onWeb(WebMessage.Ready(EDITOR_BRIDGE_VERSION))
        h.pump()
        return h
    }

    /**
     * I type `A`; it is written and its save goes out, held on the wire. `AA` is typed (not written yet), someone
     * else saves `a\nb\nREMOTE`, and the answer lands. [focused]: whether the session sees the editor focused when the
     * answer lands. False is review v0.1.49 #1's case — the focus not seen (or typing begun just as the `replace` went
     * out): the merge goes out as `replace` while the page still holds a write, and the page holds it back and drops
     * it; the body's generation keeps that safe. [beforeTyping] runs while the save waits (before `AA`),
     * [beforeAnswer] just before the answer lands.
     */
    private fun Harness.firstSaveLandsWhileTyping(
        focused: Boolean = true, beforeTyping: Harness.() -> Unit = {}, beforeAnswer: Harness.() -> Unit = {},
    ) {
        this.focused = focused
        assertEquals("gen 1: the first read put the body in", 1, web.gen)
        web.type("A\nb\nc")
        advance(300) // written: `changed`
        val gate = CompletableDeferred<Unit>()
        server.gate = gate
        advance(2_000) // the pause: the save goes out and waits on the wire
        assertTrue(saver.busy)
        beforeTyping()
        web.type("AA\nb\nc") // inside the WebView only
        assertTrue(web.writePending)
        server.gate = null
        server.otherSaves("a\nb\nREMOTE")
        beforeAnswer()
        gate.complete(Unit)
        pump()
        assertTrue("the server merged both", server.body.endsWith("\nb\nREMOTE"))
    }

    private fun Harness.assertNothingLost() {
        advance(5_000)
        assertEquals("the other person's line survives", "AA\nb\nREMOTE", server.body)
        val afterMerge = server.saves.drop(1)
        assertTrue(afterMerge.isNotEmpty())
        // The save carrying `AA` went on the side version holding exactly `A\nb\nc` (what the editor typed on), not on
        // the merged head (which would have been a deliberate deletion of REMOTE).
        assertEquals("r3", afterMerge.first().baseRevId) // r2: REMOTE, r3: my `A\nb\nc` beside it, r4: the merge
        assertNotEquals(CanvasSaveStatus.CONFLICT, saver.status)
    }

    /** Not focused as far as the session can tell: the merge went out as `replace` (gen 2) and the page held it back. */
    private fun Harness.assertTheMergeWentOutAndWasHeld() {
        assertEquals(listOf(NativeMessage.Replace("A\nb\nREMOTE", gen = 2)), web.replaces)
        assertEquals("A\nb\nREMOTE", web.held)
    }

    /** The reviewer's case: typing on (the keyboard is up), the answer lands inside the 300 ms write-out. */
    @Test fun typingWhenTheMergeLandsLosesNothing() {
        for (focused in listOf(true, false)) {
            val h = harness()
            h.firstSaveLandsWhileTyping(focused)
            if (focused) assertEquals("the merge is kept back", "A\nb\nc", h.saver.text) else h.assertTheMergeWentOutAndWasHeld()
            h.advance(300) // `AA` is written (on gen 1: a held `replace` is dropped)
            assertEquals(if (focused) emptyList() else listOf("A\nb\nREMOTE"), h.web.dropped)
            h.assertNothingLost()
            // The keyboard goes away: the merged body comes in.
            h.focused = false
            h.web.blur()
            h.advance(EditorSession.QUIET_AFTER_MS + 500)
            assertEquals("focused=$focused", "AA\nb\nREMOTE", h.web.doc)
            assertEquals("AA\nb\nREMOTE", h.saver.text)
            if (!focused) {
                // Taken this time (gen 3): the next edit is saved on the head, beside someone else's next one.
                assertEquals(NativeMessage.Replace("AA\nb\nREMOTE", gen = 3), h.web.replaces.last())
                assertEquals(3, h.web.gen)
                h.web.type("AAA\nb\nREMOTE")
                h.server.otherSaves("AA\nb\nREMOTE2")
                h.advance(5_000)
                assertEquals("AAA\nb\nREMOTE2", h.server.body)
            }
        }
    }

    /** An IME composition open when the answer lands; converted, then typed on. */
    @Test fun aCompositionWhenTheMergeLandsLosesNothing() {
        for (focused in listOf(true, false)) {
            val h = harness()
            h.firstSaveLandsWhileTyping(focused, beforeAnswer = { web.composing = true })
            if (!focused) h.assertTheMergeWentOutAndWasHeld()
            h.advance(100)
            h.web.endComposition()
            h.advance(300)
            h.web.type("AA\nb\nc") // the next keystroke after the conversion
            h.assertNothingLost()
            h.focused = false
            h.web.blur()
            h.advance(EditorSession.QUIET_AFTER_MS + 500)
            assertEquals("focused=$focused", "AA\nb\nREMOTE", h.web.doc)
        }
    }

    /** The composition ends with nothing else to write: the page lets the held merge in (gen 2) and writes on it. */
    @Test fun aMergeLetInAfterACompositionIsWrittenOn() {
        val h = harness()
        h.focused = false
        h.web.type("A\nb\nc")
        h.advance(300)
        val gate = CompletableDeferred<Unit>()
        h.server.gate = gate
        h.advance(2_000)
        h.web.composing = true // 「。」 being composed, nothing waiting to be written
        h.server.gate = null
        h.server.otherSaves("a\nb\nREMOTE")
        gate.complete(Unit)
        h.pump()
        h.assertTheMergeWentOutAndWasHeld()
        h.web.endComposition()
        h.advance(60)
        assertEquals("A\nb\nREMOTE", h.web.doc)
        assertEquals(2, h.web.gen)
        h.web.type("A\nb\nREMOTE。")
        h.advance(5_000)
        assertEquals("A\nb\nREMOTE。", h.server.body)
        assertEquals("written on the merged head", "r4", h.server.saves.last().baseRevId)
    }

    /** The app goes to the background (`requestBody` with flush) right when the answer lands, in either order. */
    @Test fun anImmediateRequestBodyLosesNothing() {
        for (focused in listOf(true, false)) {
            for (before in listOf(true, false)) {
                val h = harness()
                if (before) {
                    h.firstSaveLandsWhileTyping(focused, beforeAnswer = { session.requestBody(flush = true) })
                } else {
                    h.firstSaveLandsWhileTyping(focused)
                    h.session.requestBody(flush = true)
                }
                assertFalse(h.session.awaitingBody)
                h.assertNothingLost()
            }
        }
    }

    /**
     * Someone else's version read while idle goes in as `replace` (gen 2); the page, still writing, drops it: its text
     * (on gen 1) is merged with that version, not saved over it. Focused, the version is kept back instead.
     */
    @Test fun anEditOnTheBodyBeforeSomeoneElsesVersionIsMergedWithIt() {
        for (focused in listOf(true, false)) {
            val h = harness()
            h.focused = focused
            h.server.otherSaves("a\nb\nREMOTE")
            h.saver.remoteVersion(h.server.version) // read after 500 ms
            h.advance(300)
            h.web.type("A\nb\nc") // written at 600 ms, after the read
            h.advance(200)
            assertEquals(0, h.server.saves.size)
            h.advance(100)
            if (focused) {
                assertTrue(h.web.replaces.isEmpty())
            } else {
                assertEquals(listOf(NativeMessage.Replace("a\nb\nREMOTE", gen = 2)), h.web.replaces)
                assertEquals(listOf("a\nb\nREMOTE"), h.web.dropped) // the write at 300 ms dropped it
            }
            h.advance(5_000)
            assertEquals("focused=$focused", "A\nb\nREMOTE", h.server.body)
            assertEquals("written on the version before REMOTE", "r1", h.server.saves.first().baseRevId)
        }
    }

    /**
     * A save that went out before the page's text stepped back to an earlier body (here: a tick in the reading view on
     * the merged body, sent at once, while the page drops both `replace`s and writes on gen 1) does not move the base:
     * its answer is that tick's generation's base, and the page's text is merged on its own (gen 1's) version.
     */
    @Test fun aSaveSentBeforeAStepBackDoesNotMoveTheBase() {
        val h = harness()
        h.firstSaveLandsWhileTyping(focused = false)
        h.assertTheMergeWentOutAndWasHeld()
        h.saver.edit("A\nB\nREMOTE", external = true) // a tick: gen 3, on the merged head r4
        h.pump()
        assertEquals(NativeMessage.Replace("A\nB\nREMOTE", gen = 3), h.web.replaces.last())
        val gate = CompletableDeferred<Unit>()
        h.server.gate = gate
        h.saver.flush() // on the wire, on r4
        assertTrue(h.saver.busy)
        h.advance(300) // the page writes `AA` on gen 1, dropping both
        assertEquals(listOf("A\nB\nREMOTE"), h.web.dropped)
        h.server.gate = null
        gate.complete(Unit)
        h.pump()
        h.advance(5_000)
        assertEquals("the tick, the other person's line and mine", "AA\nB\nREMOTE", h.server.body)
        assertEquals("r3", h.server.saves.last().baseRevId)
    }

    /** A text that names no generation (a bundle of bridge version 1) is taken as before: on the loop's base. */
    @Test fun aChangedWithoutBaseGenIsWrittenOnTheCurrentBody() {
        val h = harness()
        h.web.type("A\nb\nc")
        h.advance(300)
        val gate = CompletableDeferred<Unit>()
        h.server.gate = gate
        h.advance(2_000)
        h.server.gate = null
        h.server.otherSaves("a\nb\nREMOTE")
        gate.complete(Unit)
        h.pump()
        assertEquals(listOf(NativeMessage.Replace("A\nb\nREMOTE", gen = 2)), h.web.replaces)
        h.session.onWeb(WebMessage.Changed("A\nb\nREMOTE!", dirty = true))
        h.advance(5_000)
        assertEquals("A\nb\nREMOTE!", h.server.body)
        assertEquals("r4", h.server.saves.last().baseRevId)
    }

    /**
     * The keyboard is put away (the back gesture) while `AA` waits to be written, or a composition the IME commits on
     * closing does: the editor is not focused any more, but its write is still to come. Before the fix the answer
     * landing then was taken as quiet, the merge advanced the base, the editor held the `replace` and dropped it at the
     * write, and `AA\nb\nc` was saved on the merged head (REMOTE gone). The screen blurs the editor when the keyboard
     * goes (MobileEditor), and letting go counts as activity.
     */
    @Test fun theKeyboardClosingWhileAWriteWaitsLosesNothing() {
        val h = harness()
        h.firstSaveLandsWhileTyping(
            beforeTyping = { advance(EditorSession.QUIET_AFTER_MS + 100) }, // the answer is slow; the last `changed` is long past
            beforeAnswer = {
                focused = false
                session.letGo() // the keyboard went away; `AA` is still waiting to be written
            },
        )
        h.advance(300)
        h.assertNothingLost()
    }

    /** The same with the screen's blur: the write comes out at once, before the answer. */
    @Test fun theKeyboardClosingBlursAndLosesNothing() {
        val h = harness()
        h.firstSaveLandsWhileTyping(
            beforeTyping = { advance(EditorSession.QUIET_AFTER_MS + 100) },
            beforeAnswer = {
                session.blur() // MobileEditor: the keyboard went away → the editor lets go (writes `AA`, then `caret`)
                focused = false
            },
        )
        h.assertNothingLost()
        h.advance(EditorSession.QUIET_AFTER_MS + 500)
        assertEquals("AA\nb\nREMOTE", h.web.doc)
    }
}
