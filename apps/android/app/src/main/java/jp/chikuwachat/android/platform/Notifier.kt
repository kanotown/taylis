package jp.chikuwachat.android.platform

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import jp.chikuwachat.android.MainActivity
import jp.chikuwachat.android.R

/** Local notifications for DMs received while the app is in the background (PUSH_NOTIFICATIONS.md §9). */
class Notifier(private val context: Context) {
    private val manager = context.getSystemService(NotificationManager::class.java)

    init {
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, context.getString(R.string.notification_channel_messages), NotificationManager.IMPORTANCE_HIGH),
        )
    }

    val permitted: Boolean
        get() = Build.VERSION.SDK_INT < 33 ||
            context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    /**
     * `key` names the notification: the channel id for messages (the newest message replaces the previous
     * one; a read clears it), "reminder:<id>" for a reminder so it stands on its own. The socket and FCM may
     * both post the same message: the replacement does not ring a second time.
     */
    fun notifyMessage(channelId: String, title: String, body: String, key: String = channelId, workspace: String? = null, subText: String? = null) {
        if (!permitted) return
        // M16c: the tap opens the notification's workspace first (WORKSPACES.md §7).
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_NEW_TASK
            putExtra(EXTRA_CHANNEL_ID, channelId)
            if (workspace != null) putExtra(EXTRA_WORKSPACE, workspace)
        }
        val request = ((workspace ?: "") + "|" + key).hashCode()
        val pending = PendingIntent.getActivity(context, request, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val builder = Notification.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(Notification.BigTextStyle().bigText(body))
            .setContentIntent(pending)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
        // With two or more workspaces the name tells them apart.
        if (subText != null) builder.setSubText(subText)
        if (workspace != null) builder.addExtras(Bundle().apply { putString(EXTRA_WORKSPACE, workspace) })
        manager.notify(key, NOTIFICATION_ID, builder.build())
    }

    /** The conversation was read (here or elsewhere): its message notification goes; reminders stay. */
    fun clear(channelId: String) = manager.cancel(channelId, NOTIFICATION_ID)

    /** Signed out (SYNC_PROTOCOL.md §11): nothing of the old account stays on screen. */
    fun clearAll() = manager.cancelAll()

    /**
     * One workspace signed out (WORKSPACES.md §5.3): its notifications go, the others' stay. `everything` when it was
     * the only one (notifications posted before workspaces existed carry no workspace).
     */
    fun clearWorkspace(workspace: String, everything: Boolean) {
        if (everything) {
            manager.cancelAll()
            return
        }
        runCatching { manager.activeNotifications }.getOrNull()?.forEach { shown ->
            if (shown.notification.extras?.getString(EXTRA_WORKSPACE) == workspace) manager.cancel(shown.tag, shown.id)
        }
    }

    companion object {
        const val CHANNEL_ID = "messages"
        const val EXTRA_CHANNEL_ID = "channel_id"
        /** The workspace's server URL (the list key, WORKSPACES.md §4). */
        const val EXTRA_WORKSPACE = "workspace"
        /** Notifications are told apart by their tag (the key); the id is the same for all. */
        private const val NOTIFICATION_ID = 1
    }
}
