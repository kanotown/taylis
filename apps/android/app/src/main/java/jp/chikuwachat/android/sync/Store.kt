package jp.chikuwachat.android.sync

import androidx.compose.ui.graphics.ImageBitmap
import jp.chikuwachat.android.api.ActivitySummaryOut
import jp.chikuwachat.android.api.CustomEmojiOut
import jp.chikuwachat.android.api.Limits
import jp.chikuwachat.android.api.SystemEventOut
import jp.chikuwachat.android.api.MessageCallOut
import jp.chikuwachat.android.api.MessageWorkflowOut
import jp.chikuwachat.android.api.WorkspaceSettingsOut
import jp.chikuwachat.android.api.PollOut
import jp.chikuwachat.android.platform.AvatarCache
import jp.chikuwachat.android.api.GroupOut
import jp.chikuwachat.android.api.TemplateOut
import jp.chikuwachat.android.api.LabProfileOut
import jp.chikuwachat.android.api.SidebarSectionOut
import jp.chikuwachat.android.api.ReminderOut
import jp.chikuwachat.android.api.ScheduledOut
import jp.chikuwachat.android.api.AckOut
import jp.chikuwachat.android.api.CollectionOut
import jp.chikuwachat.android.api.MessageTaskOut
import jp.chikuwachat.android.api.MembershipOut
import jp.chikuwachat.android.api.AttachmentOut
import jp.chikuwachat.android.api.CanvasMeta
import jp.chikuwachat.android.api.CanvasOut
import jp.chikuwachat.android.api.ChannelLinkOut
import jp.chikuwachat.android.api.PoolOut
import jp.chikuwachat.android.api.ChannelOut
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.HistoryOut
import jp.chikuwachat.android.api.LastMessageOut
import jp.chikuwachat.android.api.MessageOut
import jp.chikuwachat.android.api.NotificationPreferenceOut
import jp.chikuwachat.android.api.ParentThread
import jp.chikuwachat.android.api.PresenceEntry
import jp.chikuwachat.android.api.ReactionOut
import jp.chikuwachat.android.api.ThreadItem
import jp.chikuwachat.android.api.ThreadState
import jp.chikuwachat.android.api.ThreadSummary
import jp.chikuwachat.android.api.UserMe
import jp.chikuwachat.android.api.UserPublic
// M49: the preview's rule is plain text work shared with the rows that show it (DmPreview.kt).
import jp.chikuwachat.android.ui.lastMessageOf
import jp.chikuwachat.android.ui.sameLastMessage
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.Serializable

/** A channel as the client stores it: server fields plus the sync cursor (SYNC_PROTOCOL.md §7.1). */
@Serializable
data class ChannelState(
    val channel: ChannelOut,
    val isMember: Boolean,
    /** null: no timeline loaded yet. */
    val syncedSeq: Int? = null,
    val lastSeq: Int = 0,
    /** Server read position and counts (SYNC_PROTOCOL.md §10); counts are replaced by read.updated. */
    val lastReadSeq: Int = 0,
    val unreadCount: Int = 0,
    val mentionCount: Int = 0,
    /** §10.1: created_at of the oldest unread message (the banner's 「… 以降」); null when none or not known. */
    val firstUnreadAt: String? = null,
    val hasOlder: Boolean = true,
    /**
     * §7.3: the oldest seq of the timeline loaded contiguously (latest page + 「以前を読み込む」); 0 = from the
     * start, null = no timeline yet. Older rows may be stored (a thread parent a reply bumped, a reaction on
     * an old message) but the timeline shows seq >= this only, and scroll-back pages from it.
     */
    val oldestLoadedSeq: Int? = null,
    /** §10: a read position set here that the server has not confirmed yet; sent again after reconnecting. */
    val unsentReadSeq: Int? = null,
) {
    val id: String get() = channel.id
    val hasUnread: Boolean get() = unreadCount > 0

    /** M15a: whether I may start top-level posts here; thread replies stay open to every member. */
    fun canPostTopLevel(isAdmin: Boolean): Boolean = !channel.isAnnouncement || isAdmin || channel.membership?.role == "owner"
}

/** A message as stored locally. Pending messages have seq null and id "local:<client_msg_id>". */
@Serializable
data class MessageState(
    val id: String,
    val channelId: String,
    val senderId: String,
    val seq: Int?,
    val updatedSeq: Int,
    val clientMsgId: String?,
    val body: String,
    val createdAt: String,
    val editedAt: String? = null,
    val deleted: Boolean = false,
    val pending: Boolean = false,
    val failed: Boolean = false,
    val reactions: List<ReactionOut> = emptyList(),
    val mentionedUserIds: List<String> = emptyList(),
    val mentionAll: Boolean = false,
    val parentId: String? = null,
    /** M15c: a reply shown in the channel timeline as well as in its thread. */
    val alsoInChannel: Boolean = false,
    val replyCount: Int = 0,
    val lastReplyAt: String? = null,
    /** C3: who replied, most recent first (MessageOut.reply_user_ids); rows persisted earlier lack it. */
    val replyUserIds: List<String> = emptyList(),
    val attachments: List<AttachmentOut> = emptyList(),
    /** M11c: pinned in the channel; rows persisted earlier lack the fields. */
    val pinnedAt: String? = null,
    val pinnedBy: String? = null,
    /** M14b: the poll, when the message carries one. */
    val poll: PollOut? = null,
    /** M15e: priority label and acknowledgements (only when asked for). */
    val priority: String? = null,
    val ackRequested: Boolean = false,
    val acks: List<AckOut> = emptyList(),
    /** "user", or a system row, which is never unread (§10.1 rule 12); rows persisted earlier lack it. */
    val type: String = "user",
    /** L6 (M60): a recurring post's collection (RECURRING.md §3); rows persisted earlier lack it. */
    val collection: CollectionOut? = null,
    /** L9 (M64): the shared tasks made from it (REVIEWS.md §2.2); rows persisted earlier lack it. */
    val tasks: List<MessageTaskOut> = emptyList(),
    /** M89 (MEMBERSHIP.md §5): a system row's event, kept so a restart writes the line again; rows persisted earlier lack it. */
    val systemEvent: SystemEventOut? = null,
    /** M95: the workflow that posted it (MessageOut.workflow); rows persisted earlier lack it (no Room version: it is JSON). */
    val workflow: MessageWorkflowOut? = null,
    /** M117: the call it started (MessageOut.call, docs/CALLS.md §5); rows persisted earlier lack it. */
    val call: MessageCallOut? = null,
) {
    /** M88: a system row (the join / leave lines): one muted line, never grouped, no actions, never unread. */
    val isSystem: Boolean get() = type != "user"

    fun reactedBy(userId: String, emoji: String): Boolean = reactions.any { it.emoji == emoji && userId in it.userIds }

    /** A row's key in lists: the client_msg_id, which a pending message keeps when the server confirms it. */
    val rowKey: String get() = clientMsgId ?: id
    val isReply: Boolean get() = parentId != null
    /** The channel timeline shows top-level messages and replies also sent to the channel (M15c). */
    val inTimeline: Boolean get() = parentId == null || alsoInChannel

    companion object {
        fun from(message: MessageOut) = MessageState(
            id = message.id, channelId = message.channelId, senderId = message.senderId, seq = message.seq,
            updatedSeq = message.updatedSeq, clientMsgId = message.clientMsgId, body = message.body,
            createdAt = message.createdAt, editedAt = message.editedAt, deleted = message.deleted,
            reactions = message.reactions, mentionedUserIds = message.mentionedUserIds, mentionAll = message.mentionAll,
            parentId = message.parentId, alsoInChannel = message.alsoInChannel, replyCount = message.replyCount, lastReplyAt = message.lastReplyAt, replyUserIds = message.replyUserIds, attachments = message.attachments,
            pinnedAt = message.pinnedAt, pinnedBy = message.pinnedBy, poll = message.poll,
            priority = message.priority, ackRequested = message.ackRequested, acks = message.acks, type = message.type,
            collection = message.collection, tasks = message.tasks, systemEvent = message.systemEvent, workflow = message.workflow,
            call = message.call,
        )

        fun placeholder(
            clientMsgId: String, channelId: String, senderId: String, body: String, createdAt: String, parentId: String? = null, alsoInChannel: Boolean = false,
            priority: String? = null, ackRequested: Boolean = false,
        ) = MessageState(
            id = LOCAL_PREFIX + clientMsgId, channelId = channelId, senderId = senderId, seq = null, updatedSeq = -1,
            clientMsgId = clientMsgId, body = body, createdAt = createdAt, pending = true, parentId = parentId, alsoInChannel = alsoInChannel,
            priority = priority, ackRequested = ackRequested,
        )
    }
}

