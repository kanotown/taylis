package jp.chikuwachat.android.editor

/**
 * M153a (docs/WIKI.md §30.3): the transport of the editor bridge on the app's side. App → editor goes through
 * [EditorPort.evaluate] (`WebView.evaluateJavascript` on the UI thread); editor → app arrives in [post] from the
 * WebView's JavaScript thread (the `TaylisBridge.post` interface, ui/MobileEditor.kt) and is handed to [listener] on
 * the main thread through [main], in the order it came. A message that cannot be read is reported to [refused], not
 * thrown at the WebView.
 */
class EditorBridge(
    private val port: EditorPort,
    /** Runs a block on the main thread (the app: the main looper; the tests: at once). */
    private val main: (Runnable) -> Unit,
    private val listener: (WebMessage) -> Unit,
    private val refused: (EditorBridgeRefused) -> Unit = {},
) {
    /** Every message sent, for the log (bodies by their length). */
    var sent = 0
        private set

    fun send(message: NativeMessage) {
        sent += 1
        port.evaluate(EditorBridgeCodec.receiveCall(message))
    }

    /** `TaylisBridge.post(json)`: called off the UI thread. */
    fun post(json: String) {
        main(Runnable {
            EditorBridgeCodec.decodeWeb(json).fold(
                onSuccess = { listener(it) },
                onFailure = { refused(it as? EditorBridgeRefused ?: EditorBridgeRefused(json, it.message ?: "refused")) },
            )
        })
    }
}

/** Where the bridge's JavaScript runs. */
fun interface EditorPort {
    fun evaluate(js: String)
}
