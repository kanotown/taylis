package jp.chikuwachat.android.ui

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.util.LruCache
import android.view.View
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Redo
import androidx.compose.material.icons.automirrored.outlined.Undo
import androidx.compose.material.icons.outlined.AddPhotoAlternate
import androidx.compose.material.icons.outlined.AlternateEmail
import androidx.compose.material.icons.outlined.KeyboardHide
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.webkit.WebViewAssetLoader
import jp.chikuwachat.android.BuildConfig
import jp.chikuwachat.android.L10n
import jp.chikuwachat.android.R
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.editor.BridgeEmoji
import jp.chikuwachat.android.editor.BridgePage
import jp.chikuwachat.android.editor.BridgePerson
import jp.chikuwachat.android.editor.EditorBridge
import jp.chikuwachat.android.editor.EditorCommand
import jp.chikuwachat.android.editor.EditorSession
import jp.chikuwachat.android.editor.EditorSessionEnv
import jp.chikuwachat.android.editor.EditorTheme
import jp.chikuwachat.android.editor.NativeMessage
import jp.chikuwachat.android.editor.WebMessage
import jp.chikuwachat.android.platform.KeyValueStore
import jp.chikuwachat.android.sync.CanvasSaver
import jp.chikuwachat.android.sync.WikiLinks
import jp.chikuwachat.android.sync.WikiTree
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import java.io.ByteArrayInputStream

/*
 * M153a (docs/WIKI.md §30.3 / §30.5): the 見たまま page editor on Android — the same TipTap editor as Desktop, bundled
 * into assets/editor by the Gradle build (copyMobileEditor) and shown in a WebView only while a page is edited. The
 * WebView loads nothing from the network: WebViewAssetLoader serves the bundle at
 * https://appassets.androidplatform.net/editor/, the pictures of the page are fetched by the app with its session
 * and handed over as /attachment/<id> (cached), every other navigation is refused, and the page's CSP lets it talk
 * to no one. The bridge (editor/EditorBridge.kt, editor/EditorSession.kt) carries the body, the directory, the
 * pictures and the links; the page's CanvasSaver saves as for the Markdown editor.
 *
 * Per device (You.kt WysiwygEditing, off by default: a prototype), and per page the 「見たまま / Markdown」 switch
 * (DocPage.kt). The formatting row is the editor's own, fixed at the bottom of the WebView above the keyboard; the
 * app adds a thin row under it (undo / redo / @ / image / close the keyboard) — §30.5 says why.
 */

private const val TAG = "MobileEditor"
private const val ASSET_HOST = "appassets.androidplatform.net"
private const val EDITOR_URL = "https://$ASSET_HOST/editor/index.html"
private const val ATTACHMENT_URL = "https://$ASSET_HOST/attachment/{id}"
private const val EMOJI_URL = "https://$ASSET_HOST/emoji/"
/** The pictures of open pages kept decoded-ready for the WebView (bytes, by attachment or emoji id). */
private const val IMAGE_CACHE_BYTES = 16 * 1024 * 1024
/** How long a `requestBody` sent while leaving may take before the WebView goes anyway. */
private const val LEAVE_GRACE_MS = 1_000L
private val UUID = Regex("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", RegexOption.IGNORE_CASE)

/** M153a: 「ドキュメントの見たまま編集（試作）」, kept on this device; off leaves no key behind. */
object WysiwygEditing {
    private const val KEY = "docs_wysiwyg"
    /** The page's last 「見たまま / Markdown」 choice while the setting is on ("markdown" to open in Markdown). */
    private const val CHOICE_KEY = "docs_wysiwyg_choice"

    fun read(store: KeyValueStore): Boolean = store.getString(KEY) == "on"

    fun write(store: KeyValueStore, on: Boolean) = store.putString(KEY, if (on) "on" else null)

    fun prefersMarkdown(store: KeyValueStore): Boolean = store.getString(CHOICE_KEY) == "markdown"

    fun writeChoice(store: KeyValueStore, markdown: Boolean) = store.putString(CHOICE_KEY, if (markdown) "markdown" else null)
}

/**
 * One warmed WebView with the bundle loaded, made when the page screen opens (so 「編集」 only sends `load`), and the
 * bridge over it. Holds the pictures it served. Destroyed when the page screen goes ([release]).
 */
