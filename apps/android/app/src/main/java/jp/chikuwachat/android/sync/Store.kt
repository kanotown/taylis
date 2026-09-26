package jp.chikuwachat.android.sync

import jp.chikuwachat.android.api.AttachmentOut
import jp.chikuwachat.android.api.ChannelOut
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.MessageOut
import jp.chikuwachat.android.api.NotificationPreferenceOut
import jp.chikuwachat.android.api.ParentThread
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
) {
    val id: String get() = channel.id
    val hasUnread: Boolean get() = unreadCount > 0
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
    val replyCount: Int = 0,
    val lastReplyAt: String? = null,
    val attachments: List<AttachmentOut> = emptyList(),
) {
    fun reactedBy(userId: String, emoji: String): Boolean = reactions.any { it.emoji == emoji && userId in it.userIds }
    val isReply: Boolean get() = parentId != null

    companion object {
        fun from(message: MessageOut) = MessageState(
            id = message.id, channelId = message.channelId, senderId = message.senderId, seq = message.seq,
            updatedSeq = message.updatedSeq, clientMsgId = message.clientMsgId, body = message.body,
            createdAt = message.createdAt, editedAt = message.editedAt, deleted = message.deleted,
            reactions = message.reactions, mentionedUserIds = message.mentionedUserIds, mentionAll = message.mentionAll,
            parentId = message.parentId, replyCount = message.replyCount, lastReplyAt = message.lastReplyAt, attachments = message.attachments,
        )

        fun placeholder(clientMsgId: String, channelId: String, senderId: String, body: String, createdAt: String, parentId: String? = null) = MessageState(
            id = LOCAL_PREFIX + clientMsgId, channelId = channelId, senderId = senderId, seq = null, updatedSeq = -1,
            clientMsgId = clientMsgId, body = body, createdAt = createdAt, pending = true, parentId = parentId,
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
)

@Serializable
data class Draft(val text: String = "", val attachments: List<AttachmentOut> = emptyList())

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
        parentId = parentId, body = body, mentionedUserIds = mentionedUserIds, mentionAll = mentionAll, reactions = reactions,
        attachments = attachments, replyCount = replyCount, lastReplyAt = lastReplyAt, createdAt = createdAt, editedAt = editedAt, deleted = deleted,
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
    private val drafts = LinkedHashMap<String, Draft>()
    private val uploads = HashMap<String, Int>()
    private fun draftKey(channelId: String, parentId: String?) = "draft:$channelId:${parentId ?: ""}"
    fun draft(channelId: String, parentId: String? = null) = drafts[draftKey(channelId, parentId)] ?: Draft()
    fun setDraft(channelId: String, parentId: String? = null, mutate: (Draft) -> Draft) {
        val key = draftKey(channelId, parentId)
        val value = mutate(draft(channelId, parentId))
        if (value.text.isEmpty() && value.attachments.isEmpty()) drafts.remove(key) else drafts[key] = value
        persist { it.saveMeta(key, drafts[key]?.let { d -> Codec.plain.encodeToString(Draft.serializer(), d) }) }
        emit()
    }
    fun uploading(channelId: String, parentId: String? = null) = uploads[draftKey(channelId, parentId)] ?: 0
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
        snapshot.channels.forEach { channels[it.id] = it }
        snapshot.messages.forEach { bucket(it.channelId)[it.id] = it }
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
            // channel.updated events carry no per-user preference: keep the one we know.
            channel = channel.copy(readState = null, notification = channel.notification ?: existing?.channel?.notification),
            isMember = isMember ?: existing?.isMember ?: (channel.membership != null),
            syncedSeq = existing?.syncedSeq,
            lastSeq = maxOf(existing?.lastSeq ?: 0, channel.lastSeq),
            lastReadSeq = maxOf(existing?.lastReadSeq ?: 0, read?.lastReadSeq ?: 0),
            unreadCount = read?.unreadCount ?: existing?.unreadCount ?: 0,
            mentionCount = read?.mentionCount ?: existing?.mentionCount ?: 0,
            hasOlder = existing?.hasOlder ?: true,
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

    /** Top-level messages: confirmed by seq, then pending ones in creation order (SYNC_PROTOCOL.md §9). */
    fun messages(channelId: String): List<MessageState> = ordered(bucket(channelId).values.filter { !it.isReply })

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