@Serializable
data class OutboxItem(
    val clientMsgId: String,
    val channelId: String,
    val body: String,
    val createdAt: String,
    val failed: String? = null,
    val parentId: String? = null,
    val attachmentIds: List<String> = emptyList(),
    val alsoInChannel: Boolean = false,
    /** M15e */
    val priority: String? = null,
    val ackRequested: Boolean = false,
)

@Serializable
data class Draft(
    val text: String = "",
    val attachments: List<AttachmentOut> = emptyList(),
    /** M15d: edited here and not yet saved on the server (an emptied draft stays until its delete is saved). */
    val dirty: Boolean = false,
    /** M15d: the server's `updated_at` of the version this device last matched. */
    val syncedAt: String? = null,
)

@Serializable
data class Snapshot(
    val meta: Map<String, String> = emptyMap(),
    val users: List<UserPublic> = emptyList(),
    val channels: List<ChannelState> = emptyList(),
    val messages: List<MessageState> = emptyList(),
    val outbox: List<OutboxItem> = emptyList(),
)

/** Write-through persistence (SQLite in the app; null in tests). */
interface Persistence {
    /** Everything but the messages, which [loadMessages] reads on its own. */
    fun loadAll(): Snapshot
    /** The cached messages: the bulk of the store, loaded apart so a failure here loses only them (AND-4). */
    fun loadMessages(): List<MessageState>
    fun saveMeta(key: String, value: String?)
    fun saveUser(user: UserPublic)
    fun saveChannel(channel: ChannelState)
    fun deleteChannel(id: String)
    fun saveMessage(message: MessageState)
    fun deleteMessage(id: String)
    /** §7.7: the rows a trim dropped, by id (the table has no seq column to delete a range by). */
    fun deleteMessages(ids: List<String>)
    fun clearMessages(channelId: String)
    fun saveOutbox(item: OutboxItem)
    fun deleteOutbox(clientMsgId: String)

    // M74 (CANVAS.md §19.2): the last copy of each canvas read, for offline viewing. Read on demand, never at start.
    /** Writes the copy and keeps only the `keep` most recently written ones. */
    fun saveCanvas(canvas: CachedCanvas, keep: Int)
    /** Blocking (after the writes queued before it): call off the main thread. */
    fun loadCanvas(id: String): CachedCanvas?
    /** The conversation's copies (its list while the server cannot be reached). Blocking, like [loadCanvas]. */
    fun loadCanvases(channelId: String): List<CachedCanvas>
    /** M78: every copy (the home's 「キャンバス」 while the server cannot be reached). Blocking, like [loadCanvas]. */
    fun loadAllCanvases(): List<CachedCanvas>
    fun deleteCanvas(id: String)
    fun deleteCanvases(channelId: String)
}

const val LOCAL_PREFIX = "local:"

/** M46: the meta key prefix of a canvas's unsaved edits ("canvas:<id>"). */
const val CANVAS_PENDING_PREFIX = "canvas:"

/**
 * At most this many messages are kept per channel (M22, SYNC_PROTOCOL.md §7.7): the newest ones (pending sends always
 * stay). Older history is paged in again when the reader scrolls up.
 */
const val CACHED_MESSAGES_PER_CHANNEL = 500

/** The single source of truth for the UI (ARCHITECTURE.md §11). Mutated only from the engine's thread. */
/**
 * One row of the threads view (THREADS.md §5): the parent and my relation to the thread. Not persisted:
 * the badge comes with bootstrap and the list is fetched when the view opens.
 */
data class ThreadEntry(val parent: MessageOut, val state: ThreadState) {
    val id: String get() = parent.id
}

/**
 * A public channel read before joining (SYNC_PROTOCOL.md §7.6.1): the pages GET /channels/{id}/messages gave when it
 * opened (older ones as the reader scrolls up) and the threads opened from it. Events only reach members, so nothing
 * keeps it current. Memory only: no cursor, read position or unread, never persisted nor in a snapshot; it goes when
 * the conversation closes or another one opens.
 */
data class ChannelPreview(
    val channelId: String,
    /** Timeline rows (top-level, or replies also sent to the channel), oldest first. */
    val messages: List<MessageState> = emptyList(),
    /** The first page has arrived; a failed load leaves it false with `failed` set (opening again retries). */
    val loaded: Boolean = false,
    val failed: Boolean = false,
    val hasOlder: Boolean = false,
    /** Replies of the threads opened from the preview, by parent id, oldest first. */
    val replies: Map<String, List<MessageState>> = emptyMap(),
    /**
     * M89 (MEMBERSHIP.md §5): the workspace turned the preview off (its setting, or the server's 403 preview_disabled): no
     * rows; the screen shows the join panel instead.
     */
    val disabled: Boolean = false,
) {
    /** Where the next older page starts (`before_seq`). */
    val oldestSeq: Int? get() = messages.firstOrNull()?.seq

    /** A history page: the latest one replaces the rows, an older one goes before them. */
    fun withPage(page: HistoryOut, older: Boolean): ChannelPreview {
        val rows = LinkedHashMap<String, MessageState>()
        if (older) messages.forEach { rows[it.id] = it }
        page.messages.filter { !it.deleted }.forEach { rows[it.id] = MessageState.from(it) }
        return copy(messages = rows.values.sortedBy { it.seq }, loaded = true, failed = false, hasOlder = page.hasMore)
    }
}

/**
 * L8 (TIMES_FEED.md §5): a change to a timeline row, for lists kept outside the store (the Times feed). `event`: a live
 * message.created / message.updated / message.deleted, [SYNCED] (a row the store took from a catch-up page, a fetch or the
 * answer to my own action), [MY_POLL] (the answer to my vote or answers: its own parts go in whatever the updated_seq,
 * SYNC_PROTOCOL.md §8) or [PARENT_THREAD] (a reply moved its parent's counts; `message` is null).
 */
data class TimelineEvent(val event: String, val message: MessageOut?, val thread: ParentThread? = null) {
    /** The version the event brings: lists kept apart re-apply what arrived during a page read in this order. */
    val version: Int get() = message?.updatedSeq ?: thread?.updatedSeq ?: 0

    companion object {
        const val SYNCED = "message.synced"
        const val MY_POLL = "poll.mine"
        const val PARENT_THREAD = "parent_thread"
    }
}

/**
 * SYNC_PROTOCOL.md §8 poll.mine (M27), my_answers / my_comment (M53): the parts of a poll only a response to me carries
 * (an event has them null). The conversation store and the Times feed merge them the same way.
 */
object MyPollPart {
    /** `incoming` with the parts it lacks (null) taken from `local`; `incoming` itself if none. */
    fun keep(incoming: PollOut, local: PollOut): PollOut {
        val mine = if (incoming.mine == null) local.mine else incoming.mine
        val answers = if (incoming.myAnswers == null) local.myAnswers else incoming.myAnswers
        val comment = if (incoming.myComment == null) local.myComment else incoming.myComment
        if (mine == incoming.mine && answers == incoming.myAnswers && comment == incoming.myComment) return incoming
        return incoming.copy(mine = mine, myAnswers = answers, myComment = comment)
    }

    /** `local` with the parts `response` carries, or null when they change nothing. */
    fun taken(local: PollOut, response: PollOut): PollOut? {
        val mine = response.mine ?: local.mine
        val answers = response.myAnswers ?: local.myAnswers
        val comment = response.myComment ?: local.myComment
        if (mine == local.mine && answers == local.myAnswers && comment == local.myComment) return null
        return local.copy(mine = mine, myAnswers = answers, myComment = comment)
    }
}

/** A confirmed local row in the server shape (thread rows built from the timeline). */
fun MessageState.toOut(): MessageOut? {
    val seq = seq ?: return null
    if (pending) return null
    return MessageOut(
        id = id, channelId = channelId, senderId = senderId, seq = seq, updatedSeq = updatedSeq, clientMsgId = clientMsgId,
        parentId = parentId, alsoInChannel = alsoInChannel, body = body, mentionedUserIds = mentionedUserIds, mentionAll = mentionAll, reactions = reactions,
        attachments = attachments, replyCount = replyCount, lastReplyAt = lastReplyAt, replyUserIds = replyUserIds, createdAt = createdAt, editedAt = editedAt, deleted = deleted,
        pinnedAt = pinnedAt, pinnedBy = pinnedBy, poll = poll, priority = priority, ackRequested = ackRequested, acks = acks, type = type,
        collection = collection, tasks = tasks, workflow = workflow, call = call,
    )
}