class MobileEditorHost(context: Context, private val controller: AppController) {
    val webView: WebView
    private val bridge: EditorBridge
    private val main = Handler(Looper.getMainLooper())
    // The handler resolves what follows its prefix against the assets root, so "/" maps /editor/index.html to
    // assets/editor/index.html; [intercept] lets only /editor/ reach it.
    private val assets = WebViewAssetLoader.Builder().addPathHandler("/", WebViewAssetLoader.AssetsPathHandler(context)).build()
    private val images = object : LruCache<String, Pair<String, ByteArray>>(IMAGE_CACHE_BYTES) {
        override fun sizeOf(key: String, value: Pair<String, ByteArray>): Int = value.second.size + 64
    }
    private val startedAt = SystemClock.uptimeMillis()

    /** The bundle's bridge version once `ready` came (null until then). */
    var readyVersion: Int? by mutableStateOf(null)
        private set
    /** The editor cannot be used (the render process died, a bundle of another version): the screen shows Markdown. */
    var failed: String? by mutableStateOf(null)
        private set
    /** Measurements for the log: when the page became ready, when the first body was painted. */
    var readyAfterMs: Long? = null
        private set
    private var session: EditorSession? = null
    private var leaving: EditorSession? = null
    private var released = false
    private var loadSentAt = 0L
    private var firstHeightAt: Long? = null

