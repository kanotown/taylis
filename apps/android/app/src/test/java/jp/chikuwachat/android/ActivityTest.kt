package jp.chikuwachat.android

import jp.chikuwachat.android.api.ActivityItem
import jp.chikuwachat.android.api.ActivityListOut
import jp.chikuwachat.android.api.ActivitySummaryOut
import jp.chikuwachat.android.api.ApiClient
import jp.chikuwachat.android.api.BootstrapOut
import jp.chikuwachat.android.api.ChannelOut
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.MessageOut
import jp.chikuwachat.android.api.ParentThread
import jp.chikuwachat.android.api.ThreadSummary
import jp.chikuwachat.android.api.UserMe
import jp.chikuwachat.android.platform.PushMessage
import jp.chikuwachat.android.sync.ActivityRules
import jp.chikuwachat.android.sync.ChannelState
import jp.chikuwachat.android.sync.EngineOptions
import jp.chikuwachat.android.sync.Store
import jp.chikuwachat.android.sync.SyncEngine
import jp.chikuwachat.android.ui.ActivitySegment
import jp.chikuwachat.android.ui.ActivityText
import jp.chikuwachat.android.ui.MainTabs
import jp.chikuwachat.android.ui.Route
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import okio.Buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** M39 (MOBILE_UI.md §6.4, §7.2): the activity tab's wire shapes, badge, unread dots, texts and refresh triggers. */
class ActivityTest {
    private fun message(id: String, sender: String = "alice", body: String = "hi", parentId: String? = null, mentioned: List<String> = emptyList(), all: Boolean = false) =
        MessageOut(
            id = id, channelId = "c1", senderId = sender, seq = 1, updatedSeq = 1, parentId = parentId, body = body,
            mentionedUserIds = mentioned, mentionAll = all, createdAt = "2026-09-30T01:00:00Z", deleted = false,
        )

    private fun me(id: String = "bob", keywords: List<String> = emptyList()) =
        UserMe(id, id, id, "member", null, "", "", null, false, notifyKeywords = keywords)

    // --- parsing ---

    private val messageJson = """{"id":"m1","channel_id":"c1","sender_id":"u1","seq":3,"updated_seq":3,"body":"<@u2> 見て","created_at":"2026-09-30T01:00:00.123456Z","deleted":false}"""

    @Test fun theFeedParsesEveryKindAndTheEmojiDefault() {
        val page = Codec.snake.decodeFromString(ActivityListOut.serializer(), """
            {"items":[
              {"kind":"reaction","at":"2026-09-30T02:00:00Z","message":$messageJson,"actor_ids":["u3","u4"],"emojis":["👍","🎉"]},
              {"kind":"mention","at":"2026-09-30T01:00:00.123456Z","message":$messageJson,"actor_ids":["u1"]},
              {"kind":"thread_reply","at":"2026-09-30T00:59:00Z","message":$messageJson,"actor_ids":["u1"],"emojis":[],"future_field":1}
            ],"next_cursor":"2026-09-30T00:59:00Z","read_at":"2026-09-30T00:00:00Z"}
        """.trimIndent())
        assertEquals(listOf("reaction", "mention", "thread_reply"), page.items.map { it.kind })
        assertEquals(listOf("u3", "u4"), page.items[0].actorIds)
        assertEquals(listOf("👍", "🎉"), page.items[0].emojis)
        assertEquals(emptyList<String>(), page.items[1].emojis)
        assertEquals("<@u2> 見て", page.items[1].message?.body)
        assertEquals("2026-09-30T00:59:00Z", page.nextCursor)
        assertEquals("2026-09-30T00:00:00Z", page.readAt)
        assertEquals("reaction:m1", page.items[0].key)
        val last = Codec.snake.decodeFromString(ActivityListOut.serializer(), """{"items":[],"next_cursor":null,"read_at":"2026-09-30T00:00:00Z"}""")
        assertNull(last.nextCursor)
        val summary = Codec.snake.decodeFromString(ActivitySummaryOut.serializer(), """{"read_at":"2026-09-30T00:00:00Z","unread_count":3,"mention_unread":true}""")
        assertEquals(ActivitySummaryOut("2026-09-30T00:00:00Z", 3, true), summary)
    }