class Store(private val persistence: Persistence? = null) {
    var me: UserMe? = null
        private set
    val users = LinkedHashMap<String, UserPublic>()
    val channels = LinkedHashMap<String, ChannelState>()
    val outbox = ArrayList<OutboxItem>()
    /** Followed threads (THREADS.md §5), replaced by thread.updated and GET /threads pages. */
    val threads = LinkedHashMap<String, ThreadEntry>()
    var threadSummary = ThreadSummary()
        private set
    /**
     * M39: the activity tab's badge, from bootstrap (every connect) and GET /activity/summary. Null until a bootstrap
     * brought one, or from a server before M39: the tab then keeps its stage-A lists and badge (MainTabs.activityBadge).
     * Not persisted.
     */
    var activity: ActivitySummaryOut? = null
        private set
    /**
     * M39: bumped by each event that may add an activity item (reaction.added, a mention, a reply in a followed
     * thread): the activity list on screen reads its first page again.
     */
    var activityRevision = 0
        private set
    /**
     * MOBILE_UI.md §6.4: bumped when my read position in a conversation moved back (read.updated, reason "set"): items
     * read in it may be unread again, so the activity list on screen loads again.
     */
    var activityReloads = 0
        private set
    /**
     * My read position per thread (parent id), from every thread state seen and the replies read on this device, held
     * or not: the activity list unmarks the replies read in their thread (§6.4). Not persisted.
     */
    val threadReadSeqs = HashMap<String, Int>()
    var threadsFilter = "all"
        private set
    var threadsLoaded = false
        private set
    var threadsCursor: String? = null
        private set
    var threadsHasMore = false
        private set
    /** Who is connected right now (SYNC_PROTOCOL.md §5.2); absent = offline. Replaced by bootstrap. */
    val presence = HashMap<String, String>()
    /** "channel[:parent]" → user id → expiry (epoch ms); volatile typing indicators. */
    private val typing = HashMap<String, HashMap<String, Long>>()
    /** My saved message ids (M11c); from bootstrap and bookmark.updated, not persisted. */
    val bookmarks = HashSet<String>()
    /** My starred channel ids (M12a); from bootstrap and favorite.updated, not persisted. */
    val favorites = HashSet<String>()
    /** M118: the DMs I pinned to the top, oldest pin first; from bootstrap and dm_pin.updated, not persisted. */
    val dmPins = ArrayList<String>()
    /** M118: the server keeps pins (it sent `dm_pins`); a server before M118 does not, and no pin action is offered. */
    var dmPinsKnown = false
        private set
    /** M104 (MODERATION.md §4): the people I blocked; from bootstrap and block.updated, not persisted. */
    val blockedUsers = HashSet<String>()
    /** My pending scheduled messages (M12d); from GET /scheduled and scheduled.updated, not persisted. */
    val scheduled = LinkedHashMap<String, ScheduledOut>()
    /** My open reminders (M12e): fired ones wait for 完了, pending ones for their time. */
    val reminders = LinkedHashMap<String, ReminderOut>()
    /** Custom emoji by name (M12f); from bootstrap and emoji.updated. Images are cached by id once fetched. */
    val customEmoji = LinkedHashMap<String, CustomEmojiOut>()
    val emojiImages = HashMap<String, ImageBitmap>()
    /** M100: emoji packs by id (picker tabs) and their tab icons by "id:version". */
    val emojiPacks = LinkedHashMap<String, jp.chikuwachat.android.api.EmojiPackOut>()
    val packTabImages = HashMap<String, ImageBitmap>()
    /** The frames of the animated ones (GIF), by id; their first frame is in [emojiImages]. */
    val emojiAnimations = HashMap<String, jp.chikuwachat.android.ui.EmojiAnimation>()
    /** User groups by id (M12k); from bootstrap and group.updated. `@name` expands on the server. */
    val groups = LinkedHashMap<String, GroupOut>()
    /** Post templates by id (M30); from bootstrap and template.updated, not persisted (like groups). Order: ui/Templates.kt. */
    val templates = LinkedHashMap<String, TemplateOut>()
    /** The lab roster (M23) by user id; from bootstrap and roster.updated, not persisted (like groups). Order: ui/Roster.kt. */
    val roster = HashMap<String, LabProfileOut>()
    /** My sidebar sections (M14f), in order; from bootstrap and sidebar.updated. */
    var sidebarSections: List<SidebarSectionOut> = emptyList()
        private set
    /** bootstrap.limits (SYNC_PROTOCOL.md §4.1); null until the first bootstrap. */
    var limits: Limits? = null
        private set
    fun setLimits(value: Limits) {
        limits = value
    }
    /** M88 (MEMBERSHIP.md §3): bootstrap's workspace_settings, replaced by workspace.settings_updated; not persisted. */
    var workspaceSettings = WorkspaceSettingsOut()
        private set
    /** M93: bootstrap's or workspace.settings_updated's `icon_version` (only when the server sends it): the saved entry follows. */
    var onWorkspaceIcon: ((String?) -> Unit)? = null
    fun setWorkspaceSettings(value: WorkspaceSettingsOut) {
        if (value.knowsIcon) onWorkspaceIcon?.invoke(value.iconVersion)
        if (workspaceSettings == value) return
        workspaceSettings = value
        emit()
    }
    /** M15f: link bars of the conversations opened so far (not persisted). */
    private val channelLinks = HashMap<String, List<ChannelLinkOut>>()
    fun setChannelLinks(channelId: String, links: List<ChannelLinkOut>) {
        channelLinks[channelId] = links
        emit()
    }
    fun linksOf(channelId: String): List<ChannelLinkOut> = channelLinks[channelId] ?: emptyList()
    /**
     * M112 (docs/RESERVATIONS.md §6): the workspace's reservation pools as the server answered me (not persisted); null
     * until first read (after every bootstrap, then on reservation.updated) or with a server before M112.
     */
    var reservationPools: List<PoolOut>? = null
        private set
    fun setReservationPools(pools: List<PoolOut>?) {
        reservationPools = pools
        emit()
    }
    /** One pool as an action answered it (replaced in place, or added at the end). */
    fun putReservationPool(pool: PoolOut) {
        val list = reservationPools ?: emptyList()
        setReservationPools(if (list.any { it.id == pool.id }) list.map { if (it.id == pool.id) pool else it } else list + pool)
    }
    fun dropReservationPool(poolId: String) {
        reservationPools?.let { list -> setReservationPools(list.filter { it.id != poolId }) }
    }

    /**
     * M46 (CANVAS.md §4.6): the canvases of the conversations opened so far, without bodies, most recently updated first.
     * Loaded when a conversation opens and after reconnecting; canvas.* events keep them current (the larger version
     * wins). Not persisted.
     */
    private val canvasLists = HashMap<String, List<CanvasMeta>>()

    /** Null: not loaded yet. */
    fun canvasesOf(channelId: String): List<CanvasMeta>? = canvasLists[channelId]

    fun canvasMeta(canvasId: String): CanvasMeta? = canvasLists.values.firstNotNullOfOrNull { list -> list.firstOrNull { it.id == canvasId } }

    /**
     * Why a conversation's list could not be loaded (the last try; cleared when it loads): the pane shows it instead of
     * 「読み込み中…」 (a server older than canvases answers 404). Not persisted.
     */
    private val canvasListErrors = HashMap<String, Throwable>()

    fun canvasListError(channelId: String): Throwable? = canvasListErrors[channelId]

    fun setCanvasListError(channelId: String, error: Throwable?) {
        if (error != null) canvasListErrors[channelId] = error
        else if (canvasListErrors.remove(channelId) == null) return
        emit()
    }

    fun setCanvases(channelId: String, list: List<CanvasMeta>) {
        canvasListErrors.remove(channelId)
        val known = canvasLists[channelId] ?: emptyList()
        // A newer version from an event that overtook the list keeps its place.
        val merged = list.map { meta -> known.firstOrNull { it.id == meta.id }?.takeIf { it.version > meta.version } ?: meta }
        canvasLists[channelId] = sortCanvases(merged)
        emit()
    }

    /** canvas.created / canvas.updated, or an answer of mine: the larger version wins. */
    fun applyCanvasMeta(meta: CanvasMeta) {
        val list = canvasLists[meta.channelId] ?: return // loaded with the list when the conversation opens
        val existing = list.firstOrNull { it.id == meta.id }
        if (existing != null && existing.version >= meta.version) return
        canvasLists[meta.channelId] = sortCanvases(list.filter { it.id != meta.id } + meta.copy(deletedAt = null))
        emit()
    }

    fun removeCanvas(channelId: String, canvasId: String) {
        val list = canvasLists[channelId] ?: return
        if (list.none { it.id == canvasId }) return
        canvasLists[channelId] = list.filter { it.id != canvasId }
        emit()
    }

    /**
     * M74: the list could not be read (offline): the conversation's cached copies stand in for it until it loads (the
     * error stays, so the next try is not skipped). Nothing is done once a list is there.
     */
    fun setCanvasesFromCache(channelId: String, copies: List<CachedCanvas>) {
        if (canvasLists.containsKey(channelId) || copies.isEmpty()) return
        canvasLists[channelId] = sortCanvases(copies.map { it.canvas.meta })
        emit()
    }

