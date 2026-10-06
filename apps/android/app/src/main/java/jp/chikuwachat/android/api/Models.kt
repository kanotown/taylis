package jp.chikuwachat.android.api

import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.SerializationException
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonDecoder
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
    /** M98: what a bot is for; "feed" = a channel's feed bot (its link previews load by themselves, LinkPreviewPolicy). */
    val botKind: String? = null,
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
    /**
     * M56 (TASKS.md §5): pushes for task assignments and due dates (default on). Null from a server before M55 (no key):
     * 自分 → 通知 then hides the switch.
     */
    val notifyTasks: Boolean? = null,
    /**
     * M111: `nav_items` as it came (my home tiles / the desktop's sidebar items, apps/shared/nav-items.json): no key
     * ([NAV_ITEMS_ABSENT], a server before M111: the setting is hidden, the tiles are the defaults) differs from null
     * (not customised). Read it through [navItems] / [knowsNavItems].
     */
    @SerialName("nav_items") val navItemsJson: JsonElement = NAV_ITEMS_ABSENT,
    /**
     * docs/I18N.md: `locale` as it came: my UI language ("ja" / "en" / "zh-Hans"; null = follow the device). No key
     * ([LOCALE_ABSENT]) is a server that does not keep it: the language then stays on this device. Read it through
     * [locale] / [knowsLocale].
     */
    @SerialName("locale") val localeJson: JsonElement = LOCALE_ABSENT,
) {
    /** My UI language as saved on the server; null = the device's (or an older server). */
    val locale: String? get() = (localeJson as? JsonPrimitive)?.takeIf { it.isString }?.content

    /** The server keeps the UI language (it sends the key, null or a value). */
    val knowsLocale: Boolean get() = localeJson != LOCALE_ABSENT

    /** M111: my list as saved (in order, unknown keys kept); null = the defaults (or an older server). */
    val navItems: List<NavItem>?
        get() = (navItemsJson as? JsonArray)?.mapNotNull { element ->
            val item = element as? JsonObject ?: return@mapNotNull null
            val key = (item["key"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return@mapNotNull null
            val visible = (item["visible"] as? JsonPrimitive)?.content?.toBooleanStrictOrNull() ?: return@mapNotNull null
            NavItem(key, visible)
        }

    /** M111: the server has the setting; 自分 → 表示 offers 「ホームのタイル」 only then. */
    val knowsNavItems: Boolean get() = navItemsJson != NAV_ITEMS_ABSENT

    /** M50: the long-press sheet's reactions I chose (1–6 plain emoji, in order); null = not chosen (or an older server). */
    val quickReactions: List<String>?
        get() = (quickReactionsJson as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content }

    /** M50: the server has the setting (it sends the key, null or a list); 自分 → 表示 offers it only then. */
    val knowsQuickReactions: Boolean get() = quickReactionsJson != QUICK_REACTIONS_ABSENT

    val asPublic: UserPublic get() = UserPublic(id, username, displayName, role, deactivatedAt, createdAt, updatedAt, title, statusText, statusEmoji, statusExpiresAt, dndUntil, quietHours, avatarUpdatedAt)
}

/** M111: one sidebar item / home tile and whether it shows (UserMe.nav_items). */
@Serializable
data class NavItem(val key: String, val visible: Boolean)

/** [UserMe.localeJson] when the key was missing (a server without the UI language setting). */
val LOCALE_ABSENT: JsonElement = JsonObject(mapOf("absent" to JsonPrimitive(true)))

/** [UserMe.navItemsJson] when the key was missing (a server before M111). */
val NAV_ITEMS_ABSENT: JsonElement = JsonObject(mapOf("absent" to JsonPrimitive(true)))

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

/** POST /users/me/test-notification (PUSH_NOTIFICATIONS.md §15): what happened on one device of mine. */
@Serializable
data class TestNotificationDevice(
    val deviceId: String,
    val deviceName: String? = null,
    val platform: String,
    val pushProvider: String,
    val current: Boolean,
    /** sent / failed / no_token / not_configured / in_app / disabled. */
    val status: String,
    val detail: String? = null,
)

@Serializable
data class TestNotificationOut(
    val apnsConfigured: Boolean,
    val fcmConfigured: Boolean,
    val dndActive: Boolean,
    val sentCount: Int,
    val devices: List<TestNotificationDevice>,
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

/**
 * M108 (docs/PREVIEWS.md §5): `pending` (the card says 「プレビューを作成中…」), `ready` (the first page at `/preview/thumbnail`,
 * [width] × [height] pixels, every page at `/preview/pdf`) or `failed` (a plain file row).
 */
@Serializable
data class AttachmentPreviewOut(val status: String, val pages: Int? = null, val width: Int? = null, val height: Int? = null) {
    val isPending: Boolean get() = status == "pending"
    val isReady: Boolean get() = status == "ready"
}

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
    /**
     * M79 / M82: a video's poster frame, served by `GET /attachments/{id}/thumbnail` like an image's thumbnail (a video's
     * `has_thumbnail` stays false), and its length. Both absent from a server before M79 (and rows stored before): false / null.
     */
    val hasPoster: Boolean = false,
    val durationMs: Long? = null,
    /** M108 (docs/PREVIEWS.md): a PDF's or Office file's preview; null without one (or from an older server, or rows stored before). */
    val preview: AttachmentPreviewOut? = null,
) {
    /** By the type the server sniffed (M82): a video is never a photo, whatever thumbnail flags it carries. */
    val isVideo: Boolean get() = contentType.startsWith("video/", ignoreCase = true)
    val isImage: Boolean get() = hasThumbnail && contentType.startsWith("image/", ignoreCase = true)
    /** Whether `/thumbnail` has a picture for this attachment: an image's thumbnail or a video's poster. */
    val hasPreviewPicture: Boolean get() = isImage || (isVideo && hasPoster)
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
    /**
     * L6 (M60, RECURRING.md §3): a recurring post that collects replies; null for any other message and from a server
     * before M59. A change arrives as the parent's message.updated (change "collection") with a new updated_seq.
     */
    val collection: CollectionOut? = null,
    /**
     * L9 (M63, REVIEWS.md §2.2): the shared tasks made from this message (the chips under it); empty without any and from a
     * server before M63. A change arrives as message.updated (change "tasks") with a new updated_seq.
     */
    val tasks: List<MessageTaskOut> = emptyList(),
    /**
     * M88 (MEMBERSHIP.md §1): what a `type = "system"` row says (the join / leave lines); null for people's posts and from
     * a server before M88. The line is written from it with the directory's names (ui/SystemMessages.kt).
     */
    val systemEvent: SystemEventOut? = null,
    /**
     * M95 (WORKFLOWS.md §8 1.): the workflow whose form posted it (「⚡ name」 above the message); null for any other
     * message, a deleted one, and from a server before M94.
     */
    val workflow: MessageWorkflowOut? = null,
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
    /** M100: emoji packs in tab order; changes arrive as emoji_pack.updated. */
    val emojiPacks: List<EmojiPackOut> = emptyList(),
    /** User groups (M12k): every group with its members; changes arrive as group.updated. */
    val groups: List<GroupOut> = emptyList(),
    /** The lab roster (M23), in roster order; changes arrive as roster.updated. Absent from servers before M23. */
    val roster: List<LabProfileOut> = emptyList(),
    /** My sidebar sections (M14f); changes arrive as sidebar.updated. */
    val sidebarSections: List<SidebarSectionOut> = emptyList(),
    /** The default sections' sorts (DATA_MODEL.md 「並べ替え」); empty from an older server (the defaults). */
    val sidebarDefaults: List<SidebarDefaultOut> = emptyList(),
    /** My drafts shared by my devices (M15d); changes arrive as draft.updated. */
    val drafts: List<DraftOut> = emptyList(),
    /** Post templates (M30): the workspace's, then mine; changes arrive as template.updated. Absent before M30. */
    val templates: List<TemplateOut> = emptyList(),
    /**
     * M39: the activity tab's badge (GET /activity/summary; SYNC_PROTOCOL.md §4.1). Null from a server before M39: the
     * tab then keeps its stage-A lists and badge rule (MainTabs.activityBadge).
     */
    val activity: ActivitySummaryOut? = null,
    /** M88 (MEMBERSHIP.md §3): the two workspace switches; both on from a server before M88. */
    val workspaceSettings: WorkspaceSettingsOut = WorkspaceSettingsOut(),
    /** M104 (MODERATION.md §4): the people I blocked; changes arrive as block.updated. Empty from an older server. */
    val blockedUserIds: List<String> = emptyList(),
)

/**
 * M88 (MEMBERSHIP.md §1): a system row's event. `kind`: member_joined, member_left, members_added, member_removed (an
 * unknown one falls back to the row's body). For joined / left `userIds` is `[actorId]`.
 */
@Serializable
data class SystemEventOut(val kind: String, val actorId: String, val userIds: List<String> = emptyList())

/**
 * M88 (MEMBERSHIP.md §3): bootstrap's `workspace_settings` and workspace.settings_updated's `settings`. Not persisted: an
 * offline start uses these defaults until the next bootstrap.
 */
@Serializable
data class WorkspaceSettingsOut(
    val showMembershipMessages: Boolean = true,
    val previewBeforeJoin: Boolean = true,
    /** M93 (WORKSPACES.md §3.4): `icon_version` as it came; read it through [iconVersion] / [knowsIcon]. */
    @SerialName("icon_version") val iconVersionJson: JsonElement = ICON_VERSION_ABSENT,
) {
    /** M93: the workspace icon's version; null = none (the letter tile). */
    val iconVersion: String? get() = iconVersionOf(iconVersionJson)
    /** M93: the server sent `icon_version` (null or a version); a server before M93 does not, and the saved one stays. */
    val knowsIcon: Boolean get() = iconVersionJson != ICON_VERSION_ABSENT
}

/** [WorkspaceSettingsOut.iconVersionJson] / [ServerInfoOut.iconVersionJson] when the key was missing (a server before M93). */
val ICON_VERSION_ABSENT: JsonElement = JsonObject(emptyMap())

/** M93: `icon_version`'s string; null for null (no icon) or anything else. */
fun iconVersionOf(json: JsonElement): String? = (json as? JsonPrimitive)?.takeIf { it.isString }?.content?.ifEmpty { null }

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
    /** DATA_MODEL.md 「並べ替え」: "name" / "recent" / "manual", and the hand-made order (conversation ids). */
    val sort: String = "name", val manualOrder: List<String> = emptyList(),
)

/** The sort of a default section ("favorites", "channels", "dms"); the server always sends all three. */
@Serializable
data class SidebarDefaultOut(val key: String, val sort: String, val manualOrder: List<String> = emptyList())

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
data class CustomEmojiOut(
    val id: String, val name: String, val contentType: String, val width: Int, val height: Int, val createdBy: String, val createdAt: String,
    /** M100 (docs/EMOJI.md): "image" (older servers: absent) or "text" (`label` drawn as a pill in `color`, no image). */
    val kind: String = "image",
    /** The display name (the picker's name, 「おじぎ」); the text of a text emoji. */
    val label: String? = null,
    val color: String? = null,
    /** Search terms for the picker and `:` completion (Japanese included). */
    val keywords: List<String> = emptyList(),
    /** The pack (its own picker tab); null = 「カスタム」. */
    val packId: String? = null,
    val position: Int = 0,
) {
    val isText: Boolean get() = kind == "text"
}

/** M100: a set of custom emoji with its own picker tab; its tab icon at GET /emoji/packs/{id}/tab when `tabVersion` is set. */
@Serializable
data class EmojiPackOut(val id: String, val name: String, val position: Int = 0, val tabVersion: String? = null, val createdAt: String = "", val updatedAt: String = "")

/** PUT / DELETE /users/{id}/block (M104, MODERATION.md §4). */
@Serializable
data class BlockStateOut(val userId: String, val blocked: Boolean)

/** POST /messages/{id}/report (M104, MODERATION.md §3): my own report only. */
@Serializable
data class ReportAck(val id: String, val messageId: String, val reason: String, val createdAt: String = "")

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
    /**
     * L4 (M31): "personal" (set by me) or "ack" (the author asked me to acknowledge the message); L6 (M59): "collect" (a
     * recurring post's due time passed and I have not replied in its thread). Any other value reads as personal.
     */
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
 *
 * M77 (CANVAS.md §20.5): "canvas_mention" (a canvas save mentioned me) has no `message` but a [canvas]; the server sends
 * it only when asked with `include=canvas_mention` ([ActivityInclude]). Items are read one at a time
 * ([ActivityItemsSerializer]): an unknown kind or a malformed item is skipped, never the whole page.
 */
@Serializable
data class ActivityItem(
    val kind: String,
    val at: String,
    val message: MessageOut? = null,
    val actorIds: List<String>,
    val emojis: List<String> = emptyList(),
    val canvas: ActivityCanvas? = null,
    /** M112: a reservation item's notice (asked for with `include=reservation`). */
    val reservation: ActivityReservation? = null,
) {
    /** One row per kind and message (a reaction row is per message, whoever reacts next); a canvas one per item. */
    val key: String get() = canvas?.let { "canvas_mention:${it.itemId}" } ?: reservation?.let { "reservation:${it.itemId}" } ?: "$kind:${message?.id}"

    /** Whether this device can show the item: a kind it knows, with the part that kind needs. */
    val isShown: Boolean get() = when (kind) {
        "mention", "reaction", "thread_reply" -> message != null
        "canvas_mention" -> canvas != null
        "reservation" -> reservation != null
        else -> false
    }

    companion object {
        /** One item from the wire, or null when it is malformed or not one this device shows. */
        fun decodeOrNull(json: Json, element: JsonElement): ActivityItem? =
            runCatching { json.decodeFromJsonElement(serializer(), element) }.getOrNull()?.takeIf { it.isShown }
    }
}

/** M77 (CANVAS.md §20.3): a canvas_mention item's canvas. `title` is the current one; `excerpt` the line as saved. */
@Serializable
data class ActivityCanvas(
    val itemId: String,
    val canvasId: String,
    val channelId: String,
    val title: String,
    val excerpt: String,
    val revId: String,
)

/** M77 (CANVAS.md §20.3): the kinds beyond M39's this device reads, sent on every activity call (`include=`). */
object ActivityInclude {
    /** M112: reservation notices too. */
    val VALUES = listOf("canvas_mention", "reservation")

    /** `name=canvas_mention&name=reservation`. */
    fun query(name: String): String = VALUES.joinToString("&") { "$name=$it" }
}

/** The activity items one at a time: a bad or unknown one is dropped, the others stay (CANVAS.md §20.5). */
object ActivityItemsSerializer : KSerializer<List<ActivityItem>> {
    private val list = ListSerializer(ActivityItem.serializer())
    override val descriptor: SerialDescriptor = list.descriptor

    override fun deserialize(decoder: Decoder): List<ActivityItem> {
        val input = decoder as? JsonDecoder ?: throw SerializationException("activity items are JSON only")
        val array = input.decodeJsonElement() as? JsonArray ?: throw SerializationException("activity items: not an array")
        return array.mapNotNull { ActivityItem.decodeOrNull(input.json, it) }
    }

    override fun serialize(encoder: Encoder, value: List<ActivityItem>) = encoder.encodeSerializableValue(list, value)
}

/** GET /activity: newest first; `nextCursor` (the oldest row's time) goes back as `cursor`, null at the end. */
@Serializable
data class ActivityListOut(
    @Serializable(with = ActivityItemsSerializer::class) val items: List<ActivityItem>,
    val nextCursor: String? = null,
    val readAt: String,
)

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
    /** L8 (TIMES_FEED.md §6): the hits' channels I am not a member of (an `is:times` search); older servers lack it. */
    val channels: List<ChannelOut> = emptyList(),
)