    private fun bootstrapJson(extra: String) = """
        {"server_time":"2026-09-30T00:00:00Z",
         "me":{"id":"u","username":"bob","display_name":"Bob","role":"member","created_at":"","updated_at":"","must_change_password":false$extra},
         "users":[],"channels":[],"limits":{"max_message_length":1,"max_attachment_bytes":1,"max_attachments_per_message":1}
         ${if (extra.isNotEmpty()) ""","activity":{"read_at":"2026-09-30T00:00:00Z","unread_count":5,"mention_unread":false}""" else ""}}
    """.trimIndent()

    @Test fun bootstrapCarriesTheSummaryAndMyReactionSettingOnlyFromM39() {
        val older = Codec.snake.decodeFromString(BootstrapOut.serializer(), bootstrapJson(""))
        assertNull(older.activity)
        assertFalse(older.me.notifyReactions) // absent: off
        val current = Codec.snake.decodeFromString(BootstrapOut.serializer(), bootstrapJson(""","notify_reactions":true"""))
        assertEquals(ActivitySummaryOut("2026-09-30T00:00:00Z", 5, false), current.activity)
        assertTrue(current.me.notifyReactions)
    }

    // --- the badge ---

    private fun channel(id: String, mentions: Int = 0) = ChannelState(
        channel = ChannelOut(id = id, type = "public", name = id, archived = false, lastSeq = 0, createdAt = "2026-01-01T00:00:00Z", updatedAt = "2026-01-01T00:00:00Z"),
        isMember = true, unreadCount = mentions, mentionCount = mentions,
    )

    @Test fun theBadgeIsTheServersCountWithTheFieldAndStageAWithout() {
        val channels = listOf(channel("a", mentions = 2), channel("b"))
        val threads = ThreadSummary(unreadCount = 4)
        // Without bootstrap's `activity` (a server before M39): followed threads + channels with a mention, red with one.
        assertEquals(MainTabs.ActivityBadge(5, mention = true), MainTabs.activityBadge(channels, threads, null))
        // With it: only the server's count; red only while a mention is among the unread items.
        assertEquals(MainTabs.ActivityBadge(3, mention = false), MainTabs.activityBadge(channels, threads, ActivitySummaryOut("t", 3, false)))
        assertEquals(MainTabs.ActivityBadge(2, mention = true), MainTabs.activityBadge(channels, threads, ActivitySummaryOut("t", 2, true)))
        assertEquals(MainTabs.ActivityBadge(0, mention = false), MainTabs.activityBadge(channels, threads, ActivitySummaryOut("t", 0, true)))
        assertEquals(MainTabs.ActivityBadge(99, mention = false), MainTabs.activityBadge(emptyList(), ThreadSummary(), ActivitySummaryOut("t", 99, false)))
    }

    // --- the unread dot ---

    @Test fun anItemNewerThanTheReadPositionHasTheDot() {
        val read = "2026-09-30T01:00:00Z"
        assertTrue(ActivityRules.isUnread("2026-09-30T01:00:00.000001Z", read))
        assertFalse(ActivityRules.isUnread("2026-09-30T01:00:00Z", read)) // at the position: read
        assertFalse(ActivityRules.isUnread("2026-09-30T00:59:59Z", read))
        // Offsets and fractions compare as instants, not as strings.
        assertTrue(ActivityRules.isUnread("2026-09-30T10:00:01+09:00", read))
        assertFalse(ActivityRules.isUnread("2026-09-30T09:59:00+09:00", read))
        // No position (not loaded) or an unreadable time: no dot.
        assertFalse(ActivityRules.isUnread("2026-09-30T02:00:00Z", null))
        assertFalse(ActivityRules.isUnread("garbage", read))
        // A position only moves forward.
        assertEquals("2026-09-30T02:00:00Z", ActivityRules.later("2026-09-30T02:00:00Z", read))
        assertEquals("2026-09-30T02:00:00Z", ActivityRules.later(read, "2026-09-30T02:00:00Z"))
        assertEquals(read, ActivityRules.later(null, read))
    }

    // --- what a row says ---

    private val names = mapOf("u1" to "佐藤", "u2" to "山田", "u3" to "鈴木")
    private fun item(kind: String, actors: List<String>, emojis: List<String> = emptyList(), at: String = "2026-09-30T01:00:00Z", id: String = "m1") =
        ActivityItem(kind, at, message(id), actors, emojis)