    // --- M74: the canvas copies for offline viewing (CANVAS.md §19.2) ------------------------------

    /** The last copy of a canvas read on this device. Blocking: call off the main thread. */
    fun cachedCanvas(canvasId: String): CachedCanvas? = persistence?.let { p -> runCatching { p.loadCanvas(canvasId) }.getOrNull() }

    /** The conversation's copies. Blocking: call off the main thread. */
    fun cachedCanvases(channelId: String): List<CachedCanvas> = persistence?.let { p -> runCatching { p.loadCanvases(channelId) }.getOrNull() } ?: emptyList()

    /** M78: every copy on this device (the home's 「キャンバス」 offline). Blocking: call off the main thread. */
    fun allCachedCanvases(): List<CachedCanvas> = persistence?.let { p -> runCatching { p.loadAllCanvases() }.getOrNull() } ?: emptyList()

    /** The server answered with this canvas (read or saved): it becomes the copy shown offline. */
    fun cacheCanvas(canvas: CanvasOut, at: Long = System.currentTimeMillis()) {
        persist { it.saveCanvas(CachedCanvas(canvas, at), CANVAS_CACHE_LIMIT) }
    }

    /** In the trash, or out of reach: its copy goes. */
    fun uncacheCanvas(canvasId: String) {
        persist { it.deleteCanvas(canvasId) }
    }

    private fun sortCanvases(list: List<CanvasMeta>): List<CanvasMeta> =
        list.sortedWith(compareByDescending<CanvasMeta> { it.updatedAt }.thenByDescending { it.id })

    /** M46: unsaved canvas edits, kept in the meta table under "canvas:<id>" so a restart sends them (same key, §4.4). */
    private val canvasPending = LinkedHashMap<String, CanvasPendingState>()

    fun pendingCanvas(canvasId: String): CanvasPendingState? = canvasPending[canvasId]

    fun pendingCanvases(): List<Pair<String, CanvasPendingState>> = canvasPending.entries.map { it.key to it.value }

    fun setPendingCanvas(canvasId: String, state: CanvasPendingState?) {
        if (state != null) canvasPending[canvasId] = state
        else if (canvasPending.remove(canvasId) == null) return
        persist { it.saveMeta(CANVAS_PENDING_PREFIX + canvasId, state?.let { value -> Codec.plain.encodeToString(CanvasPendingState.serializer(), value) }) }
    }

    /** §7.6.1: the public channel being read before joining, if any (never persisted, see ChannelPreview). */
    var preview: ChannelPreview? = null
        private set

    fun setPreview(value: ChannelPreview?) {
        if (preview == value) return
        preview = value
        emit()
    }

    /** Changes the preview of `channelId`; nothing when another channel's (or none) is held. */
    fun updatePreview(channelId: String, change: (ChannelPreview) -> ChannelPreview) {
        val current = preview?.takeIf { it.channelId == channelId } ?: return
        setPreview(change(current))
    }
    private val drafts = LinkedHashMap<String, Draft>()
    private val uploads = HashMap<String, Int>()
    private fun draftKey(channelId: String, parentId: String?) = "draft:$channelId:${parentId ?: ""}"
    fun draft(channelId: String, parentId: String? = null) = drafts[draftKey(channelId, parentId)] ?: Draft()
    /** M15d: told about every local text change (the engine saves it on the server a moment later). */
    var onDraftEdited: ((channelId: String, parentId: String?) -> Unit)? = null

    /**
     * `quiet` (M28c): the composer writes each keystroke through without a version bump (which recomposed the whole
     * screen); it shows the text from its own state and bumps the version itself when it leaves ([notifyChanged]).
     * Everything else about the draft (persisted, dirty, the sync's save after the pause) is the same.
     */
    fun setDraft(channelId: String, parentId: String? = null, quiet: Boolean = false, mutate: (Draft) -> Draft) {
        val previous = draft(channelId, parentId)
        var value = mutate(previous)
        val edited = value.text != previous.text
        if (edited) value = value.copy(dirty = true)
        writeDraft(draftKey(channelId, parentId), value, quiet)
        if (edited) onDraftEdited?.invoke(channelId, parentId)
    }

    private fun writeDraft(key: String, value: Draft, quiet: Boolean = false) {
        val keep = value.text.isNotEmpty() || value.attachments.isNotEmpty() || value.dirty
        if (keep) drafts[key] = value else drafts.remove(key)
        persist { it.saveMeta(key, drafts[key]?.let { d -> Codec.plain.encodeToString(Draft.serializer(), d) }) }
        if (!quiet) emit()
    }

    /** A version bump for changes written quietly (see [setDraft]): the screens read the Store again. */
    fun notifyChanged() = emit()

    /** M15d: every stored draft, including emptied ones whose delete is not saved yet. */
    fun draftEntries(): List<DraftEntry> = drafts.entries.mapNotNull { (key, draft) ->
        val parts = key.split(":", limit = 3)
        if (parts.size != 3) null else DraftEntry(parts[1], parts[2].ifEmpty { null }, draft)
    }

    /** M15d: a version from my other devices (`body` null = deleted there); ignored while this device has unsaved edits. */
    fun applyRemoteDraft(channelId: String, parentId: String?, body: String?, updatedAt: String?) {
        val key = draftKey(channelId, parentId)
        val current = drafts[key]
        if (current?.dirty == true) return
        val next = Draft(text = body ?: "", attachments = current?.attachments ?: emptyList(), syncedAt = if (body == null) null else updatedAt)
        if (current != null && current.text == next.text && current.syncedAt == next.syncedAt) return
        if (current == null && next.text.isEmpty()) return
        writeDraft(key, next)
    }

    /** M15d: the server now holds `text` (no draft when `updatedAt` is null), unless it was edited again meanwhile. */
    fun markDraftSaved(channelId: String, parentId: String?, text: String, updatedAt: String?) {
        val key = draftKey(channelId, parentId)
        val current = drafts[key] ?: return
        if (current.text != text) return
        writeDraft(key, current.copy(dirty = false, syncedAt = updatedAt))
    }

    fun markDraftDirty(channelId: String, parentId: String?) {
        val key = draftKey(channelId, parentId)
        val current = drafts[key] ?: return
        if (!current.dirty) writeDraft(key, current.copy(dirty = true))
    }
    fun uploading(channelId: String, parentId: String? = null) = uploads[draftKey(channelId, parentId)] ?: 0

    /** A conversation with unsent text or attachments (M11h 「下書き」). */
    data class DraftEntry(val channelId: String, val parentId: String?, val draft: Draft)

    /** Every draft with text or attachments, in the order they were started. */
    fun listDrafts(): List<DraftEntry> = drafts.entries.mapNotNull { (key, draft) ->
        val parts = key.split(":", limit = 3)
        if (parts.size != 3 || (draft.text.isBlank() && draft.attachments.isEmpty())) return@mapNotNull null
        DraftEntry(parts[1], parts[2].ifEmpty { null }, draft)
    }
    fun trackUpload(channelId: String, parentId: String? = null, delta: Int) {
        val key = draftKey(channelId, parentId)
        uploads[key] = maxOf(0, (uploads[key] ?: 0) + delta)
        emit()
    }
    private val messagesByChannel = HashMap<String, LinkedHashMap<String, MessageState>>()

    private val _version = MutableStateFlow(0)
    /** Bumps on every change; Compose collects it and re-reads the store. */
    val version: StateFlow<Int> = _version

    fun load() {
        val target = persistence ?: return
        val snapshot = runCatching { target.loadAll() }.getOrNull() ?: return
        // AND-4: the messages come on their own. A failure there (years of rows too big for memory) costs only the
        // cached rows; the outbox, drafts and channels that loaded fine stay.
        val messages = runCatching { target.loadMessages() }.onFailure { println("messages not loaded: $it") }
        apply(snapshot.copy(messages = messages.getOrDefault(emptyList())), messagesLost = messages.isFailure)
        emit()
    }

