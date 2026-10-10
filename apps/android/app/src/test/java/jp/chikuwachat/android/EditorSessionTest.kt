package jp.chikuwachat.android

import jp.chikuwachat.android.editor.BridgeEmoji
import jp.chikuwachat.android.editor.EDITOR_BRIDGE_VERSION
import jp.chikuwachat.android.editor.BridgePage
import jp.chikuwachat.android.editor.BridgePerson
import jp.chikuwachat.android.editor.EditorCommand
import jp.chikuwachat.android.editor.EditorSession
import jp.chikuwachat.android.editor.EditorSessionEnv
import jp.chikuwachat.android.editor.EditorTheme
import jp.chikuwachat.android.editor.NativeMessage
import jp.chikuwachat.android.editor.WebMessage
import jp.chikuwachat.android.sync.CanvasSaveStatus
import jp.chikuwachat.android.sync.CanvasSaver
import jp.chikuwachat.android.sync.CanvasSaverOptions
import jp.chikuwachat.android.ui.EditorCaretLink
import jp.chikuwachat.android.ui.EditorImageType
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * M153a (docs/WIKI.md §30.5): the bundled editor wired to the page's save loop (editor/EditorSession.kt) over a
 * pretend WebView — what `ready` brings out, `changed` into the loop and its save after the pause, a merge back as
 * `replace` (only for what the loop changed, never before `load`), `requestBody` with the caret's line, the pages
 * `[[` asks for, pictures and links, a WebView that comes up again, and a merge kept back while the editor is focused
 * (nothing lost). The loop is the real CanvasSaver on FakeCanvasServer, as CanvasSaveTest drives it.
 */
class EditorSessionTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
    private var ids = 0

    private class Env : EditorSessionEnv {
        override var title = "手順"
        override var theme = EditorTheme.DARK
        override var locale: String? = "ja"
        override var readOnly = false
        override val attachmentUrl = "https://appassets.androidplatform.net/attachment/{id}"
        val people = listOf(BridgePerson("u1", "hanako", "花子"), BridgePerson("g1", "m2", "M2", kind = "group", members = 4))
        val emoji = listOf(BridgeEmoji("lab", url = "https://appassets.androidplatform.net/emoji/e1", kind = "image"))
        val tree = listOf(BridgePage("p1", "設計メモ", "📐", "page"), BridgePage("p2", "議事録", null, "page"), BridgePage("d1", "機材台帳", "🔧", "database"))
        var picks = 0
        val opened = ArrayList<String>()
        val logged = ArrayList<String>()
        val unsupported = ArrayList<Int>()
        override fun people() = people
        override fun emoji() = emoji
        override fun pages(query: String?): List<BridgePage> = if (query == null) tree else tree.filter { it.title.contains(query) }
        override fun pickImage() { picks += 1 }
        override fun openLink(url: String) { opened.add(url) }
        override fun log(level: String, message: String, detail: String?) { logged.add("$level: $message") }
        override fun unsupported(version: Int) { unsupported.add(version) }
    }

    private class Harness(initial: String, caretLine: Int? = null) {
        val server = FakeCanvasServer(initial)
        val timers = ManualTimers()
        val env = Env()
        val sent = ArrayList<NativeMessage>()
        lateinit var saver: CanvasSaver
        lateinit var session: EditorSession
        val caretLine = caretLine
    }

    private fun harness(initial: String, caretLine: Int? = null, autoFocus: Boolean = true): Harness {
        val h = Harness(initial, caretLine)
        val options = CanvasSaverOptions(newId = { "k${++ids}" }, timers = h.timers)
        h.saver = CanvasSaver(h.server.canvasId, h.server.channelId, h.server.api, scope, options).also { it.load() }
        h.session = EditorSession(
            h.saver, { h.sent.add(it) }, h.env, initialCaretLine = caretLine, autoFocus = autoFocus, timers = h.timers, now = { h.timers.now },
        )
        h.session.start()
        return h
    }

    private val List<NativeMessage>.types get() = map { it::class.simpleName }

    @Test fun readyBringsTheDirectoryThenTheBodyThenTheKeyboard() {
        val h = harness("# 手順\n\n最初の行\n", caretLine = 2)
        assertFalse(h.session.loaded)
        h.session.onWeb(WebMessage.Ready(EDITOR_BRIDGE_VERSION))
        assertEquals(listOf("SetTheme", "SetViewport", "ProvidePeople", "ProvideEmoji", "ProvidePages", "Load", "Focus"), h.sent.types)
        assertEquals(NativeMessage.SetTheme(EditorTheme.DARK), h.sent[0])
        assertEquals(NativeMessage.SetViewport(0), h.sent[1]) // adjustResize: the WebView is resized above the keyboard
        assertEquals(h.env.people, (h.sent[2] as NativeMessage.ProvidePeople).people)
        assertEquals(h.env.emoji, (h.sent[3] as NativeMessage.ProvideEmoji).emoji)
        assertEquals(NativeMessage.ProvidePages(null, h.env.tree), h.sent[4]) // the whole tree: `[[` filters in the editor
        val load = h.sent[5] as NativeMessage.Load
        assertEquals("# 手順\n\n最初の行\n", load.body)
        assertEquals("手順", load.title)
        assertEquals(EditorTheme.DARK, load.theme)
        assertEquals(false, load.readOnly)
        assertEquals(2, load.caretLine)
        assertEquals("ja", load.locale)
        assertEquals(h.env.attachmentUrl, load.attachmentUrl)
        assertEquals("the body's generation: the first read put it in", 1, load.gen)
        assertEquals(h.saver.textLineage, load.gen)
        assertTrue(h.session.loaded)
    }

    @Test fun aReadOnlyPageGetsNoKeyboard() {
        val h = harness("x")
        h.env.readOnly = true
        h.session.onWeb(WebMessage.Ready(EDITOR_BRIDGE_VERSION))
        assertEquals(true, (h.sent.last() as NativeMessage.Load).readOnly)
        assertFalse(h.sent.any { it is NativeMessage.Focus })
    }

    @Test fun aBundleOfAnotherBridgeVersionIsNotUsed() {
        val h = harness("x")
        h.session.onWeb(WebMessage.Ready(1)) // a bundle of bridge version 1 (no generations)
        assertEquals(listOf(1), h.env.unsupported)
        assertTrue(h.session.unsupported)
        assertTrue(h.sent.isEmpty())
        assertFalse(h.session.loaded)
    }

    @Test fun changedGoesToTheLoopAndIsSavedAfterThePauseWithoutAnEcho() {
        val h = harness("# 議事録\n")
        h.session.onWeb(WebMessage.Ready(EDITOR_BRIDGE_VERSION))
        val before = h.sent.size
        h.session.onWeb(WebMessage.Changed("# 議事録\nA", dirty = true))
        assertEquals("# 議事録\nA", h.saver.text)
        assertEquals(CanvasSaveStatus.EDITING, h.saver.status)
        h.session.saverChanged() // the loop's revision moved because of this very edit
        assertEquals(before, h.sent.size) // the editor is not told its own text
        h.timers.advance(2_000)
        assertEquals(listOf(FakeCanvasServer.Save("r1", "# 議事録\nA", "k1", "fail")), h.server.saves)
        assertEquals(CanvasSaveStatus.SAVED, h.saver.status)
        h.session.saverChanged()
        assertEquals(before, h.sent.size)
    }

    @Test fun aMergeComesBackAsReplace() {
        val h = harness("a\nb\nc")
        h.session.onWeb(WebMessage.Ready(EDITOR_BRIDGE_VERSION))
        h.server.otherSaves("a\nb\nC") // someone else, another line
        h.session.onWeb(WebMessage.Changed("A\nb\nc", dirty = true))
        h.timers.advance(EditorSession.QUIET_AFTER_MS) // not focused, and the edit is that old when the save lands
        h.saver.flush()
        assertEquals("A\nb\nC", h.saver.text) // the server merged both
        h.session.saverChanged()
        assertEquals(NativeMessage.Replace("A\nb\nC", gen = 2), h.sent.last())
        // The editor then writes the same body (its `changed` after the replace, were there one): no second replace.
        val count = h.sent.size
        h.session.onWeb(WebMessage.Changed("A\nb\nC", dirty = false))
        h.session.saverChanged()
        assertEquals(count, h.sent.size)
    }

    /**
     * The data loss of §30.4 / §30.5: a merge sent as `replace` while the IME composed was held back by the editor and
     * dropped at its next edit, and that edit (written on the body before the merge) was saved on the merged version,
     * deleting the other device's line. While the editor is focused the loop keeps the merge back and saves on the
     * version the editor's body was written on (the server merges); the merge comes in after the editor lets go.
     */
    @Test fun whileTheEditorIsFocusedAMergeWaitsAndNothingIsLost() {
        val h = harness("最初の行\nb\nc")
        h.session.onWeb(WebMessage.Ready(EDITOR_BRIDGE_VERSION))
        var focused = true
        h.session.editorFocused = { focused }
        // 「にほん」 is being composed when another device changes the last line.
        h.session.onWeb(WebMessage.Changed("最初の行にほん\nb\nc", dirty = true))
        h.server.otherSaves("最初の行\nb\n相手の行")
        h.timers.advance(2_000)
        assertEquals("最初の行にほん\nb\n相手の行", h.server.body) // the server merged
        h.session.saverChanged() // a `replace` now would be held back by the composition and dropped at the next edit
        // The composition is converted: the editor's body is still the one before the merge.
        h.session.onWeb(WebMessage.Changed("最初の行日本\nb\nc", dirty = true))
        h.session.saverChanged()
        h.timers.advance(2_000)
        assertEquals("the other device's line survives", "最初の行日本\nb\n相手の行", h.server.body)
        h.session.saverChanged()
        assertFalse("nothing goes in while the editor is focused", h.sent.any { it is NativeMessage.Replace })
        // The keyboard goes away (`caret`): once quiet, the merged body comes in.
        focused = false
        h.session.onWeb(WebMessage.Caret(0))
        h.timers.advance(EditorSession.QUIET_AFTER_MS + 200)
        assertEquals(h.server.body, h.saver.text)
        h.session.saverChanged()
        assertEquals(NativeMessage.Replace("最初の行日本\nb\n相手の行", gen = h.saver.textLineage), h.sent.last())
        assertEquals(CanvasSaveStatus.SAVED, h.saver.status)
    }

    /**
     * Leaving: while the editor's last body is asked for, a merge stays back (the answer is written on what the editor
     * holds); it comes in once the answer is in. The loop's rule is the plain one again when the session ends, unless
     * another editor set its own meanwhile.
     */
    @Test fun leavingKeepsTheMergeBackUntilTheLastBodyIsInThenHandsTheRuleBack() {
        val h = harness("a\nb\nc")
        h.session.onWeb(WebMessage.Ready(EDITOR_BRIDGE_VERSION))
        h.session.onWeb(WebMessage.Changed("A\nb\nc", dirty = true))
        h.timers.advance(2_000) // saved
        h.timers.advance(EditorSession.QUIET_AFTER_MS)
        assertTrue(h.session.editorQuiet)
        h.session.requestBody(flush = true)
        assertFalse("a body is on its way", h.session.editorQuiet)
        h.server.otherSaves("A\nb\nC")
        h.saver.remoteVersion(h.server.version)
        h.timers.advance(1_000)
        assertEquals("A\nb\nc", h.saver.text) // kept back
        h.session.onWeb(WebMessage.BodyRequested("A\nb\nc", dirty = false, caretLine = 0))
        assertTrue(h.session.editorQuiet)
        assertEquals("A\nb\nC", h.saver.text) // read once the answer is in (its flush)
        assertEquals("A\nb\nC", h.server.body)
        val other = harness("x")
        other.session.editorFocused = { true }
        assertFalse(other.saver.canReplace())
        other.session.end()
        assertTrue(other.saver.canReplace())
        // Another editor's rule set meanwhile is not undone.
        val third = harness("y")
        val rule = { false }
        third.saver.canReplace = rule
        third.session.end()
        assertTrue(third.saver.canReplace === rule)
    }

    /** The Markdown editor took over and the loop took a merge: the editor's last body, with nothing new, leaves it. */
    @Test fun anAnswerThatHoldsNothingNewDoesNotUndoAMerge() {
        val h = harness("a\nb\nc")
        h.session.onWeb(WebMessage.Ready(EDITOR_BRIDGE_VERSION))
        h.session.onWeb(WebMessage.Changed("A\nb\nc", dirty = true))
        h.timers.advance(3_000) // saved
        h.session.requestBody(flush = true)
        h.saver.canReplace = { true } // the Markdown editor's rule (CanvasPane), no composition
        h.server.otherSaves("A\nb\nC")
        h.saver.remoteVersion(h.server.version)
        h.timers.advance(1_000)
        assertEquals("A\nb\nC", h.saver.text)
        h.session.onWeb(WebMessage.BodyRequested("A\nb\nc", dirty = false, caretLine = 0))
        h.timers.advance(3_000)
        assertEquals("A\nb\nC", h.saver.text)
        assertEquals("A\nb\nC", h.server.body)
    }

    @Test fun aTickInTheReadingViewReachesTheEditor() {
        val h = harness("- [ ] x\n")
        h.session.onWeb(WebMessage.Ready(EDITOR_BRIDGE_VERSION))
        h.saver.edit("- [x] x\n", external = true)
        h.session.saverChanged()
        assertEquals(NativeMessage.Replace("- [x] x\n", gen = 2), h.sent.last())
    }

    @Test fun nothingIsReplacedBeforeTheBodyWasLoaded() {
        val h = harness("a")
        h.saver.edit("b", external = true)
        h.session.saverChanged()
        assertTrue(h.sent.isEmpty())
        h.session.onWeb(WebMessage.Ready(EDITOR_BRIDGE_VERSION))
        assertEquals("b", (h.sent.last { it is NativeMessage.Load } as NativeMessage.Load).body)
    }

    @Test fun requestBodyTakesWhatIsTypedFlushesAndCarriesTheCaret() {
        val h = harness("a\n")
        h.session.onWeb(WebMessage.Ready(EDITOR_BRIDGE_VERSION))
        var carried: Int? = null
        h.session.requestBody { carried = it }
        val asked = (h.sent.last() as NativeMessage.RequestBody).id!!
        assertTrue(h.session.awaitingBody)
        assertTrue(h.session.waitsFor(asked))
        h.session.onWeb(WebMessage.BodyRequested("a\nb", dirty = true, caretLine = 1, baseGen = 1, id = asked))
        assertFalse(h.session.awaitingBody)
        assertEquals(1, carried)
        assertEquals(1, h.session.caretLine)
        assertEquals("a\nb", h.saver.text)
        assertEquals("a\nb", h.server.body) // flushed at once, not after the pause
        // Without the flush (the switch to Markdown): the loop has the text, the save waits for the pause.
        h.session.requestBody(flush = false) { carried = it }
        // A bundle of bridge version 1 answers without an id: still taken.
        h.session.onWeb(WebMessage.BodyRequested("a\nbc", dirty = true, caretLine = 1))
        assertEquals("a\nbc", h.saver.text)
        assertEquals("a\nb", h.server.body)
        h.timers.advance(2_000)
        assertEquals("a\nbc", h.server.body)
    }

    @Test fun requestBodyBeforeLoadAnswersAtOnce() {
        val h = harness("a", caretLine = 3)
        var carried: Int? = null
        h.session.requestBody { carried = it }
        assertEquals(3, carried)
        assertTrue(h.sent.isEmpty())
    }

    @Test fun theCaretIsRememberedAndAWebViewThatComesUpAgainOpensThere() {
        val h = harness("a\nb\nc\n")
        h.session.onWeb(WebMessage.Ready(EDITOR_BRIDGE_VERSION))
        h.session.onWeb(WebMessage.Caret(2))
        assertEquals(2, h.session.caretLine)
        h.sent.clear()
        h.session.onWeb(WebMessage.Ready(EDITOR_BRIDGE_VERSION)) // the render process restarted and the page loaded again
        val load = h.sent.last { it is NativeMessage.Load } as NativeMessage.Load
        assertEquals(2, load.caretLine)
        assertEquals("a\nb\nc\n", load.body)
    }

    @Test fun pagesPeoplePicturesAndLinksGoThroughTheApp() {
        val h = harness("x")
        h.session.onWeb(WebMessage.Ready(EDITOR_BRIDGE_VERSION))
        h.session.onWeb(WebMessage.NeedPages("設計"))
        assertEquals(NativeMessage.ProvidePages("設計", listOf(BridgePage("p1", "設計メモ", "📐", "page"))), h.sent.last())
        h.session.onWeb(WebMessage.NeedPeople("ha"))
        assertEquals(NativeMessage.ProvidePeople(h.env.people), h.sent.last())
        h.session.onWeb(WebMessage.PickImage)
        assertEquals(1, h.env.picks)
        h.session.insertImage("0190a2b4-0000-7000-8000-00000000a001", null)
        assertEquals(NativeMessage.InsertImage("0190a2b4-0000-7000-8000-00000000a001"), h.sent.last())
        h.session.onWeb(WebMessage.OpenLink("page:p1"))
        h.session.onWeb(WebMessage.OpenLink("https://example.com/"))
        assertEquals(listOf("page:p1", "https://example.com/"), h.env.opened)
        h.session.onWeb(WebMessage.Log("warn", "message refused: unknown type \"ping\"", null))
        assertEquals(listOf("warn: message refused: unknown type \"ping\""), h.env.logged)
        h.session.onWeb(WebMessage.Height(1240.0)) // ignored: the WebView fills the screen
        h.session.onWeb(WebMessage.FocusTitle)
        h.session.command(EditorCommand.UNDO)
        assertEquals(NativeMessage.Command(EditorCommand.UNDO), h.sent.last())
        h.session.setTheme(EditorTheme.LIGHT)
        assertEquals(NativeMessage.SetTheme(EditorTheme.LIGHT), h.sent.last())
        h.session.blur()
        assertEquals(NativeMessage.Blur, h.sent.last())
    }

    // --- review v0.1.49 #2: a page read again never gives an empty body (bridge version 2) -------------------------

    /** The render process ended: nothing is asked of the new page; its `ready` gets the loop's text, generation, caret. */
    @Test fun afterThePageEndedTheBodyIsLoadedAgainOnReady() {
        val h = harness("a\nb\n", caretLine = 1)
        h.session.onWeb(WebMessage.Ready(EDITOR_BRIDGE_VERSION))
        h.session.onWeb(WebMessage.Changed("a\nb\n打った\n", dirty = true, baseGen = 1))
        var carried: Int? = null
        h.session.requestBody(flush = false) { carried = it }
        val asked = (h.sent.last() as NativeMessage.RequestBody).id!!
        h.session.onWeb(WebMessage.Caret(2))
        h.session.pageLost()
        assertEquals("the request is given up with the last known line", 2, carried)
        assertFalse(h.session.awaitingBody)
        assertFalse(h.session.loaded)
        // While the page is read again: nothing goes to it, and the loop keeps its text.
        val count = h.sent.size
        carried = null
        h.session.requestBody { carried = it }
        assertEquals(2, carried)
        h.session.saverChanged()
        h.session.command(EditorCommand.BOLD)
        assertEquals(count, h.sent.size)
        assertEquals("a\nb\n打った\n", h.saver.text)
        // A late answer of the old page is no one's.
        h.session.onWeb(WebMessage.BodyRequested("", dirty = true, caretLine = 0, baseGen = 1, id = asked))
        assertEquals("a\nb\n打った\n", h.saver.text)
        // The page is up again: the directory and the loop's text with its generation and the caret's line.
        h.session.onWeb(WebMessage.Ready(EDITOR_BRIDGE_VERSION))
        assertEquals(listOf("SetTheme", "SetViewport", "ProvidePeople", "ProvideEmoji", "ProvidePages", "Load"), h.sent.drop(count).types.take(6))
        val load = h.sent.last { it is NativeMessage.Load } as NativeMessage.Load
        assertEquals("a\nb\n打った\n", load.body)
        assertEquals(h.saver.textLineage, load.gen)
        assertEquals(2, load.caretLine)
        assertTrue(h.session.loaded)
        h.timers.advance(3_000)
        assertEquals("a\nb\n打った\n", h.server.body)
    }

    /** `bodyRequested {loaded: false}` (a page without an editor) is never taken for a body. */
    @Test fun anAnswerWithoutABodyIsNeverSaved() {
        val h = harness("消してはいけない段落\n")
        h.session.onWeb(WebMessage.Ready(EDITOR_BRIDGE_VERSION))
        var carried: Int? = null
        h.session.requestBody(flush = true) { carried = it }
        val asked = (h.sent.last() as NativeMessage.RequestBody).id!!
        h.session.onWeb(WebMessage.BodyUnavailable(asked))
        assertEquals(0, carried)
        assertFalse(h.session.awaitingBody)
        assertEquals("消してはいけない段落\n", h.saver.text)
        assertFalse(h.saver.unsaved)
        h.timers.advance(3_000)
        assertEquals(1L, h.server.version) // nothing saved
        assertTrue(h.env.logged.any { it.contains("without an editor") })
    }

    @Test fun anAnswerToAnotherRequestIsIgnored() {
        val h = harness("a")
        h.session.onWeb(WebMessage.Ready(EDITOR_BRIDGE_VERSION))
        var carried: Int? = null
        h.session.requestBody(flush = false) { carried = it }
        val asked = (h.sent.last() as NativeMessage.RequestBody).id!!
        h.session.onWeb(WebMessage.BodyRequested("", dirty = true, caretLine = 9, baseGen = 1, id = asked + 1000))
        assertEquals("a", h.saver.text)
        assertNull(carried)
        assertTrue(h.session.awaitingBody)
        h.session.onWeb(WebMessage.BodyRequested("ax", dirty = true, caretLine = 3, baseGen = 1, id = asked))
        assertEquals(3, carried)
        assertEquals("ax", h.saver.text)
    }

    @Test fun theCaretLineHelpersAgreeWithEachOther() {
        val text = "# 手順\n\n最初の行\n次"
        assertEquals(0, EditorCaretLink.lineOf(text, 0))
        assertEquals(0, EditorCaretLink.lineOf(text, 4))
        assertEquals(1, EditorCaretLink.lineOf(text, 5))
        assertEquals(2, EditorCaretLink.lineOf(text, 6))
        assertEquals(3, EditorCaretLink.lineOf(text, text.length))
        assertEquals(0, EditorCaretLink.startOfLine(text, 0))
        assertEquals(5, EditorCaretLink.startOfLine(text, 1))
        assertEquals(6, EditorCaretLink.startOfLine(text, 2))
        assertEquals(text.length, EditorCaretLink.startOfLine(text, 9)) // past the end: the end
        for (line in 0..3) assertEquals(line, EditorCaretLink.lineOf(text, EditorCaretLink.startOfLine(text, line)))
    }

    @Test fun aPicturesTypeIsReadFromItsBytes() {
        assertEquals("image/png", EditorImageType.of(byteArrayOf(0x89.toByte(), 'P'.code.toByte(), 'N'.code.toByte(), 'G'.code.toByte(), 13, 10, 26, 10)))
        assertEquals("image/jpeg", EditorImageType.of(byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte(), 0xE0.toByte())))
        assertEquals("image/gif", EditorImageType.of("GIF89a".toByteArray()))
        assertEquals("image/webp", EditorImageType.of("RIFF\u0000\u0000\u0000\u0000WEBPVP8 ".toByteArray(Charsets.ISO_8859_1)))
        assertNull(EditorImageType.of("hello".toByteArray()))
        assertNull(EditorImageType.of(ByteArray(0)))
    }
}
