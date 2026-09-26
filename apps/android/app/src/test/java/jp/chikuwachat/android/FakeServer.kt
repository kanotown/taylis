package jp.chikuwachat.android

import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.BootstrapOut
import jp.chikuwachat.android.api.ChannelOut
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.DeltaOut
import jp.chikuwachat.android.api.HistoryOut
import jp.chikuwachat.android.api.Limits
import jp.chikuwachat.android.api.MembershipOut
import jp.chikuwachat.android.api.MessageOut
import jp.chikuwachat.android.api.UserMe
import jp.chikuwachat.android.api.UserPublic
import jp.chikuwachat.android.sync.CLOSE_SESSION_REVOKED
import jp.chikuwachat.android.sync.SyncApi
import jp.chikuwachat.android.sync.WsConnector
import jp.chikuwachat.android.sync.WsTransport
import kotlinx.coroutines.CompletableDeferred
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/** In-process model of the server side of SYNC_PROTOCOL.md (same behaviour as the other clients' fakes). */
class FakeServer {
    inner class Socket(val userId: String) : WsTransport {
        override var onMessage: ((String) -> Unit)? = null
        override var onClose: ((Int) -> Unit)? = null
        var dropNext = 0
        var closed = false

        override fun send(text: String) {
            val frame = Codec.plain.parseToJsonElement(text).jsonObject
            when (frame["type"]?.jsonPrimitive?.contentOrNull) {
                "auth" -> deliver(buildJsonObject { put("type", "hello"); put("session_id", "s-$userId"); put("server_time", now()); put("heartbeat_interval_sec", 30) })
                "ping" -> deliver(buildJsonObject { put("type", "pong"); put("server_time", now()) })
            }
        }

        override fun close() = closeRemote(1000)

        fun closeRemote(code: Int) {
            if (closed) return
            closed = true
            sockets.remove(this)
            onClose?.invoke(code)
        }

        fun deliver(frame: JsonObject) {
            if (closed) return
            if (frame["type"]?.jsonPrimitive?.contentOrNull == "event" && dropNext > 0) {
                dropNext -= 1 // simulated loss
                return
            }
            onMessage?.invoke(Codec.plain.encodeToString(JsonObject.serializer(), frame))
        }
    }

    inner class Api(val userId: String) : SyncApi {
        var pendingFailure: Throwable? = null
        /** When set, bootstrap() suspends until it completes (lets tests deliver events mid-bootstrap). */
        var bootstrapGate: CompletableDeferred<Unit>? = null

        private fun maybeFail() {
            pendingFailure?.let { pendingFailure = null; throw it }
        }

        override suspend fun bootstrap(): BootstrapOut {
            maybeFail()
            bootstrapGate?.let { gate -> bootstrapGate = null; gate.await() }
            return this@FakeServer.bootstrap(userId)
        }
        override suspend fun history(channelId: String, beforeSeq: Int?, limit: Int): HistoryOut { maybeFail(); return this@FakeServer.history(userId, channelId, beforeSeq, limit) }
        override suspend fun delta(channelId: String, sinceSeq: Int, limit: Int): DeltaOut { maybeFail(); return this@FakeServer.delta(userId, channelId, sinceSeq, limit) }
        override suspend fun postMessage(channelId: String, clientMsgId: String, body: String): Pair<MessageOut, Boolean> { maybeFail(); return post(channelId, userId, body, clientMsgId) }
        override suspend fun publicChannels(): List<ChannelOut> =
            channels.values.filter { it.channel.type == "public" && userId !in it.members }.map { it.channel.copy(membership = null) }
    }

    class ChannelRecord(var channel: ChannelOut, val members: MutableSet<String>, val messages: MutableList<MessageOut>)

    val users = LinkedHashMap<String, UserPublic>()
    val channels = LinkedHashMap<String, ChannelRecord>()
    val sockets = ArrayList<Socket>()
    var holdEvents = false
    private val held = ArrayList<Pair<Set<String>, JsonObject>>()
    private val byClientKey = HashMap<String, MessageOut>()
    private var counter = 0
    private var eventId = 0L

    fun nextId(): String = "00000000-0000-7000-8000-" + (++counter).toString().padStart(12, '0')
    private fun now(): String = java.time.Instant.now().toString()

    fun addUser(username: String, role: String = "member"): UserPublic {
        val user = UserPublic(nextId(), username, username.replaceFirstChar { it.uppercase() }, role, null, now(), now())
        users[user.id] = user
        return user
    }

    fun user(username: String): UserPublic = users.values.first { it.username == username }

    fun createChannel(name: String, ownerId: String, type: String = "public"): ChannelOut {
        val channel = ChannelOut(
            id = nextId(), type = type, name = if (type == "dm" || type == "group_dm") null else name, archived = false,
            createdBy = ownerId, lastSeq = 0, createdAt = now(), updatedAt = now(),
        )
        channels[channel.id] = ChannelRecord(channel, mutableSetOf(ownerId), ArrayList())
        return channel
    }

