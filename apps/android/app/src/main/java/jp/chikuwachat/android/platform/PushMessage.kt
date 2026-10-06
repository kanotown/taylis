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
    /** M73: the canvas that newly mentions me (`kind = canvas`, CANVAS.md §18.1); `channel_id` is its conversation. */
    val canvasId: String? = null,
    /** M122 (docs/WIKI.md §9.3): the page that mentions me or was shared with me (`kind = page`). */
    val pageId: String? = null,
    /**
     * PUSH_NOTIFICATIONS.md §16 (`kind = message`): who sent it, their picture's version (null without one) and the
     * conversation's type (public / private / dm / group_dm), for the MessagingStyle notification with the sender's picture.
     */
    val senderId: String? = null,
    val senderName: String? = null,
    val senderAvatar: String? = null,
    val channelType: String? = null,
) {
    val isSilent: Boolean get() = kind == "silent"

    /** M52 (PUSH_NOTIFICATIONS.md, CALENDAR.md §6): one of my calendar alarms; the tap opens the event. */
    val isCalendar: Boolean get() = kind == "calendar" && eventId != null

    /** M56 (TASKS.md §5, §8): a task assigned to me or due today; the tap opens the task. */
    val isTask: Boolean get() = kind == "task" && taskId != null

    /** M73 (CANVAS.md §18.5): a canvas mentioned me; the tap opens it in its conversation's 「キャンバス」 tab. */
    val isCanvas: Boolean get() = kind == "canvas" && canvasId != null

    /** M122: a page of 「ドキュメント」 mentioned me or was shared with me; the tap opens the page. */
    val isPage: Boolean get() = kind == "page" && pageId != null

    /** M112: a reservation notice (an operator's to-do, or news of my own reservation): the tap opens 「予約」. */
    val isReservation: Boolean get() = kind == "reservation"

    /** §15: 「テスト通知を送る」: no conversation; the tap only opens the app. */
    val isTest: Boolean get() = kind == "test"

    /** Whether it becomes a notification: a conversation's, or a calendar alarm's / a task's / a test's (which have no conversation). */
    val shown: Boolean get() = !isSilent && notificationKey != null && (channelId != null || isCalendar || isTask || isTest || isReservation || isPage)

    /** M39: someone reacted to my message (PUSH_NOTIFICATIONS.md §4); the tap opens that message. */
    val isReaction: Boolean get() = kind == "reaction"

    /**
     * §16: a person's message, shown as a conversation (MessagingStyle, the sender's picture). Null for anything else, and
     * for a server that sends no sender (the plain notification then).
     */
    val conversation: ConversationNote? get() {
        if (kind != "message" || channelId == null) return null
        val sender = senderId ?: return null
        val group = ConversationNote.isGroup(channelType)
        return ConversationNote(
            senderId = sender,
            senderName = senderName ?: (if (group) subtitle else title)?.takeIf { it.isNotBlank() } ?: "?",
            senderAvatar = senderAvatar,
            isGroup = group,
            conversationTitle = if (group) title.takeIf { it.isNotBlank() } else null,
        )
    }

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
        // M73: one per canvas ("canvas:<canvas id>"): the next mention in it replaces it; a read of the conversation keeps it.
        "canvas" -> collapseKey ?: canvasId?.let { "canvas:$it" }
        // M122: one per page ("page:<page id>", the server's collapse key).
        "page" -> collapseKey ?: pageId?.let { "page:$it" }
        // M112: one per notice ("reservation:<item id>", the server's collapse key).
        "reservation" -> collapseKey ?: "reservation"
        // §15: one test notification at a time (the server's collapse key is "test").
        "test" -> collapseKey ?: "test"
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
                canvasId = data["canvas_id"]?.takeIf { it.isNotBlank() },
                pageId = data["page_id"]?.takeIf { it.isNotBlank() },
                senderId = data["sender_id"]?.takeIf { it.isNotBlank() },
                senderName = data["sender_name"]?.takeIf { it.isNotBlank() },
                senderAvatar = data["sender_avatar"]?.takeIf { it.isNotBlank() },
                channelType = data["channel_type"]?.takeIf { it.isNotBlank() },
            )
        }
    }
}
