package jp.chikuwachat.android.api

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

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
    val avatarUpdatedAt: String? = null,
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
    /** M12g: words that make a message count as a mention of me. */
    val notifyKeywords: List<String> = emptyList(),
    /** M14a: when the profile picture changed (null = no picture); the cache key. */
    val avatarUpdatedAt: String? = null,
    /** L4 (M31): others always see me offline (the server never sends my presence). */
    val presenceHidden: Boolean = false,
    /**
     * M35: what channels without a level of their own notify me of ("all" / "mentions" / "none"; PUSH_NOTIFICATIONS.md
     * §4). Pushes only: the unread rules never read it (SYNC_PROTOCOL.md §10.5).
     */
    val notificationDefault: String = "mentions",
    /**
     * M39: a banner (push) when someone reacts to my message (PUSH_NOTIFICATIONS.md §4); off unless turned on. The
     * activity tab lists the reactions either way. Absent from servers before M39 (off).
     */
    val notifyReactions: Boolean = false,
    /**
     * M48 (docs/SSO.md §4): false for an account that signs in with Google only; settings then offer no password change
     * and no two-factor setup. Absent from servers before M48 (true).
     */
    val hasPassword: Boolean = true,
    /**
     * M50: `quick_reactions` as it came, so a server before M50 (no key: [QUICK_REACTIONS_ABSENT], the setting is hidden)
     * differs from one where I have not chosen any (null). Read it through [quickReactions] / [knowsQuickReactions].
     */
    @SerialName("quick_reactions") val quickReactionsJson: JsonElement = QUICK_REACTIONS_ABSENT,
) {
    /** M50: the long-press sheet's reactions I chose (1–6 plain emoji, in order); null = not chosen (or an older server). */
    val quickReactions: List<String>?
        get() = (quickReactionsJson as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content }

    /** M50: the server has the setting (it sends the key, null or a list); 自分 → 表示 offers it only then. */
    val knowsQuickReactions: Boolean get() = quickReactionsJson != QUICK_REACTIONS_ABSENT

    val asPublic: UserPublic get() = UserPublic(id, username, displayName, role, deactivatedAt, createdAt, updatedAt, title, statusText, statusEmoji, statusExpiresAt, dndUntil, quietHours, avatarUpdatedAt)
}

/** [UserMe.quickReactionsJson] when the key was missing (a server before M50); a server never sends an object there. */
val QUICK_REACTIONS_ABSENT: JsonElement = JsonObject(emptyMap())

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

/** What an invite link offers before any account exists (M12h). */
@Serializable
data class InvitePreviewOut(
    val invitedBy: String,
    val role: String,
    val channels: List<String> = emptyList(),
    val expiresAt: String,
    val passwordMinLength: Int = 8,
    /** M32 (L7): the roster line the invite gives on acceptance; null for an invite without a lab preset or an older server. */
    val lab: InviteLabPreview? = null,
)

/**
 * The lab preset as the acceptance screen shows it (M32, DATA_MODEL.md invites). Strings, as in [LabProfileOut], so a
 * value a newer server adds does not fail the preview.
 */
@Serializable
data class InviteLabPreview(
    val affiliation: String,
    val rank: String? = null,
    val grade: String? = null,
    val supervisorName: String? = null,
    val times: Boolean = false,
)

/** Two-factor authentication (M12i). */
@Serializable
data class TotpStatusOut(val enabled: Boolean, val enabledAt: String? = null, val recoveryCodesLeft: Int = 0)

@Serializable
data class TotpSetupOut(val secret: String, val otpauthUri: String, val qrPngBase64: String)

@Serializable
data class TotpEnabledOut(val recoveryCodes: List<String>)

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

