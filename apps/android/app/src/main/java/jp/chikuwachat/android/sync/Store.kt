package jp.chikuwachat.android.sync

import androidx.compose.ui.graphics.ImageBitmap
import jp.chikuwachat.android.api.CustomEmojiOut
import jp.chikuwachat.android.api.Limits
import jp.chikuwachat.android.api.PollOut
import jp.chikuwachat.android.platform.AvatarCache
import jp.chikuwachat.android.api.GroupOut
import jp.chikuwachat.android.api.SidebarSectionOut
import jp.chikuwachat.android.api.ReminderOut
import jp.chikuwachat.android.api.ScheduledOut
import jp.chikuwachat.android.api.AckOut
import jp.chikuwachat.android.api.AttachmentOut
import jp.chikuwachat.android.api.ChannelLinkOut
import jp.chikuwachat.android.api.ChannelOut
import jp.chikuwachat.android.api.Codec
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
) {
    fun reactedBy(userId: String, emoji: String): Boolean = reactions.any { it.emoji == emoji && userId in it.userIds }
    val isReply: Boolean get() = parentId != null
    /** The channel timeline shows top-level messages and replies also sent to the channel (M15c). */
    val inTimeline: Boolean get() = parentId == null || alsoInChannel

    companion object {
        fun from(message: MessageOut) = MessageState(
            id = message.id, channelId = message.channelId, senderId = message.senderId, seq = message.seq,
            updatedSeq = message.updatedSeq, clientMsgId = message.clientMsgId, body = message.body,
            createdAt = message.createdAt, editedAt = message.editedAt, deleted = message.deleted,
            reactions = message.reactions, mentionedUserIds = message.mentionedUserIds, mentionAll = message.mentionAll,
            parentId = message.parentId, alsoInChannel = message.alsoInChannel, replyCount = message.replyCount, lastReplyAt = message.lastReplyAt, attachments = message.attachments,
            pinnedAt = message.pinnedAt, pinnedBy = message.pinnedBy, poll = message.poll,
            priority = message.priority, ackRequested = message.ackRequested, acks = message.acks,
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
    fun loadAll(): Snapshot
    fun saveMeta(key: String, value: String?)
    fun saveUser(user: UserPublic)
    fun saveChannel(channel: ChannelState)
    fun deleteChannel(id: String)
    fun saveMessage(message: MessageState)
    fun deleteMessage(id: String)
    fun clearMessages(channelId: String)
    fun saveOutbox(item: OutboxItem)
    fun deleteOutbox(clientMsgId: String)
}

const val LOCAL_PREFIX = "local:"

/** The single source of truth for the UI (ARCHITECTURE.md §11). Mutated only from the engine's thread. */
/**
 * One row of the threads view (THREADS.md §5): the parent and my relation to the thread. Not persisted:
 * the badge comes with bootstrap and the list is fetched when the view opens.
 */
data class ThreadEntry(val parent: MessageOut, val state: ThreadState) {
    val id: String get() = parent.id
}

/** A confirmed local row in the server shape (thread rows built from the timeline). */
fun MessageState.toOut(): MessageOut? {
    val seq = seq ?: return null
    if (pending) return null
    return MessageOut(
        id = id, channelId = channelId, senderId = senderId, seq = seq, updatedSeq = updatedSeq, clientMsgId = clientMsgId,
        parentId = parentId, alsoInChannel = alsoInChannel, body = body, mentionedUserIds = mentionedUserIds, mentionAll = mentionAll, reactions = reactions,
        attachments = attachments, replyCount = replyCount, lastReplyAt = lastReplyAt, createdAt = createdAt, editedAt = editedAt, deleted = deleted,
        pinnedAt = pinnedAt, pinnedBy = pinnedBy, poll = poll, priority = priority, ackRequested = ackRequested, acks = acks,
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
    /** My pending scheduled messages (M12d); from GET /scheduled and scheduled.updated, not persisted. */
    val scheduled = LinkedHashMap<String, ScheduledOut>()
    /** My open reminders (M12e): fired ones wait for 完了, pending ones for their time. */
    val reminders = LinkedHashMap<String, ReminderOut>()
    /** Custom emoji by name (M12f); from bootstrap and emoji.updated. Images are cached by id once fetched. */
    val customEmoji = LinkedHashMap<String, CustomEmojiOut>()
    val emojiImages = HashMap<String, ImageBitmap>()
    /** User groups by id (M12k); from bootstrap and group.updated. `@name` expands on the server. */
    val groups = LinkedHashMap<String, GroupOut>()
    /** My sidebar sections (M14f), in order; from bootstrap and sidebar.updated. */
    var sidebarSections: List<SidebarSectionOut> = emptyList()
        private set
    /** bootstrap.limits (SYNC_PROTOCOL.md §4.1); null until the first bootstrap. */
    var limits: Limits? = null
        private set
    fun setLimits(value: Limits) {
        limits = value
    }
    /** M15f: link bars of the conversations opened so far (not persisted). */
    private val channelLinks = HashMap<String, List<ChannelLinkOut>>()
    fun setChannelLinks(channelId: String, links: List<ChannelLinkOut>) {
        channelLinks[channelId] = links
        emit()
    }
    fun linksOf(channelId: String): List<ChannelLinkOut> = channelLinks[channelId] ?: emptyList()
    private val drafts = LinkedHashMap<String, Draft>()
    private val uploads = HashMap<String, Int>()
    private fun draftKey(channelId: String, parentId: String?) = "draft:$channelId:${parentId ?: ""}"
    fun draft(channelId: String, parentId: String? = null) = drafts[draftKey(channelId, parentId)] ?: Draft()
    /** M15d: told about every local text change (the engine saves it on the server a moment later). */
    var onDraftEdited: ((channelId: String, parentId: String?) -> Unit)? = null

    fun setDraft(channelId: String, parentId: String? = null, mutate: (Draft) -> Draft) {
        val previous = draft(channelId, parentId)
        var value = mutate(previous)
        val edited = value.text != previous.text
        if (edited) value = value.copy(dirty = true)
        writeDraft(draftKey(channelId, parentId), value)
        if (edited) onDraftEdited?.invoke(channelId, parentId)
    }

    private fun writeDraft(key: String, value: Draft) {
        val keep = value.text.isNotEmpty() || value.attachments.isNotEmpty() || value.dirty
        if (keep) drafts[key] = value else drafts.remove(key)
        persist { it.saveMeta(key, drafts[key]?.let { d -> Codec.plain.encodeToString(Draft.serializer(), d) }) }
        emit()
    }

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
        val snapshot = runCatching { persistence?.loadAll() }.getOrNull() ?: return
        apply(snapshot)
        emit()
    }

    private fun apply(snapshot: Snapshot) {
        snapshot.meta.filterKeys { it.startsWith("draft:") }.forEach { (key, value) ->
            runCatching { Codec.plain.decodeFromString(Draft.serializer(), value) }.getOrNull()?.let { drafts[key] = it }
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

    /** Merge server fields into the local channel, keeping the local cursor. */
    fun upsertChannel(channel: ChannelOut, isMember: Boolean? = null): ChannelState {
        val existing = channels[channel.id]
        val read = channel.readState
        val merged = ChannelState(
            // channel.updated events carry no per-user preference, membership or count (M11h): keep the ones we know.
            channel = channel.copy(
                readState = null,
                notification = channel.notification ?: existing?.channel?.notification,
                membership = channel.membership ?: existing?.channel?.membership,
                memberCount = channel.memberCount ?: existing?.channel?.memberCount,
            ),
            isMember = isMember ?: existing?.isMember ?: (channel.membership != null),
            syncedSeq = existing?.syncedSeq,
            lastSeq = maxOf(existing?.lastSeq ?: 0, channel.lastSeq),
            // §10: the server's read state is the truth (no max merge): a position that only moved here stays
            // in unsentReadSeq and is sent again; kept locally it would leave an unread that cannot be read.
            lastReadSeq = read?.lastReadSeq ?: existing?.lastReadSeq ?: 0,
            unreadCount = read?.unreadCount ?: existing?.unreadCount ?: 0,
            mentionCount = read?.mentionCount ?: existing?.mentionCount ?: 0,
            hasOlder = existing?.hasOlder ?: true,
            oldestLoadedSeq = existing?.oldestLoadedSeq,
            unsentReadSeq = existing?.unsentReadSeq,
        )
        channels[channel.id] = merged
        persist { it.saveChannel(merged) }
        emit()
        return merged
    }

    fun setNotification(channelId: String, level: String, mutedUntil: String?) {
        updateChannel(channelId) { it.copy(channel = it.channel.copy(notification = NotificationPreferenceOut(channelId, level, mutedUntil))) }
    }

    fun updateChannel(id: String, mutate: (ChannelState) -> ChannelState): ChannelState? {
        val existing = channels[id] ?: return null
        val updated = mutate(existing)
        channels[id] = updated
        persist { it.saveChannel(updated) }
        emit()
        return updated
    }

    fun removeChannel(id: String) {
        channels.remove(id)
        messagesByChannel.remove(id)
        persist { it.clearMessages(id); it.deleteChannel(id) }
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

    /** Pinned messages held for the channel, loaded range or not (the pins pane re-reads when they change). */
    fun pinnedIds(channelId: String): List<String> = bucket(channelId).values.filter { it.pinnedAt != null && !it.pending }.map { it.id }.sorted()

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
        val parent = bucket(channelId)[thread.id] ?: return
        if (thread.updatedSeq <= parent.updatedSeq) return
        val updated = parent.copy(replyCount = thread.replyCount, lastReplyAt = thread.lastReplyAt, updatedSeq = thread.updatedSeq)
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

    /**
     * A page of GET /threads. Rows merge so an open thread keeps its state across filter changes and
     * refreshes; on a first page, rows the server would have listed but did not (unfollowed or deleted
     * elsewhere) are dropped.
     */
    fun setThreadPage(filter: String, items: List<ThreadItem>, cursor: String?, append: Boolean, pageSize: Int) {
        if (!append) {
            val listed = items.map { it.parent.id }.toSet()
            val oldest = if (items.size >= pageSize) items.last().state.lastReplyAt ?: "" else ""
            threads.entries.removeAll { (id, entry) ->
                id !in listed && entry.state.following &&
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

    // --- custom emoji (M12f) -----------------------------------------------------------------

    fun replaceCustomEmoji(rows: List<CustomEmojiOut>) {
        customEmoji.clear()
        rows.forEach { customEmoji[it.name] = it }
        emit()
    }

    fun applyCustomEmoji(row: CustomEmojiOut, deleted: Boolean) {
        if (deleted) customEmoji.remove(row.name) else customEmoji[row.name] = row
        emit()
    }

    fun setEmojiImage(id: String, image: ImageBitmap) {
        emojiImages[id] = image
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

    fun listScheduled(): List<ScheduledOut> = scheduled.values.sortedBy { it.sendAt }

    fun replaceScheduled(rows: List<ScheduledOut>) {
        scheduled.clear()
        rows.filter { it.status == "pending" }.forEach { scheduled[it.id] = it }
        emit()
    }

    /** scheduled.updated: a pending row is kept (created / edited); any other status drops it. */
    fun applyScheduled(row: ScheduledOut) {
        if (row.status == "pending") scheduled[row.id] = row else scheduled.remove(row.id)
        emit()
    }

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
        val bucket = bucket(message.channelId)
        message.clientMsgId?.let { key ->
            val placeholder = LOCAL_PREFIX + key
            if (bucket.remove(placeholder) != null) persist { it.deleteMessage(placeholder) }
        }
        val local = bucket[message.id]
        if (local != null && message.updatedSeq <= local.updatedSeq) return false
        if (message.deleted) {
            bucket.remove(message.id)
            persist { it.deleteMessage(message.id) }
        } else {
            bucket[message.id] = message
            persist { it.saveMessage(message) }
        }
        emit()
        return true
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
