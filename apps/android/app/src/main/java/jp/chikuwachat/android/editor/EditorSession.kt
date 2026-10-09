package jp.chikuwachat.android.editor

import jp.chikuwachat.android.sync.CanvasSaver

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
 * (leaving, the background, the switch to Markdown) and carries the caret's line across. The editor itself holds a
 * `replace` back while an IME composition is open (bridge.ts), so the loop's `canReplace` stays true here.
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
) {
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
            is WebMessage.Changed -> take(message.body)
            is WebMessage.BodyRequested -> {
                take(message.body)
                caretLine = message.caretLine
                val waiting = bodyWaiters.toList()
                bodyWaiters.clear()
                waiting.forEach { it(message) }
            }
            is WebMessage.Caret -> caretLine = message.line
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

    private fun take(body: String) {
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
        if (loaded) send(NativeMessage.Command(name))
    }

    /** The answer to `pickImage`: the uploaded picture at the caret. */
    fun insertImage(attachmentId: String, url: String?) {
        if (loaded) send(NativeMessage.InsertImage(attachmentId, url))
    }

    fun focus() {
        if (loaded) send(NativeMessage.Focus)
    }

    fun blur() {
        if (loaded) send(NativeMessage.Blur)
    }
}