    init {
        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true)
        bridge = EditorBridge(
            port = { js -> if (!released) webView.evaluateJavascript(js, null) },
            main = { runnable -> main.post(runnable) },
            listener = ::onWeb,
            refused = { Log.w(TAG, "message refused: ${it.message} (${it.raw.take(120)})") },
        )
        webView = makeWebView(context)
        webView.loadUrl(EDITOR_URL)
    }

    // MissingOnRenderProcessGone: lint does not see the override in the anonymous client below (it is there).
    @SuppressLint("SetJavaScriptEnabled", "MissingOnRenderProcessGone")
    private fun makeWebView(context: Context): WebView = WebView(context).apply {
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = false
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        settings.setSupportZoom(false)
        settings.builtInZoomControls = false
        settings.displayZoomControls = false
        settings.mediaPlaybackRequiresUserGesture = true
        settings.setGeolocationEnabled(false)
        overScrollMode = View.OVER_SCROLL_NEVER
        isVerticalScrollBarEnabled = true
        setBackgroundColor(Color.TRANSPARENT)
        webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? = intercept(request)

            /** Only the bundle's own documents load; a link is handed to the app by the editor (`openLink`). */
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                val ours = url.host == ASSET_HOST && url.path?.startsWith("/editor/") == true
                if (!ours) Log.w(TAG, "navigation refused: $url")
                return !ours
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                Log.e(TAG, "render process gone (crash=${detail.didCrash()})")
                failed = "render process gone"
                (view.parent as? ViewGroup)?.removeView(view)
                view.destroy()
                released = true
                return true
            }
        }
        webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                Log.d(TAG, "console ${message.messageLevel()}: ${message.message()} (${message.sourceId()}:${message.lineNumber()})")
                return true
            }
        }
        addJavascriptInterface(TaylisBridge(bridge), "TaylisBridge")
    }

    /** `TaylisBridge.post` from the page: called on the WebView's JavaScript thread. */
    private class TaylisBridge(private val bridge: EditorBridge) {
        @JavascriptInterface
        fun post(json: String) = bridge.post(json)
    }

    private fun onWeb(message: WebMessage) {
        if (released) return
        when (message) {
            is WebMessage.Ready -> {
                readyAfterMs = SystemClock.uptimeMillis() - startedAt
                Log.i(TAG, "ready (bridge ${message.version}) after $readyAfterMs ms")
                readyVersion = message.version
            }
            is WebMessage.Height -> if (firstHeightAt == null && loadSentAt > 0) {
                firstHeightAt = SystemClock.uptimeMillis()
                Log.i(TAG, "first paint ${firstHeightAt!! - loadSentAt} ms after load (${message.px.toInt()} px)")
            }
            is WebMessage.Log -> Log.println(
                when (message.level) { "error" -> Log.ERROR; "warn" -> Log.WARN; "info" -> Log.INFO; else -> Log.DEBUG },
                TAG, message.message + (message.detail?.let { "\n$it" } ?: ""),
            )
            else -> Unit
        }
        val target = session ?: leaving ?: return
        target.onWeb(message)
        if (message is WebMessage.Ready) {
            loadSentAt = SystemClock.uptimeMillis()
            firstHeightAt = null
        }
        if (message is WebMessage.BodyRequested && target === leaving && !target.awaitingBody) {
            leaving = null
            if (released) destroyNow()
        }
        if (target.unsupported) failed = "bridge version ${(message as? WebMessage.Ready)?.version}"
    }

    /** The page's editing session; a `ready` that came already is replayed so `load` goes out now. */
    fun attach(next: EditorSession) {
        session = next
        leaving = null
        readyVersion?.let {
            loadSentAt = SystemClock.uptimeMillis()
            firstHeightAt = null
            next.onWeb(WebMessage.Ready(it))
        }
    }

    /** Leaving the editor: the body as held now is asked for; the session stays for the answer (at most [LEAVE_GRACE_MS]). */
    fun detach(current: EditorSession) {
        if (session !== current) return
        session = null
        if (!current.loaded || released) return
        leaving = current
        current.requestBody(flush = true)
        main.postDelayed({ if (leaving === current) { leaving = null; if (released) destroyNow() } }, LEAVE_GRACE_MS)
    }

    /** The page screen goes: the WebView is destroyed (after a pending `requestBody` answered). */
    fun release() {
        if (released) return
        released = true
        session?.let { current ->
            session = null
            if (current.loaded) {
                leaving = current
                current.requestBody(flush = true)
                main.postDelayed({ if (leaving === current) { leaving = null; destroyNow() } }, LEAVE_GRACE_MS)
                return
            }
        }
        if (leaving == null) destroyNow()
    }

    private fun destroyNow() {
        (webView.parent as? ViewGroup)?.removeView(webView)
        webView.destroy()
    }

    fun send(message: NativeMessage) {
        if (BuildConfig.DEBUG && message is NativeMessage.Load) Log.d(TAG, "load ${message.body.length} chars, caretLine=${message.caretLine}")
        bridge.send(message)
    }

    /** The session editing now (DocPage asks it for the body and the caret before switching to Markdown). */
    val current: EditorSession? get() = session

    /**
     * The bundle's files, and the page's pictures (`/attachment/<id>`, `/emoji/<id>`) fetched by the app with its
     * session, cached here. Anything else is refused (the CSP refuses it too). Runs on the WebView's I/O threads.
     */
    private fun intercept(request: WebResourceRequest): WebResourceResponse {
        val url = request.url
        if (url.host != ASSET_HOST) return refuse()
        val path = url.path ?: return refuse()
        if (path.startsWith("/editor/")) return assets.shouldInterceptRequest(url) ?: refuse()
        val attachmentId = WikiLinks.attachmentOf("attachment:" + path.removePrefix("/attachment/")).takeIf { path.startsWith("/attachment/") }
        if (attachmentId != null) return image("a:$attachmentId") { controller.editorImage(attachmentId) }
        val emojiId = path.removePrefix("/emoji/").takeIf { path.startsWith("/emoji/") && UUID.matches(it) }?.lowercase()
        if (emojiId != null) return image("e:$emojiId") { controller.editorEmojiImage(emojiId) }
        return refuse()
    }

    private fun image(key: String, fetch: suspend () -> Pair<String, ByteArray>?): WebResourceResponse {
        val cached = images.get(key) ?: runCatching { runBlocking { fetch() } }.getOrNull()?.also { images.put(key, it) } ?: return refuse()
        return WebResourceResponse(cached.first, null, 200, "OK", mapOf("Cache-Control" to "private, max-age=3600"), ByteArrayInputStream(cached.second))
    }

    private fun refuse(): WebResourceResponse = WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), ByteArrayInputStream(ByteArray(0)))
}

/** The host for one page screen (made at once: the WebView warms up before 「編集」); null when WebView is unavailable. */
@Composable
internal fun rememberMobileEditorHost(controller: AppController, pageId: String): MobileEditorHost? {
    val context = LocalContext.current
    val host = remember(pageId) {
        runCatching { MobileEditorHost(context, controller) }.onFailure { Log.e(TAG, "no WebView", it) }.getOrNull()
    }
    DisposableEffect(host) { onDispose { host?.release() } }
    return host
}

