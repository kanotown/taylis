package jp.chikuwachat.android.api

import kotlinx.serialization.Serializable

// Models mirror the shared OpenAPI document (openapi/openapi.json). Wire keys are snake_case,
// mapped by JsonNamingStrategy.SnakeCase in Json.kt.

@Serializable
data class UserPublic(
    val id: String,
    val username: String,
    val displayName: String,
    val role: String,
    val deactivatedAt: String? = null,
    val createdAt: String,
    val updatedAt: String,
    /** Profile card (M11d); the server reports an expired status as null. */
    val title: String? = null,
    val statusText: String? = null,
    val statusEmoji: String? = null,
    val statusExpiresAt: String? = null,
    /** Do not disturb (M12c): a manual pause and the daily quiet hours (public, for 🔕 next to the name). */
    val dndUntil: String? = null,
    val quietHours: QuietHours? = null,
)

/** A daily window (in the user's zone) during which pushes are held back (M12c). */
@Serializable
data class QuietHours(val start: String, val end: String, val days: List<Int> = emptyList(), val tz: String)

@Serializable
data class UserMe(
    val id: String,
    val username: String,
    val displayName: String,
    val role: String,
    val deactivatedAt: String? = null,
    val createdAt: String,
    val updatedAt: String,
    val email: String? = null,
    val mustChangePassword: Boolean,
    val title: String? = null,
    val statusText: String? = null,
    val statusEmoji: String? = null,
    val statusExpiresAt: String? = null,
    val dndUntil: String? = null,
    val quietHours: QuietHours? = null,
) {
    val asPublic: UserPublic get() = UserPublic(id, username, displayName, role, deactivatedAt, createdAt, updatedAt, title, statusText, statusEmoji, statusExpiresAt, dndUntil, quietHours)
}

/** A custom status (M11d) that has not expired: emoji to text; null otherwise. */
fun activeStatus(user: UserPublic?, now: Long = System.currentTimeMillis()): Pair<String, String>? {
    if (user == null) return null
    val emoji = user.statusEmoji ?: ""
    val text = user.statusText ?: ""
    if (emoji.isEmpty() && text.isEmpty()) return null
    val expires = user.statusExpiresAt?.let { runCatching { java.time.Instant.parse(it).toEpochMilli() }.getOrNull() }
    if (expires != null && expires <= now) return null
    return emoji to text
}

@Serializable
data class DeviceOut(
    val id: String,
    val platform: String,
    val deviceName: String? = null,
    val appVersion: String? = null,
    val enabled: Boolean,
    val disabledReason: String? = null,
    val pushProvider: String = "none",
    val pushEnvironment: String? = null,
    val pushRegistered: Boolean = false,
    val lastSeenAt: String? = null,
    val createdAt: String,
    val updatedAt: String,
)

@Serializable
data class TokenResponse(
    val accessToken: String,
    val refreshToken: String,
    val tokenType: String,
    val expiresIn: Int,
    val sessionId: String,
    val device: DeviceOut,
    val user: UserMe,
)

@Serializable
data class MembershipOut(val role: String, val joinedAt: String)

@Serializable
data class NotificationPreferenceOut(val channelId: String, val level: String, val mutedUntil: String? = null)

@Serializable
data class ReadStateOut(val lastReadSeq: Int, val unreadCount: Int, val mentionCount: Int)

@Serializable
data class ChannelOut(
    val id: String,
    val type: String,
    val name: String? = null,
    val topic: String? = null,
    val purpose: String? = null,
    val archived: Boolean,
    val createdBy: String? = null,
    val lastSeq: Int,
    val lastMessageAt: String? = null,
    val createdAt: String,
    val updatedAt: String,
    val membership: MembershipOut? = null,
    val dmUserIds: List<String>? = null,
    val notification: NotificationPreferenceOut? = null,
    val readState: ReadStateOut? = null,
    /** How many members the channel has (M11h); lists, single-channel responses and channel events carry it. */
    val memberCount: Int? = null,
) {
    val isDm: Boolean get() = type == "dm" || type == "group_dm"
}

@Serializable
data class ReactionOut(val emoji: String, val count: Int, val userIds: List<String> = emptyList())

@Serializable
data class AttachmentOut(
    val id: String,
    val filename: String,
    val contentType: String,
    val sizeBytes: Long,
    val width: Int? = null,
    val height: Int? = null,
    val hasThumbnail: Boolean = false,
    val status: String = "attached",
    val createdAt: String = "",
) {
    val isImage: Boolean get() = hasThumbnail
}

@Serializable
data class MessageOut(
    val id: String,
    val channelId: String,
    val senderId: String,
    val seq: Int,
    val updatedSeq: Int,
    val clientMsgId: String? = null,
    val parentId: String? = null,
    val type: String = "user",
    val body: String,
    val mentionedUserIds: List<String> = emptyList(),
    val mentionAll: Boolean = false,
    val reactions: List<ReactionOut> = emptyList(),
    val attachments: List<AttachmentOut> = emptyList(),
    val replyCount: Int = 0,
    val lastReplyAt: String? = null,
    val createdAt: String,
    val editedAt: String? = null,
    val deleted: Boolean,
    /** Pinned in the channel (M11c); both null when not pinned. */
    val pinnedAt: String? = null,
    val pinnedBy: String? = null,
) {
    fun mentions(userId: String): Boolean = mentionAll || userId in mentionedUserIds
    val isReply: Boolean get() = parentId != null
}