/** GET /times/feed (L8, TIMES_FEED.md §3); `nextCursor` null at the end. */
@Serializable
data class TimesFeedOut(val items: List<MessageOut> = emptyList(), val nextCursor: String? = null)

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
    /** L8: only times channels (the 「Times」 chip; a typed `is:times` stays in `q`). */
    val isTimes: Boolean = false,
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
    /** L8: `is:times` (or the is_times parameter) understood; older servers lack it. */
    val isTimes: Boolean = false,
)

/** GET /server (M16c, no sign-in): which ChikuwaChat deployment a URL is (WORKSPACES.md §3.1). */
@Serializable
data class ServerInfoOut(
    val product: String,
    val workspaceId: String,
    val name: String,
    val apiVersion: String = "",
    /** M93 (WORKSPACES.md §3.4): `icon_version` as it came; read it through [iconVersion] / [knowsIcon]. */
    @SerialName("icon_version") val iconVersionJson: JsonElement = ICON_VERSION_ABSENT,
) {
    /** M93: the workspace icon's version (GET /server/icon?v=…); null = none. */
    val iconVersion: String? get() = iconVersionOf(iconVersionJson)
    /** M93: the server sent `icon_version`; a server before M93 does not, and the saved one stays. */
    val knowsIcon: Boolean get() = iconVersionJson != ICON_VERSION_ABSENT
}

