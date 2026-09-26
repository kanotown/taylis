package jp.chikuwachat.android.sync

import jp.chikuwachat.android.api.AttachmentOut
import jp.chikuwachat.android.api.ChannelOut
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.MessageOut
import jp.chikuwachat.android.api.NotificationPreferenceOut
import jp.chikuwachat.android.api.ParentThread
import jp.chikuwachat.android.api.ReactionOut
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
class Store(private val persistence: Persistence? = null) {
    var me: UserMe? = null
        private set
    val users = LinkedHashMap<String, UserPublic>()
    val channels = LinkedHashMap<String, ChannelState>()
    val outbox = ArrayList<OutboxItem>()
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
        meta = me?.let { mapOf("me" to Codec.plain.encodeToString(UserMe.serializer(), it)) } ?: emptyMap(),
        users = users.values.toList(),
        channels = channels.values.toList(),
        messages = messagesByChannel.values.flatMap { it.values },
        outbox = outbox.toList(),
    )

    companion object {
        fun fromSnapshot(snapshot: Snapshot, persistence: Persistence? = null): Store = Store(persistence).also { it.apply(snapshot) }
    }
}