    fun join(channelId: String, userId: String) { channels[channelId]?.members?.add(userId) }

    private fun requireMember(channelId: String, userId: String): ChannelRecord {
        val record = channels[channelId] ?: throw ApiException.Api(404, "channel_not_found", "not found")
        if (userId !in record.members) throw ApiException.Api(403, "not_a_member", "not a member")
        return record
    }

    fun post(channelId: String, senderId: String, body: String, clientMsgId: String? = null): Pair<MessageOut, Boolean> {
        val record = requireMember(channelId, senderId)
        val key = clientMsgId ?: nextId()
        byClientKey["$senderId:$key"]?.let { existing ->
            if (existing.channelId != channelId) throw ApiException.Api(409, "idempotency_conflict", "conflict")
            return existing to false
        }
        val seq = record.channel.lastSeq + 1
        record.channel = record.channel.copy(lastSeq = seq, lastMessageAt = now())
        val message = MessageOut(nextId(), channelId, senderId, seq, seq, key, body, now(), null, false)
        record.messages.add(message)
        byClientKey["$senderId:$key"] = message
        emit(record.members, event("message.created", channelId, seq, buildJsonObject { put("message", Codec.snake.encodeToJsonElement(MessageOut.serializer(), message)) }))
        return message to true
    }

    private fun event(name: String, channelId: String?, seq: Int?, data: JsonObject): JsonObject = buildJsonObject {
        put("type", "event"); put("id", ++eventId); put("event", name); put("ts", now())
        put("channel_id", channelId?.let { JsonPrimitive(it) } ?: JsonNull)
        put("seq", seq?.let { JsonPrimitive(it) } ?: JsonNull)
        put("data", data)
    }

    private fun emit(userIds: Set<String>, frame: JsonObject) {
        if (holdEvents) { held.add(userIds.toSet() to frame); return }
        sockets.toList().filter { it.userId in userIds }.forEach { it.deliver(frame) }
    }

    fun release() {
        val pending = held.toList()
        held.clear()
        pending.forEach { (ids, frame) -> emit(ids, frame) }
    }

    /** What the real server emits after a join / add: member_added to the channel, channel.created to the user. */
    fun emitMembership(channelId: String, userId: String) {
        val record = channels[channelId] ?: return
        emit(record.members, event("channel.member_added", channelId, null, buildJsonObject { put("channel_id", channelId); put("user_id", userId) }))
        emit(setOf(userId), event("channel.created", channelId, null, buildJsonObject {
            put("channel", Codec.snake.encodeToJsonElement(ChannelOut.serializer(), record.channel.copy(membership = null)))
            put("member_ids", buildJsonArray { record.members.forEach { add(JsonPrimitive(it)) } })
        }))
    }

    fun revokeSession(userId: String) {
        sockets.toList().filter { it.userId == userId }.forEach { socket ->
            socket.deliver(event("session.revoked", null, null, buildJsonObject { put("reason", "logout") }))
            socket.closeRemote(CLOSE_SESSION_REVOKED)
        }
    }

    fun disconnect(userId: String, code: Int = 1006) = sockets.toList().filter { it.userId == userId }.forEach { it.closeRemote(code) }

    fun socketsOf(userId: String): List<Socket> = sockets.filter { it.userId == userId }

    fun bootstrap(userId: String): BootstrapOut {
        val user = users.getValue(userId)
        val me = UserMe(user.id, user.username, user.displayName, user.role, null, user.createdAt, user.updatedAt, null, false)
        val mine = channels.values.filter { userId in it.members }.map { record ->
            record.channel.copy(membership = MembershipOut(if (record.channel.createdBy == userId) "owner" else "member", now()))
        }
        return BootstrapOut(now(), me, users.values.toList(), mine, Limits(20000, 1, 10))
    }

    fun history(userId: String, channelId: String, beforeSeq: Int?, limit: Int): HistoryOut {
        val record = requireMember(channelId, userId)
        val channelLastSeq = record.channel.lastSeq // read BEFORE the rows (§4.3)
        var rows = record.messages.filter { !it.deleted }
        if (beforeSeq != null) rows = rows.filter { it.seq < beforeSeq }
        rows = rows.sortedByDescending { it.seq }
        return HistoryOut(channelLastSeq, rows.take(limit), rows.size > limit)
    }

    fun delta(userId: String, channelId: String, sinceSeq: Int, limit: Int): DeltaOut {
        val record = requireMember(channelId, userId)
        val channelLastSeq = record.channel.lastSeq
        val rows = record.messages.filter { it.updatedSeq > sinceSeq }.sortedBy { it.updatedSeq }
        val page = rows.take(limit)
        val hasMore = rows.size > limit
        return DeltaOut(page, if (hasMore) page.last().updatedSeq else maxOf(channelLastSeq, sinceSeq), hasMore)
    }

    fun api(userId: String): Api = Api(userId)

    fun connector(userId: String): WsConnector = { _, _ -> Socket(userId).also { sockets.add(it) } }
}
