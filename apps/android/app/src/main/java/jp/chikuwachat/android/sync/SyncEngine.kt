package jp.chikuwachat.android.sync

import android.util.Log
import jp.chikuwachat.android.api.CustomEmojiOut
import jp.chikuwachat.android.api.GroupOut
import jp.chikuwachat.android.api.MembershipOut
import jp.chikuwachat.android.api.TemplateOut
import jp.chikuwachat.android.api.LabProfileOut
import jp.chikuwachat.android.api.hitsKeyword
import jp.chikuwachat.android.api.SidebarSectionOut
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.nullable
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
import jp.chikuwachat.android.api.NotificationPreferenceOut
import jp.chikuwachat.android.api.ParentThread
import jp.chikuwachat.android.api.ReadStateOut
import jp.chikuwachat.android.api.ThreadListOut
import jp.chikuwachat.android.api.ThreadState
import jp.chikuwachat.android.api.UserPublic
import jp.chikuwachat.android.api.WorkspaceSettingsOut
import jp.chikuwachat.android.api.ChannelLinkOut
import jp.chikuwachat.android.api.DraftUpdated
import jp.chikuwachat.android.api.isRefusal
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
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
        channelId: String, clientMsgId: String, body: String, parentId: String? = null, attachmentIds: List<String> = emptyList(), options: SendOptions = SendOptions(),
    ): Pair<MessageOut, Boolean>
    suspend fun publicChannels(): List<ChannelOut>
    suspend fun markRead(channelId: String, lastReadSeq: Int): ReadStateOut
    /** M12a: every channel read to its end; returns the new states. `scope` "times" (L8): only the Times feed's channels. */
    suspend fun readAll(scope: String? = null): List<ChannelReadStateOut>
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
    /** A dead connection (§5.3 heartbeat deadline): drop it without waiting for a closing handshake. */
    fun abort() = close()
}

typealias WsConnector = suspend (url: String, token: String) -> WsTransport

enum class EngineStatus { IDLE, CONNECTING, ONLINE, OFFLINE, SIGNED_OUT }

/** §7.7: a channel nobody looks at is trimmed back to the cap once live rows take it this far past it. */
const val TRIM_MARGIN = 100

/** L8: live rows the Times feed may be behind by before it reads the server again (SyncEngine.timelineStale). */
const val TIMELINE_BUFFER = 256

/** M88 (MEMBERSHIP.md §3): the 403 for an unjoined public channel's rows while the workspace turned the preview off. */
const val PREVIEW_DISABLED = "preview_disabled"

