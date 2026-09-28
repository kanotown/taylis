package jp.chikuwachat.android

import jp.chikuwachat.android.api.UserPublic
import jp.chikuwachat.android.sync.ChannelState
import jp.chikuwachat.android.sync.MessageState
import jp.chikuwachat.android.sync.OutboxItem
import jp.chikuwachat.android.sync.Persistence
import jp.chikuwachat.android.sync.Snapshot

/** The Room store's stand-in for tests: the same tables, in memory, written at once. */
class MemoryPersistence : Persistence {
    val meta = LinkedHashMap<String, String>()
    val users = LinkedHashMap<String, UserPublic>()
    val channels = LinkedHashMap<String, ChannelState>()
    val messages = LinkedHashMap<String, MessageState>()
    val outbox = LinkedHashMap<String, OutboxItem>()
    /** Makes loadMessages fail the way a table too big for memory does (AND-4). */
    var failMessages = false

    override fun loadAll(): Snapshot = Snapshot(meta.toMap(), users.values.toList(), channels.values.toList(), outbox = outbox.values.toList())
    override fun loadMessages(): List<MessageState> {
        if (failMessages) throw OutOfMemoryError("messages")
        return messages.values.toList()
    }
    override fun saveMeta(key: String, value: String?) { if (value == null) meta.remove(key) else meta[key] = value }
    override fun saveUser(user: UserPublic) { users[user.id] = user }
    override fun saveChannel(channel: ChannelState) { channels[channel.id] = channel }
    override fun deleteChannel(id: String) { channels.remove(id) }
    override fun saveMessage(message: MessageState) { messages[message.id] = message }
    override fun deleteMessage(id: String) { messages.remove(id) }
    override fun deleteMessages(ids: List<String>) { ids.forEach { messages.remove(it) } }
    override fun clearMessages(channelId: String) { messages.values.removeAll { it.channelId == channelId } }
    override fun saveOutbox(item: OutboxItem) { outbox[item.clientMsgId] = item }
    override fun deleteOutbox(clientMsgId: String) { outbox.remove(clientMsgId) }
}