/** M40: a signed-in session of mine (GET /auth/sessions): its device, whether it is this one, when it was last used. */
@Serializable
data class SessionOut(
    val id: String,
    val device: DeviceOut,
    val current: Boolean,
    val lastIp: String? = null,
    val createdAt: String,
    val lastUsedAt: String,
    val expiresAt: String,
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

/**
 * `level` is RESOLVED (M35): the channel's own level, else what my overall setting makes of it; `followsDefault` says
 * it has none of its own. `muted`: muted until unmuted (M35), apart from the timed `mutedUntil`.
 */
@Serializable
data class NotificationPreferenceOut(
    val channelId: String,
    val level: String,
    val mutedUntil: String? = null,
    /** Absent from servers before M35: their `level` is then the channel's own (a "none" stays muted, as before). */
    val followsDefault: Boolean? = null,
    val muted: Boolean = false,
) {
    /** The channel's own level, null when it follows the overall setting (the unread rules take this one, §10.5). */
    val ownLevel: String? get() = if (followsDefault == true) null else level
}

/**
 * `firstUnreadAt`: created_at of the oldest message counted in unreadCount, null when nothing is unread or the
 * server predates M17; only the unread banner's 「… 以降」 uses it (SYNC_PROTOCOL.md §10.1).
 */
@Serializable
data class ReadStateOut(val lastReadSeq: Int, val unreadCount: Int, val mentionCount: Int, val firstUnreadAt: String? = null)

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
    /** M15a: "owners" = an announcement channel (only owners and admins start top-level posts). */
    val postingPolicy: String? = null,
    /**
     * M24: whose times (work log) this channel is; null for other channels. Channels persisted before M24 lack it
     * and read as null until the next bootstrap or channel event brings the value.
     */
    val timesOwnerId: String? = null,
    /**
     * M49 (SYNC_PROTOCOL.md §7.8): the conversation's newest timeline message as one line, the DM list's preview. Only
     * answers to a member carry it (bootstrap, GET /channels, GET /channels/{id}, POST /dms); null elsewhere means
     * "not said" (Store.upsertChannel keeps the held one), in bootstrap "no message yet". A server before M49 never
     * sends it.
     */
    val lastMessage: LastMessageOut? = null,
) {
    val isDm: Boolean get() = type == "dm" || type == "group_dm"
    val isAnnouncement: Boolean get() = postingPolicy == "owners"
    val isTimes: Boolean get() = timesOwnerId != null
}

/**
 * M49 (MOBILE_UI.md §7.1): a conversation's newest message (top-level, or a reply also sent to the channel; never a
 * deleted one) as one line. `excerpt` is the push body's rule (ui/DmPreview.kt [jp.chikuwachat.android.ui.previewExcerpt]);
 * the client puts the prefix in front ([jp.chikuwachat.android.ui.previewLine]). Defaults keep an incomplete row readable.
 */
@Serializable
data class LastMessageOut(
    val id: String,
    val senderId: String,
    val type: String = "user",
    val seq: Int = 0,
    val excerpt: String = "",
    val hasAttachments: Boolean = false,
    val createdAt: String = "",
)

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

/**
 * A poll on a message (M14b). M27 (DATA_MODEL.md 「投票」): `anonymous` polls list no voters (`votes` holds an empty list
 * per option), `counts` says how many voted for each option, and `mine` is the options the reader voted for. `mine` is
 * only in responses to the reader: events carry null, and the store keeps what it knew (SYNC_PROTOCOL.md §8). All three
 * default so a server before M27 (and rows persisted before) still decode; the counts then come from `votes`.
 */
@Serializable
data class PollOut(
    val question: String,
    val options: List<String>,
    val multiple: Boolean = false,
    val closedAt: String? = null,
    val votes: List<List<String>> = emptyList(),
    val anonymous: Boolean = false,
    val counts: List<Int> = emptyList(),
    val mine: List<Int>? = null,
    /**
     * M53 (SCHEDULING.md): `"schedule"` for a scheduling poll (日程調整), else `"choice"`. The rest are a scheduling poll's:
     * its candidates (`slots`, one per option; `options` holds their labels written in `tz`), the decision, ○ △ × per
     * candidate (`answers`), who answered or commented (`respondents`, the table's rows, first answer first), the
     * comments, and my own `myAnswers` / `myComment`, which like `mine` come only in responses to me (events: null; the
     * store keeps what it knew, SYNC_PROTOCOL.md §8). All default, so an older server and rows stored before decode.
     */
    val kind: String = "choice",
    val slots: List<ScheduleSlotOut> = emptyList(),
    val tz: String? = null,
    val decided: PollDecidedOut? = null,
    val answers: List<SlotAnswersOut> = emptyList(),
    val respondents: List<String> = emptyList(),
    val comments: List<PollCommentOut> = emptyList(),
    val myAnswers: List<String?>? = null,
    val myComment: String? = null,
) {
    val isSchedule: Boolean get() = kind == "schedule"

    /** How many voted for the option: the server's count, else (a server before M27) its voters. */
    fun count(option: Int): Int = counts.getOrNull(option) ?: votes.getOrNull(option)?.size ?: 0

    /** Votes over all options (a person counts once per option picked). */
    val total: Int get() = options.indices.sumOf { count(it) }

    /** Who voted for the option, in order of voting; nobody for an anonymous poll. */
    fun voters(option: Int): List<String> = if (anonymous) emptyList() else votes.getOrNull(option) ?: emptyList()

    /**
     * The options `userId` (the reader) voted for. A named poll reads its votes, which every event carries whole: the
     * `mine` kept across an event would still show a vote taken back on another device. An anonymous poll has only
     * `mine` (none known yet = none).
     */
    fun mineFor(userId: String?): Set<Int> {
        if (anonymous || userId == null) return mine?.toSet() ?: emptySet()
        return votes.indices.filter { userId in votes[it] }.toSet()
    }
}