    @Test fun headlinesSayWhoDidWhat() {
        assertEquals("佐藤 がメンション", ActivityText.headline(item("mention", listOf("u1")), names::get))
        assertEquals("佐藤 がスレッドに返信", ActivityText.headline(item("thread_reply", listOf("u1")), names::get))
        assertEquals("佐藤 が 👍", ActivityText.headline(item("reaction", listOf("u1"), listOf("👍")), names::get))
        assertEquals("佐藤 ほか 2 人が 👍🎉", ActivityText.headline(item("reaction", listOf("u1", "u2", "u3"), listOf("👍", "🎉")), names::get))
        assertEquals("誰か がメンション", ActivityText.headline(item("mention", listOf("gone")), names::get))
    }

    @Test fun theNewestItemAndARefreshedFirstPage() {
        val a = item("mention", listOf("u1"), at = "2026-09-30T03:00:00Z", id = "a")
        val b = item("reaction", listOf("u1"), listOf("👍"), at = "2026-09-30T02:00:00Z", id = "b")
        val c = item("thread_reply", listOf("u1"), at = "2026-09-30T01:00:00Z", id = "c")
        assertEquals("2026-09-30T03:00:00Z", ActivityText.newestAt(listOf(c, a, b)))
        assertNull(ActivityText.newestAt(emptyList()))
        // A new item on top of a paged list: the page, then the older rows it did not reach.
        val fresh = item("mention", listOf("u2"), at = "2026-09-30T04:00:00Z", id = "d")
        assertEquals(listOf("d", "a", "b", "c"), ActivityText.merge(listOf(a, b, c), listOf(fresh, a), pageIsWhole = false).map { it.message?.id })
        // A row within the page's span that the page no longer has (a reaction taken away) goes.
        val x = item("mention", listOf("u1"), at = "2026-09-30T01:30:00Z", id = "x")
        assertEquals(listOf("d", "x", "c"), ActivityText.merge(listOf(a, b, c), listOf(fresh, x), pageIsWhole = false).map { it.message?.id })
        // More reactions on the same message: its row moves up, once.
        val again = b.copy(at = "2026-09-30T05:00:00Z", actorIds = listOf("u2", "u1"))
        assertEquals(listOf("b", "a", "c"), ActivityText.merge(listOf(a, b, c), listOf(again, a), pageIsWhole = false).map { it.message?.id })
        // A page that is the whole list replaces it (a reaction taken away is gone).
        assertEquals(listOf("a"), ActivityText.merge(listOf(a, b, c), listOf(a), pageIsWhole = true).map { it.message?.id })
    }

    @Test fun theFiltersAreTheServersAndOldSavedRoutesStillOpen() {
        assertEquals(listOf("all", "mentions", "threads", "reactions"), ActivitySegment.entries.map { it.filter })
        assertEquals(listOf("すべて", "メンション", "スレッド", "リアクション"), ActivitySegment.entries.map { it.label })
        assertEquals(ActivitySegment.ALL, Route.Activity().segment)
        // A stack saved by an M34 build (segment MENTIONS / THREADS) decodes as before.
        val saved = """[{"type":"activity","segment":"THREADS"}]"""
        assertEquals(listOf(Route.Activity(ActivitySegment.THREADS)), jp.chikuwachat.android.ui.MainNav.decode(saved))
    }

    // --- when the badge is read again ---

    @Test fun whichNewMessagesAreActivity() {
        val bob = me()
        assertTrue(ActivityRules.isActivity(message("1", mentioned = listOf("bob")), bob, null, false))
        assertTrue(ActivityRules.isActivity(message("2", all = true), bob, null, false))
        assertTrue(ActivityRules.isActivity(message("3", body = "ゼミの件"), me(keywords = listOf("ゼミ")), null, false))
        assertFalse(ActivityRules.isActivity(message("4"), bob, null, false))
        // A reply in a thread I follow: from the event's followers, or the thread state held here.
        val reply = message("5", parentId = "p")
        assertTrue(ActivityRules.isActivity(reply, bob, ParentThread("p", 1, null, 1, listOf("alice", "bob")), false))
        assertTrue(ActivityRules.isActivity(reply, bob, null, followingHeld = true))
        assertFalse(ActivityRules.isActivity(reply, bob, ParentThread("p", 1, null, 1, listOf("alice")), false))
        // Mine, or deleted, never.
        assertFalse(ActivityRules.isActivity(message("6", sender = "bob", mentioned = listOf("bob")), bob, null, false))
        assertFalse(ActivityRules.isActivity(message("7", mentioned = listOf("bob")).copy(deleted = true), bob, null, false))
        assertFalse(ActivityRules.isActivity(message("8", mentioned = listOf("bob")), null, null, false))
    }

