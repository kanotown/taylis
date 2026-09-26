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

    fun notifyMessage(channelId: String, title: String, body: String) {
        if (!permitted) return
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_NEW_TASK
            putExtra(EXTRA_CHANNEL_ID, channelId)
        }
        val pending = PendingIntent.getActivity(context, channelId.hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val notification = Notification.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(Notification.BigTextStyle().bigText(body))
            .setContentIntent(pending)
            .setAutoCancel(true)
            .build()
        // One notification per channel: the newest message replaces the previous one.
        manager.notify(channelId.hashCode(), notification)
    }

    fun clear(channelId: String) = manager.cancel(channelId.hashCode())

    companion object {
        const val CHANNEL_ID = "messages"
        const val EXTRA_CHANNEL_ID = "channel_id"
    }
}