/** M53: a candidate sent when creating a scheduling poll: `startsAt` and `endsAt` (UTC), or `date` for a whole day. */
@Serializable
data class ScheduleSlotIn(val startsAt: String? = null, val endsAt: String? = null, val date: String? = null)

/** M53: one of my answers (PUT …/poll/answers): `answer` is "yes" (○), "maybe" (△) or "no" (×). */
data class PollAnswerIn(val index: Int, val answer: String)

/** M53: what an answer does to my comment: left as it is, or set (null or blank removes it). */
sealed class CommentChange {
    data object Keep : CommentChange()
    data class Set(val text: String?) : CommentChange()
}

/** M53: one candidate of a scheduling poll: a time (UTC instants) or a whole day (`date`, "YYYY-MM-DD"). */
@Serializable
data class ScheduleSlotOut(val startsAt: String? = null, val endsAt: String? = null, val date: String? = null)

/** M53: the decided candidate, the calendar event it made (none in a DM or when made without), who decided and when. */
@Serializable
data class PollDecidedOut(val index: Int, val eventId: String? = null, val by: String = "", val at: String = "")

/** M53: who answered ○ (yes) / △ (maybe) / × (no) for one candidate, first first (nobody in an anonymous poll), and how many. */
@Serializable
data class SlotAnswersOut(
    val yes: List<String> = emptyList(),
    val maybe: List<String> = emptyList(),
    val no: List<String> = emptyList(),
    val yesCount: Int = 0,
    val maybeCount: Int = 0,
    val noCount: Int = 0,
)

/** M53: a comment on a scheduling poll; `userId` null in an anonymous poll. */
@Serializable
data class PollCommentOut(val userId: String? = null, val text: String)

/** A body an edit replaced (M14c); the current body is the message's own. */
@Serializable
data class MessageRevisionOut(val body: String, val writtenAt: String, val replacedAt: String)

@Serializable
data class MessageOut(
    val id: String,
    val channelId: String,
    val senderId: String,
    val seq: Int,
    val updatedSeq: Int,
    val clientMsgId: String? = null,
    val parentId: String? = null,
    /** M15c: a reply shown in the channel timeline as well as in its thread. */
    val alsoInChannel: Boolean = false,
    val type: String = "user",
    val body: String,
    val mentionedUserIds: List<String> = emptyList(),
    val mentionAll: Boolean = false,
    val reactions: List<ReactionOut> = emptyList(),
    val attachments: List<AttachmentOut> = emptyList(),
    val replyCount: Int = 0,
    val lastReplyAt: String? = null,
    /** C3 (THREADS.md §3.1): who replied, most recent first, at most 5; empty without replies or from an older server. */
    val replyUserIds: List<String> = emptyList(),
    val createdAt: String,
    val editedAt: String? = null,
    val deleted: Boolean,
    /** Pinned in the channel (M11c); both null when not pinned. */
    val pinnedAt: String? = null,
    val pinnedBy: String? = null,
    /** M14b: the poll, when the message carries one. */
    val poll: PollOut? = null,
    /** M15e: "important" / "urgent", and who acknowledged a message that asked for it (oldest first). */
    val priority: String? = null,
    val ackRequested: Boolean = false,
    val acks: List<AckOut> = emptyList(),
) {
    /** Mentions me by name, group or @channel, or by one of my notification keywords (M12g). */
    fun mentions(userId: String, keywords: List<String> = emptyList()): Boolean =
        mentionAll || userId in mentionedUserIds || hitsKeyword(body, keywords)
    val isReply: Boolean get() = parentId != null
}

/**
 * M12g: one of my notification keywords is in the body, with the server's rule (case-insensitive, anywhere).
 * The server keeps keyword hits private (they would show my keywords to the others, SYNC_PROTOCOL.md §7.4),
 * so each client finds its own.
 */
