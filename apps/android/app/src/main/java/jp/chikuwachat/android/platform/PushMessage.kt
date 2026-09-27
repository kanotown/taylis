package jp.chikuwachat.android.platform

/** The data-only FCM message the server sends (PUSH_NOTIFICATIONS.md §5); keys are all strings. */
data class PushMessage(
    val kind: String,
    val channelId: String?,
    val messageId: String?,
    val seq: Int?,
    val title: String,
    val body: String,
    /** The sender in a channel or group DM ("Alice"); absent for a 1:1 DM, whose title is the sender. */
    val subtitle: String? = null,
    /** The channel id for messages, "reminder:<id>" for reminders. */
    val collapseKey: String? = null,
) {
    val isSilent: Boolean get() = kind == "silent"

    /** "#general · Alice", or just the sender for a DM (the same title the in-app notifications use). */
    val displayTitle: String get() = listOfNotNull(title.takeIf { it.isNotBlank() }, subtitle?.takeIf { it.isNotBlank() }).joinToString(" · ")

    /**
     * Which notification this replaces: one per conversation for messages (so reading it elsewhere clears
     * it), one per reminder for reminders (never replaced by the next message, nor cleared by a read).
     */
    val notificationKey: String? get() = if (kind == "reminder") collapseKey ?: messageId?.let { "reminder:$it" } else channelId

    companion object {
        fun parse(data: Map<String, String>): PushMessage? {
            val kind = data["kind"] ?: return null
            return PushMessage(
                kind = kind,
                channelId = data["channel_id"]?.takeIf { it.isNotBlank() },
                messageId = data["message_id"]?.takeIf { it.isNotBlank() },
                seq = data["seq"]?.toIntOrNull(),
                title = data["title"] ?: "",
                body = data["body"] ?: "",
                subtitle = data["subtitle"]?.takeIf { it.isNotBlank() },
                collapseKey = data["collapse_key"]?.takeIf { it.isNotBlank() },
            )
        }
    }
}
