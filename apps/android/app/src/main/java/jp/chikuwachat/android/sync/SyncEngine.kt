package jp.chikuwachat.android.sync

import jp.chikuwachat.android.api.CustomEmojiOut
import jp.chikuwachat.android.api.GroupOut
import jp.chikuwachat.android.api.SidebarSectionOut
import kotlinx.serialization.builtins.ListSerializer
import jp.chikuwachat.android.api.ReminderOut
import jp.chikuwachat.android.api.ScheduledOut
import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.ChannelReadStateOut
import jp.chikuwachat.android.api.BootstrapOut
import jp.chikuwachat.android.api.ChannelOut
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.DeltaOut
import jp.chikuwachat.android.api.HistoryOut
import jp.chikuwachat.android.api.MessageOut
import jp.chikuwachat.android.api.ParentThread
import jp.chikuwachat.android.api.ReadStateOut
import jp.chikuwachat.android.api.ThreadListOut
import jp.chikuwachat.android.api.ThreadState
import jp.chikuwachat.android.api.UserPublic
import jp.chikuwachat.android.api.isRetryable
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.util.UUID
import kotlin.math.min
import kotlin.random.Random

/** The server API the engine needs (ApiClient and the test fake). */
interface SyncApi {
    suspend fun bootstrap(): BootstrapOut
    suspend fun history(channelId: String, beforeSeq: Int?, limit: Int): HistoryOut
    suspend fun delta(channelId: String, sinceSeq: Int, limit: Int): DeltaOut
    suspend fun postMessage(
        channelId: String, clientMsgId: String, body: String, parentId: String? = null, attachmentIds: List<String> = emptyList(), alsoInChannel: Boolean = false,
    ): Pair<MessageOut, Boolean>
    suspend fun publicChannels(): List<ChannelOut>
    suspend fun markRead(channelId: String, lastReadSeq: Int): ReadStateOut
    /** M12a: every channel read to its end; returns the new states. */
    suspend fun readAll(): List<ChannelReadStateOut>
    /** M12d: my pending scheduled messages. */
    suspend fun listScheduled(): List<ScheduledOut>
    /** M12e: my open reminders. */
    suspend fun listReminders(): List<ReminderOut>
    suspend fun setReadPosition(channelId: String, lastReadSeq: Int): ReadStateOut
    suspend fun replies(messageId: String): List<MessageOut>
    /** THREADS.md §3. */
    suspend fun threads(filter: String, cursor: String? = null, limit: Int = 50): ThreadListOut
    suspend fun threadState(messageId: String): ThreadState
    suspend fun markThreadRead(messageId: String, lastReadSeq: Int): ThreadState
    suspend fun setThreadFollow(messageId: String, following: Boolean): ThreadState
}

/** Transport as the engine sees it (OkHttp in the app, a fake in tests). Callbacks may come from any thread. */
interface WsTransport {
    var onMessage: ((String) -> Unit)?
    var onClose: ((Int) -> Unit)?
    fun send(text: String)
    fun close()
}

typealias WsConnector = suspend (url: String, token: String) -> WsTransport

enum class EngineStatus { IDLE, CONNECTING, ONLINE, OFFLINE, SIGNED_OUT }

data class EngineOptions(
    val pageSize: Int = 50,
    val gapLimit: Int = 5000,
    val deltaLimit: Int = 200,
    val helloTimeoutMs: Long = 10_000,
    val reconnectMinMs: Long = 1_000,
    val reconnectMaxMs: Long = 30_000,
    /** §10: read marks are debounced so scrolling does not spam the server. */
    val readDebounceMs: Long = 1_000,
    val threadPageSize: Int = 50,
    /** thread.updated bursts (one per reply) collapse into one list / badge refresh. */
    val threadRefreshMs: Long = 300,
    /** §5.2: typing frames go out at most this often per conversation; indicators expire after typingTtlMs. */
    val typingIntervalMs: Long = 3_000,
    val typingTtlMs: Long = 5_000,
    /** Injectable so tests can skip reconnect pacing. */
    val sleep: suspend (Long) -> Unit = { delay(it) },
    val random: () -> Double = { Random.nextDouble() },
    val newId: () -> String = { UUID.randomUUID().toString() },
    val now: () -> String = { java.time.Instant.now().toString() },
)

