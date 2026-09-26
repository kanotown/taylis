package jp.chikuwachat.android.platform

import android.content.Context
import com.google.android.gms.tasks.Task
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import jp.chikuwachat.android.ChikuwaApp
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** FCM entry points: token rotation and data-only messages (PUSH_NOTIFICATIONS.md §3, §9). */
class ChikuwaMessagingService : FirebaseMessagingService() {
    private val controller get() = (application as ChikuwaApp).controller

    override fun onNewToken(token: String) {
        controller.push.tokenReceived(token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val push = PushMessage.parse(message.data) ?: return
        controller.handlePush(push)
    }
}

/** Firebase is configured only when google-services.json was present at build time. */
fun firebaseConfigured(context: Context): Boolean = FirebaseApp.getApps(context).isNotEmpty()

suspend fun fetchFcmToken(context: Context): String? {
    if (!firebaseConfigured(context)) return null
    return FirebaseMessaging.getInstance().token.await()
}

private suspend fun <T> Task<T>.await(): T = suspendCancellableCoroutine { continuation ->
    addOnCompleteListener { task ->
        if (task.isSuccessful) continuation.resume(task.result) else continuation.resumeWithException(task.exception ?: IllegalStateException("task failed"))
    }
}