fun hitsKeyword(body: String, keywords: List<String>): Boolean {
    if (keywords.isEmpty() || body.isEmpty()) return false
    val text = body.lowercase()
    return keywords.any { it.isNotEmpty() && text.contains(it.lowercase()) }
}

/** The parent's thread fields after a reply changed them (SYNC_PROTOCOL.md §6). */
@Serializable
data class ParentThread(
    val id: String,
    val replyCount: Int,
    val lastReplyAt: String? = null,
    val updatedSeq: Int,
    val participantIds: List<String> = emptyList(),
    /** C3: the parent's repliers after this change; null from an older server (the parent keeps its list). */
    val replyUserIds: List<String>? = null,
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
    /** Custom emoji (M12f): the whole table; changes arrive as emoji.updated. */
    val customEmoji: List<CustomEmojiOut> = emptyList(),
    /** User groups (M12k): every group with its members; changes arrive as group.updated. */
    val groups: List<GroupOut> = emptyList(),
    /** The lab roster (M23), in roster order; changes arrive as roster.updated. Absent from servers before M23. */
    val roster: List<LabProfileOut> = emptyList(),
    /** My sidebar sections (M14f); changes arrive as sidebar.updated. */
    val sidebarSections: List<SidebarSectionOut> = emptyList(),
    /** My drafts shared by my devices (M15d); changes arrive as draft.updated. */
    val drafts: List<DraftOut> = emptyList(),
    /** Post templates (M30): the workspace's, then mine; changes arrive as template.updated. Absent before M30. */
    val templates: List<TemplateOut> = emptyList(),
    /**
     * M39: the activity tab's badge (GET /activity/summary; SYNC_PROTOCOL.md §4.1). Null from a server before M39: the
     * tab then keeps its stage-A lists and badge rule (MainTabs.activityBadge).
     */
    val activity: ActivitySummaryOut? = null,
)

/**
 * A post template (M30, DATA_MODEL.md message_templates): `scope` "workspace" (admins edit it) or "user" (mine, then
 * `ownerId` is me); `suggestIn` "times" puts it first in a times channel. Mobile only inserts them (ui/Templates.kt).
 */
@Serializable
data class TemplateOut(
    val id: String, val scope: String, val ownerId: String? = null, val name: String, val body: String,
    val suggestIn: String = "any", val position: Int = 0, val createdAt: String, val updatedAt: String,
)

/** A draft saved on the server (M15d): text only, one per composer. */
@Serializable
data class DraftOut(val channelId: String, val parentId: String? = null, val body: String, val updatedAt: String)

/** draft.updated (M15d): saved or deleted (then `body` is empty) on one of my devices. */
@Serializable
data class DraftUpdated(val channelId: String, val parentId: String? = null, val body: String = "", val updatedAt: String, val deleted: Boolean = false)

/**
 * One of my sidebar sections (M14f); `channelIds` are the conversations placed in it. M26: `emoji` is its icon (an
 * emoji or a custom `:name:`), `collapsed` folds it up on all my devices.
 */
@Serializable
data class SidebarSectionOut(
    val id: String, val name: String, val position: Int, val channelIds: List<String> = emptyList(),
    val emoji: String? = null, val collapsed: Boolean = false,
)

/**
 * A named set of members that `@name` notifies (M12k). `managed` (M23): the server keeps its members from the lab
 * roster (faculty, students, m1 …) and refuses hand edits with 409 group_managed; groups are only edited on desktop.
 */
@Serializable
data class GroupOut(
    val id: String, val name: String, val description: String? = null, val memberIds: List<String> = emptyList(), val createdBy: String,
    val createdAt: String, val updatedAt: String, val managed: Boolean = false,
)

/**
 * One line of the lab roster (M23, DATA_MODEL.md lab_profiles): display and grouping only, never permissions.
 * `affiliation` (faculty / student / alumni / other), `rank` and `grade` stay strings so a value a newer server adds
 * sorts after the known ones (ui/Roster.kt) instead of failing the whole bootstrap.
 */
@Serializable
data class LabProfileOut(
    val userId: String,
    val affiliation: String,
    val rank: String? = null,
    val grade: String? = null,
    val supervisorId: String? = null,
    val researchTopic: String? = null,
    val reading: String? = null,
    val updatedAt: String,
)

/** A workspace emoji (M12f) used as `:name:` in text and reactions. */
@Serializable
data class CustomEmojiOut(val id: String, val name: String, val contentType: String, val width: Int, val height: Int, val createdBy: String, val createdAt: String)

