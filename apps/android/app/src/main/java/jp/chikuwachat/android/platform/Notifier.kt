package jp.chikuwachat.android.platform

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.os.Build
import android.os.Bundle
import androidx.core.app.NotificationCompat
import androidx.core.app.Person
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import jp.chikuwachat.android.MainActivity
import jp.chikuwachat.android.L10n
import jp.chikuwachat.android.R

/** Local notifications for DMs received while the app is in the background (PUSH_NOTIFICATIONS.md §9). */
class Notifier(private val context: Context) {
    private val manager = context.getSystemService(NotificationManager::class.java)

    init {
        refreshChannel()
    }

    /** Creates the channel, or renames it in the UI language (the system keeps the user's settings for the id). */
    fun refreshChannel() {
        manager.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, L10n.str(R.string.notification_channel_messages), NotificationManager.IMPORTANCE_HIGH),
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
    fun notifyMessage(
        /** M52: null for an alarm of my own calendar (no conversation); `eventId` then says what the tap opens. */
        channelId: String?, title: String, body: String, key: String = channelId ?: "", workspace: String? = null, subText: String? = null,
        /** M28c: the message and, for a reply, its thread: the tap opens the thread at the reply (as a permalink does). */
        messageId: String? = null, parentId: String? = null,
        /** M39: a reaction's notification: the tap reveals `messageId` itself (the push has no thread id for a reply). */
        reveal: Boolean = false,
        /** M28c: my unread count across the workspaces, for launchers that show a number on the app icon. */
        badge: Int? = null,
        /** M52: a calendar alarm's event: the tap opens it (in its channel's 「予定」 tab, or the calendar for my own). */
        eventId: String? = null,
        /** M56: a task's notification: the tap opens it (in its channel's 「タスク」 tab, or 「自分のタスク」 for a personal one). */
        taskId: String? = null,
        /** M73: a canvas mention's notification: the tap opens the canvas (its conversation's 「キャンバス」 tab). */
        canvasId: String? = null,
        /** M112: a reservation notice: the tap opens 「予約」. */
        reservations: Boolean = false,
    ) {
        if (!permitted) return
        val pending = contentIntent(channelId, key, workspace, messageId, parentId, reveal, eventId, taskId, canvasId, reservations)
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
        // The launcher badge (PUSH_NOTIFICATIONS.md §4.2 is iOS; here the standard notification number, which some launchers
        // show on the icon and Pixel's turns into a dot): nothing beyond the platform API, so no ShortcutBadger.
        if (badge != null && badge > 0) builder.setNumber(badge)
        manager.notify(key, NOTIFICATION_ID, builder.build())
    }

    /** The messages each conversation's notification lists while it is on screen ("workspace|key" → lines, pictures). */
    private val lines = HashMap<String, List<ConversationLine>>()
    private val icons = HashMap<String, MutableMap<String, IconCompat?>>()

    /**
     * PUSH_NOTIFICATIONS.md §16: a person's message as a conversation: MessagingStyle with the sender as a Person and
     * their picture ([avatar], already a circle), on a long-lived conversation shortcut, so Android shows the picture as
     * the main image and the app's small icon in its corner. The newest few messages of the conversation stay listed
     * while the notification is on screen; the same message from the socket and from FCM is listed once.
     */
    fun notifyConversation(
        channelId: String, title: String, body: String, note: ConversationNote, avatar: Bitmap?,
        key: String = channelId, workspace: String? = null, subText: String? = null,
        messageId: String? = null, parentId: String? = null, badge: Int? = null,
    ) {
        if (!permitted) return
        val slot = (workspace ?: "") + "|" + key
        val shown = runCatching { manager.activeNotifications.any { it.tag == key && it.id == NOTIFICATION_ID } }.getOrDefault(false)
        val previous = if (shown) lines[slot].orEmpty() else emptyList()
        val updated = ConversationStyle.append(previous, ConversationLine(messageId, note.senderId, note.senderName, body, System.currentTimeMillis()))
        if (shown && updated === previous) return // already listed (the socket's copy, then FCM's)
        lines[slot] = updated
        val icon = avatar?.let { IconCompat.createWithBitmap(it) }
        val people = (if (shown) icons[slot] else null) ?: HashMap()
        people[note.senderId] = icon
        icons[slot] = people
        val me = Person.Builder().setKey("me").setName(L10n.str(R.string.notification_me)).build()
        val sender = ConversationStyle.person(note.senderId, note.senderName, icon)
        val label = (if (note.isGroup) note.conversationTitle else null) ?: note.senderName
        val shortcut = ShortcutInfoCompat.Builder(context, ConversationStyle.shortcutId(workspace, channelId))
            .setShortLabel(label.take(SHORTCUT_LABEL_MAX).ifBlank { "?" })
            .setLongLived(true)
            .setPerson(sender)
            .setIcon(icon ?: IconCompat.createWithResource(context, R.mipmap.ic_launcher))
            .setIntent(
                Intent(context, MainActivity::class.java).apply {
                    action = ACTION_CONVERSATION
                    putExtra(EXTRA_CHANNEL_ID, channelId)
                    if (workspace != null) putExtra(EXTRA_WORKSPACE, workspace)
                },
            )
            .build()
        // The notification never depends on the shortcut (a launcher's limit, a work profile's policy…).
        val withShortcut = runCatching { ShortcutManagerCompat.pushDynamicShortcut(context, shortcut) }.isSuccess
        val builder = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(ConversationStyle.style(me, updated, people, note.isGroup, note.conversationTitle))
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setContentIntent(contentIntent(channelId, key, workspace, messageId, parentId))
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
        if (withShortcut) builder.setShortcutInfo(shortcut)
        // Before Android 11 there are no conversation notifications: the picture is the large icon instead.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R && avatar != null) builder.setLargeIcon(avatar)
        if (subText != null) builder.setSubText(subText)
        if (workspace != null) builder.addExtras(Bundle().apply { putString(EXTRA_WORKSPACE, workspace) })
        if (badge != null && badge > 0) builder.setNumber(badge)
        manager.notify(key, NOTIFICATION_ID, builder.build())
    }