/** Extras for a send (they travel with the outbox so retries keep them). */
data class SendOptions(
    /** M15c: a thread reply also shown in the channel. */
    val alsoInChannel: Boolean = false,
    /** M15e: top-level posts only. */
    val priority: String? = null,
    val ackRequested: Boolean = false,
)

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
    /** M39: the events that move the activity badge collapse into one GET /activity/summary this long after the last. */
    val activityRefreshMs: Long = 1_000,
    /** §5.2: typing frames go out at most this often per conversation; indicators expire after typingTtlMs. */
    val typingIntervalMs: Long = 3_000,
    val typingTtlMs: Long = 5_000,
    /** M15d: a draft is saved on the server this long after typing pauses. */
    val draftSaveMs: Long = 1_000,
    /** §9: after a temporary send failure the outbox retries after 2 s, 4 s … at most 30 s while connected. */
    val outboxRetryMinMs: Long = 2_000,
    val outboxRetryMaxMs: Long = 30_000,
    /** Injectable so tests can skip reconnect pacing. */
    val sleep: suspend (Long) -> Unit = { delay(it) },
    /**
     * The §5.3 heartbeat deadline and the §9 outbox retry run on this monotonic clock (ms) and wait with
     * `timer`; tests drive both by hand (skipping them like `sleep` would spin).
     */
    val clock: () -> Long = { System.nanoTime() / 1_000_000 },
    val timer: suspend (Long) -> Unit = { delay(it) },
    val random: () -> Double = { Random.nextDouble() },
    val newId: () -> String = { UUID.randomUUID().toString() },
    val now: () -> String = { java.time.Instant.now().toString() },
    /** M46: the canvas save loop's pauses (CANVAS.md §4.4); M74: its copies are read off the main thread. */
    val canvasSave: CanvasSaverOptions = CanvasSaverOptions(io = Dispatchers.IO),
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

    private val _timelineEvents = MutableSharedFlow<TimelineEvent>(extraBufferCapacity = TIMELINE_BUFFER)
    /**
     * L8 (TIMES_FEED.md §5): the rows of the times I am in as they change, for lists kept outside the store (the Times
     * feed) while they are on screen: every live message.created / updated / deleted, and every row the store takes
     * otherwise (a catch-up after a gap, the answers to my own actions, my poll answers, parents' reply counts). Nothing
     * is replayed: such a list reads the server again on opening, after reconnecting and when [timelineStale] moves.
     */
    val timelineEvents: SharedFlow<TimelineEvent> = _timelineEvents
    private val _timelineStale = MutableStateFlow(0)
    /** Bumped when [timelineEvents] could not take an event (its buffer full): the list on screen reads the server again. */
    val timelineStale: StateFlow<Int> = _timelineStale
    /** M15d: my drafts across devices. */
    val drafts = DraftSync(api as? DraftApi, store, scope, { _status.value == EngineStatus.ONLINE }, options.draftSaveMs)

    /** M46: the conversations' canvases and the save loops of the open ones (CANVAS.md §4.4 / §4.6). */
    val canvases = CanvasHub(api as? CanvasApi, store, scope, options.canvasSave)

    /** M52: the ranges of the calendar on screen and the channels' 「予定」 counts (CALENDAR.md §5, §15). */
    val calendar = CalendarHub(api as? CalendarApi, scope, { store.me?.id })

    /** M56: the boards, 「自分のタスク」 and the calendar's due tasks on screen (TASKS.md §4, SYNC_PROTOCOL.md §16). */
    val tasks = TaskHub(api as? TaskApi, scope, { store.me?.id })

    /** M66: the AI status (which bots are AI, whether summaries may be asked for) and the open summary (docs/AI.md §5). */
    val ai = AiHub(api as? AiApi, scope)

    init {
        store.onDraftEdited = { channelId, parentId -> drafts.edited(channelId, parentId) }
        store.onTimelineRow = { channelId, event -> emitTimeline(channelId, event) }
        store.onStalePreview = { channelId -> post { refreshLastMessage(channelId) } }
    }

    /**
     * M49 (SYNC_PROTOCOL.md §7.8): the preview's message was deleted and the rows held do not say which one is last now:
     * the server's answer (GET /channels/{id}). A failure leaves it empty until the next bootstrap.
     */
    suspend fun refreshLastMessage(channelId: String) {
        val channelApi = api as? ChannelApi ?: return
        runCatching { channelApi.channel(channelId) }
            .onSuccess { store.setFetchedLastMessage(channelId, it.lastMessage) }
            .onFailure { Log.w("SyncEngine", "could not refresh the conversation's last message", it) }
    }

    /** M15f: the conversation's link bar; loaded when it opens and after reconnecting (not in bootstrap). */
    suspend fun loadLinks(channelId: String) {
        val linksApi = api as? ChannelLinksApi ?: return
        runCatching { linksApi.channelLinks(channelId) }.onSuccess { store.setChannelLinks(channelId, it) }
    }

    /**
     * M99 (docs/RESERVATIONS.md §6): the conversation's reservation pools; loaded when it opens, after reconnecting and on
     * reservation.updated (the event carries no card: it differs per person).
     */
    suspend fun loadReservationPools(channelId: String) {
        val poolsApi = api as? ReservationsApi ?: return
        runCatching { poolsApi.reservationPools(channelId) }.onSuccess { store.setReservationPools(channelId, it) }
    }

    /** Save edited drafts now instead of after the typing pause (tests, sign-out). */
    suspend fun flushDrafts() = drafts.flush()
    var currentChannelId: String? = null
        private set
    var onSignedOut: (() -> Unit)? = null
    var onNotify: ((MessageOut, ChannelState) -> Unit)? = null
    /**
     * M73 (CANVAS.md §18.1): a canvas newly mentions me while the app is open (the push is not shown then). Called only
     * when the conversation's level is not 「なし」 and it is not muted (DND is the caller's).
     */
    var onCanvasMention: ((jp.chikuwachat.android.api.CanvasMentioned, ChannelState) -> Unit)? = null
    /** A channel became fully read (here or on another device): dismiss its notification. */
    var onRead: ((String) -> Unit)? = null
    var isActive: () -> Boolean = { true }
    /**
     * Runs before every connection (§7.2) to make sure a usable access token exists. `refresh` is true after
     * the server refused the token (close 4001, §5.3): then it is renewed even if it still looks valid.
     */
    var prepareConnection: (suspend (refresh: Boolean) -> Unit)? = null
    var catchUps = 0
        private set
    var reloads = 0
        private set
    /** §7.3 reloads per channel: an open view re-opens after one (its rows, and the read anchor, are gone). */
    private val reloadsByChannel = HashMap<String, Int>()
    var reconnects = 0
        private set

    private val queue = Channel<suspend () -> Unit>(Channel.UNLIMITED)
    private var worker: Job? = null
    private var ws: WsTransport? = null
    private var heartbeat: Job? = null
    /** §5.3: the one pending reconnect (it sleeps the backoff first); null while connecting or connected. */
    private var reconnectJob: Job? = null
    /** §5.3: the last socket was closed with 4001, so the next connection renews the access token first. */
    private var refreshBeforeConnect = false
    private var stopped = false
    private var flushing = false
    /** §9: something was queued while the outbox loop ran; it goes round once more before stopping. */
    private var flushAgain = false
    /** §9: the timer that resumes the outbox after a temporary failure, and the failures in a row (backoff). */
    private var outboxRetry: Job? = null
    private var outboxFailures = 0
    private var reconnectAttempt = 0
    private val pendingReads = HashMap<String, Job>()
    /** Channels marked unread by hand: visible-range marking pauses until the reader opens another one (§10). */
    private val unreadHold = HashMap<String, Int>()
    fun heldUnread(channelId: String): Int? = unreadHold[channelId]
    /** Thread read positions sent (or about to be) while the thread's state is not loaded yet. */
    private val threadReadFloor = HashMap<String, Int>()
    /** §10: thread read marks the server has not confirmed (PUT failed or still debouncing); resent after reconnecting. */
    private val unsentThreadReads = HashMap<String, Int>()
    /** §10.2: parent id → channel id of threads whose whole reply list was fetched; dropped with the channel's rows. */
    private val completeThreads = HashMap<String, String>()
    /** Threads on screen, whose ThreadState a GET /threads refresh must not drop (§10.2). */
    private val shownThreads = HashSet<String>()
    /** §7.7: views of a channel's rows besides the open conversation (a thread pane); the channel is not trimmed meanwhile. */
    private val views = HashMap<String, Int>()
    private var threadRefresh: Job? = null
    private var activityRefresh: Job? = null
    /** "channel[:parent]" → when the last typing frame went out. */
    private val typingSent = HashMap<String, Long>()
    /** M73: what this device last said of the canvases it edits (`canvas_presence`, CANVAS.md §18.2). */
    private val canvasPresence = CanvasPresenceSender()

    // --- serial work queue --------------------------------------------------------------------

    private fun ensureWorker() {
        if (worker?.isActive == true) return
        worker = scope.launch { for (work in queue) runCatching { work() }.onFailure { Log.w("SyncEngine", "sync step failed", it) } }
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

    /** One socket (§5.3): when a frame last arrived (the heartbeat deadline counts from it) and how it closed. */
    private class Connection(val socket: WsTransport, @Volatile var lastFrameAt: Long) {
        @Volatile var closeCode: Int? = null
    }

    suspend fun start() {
        stopped = false
        connectSocket()
    }

    fun stop() {
        stopped = true
        canvases.stop()
        calendar.stop()
        tasks.stop()
        ai.stop()
        cancelReconnect()
        stopHeartbeat()
        threadRefresh?.cancel()
        threadRefresh = null
        activityRefresh?.cancel()
        activityRefresh = null
        outboxRetry?.cancel()
        outboxRetry = null
        closeSocket()
        _status.value = EngineStatus.IDLE
    }

    /** Forgets the socket before closing it, so its close callback finds nothing left to act on. */
    private fun closeSocket() {
        val socket = ws ?: return
        ws = null
        socket.close()
    }

    private suspend fun connectSocket() {
        if (stopped || _status.value == EngineStatus.CONNECTING || _status.value == EngineStatus.ONLINE) return
        _status.value = EngineStatus.CONNECTING
        try {
            prepareConnection?.invoke(refreshBeforeConnect)
            refreshBeforeConnect = false
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (e is ApiException.Api && e.isAuth) signOut() else scheduleReconnect()
            return
        }
        if (stopped) return
        val token = getAccessToken()
        if (token == null) {
            signOut()
            return
        }
        val socket = try {
            connect(wsUrl, token)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            scheduleReconnect()
            return
        }
        if (stopped) {
            socket.close()
            return
        }
        val connection = Connection(socket, options.clock())
        ws = socket
        val hello = CompletableDeferred<Boolean>()
        socket.onMessage = { text ->
            connection.lastFrameAt = options.clock() // §5.3: any frame proves the socket alive
            val frame = ServerFrame.parse(text)
            // hello is awaited *inside* the queued bootstrap step, so it must be signalled here, on the
            // transport thread; everything else is applied in order on the work queue.
            if (frame is ServerFrame.Hello) hello.complete(true)
            if (frame != null) post { onFrame(frame, connection) }
        }
        socket.onClose = { code ->
            connection.closeCode = code
            hello.complete(false) // no hello is coming: stop waiting for it
            post { handleClose(connection) }
        }
        socket.send(ClientFrame.auth(token))

        try {
            enqueue {
                if (withTimeoutOrNull(options.helloTimeoutMs) { hello.await() } != true) {
                    throw ApiException.Network(IllegalStateException("no hello"))
                }
                // Frames that arrive from here on are queued behind this step (= buffered, §7.2).
                val bootstrap = api.bootstrap()
                applyBootstrap(bootstrap)
                loadBrowsableChannels()
                currentChannelId?.let { catchUp(it) }
                // §5.3: a socket that went away meanwhile must not leave us "connected" without one.
                if (ws !== socket || connection.closeCode != null) throw ApiException.Network(IllegalStateException("socket closed while connecting"))
                reconnectAttempt = 0
                _status.value = EngineStatus.ONLINE
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // §5.3: drop this connection *before* closing it, so its close callback cannot start a second
            // reconnect loop; if the callback got here first, it has already decided what comes next.
            val code = connection.closeCode
            val ours = ws === socket
            if (ours) {
                ws = null
                stopHeartbeat()
            }
            socket.close()
            if (e is ApiException.Api && e.isAuth) signOut() else if (ours) reconnectAfter(code)
            return
        }
        if (_status.value != EngineStatus.ONLINE) return
        scope.launch { flushOutbox() }
        scope.launch { drafts.flush() } // edited while offline (M15d)
        canvases.online() // M46: canvas saves that failed, open canvases read again, edits kept from before a restart
        calendar.online() // M52: the calendar's ranges on screen and the counts read again (CALENDAR.md §5)
        tasks.online() // M56: the boards, 「自分のタスク」 and the due ranges on screen read again (SYNC_PROTOCOL.md §16)
        ai.online() // M66: the AI status, and the open summary's run read again (docs/AI.md §5)
        // Open the conversation again: its links may have changed while away (M15f), and one opened while this
        // connection was starting (a tap during start-up) skipped its catch-up then; a synced one costs nothing.
        currentChannelId?.let { current -> scope.launch { openChannel(current) } }
        resendReads() // §10: marks that never reached the server
        if (store.threadsLoaded) scheduleThreadRefresh() // the open list may have moved while we were away
    }

    /** §5.3: jittered backoff (1 s, 2 s … 30 s); never more than one reconnect pending. */
    private fun scheduleReconnect() {
        if (stopped || _status.value == EngineStatus.SIGNED_OUT) return
        _status.value = EngineStatus.OFFLINE
        if (reconnectJob != null) return
        reconnectAttempt += 1
        reconnects += 1
        val base = min(options.reconnectMinMs * (1L shl (reconnectAttempt - 1).coerceAtMost(20)), options.reconnectMaxMs)
        val wait = (base * (0.5 + options.random())).toLong()
        // Started only once assigned, so a failure inside connectSocket (which schedules the next attempt) sees it cleared.
        val job = scope.launch(start = CoroutineStart.LAZY) {
            options.sleep(wait)
            reconnectJob = null
            connectSocket()
        }
        reconnectJob = job
        job.start()
    }

    private fun cancelReconnect() {
        reconnectJob?.cancel()
        reconnectJob = null
    }

    /** A connection is gone (§5.3): 4003 signs out, 4001 renews the access token before reconnecting, the rest back off. */
    private fun reconnectAfter(code: Int?) {
        when (code) {
            CLOSE_SESSION_REVOKED -> signOut()
            CLOSE_AUTH_FAILED -> {
                refreshBeforeConnect = true
                scheduleReconnect()
            }
            else -> scheduleReconnect()
        }
    }

    private fun handleClose(connection: Connection) {
        if (ws !== connection.socket) return
        ws = null
        stopHeartbeat()
        reconnectAfter(connection.closeCode)
    }

    private fun signOut() {
        cancelReconnect()
        stopHeartbeat()
        closeSocket()
        _status.value = EngineStatus.SIGNED_OUT
        onSignedOut?.invoke()
    }

    /** Foreground / network change: skip the backoff and catch up the open channel. */
    fun reconnectNow() {
        if (_status.value == EngineStatus.OFFLINE && ws == null) {
            cancelReconnect()
            scope.launch { connectSocket() }
        } else if (_status.value == EngineStatus.ONLINE) {
            currentChannelId?.let { id -> post { catchUp(id) } }
        }
    }

    /**
     * M37 pull to refresh (MOBILE_UI.md §6.1): bootstrap again and catch the open conversation up, as after a reconnect
     * (§7.5); returns when done. Offline or connecting, it reconnects now instead. Nothing depends on it for being
     * correct (the socket and the reconnects are): it is for the reader's peace of mind.
     */
    suspend fun resync() {
        if (_status.value != EngineStatus.ONLINE) {
            reconnectNow()
            return
        }
        enqueue {
            applyBootstrap(api.bootstrap())
            loadBrowsableChannels()
            currentChannelId?.let { catchUp(it) }
        }
    }

    /**
     * A push named a message (PUSH_NOTIFICATIONS.md §9): the push only says new data may exist, so its conversation
     * catches up as well when its row is not here yet (the socket may be half open and the heartbeat has not noticed),
     * besides what [reconnectNow] does. A row already here came over the socket: nothing to fetch. M28c.
     */
    fun pushReceived(channelId: String?, messageId: String?) {
        reconnectNow()
        if (_status.value != EngineStatus.ONLINE || channelId == null || channelId == currentChannelId) return
        if (store.channel(channelId)?.isMember != true) return
        if (messageId != null && store.message(channelId, messageId) != null) return
        post { catchUp(channelId) }
    }

    // --- frames -----------------------------------------------------------------------------

    private suspend fun onFrame(frame: ServerFrame, connection: Connection) {
        when (frame) {
            is ServerFrame.Hello -> if (ws === connection.socket) {
                canvasPresence.reset() // a new connection knows nothing of what the last one said
                startHeartbeat(connection, frame.heartbeatIntervalSec * 1000L)
                // The server counts a new connection as in use (PUSH_NOTIFICATIONS.md §4.1): one that is not says so at
                // once, not a heartbeat later (the reader's pushes were held back meanwhile).
                if (!isActive()) runCatching { connection.socket.send(ClientFrame.ping(false)) }
            }
            ServerFrame.Pong -> Unit // its arrival time is all the heartbeat needs (§5.3)
            // An auth refusal is followed by close 4001 (renew the token) or 4003 (signed out): the close code decides.
            is ServerFrame.Error -> Unit
            is ServerFrame.Event -> applyEvent(frame.frame)
            is ServerFrame.Typing -> {
                // Volatile (SYNC_PROTOCOL.md §5.2): shown for a few seconds, never stored.
                if (frame.userId != store.me?.id) store.noteTyping(frame.channelId, frame.parentId, frame.userId, System.currentTimeMillis() + options.typingTtlMs)
            }
            is ServerFrame.Presence -> store.setPresence(frame.userId, frame.status)
            // M73: volatile 「編集中」 (CANVAS.md §18.2), dropped after 45 s without a refresh.
            is ServerFrame.CanvasPresence -> if (frame.userId != store.me?.id) {
                store.noteCanvasEditing(frame.canvasId, frame.userId, frame.editing, frame.section, System.currentTimeMillis())
            }
        }
    }

    /**
     * §5.3: a ping every interval; a socket that has sent nothing (not even a pong) for two intervals is
     * half-open and gets dropped. The deadline counts from the last frame received, never from the last
     * ping, or a dead socket would look alive for ever (and suppress pushes).
     */
    private fun startHeartbeat(connection: Connection, intervalMs: Long) {
        stopHeartbeat()
        heartbeat = scope.launch {
            val started = options.clock()
            var nextPing = started + intervalMs
            // Silence before the first ping (a slow bootstrap) says nothing about the socket.
            fun lastHeard() = maxOf(connection.lastFrameAt, started)
            while (true) {
                options.timer(maxOf(0L, minOf(nextPing, lastHeard() + intervalMs * 2) - options.clock()))
                if (ws !== connection.socket) return@launch
                val now = options.clock()
                if (now - lastHeard() >= intervalMs * 2) {
                    connection.socket.abort() // the close callback reconnects
                    return@launch
                }
                if (now >= nextPing) {
                    runCatching { connection.socket.send(ClientFrame.ping(isActive())) }
                    nextPing = now + intervalMs
                }
            }
        }
    }

    private fun stopHeartbeat() {
        heartbeat?.cancel()
        heartbeat = null
    }

    private fun applyBootstrap(bootstrap: BootstrapOut) {
        store.setMe(bootstrap.me)
        bootstrap.users.forEach { store.upsertUser(it) }
        val seen = HashSet<String>()
        bootstrap.channels.forEach { channel ->
            seen.add(channel.id)
            // M49: the preview too (null here does mean "no message yet", unlike other responses').
            store.upsertChannel(channel, isMember = true, replaceLastMessage = true)
        }
        store.channels.values.toList().filter { it.isMember && it.id !in seen }.forEach { dropChannel(it.id) }
        reapplyUnsentReads()
        bootstrap.threads?.let { store.setThreadSummary(it) }
        // M39: every connect corrects the activity badge (the events alone may have been missed); none from an older server.
        store.setActivity(bootstrap.activity)
        store.setLimits(bootstrap.limits)
        store.replacePresence(bootstrap.presence)
        store.replaceBookmarks(bootstrap.bookmarks)
        store.replaceFavorites(bootstrap.favorites)
        store.replaceCustomEmoji(bootstrap.customEmoji)
        store.replaceRoster(bootstrap.roster)
        store.replaceGroups(bootstrap.groups)
        store.replaceTemplates(bootstrap.templates)
        store.replaceSidebar(bootstrap.sidebarSections)
        applyWorkspaceSettings(bootstrap.workspaceSettings, live = false) // the reconnect's openChannel loads a preview again
        drafts.applyBootstrap(bootstrap.drafts)
        scope.launch { loadScheduled() }
        scope.launch { loadReminders() }
    }

    /**
     * §10: a read position that moved here but never reached the server (the PUT failed, or the connection dropped
     * first) is applied over the bootstrap's again before it is sent: the server's older position showed the rows
     * unread on every reconnect until the resend's read.updated (M28c; the desktop and iOS do the same). One the server
     * has reached, or of a channel I am no longer in, is forgotten.
     */
    private fun reapplyUnsentReads() {
        store.channels.values.toList().forEach { channel ->
            val seq = channel.unsentReadSeq ?: return@forEach
            if (!channel.isMember || seq <= channel.lastReadSeq) {
                store.updateChannel(channel.id) { it.copy(unsentReadSeq = null) }
                return@forEach
            }
            store.updateChannel(channel.id) {
                if (seq >= it.lastSeq) it.copy(lastReadSeq = seq, unreadCount = 0, mentionCount = 0, firstUnreadAt = null) else it.copy(lastReadSeq = seq)
            }
        }
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

    /**
     * 「すべて既読にする」 (M12a): the server moves every channel; the states apply like read.updated. `scope` "times"
     * (L8, TIMES_FEED.md §4): only the Times feed's channels (my unmuted times).
     */
    suspend fun markAllRead(scope: String? = null) {
        val states = api.readAll(scope)
        enqueue {
            states.forEach {
                applyReadState(it.channelId, ReadStateOut(lastReadSeq = it.lastReadSeq, unreadCount = it.unreadCount, mentionCount = it.mentionCount, firstUnreadAt = it.firstUnreadAt))
            }
        }
    }

    /** The composer changed: tell the other members, at most once per typingIntervalMs per conversation. */
    /**
     * Tells the server now whether the reader is using this device (the app went to the background or came back),
     * not at the next heartbeat: a phone in the background gets its pushes at once (PUSH_NOTIFICATIONS.md §4.1).
     */
    fun reportActivity() {
        val socket = ws ?: return
        if (_status.value != EngineStatus.ONLINE) return
        runCatching { socket.send(ClientFrame.ping(isActive())) }
    }

    /**
     * M73 (CANVAS.md §18.2): I edit this canvas (the editor has the focus and is used; `section` is the caret's heading)
     * or stopped. Repeats go out every 20 s, a new heading after 2 s at most; a stop only after a start went out.
     */
    fun setCanvasEditing(canvasId: String, editing: Boolean, section: String? = null) {
        val socket = ws ?: return
        if (_status.value != EngineStatus.ONLINE) return
        val frame = canvasPresence.next(canvasId, editing, section, options.clock()) ?: return
        runCatching { socket.send(ClientFrame.canvasPresence(frame)) } // volatile: the others drop it after 45 s anyway
    }

    /** M73: the app went to the background: every canvas I said I edit gets its `editing: false`. */
    fun stopCanvasEditing() {
        canvasPresence.editing().forEach { setCanvasEditing(it, false) }
    }

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
        // The one being read as a preview (§7.6.1) stays even when the list no longer has it: an archived channel
        // opened from a link is not listed, and dropping it closed its preview on every reconnect (M28c). A channel
        // that merely went private while open is still dropped (its threads are forgotten, V53).
        val kept = setOfNotNull(store.preview?.channelId, currentChannelId?.takeIf { store.channel(it)?.channel?.archived == true })
        store.channels.values.toList().filter { !it.isMember && it.id !in ids && it.id !in kept }.forEach { dropChannel(it.id) }
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
            "channel.links_updated" -> {
                val id = frame.data.str("channel_id") ?: return
                store.setChannelLinks(id, Codec.snake.decodeFromJsonElement(ListSerializer(ChannelLinkOut.serializer()), frame.data["links"] ?: return))
            }
            "reservation.updated" -> {
                // M99: read the pools again where they are held (a conversation opened so far).
                val id = frame.data.str("channel_id") ?: return
                val poolId = frame.data.str("pool_id")
                if (frame.data.bool("deleted") == true && poolId != null) store.dropReservationPool(id, poolId)
                if (store.holdsPools(id) || id == currentChannelId) scope.launch { loadReservationPools(id) }
            }
            "canvas.created", "canvas.updated", "canvas.deleted" -> canvases.applyEvent(frame.event, frame.data)
            "canvas.mentioned" -> {
                // M77 (CANVAS.md §20.5): the save wrote (or moved) my canvas activity item: the badge and the list on
                // screen read again, collapsed like a message mention.
                store.noteActivity()
                scheduleActivityRefresh()
                maybeNotifyCanvasMention(frame.data)
            }
            // M52 (CALENDAR.md §5): outside the channel seq; the ranges on screen take them.
            "calendar.event.updated", "calendar.event.deleted", "calendar.alarm.updated" -> calendar.applyEvent(frame.event, frame.data)
            // M56 (SYNC_PROTOCOL.md §16): outside the channel seq too; the windows on screen take them.
            "task.updated", "task.deleted", "task.assigned", "task.due", "task.review_done", "task.columns.updated" -> tasks.applyEvent(frame.event, frame.data)
            // M66 (docs/AI.md §5): my summary's run moved on (to me only, outside the channel seq).
            "ai.run_updated" -> ai.applyEvent(frame.event, frame.data)
            "draft.updated" -> drafts.applyEvent(Codec.snake.decodeFromJsonElement(DraftUpdated.serializer(), frame.data))
            "sidebar.updated" -> {
                val rows = Codec.snake.decodeFromJsonElement(ListSerializer(SidebarSectionOut.serializer()), frame.data["sections"] ?: return)
                store.replaceSidebar(rows)
            }
            "group.updated" -> {
                val row = Codec.snake.decodeFromJsonElement(GroupOut.serializer(), frame.data["group"] ?: return)
                store.applyGroup(row, frame.data.bool("deleted") ?: false)
            }
            "template.updated" -> {  // M30: replaced by id, or removed
                val row = Codec.snake.decodeFromJsonElement(TemplateOut.serializer(), frame.data["template"] ?: return)
                store.applyTemplate(row, frame.data.bool("deleted") ?: false)
            }
            "roster.updated" -> {
                // M23: the whole line replaces the old one; a null profile means the person left the roster. The managed
                // groups that follow from it arrive separately as group.updated.
                val userId = frame.data.str("user_id") ?: return
                store.applyRoster(userId, Codec.snake.decodeFromJsonElement(LabProfileOut.serializer().nullable, frame.data["profile"] ?: JsonNull))
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
                store.applyThreadState(withFloor(Codec.snake.decodeFromJsonElement(ThreadState.serializer(), frame.data)))
                scheduleThreadRefresh()
            }
            "channel.created", "channel.updated" -> {
                val channel = Codec.snake.decodeFromJsonElement(ChannelOut.serializer(), frame.data["channel"] ?: return)
                val memberIds = (frame.data["member_ids"] as? JsonArray)?.map { it.jsonPrimitive.content } ?: emptyList()
                val isMember = store.me?.id?.let { it in memberIds } ?: false
                val mine = if (frame.event == "channel.created" && isMember) createdByMe(channel) else channel
                if (isMember || channel.type == "public") store.upsertChannel(mine, isMember = isMember)
                else if (store.channel(channel.id) != null) dropChannel(channel.id) // made private (M15b)
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
                    dropChannel(id)
                } else {
                    store.updateChannel(id) { state -> state.channel.memberCount?.let { state.copy(channel = state.channel.copy(memberCount = maxOf(0, it - 1))) } ?: state }
                }
            }
            "channel.member_updated" -> {
                val id = frame.data.str("channel_id") ?: return
                store.applyMemberUpdated(id, frame.data.str("user_id") ?: return, frame.data.str("role") ?: return)
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
                val pref = runCatching { Codec.snake.decodeFromJsonElement(NotificationPreferenceOut.serializer(), frame.data) }.getOrNull()
                    ?: NotificationPreferenceOut(channelId, frame.data.str("level") ?: NotificationLevels.MENTIONS, frame.data.str("muted_until"))
                store.setNotification(pref.copy(channelId = channelId))
            }
            // M39 (SYNC_PROTOCOL.md §6): someone reacted to my message, or my read position moved on another device.
            "reaction.added" -> {
                store.noteActivity()
                scheduleActivityRefresh()
            }
            "activity.read" -> scheduleActivityRefresh()
            // Review v0.1.22 (CANVAS.md §20.8): items I may hold changed in place (an erased canvas version blanked their
            // excerpts). The badge does not change: the rows shown drop the excerpt and the list reads its first page again.
            "activity.updated" -> {
                val ids = (frame.data["item_ids"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content } ?: return
                store.blankActivityExcerpts(ids)
            }
            "session.revoked" -> signOut()
            // M88 (MEMBERSHIP.md §3): an admin changed a switch; the open preview follows at once (§5 item 5).
            "workspace.settings_updated" -> {
                val settings = Codec.snake.decodeFromJsonElement(WorkspaceSettingsOut.serializer(), frame.data["settings"] ?: return)
                applyWorkspaceSettings(settings, live = true)
            }
        }
    }

    /**
     * M89 (MEMBERSHIP.md §5 item 5): the workspace switches from bootstrap or workspace.settings_updated. The preview turned
     * off drops the rows of the one held (its screen shows the join panel); turned back on, the panel's preview is read
     * again (live: now, if it is the open conversation; after a bootstrap the reconnect's openChannel does it).
     */
    private fun applyWorkspaceSettings(value: WorkspaceSettingsOut, live: Boolean) {
        store.setWorkspaceSettings(value)
        val held = store.preview ?: return
        if (!value.previewBeforeJoin && !held.disabled) {
            // Pages and threads still on their way are stale now (Review v0.1.22 #6).
            replacePreview(ChannelPreview(held.channelId, disabled = true))
        } else if (value.previewBeforeJoin && held.disabled) {
            replacePreview(null)
            if (live && currentChannelId == held.channelId && _status.value == EngineStatus.ONLINE) scope.launch { loadPreview(held.channelId) }
        }
    }

    // --- §7.4 live timeline events -----------------------------------------------------------

    /**
     * L8: an event for [timelineEvents] while someone collects it, of a times I am in (the feed reads no other channel).
     * A full buffer loses it: [timelineStale] then says the list must be read again.
     */
    private fun emitTimeline(channelId: String, event: TimelineEvent) {
        if (_timelineEvents.subscriptionCount.value == 0) return
        val channel = store.channel(channelId) ?: return
        if (!channel.isMember || channel.channel.timesOwnerId == null) return
        if (!_timelineEvents.tryEmit(event)) _timelineStale.value += 1
    }

    private suspend fun applyTimelineEvent(frame: EventFrame) {
        val channelId = frame.channelId ?: return
        val seq = frame.seq ?: return
        val channel = store.channel(channelId) ?: return
        val message = Codec.snake.decodeFromJsonElement(MessageOut.serializer(), frame.data["message"]?.jsonObject ?: return)
        val thread = (frame.data["parent_thread"] as? JsonObject)?.let { Codec.snake.decodeFromJsonElement(ParentThread.serializer(), it) }
        val isNew = frame.event == "message.created"
        emitTimeline(channelId, TimelineEvent(frame.event, message, thread))
        val synced = channel.syncedSeq
        // M39: a mention of me or a reply in a thread I follow is an activity item (not an event applied already).
        if (isNew && (synced == null || seq > synced) && ActivityRules.isActivity(message, store.me, thread, message.parentId?.let { store.threads[it]?.state?.following } == true)) {
            store.noteActivity()
            scheduleActivityRefresh()
        }
        when {
            synced == null -> {
                // §7.4: no timeline here, but rows already held (an open thread's parent and replies) follow the event.
                if (holds(channelId, message)) {
                    store.upsertMessage(message)
                    if (thread != null) store.applyParentThread(channelId, thread)
                } else {
                    store.applyLastMessage(MessageState.from(message)) // M49: the DM list's preview moves without a timeline too (§7.8)
                }
                store.updateChannel(channelId) { it.advancedTo(seq, message, isNew) }
                if (isNew) { countUnread(message); maybeNotify(message, channel, thread) }
            }
            seq == synced + 1 -> {
                store.upsertMessage(message)
                if (thread != null) store.applyParentThread(channelId, thread)
                store.updateChannel(channelId) { it.advancedTo(seq, message, isNew).copy(syncedSeq = seq) }
                if (isNew) { countUnread(message); maybeNotify(message, channel, thread) }
                trimIfFull(channelId)
            }
            seq > synced + 1 -> {
                store.updateChannel(channelId) { it.advancedTo(seq, message, isNew) }
                // The rows the catch-up brings after the last seq known before this event (this one too) were never counted.
                catchUp(channelId, countedTo = channel.lastSeq)
                trimIfFull(channelId)
                if (isNew) { store.clearTyping(message.channelId, message.parentId, message.senderId); maybeNotify(message, channel, thread) }
            }
            // seq <= synced: already applied
        }
    }

    /** Whether the store holds rows this message goes with: the row itself, or its thread's parent or replies (§7.4). */
    private fun holds(channelId: String, message: MessageOut): Boolean {
        if (store.message(channelId, message.id) != null) return true
        val parentId = message.parentId ?: return false
        return store.message(channelId, parentId) != null || store.replies(channelId, parentId).isNotEmpty()
    }

    /**
     * lastSeq moves up; a new message in the timeline (a top-level post, or a reply also sent to the channel, M15c) also
     * moves lastMessageAt, which orders the DM list (§7.4; the desktop and iOS count the shared reply too, M28c).
     */
    private fun ChannelState.advancedTo(seq: Int, message: MessageOut, isNew: Boolean): ChannelState {
        val moved = copy(lastSeq = maxOf(lastSeq, seq))
        val inTimeline = message.parentId == null || message.alsoInChannel
        // M88: a join / leave line does not move it either (the server keeps last_message_at; the 「最近」 order stays).
        if (!isNew || !inTimeline || message.type != "user" || !isLater(message.createdAt, channel.lastMessageAt)) return moved
        return moved.copy(channel = channel.copy(lastMessageAt = message.createdAt))
    }

    private fun isLater(time: String, than: String?): Boolean {
        if (than == null) return true
        val a = runCatching { java.time.Instant.parse(time) }.getOrNull()
        val b = runCatching { java.time.Instant.parse(than) }.getOrNull()
        return if (a != null && b != null) a.isAfter(b) else time > than
    }

    /**
     * §7.4 / §10.1 rule 12: someone else's message is unread until read.updated says otherwise, and only where the
     * server counts it. My own never moves the read position here (rule 11): a post from this device moves it with
     * its POST response ([readByOwnPost]), one from another device is followed by read.updated, and a scheduled send
     * (M12d) does not read the channel at all, so moving here would put the position ahead of the server's.
     */
    private fun countUnread(message: MessageOut) {
        store.clearTyping(message.channelId, message.parentId, message.senderId) // their message arrived: no longer typing
        countAsUnread(message)
    }

    private fun countAsUnread(message: MessageOut) {
        val me = store.me ?: return
        if (message.deleted || message.senderId == me.id) return
        if (message.isReply && !message.alsoInChannel) return // replies are not unread items unless also sent to the channel (M15c)
        if (message.type != "user") return // nor are system messages (the server counts the same way)
        store.updateChannel(message.channelId) { channel ->
            if (!channel.isMember || message.seq <= channel.lastReadSeq) channel // a public channel only browsed has no read state
            else channel.copy(
                unreadCount = channel.unreadCount + 1,
                mentionCount = channel.mentionCount + if (message.mentions(me.id, me.notifyKeywords)) 1 else 0,
                // §10.1: the banner's 「… 以降」 starts at the first unread; later ones keep it.
                firstUnreadAt = if (channel.unreadCount == 0) message.createdAt else channel.firstUnreadAt,
            )
        }
    }

    private fun applyReadState(channelId: String, state: ReadStateOut, allowDecrease: Boolean = false) {
        // Advances merge with max (an event for an older PUT may arrive after a newer local mark);
        // a mark-as-unread (reason "set") moves the position down as well and replaces any mark not sent yet.
        val updated = store.updateChannel(channelId) {
            it.copy(
                lastReadSeq = if (allowDecrease) state.lastReadSeq else maxOf(it.lastReadSeq, state.lastReadSeq),
                unreadCount = state.unreadCount,
                mentionCount = state.mentionCount,
                firstUnreadAt = state.firstUnreadAt,
                unsentReadSeq = if (allowDecrease) null else it.unsentReadSeq?.takeIf { s -> s > state.lastReadSeq },
            )
        } ?: return
        if (updated.unreadCount == 0) onRead?.invoke(channelId)
    }

    /**
     * M73 (CANVAS.md §18.1): canvas.mentioned (to me only) — said while the app is open unless the conversation's level is
     * 「なし」 or it is muted (a mention: 「メンションのみ」 says it too). Not from myself; not for a conversation I left.
     */
    private fun maybeNotifyCanvasMention(data: JsonObject) {
        val mention = runCatching { Codec.snake.decodeFromJsonElement(jp.chikuwachat.android.api.CanvasMentioned.serializer(), data) }.getOrNull() ?: return
        val me = store.me ?: return
        if (mention.byUserId == me.id) return
        val channel = store.channel(mention.channelId) ?: return
        if (!channel.isMember) return
        if (!NotificationLevels.notifies(channel, me.notificationDefault, me.id, involved = true)) return
        onCanvasMention?.invoke(mention, channel)
    }

    /**
     * DMs always notify; channels by their level, a reply only in its thread only when I follow it or it names me (and
     * never once I unfollowed it by hand). The server's PushPlanner rule (PUSH_NOTIFICATIONS.md §4, notify-rules.json).
     */
    private fun maybeNotify(message: MessageOut, channel: ChannelState, thread: ParentThread? = null) {
        val me = store.me ?: return
        if (message.senderId == me.id) return
        // M89: a join / leave line never notifies (facts.system; notify-rules.json system_messages).
        // The level resolved with my overall setting (M35), and a mute.
        val followingHeld = message.parentId?.let { store.threads[it]?.state?.following } == true
        val facts = NotificationLevels.facts(message, me.id, me.notifyKeywords, thread, followingHeld)
        if (!NotificationLevels.notifies(channel, me.notificationDefault, me.id, facts)) return
        if (isActive() && currentChannelId == channel.id) return
        onNotify?.invoke(message, channel)
    }

    /**
     * Opening a thread: fetch its replies. Live ones keep arriving as timeline events, also in a channel
     * whose timeline is not loaded (§7.4), because the parent (from the threads list) and the replies are held.
     */
    suspend fun loadReplies(channelId: String, parentId: String): Boolean {
        var loaded = false
        enqueue {
            if (_status.value != EngineStatus.ONLINE) return@enqueue
            store.threads[parentId]?.parent?.let { store.upsertMessage(it) }
            api.replies(parentId).forEach { store.upsertMessage(it) }
            completeThreads[parentId] = channelId
            loaded = true
        }
        return loaded
    }

    /**
     * §10.2: the whole thread was fetched here. Until then only some replies may be held (the new ones that
     * arrived live), so reading the visible ones could skip older unread replies never loaded.
     */
    fun threadComplete(parentId: String): Boolean = parentId in completeThreads

    /** A channel's local rows are gone (§7.3 reload, removed from it): its threads must be fetched again. */
    private fun forgetThreads(channelId: String) {
        completeThreads.values.removeAll { it == channelId }
    }

    /**
     * M32: channel.created carries no per-user membership. A channel (not a DM or group DM) I created on another device
     * arrives here without one, and owner-only actions would stay hidden until the next bootstrap; its creator is its
     * first owner, so it is one here too (joined when it was made). A membership already known is left alone.
     */
    private fun createdByMe(channel: ChannelOut): ChannelOut {
        val me = store.me?.id ?: return channel
        if (channel.type == "dm" || channel.type == "group_dm" || channel.createdBy != me) return channel
        if (channel.membership != null || store.channel(channel.id)?.channel?.membership != null) return channel
        return channel.copy(membership = MembershipOut("owner", channel.createdAt))
    }

    /** The channel leaves this device (I left it, it was made private, it is no longer browsable). */
    fun dropChannel(channelId: String) {
        forgetThreads(channelId)
        canvases.removeChannel(channelId)
        calendar.removeChannel(channelId) // M52: its shared calendar leaves every range (CALENDAR.md §3)
        tasks.removeChannel(channelId) // M56: its board closes, its tasks leave 「自分のタスク」 and the calendar
        store.removeChannel(channelId)
    }

    /** How many §7.3 reloads replaced the channel's local rows; the open view keys its position on it. */
    fun reloadCount(channelId: String): Int = reloadsByChannel[channelId] ?: 0

    // --- §7.3 catch_up --------------------------------------------------------------------------

    suspend fun openChannel(channelId: String) {
        val previous = currentChannelId
        currentChannelId = channelId
        if (previous != null && previous != channelId) trimLater(previous) // §7.7: the conversation just left
        unreadHold.keys.filter { it != channelId }.forEach { unreadHold.remove(it) }
        // §7.6.1: a preview goes when another conversation opens, or when this one was joined meanwhile.
        val previewing = store.channel(channelId)?.isMember == false
        store.preview?.let { held -> if (held.channelId != channelId || !previewing) replacePreview(null) }
        if (_status.value != EngineStatus.ONLINE) return
        if (previewing) {
            loadPreview(channelId)
            return
        }
        scope.launch { loadLinks(channelId) }
        scope.launch { loadReservationPools(channelId) } // M99
        scope.launch { canvases.loadList(channelId) } // M46 (CANVAS.md §4.6)
        enqueue {
            val channel = store.channel(channelId) ?: return@enqueue
            if (channel.syncedSeq == null || channel.syncedSeq < channel.lastSeq) catchUp(channelId)
            // Only the visible timeline advances read state.
        }
    }

    /**
     * The conversation was closed without another opening (M28c; iOS closeChannel): nothing is open, so its rows may be
     * trimmed (§7.7 rule 2), its notices show again on the list, a 「ここから未読にする」 hold ends as when another
     * conversation opens (§10), a preview goes (§7.6.1), and the next reconnect does not open it again.
     */
    fun closeConversation() {
        closePreview()
        val previous = currentChannelId ?: return
        currentChannelId = null
        unreadHold.clear()
        trimLater(previous)
    }

    /**
     * 「ここから未読にする」: seq - 1 becomes the position here and on the server (mode=set) at once. Returns the
     * position it holds (the divider goes there), null when nothing happened.
     */
    fun markUnread(channelId: String, seq: Int): Int? {
        if (_status.value != EngineStatus.ONLINE || seq < 1) return null
        val channel = store.channel(channelId) ?: return null
        if (!channel.isMember) return null
        // §10.1: moving forward would read the rows before `seq`, and unread rows this device never loaded may be
        // among them (the row can also be a search hit's context). They and this row stay unread; reading pauses.
        if (!ReadGate.markUnreadOffered(channel, seq)) {
            unreadHold[channelId] = channel.lastReadSeq
            return channel.lastReadSeq
        }
        val target = seq - 1
        unreadHold[channelId] = target
        pendingReads.remove(channelId)?.cancel()
        val me = store.me
        // The rows the server counts (rule 12): store.messages holds timeline rows only (top-level or also_in_channel).
        val later = store.messages(channelId).filter { (it.seq ?: 0) > target && it.senderId != me?.id && it.type == "user" }
        store.updateChannel(channelId) {
            it.copy(
                lastReadSeq = target,
                unreadCount = later.size,
                mentionCount = later.count { m -> me != null && (m.mentionAll || me.id in m.mentionedUserIds || hitsKeyword(m.body, me.notifyKeywords)) },
                firstUnreadAt = later.firstOrNull()?.createdAt,
                unsentReadSeq = null, // the set replaces a mark not sent yet
            )
        }
        pendingReads[channelId] = scope.launch {
            val state = try { api.setReadPosition(channelId, target) } catch (e: CancellationException) { throw e } catch (e: Exception) { null }
            if (state != null) post { applyReadState(channelId, state, allowDecrease = true) }
        }
        return target
    }

    /**
     * §10: move the local position at once (monotonic), then PUT after a debounce; the server's answer wins.
     * Until the server confirms it the mark stays in the channel state (persisted), and is sent again after
     * reconnecting, so a lost PUT never leaves a channel that cannot be read.
     */
    fun markRead(channelId: String, seq: Int, force: Boolean = false) {
        if (_status.value != EngineStatus.ONLINE || !isActive()) return
        if (force) unreadHold.remove(channelId) else if (unreadHold.containsKey(channelId)) return
        val channel = store.channel(channelId) ?: return
        // §10.1: a visible row past unread rows this device never loaded does not read them; only an explicit
        // read (Esc, 「既読にする」) goes to the end regardless.
        if (!force && !ReadGate.readRangeReady(channel)) return
        if (!channel.isMember || seq <= channel.lastReadSeq) return
        store.updateChannel(channelId) {
            val moved = if (seq >= it.lastSeq) it.copy(lastReadSeq = seq, unreadCount = 0, mentionCount = 0, firstUnreadAt = null) else it.copy(lastReadSeq = seq)
            moved.copy(unsentReadSeq = maxOf(it.unsentReadSeq ?: 0, seq))
        }
        sendRead(channelId, debounce = true)
    }

    /** §10.1: every unread row of the channel is held, so visible-range reads can move the position. */
    fun readRangeReady(channelId: String): Boolean = store.channel(channelId)?.let { ReadGate.readRangeReady(it) } ?: false

    /** PUT the channel's unconfirmed read mark; a temporary failure keeps it for the next reconnect. */
    private fun sendRead(channelId: String, debounce: Boolean) {
        pendingReads.remove(channelId)?.cancel()
        pendingReads[channelId] = scope.launch {
            if (debounce) options.sleep(options.readDebounceMs)
            val target = store.channel(channelId)?.unsentReadSeq ?: return@launch
            val state = try {
                api.markRead(channelId, target)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // Refused for good (no longer a member …): forget it. Otherwise it waits for the reconnect.
                if (e.isRefusal()) store.updateChannel(channelId) { it.copy(unsentReadSeq = null) }
                return@launch
            }
            post {
                store.updateChannel(channelId) { if ((it.unsentReadSeq ?: 0) <= target) it.copy(unsentReadSeq = null) else it }
                applyReadState(channelId, state)
            }
        }
    }

    /** §10: read marks that never reached the server (PUT failed, or the connection dropped first) go out again. */
    private fun resendReads() {
        store.channels.values.filter { it.unsentReadSeq != null }.forEach { sendRead(it.id, debounce = false) }
        unsentThreadReads.keys.toList().forEach { sendThreadRead(it, debounce = false) }
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
        // §10.2: a list refresh (every thread.updated schedules one) must not lower a position read here and still on
        // its way, nor drop the state of a thread on screen (its read gate needs it).
        val items = page.items.map { it.copy(state = withFloor(it.state)) }
        store.setThreadPage(filter, items, page.nextCursor, append = cursor != null, pageSize = options.threadPageSize, keep = shownThreads)
        store.setThreadSummary(page.summary)
    }

    /** A ThreadPane shows the thread (or no longer does): a list refresh keeps its state even when the server no longer lists it. */
    fun threadShown(parentId: String, shown: Boolean) {
        if (shown) shownThreads.add(parentId) else shownThreads.remove(parentId)
    }

    /** A thread opened from a channel: fetch my relation to it (follow flag, read position). */
    suspend fun loadThreadState(parentId: String, parent: MessageOut? = null) = enqueue {
        if (_status.value != EngineStatus.ONLINE) return@enqueue
        store.applyThreadState(withFloor(api.threadState(parentId)), parent)
    }

    /** A server state, but never behind what this device has read (its PUT may still be on the way, or waiting to be resent). */
    private fun withFloor(state: ThreadState): ThreadState {
        val floor = threadReadFloor[state.parentId] ?: return state
        return if (floor > state.lastReadSeq) state.copy(lastReadSeq = floor) else state
    }

    /** The reply with `seq` was shown: the thread position moves now (monotonic) and is sent after a debounce. */
    fun markThreadRead(parentId: String, seq: Int) {
        if (_status.value != EngineStatus.ONLINE || !isActive()) return
        if (!threadComplete(parentId)) return // §10.2: older unread replies may not be loaded yet
        val current = maxOf(store.threads[parentId]?.state?.lastReadSeq ?: 0, threadReadFloor[parentId] ?: 0)
        if (seq <= current) return
        threadReadFloor[parentId] = seq
        unsentThreadReads[parentId] = seq
        store.threads[parentId]?.state?.let { state ->
            val newest = store.replies(state.channelId, parentId).mapNotNull { it.seq }.maxOrNull() ?: 0
            store.applyThreadState(if (seq >= newest) state.copy(lastReadSeq = seq, unreadCount = 0, mentionCount = 0) else state.copy(lastReadSeq = seq))
        }
        sendThreadRead(parentId, debounce = true)
    }

    /** PUT the thread's unconfirmed read mark; like [sendRead], a temporary failure keeps it for the reconnect (§10). */
    private fun sendThreadRead(parentId: String, debounce: Boolean) {
        val key = "thread:$parentId"
        pendingReads.remove(key)?.cancel()
        pendingReads[key] = scope.launch {
            if (debounce) options.sleep(options.readDebounceMs)
            val target = unsentThreadReads[parentId] ?: return@launch
            val state = try {
                api.markThreadRead(parentId, target)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (e.isRefusal()) unsentThreadReads.remove(parentId)
                return@launch
            }
            if ((unsentThreadReads[parentId] ?: 0) <= target) unsentThreadReads.remove(parentId)
            post { store.applyThreadState(withFloor(state)) }
        }
    }

    suspend fun setThreadFollow(parentId: String, following: Boolean) = enqueue {
        if (_status.value != EngineStatus.ONLINE) return@enqueue
        store.applyThreadState(withFloor(api.setThreadFollow(parentId, following)))
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

    /**
     * M39: the activity badge is read again shortly after the events that move it (a burst of them, one request). Not
     * against a server before M39 (no badge came with bootstrap, and it sends none of these events anyway).
     */
    private fun scheduleActivityRefresh() {
        if (store.activity == null || api !is ActivityApi) return
        activityRefresh?.cancel()
        activityRefresh = scope.launch {
            options.sleep(options.activityRefreshMs)
            if (_status.value == EngineStatus.ONLINE) refreshActivity()
        }
    }

    /** GET /activity/summary into the store; a failure keeps the last badge (the next connect's bootstrap corrects it). */
    suspend fun refreshActivity() {
        val activityApi = api as? ActivityApi ?: return
        runCatching { activityApi.activitySummary() }.onSuccess { store.setActivity(it) }
    }

    /** Waits for the debounced activity refresh (tests). */
    suspend fun flushActivity() {
        activityRefresh?.join()
    }

    /** Waits for the debounced thread refresh and read marks (tests). */
    suspend fun flushThreads() {
        threadRefresh?.join()
        flushReads()
    }

    /**
     * §7.3. The unread count covers the rows up to `countedTo` (the last seq known from bootstrap and counted live
     * events). The rows the catch-up brings past it, up to the new synced seq, are counted here: their events, if they
     * come at all, are stale by then (a gap, a post during the reconnect's bootstrap). A row past the synced seq
     * (committed while the page was read, §4.3) is left to its event, which still applies in order. Kept on purpose
     * (M28c): the desktop and iOS count the gap event's own row only and end one short of the server's count until
     * the next bootstrap (no read.updated comes for a row nobody read); UnreadRangeTest pins the parity here.
     */
    suspend fun catchUp(channelId: String, countedTo: Int? = null) {
        catchUps += 1
        // A public channel only browsed has no timeline here: its preview (§7.6.1) is read apart and never synced.
        val channel = store.channel(channelId)?.takeIf { it.isMember } ?: return
        val counted = countedTo ?: channel.lastSeq
        val brought = LinkedHashMap<String, MessageOut>() // by id: a row changed between two delta pages counts once, as it is now
        try {
            catchUpRows(channelId, channel, brought)
        } finally {
            val synced = store.channel(channelId)?.syncedSeq ?: counted
            brought.values.filter { it.seq > counted && it.seq <= synced }.sortedBy { it.seq }.forEach { countAsUnread(it) }
        }
    }

    private suspend fun catchUpRows(channelId: String, start: ChannelState, brought: MutableMap<String, MessageOut>) {
        var channel = start
        val synced = channel.syncedSeq
        if (synced != null && channel.lastSeq - synced > options.gapLimit) {
            forgetThreads(channelId)
            reloadsByChannel[channelId] = reloadCount(channelId) + 1 // before the rows go, so a view never sees them gone unannounced
            store.clearMessages(channelId)
            channel = store.updateChannel(channelId) { it.copy(syncedSeq = null, hasOlder = true, oldestLoadedSeq = null) } ?: channel
            reloads += 1
        }
        var since = channel.syncedSeq
        if (since == null) {
            val page = api.history(channelId, null, options.pageSize)
            page.messages.forEach { store.upsertMessage(it); brought[it.id] = it }
            store.updateChannel(channelId) {
                it.copy(
                    syncedSeq = page.channelLastSeq, lastSeq = maxOf(it.lastSeq, page.channelLastSeq), hasOlder = page.hasMore,
                    oldestLoadedSeq = oldestOf(page), // §7.3: the timeline starts here
                )
            }
            return
        }
        while (true) {
            val delta = api.delta(channelId, since!!, options.deltaLimit)
            delta.messages.forEach { store.upsertMessage(it); brought[it.id] = it }
            since = delta.nextSinceSeq
            store.updateChannel(channelId) { it.copy(syncedSeq = delta.nextSinceSeq, lastSeq = maxOf(it.lastSeq, delta.nextSinceSeq)) }
            if (!delta.hasMore) return
        }
    }

    /**
     * Scroll-up pagination (§7.3): the page before `oldestLoadedSeq`. Older rows that arrived from outside
     * the loaded range (a thread parent bumped by a reply, a reaction on an old message) are stored but never
     * used as the cursor, or the messages in between would never be loaded.
     */
    suspend fun loadOlder(channelId: String) = enqueue {
        if (_status.value != EngineStatus.ONLINE) return@enqueue
        val channel = store.channel(channelId) ?: return@enqueue
        val before = channel.oldestLoadedSeq ?: return@enqueue // the latest page comes first (catch_up)
        if (!channel.hasOlder || before == 0) return@enqueue
        val page = api.history(channelId, before, options.pageSize)
        page.messages.forEach { store.upsertMessage(it) }
        store.updateChannel(channelId) { it.copy(hasOlder = page.hasMore, oldestLoadedSeq = oldestOf(page)) }
    }

    /**
     * 「最初の未読へ」 (§10.1 rule 6): pages backwards from the loaded range, like [loadOlder] but 200 rows at a time,
     * until it reaches the read position as it was when pressed. At most JUMP_MAX_PAGES pages per call; true once
     * covered (pressing again goes on from where it stopped). Paging backwards keeps the one contiguous range.
     */
    suspend fun loadFirstUnread(channelId: String): Boolean {
        val target = store.channel(channelId)?.lastReadSeq ?: return false
        var covered = false
        enqueue {
            var pages = 0
            while (true) {
                val channel = store.channel(channelId) ?: return@enqueue
                val oldest = channel.oldestLoadedSeq
                if (ReadGate.covers(oldest, target)) break
                // null: the latest page has not arrived yet (catch_up comes first on this queue).
                if (oldest == null || oldest <= 0 || !channel.hasOlder || pages >= ReadGate.JUMP_MAX_PAGES) break
                if (_status.value != EngineStatus.ONLINE || currentChannelId != channelId) break
                val page = api.history(channelId, oldest, ReadGate.JUMP_PAGE_SIZE)
                page.messages.forEach { store.upsertMessage(it) }
                store.updateChannel(channelId) { it.copy(hasOlder = page.hasMore, oldestLoadedSeq = oldestOf(page)) }
                pages += 1
            }
            covered = ReadGate.covers(store.channel(channelId)?.oldestLoadedSeq, target)
        }
        return covered
    }

    // --- §7.6.1 preview before joining -------------------------------------------------------------

    /**
     * A public channel I have not joined, opened to read (§7.6.1): the latest page of GET /channels/{id}/messages goes
     * into the store's preview, in memory only. No cursor, read position or unread; nothing persisted, no read mark,
     * no typing. Not on the work queue: it touches none of the synced state, and a slow page must not hold live
     * events back. Opening it again while its rows are held (a reconnect) keeps them; a failed load is tried again.
     * Guests never preview (SECURITY.md §3.2; the server refuses too).
     */
    private suspend fun loadPreview(channelId: String) {
        if (store.me?.role == "guest") return
        // M89 (MEMBERSHIP.md §5 item 5): the workspace turned the preview off: no history, the join panel.
        if (!store.workspaceSettings.previewBeforeJoin) {
            replacePreview(ChannelPreview(channelId, disabled = true))
            return
        }
        val held = store.preview?.takeIf { it.channelId == channelId && !it.disabled }
        if (held?.loaded == true) return
        if (held == null) replacePreview(ChannelPreview(channelId))
        val gen = previewGen
        val page = try {
            api.history(channelId, null, options.pageSize)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // Closed, turned off or refused meanwhile: nobody is looking at this answer (Review v0.1.22 #6).
            if (!previewCurrent(channelId, gen)) return
            // Turned off while this device did not hear of it (offline): the same panel as from the setting.
            if (e is ApiException.Api && e.code == PREVIEW_DISABLED) refusePreview(channelId)
            else store.updatePreview(channelId) { it.copy(failed = true) }
            return
        }
        if (!previewCurrent(channelId, gen)) return
        store.updatePreview(channelId) { it.withPage(page, older = false) }
    }

    /** §7.6.1: the page before the preview's oldest row, as the reader scrolls up. */
    suspend fun loadOlderPreview(channelId: String) {
        if (_status.value != EngineStatus.ONLINE) return
        val gen = previewGen
        if (!previewCurrent(channelId, gen)) return
        val held = store.preview?.takeIf { it.channelId == channelId && it.loaded && it.hasOlder } ?: return
        val before = held.oldestSeq ?: return
        val page = try {
            api.history(channelId, before, options.pageSize)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (!previewCurrent(channelId, gen)) return // stale: no rows, no toast (Review v0.1.22 #6)
            if (e is ApiException.Api && e.code == PREVIEW_DISABLED) return refusePreview(channelId)
            throw e
        }
        if (!previewCurrent(channelId, gen)) return
        store.updatePreview(channelId) { it.withPage(page, older = true) }
    }

    /**
     * §7.6.1: a thread opened from a preview, read-only: its replies go into the preview too (a reply's parent is
     * among the preview rows, or the context a link brought). A thread opened before the page arrived starts the preview;
     * replies that come back after the preview was closed, turned off or refused are dropped (Review v0.1.22 #6).
     */
    suspend fun loadPreviewReplies(channelId: String, parentId: String) {
        if (_status.value != EngineStatus.ONLINE || store.channel(channelId)?.isMember != false) return
        if (!store.workspaceSettings.previewBeforeJoin || store.preview?.takeIf { it.channelId == channelId }?.disabled == true) return
        if (store.preview?.channelId != channelId) replacePreview(ChannelPreview(channelId))
        val gen = previewGen
        val replies = try {
            api.replies(parentId).filter { !it.deleted }.map { MessageState.from(it) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (!previewCurrent(channelId, gen)) return
            if (e is ApiException.Api && e.code == PREVIEW_DISABLED) return refusePreview(channelId)
            throw e
        }
        if (!previewCurrent(channelId, gen)) return
        store.updatePreview(channelId) { it.copy(replies = it.replies + (parentId to replies)) }
    }

    /** The previewed conversation closed: its rows go (§7.6.1). */
    fun closePreview() = replacePreview(null)

    /**
     * Review v0.1.22 #6 (MEMBERSHIP.md §4): the preview's load generation. Bumped whenever the preview is replaced (opened,
     * closed, turned off or back on) and when the server refuses it: a page or thread asked for before then writes nothing
     * back when it arrives (no rows, no `disabled = false`, no toast).
     */
    private var previewGen = 0

    private fun replacePreview(value: ChannelPreview?) {
        previewGen += 1
        store.setPreview(value)
    }

    /** An answer for the preview of `channelId` asked for at `gen` may still be written: same preview, setting still on. */
    private fun previewCurrent(channelId: String, gen: Int): Boolean =
        gen == previewGen && store.workspaceSettings.previewBeforeJoin && store.preview?.let { it.channelId == channelId && !it.disabled } == true

    /** The server refused the preview (403 preview_disabled): the join panel, and anything else on its way is stale. */
    private fun refusePreview(channelId: String) {
        if (store.preview?.channelId == channelId) replacePreview(ChannelPreview(channelId, disabled = true))
    }

    /** The oldest seq a history page reaches; 0 once nothing older is left. */
    private fun oldestOf(page: HistoryOut): Int = if (page.hasMore) page.messages.minOfOrNull { it.seq } ?: 0 else 0

    // --- §7.7 cap on held messages ----------------------------------------------------------------

    /**
     * §7.7: a view of the channel's rows other than the open conversation (a thread pane) keeps them whole until the
     * returned function releases it. Releasing twice counts once.
     */
    fun viewing(channelId: String): () -> Unit {
        views[channelId] = (views[channelId] ?: 0) + 1
        var released = false
        return release@{
            if (released) return@release
            released = true
            val left = (views[channelId] ?: 1) - 1
            if (left > 0) {
                views[channelId] = left
            } else {
                views.remove(channelId)
                trimLater(channelId)
            }
        }
    }

    /** The open conversation, or a channel a thread pane shows (§10.1 rule 9: reading must not lose its rows). */
    private fun shown(channelId: String): Boolean = channelId == currentChannelId || channelId in views

    /** §7.7, on the work queue: after any page still loading for the channel (a page landing after the trim would leave a gap). */
    private fun trimLater(channelId: String) = post { trim(channelId) }

    /** Live rows piling up in a channel nobody looks at: trimmed once they pass the cap by a margin (not on every row). */
    private fun trimIfFull(channelId: String) {
        if (store.heldCount(channelId) > CACHED_MESSAGES_PER_CHANNEL + TRIM_MARGIN) trim(channelId)
    }

    /** Runs on the work queue only; the channel may have been opened again since the trim was queued. */
    private fun trim(channelId: String) {
        if (shown(channelId)) return
        // A thread whose older replies went is no longer complete (§10.2): opening it fetches them again.
        if (store.trimMessages(channelId)) forgetThreads(channelId)
    }

    // --- §9 optimistic send -------------------------------------------------------------------

    suspend fun send(
        channelId: String, body: String, clientMsgId: String? = null, parentId: String? = null, attachmentIds: List<String> = emptyList(),
        sendOptions: SendOptions = SendOptions(),
    ) {
        val key = clientMsgId ?: options.newId()
        val createdAt = options.now()
        val shared = sendOptions.alsoInChannel && parentId != null // M15c: only replies can also go to the channel
        val priority = if (parentId == null) sendOptions.priority else null // M15e: top-level posts only
        val ackRequested = parentId == null && sendOptions.ackRequested
        store.addOutbox(OutboxItem(key, channelId, body, createdAt, parentId = parentId, attachmentIds = attachmentIds, alsoInChannel = shared,
            priority = priority, ackRequested = ackRequested))
        store.putPlaceholder(MessageState.placeholder(key, channelId, store.me?.id ?: "", body, createdAt, parentId, alsoInChannel = shared,
            priority = priority, ackRequested = ackRequested))
        flushOutbox()
    }

    /** 「再送」 on one failed message: that message only (others stay failed until their own 再送). */
    suspend fun retryFailed(clientMsgId: String) {
        if (store.outbox.any { it.clientMsgId == clientMsgId && it.failed != null }) store.markOutboxFailed(clientMsgId, null)
        flushOutbox()
    }

    fun discardFailed(clientMsgId: String) {
        val item = store.outbox.firstOrNull { it.clientMsgId == clientMsgId } ?: return
        store.upsertMessage(MessageState(id = LOCAL_PREFIX + clientMsgId, channelId = item.channelId, senderId = "", seq = null, updatedSeq = Int.MAX_VALUE, clientMsgId = null, body = "", createdAt = "", deleted = true))
        store.removeOutbox(clientMsgId)
    }

    /**
     * Sends queued messages one at a time, in order (§9). A send queued while this runs is picked up by the
     * running loop (the next unsent item is read again every pass). A refusal (4xx other than 429) marks the
     * item failed and the queue moves on; anything else (429, 5xx, network, an HTML error page) stops the
     * loop and retries on a 2 s, 4 s … 30 s timer while connected, and again after reconnecting.
     */
    suspend fun flushOutbox() {
        if (_status.value != EngineStatus.ONLINE) return
        if (flushing) {
            flushAgain = true
            return
        }
        flushing = true
        try {
            do {
                flushAgain = false
                if (!sendQueued()) return
            } while (flushAgain)
        } finally {
            flushing = false
        }
    }

    /** True when nothing sendable is left; false when a temporary failure stopped it (the retry is scheduled). */
    private suspend fun sendQueued(): Boolean {
        while (_status.value == EngineStatus.ONLINE) {
            val item = store.outbox.firstOrNull { it.failed == null } ?: return true
            try {
                val (message, created) = api.postMessage(item.channelId, item.clientMsgId, item.body, item.parentId, item.attachmentIds,
                    SendOptions(item.alsoInChannel, item.priority, item.ackRequested))
                store.upsertMessage(message)
                store.removeOutbox(item.clientMsgId)
                // A replay (200) read nothing now: the server read the channel when it first stored the post, and its
                // read.updated or a bootstrap since then already carries the position.
                if (message.parentId == null && created) readByOwnPost(message)
                outboxFailures = 0
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (e.isRefusal()) {
                    // Kept as failed (also across restarts) for 再送 / 破棄; the rest of the queue goes on.
                    store.markOutboxFailed(item.clientMsgId, (e as ApiException.Api).code)
                    continue
                }
                scheduleOutboxRetry()
                return false
            }
        }
        return true // offline: the reconnect flushes again
    }

    /**
     * §10.1 rule 11: a top-level post this device made through an endpoint of its own rather than the outbox (a poll,
     * M14b) reads the channel like a send: the server read it up to the post in the same transaction. Before, the
     * position waited for read.updated, as for a post from another device.
     */
    fun postedFromHere(message: MessageOut) {
        store.upsertMessage(message)
        if (message.parentId == null) readByOwnPost(message)
    }

    /**
     * §10.1 rule 11: the server read the channel in the same transaction as my top-level post, so the accepted POST
     * moves the local position and ends a 「ここから未読にする」 hold. A thread reply (also_in_channel too) never does.
     * Nothing is unread any more only when the post is the newest row: the response can come after later rows from
     * others were counted, and the server's read.updated for the post precedes those on the socket, so the count kept
     * then is already right (at worst too high until the next server value, never too low).
     */
    private fun readByOwnPost(message: MessageOut) {
        unreadHold.remove(message.channelId)
        store.updateChannel(message.channelId) {
            val moved = it.copy(lastReadSeq = maxOf(it.lastReadSeq, message.seq), unsentReadSeq = it.unsentReadSeq?.takeIf { s -> s > message.seq })
            if (message.seq >= it.lastSeq) moved.copy(unreadCount = 0, mentionCount = 0, firstUnreadAt = null) else moved
        }
    }

    private fun scheduleOutboxRetry() {
        if (outboxRetry != null) return
        outboxFailures += 1
        val wait = min(options.outboxRetryMinMs * (1L shl (outboxFailures - 1).coerceAtMost(10)), options.outboxRetryMaxMs)
        val job = scope.launch(start = CoroutineStart.LAZY) {
            options.timer(wait)
            outboxRetry = null
            flushOutbox()
        }
        outboxRetry = job
        job.start()
    }
}