/** PUT / DELETE /channels/{id}/favorite (M12a). */
@Serializable
data class FavoriteStateOut(val channelId: String, val favorite: Boolean)

/** One row of POST /channels/read-all (M12a). */
@Serializable
data class ChannelReadStateOut(val channelId: String, val lastReadSeq: Int, val unreadCount: Int, val mentionCount: Int, val firstUnreadAt: String? = null)

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
    /** L4 (M31): "personal" (set by me) or "ack" (the author asked me to acknowledge the message). */
    val kind: String = "personal",
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

/**
 * M39 (MOBILE_UI.md §7.2): one row of the activity tab. `kind` "mention" (a message mentioning me), "reaction" (my
 * message, with everyone who reacted and the distinct emoji, the newest reaction's time as `at`) or "thread_reply" (a
 * reply by someone else in a thread I follow). `actorIds`: who did it (never me).
 */
@Serializable
data class ActivityItem(
    val kind: String,
    val at: String,
    val message: MessageOut,
    val actorIds: List<String>,
    val emojis: List<String> = emptyList(),
) {
    /** One row per kind and message (a reaction row is per message, whoever reacts next). */
    val key: String get() = "$kind:${message.id}"
}

/** GET /activity: newest first; `nextCursor` (the oldest row's time) goes back as `cursor`, null at the end. */
@Serializable
data class ActivityListOut(val items: List<ActivityItem>, val nextCursor: String? = null, val readAt: String)

/** GET /activity/summary, PUT /activity/read and bootstrap `activity`: the items after `readAt` (at most 99). */
@Serializable
data class ActivitySummaryOut(val readAt: String, val unreadCount: Int, val mentionUnread: Boolean)

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

/** L4 (M31): GET /messages/{id}/ack/pending, the members yet to acknowledge (by display name). */
@Serializable
data class AckPendingOut(val userIds: List<String> = emptyList())

/** L4 (M31): POST /messages/{id}/ack/remind, how many were reminded (0: everyone pending already has one open). */
@Serializable
data class AckRemindOut(val reminded: Int = 0)

@Serializable
data class ErrorEnvelope(val error: ErrorInner)

/** `details` (M46): extra facts of some errors, e.g. the current canvas of a 409 canvas_conflict (CANVAS.md §4.4). */
@Serializable
data class ErrorInner(val code: String, val message: String, val details: kotlinx.serialization.json.JsonElement? = null)

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
    /** M16b: how many messages match; the server stops counting past 1,000 and then sets `totalCapped`. */
    val total: Int = 0,
    val totalCapped: Boolean = false,
)

/**
 * GET /search/messages parameters (M16b): the words (typed modifiers such as from:@ stay in them) and the
 * filters picked from menus. `after` is inclusive, `before` exclusive (ISO-8601 with an offset); `has` repeats.
 */
data class SearchRequest(
    val q: String,
    val channelId: String? = null,
    val fromUserId: String? = null,
    val after: String? = null,
    val before: String? = null,
    val has: List<String> = emptyList(),
    val isThread: Boolean = false,
    /** "relevance" or "newest"; a search without words is newest first whatever this says. */
    val sort: String = "relevance",
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
    /** M15h: the has: flags (file, link, pin, reaction, poll) and is:thread the server understood. */
    val has: List<String> = emptyList(),
    val isThread: Boolean = false,
)

/** GET /server (M16c, no sign-in): which ChikuwaChat deployment a URL is (WORKSPACES.md §3.1). */
@Serializable
data class ServerInfoOut(val product: String, val workspaceId: String, val name: String, val apiVersion: String = "")

/** GET /auth/methods (M48, docs/SSO.md §3): which sign-in buttons the login screen shows. */
@Serializable
data class AuthMethodsOut(val password: Boolean = true, val google: ProviderMethod = ProviderMethod())

@Serializable
data class ProviderMethod(val enabled: Boolean = false)

/** GET /sync/summary (M16c): the unread marks of a workspace that is not open (WORKSPACES.md §3.2). */
@Serializable
data class UnreadSummaryOut(val badge: Int = 0, val hasUnread: Boolean = false)

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

/** M15e: one member's 「確認しました」. */
@Serializable
data class AckOut(val userId: String, val ackedAt: String)

/** A link pinned to the top of a conversation (M15f). */
@Serializable
data class ChannelLinkOut(val id: String, val title: String, val url: String, val position: Int, val createdBy: String, val createdAt: String)
