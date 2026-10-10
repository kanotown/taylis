package jp.chikuwachat.android

import jp.chikuwachat.android.editor.EditorHostLifecycle
import jp.chikuwachat.android.editor.EditorSession
import jp.chikuwachat.android.editor.EditorSessionEnv
import jp.chikuwachat.android.editor.EditorTheme
import jp.chikuwachat.android.editor.NativeMessage
import jp.chikuwachat.android.editor.WebMessage
import jp.chikuwachat.android.sync.CanvasSaver
import jp.chikuwachat.android.sync.CanvasSaverOptions
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Review v0.1.49 #3 (docs/WIKI.md §30.5): the page screen going while the last keystrokes are only in the WebView
 * (its 300 ms write-out). The host's lifecycle (editor/EditorHostLifecycle.kt, what MobileEditorHost does with the
 * WebView) with the real EditorSession and CanvasSaver on FakeCanvasServer: the final `requestBody` goes out and its
 * answer comes in and is saved while closing; only then is the WebView destroyed; `detach` and `release` in either
 * order end the same; an answer that never comes leaves what the loop has, saved.
 */
class EditorHostLifecycleTest {

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

    /**
     * The host around the lifecycle as MobileEditorHost wires it: sends reach the WebView only while it is not
     * destroyed, and what the WebView posts goes to the routed session (none once destroyed).
     */
    private class Host {
        val server = FakeCanvasServer("a")
        val timers = ManualTimers()
        var destroyed = 0
        val warnings = ArrayList<String>()
        val lifecycle = EditorHostLifecycle(timers, destroyWebView = { destroyed += 1 }, warn = { warnings.add(it) })
        /** What reached the WebView (after the lifecycle's gate). */
        val delivered = ArrayList<NativeMessage>()
        val saver: CanvasSaver = CanvasSaver(server.canvasId, server.channelId, server.api, CoroutineScope(SupervisorJob() + Dispatchers.Unconfined), CanvasSaverOptions(newId = { "k${++ids}" }, timers = timers)).also { it.load() }
        private var ids = 0

        fun session(): EditorSession =
            EditorSession(saver, { if (lifecycle.canSend) delivered.add(it) }, Env, autoFocus = false, timers = timers, now = { timers.now })

        /** The WebView posts a message (TaylisBridge.post → main thread → MobileEditorHost.onWeb). */
        fun post(message: WebMessage) {
            if (lifecycle.destroyed) return
            val target = lifecycle.route(message) ?: return
            target.onWeb(message)
            lifecycle.delivered(target)
        }

        fun open(): EditorSession {
            val s = session()
            lifecycle.attach(s, readyVersion = 1)
            assertTrue(s.loaded)
            return s
        }
    }

    /** The bug: `release` first stopped both ways, so the answer holding the last keystrokes never reached the loop. */
    @Test fun releaseStillTakesTheLastBodyThenDestroys() {
        val h = Host()
        val s = h.open()
        h.post(WebMessage.Changed("ab", dirty = true))
        var closed = false
        h.lifecycle.release { closed = true }
        assertEquals(NativeMessage.RequestBody, h.delivered.last()) // the final request went out while closing
        assertTrue(h.lifecycle.closing)
        assertEquals(0, h.destroyed) // the WebView stays for the answer
        assertFalse(closed)
        assertTrue(h.lifecycle.leavingAwaitsBody)
        h.post(WebMessage.BodyRequested("abc", dirty = true, caretLine = 0)) // `c` was only in the WebView
        assertEquals("abc", h.saver.text)
        assertEquals("abc", h.server.body) // flushed at once
        assertEquals(1, h.destroyed)
        assertTrue(closed)
        assertFalse(s.awaitingBody)
        assertTrue(h.saver.canReplace()) // the session ended and handed the rule back
        h.timers.advance(5_000)
        assertEquals(1, h.destroyed)
        assertTrue(h.warnings.isEmpty())
    }

