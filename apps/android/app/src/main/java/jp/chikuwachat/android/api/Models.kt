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
)

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
)

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
)

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
