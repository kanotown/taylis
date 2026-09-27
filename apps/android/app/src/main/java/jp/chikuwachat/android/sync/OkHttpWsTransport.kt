package jp.chikuwachat.android.sync

import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** OkHttp WebSocket adapted to the engine's transport. Callbacks arrive on OkHttp threads. */
class OkHttpWsTransport private constructor() : WsTransport {
    override var onMessage: ((String) -> Unit)? = null
    override var onClose: ((Int) -> Unit)? = null
    private var socket: WebSocket? = null
    @Volatile private var closed = false

    override fun send(text: String) {
        socket?.send(text)
    }

    override fun close() {
        socket?.close(1000, null)
        fireClose(1000)
    }

    /** Half-open (§5.3): a closing handshake would only wait for a peer that is gone. */
    override fun abort() {
        socket?.cancel()
        fireClose(1006)
    }

    private fun fireClose(code: Int) {
        if (closed) return
        closed = true
        onClose?.invoke(code)
    }

    companion object {
        suspend fun connect(client: OkHttpClient, url: String): WsTransport = suspendCancellableCoroutine { continuation ->
            val transport = OkHttpWsTransport()
            var opened = false
            val request = Request.Builder().url(url).build()
            transport.socket = client.newWebSocket(request, object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    opened = true
                    continuation.resume(transport)
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    transport.onMessage?.invoke(text)
                }

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    webSocket.close(code, reason)
                    transport.fireClose(code)
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    transport.fireClose(code)
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    if (!opened) continuation.resumeWithException(t) else transport.fireClose(1006)
                }
            })
            continuation.invokeOnCancellation { transport.socket?.cancel() }
        }
    }
}
