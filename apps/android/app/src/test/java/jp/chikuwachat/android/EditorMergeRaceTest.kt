package jp.chikuwachat.android

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
 * and then sends `caret`.
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
        /** A `replace` held back (BridgeSink.pending). */
        var held: String? = null
            private set
        val dropped = ArrayList<String>()
        var composing = false
        private var writeTimer: CanvasCancel? = null
        val writePending: Boolean get() = writeTimer != null

        fun receive(message: NativeMessage) {
            when (message) {
                is NativeMessage.Load -> {
                    doc = message.body
                    written = message.body
                    base = message.body
                    held = null
                }
                is NativeMessage.Replace -> replace(message.body)
                NativeMessage.RequestBody -> {
                    // Written now, without a `changed` (sink.quiet), and answered in the same task.
                    writeTimer?.cancel()
                    writeTimer = null
                    edit(doc, quiet = true)
                    post(WebMessage.BodyRequested(written, written != base, 0))
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
            timers.schedule(50) { held?.let { if (canReplace()) apply(it) } }
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
            if (!quiet) post(WebMessage.Changed(text, text != base))
        }

        private fun replace(body: String) {
            if (body == written) {
                base = body
                held = null
                return
            }
            if (!canReplace()) {
                held = body
                return
            }
            apply(body)
        }

        private fun apply(body: String) {
            held = null
            base = body
            written = body
            doc = body
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
        h.session.onWeb(WebMessage.Ready(1))
        h.pump()
        return h
    }

    /**
     * I type `A`; it is written and its save goes out, held on the wire. `AA` is typed (not written yet), someone
     * else saves `a\nb\nREMOTE`, and the answer lands. [beforeTyping] runs while the save waits (before `AA`),
     * [beforeAnswer] just before the answer lands.
     */
    private fun Harness.firstSaveLandsWhileTyping(beforeTyping: Harness.() -> Unit = {}, beforeAnswer: Harness.() -> Unit = {}) {
        focused = true
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

    /** The reviewer's case: typing on (the keyboard is up), the answer lands inside the 300 ms write-out. */
    @Test fun typingWhenTheMergeLandsLosesNothing() {
        val h = harness()
        h.firstSaveLandsWhileTyping()
        assertEquals("the merge is kept back", "A\nb\nc", h.saver.text)
        h.advance(300) // `AA` is written
        h.assertNothingLost()
        assertTrue(h.web.dropped.isEmpty())
        // The keyboard goes away: the merged body comes in.
        h.focused = false
        h.web.blur()
        h.advance(EditorSession.QUIET_AFTER_MS + 500)
        assertEquals("AA\nb\nREMOTE", h.web.doc)
        assertEquals("AA\nb\nREMOTE", h.saver.text)
    }

    /** An IME composition open when the answer lands; converted, then typed on. */
    @Test fun aCompositionWhenTheMergeLandsLosesNothing() {
        val h = harness()
        h.firstSaveLandsWhileTyping(beforeAnswer = { web.composing = true })
        h.advance(100)
        h.web.endComposition()
        h.advance(300)
        h.web.type("AA\nb\nc") // the next keystroke after the conversion
        h.assertNothingLost()
        h.focused = false
        h.web.blur()
        h.advance(EditorSession.QUIET_AFTER_MS + 500)
        assertEquals("AA\nb\nREMOTE", h.web.doc)
    }

    /** The app goes to the background (`requestBody` with flush) right when the answer lands, in either order. */
    @Test fun anImmediateRequestBodyLosesNothing() {
        for (before in listOf(true, false)) {
            val h = harness()
            if (before) {
                h.firstSaveLandsWhileTyping(beforeAnswer = { session.requestBody(flush = true) })
            } else {
                h.firstSaveLandsWhileTyping()
                h.session.requestBody(flush = true)
            }
            assertFalse(h.session.awaitingBody)
            h.assertNothingLost()
        }
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
