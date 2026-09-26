package jp.chikuwachat.android.platform

/** The data-only FCM message the server sends (PUSH_NOTIFICATIONS.md §5); keys are all strings. */
data class PushMessage(
    val kind: String,
    val channelId: String?,
    val messageId: String?,
    val seq: Int?,
    val title: String,
    val body: String,
) {
    val isSilent: Boolean get() = kind == "silent"

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
            )
        }
    }
}
