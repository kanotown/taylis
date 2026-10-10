package jp.chikuwachat.android.editor

import jp.chikuwachat.android.sync.CanvasCancel
import jp.chikuwachat.android.sync.CanvasSaver
import jp.chikuwachat.android.sync.CanvasTimers

/** What one editing session needs from the app around it (ui/MobileEditor.kt builds it from the controller). */
interface EditorSessionEnv {
    val title: String
    val theme: EditorTheme
    /** "ja" / "en" / "zh-Hans", or null for the device's. */
    val locale: String?
    val readOnly: Boolean
    /** Where `![alt](attachment:<id>)` images load from, `{id}` standing for the id (the WebView's own origin). */
    val attachmentUrl: String
    fun people(): List<BridgePerson>
    fun emoji(): List<BridgeEmoji>
    /** The pages whose title holds `query`; null: the whole tree (the editor then filters by itself). */
    fun pages(query: String?): List<BridgePage>
    /** The image button: pick, upload, then [EditorSession.insertImage]. */
    fun pickImage()
    /** `https://…`, `page:<id>` or `attachment:<id>`. */
    fun openLink(url: String)
    fun log(level: String, message: String, detail: String?)
    /** `ready` carried another bridge version than this app knows: the editor is not used. */
    fun unsupported(version: Int)
}

/**
 * M153a (docs/WIKI.md §30.3 / §30.5): one page edited in the bundled editor, between the bridge and the page's
 * [CanvasSaver] (the same save loop, pause, merge, conflict and offline handling as the Markdown editor). The editor's
 * `changed` goes to [CanvasSaver.edit]; a body the loop changed (a merge, someone else's version, a box ticked in the
 * reading view) goes back as `replace` ([saverChanged]); `requestBody` fetches what is typed but not yet written
 * (leaving, the background, the switch to Markdown) and carries the caret's line across.
 *
 * The loop may put a merged body on screen only while the editor is quiet ([editorQuiet], its `canReplace` from
 * [start] to [end]). The editor holds a `replace` back while an IME composition is open and drops it at its next edit
 * (bridge.ts); that edit's `changed` is written on the body before the merge, and saved on the merged version it
 * deleted the other person's lines (docs/WIKI.md §30.4 / §30.5). Kept back instead, every save goes on the version the
 * editor's body was written on and the server merges it; the merged body comes in once the editor lets go ([letGo]).
 *
 * Runs on the main thread, like the loop.
 */