/** GET /auth/methods (M48, docs/SSO.md §3): which sign-in buttons the login screen shows. */
@Serializable
data class AuthMethodsOut(val password: Boolean = true, val google: ProviderMethod = ProviderMethod())

/**
 * `domains`: the Workspace domains the server accepts (missing before the field existed, empty when unrestricted);
 * `label`: the administrator's name for the organisation (SSO_GOOGLE_LABEL), shown instead of the domain.
 */
@Serializable
data class ProviderMethod(val enabled: Boolean = false, val domains: List<String> = emptyList(), val label: String? = null)

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

// --- recurring posts and collections (L6, M59/M60, docs/RECURRING.md) --------------------------------------------------

/**
 * Under a recurring post that collects replies (RECURRING.md §3): the due time, the targets fixed when it was posted,
 * and who of them has a live reply in its thread. The same for every reader. Every field defaults, so an incomplete
 * row (or one stored before) still decodes; an unreadable `dueAt` just shows no date.
 */
@Serializable
data class CollectionOut(
    val dueAt: String = "",
    val targetUserIds: List<String> = emptyList(),
    val targetCount: Int = 0,
    val submittedUserIds: List<String> = emptyList(),
    val remindedAt: String? = null,
)

/**
 * WeeklySchedule (`weekdays`, 0 = Monday) or MonthlySchedule (`day` 1–31, a month without it runs on its last day), at
 * `time` ("HH:MM") in the post's zone. One class for both, so a kind a newer server adds still decodes (and reads as
 * unknown); requests are written by hand (ui/Recurring.kt), since the server refuses the other kind's fields.
 */