/** The parent's thread fields after a reply changed them (SYNC_PROTOCOL.md §6). */
@Serializable
data class ParentThread(
    val id: String,
    val replyCount: Int,
    val lastReplyAt: String? = null,
    val updatedSeq: Int,
    val participantIds: List<String> = emptyList(),
)

@Serializable
data class HistoryOut(val channelLastSeq: Int, val messages: List<MessageOut>, val hasMore: Boolean)

@Serializable
data class DeltaOut(val messages: List<MessageOut>, val nextSinceSeq: Int, val hasMore: Boolean)

@Serializable
data class Limits(val maxMessageLength: Int, val maxAttachmentBytes: Long, val maxAttachmentsPerMessage: Int)

@Serializable
data class BootstrapOut(
    val serverTime: String,
    val me: UserMe,
    val users: List<UserPublic>,
    val channels: List<ChannelOut>,
    val limits: Limits,
    /** Followed threads with unread replies / mentions (THREADS.md §3); the 「スレッド」 badge. */
    val threads: ThreadSummary? = null,
    /** Who is connected right now (SYNC_PROTOCOL.md §5.2 presence); users not listed are offline. */
    val presence: List<PresenceEntry> = emptyList(),
    /** My saved messages (M11c): ids only, newest first; the list itself is GET /bookmarks. */
    val bookmarks: List<String> = emptyList(),
    /** My starred channels (M12a) among `channels`. */
    val favorites: List<String> = emptyList(),
)

/** PUT / DELETE /channels/{id}/favorite (M12a). */
@Serializable
data class FavoriteStateOut(val channelId: String, val favorite: Boolean)

/** One row of POST /channels/read-all (M12a). */
@Serializable
data class ChannelReadStateOut(val channelId: String, val lastReadSeq: Int, val unreadCount: Int, val mentionCount: Int)

@Serializable
data class BookmarkStateOut(val messageId: String, val bookmarked: Boolean)

@Serializable
data class BookmarkItem(val message: MessageOut, val createdAt: String)

/** `nextCursor` goes back as `cursor` for the next page; null when the page was empty. */
@Serializable
data class BookmarkListOut(val items: List<BookmarkItem>, val nextCursor: String? = null)

/** GET /files (M11i): one attached file and where it was posted. */
@Serializable
data class FileItem(
    val attachment: AttachmentOut,
    val messageId: String,
    val channelId: String,
    val parentId: String? = null,
    val uploaderId: String,
    val attachedAt: String,
)

@Serializable
data class FileListOut(val items: List<FileItem>, val nextCursor: String? = null)

/** A personal reminder about a message (M12e); `status` is pending | fired | done | cancelled. */
@Serializable
data class ReminderOut(
    val id: String,
    val messageId: String,
    val channelId: String,
    val note: String? = null,
    val preview: String = "",
    val remindAt: String,
    val status: String,
    val firedAt: String? = null,
    val createdAt: String,
)

/** A message the server posts later (M12d); `status` is pending | sent | failed | cancelled. */
@Serializable
data class ScheduledOut(
    val id: String,
    val channelId: String,
    val parentId: String? = null,
    val clientMsgId: String,
    val body: String,
    val attachments: List<AttachmentOut> = emptyList(),
    val sendAt: String,
    val status: String,
    val error: String? = null,
    val sentMessageId: String? = null,
    val createdAt: String,
)

/** GET /mentions (M11h): messages that mention me or everyone, newest first. */
@Serializable
data class MentionListOut(val items: List<MessageOut>, val nextCursor: String? = null)

@Serializable
data class PresenceEntry(val userId: String, val status: String)

/** My relation to one thread (THREADS.md §3). */
@Serializable
data class ThreadState(
    val parentId: String,
    val channelId: String,
    val following: Boolean,
    val lastReadSeq: Int,
    val unreadCount: Int,
    val mentionCount: Int,
    val replyCount: Int,
    val lastReplyAt: String? = null,
    /** Current followers: who gets thread.updated and the reply's push. */
    val participantIds: List<String> = emptyList(),
)

@Serializable
data class ThreadItem(val parent: MessageOut, val state: ThreadState)

@Serializable
data class ThreadSummary(val unreadCount: Int = 0, val mentionCount: Int = 0)

/** `nextCursor` goes back as `cursor` for the next page; null when the page was empty. */
@Serializable
data class ThreadListOut(val items: List<ThreadItem>, val nextCursor: String? = null, val summary: ThreadSummary)

@Serializable
data class MemberOut(val userId: String, val role: String, val joinedAt: String)

@Serializable
data class ErrorEnvelope(val error: ErrorInner)

@Serializable
data class ErrorInner(val code: String, val message: String)

@Serializable
data class SearchHit(val message: MessageOut, val score: Double = 0.0)

@Serializable
data class SearchOut(
    val hits: List<SearchHit>,
    val keywords: List<String> = emptyList(),
    val filters: SearchFilters? = null,
    val limit: Int,
    val offset: Int,
    val hasMore: Boolean,
)

/** What the server understood from the query's modifiers (from: in: before: after: on:). */
@Serializable
data class SearchFilters(
    val text: String = "",
    val fromUsername: String? = null,
    val inChannel: String? = null,
    val after: String? = null,
    val before: String? = null,
    val unresolved: List<String> = emptyList(),
)

/** Open Graph data for a link (M11g); `status == "failed"` means the page gave nothing usable. */
@Serializable
data class LinkPreviewOut(
    val url: String,
    val status: String,
    val title: String? = null,
    val description: String? = null,
    val imageUrl: String? = null,
    val siteName: String? = null,
    val fetchedAt: String,
)