    private suspend fun settle(engine: SyncEngine) { repeat(20) { engine.idle(); yield() } }

    @Test fun theEngineReadsTheSummaryAgainAfterTheEventsThatMoveIt() = runBlocking {
        val server = FakeServer()
        val alice = server.addUser("alice")
        val bob = server.addUser("bob")
        val channel = server.createChannel("general", alice.id)
        server.join(channel.id, bob.id)
        server.activity[bob.id] = ActivitySummaryOut("2026-09-30T00:00:00Z", 0, false)
        val store = Store()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val api = server.api(bob.id)
        val engine = SyncEngine(api, server.connector(bob.id), "ws://fake", store, { "token" }, scope, EngineOptions(sleep = {}, reconnectMinMs = 0, random = { 0.5 }))
        engine.isActive = { false }
        engine.start(); settle(engine)
        assertEquals(ActivitySummaryOut("2026-09-30T00:00:00Z", 0, false), store.activity) // from bootstrap
        assertEquals(0, api.activitySummaryCalls)

        // Someone reacts to my message: reaction.added.
        val (mine, _) = server.post(channel.id, bob.id, "mine")
        server.activity[bob.id] = ActivitySummaryOut("2026-09-30T00:00:00Z", 1, false)
        server.react(channel.id, alice.id, mine.id, "👍", present = true)
        engine.flushActivity(); settle(engine)
        assertEquals(1, api.activitySummaryCalls)
        assertEquals(1, store.activity?.unreadCount)
        assertEquals(1, store.activityRevision)

        // A plain message, or a reaction to someone else's: nothing to read again.
        val (theirs, _) = server.post(channel.id, alice.id, "hello")
        server.react(channel.id, bob.id, theirs.id, "👍", present = true)
        server.react(channel.id, alice.id, mine.id, "👍", present = false) // taken away: no event
        engine.flushActivity(); settle(engine)
        assertEquals(1, api.activitySummaryCalls)

        // A mention of me.
        server.activity[bob.id] = ActivitySummaryOut("2026-09-30T00:00:00Z", 2, true)
        server.post(channel.id, alice.id, "<@${bob.id}> 見て")
        engine.flushActivity(); settle(engine)
        assertEquals(2, api.activitySummaryCalls)
        assertEquals(ActivitySummaryOut("2026-09-30T00:00:00Z", 2, true), store.activity)

        // A reply in a thread I follow (I replied in it), not my own reply nor one in a thread I do not follow.
        val (topic, _) = server.post(channel.id, alice.id, "topic")
        server.post(channel.id, bob.id, "my reply", parentId = topic.id)
        engine.flushActivity(); settle(engine)
        assertEquals(2, api.activitySummaryCalls)
        server.post(channel.id, alice.id, "their reply", parentId = topic.id)
        engine.flushActivity(); settle(engine)
        assertEquals(3, api.activitySummaryCalls)
        val (other, _) = server.post(channel.id, alice.id, "other topic")
        server.post(channel.id, alice.id, "self reply", parentId = other.id)
        engine.flushActivity(); settle(engine)
        assertEquals(3, api.activitySummaryCalls)
        assertEquals(3, store.activityRevision)

        // My other device read the activity: activity.read.
        server.activity[bob.id] = ActivitySummaryOut("2026-09-30T05:00:00Z", 0, false)
        server.emitActivityRead(bob.id, "2026-09-30T05:00:00Z")
        engine.flushActivity(); settle(engine)
        assertEquals(4, api.activitySummaryCalls)
        assertEquals(ActivitySummaryOut("2026-09-30T05:00:00Z", 0, false), store.activity)
        assertEquals(3, store.activityRevision) // no new item

        // A reconnect corrects the badge from bootstrap (events may have been lost meanwhile).
        server.activity[bob.id] = ActivitySummaryOut("2026-09-30T05:00:00Z", 7, true)
        server.disconnect(bob.id); settle(engine)
        assertEquals(7, store.activity?.unreadCount)
        engine.stop(); scope.cancel()
    }