/**
 * The editor for one page: the WebView (the formatting row at its bottom), and the app's row under it. `caretLine`:
 * where to open (from the Markdown editor); [onLeave] gets the caret's line when the editor is left.
 */
@Composable
internal fun MobileEditor(
    controller: AppController, host: MobileEditorHost, saver: CanvasSaver, title: String, readOnly: Boolean, caretLine: Int?,
    onOpenPage: (String) -> Unit, onCaret: (Int) -> Unit, modifier: Modifier = Modifier,
) {
    val store = controller.store
    val dark = controller.appearance.isDark(isSystemInDarkTheme())
    val theme = if (dark) EditorTheme.DARK else EditorTheme.LIGHT
    val uriHandler = LocalUriHandler.current
    val keyboard = LocalSoftwareKeyboardController.current
    val hub = controller.wiki
    // The session outlives recompositions: it reads the latest title, rights, theme and callbacks through these.
    val currentTitle by rememberUpdatedState(title)
    val currentReadOnly by rememberUpdatedState(readOnly)
    val currentTheme by rememberUpdatedState(theme)
    val currentOpenPage by rememberUpdatedState(onOpenPage)
    // The picker's launcher is remembered below the session; the env reaches it through this holder.
    val pickImage = remember { mutableStateOf<(() -> Unit)?>(null) }
    val session = remember(host, saver) {
        val env = object : EditorSessionEnv {
            override val title: String get() = currentTitle
            override val theme: EditorTheme get() = currentTheme
            override val locale: String? get() = controller.language
            override val readOnly: Boolean get() = currentReadOnly
            override val attachmentUrl: String get() = ATTACHMENT_URL
            override fun people(): List<BridgePerson> {
                val ai = controller.aiBotIdsRead
                val users = store.users.values.filter { it.deactivatedAt == null }.map { BridgePerson(it.id, it.username, it.displayName, ai = if (ai?.contains(it.id) == true) true else null) }
                val groups = store.groups.values.map { BridgePerson(it.id, it.name, it.name, kind = "group", members = it.memberIds.size, description = it.description) }
                return users + groups
            }
            override fun emoji(): List<BridgeEmoji> = store.customEmoji.values.map { emoji ->
                if (emoji.isText) BridgeEmoji(emoji.name, label = emoji.label, kind = "text", color = emoji.color)
                else BridgeEmoji(emoji.name, url = EMOJI_URL + emoji.id, label = emoji.label, kind = "image", width = emoji.width, height = emoji.height)
            }
            override fun pages(query: String?): List<BridgePage> {
                val all = hub?.pages?.values.orEmpty().filter { it.kind != "row" }.sortedWith(WikiTree.order)
                val q = query?.trim()?.lowercase().orEmpty()
                val found = if (q.isEmpty()) all else all.filter { it.title.lowercase().contains(q) }
                return (if (query == null) found else found.take(20)).map { BridgePage(it.id, it.title, it.icon, it.kind) }
            }
            override fun pickImage() {
                pickImage.value?.invoke()
            }
            override fun openLink(url: String) {
                WikiLinks.idOf(url)?.let { currentOpenPage(it); return }
                WikiLinks.attachmentOf(url)?.let { controller.openAttachmentById(it); return }
                if (url.startsWith("https://") || url.startsWith("http://")) runCatching { uriHandler.openUri(url) }.onFailure { Log.w(TAG, "could not open $url", it) }
                else Log.w(TAG, "link refused: $url")
            }
            override fun log(level: String, message: String, detail: String?) = Unit // the host logs them
            override fun unsupported(version: Int) {
                Log.e(TAG, "the bundled editor speaks bridge version $version, this app ${jp.chikuwachat.android.editor.EDITOR_BRIDGE_VERSION}")
                controller.error = L10n.str(R.string.docs_wysiwyg_unsupported)
            }
        }
        // No `focus` after `load`: Android's WebView raises the keyboard only for a tap, and a programmatic focus of an
        // unfocused editor lands the DOM caret at the start (the caret `load` placed on `caretLine` would be lost).
        EditorSession(saver, host::send, env, initialCaretLine = caretLine, autoFocus = false)
    }
    val photoPicker = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri == null) return@rememberLauncherForActivityResult
        controller.scope.launch {
            val uploaded = controller.uploadCanvasImage(uri) ?: return@launch
            session.insertImage(uploaded.id, null)
        }
    }
    pickImage.value = { photoPicker.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }

    DisposableEffect(host, session) {
        host.attach(session)
        onDispose {
            onCaret(session.caretLine ?: 0)
            host.detach(session)
        }
    }
    // The loop's text changed (a merge, someone else's version, a tick in the reading view): the editor takes it.
    val revision by saver.revision.collectAsState()
    LaunchedEffect(revision) { session.saverChanged() }
    LaunchedEffect(theme) { session.setTheme(theme) }
    // The app goes to the background: what is typed but not yet written goes to the loop (which flushes then).
    LaunchedEffect(controller.appForeground) { if (!controller.appForeground) session.requestBody(flush = true) }

    // adjustResize with edge-to-edge: the pane pads itself for the keyboard (MainScreen consumes the scaffold's insets),
    // so the WebView ends above it and its own formatting row (fixed at its bottom) sits right over the keyboard.
    Column(modifier.imePadding()) {
        AndroidView(
            factory = {
                (host.webView.parent as? ViewGroup)?.removeView(host.webView)
                host.webView
            },
            modifier = Modifier.weight(1f).fillMaxWidth().semantics { contentDescription = L10n.str(R.string.docs_wysiwyg_body) },
        )
        if (!readOnly) {
            HorizontalDivider()
            EditorKeyboardRow(
                onCommand = { session.command(it) },
                onImage = { pickImage.value?.invoke() },
                onDone = {
                    session.blur()
                    keyboard?.hide()
                },
            )
        }
    }
}

