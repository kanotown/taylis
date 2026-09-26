package jp.chikuwachat.android.sync

import jp.chikuwachat.android.api.ChannelOut
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.MessageOut
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
    /** Local read marker until the server read state arrives in M8b. */
    val seenSeq: Int = 0,
    val hasOlder: Boolean = true,
) {
    val id: String get() = channel.id
    val hasUnread: Boolean get() = lastSeq > seenSeq
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
) {
    companion object {
        fun from(message: MessageOut) = MessageState(
            id = message.id, channelId = message.channelId, senderId = message.senderId, seq = message.seq,
            updatedSeq = message.updatedSeq, clientMsgId = message.clientMsgId, body = message.body,
            createdAt = message.createdAt, editedAt = message.editedAt, deleted = message.deleted,
        )

        fun placeholder(clientMsgId: String, channelId: String, senderId: String, body: String, createdAt: String) = MessageState(
            id = LOCAL_PREFIX + clientMsgId, channelId = channelId, senderId = senderId, seq = null, updatedSeq = -1,
            clientMsgId = clientMsgId, body = body, createdAt = createdAt, pending = true,
        )
    }
}

@Serializable
data class OutboxItem(val clientMsgId: String, val channelId: String, val body: String, val createdAt: String, val failed: String? = null)

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
        val merged = ChannelState(
            channel = channel,
            isMember = isMember ?: existing?.isMember ?: (channel.membership != null),
            syncedSeq = existing?.syncedSeq,
            lastSeq = maxOf(existing?.lastSeq ?: 0, channel.lastSeq),
            seenSeq = existing?.seenSeq ?: 0,
            hasOlder = existing?.hasOlder ?: true,
        )
        channels[channel.id] = merged
        persist { it.saveChannel(merged) }
        emit()
        return merged
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

    /** Confirmed messages by seq, then pending ones in creation order (SYNC_PROTOCOL.md §9). */
    fun messages(channelId: String): List<MessageState> {
        val all = bucket(channelId).values
        val confirmed = all.filter { it.seq != null }.sortedBy { it.seq }
        val pending = all.filter { it.seq == null }.sortedBy { it.createdAt }
        return confirmed + pending
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