    private fun contentIntent(
        channelId: String?, key: String, workspace: String?, messageId: String?, parentId: String?, reveal: Boolean = false,
        eventId: String? = null, taskId: String? = null, canvasId: String? = null, reservations: Boolean = false,
    ): PendingIntent {
        // M16c: the tap opens the notification's workspace first (WORKSPACES.md §7).
        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_NEW_TASK
            if (channelId != null) putExtra(EXTRA_CHANNEL_ID, channelId)
            if (eventId != null) putExtra(EXTRA_EVENT_ID, eventId)
            if (taskId != null) putExtra(EXTRA_TASK_ID, taskId)
            if (canvasId != null) putExtra(EXTRA_CANVAS_ID, canvasId)
            if (reservations) putExtra(EXTRA_RESERVATIONS, true)
            if (workspace != null) putExtra(EXTRA_WORKSPACE, workspace)
            if (messageId != null) putExtra(EXTRA_MESSAGE_ID, messageId)
            if (parentId != null) putExtra(EXTRA_PARENT_ID, parentId)
            if (reveal) putExtra(EXTRA_REVEAL, true)
        }
        val request = ((workspace ?: "") + "|" + key).hashCode()
        return PendingIntent.getActivity(context, request, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    /** The conversation was read (here or elsewhere): its message notification goes; reminders stay. */
    fun clear(channelId: String) {
        manager.cancel(channelId, NOTIFICATION_ID)
        lines.keys.filter { it.endsWith("|$channelId") }.forEach { lines.remove(it); icons.remove(it) }
    }

    /** Signed out (SYNC_PROTOCOL.md §11): nothing of the old account stays on screen. */
    fun clearAll() {
        manager.cancelAll()
        forgetConversations(null)
        avatars.clear()
    }

    /** §16: the senders' pictures for [notifyConversation] (a disk cache dropped with the last sign-out). */
    val avatars = NotificationAvatars(context)

    /** §16: a workspace's (null: every) conversation shortcuts and listed messages go with its sign-out. */
    private fun forgetConversations(workspace: String?) {
        val prefix = workspace?.let { "$it|" }
        lines.keys.filter { prefix == null || it.startsWith(prefix) }.forEach { lines.remove(it); icons.remove(it) }
        runCatching {
            val flags = ShortcutManagerCompat.FLAG_MATCH_DYNAMIC or ShortcutManagerCompat.FLAG_MATCH_CACHED
            val mine = workspace?.let { ConversationStyle.shortcutId(it, "") } ?: "conv:"
            val ids = ShortcutManagerCompat.getShortcuts(context, flags).map { it.id }.filter { it.startsWith(mine) }
            if (ids.isNotEmpty()) {
                ShortcutManagerCompat.removeDynamicShortcuts(context, ids)
                ShortcutManagerCompat.removeLongLivedShortcuts(context, ids)
            }
        }
    }

    /**
     * One workspace signed out (WORKSPACES.md §5.3): its notifications go, the others' stay. `everything` when it was
     * the only one (notifications posted before workspaces existed carry no workspace).
     */
    fun clearWorkspace(workspace: String, everything: Boolean) {
        if (everything) {
            clearAll()
            return
        }
        forgetConversations(workspace)
        runCatching { manager.activeNotifications }.getOrNull()?.forEach { shown ->
            if (shown.notification.extras?.getString(EXTRA_WORKSPACE) == workspace) manager.cancel(shown.tag, shown.id)
        }
    }

    companion object {
        const val CHANNEL_ID = "messages"
        /** §16: a conversation shortcut (the launcher's long-press list, the conversation settings) opens its channel. */
        const val ACTION_CONVERSATION = "jp.chikuwachat.android.OPEN_CONVERSATION"
        private const val SHORTCUT_LABEL_MAX = 40
        const val EXTRA_CHANNEL_ID = "channel_id"
        /** M28c: the message the notification is about and, for a reply, its thread's parent. */
        const val EXTRA_MESSAGE_ID = "message_id"
        const val EXTRA_PARENT_ID = "parent_id"
        /** M39: open the message itself (a reaction's notification), not the conversation at its unread position. */
        const val EXTRA_REVEAL = "reveal"
        /** M52: the calendar event of an alarm's notification. */
        const val EXTRA_EVENT_ID = "event_id"
        /** M56: the task of an assignment's or a due date's notification. */
        const val EXTRA_TASK_ID = "task_id"
        /** M73: the canvas of a mention's notification. */
        const val EXTRA_CANVAS_ID = "canvas_id"
        const val EXTRA_RESERVATIONS = "reservations"
        /** The workspace's server URL (the list key, WORKSPACES.md §4). */
        const val EXTRA_WORKSPACE = "workspace"
        /** Notifications are told apart by their tag (the key); the id is the same for all. */
        private const val NOTIFICATION_ID = 1
    }
}