    @Test fun detachThenReleaseEndsTheSame() {
        val h = Host()
        val s = h.open()
        h.lifecycle.detach(s) // the composable goes first
        assertEquals(NativeMessage.RequestBody, h.delivered.last())
        var closed = false
        h.lifecycle.release { closed = true }
        assertEquals(1, h.delivered.count { it == NativeMessage.RequestBody }) // asked once
        assertEquals(0, h.destroyed)
        h.post(WebMessage.BodyRequested("ab", dirty = true, caretLine = 0))
        assertEquals("ab", h.server.body)
        assertEquals(1, h.destroyed)
        assertTrue(closed)
    }

    @Test fun releaseThenDetachEndsTheSame() {
        val h = Host()
        val s = h.open()
        var closed = false
        h.lifecycle.release { closed = true }
        h.lifecycle.detach(s) // the composable's onDispose after the host's: nothing more
        assertEquals(1, h.delivered.count { it == NativeMessage.RequestBody })
        h.post(WebMessage.BodyRequested("ab", dirty = true, caretLine = 0))
        assertEquals("ab", h.server.body)
        assertEquals(1, h.destroyed)
        assertTrue(closed)
    }

    /** No answer within the grace: the loop keeps (and saves) the last `changed`; nothing is discarded. */
    @Test fun anAnswerThatNeverComesKeepsWhatIsKnown() {
        val h = Host()
        val s = h.open()
        h.post(WebMessage.Changed("ab", dirty = true))
        var closed = false
        h.lifecycle.release { closed = true }
        h.timers.advance(EditorHostLifecycle.LEAVE_GRACE_MS)
        assertEquals("ab", h.server.body) // saved at the give-up, not lost and not waiting for the pause
        assertFalse(s.awaitingBody)
        assertEquals(1, h.destroyed)
        assertTrue(closed)
        assertEquals(1, h.warnings.size)
        // A late answer after the WebView is gone is not taken (nothing reaches a destroyed WebView's sessions).
        h.post(WebMessage.BodyRequested("abc", dirty = true, caretLine = 0))
        assertEquals("ab", h.saver.text)
    }

    /** The answer to the leaving session's request goes to it, even when the next session started meanwhile. */
    @Test fun aLeavingSessionsAnswerIsItsOwn() {
        val h = Host()
        val first = h.open()
        var caret: Int? = null
        h.lifecycle.detach(first)
        val second = h.open() // back to 見たまま before the answer came
        assertTrue("a merge waits for the older body", h.lifecycle.leavingAwaitsBody)
        second.requestBody(flush = false) { caret = it }
        h.post(WebMessage.BodyRequested("ab", dirty = true, caretLine = 3)) // first's answer
        assertFalse(first.awaitingBody)
        assertTrue(second.awaitingBody)
        assertNull(caret)
        assertEquals("ab", h.server.body)
        h.post(WebMessage.BodyRequested("ab", dirty = true, caretLine = 4))
        assertEquals(4, caret)
        assertFalse(h.lifecycle.leavingAwaitsBody)
        assertEquals(0, h.destroyed)
    }

    /** The render process died: no answer will come; a leaving session gives up (keeps what is known) at once. */
    @Test fun aDeadWebViewGivesUpAtOnce() {
        val h = Host()
        val s = h.open()
        h.post(WebMessage.Changed("ab", dirty = true))
        h.lifecycle.detach(s)
        h.lifecycle.webViewGone()
        assertFalse(s.awaitingBody)
        assertEquals("ab", h.server.body)
        assertEquals(0, h.destroyed) // the host destroyed it itself
        var closed = false
        h.lifecycle.release { closed = true }
        assertTrue(closed)
        val sent = h.delivered.size
        h.lifecycle.attach(h.session(), readyVersion = 1)
        assertEquals(sent, h.delivered.size) // nothing goes to a dead WebView
    }

    /** Leaving before the body was ever loaded: nothing to ask for; the WebView goes at once. */
    @Test fun releaseBeforeLoadDestroysAtOnce() {
        val h = Host()
        val s = h.session()
        h.lifecycle.attach(s, readyVersion = null)
        var closed = false
        h.lifecycle.release { closed = true }
        assertTrue(h.delivered.isEmpty())
        assertEquals(1, h.destroyed)
        assertTrue(closed)
    }
}
