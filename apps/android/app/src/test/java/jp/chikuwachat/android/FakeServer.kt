package jp.chikuwachat.android

import jp.chikuwachat.android.api.CustomEmojiOut
import jp.chikuwachat.android.api.ReminderOut
import jp.chikuwachat.android.api.ScheduledOut
import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.ChannelReadStateOut
import jp.chikuwachat.android.api.AttachmentOut
import jp.chikuwachat.android.api.BootstrapOut
import jp.chikuwachat.android.api.ChannelOut
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.DraftOut
import jp.chikuwachat.android.api.DraftUpdated
import jp.chikuwachat.android.api.ChannelLinkOut
import jp.chikuwachat.android.sync.ChannelLinksApi
import jp.chikuwachat.android.sync.DraftApi
import jp.chikuwachat.android.sync.SendOptions
import jp.chikuwachat.android.api.DeltaOut
import jp.chikuwachat.android.api.HistoryOut
import jp.chikuwachat.android.api.LabProfileOut
import jp.chikuwachat.android.api.Limits
import jp.chikuwachat.android.api.MembershipOut
import jp.chikuwachat.android.api.MessageOut
import jp.chikuwachat.android.api.ParentThread
import jp.chikuwachat.android.api.PresenceEntry
import jp.chikuwachat.android.api.ReactionOut
import jp.chikuwachat.android.api.ReadStateOut
import jp.chikuwachat.android.api.ThreadItem
import jp.chikuwachat.android.api.ThreadListOut
import jp.chikuwachat.android.api.ThreadState
import jp.chikuwachat.android.api.ThreadSummary
import jp.chikuwachat.android.api.UserMe
import jp.chikuwachat.android.api.UserPublic
import jp.chikuwachat.android.sync.CLOSE_SESSION_REVOKED
import jp.chikuwachat.android.sync.SyncApi
import jp.chikuwachat.android.sync.WsConnector
import jp.chikuwachat.android.sync.WsTransport
import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.suspendCancellableCoroutine
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
    /** M12g notification keywords per user; like the server, hits never appear in mentionedUserIds. */
    val keywords = mutableMapOf<String, List<String>>()

    inner class Socket(val userId: String) : WsTransport {
        override var onMessage: ((String) -> Unit)? = null
        override var onClose: ((Int) -> Unit)? = null
        var dropNext = 0
        var closed = false
        /** A dead network path (§5.3): nothing the client sends arrives, nothing reaches the client. */
        var halfOpen = false
        var pings = 0
        /** The `active` of every ping this client sent. */
        val pingActive = ArrayList<Boolean>()

        var authed = false

        override fun send(text: String) {
            if (halfOpen) return
            val frame = Codec.plain.parseToJsonElement(text).jsonObject
            when (frame["type"]?.jsonPrimitive?.contentOrNull) {
                "auth" -> {
                    authed = true
                    deliver(buildJsonObject { put("type", "hello"); put("session_id", "s-$userId"); put("server_time", now()); put("heartbeat_interval_sec", 30) })
                    announcePresence(userId)
                    if (dropAfterHello > 0) {
                        dropAfterHello -= 1
                        closeRemote(1006)
                    }
                }
                "ping" -> {
                    pings += 1
                    pingActive.add(frame["active"]?.jsonPrimitive?.contentOrNull == "true")
                    if (frame["active"]?.jsonPrimitive?.contentOrNull == "true") markActive(userId)
                    deliver(buildJsonObject { put("type", "pong"); put("server_time", now()) })
                }
                "typing" -> frame["channel_id"]?.jsonPrimitive?.contentOrNull?.let { relayTyping(userId, it, frame["parent_id"]?.jsonPrimitive?.contentOrNull) }
            }
        }

        override fun close() = closeRemote(1000)

        fun closeRemote(code: Int) {
            if (closed) return
            closed = true
            sockets.remove(this)
            onClose?.invoke(code)
            if (authed) announcePresence(userId)
        }

        fun deliver(frame: JsonObject) {
            if (closed || halfOpen) return
            if (frame["type"]?.jsonPrimitive?.contentOrNull == "event" && dropNext > 0) {
                dropNext -= 1 // simulated loss
                return
            }
            onMessage?.invoke(Codec.plain.encodeToString(JsonObject.serializer(), frame))
        }
    }

    inner class Api(val userId: String) : SyncApi, DraftApi, ChannelLinksApi {
        override suspend fun channelLinks(channelId: String): List<ChannelLinkOut> { maybeFail(); requireMember(channelId, userId); return links[channelId] ?: emptyList() }
        override suspend fun saveDraft(channelId: String, parentId: String?, body: String): DraftOut { maybeFail(); return this@FakeServer.saveDraft(userId, channelId, parentId, body) }
        override suspend fun deleteDraft(channelId: String, parentId: String?) { maybeFail(); this@FakeServer.deleteDraft(userId, channelId, parentId) }

        var pendingFailure: Throwable? = null
        /** When set, bootstrap() suspends until it completes (lets tests deliver events mid-bootstrap). */
        var bootstrapGate: CompletableDeferred<Unit>? = null
        /** Failures for the next POST /messages calls only, in order. */
        val postFailures = ArrayDeque<Throwable>()
        /** When set, the next POST /messages waits for it (a send still in flight). */
        var postGate: CompletableDeferred<Unit>? = null
        /** When set, the next POST /messages is stored at once but its response waits for it (its events and later ones overtake it). */
        var postResponseGate: CompletableDeferred<Unit>? = null
        /** When set, the next GET /sync waits for it (a catch-up still on its way, §10.1). */
        var deltaGate: CompletableDeferred<Unit>? = null
        /** When set, the next GET history waits for it (a 「以前を読み込む」 page still on its way, §7.7). */
        var historyGate: CompletableDeferred<Unit>? = null
        /** When set, the next PUT thread read waits for it (a thread read still in flight, §10.2). */
        var threadReadGate: CompletableDeferred<Unit>? = null
        /** Requests made, for tests that count them: GET history (before_seq, limit), PUT read (advance, set), PUT thread read. */
        val historyCalls = ArrayList<Pair<Int?, Int>>()
        val readCalls = ArrayList<Int>()
        val setCalls = ArrayList<Int>()
        val threadReadCalls = ArrayList<Int>()

        private fun maybeFail() {
            pendingFailure?.let { pendingFailure = null; throw it }
        }

        override suspend fun bootstrap(): BootstrapOut {
            maybeFail()
            bootstrapGate?.let { gate -> bootstrapGate = null; gate.await() }
            return this@FakeServer.bootstrap(userId)
        }
        override suspend fun history(channelId: String, beforeSeq: Int?, limit: Int): HistoryOut {
            maybeFail()
            historyCalls.add(beforeSeq to limit)
            historyGate?.let { gate -> historyGate = null; gate.await() }
            return this@FakeServer.history(userId, channelId, beforeSeq, limit)
        }
        override suspend fun delta(channelId: String, sinceSeq: Int, limit: Int): DeltaOut {
            maybeFail()
            deltaGate?.let { gate -> deltaGate = null; gate.await() }
            return this@FakeServer.delta(userId, channelId, sinceSeq, limit)
        }
        override suspend fun postMessage(
            channelId: String, clientMsgId: String, body: String, parentId: String?, attachmentIds: List<String>, options: SendOptions,
        ): Pair<MessageOut, Boolean> {
            maybeFail()
            postFailures.removeFirstOrNull()?.let { throw it }
            postGate?.let { gate -> postGate = null; gate.await() }
            val stored = post(channelId, userId, body, clientMsgId, parentId, attachmentIds, options)
            postResponseGate?.let { gate -> postResponseGate = null; gate.await() }
            return stored
        }
        override suspend fun replies(messageId: String): List<MessageOut> {
            maybeFail()
            val record = channels.values.first { r -> r.messages.any { it.id == messageId } }
            requireMember(record.channel.id, userId)
            return record.messages.filter { it.parentId == messageId && !it.deleted }.sortedBy { it.seq }
        }
        override suspend fun markRead(channelId: String, lastReadSeq: Int): ReadStateOut {
            maybeFail()
            readCalls.add(lastReadSeq)
            return this@FakeServer.markRead(userId, channelId, lastReadSeq)
        }
        override suspend fun readAll(): List<ChannelReadStateOut> { maybeFail(); return this@FakeServer.readAll(userId) }
        override suspend fun listScheduled(): List<ScheduledOut> { maybeFail(); return scheduled[userId]?.toList() ?: emptyList() }
        override suspend fun listReminders(): List<ReminderOut> { maybeFail(); return reminders[userId]?.toList() ?: emptyList() }
        override suspend fun setReadPosition(channelId: String, lastReadSeq: Int): ReadStateOut {
            maybeFail()
            setCalls.add(lastReadSeq)
            return this@FakeServer.markRead(userId, channelId, lastReadSeq, mode = "set")
        }
        override suspend fun publicChannels(): List<ChannelOut> =
            channels.values.filter { it.channel.type == "public" && userId !in it.members }.map { it.channel.copy(membership = null, memberCount = it.members.size) }
        override suspend fun threads(filter: String, cursor: String?, limit: Int): ThreadListOut { maybeFail(); return this@FakeServer.threads(userId, filter, cursor, limit) }
        override suspend fun threadState(messageId: String): ThreadState { maybeFail(); return this@FakeServer.threadState(userId, messageId) }
        override suspend fun markThreadRead(messageId: String, lastReadSeq: Int): ThreadState {
            maybeFail()
            threadReadCalls.add(lastReadSeq)
            threadReadGate?.let { gate -> threadReadGate = null; gate.await() }
            return this@FakeServer.markThreadRead(userId, messageId, lastReadSeq)
        }
        override suspend fun setThreadFollow(messageId: String, following: Boolean): ThreadState { maybeFail(); return this@FakeServer.setThreadFollow(userId, messageId, following) }
    }

    class ChannelRecord(var channel: ChannelOut, val members: MutableSet<String>, val messages: MutableList<MessageOut>)

    val users = LinkedHashMap<String, UserPublic>()
    val channels = LinkedHashMap<String, ChannelRecord>()
    /** "user:channel" → last_read_seq (DATA_MODEL.md read_states). */
    val readPositions = HashMap<String, Int>()
    val sockets = ArrayList<Socket>()
    /** The next N sockets close right after hello (before the client has bootstrapped). */
    var dropAfterHello = 0
    var holdEvents = false
    private val held = ArrayList<Pair<Set<String>, JsonObject>>()
    private val byClientKey = HashMap<String, MessageOut>()
    private var counter = 0
    private var eventId = 0L

    fun nextId(): String = "00000000-0000-7000-8000-" + (++counter).toString().padStart(12, '0')
    private val clockFormat = java.time.format.DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSSSSS'Z'").withZone(java.time.ZoneOffset.UTC)
    private var clock: java.time.Instant = java.time.Instant.now()
    /** Strictly increasing and fixed width, so timestamp cursors (threads) never tie and sort as strings. */
    private fun now(): String {
        clock = clock.plusMillis(1)
        return clockFormat.format(clock)
    }

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
        readPositions["$ownerId:${channel.id}"] = 0
        return channel
    }

    fun join(channelId: String, userId: String) {
        val record = channels[channelId] ?: return
        record.members.add(userId)
        readPositions.putIfAbsent("$userId:$channelId", record.channel.lastSeq) // history before the join is read
    }

    fun readState(userId: String, channelId: String): ReadStateOut {
        val record = channels.getValue(channelId)
        val position = readPositions["$userId:$channelId"] ?: 0
        // My own posts are never unread (the server excludes them, like replies not sent to the channel and system rows).
        val unread = record.messages.filter {
            it.seq > position && !it.deleted && (it.parentId == null || it.alsoInChannel) && it.senderId != userId && it.type == "user"
        }
        return ReadStateOut(position, unread.size, unread.count { it.mentions(userId) }, unread.minByOrNull { it.seq }?.createdAt)
    }

    /** PUT /channels/{id}/read: clamp, never regress, read.updated to the user's own sockets on change. */
    fun markRead(userId: String, channelId: String, seq: Int, mode: String = "advance"): ReadStateOut {
        val record = requireMember(channelId, userId)
        val key = "$userId:$channelId"
        val target = minOf(seq, record.channel.lastSeq)
        val current = readPositions[key] ?: 0
        if (if (mode == "set") target != current else target > current) {
            readPositions[key] = target
            val state = readState(userId, channelId)
            emit(setOf(userId), event("read.updated", channelId, null, buildJsonObject { put("reason", mode)
                put("channel_id", channelId); put("last_read_seq", state.lastReadSeq); put("unread_count", state.unreadCount); put("mention_count", state.mentionCount)
                put("first_unread_at", state.firstUnreadAt?.let { JsonPrimitive(it) } ?: JsonNull)
            }))
            return state
        }
        return readState(userId, channelId)
    }

    // --- pins and bookmarks (M11c) --------------------------------------------------------------------

    /** PUT / DELETE /messages/{id}/pin: any member; a change consumes a seq (message.updated change=pin). */
    fun pin(channelId: String, userId: String, messageId: String, pinned: Boolean): MessageOut {
        val (record, message) = live(channelId, userId, messageId)
        if ((message.pinnedAt != null) == pinned) return message
        val seq = record.channel.lastSeq + 1
        record.channel = record.channel.copy(lastSeq = seq)
        val updated = message.copy(updatedSeq = seq, pinnedAt = if (pinned) now() else null, pinnedBy = if (pinned) userId else null)
        replace(record, updated, "message.updated", "pin")
        return updated
    }

    /** user → saved message ids, newest first. */
    val bookmarks = HashMap<String, MutableList<String>>()
    /** Custom emoji by name (M12f); everyone gets emoji.updated. */
    val customEmoji = LinkedHashMap<String, CustomEmojiOut>()

    fun addEmoji(name: String, userId: String): CustomEmojiOut {
        val row = CustomEmojiOut(id = "emoji-${++eventId}", name = name, contentType = "image/png", width = 32, height = 32, createdBy = userId, createdAt = now())
        customEmoji[name] = row
        return row
    }

    fun emitEmoji(row: CustomEmojiOut, deleted: Boolean) {
        if (deleted) customEmoji.remove(row.name) else customEmoji[row.name] = row
        emit(users.keys.toSet(), event("emoji.updated", null, null, buildJsonObject { put("emoji", Codec.snake.encodeToJsonElement(CustomEmojiOut.serializer(), row)); put("deleted", deleted) }))
    }

    /** M23: the lab roster by user id (bootstrap `roster`, roster.updated to everyone). */
    val roster = LinkedHashMap<String, LabProfileOut>()

    fun setRosterLine(userId: String, profile: LabProfileOut?) {
        if (profile != null) roster[userId] = profile else roster.remove(userId)
        emit(users.keys.toSet(), event("roster.updated", null, null, buildJsonObject {
            put("user_id", userId)
            put("profile", profile?.let { Codec.snake.encodeToJsonElement(LabProfileOut.serializer(), it) } ?: JsonNull)
        }))
    }

    /** "user" → open reminders (M12e). */
    val reminders = HashMap<String, MutableList<ReminderOut>>()

    fun remind(userId: String, channelId: String, messageId: String, remindAt: String, note: String? = null): ReminderOut {
        val row = ReminderOut(id = "rem-${++eventId}", messageId = messageId, channelId = channelId, note = note, preview = "preview", remindAt = remindAt, status = "pending", createdAt = now())
        reminders.getOrPut(userId) { ArrayList() }.add(row)
        return row
    }

    fun emitReminder(userId: String, row: ReminderOut) {
        val list = reminders.getOrPut(userId) { ArrayList() }
        list.removeAll { it.id == row.id }
        if (row.status == "pending" || row.status == "fired") list.add(row)
        emit(setOf(userId), event("reminder.updated", row.channelId, null, buildJsonObject { put("reminder", Codec.snake.encodeToJsonElement(ReminderOut.serializer(), row)) }))
    }

    /** "user" → pending scheduled messages (M12d). */
    val scheduled = HashMap<String, MutableList<ScheduledOut>>()

    fun schedule(userId: String, channelId: String, body: String, sendAt: String): ScheduledOut {
        val row = ScheduledOut(id = "sch-${++eventId}", channelId = channelId, clientMsgId = "c-$eventId", body = body, sendAt = sendAt, status = "pending", createdAt = now())
        scheduled.getOrPut(userId) { ArrayList() }.add(row)
        return row
    }

    fun emitScheduled(userId: String, row: ScheduledOut) {
        val list = scheduled.getOrPut(userId) { ArrayList() }
        list.removeAll { it.id == row.id }
        if (row.status == "pending") list.add(row)
        emit(setOf(userId), event("scheduled.updated", row.channelId, null, buildJsonObject { put("scheduled", Codec.snake.encodeToJsonElement(ScheduledOut.serializer(), row)) }))
    }

    /** "user" → starred channel ids (M12a). */
    val favorites = HashMap<String, MutableList<String>>()
    /** M15f: each conversation's link bar; setLinks announces it like the server does. */
    val links = HashMap<String, List<ChannelLinkOut>>()

    fun setLinks(channelId: String, titles: List<String>) {
        val record = channels[channelId] ?: return
        val rows = titles.mapIndexed { index, title -> ChannelLinkOut("link-$channelId-$title", title, "https://example.com/$index", index, record.channel.createdBy ?: "", now()) }
        links[channelId] = rows
        emit(record.members, event("channel.links_updated", channelId, null, buildJsonObject {
            put("channel_id", channelId)
            put("links", Codec.snake.encodeToJsonElement(kotlinx.serialization.builtins.ListSerializer(ChannelLinkOut.serializer()), rows))
        }))
    }

    /** M15d: "user:channel:parent" → the saved draft. */
    val drafts = LinkedHashMap<String, DraftOut>()

    fun saveDraft(userId: String, channelId: String, parentId: String?, body: String): DraftOut {
        requireMember(channelId, userId)
        val draft = DraftOut(channelId, parentId, body, now())
        drafts["$userId:$channelId:${parentId ?: ""}"] = draft
        emit(setOf(userId), event("draft.updated", null, null, Codec.snake.encodeToJsonElement(DraftUpdated.serializer(), DraftUpdated(channelId, parentId, body, draft.updatedAt, false)) as JsonObject))
        return draft
    }

    fun deleteDraft(userId: String, channelId: String, parentId: String?) {
        drafts.remove("$userId:$channelId:${parentId ?: ""}") ?: return
        emit(setOf(userId), event("draft.updated", null, null, Codec.snake.encodeToJsonElement(DraftUpdated.serializer(), DraftUpdated(channelId, parentId, "", now(), true)) as JsonObject))
    }

    fun draftsOf(userId: String): List<DraftOut> = drafts.filterKeys { it.startsWith("$userId:") }.values.toList()

    fun setFavorite(userId: String, channelId: String, on: Boolean) {
        val list = favorites.getOrPut(userId) { ArrayList() }
        if (on == (channelId in list)) return
        if (on) list.add(channelId) else list.remove(channelId)
        emit(setOf(userId), event("favorite.updated", channelId, null, buildJsonObject { put("channel_id", channelId); put("favorite", on) }))
    }

    /** POST /channels/read-all: every membership read to its end; read.updated per moved channel. */
    fun readAll(userId: String): List<ChannelReadStateOut> =
        channels.values.filter { userId in it.members }.map { record ->
            val state = markRead(userId, record.channel.id, record.channel.lastSeq)
            ChannelReadStateOut(record.channel.id, state.lastReadSeq, state.unreadCount, state.mentionCount, state.firstUnreadAt)
        }

    fun setBookmark(userId: String, messageId: String, on: Boolean) {
        val list = bookmarks.getOrPut(userId) { ArrayList() }
        if (on == (messageId in list)) return
        if (on) list.add(0, messageId) else list.remove(messageId)
        val channelId = channels.values.firstOrNull { r -> r.messages.any { it.id == messageId } }?.channel?.id
        emit(setOf(userId), event("bookmark.updated", channelId, null, buildJsonObject { put("message_id", messageId); put("channel_id", channelId); put("bookmarked", on) }))
    }

    // --- presence / typing (SYNC_PROTOCOL.md §5.2, volatile) --------------------------------------

    /** Users whose window is "away" (set by tests); everyone connected is online otherwise. */
    val awayUsers = HashSet<String>()
    private val announced = HashMap<String, String>()

    fun presenceOf(userId: String): String {
        if (sockets.none { it.userId == userId && it.authed }) return "offline"
        return if (userId in awayUsers) "away" else "online"
    }

    fun markActive(userId: String) {
        if (awayUsers.remove(userId)) announcePresence(userId)
    }

    /** Broadcast a presence frame when the user's status changed. */
    fun announcePresence(userId: String) {
        val status = presenceOf(userId)
        if ((announced[userId] ?: "offline") == status) return
        if (status == "offline") announced.remove(userId) else announced[userId] = status
        sockets.toList().filter { it.authed }.forEach { it.deliver(buildJsonObject { put("type", "presence"); put("user_id", userId); put("status", status) }) }
    }

    fun relayTyping(userId: String, channelId: String, parentId: String?) {
        val record = channels[channelId] ?: return
        if (userId !in record.members) return
        sockets.toList().filter { it.authed && it.userId != userId && it.userId in record.members }.forEach {
            it.deliver(buildJsonObject { put("type", "typing"); put("channel_id", channelId); put("parent_id", parentId?.let { p -> JsonPrimitive(p) } ?: JsonNull); put("user_id", userId) })
        }
    }

    // --- threads (THREADS.md §2) ------------------------------------------------------------------

    /** `unfollowed`: turned off by hand (auto-follow keeps it off); a row with neither only records a read position. */
    class ThreadFollow(val parentId: String, val userId: String, var following: Boolean, var lastReadSeq: Int, val order: Int, var unfollowed: Boolean = false)

    /** "parent:user" → follow row; `order` doubles as created_at. */
    val threadFollows = LinkedHashMap<String, ThreadFollow>()
    private var followOrder = 0

    private fun followers(parentId: String): List<String> =
        threadFollows.values.filter { it.parentId == parentId && it.following }.sortedBy { it.order }.map { it.userId }

    private fun autoFollow(parentId: String, userIds: List<String>) {
        userIds.forEach { userId ->
            val row = threadFollows.getOrPut("$parentId:$userId") { ThreadFollow(parentId, userId, true, 0, ++followOrder) }
            if (!row.following && !row.unfollowed) row.following = true // only read so far: now followed
        }
    }

    private fun threadParent(messageId: String): Pair<ChannelRecord, MessageOut> {
        for (record in channels.values) {
            val message = record.messages.firstOrNull { it.id == messageId && !it.deleted } ?: continue
            val parent = message.parentId?.let { pid -> record.messages.first { it.id == pid } } ?: message
            return record to parent
        }
        throw ApiException.Api(404, "message_not_found", "not found")
    }

    fun threadState(userId: String, parentId: String): ThreadState {
        val (record, parent) = threadParent(parentId)
        requireMember(record.channel.id, userId)
        val row = threadFollows["${parent.id}:$userId"]
        val lastRead = row?.lastReadSeq ?: 0
        val unread = record.messages.filter { it.parentId == parent.id && !it.deleted && it.seq > lastRead && it.senderId != userId }
        return ThreadState(
            parent.id, record.channel.id, row?.following ?: false, lastRead, unread.size, unread.count { it.mentions(userId) },
            parent.replyCount, parent.lastReplyAt, followers(parent.id),
        )
    }

    private fun emitThread(parentId: String, userIds: List<String>, reason: String) {
        userIds.forEach { userId ->
            val state = runCatching { threadState(userId, parentId) }.getOrNull() ?: return@forEach
            val data = buildJsonObject {
                Codec.snake.encodeToJsonElement(ThreadState.serializer(), state).jsonObject.forEach { (k, v) -> put(k, v) }
                put("reason", reason)
            }
            emit(setOf(userId), event("thread.updated", state.channelId, null, data))
        }
    }

    fun threadSummary(userId: String): ThreadSummary {
        val states = threadFollows.values.filter { it.userId == userId && it.following }.mapNotNull { runCatching { threadState(userId, it.parentId) }.getOrNull() }
        return ThreadSummary(states.count { it.unreadCount > 0 }, states.count { it.mentionCount > 0 })
    }

    fun threads(userId: String, filter: String, cursor: String?, limit: Int): ThreadListOut {
        var items = threadFollows.values.filter { it.userId == userId && it.following }.mapNotNull { row ->
            val (_, parent) = runCatching { threadParent(row.parentId) }.getOrNull() ?: return@mapNotNull null
            if (parent.deleted || parent.replyCount == 0) return@mapNotNull null
            ThreadItem(parent, threadState(userId, row.parentId))
        }.sortedWith(compareByDescending<ThreadItem> { it.parent.lastReplyAt ?: "" }.thenByDescending { it.parent.seq })
        if (cursor != null) items = items.filter { (it.parent.lastReplyAt ?: "") < cursor }
        if (filter == "unread") items = items.filter { it.state.unreadCount > 0 }
        items = items.take(limit)
        return ThreadListOut(items, items.lastOrNull()?.parent?.lastReplyAt, threadSummary(userId))
    }

    /** Reading is not following: a thread without a row gets one that only records the position. */
    fun markThreadRead(userId: String, messageId: String, seq: Int): ThreadState {
        val (record, parent) = threadParent(messageId)
        requireMember(record.channel.id, userId)
        val newest = record.messages.filter { it.parentId == parent.id && !it.deleted }.maxOfOrNull { it.seq } ?: 0
        val target = minOf(seq, newest)
        val row = threadFollows.getOrPut("${parent.id}:$userId") { ThreadFollow(parent.id, userId, false, 0, ++followOrder) }
        if (target > row.lastReadSeq) {
            row.lastReadSeq = target
            emitThread(parent.id, listOf(userId), "read")
        }
        return threadState(userId, parent.id)
    }

    fun setThreadFollow(userId: String, messageId: String, following: Boolean): ThreadState {
        val (record, parent) = threadParent(messageId)
        requireMember(record.channel.id, userId)
        val key = "${parent.id}:$userId"
        val changed = threadFollows[key]?.following != following
        val row = threadFollows.getOrPut(key) { ThreadFollow(parent.id, userId, following, 0, ++followOrder) }
        row.following = following
        row.unfollowed = !following
        if (changed) emitThread(parent.id, listOf(userId), "follow")
        return threadState(userId, parent.id)
    }

    private fun requireMember(channelId: String, userId: String): ChannelRecord {
        val record = channels[channelId] ?: throw ApiException.Api(404, "channel_not_found", "not found")
        if (userId !in record.members) throw ApiException.Api(403, "not_a_member", "not a member")
        return record
    }

    /**
     * `type` other than "user" is a system row: in the timeline, never unread (the server's reads.counts rule).
     * `scheduled`: a scheduled send going out (M12d), which does not read the channel for its sender.
     */
    fun post(
        channelId: String, senderId: String, body: String, clientMsgId: String? = null, parentId: String? = null, attachmentIds: List<String> = emptyList(),
        options: SendOptions = SendOptions(), type: String = "user", scheduled: Boolean = false,
    ): Pair<MessageOut, Boolean> {
        val record = requireMember(channelId, senderId)
        val key = clientMsgId ?: nextId()
        byClientKey["$senderId:$key"]?.let { existing ->
            if (existing.channelId != channelId) throw ApiException.Api(409, "idempotency_conflict", "conflict")
            return existing to false
        }
        val parentIndex = parentId?.let { pid -> record.messages.indexOfFirst { it.id == pid && !it.deleted } }
        if (parentId != null && (parentIndex == null || parentIndex < 0)) throw ApiException.Api(404, "message_not_found", "parent not found")
        if (parentIndex != null && record.messages[parentIndex].parentId != null) throw ApiException.Api(400, "reply_depth", "no replies to replies")
        val seq = record.channel.lastSeq + 1
        record.channel = record.channel.copy(lastSeq = seq, lastMessageAt = now())
        val mentioned = Regex("<@([0-9a-f-]{36})>").findAll(body).map { it.groupValues[1] }.distinct().toList()
        val message = MessageOut(
            id = nextId(), channelId = channelId, senderId = senderId, parentId = parentId, alsoInChannel = options.alsoInChannel && parentId != null,
            priority = if (parentId == null) options.priority else null, ackRequested = parentId == null && options.ackRequested,
            seq = seq, updatedSeq = seq, clientMsgId = key, body = body, type = type,
            mentionedUserIds = mentioned, mentionAll = Regex("<!(channel|here)>").containsMatchIn(body), createdAt = now(), deleted = false,
            attachments = attachmentIds.map { AttachmentOut(it, "file-$it", "application/octet-stream", 1, status = "attached", createdAt = now()) },
        )
        record.messages.add(message)
        byClientKey["$senderId:$key"] = message
        var thread: ParentThread? = null
        if (parentIndex != null) {
            val parent = record.messages[parentIndex].let { it.copy(replyCount = it.replyCount + 1, lastReplyAt = message.createdAt, updatedSeq = seq) }
            record.messages[parentIndex] = parent
            // THREADS.md §2: auto-follow, the replier has read their own reply, followers are the push targets.
            autoFollow(parent.id, listOf(parent.senderId, senderId) + parent.mentionedUserIds + message.mentionedUserIds)
            threadFollows.getValue("${parent.id}:$senderId").let { it.lastReadSeq = maxOf(it.lastReadSeq, seq) }
            thread = ParentThread(parent.id, parent.replyCount, parent.lastReplyAt, seq, followers(parent.id))
        }
        emit(record.members, event("message.created", channelId, seq, buildJsonObject {
            put("message", Codec.snake.encodeToJsonElement(MessageOut.serializer(), message))
            if (thread != null) put("parent_thread", Codec.snake.encodeToJsonElement(ParentThread.serializer(), thread))
        }))
        // §10: a top-level post reads the channel for its sender; a thread reply moves only the thread's position.
        if (parentId == null && !scheduled) markRead(senderId, channelId, seq)
        if (thread != null) emitThread(thread.id, followers(thread.id), "reply")
        return message to true
    }

    fun messageByBody(channelId: String, body: String): MessageOut =
        channels.getValue(channelId).messages.first { it.body == body && !it.deleted }

    private fun replace(record: ChannelRecord, updated: MessageOut, event: String, change: String? = null) {
        val index = record.messages.indexOfFirst { it.id == updated.id }
        record.messages[index] = updated
        emit(record.members, event(event, updated.channelId, updated.updatedSeq, buildJsonObject {
            put("message", Codec.snake.encodeToJsonElement(MessageOut.serializer(), updated))
            if (change != null) put("change", change)
        }))
    }

    private fun live(channelId: String, userId: String, messageId: String): Pair<ChannelRecord, MessageOut> {
        val record = requireMember(channelId, userId)
        val message = record.messages.firstOrNull { it.id == messageId && !it.deleted } ?: throw ApiException.Api(404, "message_not_found", "not found")
        return record to message
    }

    fun edit(channelId: String, userId: String, messageId: String, body: String): MessageOut {
        val (record, message) = live(channelId, userId, messageId)
        if (message.senderId != userId) throw ApiException.Api(403, "not_message_owner", "not the author")
        val seq = record.channel.lastSeq + 1
        record.channel = record.channel.copy(lastSeq = seq)
        val updated = message.copy(body = body, editedAt = now(), updatedSeq = seq)
        replace(record, updated, "message.updated", "body")
        return updated
    }

    fun delete(channelId: String, userId: String, messageId: String): MessageOut {
        val (record, message) = live(channelId, userId, messageId)
        val seq = record.channel.lastSeq + 1
        record.channel = record.channel.copy(lastSeq = seq)
        val tombstone = message.copy(body = "", deleted = true, updatedSeq = seq, reactions = emptyList())
        replace(record, tombstone, "message.deleted")
        return tombstone
    }

    fun react(channelId: String, userId: String, messageId: String, emoji: String, present: Boolean): Pair<MessageOut, Boolean> {
        val (record, message) = live(channelId, userId, messageId)
        val groups = LinkedHashMap<String, MutableList<String>>()
        message.reactions.forEach { groups[it.emoji] = it.userIds.toMutableList() }
        val users = groups.getOrPut(emoji) { ArrayList() }
        val changed = if (present) (userId !in users).also { if (it) users.add(userId) } else users.remove(userId)
        if (users.isEmpty()) groups.remove(emoji)
        if (!changed) return message to false
        val seq = record.channel.lastSeq + 1
        record.channel = record.channel.copy(lastSeq = seq)
        val updated = message.copy(updatedSeq = seq, reactions = groups.map { (e, ids) -> ReactionOut(e, ids.size, ids.toList()) })
        replace(record, updated, "message.updated", "reactions")
        return updated to true
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

    /** Delivers held frames up to the next `count` that reach a connected socket (a test looks between two events). */
    fun releaseNext(count: Int = 1) {
        var left = count
        while (left > 0) {
            val (ids, frame) = held.removeFirstOrNull() ?: return
            val targets = sockets.toList().filter { it.userId in ids }
            targets.forEach { it.deliver(frame) }
            if (targets.isNotEmpty()) left -= 1
        }
    }

    /** PATCH /channels/{id} as the real server announces it (M15): to the members, to everyone for a conversion. */
    fun updateChannel(channelId: String, postingPolicy: String? = null, type: String? = null) {
        val record = channels[channelId] ?: return
        val converted = type != null && type != record.channel.type
        record.channel = record.channel.copy(postingPolicy = postingPolicy ?: record.channel.postingPolicy, type = type ?: record.channel.type)
        emit(if (converted) users.keys.toSet() else record.members, event("channel.updated", channelId, null, buildJsonObject {
            put("channel", Codec.snake.encodeToJsonElement(ChannelOut.serializer(), record.channel.copy(membership = null)))
            put("member_ids", buildJsonArray { record.members.forEach { add(JsonPrimitive(it)) } })
        }))
    }

    /** What the real server emits after a join / add: member_added to the channel, channel.created to the user. */
    fun emitMembership(channelId: String, userId: String) {
        val record = channels[channelId] ?: return
        emit(record.members, event("channel.member_added", channelId, null, buildJsonObject { put("channel_id", channelId); put("user_id", userId) }))
        emit(setOf(userId), event("channel.created", channelId, null, buildJsonObject {
            put("channel", Codec.snake.encodeToJsonElement(ChannelOut.serializer(), record.channel.copy(membership = null, memberCount = record.members.size)))
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
        val me = UserMe(user.id, user.username, user.displayName, user.role, null, user.createdAt, user.updatedAt, null, false, notifyKeywords = keywords[userId] ?: emptyList())
        val mine = channels.values.filter { userId in it.members }.map { record ->
            record.channel.copy(membership = MembershipOut(if (record.channel.createdBy == userId) "owner" else "member", now()), readState = readState(userId, record.channel.id), memberCount = record.members.size)
        }
        val connected = sockets.filter { it.authed }.map { it.userId }.distinct().sorted()
        return BootstrapOut(
            now(), me, users.values.toList(), mine, Limits(20000, 1, 10), threadSummary(userId), connected.map { PresenceEntry(it, presenceOf(it) ) },
            bookmarks[userId]?.toList() ?: emptyList(),
            favorites = (favorites[userId] ?: emptyList()).filter { id -> channels[id]?.members?.contains(userId) == true },
            customEmoji = customEmoji.values.toList(),
            roster = roster.values.toList(),
            drafts = draftsOf(userId),
        )
    }

    fun history(userId: String, channelId: String, beforeSeq: Int?, limit: Int): HistoryOut {
        val record = requireMember(channelId, userId)
        val channelLastSeq = record.channel.lastSeq // read BEFORE the rows (§4.3)
        var rows = record.messages.filter { !it.deleted && (it.parentId == null || it.alsoInChannel) }
        if (beforeSeq != null) rows = rows.filter { it.seq < beforeSeq }
        rows = rows.sortedByDescending { it.seq }
        return HistoryOut(channelLastSeq, rows.take(limit), rows.size > limit)
    }

    /** Runs once between reading the cursor and the rows of the next GET /sync: a post committed in between (§4.3). */
    var beforeDeltaRows: (() -> Unit)? = null

    fun delta(userId: String, channelId: String, sinceSeq: Int, limit: Int): DeltaOut {
        val record = requireMember(channelId, userId)
        val channelLastSeq = record.channel.lastSeq // read BEFORE the rows (§4.3)
        beforeDeltaRows?.let { beforeDeltaRows = null; it() }
        val rows = record.messages.filter { it.updatedSeq > sinceSeq }.sortedBy { it.updatedSeq }
        val page = rows.take(limit)
        val hasMore = rows.size > limit
        return DeltaOut(page, if (hasMore) page.last().updatedSeq else maxOf(channelLastSeq, sinceSeq), hasMore)
    }

    fun api(userId: String): Api = Api(userId)

    fun connector(userId: String): WsConnector = { _, _ -> Socket(userId).also { sockets.add(it) } }
}

/**
 * Virtual time for the engine's timers (§5.3 heartbeat deadline, §9 outbox retry): nothing fires until the
 * test advances it. With the Unconfined scope the woken coroutines run inside [advance].
 */
class ManualTime {
    var now = 0L
        private set
    private val sleepers = ArrayList<Pair<Long, CancellableContinuation<Unit>>>()

    val clock: () -> Long = { now }
    val timer: suspend (Long) -> Unit = { ms ->
        suspendCancellableCoroutine { continuation ->
            val entry = (now + ms) to continuation
            sleepers.add(entry)
            continuation.invokeOnCancellation { sleepers.remove(entry) }
        }
    }

    fun advance(ms: Long) {
        val target = now + ms
        while (true) {
            val next = sleepers.filter { it.first <= target }.minByOrNull { it.first } ?: break
            sleepers.remove(next)
            now = next.first
            next.second.resumeWith(Result.success(Unit))
        }
        now = target
    }
}
