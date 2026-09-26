package jp.chikuwachat.android.platform

import android.util.Log
import jp.chikuwachat.android.api.ApiClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * Owns the FCM registration token and uploads it with `PUT /devices/current` whenever it changes or
 * a new session starts (PUSH_NOTIFICATIONS.md §3). The token source is injected: Firebase in the app,
 * a stub in tests. One user may have several tokens (one per device); each device uploads its own.
 */
class PushCenter(
    private val scope: CoroutineScope,
    private val tokenSource: suspend () -> String?,
    private val api: () -> ApiClient?,
) {
    var token: String? = null
        private set
    var uploadedToken: String? = null
        private set
    var uploads = 0
        private set

    /** A new session: the server device row is new, so register again even if the token is unchanged. */
    fun attach() {
        uploadedToken = null
        refresh()
    }

    /** Ask the SDK for the current token (it may have rotated while we were not running). */
    fun refresh() {
        scope.launch {
            val fetched = runCatching { tokenSource() }.onFailure { Log.i("PushCenter", "no push token: $it") }.getOrNull()
            if (fetched != null) token = fetched
            uploadIfNeeded()
        }
    }

    /** From FirebaseMessagingService.onNewToken (any thread). */
    fun tokenReceived(value: String) {
        token = value
        scope.launch { uploadIfNeeded() }
    }

    suspend fun uploadIfNeeded() {
        val current = token ?: return
        if (current == uploadedToken) return
        val client = api() ?: return
        runCatching { client.updateDevice("fcm", current) }
            .onSuccess { uploadedToken = current; uploads += 1 }
            .onFailure { Log.w("PushCenter", "push token upload failed: $it") }
    }
}