    @Test fun anOlderServerKeepsTheStageABadgeAndIsNeverAskedForASummary() = runBlocking {
        val server = FakeServer()
        val alice = server.addUser("alice")
        val bob = server.addUser("bob")
        val channel = server.createChannel("general", alice.id)
        server.join(channel.id, bob.id)
        val store = Store()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val api = server.api(bob.id)
        val engine = SyncEngine(api, server.connector(bob.id), "ws://fake", store, { "token" }, scope, EngineOptions(sleep = {}, reconnectMinMs = 0, random = { 0.5 }))
        engine.isActive = { false }
        engine.start(); settle(engine)
        val (mine, _) = server.post(channel.id, bob.id, "mine")
        server.react(channel.id, alice.id, mine.id, "👍", present = true)
        server.post(channel.id, alice.id, "<@${bob.id}> 見て")
        engine.flushActivity(); settle(engine)
        assertNull(store.activity)
        assertEquals(0, api.activitySummaryCalls)
        assertEquals(MainTabs.ActivityBadge(1, mention = true), MainTabs.activityBadge(store.channels.values, store.threadSummary, store.activity))
        engine.stop(); scope.cancel()
    }

    // --- the API and the push ---

    private fun stubbed(handler: (Request) -> Pair<Int, String>): OkHttpClient =
        OkHttpClient.Builder().addInterceptor(Interceptor { chain ->
            val (status, body) = handler(chain.request())
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(status).message("stub")
                .body(body.toResponseBody("application/json".toMediaType())).build()
        }).build()

    @Test fun theClientAsksForAFilteredPageAndMovesTheReadPosition() = runBlocking {
        val requests = ArrayList<Pair<String, String?>>()
        val client = ApiClient("http://server", stubbed { request ->
            val body = request.body?.let { b -> Buffer().also { b.writeTo(it) }.readUtf8() }
            requests.add("${request.method} ${request.url.encodedPath}?${request.url.encodedQuery ?: ""}" to body)
            when (request.url.encodedPath) {
                "/api/v1/activity" -> 200 to """{"items":[],"next_cursor":null,"read_at":"2026-09-30T00:00:00Z"}"""
                else -> 200 to """{"read_at":"2026-09-30T05:00:00Z","unread_count":0,"mention_unread":false}"""
            }
        })
        client.accessToken = "a"
        client.listActivity("reactions", cursor = "2026-09-30T01:00:00.5+00:00")
        val summary = client.markActivityRead("2026-09-30T05:00:00Z")
        client.activitySummary()
        // M77: every activity call names the canvas items (CANVAS.md §20.5; ActivityCanvasTest checks bootstrap too).
        assertEquals("GET /api/v1/activity?filter=reactions&limit=50&include=canvas_mention&include=reservation&cursor=2026-09-30T01%3A00%3A00.5%2B00%3A00", requests[0].first)
        assertEquals("PUT /api/v1/activity/read?include=canvas_mention&include=reservation", requests[1].first)
        assertEquals("2026-09-30T05:00:00Z", Codec.plain.parseToJsonElement(requests[1].second!!).jsonObject["read_at"]?.jsonPrimitive?.content)
        assertEquals("GET /api/v1/activity/summary?include=canvas_mention&include=reservation", requests[2].first)
        assertEquals(0, summary.unreadCount)
    }

    @Test fun aReactionPushStandsAloneAndOpensTheMessage() {
        val push = PushMessage.parse(mapOf(
            "kind" to "reaction", "channel_id" to "c1", "message_id" to "m1", "title" to "佐藤 がリアクションしました", "subtitle" to "#輪講",
            "body" to "👍 「スライド v2 です」", "collapse_key" to "reaction:m1",
        ))!!
        assertTrue(push.isReaction)
        assertFalse(push.isSilent)
        assertEquals("reaction:m1", push.notificationKey) // not the channel's message notification
        assertEquals("reaction:m1", push.copy(collapseKey = null).notificationKey)
        assertEquals("佐藤 がリアクションしました · #輪講", push.displayTitle)
        assertFalse(PushMessage.parse(mapOf("kind" to "message", "channel_id" to "c1"))!!.isReaction)
    }
}