/**
 * The client side of SYNC_PROTOCOL.md (§5 heartbeat / reconnect, §7 start / catch_up / live, §8 merge,
 * §9 optimistic send). All state changes run on one coroutine (the work queue) so frames and sync
 * steps never interleave. server/tests/contract_client.py is the reference.
 */
class SyncEngine(
    private val api: SyncApi,
    private val connect: WsConnector,
    private val wsUrl: String,
    val store: Store,
    private val getAccessToken: () -> String?,
    private val scope: CoroutineScope,
    private val options: EngineOptions = EngineOptions(),
) {
    private val _status = MutableStateFlow(EngineStatus.IDLE)
    val status: StateFlow<EngineStatus> = _status
    var currentChannelId: String? = null
        private set
    var onSignedOut: (() -> Unit)? = null
    var onNotify: ((MessageOut, ChannelState) -> Unit)? = null
    /** A channel became fully read (here or on another device): dismiss its notification. */
    var onRead: ((String) -> Unit)? = null
    var isActive: () -> Boolean = { true }
    var prepareConnection: (suspend () -> Unit)? = null
    var catchUps = 0
        private set
    var reloads = 0
        private set
    var reconnects = 0
        private set

    private val queue = Channel<suspend () -> Unit>(Channel.UNLIMITED)
    private var worker: Job? = null
    private var ws: WsTransport? = null
    private var helloReceived = false
    private var helloWaiter: CompletableDeferred<Unit>? = null
    private var heartbeat: Job? = null
    private var pongTimeout: Job? = null
    private var stopped = false
    private var flushing = false
    private var reconnectAttempt = 0
    private val pendingReads = HashMap<String, Job>()
    /** Channels marked unread by hand: visible-range marking pauses until the reader opens another one (§10). */
    private val unreadHold = HashMap<String, Int>()
    fun heldUnread(channelId: String): Int? = unreadHold[channelId]
    /** Thread read positions sent (or about to be) while the thread's state is not loaded yet. */
    private val threadReadFloor = HashMap<String, Int>()
    private var threadRefresh: Job? = null
    /** "channel[:parent]" → when the last typing frame went out. */
    private val typingSent = HashMap<String, Long>()

    // --- serial work queue --------------------------------------------------------------------

    private fun ensureWorker() {
        if (worker?.isActive == true) return
        worker = scope.launch { for (work in queue) runCatching { work() }.onFailure { println("sync step failed: $it") } }
    }

    /** Runs `work` after everything already queued and returns when it has finished. */
    private suspend fun enqueue(work: suspend () -> Unit) {
        ensureWorker()
        val done = CompletableDeferred<Unit>()
        queue.send {
            try {
                work()
                done.complete(Unit)
            } catch (e: Throwable) {
                done.completeExceptionally(e)
            }
        }
        done.await()
    }

    private fun post(work: suspend () -> Unit) {
        ensureWorker()
        queue.trySend { work() }
    }

    /** Resolves once all queued frames / steps have been processed (tests and UI hooks). */
    suspend fun idle() = enqueue {}

    // --- §7.2 start, §7.5 reconnect ----------------------------------------------------------

    suspend fun start() {
        stopped = false
        connectSocket()
    }

    fun stop() {
        stopped = true
        clearTimers()
        ws?.close()
        ws = null
        _status.value = EngineStatus.IDLE
    }

    private suspend fun connectSocket() {
        if (stopped || _status.value == EngineStatus.CONNECTING || _status.value == EngineStatus.ONLINE) return
        _status.value = EngineStatus.CONNECTING
        try { prepareConnection?.invoke() } catch (e: Exception) {
            if (e is ApiException.Api && e.isAuth) signOut() else scheduleReconnect()
            return
        }
        if (stopped) return
        val token = getAccessToken()
        if (token == null) {
            signOut()
            return
        }
        _status.value = EngineStatus.CONNECTING
        val socket = try {
            connect(wsUrl, token)
        } catch (e: Exception) {
            scheduleReconnect()
            return
        }
        ws = socket
        helloReceived = false
        val waiter = CompletableDeferred<Unit>()
        helloWaiter = waiter
        socket.onMessage = { text ->
            val frame = ServerFrame.parse(text)
            // hello is awaited *inside* the queued bootstrap step, so it must be signalled here, on the
            // transport thread; everything else is applied in order on the work queue.
            if (frame is ServerFrame.Hello) waiter.complete(Unit)
            if (frame != null) post { onFrame(frame) }
        }
        socket.onClose = { code -> post { handleClose(socket, code) } }
        socket.send(ClientFrame.auth(token))

        val result = runCatching {
            enqueue {
                if (!waitForHello()) {
                    socket.close()
                    throw ApiException.Network(IllegalStateException("hello timeout"))
                }
                // Frames that arrive from here on are queued behind this step (= buffered, §7.2).
                val bootstrap = api.bootstrap()
                applyBootstrap(bootstrap)
                loadBrowsableChannels()
                currentChannelId?.let { catchUp(it) }
                reconnectAttempt = 0
                _status.value = EngineStatus.ONLINE
            }
        }
        result.onFailure { error ->
            if (error is ApiException.Api && error.isAuth) {
                signOut()
                return
            }
            socket.close()
            scheduleReconnect()
            return
        }
        if (_status.value == EngineStatus.ONLINE) scope.launch { flushOutbox() }
    }

    private suspend fun waitForHello(): Boolean {
        if (helloReceived) return true
        val waiter = helloWaiter ?: return helloReceived
        return withTimeoutOrNull(options.helloTimeoutMs) { waiter.await(); true } ?: false
    }

    private suspend fun scheduleReconnect() {
        if (stopped || _status.value == EngineStatus.SIGNED_OUT) return
        _status.value = EngineStatus.OFFLINE
        reconnectAttempt += 1
        reconnects += 1
        val base = min(options.reconnectMinMs * (1L shl (reconnectAttempt - 1).coerceAtMost(20)), options.reconnectMaxMs)
        options.sleep((base * (0.5 + options.random())).toLong())
        connectSocket()
    }

    private fun handleClose(socket: WsTransport, code: Int) {
        if (ws !== socket) return
        ws = null
        clearTimers()
        if (code == CLOSE_SESSION_REVOKED || code == CLOSE_AUTH_FAILED) {
            signOut()
            return
        }
        if (!stopped) scope.launch { scheduleReconnect() }
    }

    private fun signOut() {
        clearTimers()
        ws?.close()
        ws = null
        _status.value = EngineStatus.SIGNED_OUT
        onSignedOut?.invoke()
    }

    /** Foreground / network change: skip the backoff and catch up the open channel. */
    fun reconnectNow() {
        if (_status.value == EngineStatus.OFFLINE && ws == null) scope.launch { connectSocket() }
        if (_status.value == EngineStatus.ONLINE) currentChannelId?.let { id -> post { catchUp(id) } }
    }

    // --- frames -----------------------------------------------------------------------------

    private suspend fun onFrame(frame: ServerFrame) {
        when (frame) {
            is ServerFrame.Hello -> {
                helloReceived = true
                helloWaiter?.complete(Unit)
                startHeartbeat(frame.heartbeatIntervalSec * 1000L)
            }
            ServerFrame.Pong -> {
                pongTimeout?.cancel()
                pongTimeout = null
            }
            is ServerFrame.Error -> if (frame.code in setOf("invalid_token", "session_revoked", "session_expired", "password_change_required")) signOut()
            is ServerFrame.Event -> applyEvent(frame.frame)
            is ServerFrame.Typing -> {
                // Volatile (SYNC_PROTOCOL.md §5.2): shown for a few seconds, never stored.
                if (frame.userId != store.me?.id) store.noteTyping(frame.channelId, frame.parentId, frame.userId, System.currentTimeMillis() + options.typingTtlMs)
            }
            is ServerFrame.Presence -> store.setPresence(frame.userId, frame.status)
        }
    }

    private fun startHeartbeat(intervalMs: Long) {
        clearTimers()
        heartbeat = scope.launch {
            while (true) {
                delay(intervalMs)
                val socket = ws ?: return@launch
                runCatching { socket.send(ClientFrame.ping(isActive())) }
                pongTimeout?.cancel()
                pongTimeout = scope.launch {
                    delay(intervalMs * 2)
                    socket.close()
                }
            }
        }
    }

    private fun clearTimers() {
        heartbeat?.cancel()
        pongTimeout?.cancel()
        threadRefresh?.cancel()
        heartbeat = null
        pongTimeout = null
        threadRefresh = null
    }

    private fun applyBootstrap(bootstrap: BootstrapOut) {
        store.setMe(bootstrap.me)
        bootstrap.users.forEach { store.upsertUser(it) }
        val seen = HashSet<String>()
        bootstrap.channels.forEach { channel ->
            seen.add(channel.id)
            store.upsertChannel(channel, isMember = true)
        }
        store.channels.values.toList().filter { it.isMember && it.id !in seen }.forEach { store.removeChannel(it.id) }
        bootstrap.threads?.let { store.setThreadSummary(it) }
        if (store.threadsLoaded) scheduleThreadRefresh() // the list may have moved while we were away
        store.replacePresence(bootstrap.presence)
        store.replaceBookmarks(bootstrap.bookmarks)
        store.replaceFavorites(bootstrap.favorites)
        store.replaceCustomEmoji(bootstrap.customEmoji)
        store.replaceGroups(bootstrap.groups)
        store.replaceSidebar(bootstrap.sidebarSections)
        scope.launch { loadScheduled() }
        scope.launch { loadReminders() }
    }

    /** M12e: open reminders; refreshed after every bootstrap. */
    suspend fun loadReminders() {
        runCatching { store.replaceReminders(api.listReminders()) }
    }

    /** M12e: a reminder just fired while the app is open (the push covers the background case). */
    var onReminder: ((ReminderOut) -> Unit)? = null

    /** M12d: the pending scheduled messages; refreshed after every bootstrap (a reconnect may have missed events). */
    suspend fun loadScheduled() {
        runCatching { store.replaceScheduled(api.listScheduled()) }
    }

    /** 「すべて既読にする」 (M12a): the server moves every channel; the states apply like read.updated. */
    suspend fun markAllRead() {
        val states = api.readAll()
        enqueue {
            states.forEach { applyReadState(it.channelId, ReadStateOut(lastReadSeq = it.lastReadSeq, unreadCount = it.unreadCount, mentionCount = it.mentionCount)) }
        }
    }

    /** The composer changed: tell the other members, at most once per typingIntervalMs per conversation. */
    fun sendTyping(channelId: String, parentId: String? = null) {
        val socket = ws ?: return
        if (_status.value != EngineStatus.ONLINE) return
        val key = if (parentId != null) "$channelId:$parentId" else channelId
        val now = System.currentTimeMillis()
        if (now - (typingSent[key] ?: 0L) < options.typingIntervalMs) return
        typingSent[key] = now
        runCatching { socket.send(ClientFrame.typing(channelId, parentId)) }
    }

    /** Public channels I am not a member of; bootstrap only lists my own channels. */
    suspend fun loadBrowsableChannels() {
        val listed = runCatching { api.publicChannels() }.getOrNull() ?: return
        val ids = listed.map { it.id }.toSet()
        listed.filter { store.channel(it.id) == null }.forEach { store.upsertChannel(it, isMember = false) }
        store.channels.values.toList().filter { !it.isMember && it.id !in ids }.forEach { store.removeChannel(it.id) }
    }

    private suspend fun applyEvent(frame: EventFrame) {
        when (frame.event) {
            "message.created", "message.updated", "message.deleted" -> applyTimelineEvent(frame)
            "bookmark.updated" -> {
                val id = frame.data.str("message_id") ?: return
                store.setBookmarked(id, frame.data.bool("bookmarked") ?: false)
            }
            "emoji.updated" -> {
                val row = Codec.snake.decodeFromJsonElement(CustomEmojiOut.serializer(), frame.data["emoji"] ?: return)
                store.applyCustomEmoji(row, frame.data.bool("deleted") ?: false)
            }
            "sidebar.updated" -> {
                val rows = Codec.snake.decodeFromJsonElement(ListSerializer(SidebarSectionOut.serializer()), frame.data["sections"] ?: return)
                store.replaceSidebar(rows)
            }
            "group.updated" -> {
                val row = Codec.snake.decodeFromJsonElement(GroupOut.serializer(), frame.data["group"] ?: return)
                store.applyGroup(row, frame.data.bool("deleted") ?: false)
            }
            "reminder.updated" -> {
                val row = Codec.snake.decodeFromJsonElement(ReminderOut.serializer(), frame.data["reminder"] ?: return)
                val before = store.reminders[row.id]?.status
                store.applyReminder(row)
                if (row.status == "fired" && before != "fired") onReminder?.invoke(row)
            }
            "scheduled.updated" -> {
                val row = Codec.snake.decodeFromJsonElement(ScheduledOut.serializer(), frame.data["scheduled"] ?: return)
                store.applyScheduled(row)
            }
            "favorite.updated" -> {
                val id = frame.data.str("channel_id") ?: return
                store.setFavorite(id, frame.data.bool("favorite") ?: false)
            }
            "thread.updated" -> {
                // THREADS.md §4: the row (if held) takes the new state now; the badge and the open list are
                // refreshed from the server shortly after, which also covers threads we do not hold.
                store.applyThreadState(Codec.snake.decodeFromJsonElement(ThreadState.serializer(), frame.data))
                scheduleThreadRefresh()
            }
            "channel.created", "channel.updated" -> {
                val channel = Codec.snake.decodeFromJsonElement(ChannelOut.serializer(), frame.data["channel"] ?: return)
                val memberIds = (frame.data["member_ids"] as? JsonArray)?.map { it.jsonPrimitive.content } ?: emptyList()
                val isMember = store.me?.id?.let { it in memberIds } ?: false
                if (isMember || channel.type == "public") store.upsertChannel(channel, isMember = isMember)
                else if (store.channel(channel.id) != null) store.removeChannel(channel.id) // made private (M15b)
            }
            "channel.archived" -> frame.data.str("channel_id")?.let { id ->
                store.updateChannel(id) { it.copy(channel = it.channel.copy(archived = true)) }
            }
            "channel.member_added" -> frame.data.str("channel_id")?.let { id ->
                // M11h: keep the intro's member count current; the member list itself is loaded on demand.
                store.updateChannel(id) { state -> state.channel.memberCount?.let { state.copy(channel = state.channel.copy(memberCount = it + 1)) } ?: state }
            }
            "channel.member_removed" -> {
                val me = store.me ?: return
                val id = frame.data.str("channel_id") ?: return
                if (frame.data.str("user_id") == me.id) {
                    store.removeChannel(id)
                } else {
                    store.updateChannel(id) { state -> state.channel.memberCount?.let { state.copy(channel = state.channel.copy(memberCount = maxOf(0, it - 1))) } ?: state }
                }
            }
            "user.created", "user.updated", "user.deactivated" -> {
                val user = Codec.snake.decodeFromJsonElement(UserPublic.serializer(), frame.data["user"] ?: return)
                store.upsertUser(user)
            }
            "read.updated" -> {
                val channelId = frame.data.str("channel_id") ?: return
                applyReadState(channelId, Codec.snake.decodeFromJsonElement(ReadStateOut.serializer(), frame.data), allowDecrease = frame.data.str("reason") == "set")
            }
            "notification_preference.updated" -> {
                val channelId = frame.data.str("channel_id") ?: return
                store.setNotification(channelId, frame.data.str("level") ?: "mentions", frame.data.str("muted_until"))
            }
            "session.revoked" -> signOut()
        }
    }

    // --- §7.4 live timeline events -----------------------------------------------------------

    private suspend fun applyTimelineEvent(frame: EventFrame) {
        val channelId = frame.channelId ?: return
        val seq = frame.seq ?: return
        val channel = store.channel(channelId) ?: return
        val message = Codec.snake.decodeFromJsonElement(MessageOut.serializer(), frame.data["message"]?.jsonObject ?: return)
        val thread = (frame.data["parent_thread"] as? JsonObject)?.let { Codec.snake.decodeFromJsonElement(ParentThread.serializer(), it) }
        val isNew = frame.event == "message.created"
        val synced = channel.syncedSeq
        when {
            synced == null -> {
                store.updateChannel(channelId) { it.copy(lastSeq = maxOf(it.lastSeq, seq)) }
                if (isNew) { countUnread(message); maybeNotify(message, channel, thread) }
            }
            seq == synced + 1 -> {
                store.upsertMessage(message)
                if (thread != null) store.applyParentThread(channelId, thread)
                store.updateChannel(channelId) { it.copy(syncedSeq = seq, lastSeq = maxOf(it.lastSeq, seq)) }
                if (isNew) { countUnread(message); maybeNotify(message, channel, thread) }
            }
            seq > synced + 1 -> {
                store.updateChannel(channelId) { it.copy(lastSeq = maxOf(it.lastSeq, seq)) }
                catchUp(channelId)
                if (isNew) { countUnread(message); maybeNotify(message, channel, thread) }
            }
            // seq <= synced: already applied
        }
    }

    /** §7.4 / §10: my own message is read; someone else's is unread until read.updated says otherwise. */
    private fun countUnread(message: MessageOut) {
        store.clearTyping(message.channelId, message.parentId, message.senderId) // their message arrived: no longer typing
        val me = store.me ?: return
        if (message.senderId == me.id) {
            unreadHold.remove(message.channelId) // sending reads the conversation (the server does the same)
            store.updateChannel(message.channelId) { it.copy(lastReadSeq = maxOf(it.lastReadSeq, message.seq), unreadCount = 0, mentionCount = 0) }
            return
        }
        if (message.isReply && !message.alsoInChannel) return // replies are not unread items unless also sent to the channel (M15c)
        store.updateChannel(message.channelId) { channel ->
            if (message.seq <= channel.lastReadSeq) channel
            else channel.copy(unreadCount = channel.unreadCount + 1, mentionCount = channel.mentionCount + if (message.mentions(me.id)) 1 else 0)
        }
    }

    private fun applyReadState(channelId: String, state: ReadStateOut, allowDecrease: Boolean = false) {
        // Advances merge with max (an event for an older PUT may arrive after a newer local mark);
        // a mark-as-unread (reason "set") moves the position down as well.
        val updated = store.updateChannel(channelId) {
            it.copy(
                lastReadSeq = if (allowDecrease) state.lastReadSeq else maxOf(it.lastReadSeq, state.lastReadSeq),
                unreadCount = state.unreadCount,
                mentionCount = state.mentionCount,
            )
        } ?: return
        if (updated.unreadCount == 0) onRead?.invoke(channelId)
    }

    /** DMs always notify; channels when I am mentioned or take part in the thread (PUSH_NOTIFICATIONS.md §4). */
    private fun maybeNotify(message: MessageOut, channel: ChannelState, thread: ParentThread? = null) {
        val me = store.me ?: return
        if (message.senderId == me.id) return
        // Same rule as the server's PushPlanner: the per-channel level, "none" or a timed mute silences everything.
        val level = channel.channel.notification?.level ?: if (channel.channel.isDm) "all" else "mentions"
        val mutedUntil = channel.channel.notification?.mutedUntil?.let { runCatching { java.time.Instant.parse(it) }.getOrNull() }
        if (level == "none" || (mutedUntil != null && mutedUntil.isAfter(java.time.Instant.now()))) return
        val involved = message.mentions(me.id) || (thread != null && me.id in thread.participantIds)
        if (level == "mentions" && !involved) return
        if (isActive() && currentChannelId == channel.id) return
        onNotify?.invoke(message, channel)
    }

    /** Opening a thread: fetch its replies (live ones keep arriving as timeline events). */
    suspend fun loadReplies(channelId: String, parentId: String) = enqueue {
        if (_status.value != EngineStatus.ONLINE) return@enqueue
        api.replies(parentId).forEach { store.upsertMessage(it) }
    }

    // --- §7.3 catch_up --------------------------------------------------------------------------

    suspend fun openChannel(channelId: String) {
        currentChannelId = channelId
        unreadHold.keys.filter { it != channelId }.forEach { unreadHold.remove(it) }
        if (_status.value != EngineStatus.ONLINE) return
        enqueue {
            val channel = store.channel(channelId) ?: return@enqueue
            if (channel.syncedSeq == null || channel.syncedSeq < channel.lastSeq) catchUp(channelId)
            // Only the visible timeline advances read state.
        }
    }

    /** §10: move the local position at once (monotonic), then PUT after a debounce; the server's answer wins. */
    /** 「ここから未読にする」: seq - 1 becomes the position here and on the server (mode=set) at once. */
    fun markUnread(channelId: String, seq: Int) {
        if (_status.value != EngineStatus.ONLINE || seq < 1) return
        val channel = store.channel(channelId) ?: return
        if (!channel.isMember) return
        val target = seq - 1
        unreadHold[channelId] = target
        pendingReads.remove(channelId)?.cancel()
        val me = store.me?.id
        val later = store.messages(channelId).filter { (it.seq ?: 0) > target && it.senderId != me }
        store.updateChannel(channelId) {
            it.copy(
                lastReadSeq = target,
                unreadCount = later.size,
                mentionCount = later.count { m -> me != null && (m.mentionAll || me in m.mentionedUserIds) },
            )
        }
        pendingReads[channelId] = scope.launch {
            val state = runCatching { api.setReadPosition(channelId, target) }.getOrNull()
            pendingReads.remove(channelId)
            if (state != null) post { applyReadState(channelId, state, allowDecrease = true) }
        }
    }

    fun markRead(channelId: String, seq: Int, force: Boolean = false) {
        if (_status.value != EngineStatus.ONLINE || !isActive()) return
        if (force) unreadHold.remove(channelId) else if (unreadHold.containsKey(channelId)) return
        val channel = store.channel(channelId) ?: return
        if (!channel.isMember || seq <= channel.lastReadSeq) return
        store.updateChannel(channelId) {
            if (seq >= it.lastSeq) it.copy(lastReadSeq = seq, unreadCount = 0, mentionCount = 0) else it.copy(lastReadSeq = seq)
        }
        pendingReads.remove(channelId)?.cancel()
        pendingReads[channelId] = scope.launch {
            options.sleep(options.readDebounceMs)
            val target = store.channel(channelId)?.lastReadSeq ?: return@launch
            pendingReads.remove(channelId)
            runCatching { api.markRead(channelId, target) }.onSuccess { post { applyReadState(channelId, it) } }
        }
    }

    /** Waits for debounced read marks (tests). */
    suspend fun flushReads() {
        pendingReads.values.toList().forEach { it.join() }
        idle()
    }

    // --- followed threads (THREADS.md §5) ------------------------------------------------------

    /** The threads view opens (or switches filter): fetch the first page; `more` appends the next one. */
    suspend fun loadThreads(filter: String, more: Boolean = false) = enqueue {
        if (_status.value != EngineStatus.ONLINE) return@enqueue
        val cursor = if (more && store.threadsFilter == filter) store.threadsCursor else null
        if (more && cursor == null) return@enqueue
        val page = api.threads(filter, cursor, options.threadPageSize)
        store.setThreadPage(filter, page.items, page.nextCursor, append = cursor != null, pageSize = options.threadPageSize)
        store.setThreadSummary(page.summary)
    }

    /** A thread opened from a channel: fetch my relation to it (follow flag, read position). */
    suspend fun loadThreadState(parentId: String, parent: MessageOut? = null) = enqueue {
        if (_status.value != EngineStatus.ONLINE) return@enqueue
        var state = api.threadState(parentId)
        threadReadFloor[parentId]?.let { floor -> if (floor > state.lastReadSeq) state = state.copy(lastReadSeq = floor) }
        store.applyThreadState(state, parent)
    }

    /** The reply with `seq` was shown: the thread position moves now (monotonic) and is sent after a debounce. */
    fun markThreadRead(parentId: String, seq: Int) {
        if (_status.value != EngineStatus.ONLINE || !isActive()) return
        val current = maxOf(store.threads[parentId]?.state?.lastReadSeq ?: 0, threadReadFloor[parentId] ?: 0)
        if (seq <= current) return
        threadReadFloor[parentId] = seq
        store.threads[parentId]?.state?.let { state ->
            val newest = store.replies(state.channelId, parentId).mapNotNull { it.seq }.maxOrNull() ?: 0
            store.applyThreadState(if (seq >= newest) state.copy(lastReadSeq = seq, unreadCount = 0, mentionCount = 0) else state.copy(lastReadSeq = seq))
        }
        val key = "thread:$parentId"
        pendingReads.remove(key)?.cancel()
        pendingReads[key] = scope.launch {
            options.sleep(options.readDebounceMs)
            val target = threadReadFloor[parentId] ?: seq
            pendingReads.remove(key)
            runCatching { api.markThreadRead(parentId, target) }.onSuccess { post { store.applyThreadState(it) } }
        }
    }

    suspend fun setThreadFollow(parentId: String, following: Boolean) = enqueue {
        if (_status.value != EngineStatus.ONLINE) return@enqueue
        store.applyThreadState(api.setThreadFollow(parentId, following))
    }

    private fun scheduleThreadRefresh() {
        threadRefresh?.cancel()
        threadRefresh = scope.launch {
            options.sleep(options.threadRefreshMs)
            if (_status.value == EngineStatus.ONLINE) refreshThreads()
        }
    }

    /** Re-read the badge (and the open list) from the server; cheap, and always consistent. */
    suspend fun refreshThreads() {
        if (store.threadsLoaded) runCatching { loadThreads(store.threadsFilter) }
        else runCatching { api.threads("unread", null, 1) }.onSuccess { store.setThreadSummary(it.summary) }
    }

    /** Waits for the debounced thread refresh and read marks (tests). */
    suspend fun flushThreads() {
        threadRefresh?.join()
        flushReads()
    }

    suspend fun catchUp(channelId: String) {
        catchUps += 1
        var channel = store.channel(channelId) ?: return
        val synced = channel.syncedSeq
        if (synced != null && channel.lastSeq - synced > options.gapLimit) {
            store.clearMessages(channelId)
            channel = store.updateChannel(channelId) { it.copy(syncedSeq = null, hasOlder = true) } ?: channel
            reloads += 1
        }
        var since = channel.syncedSeq
        if (since == null) {
            val page = api.history(channelId, null, options.pageSize)
            page.messages.forEach { store.upsertMessage(it) }
            store.updateChannel(channelId) { it.copy(syncedSeq = page.channelLastSeq, lastSeq = maxOf(it.lastSeq, page.channelLastSeq), hasOlder = page.hasMore) }
            return
        }
        while (true) {
            val delta = api.delta(channelId, since!!, options.deltaLimit)
            delta.messages.forEach { store.upsertMessage(it) }
            since = delta.nextSinceSeq
            store.updateChannel(channelId) { it.copy(syncedSeq = delta.nextSinceSeq, lastSeq = maxOf(it.lastSeq, delta.nextSinceSeq)) }
            if (!delta.hasMore) return
        }
    }

    /** Scroll-up pagination: older messages by seq cursor. */
    suspend fun loadOlder(channelId: String) = enqueue {
        if (_status.value != EngineStatus.ONLINE) return@enqueue
        val channel = store.channel(channelId) ?: return@enqueue
        if (!channel.hasOlder) return@enqueue
        val oldest = store.messages(channelId).firstNotNullOfOrNull { it.seq }
        val page = api.history(channelId, oldest, options.pageSize)
        page.messages.forEach { store.upsertMessage(it) }
        store.updateChannel(channelId) { it.copy(hasOlder = page.hasMore) }
    }

    // --- §9 optimistic send -------------------------------------------------------------------

    suspend fun send(
        channelId: String, body: String, clientMsgId: String? = null, parentId: String? = null, attachmentIds: List<String> = emptyList(), alsoInChannel: Boolean = false,
    ) {
        val key = clientMsgId ?: options.newId()
        val createdAt = options.now()
        val shared = alsoInChannel && parentId != null // M15c: only replies can also go to the channel
        store.addOutbox(OutboxItem(key, channelId, body, createdAt, parentId = parentId, attachmentIds = attachmentIds, alsoInChannel = shared))
        store.putPlaceholder(MessageState.placeholder(key, channelId, store.me?.id ?: "", body, createdAt, parentId, alsoInChannel = shared))
        flushOutbox()
    }

    suspend fun retryFailed() {
        store.outbox.filter { it.failed != null }.forEach { store.markOutboxFailed(it.clientMsgId, null) }
        flushOutbox()
    }

    fun discardFailed(clientMsgId: String) {
        val item = store.outbox.firstOrNull { it.clientMsgId == clientMsgId } ?: return
        store.upsertMessage(MessageState(id = LOCAL_PREFIX + clientMsgId, channelId = item.channelId, senderId = "", seq = null, updatedSeq = Int.MAX_VALUE, clientMsgId = null, body = "", createdAt = "", deleted = true))
        store.removeOutbox(clientMsgId)
    }

    /** Sends queued messages one at a time, in order (§9). Stops on temporary failures. */
    suspend fun flushOutbox() {
        if (flushing || _status.value != EngineStatus.ONLINE) return
        flushing = true
        try {
            for (item in store.outbox.toList()) {
                if (item.failed != null) continue
                try {
                    val (message, _) = api.postMessage(item.channelId, item.clientMsgId, item.body, item.parentId, item.attachmentIds, item.alsoInChannel)
                    store.upsertMessage(message)
                    store.removeOutbox(item.clientMsgId)
                } catch (e: Exception) {
                    if (e.isRetryable()) return
                    store.markOutboxFailed(item.clientMsgId, (e as? ApiException.Api)?.code ?: "failed")
                }
            }
        } finally {
            flushing = false
        }
    }
}
