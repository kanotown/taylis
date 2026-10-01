package jp.chikuwachat.android.sync

import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.CanvasMeta
import kotlinx.coroutines.delay

/** M58: what a `/c/<id>` card shows (CANVAS.md §4.13): the canvas, or why it cannot. */
sealed class CanvasLinkState {
    data class Ok(val canvas: CanvasMeta) : CanvasLinkState()
    /** 403: outside the canvas's conversation (nothing of it is shown). */
    data object Forbidden : CanvasLinkState()
    /** 404: in the trash, or gone. */
    data object Missing : CanvasLinkState()
    /** Could not be read (offline, 5xx): asked again on a tap. */
    data object Failed : CanvasLinkState()

    companion object {
        /** The card's state for a failed GET /canvases/{id}. */
        fun of(e: Throwable): CanvasLinkState = when {
            e is ApiException.Api && e.status == 403 -> Forbidden
            e is ApiException.Api && e.status == 404 -> Missing
            else -> Failed
        }
    }
}

/** M58: request patterns of the canvas actions (CANVAS.md §4.9 / §4.13). */
object CanvasRequests {
    /**
     * One operation sent with one idempotency key: a failure on the network is sent again with the same key, at most
     * `retries` more times (a restore whose answer was lost is one version, not two). Other failures are thrown at once.
     */
    suspend fun <T> sameKey(key: String, retries: Int = 2, wait: suspend (attempt: Int) -> Unit = { delay(1_000L * it) }, send: suspend (String) -> T): T {
        var attempt = 0
        while (true) {
            try {
                return send(key)
            } catch (e: ApiException.Network) {
                if (attempt >= retries) throw e
                attempt++
                wait(attempt)
            }
        }
    }
}