class EditorSession(
    private val saver: CanvasSaver,
    private val send: (NativeMessage) -> Unit,
    private val env: EditorSessionEnv,
    /** The body line to open on (from the Markdown editor), carried back by `bodyRequested` / `caret`. */
    initialCaretLine: Int? = null,
    /** Bring the keyboard up once the body is loaded. */
    private val autoFocus: Boolean = true,
    /** The catch-up after the editor let go of the focus ([letGo]): the main looper in the app, ManualTimers in tests. */
    private val timers: CanvasTimers,
    /** The clock of [editorQuiet] (ms, monotonic). */
    private val now: () -> Long,
) {
    /**
     * Whether the editor may be taking keys (MobileEditorHost.editorFocused: the WebView has the focus and a keyboard
     * is up). While it may, an IME composition can be open and a `replace` would be held back and lost.
     */
    var editorFocused: () -> Boolean = { false }
    /** When the editor last wrote an edit or was handed a command or a picture (null: never). */
    private var lastActivity: Long? = null
    private var catchUp: CanvasCancel? = null
    private var ended = false
    private val quietCheck: () -> Boolean = { editorQuiet }

    /**
     * No composition can be open and no edit can be on its way: the editor is not focused, nothing was written or
     * commanded for [QUIET_AFTER_MS], and no `requestBody` is unanswered (its answer, written on what the editor holds,
     * goes into the loop after the merge would). Only then may the loop take a merged body as its own and hand it over.
     */
    val editorQuiet: Boolean
        get() = !editorFocused() && bodyWaiters.isEmpty() && lastActivity.let { it == null || now() - it >= QUIET_AFTER_MS }

    /** The line the caret was last known on (for the Markdown editor after a switch). */
    var caretLine: Int? = initialCaretLine
        private set

    /** `load` went out (after `ready`); `replace` and `requestBody` make sense from here. */
    var loaded = false
        private set

    /** The body the editor last showed or wrote: what differs from it in the loop is a merge to put on screen. */
    private var wire: String = saver.text
    private val bodyWaiters = ArrayList<(WebMessage.BodyRequested) -> Unit>()

    /** `ready` of a bundle this app does not know came: the screen falls back to Markdown. */
    var unsupported = false
        private set

    fun onWeb(message: WebMessage) {
        when (message) {
            is WebMessage.Ready -> {
                if (message.version != EDITOR_BRIDGE_VERSION) {
                    unsupported = true
                    env.unsupported(message.version)
                    return
                }
                load()
            }
            is WebMessage.Changed -> {
                lastActivity = now()
                take(message.body)
            }
            is WebMessage.BodyRequested -> {
                take(message.body)
                caretLine = message.caretLine
                val waiting = bodyWaiters.toList()
                bodyWaiters.clear()
                waiting.forEach { it(message) }
            }
            is WebMessage.Caret -> {
                caretLine = message.line
                letGo() // the editor lost the focus (or the page hid): the merge may come in
            }
            is WebMessage.Height -> Unit // the WebView fills the screen and scrolls by itself
            // The directory may have changed since `load` (a member added): `@` gets it again.
            is WebMessage.NeedPeople -> send(NativeMessage.ProvidePeople(env.people()))
            is WebMessage.NeedPages -> send(NativeMessage.ProvidePages(message.query, env.pages(message.query)))
            WebMessage.PickImage -> env.pickImage()
            is WebMessage.OpenLink -> env.openLink(message.url)
            WebMessage.FocusTitle -> Unit // the phone's page has no title field while editing
            is WebMessage.Log -> env.log(message.level, message.message, message.detail)
        }
    }

    /** The editor is up: the directory first (chips take their names when the body is read), then the body. */
    fun load() {
        send(NativeMessage.SetTheme(env.theme))
        send(NativeMessage.SetViewport(0))
        send(NativeMessage.ProvidePeople(env.people()))
        send(NativeMessage.ProvideEmoji(env.emoji()))
        send(NativeMessage.ProvidePages(null, env.pages(null)))
        wire = saver.text
        send(
            NativeMessage.Load(
                body = saver.text, title = env.title, theme = env.theme, readOnly = env.readOnly, caretLine = caretLine,
                locale = env.locale, attachmentUrl = env.attachmentUrl,
            ),
        )
        loaded = true
        if (autoFocus && !env.readOnly) send(NativeMessage.Focus)
    }

    /** The editor's page joins the loop: from now on the loop replaces its text only when [editorQuiet]. */
    fun start() {
        ended = false
        saver.canReplace = quietCheck
    }

    /**
     * The editor is gone (and its last body is in): the loop may replace its text again, and a merge it kept back is
     * read now when nothing is left to save. Another editor may have set its own rule meanwhile: that one stays.
     */
    fun end() {
        if (ended) return
        ended = true
        catchUp?.cancel()
        catchUp = null
        if (saver.canReplace === quietCheck) saver.canReplace = { true }
        saver.replaceable()
    }

    /**
     * The editor let go of the focus (`caret`), or the keyboard went away: once it is quiet, what the server merged
     * meanwhile comes in — saved now when something is unsaved (the answer brings the merge), else read.
     */
    fun letGo() {
        if (ended) return
        catchUp?.cancel()
        catchUp = timers.schedule(QUIET_AFTER_MS + 100) {
            catchUp = null
            if (!ended && loaded && editorQuiet) saver.flush()
        }
    }

    private fun take(body: String) {
        // Nothing new since the editor last wrote or was handed this body: the loop's text (perhaps a merge not yet
        // on screen) stands.
        if (body == wire) return
        wire = body
        saver.edit(body)
    }

    /** The loop's text changed (a merge, someone else's version, a tick): the editor takes it unless it wrote it. */
    fun saverChanged() {
        if (!loaded) return
        val text = saver.text
        if (text == wire) return
        wire = text
        send(NativeMessage.Replace(text))
    }

    /**
     * The body as the editor holds it now: what is typed but not yet written (the 300 ms) goes to the loop and, with
     * [flush], out to the server at once. [then] gets the caret's line (the Markdown editor opens there).
     */
    fun requestBody(flush: Boolean = true, then: ((caretLine: Int) -> Unit)? = null) {
        if (!loaded) {
            then?.invoke(caretLine ?: 0)
            return
        }
        bodyWaiters.add { answer ->
            if (flush) saver.flush()
            then?.invoke(answer.caretLine)
        }
        send(NativeMessage.RequestBody)
    }

    /** A `requestBody` is still unanswered (the WebView must stay for it). */
    val awaitingBody: Boolean get() = bodyWaiters.isNotEmpty()

    fun setTheme(theme: EditorTheme) {
        if (loaded) send(NativeMessage.SetTheme(theme))
    }

    fun command(name: EditorCommand) {
        if (!loaded) return
        lastActivity = now()
        send(NativeMessage.Command(name))
    }

    /** The answer to `pickImage`: the uploaded picture at the caret. */
    fun insertImage(attachmentId: String, url: String?) {
        if (!loaded) return
        lastActivity = now()
        send(NativeMessage.InsertImage(attachmentId, url))
    }

    fun focus() {
        if (loaded) send(NativeMessage.Focus)
    }

    fun blur() {
        if (loaded) send(NativeMessage.Blur)
    }

    companion object {
        /** How long after the editor's last edit or command a merged body may go in (as iOS's quietAfter). */
        const val QUIET_AFTER_MS = 1_000L
    }
}
