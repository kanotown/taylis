package jp.chikuwachat.android.sync

import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.BootstrapOut
import jp.chikuwachat.android.api.ChannelOut
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.DeltaOut
import jp.chikuwachat.android.api.HistoryOut
import jp.chikuwachat.android.api.MessageOut
import jp.chikuwachat.android.api.ParentThread
import jp.chikuwachat.android.api.ReadStateOut
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
    suspend fun postMessage(channelId: String, clientMsgId: String, body: String, parentId: String? = null, attachmentIds: List<String> = emptyList()): Pair<MessageOut, Boolean>
    suspend fun publicChannels(): List<ChannelOut>
    suspend fun markRead(channelId: String, lastReadSeq: Int): ReadStateOut
    suspend fun replies(messageId: String): List<MessageOut>
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
        heartbeat = null
        pongTimeout = null
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
            "channel.created", "channel.updated" -> {
                val channel = Codec.snake.decodeFromJsonElement(ChannelOut.serializer(), frame.data["channel"] ?: return)
                val memberIds = (frame.data["member_ids"] as? JsonArray)?.map { it.jsonPrimitive.content } ?: emptyList()
                val isMember = store.me?.id?.let { it in memberIds } ?: false
                if (isMember || channel.type == "public") store.upsertChannel(channel, isMember = isMember)
            }
            "channel.archived" -> frame.data.str("channel_id")?.let { id ->
                store.updateChannel(id) { it.copy(channel = it.channel.copy(archived = true)) }
            }
            "channel.member_removed" -> {
                val me = store.me ?: return
                if (frame.data.str("user_id") == me.id) frame.data.str("channel_id")?.let { store.removeChannel(it) }
            }
            "user.created", "user.updated", "user.deactivated" -> {
                val user = Codec.snake.decodeFromJsonElement(UserPublic.serializer(), frame.data["user"] ?: return)
                store.upsertUser(user)
            }
            "read.updated" -> {
                val channelId = frame.data.str("channel_id") ?: return
                applyReadState(channelId, Codec.snake.decodeFromJsonElement(ReadStateOut.serializer(), frame.data))
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
        val me = store.me ?: return
        if (message.senderId == me.id) {
            store.updateChannel(message.channelId) { it.copy(lastReadSeq = maxOf(it.lastReadSeq, message.seq), unreadCount = 0, mentionCount = 0) }
            return
        }
        if (message.isReply) return // replies are not unread items (DATA_MODEL.md read_states)
        store.updateChannel(message.channelId) { channel ->
            if (message.seq <= channel.lastReadSeq) channel
            else channel.copy(unreadCount = channel.unreadCount + 1, mentionCount = channel.mentionCount + if (message.mentions(me.id)) 1 else 0)
        }
    }

    private fun applyReadState(channelId: String, state: ReadStateOut) {
        val updated = store.updateChannel(channelId) {
            it.copy(lastReadSeq = maxOf(it.lastReadSeq, state.lastReadSeq), unreadCount = state.unreadCount, mentionCount = state.mentionCount)
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
        if (_status.value != EngineStatus.ONLINE) return
        enqueue {
            val channel = store.channel(channelId) ?: return@enqueue
            if (channel.syncedSeq == null || channel.syncedSeq < channel.lastSeq) catchUp(channelId)
            // Only the visible timeline advances read state.
        }
    }

    /** §10: move the local position at once (monotonic), then PUT after a debounce; the server's answer wins. */
    fun markRead(channelId: String, seq: Int) {
        if (_status.value != EngineStatus.ONLINE || !isActive()) return
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

    suspend fun send(channelId: String, body: String, clientMsgId: String? = null, parentId: String? = null, attachmentIds: List<String> = emptyList()) {
        val key = clientMsgId ?: options.newId()
        val createdAt = options.now()
        store.addOutbox(OutboxItem(key, channelId, body, createdAt, parentId = parentId, attachmentIds = attachmentIds))
        store.putPlaceholder(MessageState.placeholder(key, channelId, store.me?.id ?: "", body, createdAt, parentId))
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
                    val (message, _) = api.postMessage(item.channelId, item.clientMsgId, item.body, item.parentId, item.attachmentIds)
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
