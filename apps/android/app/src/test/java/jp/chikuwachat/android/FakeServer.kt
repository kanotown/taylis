package jp.chikuwachat.android

import jp.chikuwachat.android.api.CustomEmojiOut
import jp.chikuwachat.android.api.CalendarFeedCreated
import jp.chikuwachat.android.api.CalendarFeedOut
import jp.chikuwachat.android.sync.CalendarFeedApi
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
import jp.chikuwachat.android.api.PoolOut
import jp.chikuwachat.android.api.ActivitySummaryOut
import jp.chikuwachat.android.api.LastMessageOut
import jp.chikuwachat.android.sync.ActivityApi
import jp.chikuwachat.android.sync.AiApi
import jp.chikuwachat.android.api.AiAskIn
import jp.chikuwachat.android.api.AiRunOut
import jp.chikuwachat.android.api.AiSourceOut
import jp.chikuwachat.android.api.AiRunUpdated
import jp.chikuwachat.android.api.AiStatusOut
import jp.chikuwachat.android.api.AiSummaryIn
import jp.chikuwachat.android.api.AiSummaryTargetOut
import jp.chikuwachat.android.sync.ChannelApi
import jp.chikuwachat.android.ui.previewExcerpt
import jp.chikuwachat.android.sync.ChannelLinksApi
import jp.chikuwachat.android.sync.ReservationsApi
import jp.chikuwachat.android.sync.AttendanceApi
import jp.chikuwachat.android.sync.ActionsApi
import jp.chikuwachat.android.sync.DraftApi
import jp.chikuwachat.android.sync.SendOptions
import jp.chikuwachat.android.api.DeltaOut
import jp.chikuwachat.android.api.HistoryOut
import jp.chikuwachat.android.api.LabProfileOut
import jp.chikuwachat.android.api.Limits
import jp.chikuwachat.android.api.MembershipOut
import jp.chikuwachat.android.api.NotificationPreferenceOut
import jp.chikuwachat.android.api.MessageOut
import jp.chikuwachat.android.api.ParentThread
import jp.chikuwachat.android.api.PresenceEntry
import jp.chikuwachat.android.api.ReactionOut
import jp.chikuwachat.android.api.ReadStateOut
import jp.chikuwachat.android.api.ThreadItem
import jp.chikuwachat.android.api.ThreadListOut
import jp.chikuwachat.android.api.ThreadState
import jp.chikuwachat.android.api.ThreadSummary
import jp.chikuwachat.android.api.ThreadReadAllRow
import jp.chikuwachat.android.api.ThreadsReadAllOut
import jp.chikuwachat.android.api.UserMe
import jp.chikuwachat.android.api.UserPublic
import jp.chikuwachat.android.api.SystemEventOut
import jp.chikuwachat.android.api.WorkspaceSettingsOut
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
    /** M69: each person's iCal feeds (CALENDAR.md §10.6). */
    val calendarFeedsOf = mutableMapOf<String, MutableList<CalendarFeedOut>>()
    private var calendarFeedSeq = 0

    /** M12g notification keywords per user; like the server, hits never appear in mentionedUserIds. */
    val keywords = mutableMapOf<String, List<String>>()
    /** M35: users.notification_default per user (absent = "mentions"), in UserMe at bootstrap. */
    val notificationDefaults = mutableMapOf<String, String>()

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
                "canvas_presence" -> relayCanvasPresence(userId, frame)
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

    inner class Api(val userId: String) : SyncApi, DraftApi, ChannelLinksApi, ReservationsApi, AttendanceApi, ActionsApi, ActivityApi, ChannelApi, AiApi, CalendarFeedApi {
        // --- M69 iCal feeds (CALENDAR.md §10.3, §10.6): 5 per person, the URL only in the answer that makes one ---

        override suspend fun calendarFeeds(): List<CalendarFeedOut> {
            maybeFail()
            return calendarFeedsOf[userId].orEmpty().toList()
        }

        override suspend fun createCalendarFeed(scope: String): CalendarFeedCreated {
            maybeFail()
            if (scope != "all" && scope != "personal") throw ApiException.Api(422, "validation_error", "bad scope")
            val mine = calendarFeedsOf.getOrPut(userId) { ArrayList() }
            if (mine.size >= 5) throw ApiException.Api(409, "calendar_feed_limit", "at most 5 feeds")
            calendarFeedSeq += 1
            val feed = CalendarFeedOut("feed-$calendarFeedSeq", scope, "2026-10-02T03:00:00Z", null)
            mine += feed
            return CalendarFeedCreated(feed, "https://chat.example/api/v1/calendar/ical/token$calendarFeedSeq.ics")
        }

        override suspend fun deleteCalendarFeed(feedId: String) {
            maybeFail()
            val mine = calendarFeedsOf[userId]
            if (mine == null || mine.none { it.id == feedId }) throw ApiException.Api(404, "calendar_feed_not_found", "not found")
            mine.removeAll { it.id == feedId }
        }

        // --- M66 AI (docs/AI.md §5) ---
        /** GET /ai/status and GET /ai/runs/{id} calls made. */
        var aiStatusCalls = 0
        val aiRunCalls = ArrayList<String>()
        /** The POST /ai/summaries bodies received. */
        val summaryRequests = ArrayList<AiSummaryIn>()

        override suspend fun aiStatus(): AiStatusOut {
            maybeFail()
            aiStatusCalls += 1
            return this@FakeServer.aiStatus ?: throw ApiException.Api(404, "not_found", "no AI before M65")
        }

        override suspend fun createSummary(body: AiSummaryIn): AiRunOut {
            maybeFail()
            val status = this@FakeServer.aiStatus ?: throw ApiException.Api(404, "not_found", "no AI before M65")
            summaryRequests.add(body)
            aiSummaryRefusals.removeFirstOrNull()?.let { throw it }
            val record = channels[body.channelId]
            if (record == null || userId !in record.members && !(record.channel.type == "public" && users[userId]?.role != "guest")) {
                throw ApiException.Api(404, "channel_not_found", "not found")
            }
            if (body.scope == "thread" && (body.threadId == null || record.messages.none { it.id == body.threadId && it.parentId == null })) {
                throw ApiException.Api(400, "validation_error", "thread_id must be a parent")
            }
            if (!status.available) throw ApiException.Api(409, "ai_unavailable", "AI is not available")
            if (!status.summaryAvailable) throw ApiException.Api(429, "ai_budget_exceeded", "budget exceeded")
            val run = AiRunOut(
                id = nextId(), kind = "summary", status = "pending", channelId = body.channelId, threadId = body.threadId,
                scope = body.scope, days = body.days, createdAt = now(),
            )
            aiRuns[run.id] = userId to run
            return run
        }

        override suspend fun summaryTarget(channelId: String): AiSummaryTargetOut {
            maybeFail()
            return this@FakeServer.aiSummaryTarget ?: throw ApiException.Api(404, "http_404", "no such route before review v0.1.18")
        }

        // --- M71 「AI に聞く」 (docs/AI.md §13.5) ---
        /** The POST /ai/ask bodies and the GET /ai/ask/target questions received. */
        val askRequests = ArrayList<AiAskIn>()
        val askTargetCalls = ArrayList<Pair<String, String?>>()

        override suspend fun createAsk(body: AiAskIn): AiRunOut {
            maybeFail()
            val status = this@FakeServer.aiStatus ?: throw ApiException.Api(404, "not_found", "no AI before M65")
            if (this@FakeServer.aiAskTarget == null) throw ApiException.Api(404, "http_404", "no /ai/ask before M70")
            askRequests.add(body)
            aiAskRefusals.removeFirstOrNull()?.let { throw it }
            if (body.q.isBlank()) throw ApiException.Api(400, "validation_error", "empty question")
            body.channelId?.let { id ->
                val record = channels[id]
                if (record == null || userId !in record.members) throw ApiException.Api(404, "channel_not_found", "not found")
            }
            if (!status.available) throw ApiException.Api(409, "ai_unavailable", "AI is not available")
            if (!status.summaryAvailable) throw ApiException.Api(429, "ai_budget_exceeded", "budget exceeded")
            val run = AiRunOut(
                id = nextId(), kind = "ask", status = "pending", channelId = body.channelId, question = body.q, sources = emptyList(),
                createdAt = now(), provider = "anthropic", model = "claude-opus-5-5",
            )
            aiRuns[run.id] = userId to run
            return run
        }

        override suspend fun askTarget(q: String, channelId: String?): AiSummaryTargetOut {
            maybeFail()
            askTargetCalls.add(q to channelId)
            return this@FakeServer.aiAskTarget ?: throw ApiException.Api(404, "http_404", "no /ai/ask/target before M70")
        }

        override suspend fun aiRuns(kind: String): List<AiRunOut> {
            maybeFail()
            if (this@FakeServer.aiAskTarget == null) throw ApiException.Api(404, "http_404", "no /ai/runs before M70")
            return aiRuns.values.filter { (owner, run) -> owner == userId && run.kind == kind }.map { it.second }.reversed().take(20)
        }

        override suspend fun aiRun(runId: String): AiRunOut {
            maybeFail()
            aiRunCalls.add(runId)
            val (owner, run) = aiRuns[runId] ?: throw ApiException.Api(404, "ai_run_not_found", "not found")
            if (owner != userId) throw ApiException.Api(404, "ai_run_not_found", "not found")
            return run
        }

        /** M49: GET /channels/{id} calls made (the preview asked again after a deletion). */
        val channelCalls = ArrayList<String>()
        override suspend fun channel(id: String): ChannelOut {
            maybeFail()
            channelCalls.add(id)
            return memberView(userId, requireMember(id, userId))
        }

        /** M39: GET /activity/summary calls made (the badge refreshes the events trigger). */
        var activitySummaryCalls = 0
        override suspend fun activitySummary(): ActivitySummaryOut {
            maybeFail()
            activitySummaryCalls += 1
            return activity[userId] ?: throw ApiException.Api(404, "not_found", "no activity before M39")
        }

        /** PUT /activity/read calls made (「すべて既読にする」; since 2026-10-07 never on its own). */
        val markActivityReadCalls = mutableListOf<String>()
        override suspend fun markActivityRead(readAt: String): ActivitySummaryOut {
            maybeFail()
            markActivityReadCalls.add(readAt)
            val held = activity[userId] ?: throw ApiException.Api(404, "not_found", "no activity before M39")
            val moved = if (readAt > held.readAt) readAt else held.readAt
            val answer = ActivitySummaryOut(moved, 0, false)
            activity[userId] = answer
            emitActivityRead(userId, moved)
            return answer
        }

        /** PUT /activity/items/read calls made (2026-10-07): the ids of each. */
        val markActivityItemsReadCalls = mutableListOf<List<String>>()
        override suspend fun markActivityItemsRead(itemIds: List<String>): ActivitySummaryOut {
            maybeFail()
            markActivityItemsReadCalls.add(itemIds)
            val held = activity[userId] ?: throw ApiException.Api(404, "not_found", "no activity items read before 2026-10-07")
            val answer = held.copy(unreadCount = (held.unreadCount - itemIds.size).coerceAtLeast(0))
            activity[userId] = answer
            emitActivityItemsRead(userId, itemIds, now())
            return answer
        }

        /** M140: GET /attendance (guests: 403, as the server). */
        override suspend fun attendance(): jp.chikuwachat.android.api.AttendanceBoardOut {
            maybeFail(); attendanceReads += 1
            if (users.getValue(userId).role == "guest") throw ApiException.Api(403, "guest_restricted", "guests do not see the board")
            return attendanceBoard()
        }

        /** M143: GET /actions (guests: none, as the server). */
        override suspend fun actions(): jp.chikuwachat.android.api.ActionListOut {
            maybeFail(); actionsReads += 1
            return actionListFor(userId)
        }

        /** M143: a press; the same client_invoke_id answers the first result without calling the relay again. */
        override suspend fun invokeAction(actionId: String, clientInvokeId: String): jp.chikuwachat.android.api.ActionInvokeOut {
            invokeCalls += actionId to clientInvokeId
            invokeFailures.removeFirstOrNull()?.let { throw it }
            val out = invokeResults[userId to clientInvokeId]?.copy(repeated = true) ?: run {
                relayCalls += 1
                (relayAnswer[actionId] ?: jp.chikuwachat.android.api.ActionInvokeOut(
                    invokeId = "inv-$relayCalls", actionId = actionId, ok = true, status = "succeeded", statusCode = 200, at = "2026-10-08T00:00:00Z",
                )).copy(actionId = actionId).also { invokeResults[userId to clientInvokeId] = it }
            }
            invokeLostAnswers.removeFirstOrNull()?.let { throw it }  // the relay was called, but the answer never came back
            return out
        }

        /** M143 §12.3: the groups' states (empty while off and for guests); failures from [statusFailures] first. */
        override suspend fun actionStatuses(refresh: Boolean): jp.chikuwachat.android.api.ActionStatusListOut {
            statusReads += refresh
            statusFailures.removeFirstOrNull()?.let { throw it }
            if (users.getValue(userId).role == "guest" || !actionList.enabled) return jp.chikuwachat.android.api.ActionStatusListOut(enabled = actionList.enabled)
            return jp.chikuwachat.android.api.ActionStatusListOut(enabled = true, statuses = actionStatusList)
        }

        /** Review v0.1.37 #6: when set, the next GET /reservation-pools answers as the server was then, but only once released. */
        var poolsHold: Hold? = null
        override suspend fun reservationPools(): List<PoolOut> {
            maybeFail(); poolReads += 1
            poolsHold?.let { hold -> poolsHold = null; return hold.pass { pools } }
            return pools
        }
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
        /** Review v0.1.22 #6: when set, the next GET history / replies answers as it would now, but only once released. */
        var historyHold: Hold? = null
        var repliesHold: Hold? = null

        override suspend fun history(channelId: String, beforeSeq: Int?, limit: Int): HistoryOut {
            maybeFail()
            historyCalls.add(beforeSeq to limit)
            historyHold?.let { hold -> historyHold = null; return hold.pass { this@FakeServer.history(userId, channelId, beforeSeq, limit) } }
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
            repliesHold?.let { hold -> repliesHold = null; return hold.pass { repliesNow(messageId) } }
            return repliesNow(messageId)
        }

        private fun repliesNow(messageId: String): List<MessageOut> {
            val record = channels.values.first { r -> r.messages.any { it.id == messageId } }
            requireReadable(record.channel.id, userId)
            // As the server: a deleted root's replies are no longer served.
            if (record.messages.first { it.id == messageId }.deleted) throw ApiException.Api(404, "message_not_found", "not found")
            return record.messages.filter { it.parentId == messageId && !it.deleted }.sortedBy { it.seq }.map { shaped(it, userId) }
        }
        override suspend fun markRead(channelId: String, lastReadSeq: Int): ReadStateOut {
            maybeFail()
            readCalls.add(lastReadSeq)
            readGate?.let { gate -> readGate = null; gate.await() }
            return this@FakeServer.markRead(userId, channelId, lastReadSeq)
        }
        /** When set, the next PUT read waits for it (a read mark still on its way, §10). */
        var readGate: CompletableDeferred<Unit>? = null
        override suspend fun readAll(scope: String?): List<ChannelReadStateOut> { maybeFail(); return this@FakeServer.readAll(userId) }
        override suspend fun listScheduled(): List<ScheduledOut> { maybeFail(); return scheduled[userId]?.toList() ?: emptyList() }
        override suspend fun listReminders(): List<ReminderOut> { maybeFail(); return reminders[userId]?.toList() ?: emptyList() }
        override suspend fun setReadPosition(channelId: String, lastReadSeq: Int): ReadStateOut {
            maybeFail()
            setCalls.add(lastReadSeq)
            return this@FakeServer.markRead(userId, channelId, lastReadSeq, mode = "set")
        }
        override suspend fun publicChannels(): List<ChannelOut> =
            if (users[userId]?.role == "guest") emptyList() // M13e: guests are shown only their own channels
            // Like the server (channels/service.py): archived channels are not offered for joining.
            else channels.values.filter { it.channel.type == "public" && !it.channel.archived && userId !in it.members }.map { it.channel.copy(membership = null, memberCount = it.members.size) }
        override suspend fun threads(filter: String, cursor: String?, limit: Int): ThreadListOut { maybeFail(); return this@FakeServer.threads(userId, filter, cursor, limit) }
        override suspend fun threadState(messageId: String): ThreadState { maybeFail(); return this@FakeServer.threadState(userId, messageId) }
        override suspend fun markThreadRead(messageId: String, lastReadSeq: Int): ThreadState {
            maybeFail()
            threadReadCalls.add(lastReadSeq)
            threadReadGate?.let { gate -> threadReadGate = null; gate.await() }
            return this@FakeServer.markThreadRead(userId, messageId, lastReadSeq)
        }
        override suspend fun setThreadFollow(messageId: String, following: Boolean): ThreadState { maybeFail(); return this@FakeServer.setThreadFollow(userId, messageId, following) }
        /** When set, the next POST /threads/read-all waits for it before the server moves anything (a call in flight). */
        var threadsReadAllGate: CompletableDeferred<Unit>? = null
        override suspend fun readAllThreads(): ThreadsReadAllOut {
            threadsReadAllGate?.let { gate -> threadsReadAllGate = null; gate.await() }
            maybeFail()
            return this@FakeServer.readAllThreads(userId)
        }
    }

    class ChannelRecord(var channel: ChannelOut, val members: MutableSet<String>, val messages: MutableList<MessageOut>)

    val users = LinkedHashMap<String, UserPublic>()
    /**
     * M39: each user's activity summary as GET /activity/summary answers it and bootstrap carries it; a user without
     * one is on a server before M39 (bootstrap has no `activity`, the endpoint 404s).
     */
    val activity = HashMap<String, ActivitySummaryOut>()
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

    /**
     * L6 (RECURRING.md §7): the server's side of a collection changing (the post went out, a target's first reply or
     * last reply's deletion, the reminder): the parent takes a seq of its own and goes out as message.updated
     * (change=collection).
     */
    fun setCollection(channelId: String, messageId: String, collection: jp.chikuwachat.android.api.CollectionOut?): MessageOut {
        val record = channels.getValue(channelId)
        val message = record.messages.first { it.id == messageId }
        val seq = record.channel.lastSeq + 1
        record.channel = record.channel.copy(lastSeq = seq)
        val updated = message.copy(updatedSeq = seq, collection = collection)
        replace(record, updated, "message.updated", "collection")
        return updated
    }

    /**
     * L9 (REVIEWS.md §2.2): the server's side of a message's tasks changing (made, its state / due date / assignees changed,
     * deleted): the message takes a seq of its own and goes out as message.updated (change=tasks).
     */
    fun setTasks(channelId: String, messageId: String, tasks: List<jp.chikuwachat.android.api.MessageTaskOut>): MessageOut {
        val record = channels.getValue(channelId)
        val message = record.messages.first { it.id == messageId }
        val seq = record.channel.lastSeq + 1
        record.channel = record.channel.copy(lastSeq = seq)
        val updated = message.copy(updatedSeq = seq, tasks = tasks)
        replace(record, updated, "message.updated", "tasks")
        return updated
    }

    /**
     * M79 (`app.cli probe-videos`): the server fills in a message's video (size, length, poster) after the fact; the
     * message takes a seq of its own and goes out as message.updated with `change` (normally "attachments").
     */
    fun setAttachments(channelId: String, messageId: String, attachments: List<AttachmentOut>, change: String = "attachments"): MessageOut {
        val record = channels.getValue(channelId)
        val message = record.messages.first { it.id == messageId }
        val seq = record.channel.lastSeq + 1
        record.channel = record.channel.copy(lastSeq = seq)
        val updated = message.copy(updatedSeq = seq, attachments = attachments)
        replace(record, updated, "message.updated", change)
        return updated
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
    /** M141: "user" → the DMs they closed (bootstrap's `closed_dms`); null = a server before M141. */
    var closedDms: HashMap<String, MutableList<String>>? = null

    /** M141: `PUT` / `DELETE /channels/{id}/close` on a device of `userId`: dm_close.updated to their devices. */
    fun emitDmClose(userId: String, channelId: String, closed: Boolean, closedSeq: Int? = if (closed) channels[channelId]?.channel?.lastSeq else null) {
        val list = closedDms!!.getOrPut(userId) { ArrayList() }
        list.remove(channelId)
        if (closed) list.add(channelId)
        emitDmCloseEvent(userId, channelId, closed, closedSeq)
    }

    /**
     * dm_close.updated as sent (closed_seq: where it was closed, Review v0.1.43 #6). Alone, it replays the race the review
     * found: a close that read the seq before a new message, delivered after that message.created.
     */
    fun emitDmCloseEvent(userId: String, channelId: String, closed: Boolean, closedSeq: Int?) {
        emit(setOf(userId), event("dm_close.updated", null, null, buildJsonObject {
            put("channel_id", channelId); put("closed", closed); put("at", now()); put("closed_seq", closedSeq)
        }))
    }
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

    /** M112: the workspace's reservation pools; publishPools announces a change like the server (to everyone, no pool in it). */
    var pools: List<PoolOut> = emptyList()
    /** How many times GET /reservation-pools was read. */
    var poolReads = 0

    fun publishPools(rows: List<PoolOut>) {
        pools = rows
        emit(users.keys.toSet(), event("reservation.updated", null, null, buildJsonObject {
            put("pool_id", rows.firstOrNull()?.id ?: "p")
            put("deleted", false)
        }))
    }

    /** M112: a reservation notice for one person (an activity item; the app shows a banner). */
    fun noticeReservation(userId: String, text: String) {
        emit(setOf(userId), event("reservation.notice", null, null, buildJsonObject {
            put("item_id", "n1"); put("pool_id", "p1"); put("text", text); put("operator", true); put("at", "2026-10-05T01:00:00Z")
        }))
    }

    /** M140: the 在室状況 board (off by default, as the server); the helpers announce changes like the server (not to guests). */
    var attendance = jp.chikuwachat.android.api.AttendanceBoardOut(enabled = false)
    var attendanceReads = 0

    fun attendanceBoard(): jp.chikuwachat.android.api.AttendanceBoardOut =
        if (attendance.enabled) attendance else jp.chikuwachat.android.api.AttendanceBoardOut(enabled = false)

    private fun nonGuests(): Set<String> = users.values.filter { it.role != "guest" }.map { it.id }.toSet()

    fun configureAttendance(board: jp.chikuwachat.android.api.AttendanceBoardOut) {
        attendance = board
        emit(nonGuests(), event("attendance.config_updated", null, null, buildJsonObject {}))
    }

    fun setAttendanceEntry(entry: jp.chikuwachat.android.api.AttendanceEntryOut) {
        attendance = attendance.copy(entries = attendance.entries.filter { it.userId != entry.userId } + entry)
        emit(nonGuests(), event("attendance.updated", null, null, Codec.snake.encodeToJsonElement(jp.chikuwachat.android.api.AttendanceEntryOut.serializer(), entry) as JsonObject))
    }

    /** M143: the 操作ボタン (off by default, as the server); every non-guest may press all of them here. */
    var actionList = jp.chikuwachat.android.api.ActionListOut(enabled = false)
    var actionsReads = 0
    /** Every POST invoke (action id, client_invoke_id), the relay calls made, and the stored results by (user, id). */
    val invokeCalls = ArrayList<Pair<String, String>>()
    var relayCalls = 0
    val invokeResults = HashMap<Pair<String, String>, jp.chikuwachat.android.api.ActionInvokeOut>()
    /** What the relay answers for an action (default: a 200 without a message). */
    val relayAnswer = HashMap<String, jp.chikuwachat.android.api.ActionInvokeOut>()
    /** Failures thrown before the server handles the press (the request never arrived). */
    val invokeFailures = ArrayDeque<Throwable>()
    /** Failures thrown after the relay was called (the answer was lost on the way back). */
    val invokeLostAnswers = ArrayDeque<Throwable>()

    fun actionListFor(userId: String): jp.chikuwachat.android.api.ActionListOut =
        if (users.getValue(userId).role == "guest") actionList.copy(actions = emptyList())
        else if (actionList.enabled) actionList else actionList.copy(actions = emptyList())

    /** M143 §12: what GET /actions/status answers, each read (`refresh` or not), and failures thrown before answering. */
    var actionStatusList: List<jp.chikuwachat.android.api.ActionStatusOut> = emptyList()
    val statusReads = ArrayList<Boolean>()
    val statusFailures = ArrayDeque<Throwable>()

    /** actions.status_updated to the people who may press something (here: everyone but guests). */
    fun announceActionStatus(status: jp.chikuwachat.android.api.ActionStatusOut) {
        emit(nonGuests(), event("actions.status_updated", null, null, Codec.snake.encodeToJsonElement(jp.chikuwachat.android.api.ActionStatusOut.serializer(), status) as JsonObject))
    }

    fun configureActions(list: jp.chikuwachat.android.api.ActionListOut) {
        actionList = list
        emit(nonGuests(), event("actions.updated", null, null, buildJsonObject {}))
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

    // --- canvases, M73 (CANVAS.md §18.1 / §18.2) ------------------------------------------------------

    /** Canvas id → its conversation (set by tests): where `canvas_presence` frames are relayed. */
    val canvasChannels = HashMap<String, String>()
    /** Every `canvas_presence` frame a client sent, with its sender. */
    val canvasPresenceReceived = ArrayList<Pair<String, JsonObject>>()

    /** The server's relay (§18.2): to the conversation's other members; an unknown canvas or a non-member is dropped. */
    fun relayCanvasPresence(userId: String, frame: JsonObject) {
        canvasPresenceReceived.add(userId to frame)
        val canvasId = frame["canvas_id"]?.jsonPrimitive?.contentOrNull ?: return
        val channelId = canvasChannels[canvasId] ?: return
        val record = channels[channelId] ?: return
        if (userId !in record.members) return
        val editing = frame["editing"]?.jsonPrimitive?.contentOrNull == "true"
        val section = frame["section"]?.jsonPrimitive?.contentOrNull
        sockets.toList().filter { it.authed && it.userId != userId && it.userId in record.members }.forEach {
            it.deliver(buildJsonObject {
                put("type", "canvas_presence"); put("canvas_id", canvasId); put("channel_id", channelId); put("user_id", userId)
                put("editing", editing); put("section", section?.let { v -> JsonPrimitive(v) } ?: JsonNull)
            })
        }
    }

    /** canvas.mentioned (audience user, no seq): a save of the canvas newly mentions `userId`. */
    fun emitCanvasMentioned(userId: String, canvasId: String, channelId: String, title: String, byUserId: String) {
        emit(setOf(userId), event("canvas.mentioned", null, null, buildJsonObject {
            put("canvas_id", canvasId); put("channel_id", channelId); put("rev_id", nextId()); put("title", title); put("by_user_id", byUserId)
        }))
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

    /** false: GET /threads answers as a server before the reply previews did (no latest_replies). */
    var threadPreviews = true

    fun threads(userId: String, filter: String, cursor: String?, limit: Int): ThreadListOut {
        var items = threadFollows.values.filter { it.userId == userId && it.following }.mapNotNull { row ->
            val (_, parent) = runCatching { threadParent(row.parentId) }.getOrNull() ?: return@mapNotNull null
            if (parent.deleted || parent.replyCount == 0) return@mapNotNull null
            // THREADS.md §5: the newest two live replies, oldest first; none from a server before the previews.
            val record = threadParent(row.parentId).first
            val latest = record.messages.filter { it.parentId == parent.id && !it.deleted }.sortedBy { it.seq }.takeLast(2)
            ThreadItem(parent, threadState(userId, row.parentId), latest.takeIf { threadPreviews })
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

    /**
     * POST /threads/read-all (THREADS.md §3.2): my followed threads in channels I am in, roots not deleted, read to their
     * newest live reply (forward only); one threads.read_all to my devices when any moved.
     */
    fun readAllThreads(userId: String): ThreadsReadAllOut {
        val moved = ArrayList<ThreadReadAllRow>()
        threadFollows.values.filter { it.userId == userId && it.following }.forEach { row ->
            val record = channels.values.firstOrNull { r -> r.messages.any { it.id == row.parentId } } ?: return@forEach
            if (userId !in record.members) return@forEach
            if (record.messages.first { it.id == row.parentId }.deleted) return@forEach
            val newest = record.messages.filter { it.parentId == row.parentId && !it.deleted }.maxOfOrNull { it.seq } ?: return@forEach
            if (newest <= row.lastReadSeq) return@forEach
            row.lastReadSeq = newest
            val state = threadState(userId, row.parentId)
            moved += ThreadReadAllRow(row.parentId, record.channel.id, state.lastReadSeq, state.unreadCount, state.mentionCount)
        }
        val answer = ThreadsReadAllOut(threadSummary(userId), moved)
        if (moved.isNotEmpty()) emitThreadsReadAll(userId, answer)
        return answer
    }

    /** threads.read_all to `userId`'s devices (also usable alone: a read-all made on another device). */
    fun emitThreadsReadAll(userId: String, answer: ThreadsReadAllOut) {
        emit(setOf(userId), event("threads.read_all", null, null, Codec.snake.encodeToJsonElement(ThreadsReadAllOut.serializer(), answer).jsonObject))
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

    /** M27 (SECURITY.md §3.2): reading also a public channel not joined, except for guests; writing stays with members. */
    private fun requireReadable(channelId: String, userId: String): ChannelRecord {
        val record = channels[channelId] ?: throw ApiException.Api(404, "channel_not_found", "not found")
        if (userId in record.members) return record
        if (record.channel.type == "public" && users[userId]?.role != "guest") {
            // M88: the workspace's 「参加前にチャンネルの中を見られる」 off (MEMBERSHIP.md §3; admins too).
            if (!workspaceSettings.previewBeforeJoin) throw ApiException.Api(403, "preview_disabled", "join to read")
            return record
        }
        throw ApiException.Api(403, "not_a_member", "not a member")
    }

    /** M88 (MEMBERSHIP.md §3): the workspace switches (bootstrap, the preview's 403). Change with [updateWorkspaceSettings]. */
    var workspaceSettings = WorkspaceSettingsOut()

    /**
     * PATCH /admin/workspace-settings as the real server announces it: workspace.settings_updated to everyone. `announce`
     * false: changed while the client did not hear of it (offline).
     */
    fun updateWorkspaceSettings(settings: WorkspaceSettingsOut, announce: Boolean = true) {
        workspaceSettings = settings
        if (announce) emit(users.keys.toSet(), event("workspace.settings_updated", null, null, buildJsonObject {
            put("settings", Codec.snake.encodeToJsonElement(WorkspaceSettingsOut.serializer(), settings))
        }))
    }

    /** M88: a join / leave line as the server writes it (type "system", sender the actor, a seq, never unread). */
    fun postSystem(channelId: String, event: SystemEventOut, body: String): MessageOut {
        val record = channels.getValue(channelId)
        val seq = record.channel.lastSeq + 1
        record.channel = record.channel.copy(lastSeq = seq) // last_message_at stays (MEMBERSHIP.md §1)
        val message = MessageOut(
            id = nextId(), channelId = channelId, senderId = event.actorId, seq = seq, updatedSeq = seq, clientMsgId = null, body = body,
            type = "system", systemEvent = event, createdAt = now(), deleted = false,
        )
        record.messages.add(message)
        emit(record.members, event("message.created", channelId, seq, buildJsonObject {
            put("message", Codec.snake.encodeToJsonElement(MessageOut.serializer(), message))
        }))
        return message
    }

    // --- polls (M14b, M27) ----------------------------------------------------------------------

    /** message id → (user id, option) in the order voted: apart from the message, like the server's poll_votes. */
    val pollVotes = HashMap<String, MutableList<Pair<String, Int>>>()

    /**
     * The wire shape of a message for `viewer` (DATA_MODEL.md 「投票」): counts per option, voters only for a named poll,
     * and `mine` only in a response to the viewer (null = an event, the same for every member).
     */
    fun shaped(message: MessageOut, viewer: String?): MessageOut {
        val poll = message.poll ?: return message
        val votes = pollVotes[message.id] ?: emptyList()
        val byOption = poll.options.indices.map { option -> votes.filter { it.second == option }.map { it.first } }
        return message.copy(poll = poll.copy(
            votes = if (poll.anonymous) byOption.map { emptyList() } else byOption,
            counts = byOption.map { it.size },
            mine = viewer?.let { v -> votes.filter { it.first == v }.map { it.second }.sorted() },
        ))
    }

    /** POST /channels/{id}/messages with a poll: the response is the author's (with `mine`), the event everyone's. */
    fun postPoll(channelId: String, senderId: String, question: String, options: List<String>, multiple: Boolean = false, anonymous: Boolean = false): MessageOut =
        post(channelId, senderId, "📊 $question", poll = jp.chikuwachat.android.api.PollOut(question, options, multiple, anonymous = anonymous)).first

    /** PUT / DELETE /messages/{id}/poll/votes/{option}: a change consumes a seq (message.updated change=poll). */
    fun vote(channelId: String, userId: String, messageId: String, option: Int, present: Boolean): MessageOut {
        val (record, message) = live(channelId, userId, messageId)
        val poll = message.poll ?: throw ApiException.Api(404, "poll_not_found", "no poll")
        if (poll.closedAt != null) throw ApiException.Api(409, "poll_closed", "closed")
        val votes = pollVotes.getOrPut(messageId) { ArrayList() }
        val had = (userId to option) in votes
        if (present == had) return shaped(message, userId)
        if (present) {
            if (!poll.multiple) votes.removeAll { it.first == userId } // a single-answer poll moves the vote
            votes.add(userId to option)
        } else {
            votes.remove(userId to option)
        }
        val seq = record.channel.lastSeq + 1
        record.channel = record.channel.copy(lastSeq = seq)
        val updated = message.copy(updatedSeq = seq)
        replace(record, updated, "message.updated", "poll")
        return shaped(updated, userId)
    }

    /**
     * `type` other than "user" is a system row: in the timeline, never unread (the server's reads.counts rule).
     * `scheduled`: a scheduled send going out (M12d), which does not read the channel for its sender.
     */
    fun post(
        channelId: String, senderId: String, body: String, clientMsgId: String? = null, parentId: String? = null, attachmentIds: List<String> = emptyList(),
        options: SendOptions = SendOptions(), type: String = "user", scheduled: Boolean = false, poll: jp.chikuwachat.android.api.PollOut? = null,
    ): Pair<MessageOut, Boolean> {
        val record = requireMember(channelId, senderId)
        val key = clientMsgId ?: nextId()
        byClientKey["$senderId:$key"]?.let { existing ->
            if (existing.channelId != channelId) throw ApiException.Api(409, "idempotency_conflict", "conflict")
            return shaped(existing, senderId) to false
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
            poll = poll,
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
            put("message", Codec.snake.encodeToJsonElement(MessageOut.serializer(), shaped(message, null)))
            if (thread != null) put("parent_thread", Codec.snake.encodeToJsonElement(ParentThread.serializer(), thread))
        }))
        // §10: a top-level post reads the channel for its sender; a thread reply moves only the thread's position.
        if (parentId == null && !scheduled) markRead(senderId, channelId, seq)
        if (thread != null) emitThread(thread.id, followers(thread.id), "reply")
        return shaped(message, senderId) to true
    }

    fun messageByBody(channelId: String, body: String): MessageOut =
        channels.getValue(channelId).messages.first { it.body == body && !it.deleted }

    private fun replace(record: ChannelRecord, updated: MessageOut, event: String, change: String? = null) {
        val index = record.messages.indexOfFirst { it.id == updated.id }
        record.messages[index] = updated
        emit(record.members, event(event, updated.channelId, updated.updatedSeq, buildJsonObject {
            put("message", Codec.snake.encodeToJsonElement(MessageOut.serializer(), shaped(updated, null)))
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
        // A deleted message is unpinned with it, as on the server.
        val tombstone = message.copy(body = "", deleted = true, updatedSeq = seq, reactions = emptyList(), pinnedAt = null, pinnedBy = null)
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
        // M39: news to the author (their activity badge), not when they reacted themselves nor when one is taken away.
        if (present && message.senderId != userId) {
            emit(setOf(message.senderId), event("reaction.added", null, null, buildJsonObject {
                put("channel_id", channelId); put("message_id", messageId); put("user_id", userId); put("emoji", emoji); put("at", now())
            }))
        }
        return updated to true
    }

    /** M39: PUT /activity/read on another device of `userId`: activity.read to their devices. */
    fun emitActivityRead(userId: String, readAt: String) {
        emit(setOf(userId), event("activity.read", null, null, buildJsonObject { put("read_at", readAt) }))
    }

    /** 2026-10-07: PUT /activity/items/read on a device of `userId`: activity.items_read to their devices. */
    fun emitActivityItemsRead(userId: String, itemIds: List<String>, readAt: String) {
        emit(setOf(userId), event("activity.items_read", null, null, buildJsonObject {
            put("item_ids", kotlinx.serialization.json.JsonArray(itemIds.map { kotlinx.serialization.json.JsonPrimitive(it) }))
            put("read_at", readAt)
        }))
    }

    /** Review v0.1.22 (CANVAS.md §20.8): a canvas version's body erased blanked these activity items' excerpts. */
    fun emitActivityUpdated(userId: String, itemIds: List<String>) {
        emit(setOf(userId), event("activity.updated", null, null, buildJsonObject {
            put("item_ids", kotlinx.serialization.json.JsonArray(itemIds.map { kotlinx.serialization.json.JsonPrimitive(it) }))
        }))
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

    /** PATCH /channels/{id}/members/{user_id} as the real server announces it (M31): channel.member_updated to the members. */
    fun emitMemberUpdated(channelId: String, userId: String, role: String) {
        val record = channels[channelId] ?: return
        emit(record.members, event("channel.member_updated", channelId, null, buildJsonObject { put("channel_id", channelId); put("user_id", userId); put("role", role) }))
    }

    /** PUT /channels/{id}/notification-preference as the real server announces it: to the user's own devices (M35 fields too). */
    fun emitNotificationPreference(userId: String, pref: NotificationPreferenceOut) {
        emit(setOf(userId), event("notification_preference.updated", pref.channelId, null, Codec.snake.encodeToJsonElement(NotificationPreferenceOut.serializer(), pref).jsonObject))
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
        val me = UserMe(user.id, user.username, user.displayName, user.role, null, user.createdAt, user.updatedAt, null, false, notifyKeywords = keywords[userId] ?: emptyList(), notificationDefault = notificationDefaults[userId] ?: "mentions")
        val mine = channels.values.filter { userId in it.members }.map { record -> memberView(userId, record) }
        val connected = sockets.filter { it.authed }.map { it.userId }.distinct().sorted()
        return BootstrapOut(
            now(), me, users.values.toList(), mine, Limits(20000, 1, 10), threadSummary(userId), connected.map { PresenceEntry(it, presenceOf(it) ) },
            bookmarks[userId]?.toList() ?: emptyList(),
            favorites = (favorites[userId] ?: emptyList()).filter { id -> channels[id]?.members?.contains(userId) == true },
            closedDms = closedDms?.let { all -> (all[userId] ?: emptyList()).filter { id -> channels[id]?.members?.contains(userId) == true } },
            customEmoji = customEmoji.values.toList(),
            roster = roster.values.toList(),
            drafts = draftsOf(userId),
            activity = activity[userId],
            workspaceSettings = workspaceSettings,
            attendance = if (user.role == "guest" || !attendance.enabled) null else attendanceBoard(),
            actions = if (user.role == "guest" || !actionList.enabled) null else actionListFor(userId),
        )
    }

    /** A channel as its member sees it (bootstrap, GET /channels/{id}): membership, read state, size and, M49, the last message. */
    private fun memberView(userId: String, record: ChannelRecord): ChannelOut =
        record.channel.copy(
            membership = MembershipOut(if (record.channel.createdBy == userId) "owner" else "member", now()), readState = readState(userId, record.channel.id),
            memberCount = record.members.size, lastMessage = lastMessage(record),
        )

    /** M49: the newest live timeline row, its excerpt by the push body's rule (the server's messages/service.py). */
    fun lastMessage(record: ChannelRecord): LastMessageOut? {
        val last = record.messages.filter { !it.deleted && (it.parentId == null || it.alsoInChannel) }.maxByOrNull { it.seq } ?: return null
        return LastMessageOut(
            last.id, last.senderId, last.type, last.seq, previewExcerpt(last.body, last.attachments.map { it.contentType }, users),
            last.attachments.isNotEmpty(), last.createdAt,
        )
    }

    fun history(userId: String, channelId: String, beforeSeq: Int?, limit: Int): HistoryOut {
        val record = requireReadable(channelId, userId) // M27: a public channel's preview too
        val channelLastSeq = record.channel.lastSeq // read BEFORE the rows (§4.3)
        var rows = record.messages.filter { !it.deleted && (it.parentId == null || it.alsoInChannel) }
        if (beforeSeq != null) rows = rows.filter { it.seq < beforeSeq }
        rows = rows.sortedByDescending { it.seq }
        return HistoryOut(channelLastSeq, rows.take(limit).map { shaped(it, userId) }, rows.size > limit)
    }

    /** Runs once between reading the cursor and the rows of the next GET /sync: a post committed in between (§4.3). */
    var beforeDeltaRows: (() -> Unit)? = null

    fun delta(userId: String, channelId: String, sinceSeq: Int, limit: Int): DeltaOut {
        val record = requireReadable(channelId, userId)
        val channelLastSeq = record.channel.lastSeq // read BEFORE the rows (§4.3)
        beforeDeltaRows?.let { beforeDeltaRows = null; it() }
        val rows = record.messages.filter { it.updatedSeq > sinceSeq }.sortedBy { it.updatedSeq }
        val page = rows.take(limit).map { shaped(it, userId) }
        val hasMore = rows.size > limit
        return DeltaOut(page, if (hasMore) page.last().updatedSeq else maxOf(channelLastSeq, sinceSeq), hasMore)
    }

    fun api(userId: String): Api = Api(userId)

    /** M66: GET /ai/status's answer; null is a server before M65 (every /ai route answers 404). */
    var aiStatus: AiStatusOut? = null
    /** GET /ai/summaries/target's answer; null: a server without the route (404). */
    var aiSummaryTarget: AiSummaryTargetOut? = null
    /** Run id → (who asked, the run as it is now). */
    val aiRuns = LinkedHashMap<String, Pair<String, AiRunOut>>()
    /** Refusals for the next POST /ai/summaries calls, in order (after the request is recorded). */
    val aiSummaryRefusals = ArrayDeque<Throwable>()

    /** M71: GET /ai/ask/target's answer; null is a server before M70 (POST /ai/ask, the target and GET /ai/runs answer 404). */
    var aiAskTarget: AiSummaryTargetOut? = null
    /** Refusals for the next POST /ai/ask calls, in order (after the request is recorded). */
    val aiAskRefusals = ArrayDeque<Throwable>()

    /** The worker moved a run on: stored, and ai.run_updated to the one who asked (unless `silent`: the event lost). */
    fun advanceAiRun(
        runId: String, status: String, output: String? = null, error: String? = null, omittedCount: Int = 0, silent: Boolean = false,
        /** M71: a done ask run's cited messages. */
        sources: List<AiSourceOut>? = null,
    ): AiRunOut {
        val (owner, run) = aiRuns.getValue(runId)
        val next = run.copy(
            status = status, output = output, error = error, omittedCount = omittedCount, finishedAt = if (status == "done" || status == "failed") now() else null,
            sources = sources ?: run.sources,
        )
        aiRuns[runId] = owner to next
        if (!silent) emit(setOf(owner), event("ai.run_updated", null, null, Codec.snake.encodeToJsonElement(AiRunUpdated.serializer(), AiRunUpdated(next)) as JsonObject))
        return next
    }

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

/**
 * Review v0.1.22 #6: one answer held back. It is computed when the call is made (the server as it was then: the setting still
 * on) and goes out, or a failure does, only when the test releases it.
 */
class Hold {
    private val gate = CompletableDeferred<Throwable?>()
    var asked = false
        private set

    fun release(failure: Throwable? = null) {
        gate.complete(failure)
    }

    suspend fun <T> pass(answer: () -> T): T {
        asked = true
        val value = answer()
        gate.await()?.let { throw it }
        return value
    }
}