/**
 * The app's row under the editor's own formatting row: undo / redo, `@`, a picture, and 「キーボードを閉じる」. Taps on
 * these never take the focus from the WebView (Compose buttons take none in touch mode), so Gboard stays up.
 */
@Composable
private fun EditorKeyboardRow(onCommand: (EditorCommand) -> Unit, onImage: () -> Unit, onDone: () -> Unit) {
    Row(Modifier.fillMaxWidth().height(44.dp).padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        IconButton(onClick = { onCommand(EditorCommand.UNDO) }) { Icon(Icons.AutoMirrored.Outlined.Undo, contentDescription = stringResource(R.string.docs_wysiwyg_undo)) }
        IconButton(onClick = { onCommand(EditorCommand.REDO) }) { Icon(Icons.AutoMirrored.Outlined.Redo, contentDescription = stringResource(R.string.docs_wysiwyg_redo)) }
        IconButton(onClick = { onCommand(EditorCommand.MENTION) }) { Icon(Icons.Outlined.AlternateEmail, contentDescription = stringResource(R.string.common_mention)) }
        IconButton(onClick = onImage) { Icon(Icons.Outlined.AddPhotoAlternate, contentDescription = stringResource(R.string.common_image)) }
        Spacer(Modifier.weight(1f))
        IconButton(onClick = onDone) { Icon(Icons.Outlined.KeyboardHide, contentDescription = stringResource(R.string.docs_wysiwyg_done)) }
    }
}

/** The type of a picture served to the WebView, from its first bytes (a thumbnail's type is not in its metadata). */
internal object EditorImageType {
    fun of(bytes: ByteArray): String? = when {
        bytes.size >= 8 && bytes[0] == 0x89.toByte() && bytes[1] == 'P'.code.toByte() && bytes[2] == 'N'.code.toByte() && bytes[3] == 'G'.code.toByte() -> "image/png"
        bytes.size >= 3 && bytes[0] == 0xFF.toByte() && bytes[1] == 0xD8.toByte() && bytes[2] == 0xFF.toByte() -> "image/jpeg"
        bytes.size >= 6 && bytes[0] == 'G'.code.toByte() && bytes[1] == 'I'.code.toByte() && bytes[2] == 'F'.code.toByte() && bytes[3] == '8'.code.toByte() -> "image/gif"
        bytes.size >= 12 && bytes[0] == 'R'.code.toByte() && bytes[1] == 'I'.code.toByte() && bytes[2] == 'F'.code.toByte() && bytes[3] == 'F'.code.toByte() &&
            bytes[8] == 'W'.code.toByte() && bytes[9] == 'E'.code.toByte() && bytes[10] == 'B'.code.toByte() && bytes[11] == 'P'.code.toByte() -> "image/webp"
        else -> null
    }
}
