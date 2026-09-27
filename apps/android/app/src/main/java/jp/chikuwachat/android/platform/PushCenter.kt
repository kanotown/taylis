package jp.chikuwachat.android.platform

import android.util.Log
import jp.chikuwachat.android.api.ApiClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * Owns the FCM registration token and uploads it with `PUT /devices/current` to every signed-in workspace
 * whenever it changes, at startup and when a new session starts (PUSH_NOTIFICATIONS.md §3, WORKSPACES.md §8).
 * The token source is injected: Firebase in the app, a stub in tests. One user may have several tokens (one per
 * device); each device uploads its own. A workspace in the background uploads through its own API client, which
 * renews its access token with the stored refresh token first (one refresh at a time per workspace).
 */
class PushCenter(
    private val scope: CoroutineScope,
    private val tokenSource: suspend () -> String?,
    /** The workspaces to register with: a key (the server URL) and that workspace's API client. */
    private val targets: suspend () -> List<Pair<String, ApiClient>>,
    /** Invalidates this install's token at the provider (FirebaseMessaging.deleteToken in the app). */
    private val tokenDeleter: suspend () -> Unit = {},
) {
    var token: String? = null
        private set
    /** Workspace → the token its current session holds. */
    private val uploaded = HashMap<String, String>()
    private val uploading = Mutex()
    var uploads = 0
        private set

    fun uploadedTo(key: String): String? = uploaded[key]

    /** A new session in a workspace: its device row is new, so register again even if the token is unchanged. */
    fun attach(key: String) {
        uploaded.remove(key)
        refresh()
    }

    /** A workspace signed out or left the list: nothing registered there counts any more. */
    fun detach(key: String) {
        uploaded.remove(key)
    }

    /** Ask the SDK for the current token (it may have rotated while we were not running) and upload where needed. */
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

    /**
     * Signed out without reaching the server (SYNC_PROTOCOL.md §11): the old session may still hold this token, so it
     * is deleted at FCM; the workspaces still signed in then get the new one.
     */
    fun forget() {
        token = null
        uploaded.clear()
        scope.launch {
            runCatching { tokenDeleter() }.onFailure { Log.w("PushCenter", "push token delete failed: $it") }
            refresh()
        }
    }

    suspend fun uploadIfNeeded() = uploading.withLock {
        val current = token ?: return@withLock
        for ((key, client) in targets()) {
            if (uploaded[key] == current) continue
            runCatching { client.updateDevice("fcm", current) }
                .onSuccess { uploaded[key] = current; uploads += 1 }
                .onFailure { Log.w("PushCenter", "push token upload failed: $it") }
        }
    }
}