    /** Rows as persisted: stale or lost timelines load again, the cache is trimmed (§7.7). */
    private fun apply(snapshot: Snapshot, messagesLost: Boolean = false) {
        snapshot.meta.filterKeys { it.startsWith("draft:") }.forEach { (key, value) ->
            runCatching { Codec.plain.decodeFromString(Draft.serializer(), value) }.getOrNull()?.let { drafts[key] = it }
        }
        snapshot.meta.filterKeys { it.startsWith(CANVAS_PENDING_PREFIX) }.forEach { (key, value) ->
            runCatching { Codec.plain.decodeFromString(CanvasPendingState.serializer(), value) }.getOrNull()?.let { canvasPending[key.removePrefix(CANVAS_PENDING_PREFIX)] = it }
        }
        me = snapshot.meta["me"]?.let { runCatching { Codec.plain.decodeFromString(UserMe.serializer(), it) }.getOrNull() }
        snapshot.users.forEach { users[it.id] = it }
        // §7.3: a timeline cached before `oldestLoadedSeq` existed may hide holes, so it loads again from the
        // latest page (unsent messages stay).
        val stale = snapshot.channels.filter { it.syncedSeq != null && it.oldestLoadedSeq == null }.map { it.id }.toSet()
        snapshot.channels.forEach { channels[it.id] = if (it.id in stale) it.copy(syncedSeq = null, hasOlder = true) else it }
        snapshot.messages.forEach { if (it.channelId !in stale || it.pending) bucket(it.channelId)[it.id] = it }
        stale.forEach { id ->
            val kept = bucket(id).values.toList()
            val channel = channels.getValue(id)
            persist { it.clearMessages(id); kept.forEach { m -> it.saveMessage(m) }; it.saveChannel(channel) }
        }
        outbox.addAll(snapshot.outbox)
        if (messagesLost) forgetTimelines()
        messagesByChannel.keys.toList().forEach { trimCache(it) }
    }

    /**
     * The messages could not be read: every timeline loads again from the latest page (a synced cursor over rows that
     * are not here would leave a hole no page fills), the table is emptied so the next start does not fail the same
     * way, and the unsent messages get their pending rows back from the outbox.
     */
    private fun forgetTimelines() {
        channels.values.toList().forEach { channel ->
            val reset = channel.copy(syncedSeq = null, oldestLoadedSeq = null, hasOlder = true)
            channels[channel.id] = reset
            persist { it.clearMessages(channel.id); it.saveChannel(reset) }
        }
        outbox.forEach { item ->
            val placeholder = MessageState.placeholder(
                item.clientMsgId, item.channelId, me?.id ?: "", item.body, item.createdAt, item.parentId, item.alsoInChannel, item.priority, item.ackRequested,
            ).copy(failed = item.failed != null)
            bucket(item.channelId)[placeholder.id] = placeholder
            persist { it.saveMessage(placeholder) }
        }
    }

    private fun emit() {
        _version.value = _version.value + 1
    }

    private fun persist(work: (Persistence) -> Unit) {
        val target = persistence ?: return
        runCatching { work(target) }.onFailure { println("persist failed: $it") }
    }

    // --- me / users -------------------------------------------------------------------------

    fun setMe(value: UserMe?) {
        me = value
        persist { it.saveMeta("me", value?.let { m -> Codec.plain.encodeToString(UserMe.serializer(), m) }) }
        emit()
    }

    fun upsertUser(user: UserPublic) {
        AvatarCache.note(user)  // M14a
        users[user.id] = user
        persist { it.saveUser(user) }
        emit()
    }

    // --- channels ---------------------------------------------------------------------------

    fun channel(id: String): ChannelState? = channels[id]

    /**
     * Merge server fields into the local channel, keeping the local cursor. `replaceLastMessage` (bootstrap, M49): its
     * `last_message` is the truth, null too ("no message yet"); anywhere else null means "not said" and the held one
     * stays (SYNC_PROTOCOL.md §7.8).
     */
    fun upsertChannel(channel: ChannelOut, isMember: Boolean? = null, replaceLastMessage: Boolean = false): ChannelState {
        val existing = channels[channel.id]
        val read = channel.readState
        val merged = ChannelState(
            // channel.updated events carry no per-user preference, membership or count (M11h): keep the ones we know.
            channel = channel.copy(
                readState = null,
                notification = channel.notification ?: existing?.channel?.notification,
                membership = channel.membership ?: existing?.channel?.membership,
                memberCount = channel.memberCount ?: existing?.channel?.memberCount,
                lastMessage = if (replaceLastMessage) channel.lastMessage else channel.lastMessage ?: existing?.channel?.lastMessage,
            ),
            isMember = isMember ?: existing?.isMember ?: (channel.membership != null),
            syncedSeq = existing?.syncedSeq,
            lastSeq = maxOf(existing?.lastSeq ?: 0, channel.lastSeq),
            // §10: the server's read state is the truth (no max merge): a position that only moved here stays
            // in unsentReadSeq and is sent again; kept locally it would leave an unread that cannot be read.
            lastReadSeq = read?.lastReadSeq ?: existing?.lastReadSeq ?: 0,
            unreadCount = read?.unreadCount ?: existing?.unreadCount ?: 0,
            mentionCount = read?.mentionCount ?: existing?.mentionCount ?: 0,
            firstUnreadAt = if (read != null) read.firstUnreadAt else existing?.firstUnreadAt,
            hasOlder = existing?.hasOlder ?: true,
            oldestLoadedSeq = existing?.oldestLoadedSeq,
            unsentReadSeq = existing?.unsentReadSeq,
        )
        channels[channel.id] = merged
        persist { it.saveChannel(merged) }
        emit()
        return merged
    }

    /** A PUT's answer or `notification_preference.updated` (with follows_default and muted, M35). */
    fun setNotification(pref: NotificationPreferenceOut) {
        updateChannel(pref.channelId) { it.copy(channel = it.channel.copy(notification = pref)) }
    }

    fun updateChannel(id: String, mutate: (ChannelState) -> ChannelState): ChannelState? {
        val existing = channels[id] ?: return null
        val updated = mutate(existing)
        channels[id] = updated
        persist { it.saveChannel(updated) }
        emit()
        return updated
    }

    /** M49: a preview emptied by a deletion the rows held could not replace; the engine fetches the server's. */
    var onStalePreview: ((channelId: String) -> Unit)? = null

    /**
     * L8 (TIMES_FEED.md §5): each confirmed row the store is given ([upsertMessage]: live events, catch-up and history
     * pages, the answers to my own actions), my poll answers and parents' reply counts, for lists kept apart (the feed).
     */
    var onTimelineRow: ((channelId: String, event: TimelineEvent) -> Unit)? = null

    /**
     * M49 (SYNC_PROTOCOL.md §7.8): a timeline message of one of my conversations moves its preview. A newer one takes
     * its place; the one shown, edited, brings its new text; the one shown, deleted, falls back to the newest live row
     * held below it. When the rows held cannot say (no contiguous timeline down to it), the preview empties and
     * [onStalePreview] asks the server (GET /channels/{id}). Thread-only replies, pending sends and older rows (history
     * pages, search hits) leave it. `quiet`: the caller bumps the version itself ([upsertMessage]).
     */
    fun applyLastMessage(message: MessageState, quiet: Boolean = false) {
        val seq = message.seq ?: return
        if (message.pending || !message.inTimeline) return
        val channel = channels[message.channelId] ?: return
        if (!channel.isMember) return
        val current = channel.channel.lastMessage
        if (message.deleted) {
            if (current?.id != message.id) return
            // The loaded range is contiguous up to syncedSeq (§7.3): its newest live row below is the newest there is.
            val timeline = if (channel.syncedSeq == null) emptyList() else messages(channel.id)
            val below = timeline.lastOrNull { row -> row.seq != null && row.seq < seq && !row.deleted && !row.pending }
            writeLastMessage(channel.id, below?.let { lastMessageOf(it, users, groups) }, quiet)
            if (below == null && (channel.syncedSeq == null || channel.hasOlder)) onStalePreview?.invoke(channel.id)
            return
        }
        if (current != null && current.id != message.id && current.seq >= seq) return
        val next = lastMessageOf(message, users, groups)
        if (!sameLastMessage(current, next)) writeLastMessage(channel.id, next, quiet)
    }

    /**
     * M49: the server's preview fetched after a deletion the rows held could not replace (GET /channels/{id}). A newer
     * one that came in the meantime (an event after the answer was made) stays.
     */
    fun setFetchedLastMessage(channelId: String, last: LastMessageOut?) {
        val current = channels[channelId]?.channel?.lastMessage
        if (current != null && (last == null || current.seq > last.seq)) return
        if (!sameLastMessage(current, last)) writeLastMessage(channelId, last, quiet = false)
    }

    private fun writeLastMessage(channelId: String, value: LastMessageOut?, quiet: Boolean) {
        val existing = channels[channelId] ?: return
        val updated = existing.copy(channel = existing.channel.copy(lastMessage = value))
        channels[channelId] = updated
        persist { it.saveChannel(updated) }
        if (!quiet) emit()
    }

    /** L4 (M31): bumped by channel.member_updated, so an open member list loads again (not persisted). */
    private val memberEpochs = HashMap<String, Int>()
    fun memberEpoch(channelId: String): Int = memberEpochs[channelId] ?: 0