@Serializable
data class RecurringSchedule(
    val kind: String = "weekly",
    val weekdays: List<Int> = emptyList(),
    val day: Int = 1,
    val time: String = "09:00",
)

/** Whom it collects from: everyone in the channel, or the union of the groups' members and the people. */
@Serializable
data class CollectTargets(
    val allMembers: Boolean = false,
    val groupIds: List<String> = emptyList(),
    val userIds: List<String> = emptyList(),
)

/** Due `afterDays` (0–30) after the posting day at `time`, in the post's zone. */
@Serializable
data class CollectDue(val afterDays: Int = 0, val time: String = "18:00")

@Serializable
data class CollectSpec(val targets: CollectTargets = CollectTargets(), val due: CollectDue = CollectDue())

/** GET /channels/{id}/recurring-posts and the answers of POST / PATCH (RECURRING.md §3). */
@Serializable
data class RecurringPostOut(
    val id: String,
    val channelId: String,
    val botUserId: String = "",
    val createdBy: String = "",
    val name: String,
    val body: String = "",
    val schedule: RecurringSchedule = RecurringSchedule(),
    val tz: String = "",
    val collect: CollectSpec? = null,
    val enabled: Boolean = true,
    val nextRunAt: String = "",
    val lastRunAt: String? = null,
    val createdAt: String = "",
    val updatedAt: String = "",
)

/** POST /recurring-posts/{id}/run: the message just posted. */
@Serializable
data class RecurringRunOut(val messageId: String = "")
