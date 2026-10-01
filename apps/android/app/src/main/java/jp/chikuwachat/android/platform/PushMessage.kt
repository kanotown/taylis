package jp.chikuwachat.android.platform

/** The data-only FCM message the server sends (PUSH_NOTIFICATIONS.md §5); keys are all strings. */
data class PushMessage(
    val kind: String,
    val channelId: String?,
    val messageId: String?,
    /** The thread the message replies in (its parent's id); absent for a top-level post. A tap opens the thread then. */
    val parentId: String? = null,
    val seq: Int?,
    val title: String,
    val body: String,
    /** The sender in a channel or group DM ("Alice"); absent for a 1:1 DM, whose title is the sender. */
    val subtitle: String? = null,
    /** The channel id for messages, "reminder:<id>" for reminders. */
    val collapseKey: String? = null,
    /** The deployment that sent it (WORKSPACES.md §3.3): which workspace the notification belongs to. */
    val workspaceId: String? = null,
    /** That server's app-icon count for me when it was sent (PUSH_NOTIFICATIONS.md §4.2); an approximation. */
    val badge: Int? = null,
    /** M52: a calendar alarm's event (`kind = calendar`); its `channel_id` is null for my own calendar. */
    val eventId: String? = null,
    /** M56: a task's assignment or due date (`kind = task`); its `channel_id` is null for a personal task. */
    val taskId: String? = null,
) {
    val isSilent: Boolean get() = kind == "silent"

    /** M52 (PUSH_NOTIFICATIONS.md, CALENDAR.md §6): one of my calendar alarms; the tap opens the event. */
    val isCalendar: Boolean get() = kind == "calendar" && eventId != null

    /** M56 (TASKS.md §5, §8): a task assigned to me or due today; the tap opens the task. */
    val isTask: Boolean get() = kind == "task" && taskId != null

    /** Whether it becomes a notification: a conversation's, or a calendar alarm's / a task's (which may have no conversation). */
    val shown: Boolean get() = !isSilent && notificationKey != null && (channelId != null || isCalendar || isTask)

    /** M39: someone reacted to my message (PUSH_NOTIFICATIONS.md §4); the tap opens that message. */
    val isReaction: Boolean get() = kind == "reaction"

    /** "#general · Alice", or just the sender for a DM (the same title the in-app notifications use). */
    val displayTitle: String get() = listOfNotNull(title.takeIf { it.isNotBlank() }, subtitle?.takeIf { it.isNotBlank() }).joinToString(" · ")

    /**
     * Which notification this replaces: one per conversation for messages (so reading it elsewhere clears
     * it), one per reminder for reminders (never replaced by the next message, nor cleared by a read). M39: one per
     * message reacted to ("reaction:<message id>"): the next reaction to it replaces it, and it neither replaces nor
     * is cleared with its conversation's message notification.
     */
    val notificationKey: String? get() = when (kind) {
        "reminder" -> collapseKey ?: messageId?.let { "reminder:$it" }
        "reaction" -> collapseKey ?: messageId?.let { "reaction:$it" }
        // M52: one per event ("calendar:<event id>"): never replaced by a message, nor cleared by a read.
        "calendar" -> collapseKey ?: eventId?.let { "calendar:$it" }
        // M56: one per task ("task:<task id>"), the server's collapse key.
        "task" -> collapseKey ?: taskId?.let { "task:$it" }
        else -> channelId
    }

    companion object {
        fun parse(data: Map<String, String>): PushMessage? {
            val kind = data["kind"] ?: return null
            return PushMessage(
                kind = kind,
                channelId = data["channel_id"]?.takeIf { it.isNotBlank() },
                messageId = data["message_id"]?.takeIf { it.isNotBlank() },
                parentId = data["parent_id"]?.takeIf { it.isNotBlank() },
                seq = data["seq"]?.toIntOrNull(),
                title = data["title"] ?: "",
                body = data["body"] ?: "",
                subtitle = data["subtitle"]?.takeIf { it.isNotBlank() },
                collapseKey = data["collapse_key"]?.takeIf { it.isNotBlank() },
                workspaceId = data["workspace_id"]?.takeIf { it.isNotBlank() },
                badge = data["badge"]?.toIntOrNull(),
                eventId = data["event_id"]?.takeIf { it.isNotBlank() },
                taskId = data["task_id"]?.takeIf { it.isNotBlank() },
            )
        }
    }
}