    /**
     * channel.member_updated (SYNC_PROTOCOL.md, M31): someone became an owner or a member again. When it is me, my
     * membership role changes (owner-only actions appear or go); either way an open member list is loaded again.
     */
    fun applyMemberUpdated(channelId: String, userId: String, role: String) {
        memberEpochs[channelId] = memberEpoch(channelId) + 1
        val existing = channels[channelId]
        if (existing != null && userId == me?.id && existing.isMember) {
            val membership = existing.channel.membership?.copy(role = role) ?: MembershipOut(role, "")
            updateChannel(channelId) { it.copy(channel = it.channel.copy(membership = membership)) }
        } else {
            emit()
        }
    }

    fun removeChannel(id: String) {
        channels.remove(id)
        messagesByChannel.remove(id)
        // M46 (CANVAS.md §4.6): its canvases and their unsaved edits go with it.
        canvasLists.remove(id)
        canvasListErrors.remove(id)
        canvasPending.filterValues { it.channelId == id }.keys.toList().forEach { setPendingCanvas(it, null) }
        if (preview?.channelId == id) preview = null // made private, or no longer listed: its preview goes too
        persist { it.clearMessages(id); it.deleteChannel(id); it.deleteCanvases(id) } // M74: and the canvas copies
        emit()
    }

    // --- messages ---------------------------------------------------------------------------

    private fun bucket(channelId: String): LinkedHashMap<String, MessageState> = messagesByChannel.getOrPut(channelId) { LinkedHashMap() }

    /**
     * The channel timeline: confirmed messages by seq from the loaded range on (§7.3 `oldestLoadedSeq`),
     * then pending ones in creation order (SYNC_PROTOCOL.md §9).
     */
    fun messages(channelId: String): List<MessageState> {
        val oldest = channels[channelId]?.oldestLoadedSeq
        return ordered(bucket(channelId).values.filter { it.inTimeline && (it.seq == null || (oldest != null && it.seq >= oldest)) })
    }

    /** A thread: the replies of one parent, oldest first (pending ones last). */
    fun replies(channelId: String, parentId: String): List<MessageState> =
        ordered(bucket(channelId).values.filter { it.parentId == parentId })

    private fun ordered(all: Collection<MessageState>): List<MessageState> {
        val confirmed = all.filter { it.seq != null }.sortedBy { it.seq }
        val pending = all.filter { it.seq == null }.sortedBy { it.createdAt }
        return confirmed + pending
    }

    /** A reply moved the parent's counters (message.created / message.deleted with parent_thread). */
    fun applyParentThread(channelId: String, thread: ParentThread) {
        onTimelineRow?.invoke(channelId, TimelineEvent(TimelineEvent.PARENT_THREAD, null, thread))
        val parent = bucket(channelId)[thread.id] ?: return
        if (thread.updatedSeq <= parent.updatedSeq) return
        // C3: an older server sends no list; the parent keeps what it had.
        val updated = parent.copy(
            replyCount = thread.replyCount, lastReplyAt = thread.lastReplyAt, replyUserIds = thread.replyUserIds ?: parent.replyUserIds,
            updatedSeq = thread.updatedSeq,
        )
        bucket(channelId)[parent.id] = updated
        persist { it.saveMessage(updated) }
        emit()
    }

    fun message(channelId: String, id: String): MessageState? = bucket(channelId)[id]

    // --- threads (THREADS.md §5) ------------------------------------------------------------

    fun setThreadSummary(summary: ThreadSummary) {
        if (summary == threadSummary) return
        threadSummary = summary
        emit()
    }

    // --- activity (M39) -----------------------------------------------------------------------

    fun setActivity(summary: ActivitySummaryOut?) {
        if (summary == activity) return
        activity = summary
        emit()
    }

    fun noteActivity() {
        activityRevision += 1
        emit()
    }

    fun reloadActivity() {
        activityReloads += 1
        emit()
    }

    /** A thread's read position as last seen (a thread state, or a reply read here); the list's dots follow it. */
    fun noteThreadRead(parentId: String, seq: Int) {
        if (threadReadSeqs[parentId] == seq) return
        threadReadSeqs[parentId] = seq
        emit()
    }

    /**
     * Review v0.1.22 (CANVAS.md §20.8): canvas activity items whose excerpt the server blanked (activity.updated: a
     * version's body was erased). Rows shown drop their excerpt at once; the list on screen also reads its first page
     * again (the revision). Not persisted (nothing of the list is).
     */
    var blankedActivityItems: Set<String> = emptySet()
        private set

    fun blankActivityExcerpts(itemIds: Collection<String>) {
        if (itemIds.isEmpty()) return
        blankedActivityItems = blankedActivityItems + itemIds
        noteActivity()
    }

    /**
     * A page of GET /threads. Rows merge so an open thread keeps its state across filter changes and
     * refreshes; on a first page, rows the server would have listed but did not (unfollowed or deleted
     * elsewhere) are dropped, except those in `keep` (threads on screen).
     */
    fun setThreadPage(filter: String, items: List<ThreadItem>, cursor: String?, append: Boolean, pageSize: Int, keep: Set<String> = emptySet()) {
        if (!append) {
            val listed = items.map { it.parent.id }.toSet()
            val oldest = if (items.size >= pageSize) items.last().state.lastReplyAt ?: "" else ""
            threads.entries.removeAll { (id, entry) ->
                id !in listed && id !in keep && entry.state.following &&
                    !(filter == "unread" && entry.state.unreadCount == 0) &&
                    (entry.state.lastReplyAt ?: "") >= oldest
            }
        }
        items.forEach { threads[it.parent.id] = ThreadEntry(it.parent, it.state) }
        threadsFilter = filter
        threadsLoaded = true
        threadsCursor = cursor
        threadsHasMore = items.size >= pageSize
        emit()
    }

    /** thread.updated / a PUT response: replace the state; the badge moves with it when the old state is known. */
    fun applyThreadState(state: ThreadState, parent: MessageOut? = null) {
        threadReadSeqs[state.parentId] = state.lastReadSeq
        val existing = threads[state.parentId]
        val before = existing?.state
        if (existing != null) {
            threads[state.parentId] = ThreadEntry(existing.parent.copy(replyCount = state.replyCount, lastReplyAt = state.lastReplyAt), state)
        } else {
            val known = parent ?: messagesByChannel[state.channelId]?.get(state.parentId)?.toOut()
            if (known != null) threads[state.parentId] = ThreadEntry(known.copy(replyCount = state.replyCount, lastReplyAt = state.lastReplyAt), state)
        }
        if (before != null) {
            fun unread(s: ThreadState) = if (s.following && s.unreadCount > 0) 1 else 0
            fun mention(s: ThreadState) = if (s.following && s.mentionCount > 0) 1 else 0
            threadSummary = ThreadSummary(
                maxOf(0, threadSummary.unreadCount + unread(state) - unread(before)),
                maxOf(0, threadSummary.mentionCount + mention(state) - mention(before)),
            )
        }
        emit()
    }

    // --- sidebar sections (M14f) -------------------------------------------------------------

    fun replaceSidebar(rows: List<SidebarSectionOut>) {
        sidebarSections = rows.sortedBy { it.position }
        emit()
    }

    /** The default sections' sorts (DATA_MODEL.md 「並べ替え」); empty = the defaults. */
    var sidebarDefaults: List<jp.chikuwachat.android.api.SidebarDefaultOut> = emptyList()
        private set

    fun replaceSidebarDefaults(rows: List<jp.chikuwachat.android.api.SidebarDefaultOut>) {
        sidebarDefaults = rows
        emit()
    }

    /** A default section's sort and hand-made order. */
    fun defaultSort(key: String): jp.chikuwachat.android.api.SidebarDefaultOut =
        sidebarDefaults.firstOrNull { it.key == key } ?: jp.chikuwachat.android.api.SidebarDefaultOut(key, jp.chikuwachat.android.ui.SidebarOrder.defaultSorts[key] ?: "name")

    /** The id of my section the conversation sits in, if any. */
    fun sectionOf(channelId: String): String? = sidebarSections.firstOrNull { channelId in it.channelIds }?.id

    // --- user groups (M12k) ------------------------------------------------------------------

    fun replaceGroups(rows: List<GroupOut>) {
        groups.clear()
        rows.forEach { groups[it.id] = it }
        emit()
    }

    fun applyGroup(row: GroupOut, deleted: Boolean) {
        if (deleted) groups.remove(row.id) else groups[row.id] = row
        emit()
    }

    // --- post templates (M30) ------------------------------------------------------------------

    fun replaceTemplates(rows: List<TemplateOut>) {
        templates.clear()
        rows.forEach { templates[it.id] = it }
        emit()
    }

    fun applyTemplate(row: TemplateOut, deleted: Boolean) {
        if (deleted) templates.remove(row.id) else templates[row.id] = row
        emit()
    }

    // --- lab roster (M23) ---------------------------------------------------------------------

    fun replaceRoster(rows: List<LabProfileOut>) {
        roster.clear()
        rows.forEach { roster[it.userId] = it }
        emit()
    }

    /** roster.updated (or my own save): the person's line, or null when they left the roster. */
    fun applyRoster(userId: String, profile: LabProfileOut?) {
        if (profile != null) roster[userId] = profile else roster.remove(userId)
        emit()
    }

    // --- custom emoji (M12f) -----------------------------------------------------------------

    /**
     * Review v0.1.37 #7: a bootstrap's list (after emoji.updated may have been missed offline) drops the images that no
     * longer match, as [applyCustomEmoji] does for one event: removed emoji, and text pills whose look changed.
     */
    fun replaceCustomEmoji(rows: List<CustomEmojiOut>) {
        val fresh = rows.associateBy { it.id }
        customEmoji.values.forEach { old -> if (drawnDiffers(old, fresh[old.id])) dropEmojiImage(old.id) }
        customEmoji.clear()
        rows.forEach { customEmoji[it.name] = it }
        emit()
    }

    fun applyCustomEmoji(row: CustomEmojiOut, deleted: Boolean) {
        val old = customEmoji[row.name]
        if (old != null && drawnDiffers(old, row.takeUnless { deleted || it.id != old.id })) dropEmojiImage(old.id)
        if (deleted) customEmoji.remove(row.name) else customEmoji[row.name] = row
        emit()
    }

    /**
     * Whether an emoji's cached image no longer shows [new] (null: it is gone): a text emoji's pill is drawn from its label
     * and colour, so a changed one is drawn again; a changed kind swaps pill and picture. An image emoji's picture is kept
     * by id while the app runs (docs/EMOJI.md).
     */
    private fun drawnDiffers(old: CustomEmojiOut, new: CustomEmojiOut?): Boolean =
        new == null || old.kind != new.kind || (old.isText && (old.label != new.label || old.color != new.color))

    private fun dropEmojiImage(id: String) {
        emojiImages.remove(id)
        emojiAnimations.remove(id)
    }

    // --- emoji packs (M100) --------------------------------------------------------------------

    fun replaceEmojiPacks(rows: List<jp.chikuwachat.android.api.EmojiPackOut>) {
        emojiPacks.clear()
        rows.forEach { emojiPacks[it.id] = it }
        emit()
    }

    /** emoji_pack.updated: a deleted pack's emoji become ungrouped (their emoji.updated come too). */
    fun applyEmojiPack(row: jp.chikuwachat.android.api.EmojiPackOut, deleted: Boolean) {
        if (deleted) {
            emojiPacks.remove(row.id)
            for ((name, emoji) in customEmoji.entries.toList()) if (emoji.packId == row.id) customEmoji[name] = emoji.copy(packId = null)
        } else emojiPacks[row.id] = row
        emit()
    }

    /** The packs in tab order (position, then name). */
    fun sortedEmojiPacks(): List<jp.chikuwachat.android.api.EmojiPackOut> =
        emojiPacks.values.sortedWith(compareBy({ it.position }, { it.name }))

    /** Drops the drawn text emoji pills (the app's light / dark look changed). */
    fun dropTextEmojiImages() {
        customEmoji.values.filter { it.isText }.forEach { emojiImages.remove(it.id) }
        emit()
    }

    fun setPackTab(key: String, image: ImageBitmap) {
        packTabImages[key] = image
        emit()
    }

    fun setEmojiImage(id: String, image: ImageBitmap, animation: jp.chikuwachat.android.ui.EmojiAnimation? = null) {
        emojiImages[id] = image
        if (animation != null) emojiAnimations[id] = animation
        emit()
    }

    // --- reminders (M12e) --------------------------------------------------------------------

    /** Fired first (newest nudge on top), then pending by time. */
    fun listReminders(): List<ReminderOut> =
        reminders.values.sortedWith(compareBy<ReminderOut> { if (it.status == "fired") 0 else 1 }.thenComparator { a, b ->
            if (a.status == "fired") b.remindAt.compareTo(a.remindAt) else a.remindAt.compareTo(b.remindAt)
        })

    fun firedReminderCount(): Int = reminders.values.count { it.status == "fired" }

    fun replaceReminders(rows: List<ReminderOut>) {
        reminders.clear()
        rows.filter { it.status == "pending" || it.status == "fired" }.forEach { reminders[it.id] = it }
        emit()
    }

    fun applyReminder(row: ReminderOut) {
        if (row.status == "pending" || row.status == "fired") reminders[row.id] = row else reminders.remove(row.id)
        emit()
    }

    // --- scheduled messages (M12d) -----------------------------------------------------------

    /** Failed rows first (they need the reader), then the pending ones by time. */
    fun listScheduled(): List<ScheduledOut> = scheduled.values.sortedWith(compareBy<ScheduledOut> { it.status != "failed" }.thenBy { it.sendAt })

    fun replaceScheduled(rows: List<ScheduledOut>) {
        scheduled.clear()
        rows.filter { it.kept }.forEach { scheduled[it.id] = it }
        emit()
    }

    /**
     * scheduled.updated: pending rows are kept, and failed ones too until dismissed (their text is only there, Codex
     * audit C3; SYNC_PROTOCOL.md §6); sent and cancelled rows drop.
     */
    fun applyScheduled(row: ScheduledOut) {
        if (row.kept) scheduled[row.id] = row else scheduled.remove(row.id)
        emit()
    }

    private val ScheduledOut.kept: Boolean get() = status == "pending" || status == "failed"

    // --- favorites (M12a) --------------------------------------------------------------------

    fun isFavorite(channelId: String): Boolean = channelId in favorites

    fun setFavorite(channelId: String, on: Boolean) {
        val changed = if (on) favorites.add(channelId) else favorites.remove(channelId)
        if (changed) emit()
    }

    fun replaceFavorites(ids: List<String>) {
        favorites.clear()
        favorites.addAll(ids)
        emit()
    }

    // --- pinned DMs (M118) ---------------------------------------------------------------------

    fun isDmPinned(channelId: String): Boolean = channelId in dmPins

    /** A new pin goes last (one already there keeps its place), as on the server. */
    fun setDmPin(channelId: String, on: Boolean) {
        val changed = if (on) (channelId !in dmPins && dmPins.add(channelId)) else dmPins.remove(channelId)
        if (changed) emit()
    }

    /** The pins as they were (a refused change put back in its place). */
    fun restoreDmPins(ids: List<String>) {
        if (dmPins == ids) return
        dmPins.clear()
        dmPins.addAll(ids)
        emit()
    }

    /** Bootstrap's `dm_pins`; null (a server before M118) = none, and pins unknown. */
    fun replaceDmPins(ids: List<String>?) {
        dmPinsKnown = ids != null
        dmPins.clear()
        dmPins.addAll(ids.orEmpty())
        emit()
    }

    // --- blocks (M104) ------------------------------------------------------------------------

    fun isBlocked(userId: String): Boolean = userId in blockedUsers

    fun setBlocked(userId: String, on: Boolean) {
        val changed = if (on) blockedUsers.add(userId) else blockedUsers.remove(userId)
        if (changed) emit()
    }

    fun replaceBlocked(ids: List<String>) {
        blockedUsers.clear()
        blockedUsers.addAll(ids)
        emit()
    }

    // --- bookmarks (M11c) --------------------------------------------------------------------

    fun isBookmarked(messageId: String): Boolean = messageId in bookmarks

    fun setBookmarked(messageId: String, on: Boolean) {
        val changed = if (on) bookmarks.add(messageId) else bookmarks.remove(messageId)
        if (changed) emit()
    }

    fun replaceBookmarks(ids: List<String>) {
        bookmarks.clear()
        bookmarks.addAll(ids)
        emit()
    }

    // --- presence / typing (volatile, SYNC_PROTOCOL.md §5.2) ---------------------------------

    fun presenceOf(userId: String): String = presence[userId] ?: "offline"

    fun setPresence(userId: String, status: String) {
        if (presenceOf(userId) == status) return
        if (status == "offline") presence.remove(userId) else presence[userId] = status
        emit()
    }

    /** bootstrap: the full picture; everyone not listed is offline. */
    fun replacePresence(entries: List<PresenceEntry>) {
        presence.clear()
        entries.filter { it.status != "offline" }.forEach { presence[it.userId] = it.status }
        emit()
    }

    private fun typingKey(channelId: String, parentId: String?) = if (parentId != null) "$channelId:$parentId" else channelId

    fun noteTyping(channelId: String, parentId: String?, userId: String, until: Long) {
        typing.getOrPut(typingKey(channelId, parentId)) { HashMap() }[userId] = until
        emit()
    }

    /** The user posted: their indicator goes away at once. */
    fun clearTyping(channelId: String, parentId: String?, userId: String) {
        if (typing[typingKey(channelId, parentId)]?.remove(userId) != null) emit()
    }

    /** M73: who edits which canvas (volatile `canvas_presence` frames, CANVAS.md §18.2). */
    private val canvasEditing = CanvasEditors()

    /** M73: a `canvas_presence` frame from someone else (true for 45 s unless refreshed, false ends it). */
    fun noteCanvasEditing(canvasId: String, userId: String, editing: Boolean, section: String?, now: Long = System.currentTimeMillis()) {
        if (canvasEditing.note(canvasId, userId, editing, section, now)) emit()
    }

    /** M73: who edits the canvas now (expired entries are skipped). */
    fun canvasEditors(canvasId: String, now: Long = System.currentTimeMillis()): List<CanvasEditor> = canvasEditing.of(canvasId, now)

    /** Users typing in this conversation right now (expired entries are skipped, not removed). */
    fun typingUsers(channelId: String, parentId: String?, now: Long = System.currentTimeMillis()): List<String> =
        typing[typingKey(channelId, parentId)]?.filterValues { it > now }?.keys?.sorted() ?: emptyList()

    /** The rows of the threads view: followed, newest reply first, unread only when that filter is on. */
    fun threadList(filter: String = threadsFilter): List<ThreadEntry> =
        threads.values.filter { it.state.following && (filter == "all" || it.state.unreadCount > 0) }
            .sortedWith(compareByDescending<ThreadEntry> { it.state.lastReplyAt ?: "" }.thenByDescending { it.parent.seq })

    /** The merge rule (SYNC_PROTOCOL.md §8): newer updated_seq wins; tombstones delete. */
    fun upsertMessage(message: MessageOut): Boolean = upsertMessage(MessageState.from(message))

    fun upsertMessage(message: MessageState): Boolean {
        // L8: the Times feed takes every confirmed row the store is given (not only live events), whatever the store keeps.
        onTimelineRow?.let { notify -> message.toOut()?.let { notify(message.channelId, TimelineEvent(TimelineEvent.SYNCED, it)) } }
        val bucket = bucket(message.channelId)
        message.clientMsgId?.let { key ->
            val placeholder = LOCAL_PREFIX + key
            if (bucket.remove(placeholder) != null) persist { it.deleteMessage(placeholder) }
        }
        val local = bucket[message.id]
        if (local != null && message.updatedSeq <= local.updatedSeq) {
            val merged = withMyVotes(local, message) ?: return false
            bucket[message.id] = merged
            persist { it.saveMessage(merged) }
            emit()
            return true
        }
        if (message.deleted) {
            bucket.remove(message.id)
            persist { it.deleteMessage(message.id) }
        } else {
            val stored = keepingMyVotes(message, local)
            bucket[message.id] = stored
            persist { it.saveMessage(stored) }
        }
        applyLastMessage(message, quiet = true) // M49: events, catch-up pages and my own edits / deletes alike
        emit()
        return true
    }

    /**
     * The response to my own vote, unvote or close (M27), or to my answers, decision or its undoing (M53): merged like any
     * row, then its own parts (`mine`, `my_answers`, `my_comment`) go in whatever the updated_seq order. Someone else's
     * event can overtake it (a newer row without them), and the plain rule would then drop the response and with it my
     * answers. The newer row's counts stay.
     */
    fun applyMyPollResponse(message: MessageOut) {
        upsertMessage(message)
        onTimelineRow?.invoke(message.channelId, TimelineEvent(TimelineEvent.MY_POLL, message))
        val response = message.poll ?: return
        val bucket = bucket(message.channelId)
        val stored = bucket[message.id] ?: return
        val poll = stored.poll ?: return
        val merged = MyPollPart.taken(poll, response) ?: return
        val updated = stored.copy(poll = merged)
        bucket[message.id] = updated
        persist { it.saveMessage(updated) }
        emit()
    }

    /**
     * §8 poll.mine (M27), my_answers / my_comment (M53): an event carries none of them (every member gets the same one),
     * so a newer row keeps what I was known to have answered; only a response to me says them again.
     */
    private fun keepingMyVotes(message: MessageState, local: MessageState?): MessageState {
        val poll = message.poll ?: return message
        val known = local?.poll ?: return message
        val kept = MyPollPart.keep(poll, known)
        return if (kept === poll) message else message.copy(poll = kept)
    }

    /**
     * §8 (M27, M53): the response to my vote or answers can arrive after its event (same updated_seq), which the plain
     * rule ignores as a duplicate; its own parts still go in. Null when there is nothing to take.
     */
    private fun withMyVotes(local: MessageState, message: MessageState): MessageState? {
        if (message.updatedSeq != local.updatedSeq) return null
        val response = message.poll ?: return null
        val poll = local.poll ?: return null
        return MyPollPart.taken(poll, response)?.let { local.copy(poll = it) }
    }

    fun putPlaceholder(message: MessageState) {
        bucket(message.channelId)[message.id] = message
        persist { it.saveMessage(message) }
        emit()
    }

    fun clearMessages(channelId: String) {
        messagesByChannel.remove(channelId)
        persist { it.clearMessages(channelId) }
        emit()
    }

    /**
     * §7.7: keeps the newest CACHED_MESSAGES_PER_CHANNEL rows of a channel nobody is looking at; true when rows were
     * dropped. The engine decides when (never for an open conversation or thread).
     */
    fun trimMessages(channelId: String): Boolean {
        if (!trimCache(channelId)) return false
        emit()
        return true
    }

    /**
     * Rows held for the channel, pending ones too (they are held rows; the desktop and iOS count the same, M28c): the
     * engine trims once they pass the cap by a margin. The trim itself drops rows with a seq only (§7.7).
     */
    fun heldCount(channelId: String): Int = messagesByChannel[channelId]?.size ?: 0

    /** Keeps the newest CACHED_MESSAGES_PER_CHANNEL rows with a seq; the loaded range then starts after the dropped ones. */
    private fun trimCache(channelId: String): Boolean {
        val bucket = messagesByChannel[channelId] ?: return false
        val confirmed = bucket.values.filter { it.seq != null }
        if (confirmed.size <= CACHED_MESSAGES_PER_CHANNEL) return false
        // Only from the old side: newer rows, once dropped, would not come back (the delta starts at the synced seq, §7.3).
        val dropped = confirmed.sortedByDescending { it.seq }.drop(CACHED_MESSAGES_PER_CHANNEL)
        val newestDropped = dropped.first().seq ?: return false
        dropped.forEach { bucket.remove(it.id) }
        val ids = dropped.map { it.id }
        persist { it.deleteMessages(ids) }
        val channel = channels[channelId]
        val oldest = channel?.oldestLoadedSeq
        if (channel != null && oldest != null && oldest <= newestDropped) {
            val trimmed = channel.copy(oldestLoadedSeq = newestDropped + 1, hasOlder = true)
            channels[channelId] = trimmed
            persist { it.saveChannel(trimmed) }
        }
        return true
    }

    // --- outbox -----------------------------------------------------------------------------

    fun addOutbox(item: OutboxItem) {
        outbox.add(item)
        persist { it.saveOutbox(item) }
        emit()
    }

    fun removeOutbox(clientMsgId: String) {
        outbox.removeAll { it.clientMsgId == clientMsgId }
        persist { it.deleteOutbox(clientMsgId) }
        emit()
    }

    fun markOutboxFailed(clientMsgId: String, reason: String?) {
        val index = outbox.indexOfFirst { it.clientMsgId == clientMsgId }
        if (index < 0) return
        val item = outbox[index].copy(failed = reason)
        outbox[index] = item
        val placeholderId = LOCAL_PREFIX + clientMsgId
        bucket(item.channelId)[placeholderId]?.let { placeholder ->
            val updated = placeholder.copy(failed = reason != null)
            bucket(item.channelId)[placeholderId] = updated
            persist { it.saveMessage(updated) }
        }
        persist { it.saveOutbox(item) }
        emit()
    }

    // --- snapshots (tests, diagnostics) -----------------------------------------------------

    fun snapshot(): Snapshot = Snapshot(
        meta = drafts.mapValues { Codec.plain.encodeToString(Draft.serializer(), it.value) } +
            (me?.let { mapOf("me" to Codec.plain.encodeToString(UserMe.serializer(), it)) } ?: emptyMap()),
        users = users.values.toList(),
        channels = channels.values.toList(),
        messages = messagesByChannel.values.flatMap { it.values },
        outbox = outbox.toList(),
    )

    companion object {
        fun fromSnapshot(snapshot: Snapshot, persistence: Persistence? = null): Store = Store(persistence).also { it.apply(snapshot) }
    }
}
