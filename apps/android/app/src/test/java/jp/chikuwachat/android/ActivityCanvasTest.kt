package jp.chikuwachat.android

import jp.chikuwachat.android.api.ActivityCanvas
import jp.chikuwachat.android.api.ActivityItem
import jp.chikuwachat.android.api.ActivityListOut
import jp.chikuwachat.android.api.ActivitySummaryOut
import jp.chikuwachat.android.api.ApiClient
import jp.chikuwachat.android.api.ChannelOut
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.MessageOut
import jp.chikuwachat.android.sync.ActivityRules
import jp.chikuwachat.android.sync.ChannelState
import jp.chikuwachat.android.sync.EngineOptions
import jp.chikuwachat.android.sync.Store
import jp.chikuwachat.android.sync.SyncEngine
import jp.chikuwachat.android.ui.ActivitySegment
import jp.chikuwachat.android.ui.ActivityTarget
import jp.chikuwachat.android.ui.MainNav
import jp.chikuwachat.android.ui.ActivityText
import jp.chikuwachat.android.ui.ConversationTab
import jp.chikuwachat.android.ui.MainTab
import jp.chikuwachat.android.ui.MainTabs
import jp.chikuwachat.android.ui.Route
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** M77 (CANVAS.md §20.5): the activity's canvas items on Android — reading, the calls, the row and where it opens. */
class ActivityCanvasTest {
    private val messageJson = """{"id":"m1","channel_id":"c1","sender_id":"u1","seq":3,"updated_seq":3,"body":"<@u2> 見て","created_at":"2026-09-30T01:00:00Z","deleted":false}"""
    private val canvasJson = """{"item_id":"i1","canvas_id":"cv1","channel_id":"c1","title":"議事録","excerpt":"次回は @山田 さんが発表","rev_id":"r1"}"""

    // --- reading ---

    @Test fun aCanvasItemIsReadAndBadOrUnknownItemsAreSkippedOneByOne() {
        val page = Codec.snake.decodeFromString(ActivityListOut.serializer(), """
            {"items":[
              {"kind":"canvas_mention","at":"2026-09-30T03:00:00Z","message":null,"actor_ids":["u1"],"emojis":[],"canvas":$canvasJson},
              {"kind":"poll_vote","at":"2026-09-30T02:59:00Z","message":$messageJson,"actor_ids":["u1"]},
              {"kind":"future_kind","at":"2026-09-30T02:58:00Z","actor_ids":["u1"],"something":{"id":"x"}},
              {"kind":"mention","at":"2026-09-30T02:57:00Z","message":null,"actor_ids":["u1"]},
              {"kind":"canvas_mention","at":"2026-09-30T02:56:00Z","actor_ids":["u1"]},
              {"kind":"canvas_mention","at":"2026-09-30T02:55:00Z","actor_ids":["u1"],"canvas":{"item_id":"i9"}},
              {"kind":"mention","at":"2026-09-30T02:54:00Z","message":$messageJson,"actor_ids":"not a list"},
              "not an object",
              {"kind":"mention","at":"2026-09-30T02:00:00Z","message":$messageJson,"actor_ids":["u1"]}
            ],"next_cursor":null,"read_at":"2026-09-30T00:00:00Z"}
        """.trimIndent())
        assertEquals(listOf("canvas_mention", "mention"), page.items.map { it.kind })
        val canvas = page.items[0]
        assertNull(canvas.message)
        assertEquals(ActivityCanvas("i1", "cv1", "c1", "議事録", "次回は @山田 さんが発表", "r1"), canvas.canvas)
        assertEquals(listOf("u1"), canvas.actorIds)
        assertEquals("canvas_mention:i1", canvas.key)
        assertEquals("mention:m1", page.items[1].key)
        assertEquals("<@u2> 見て", page.items[1].message?.body)
        assertEquals("2026-09-30T00:00:00Z", page.readAt)
    }

    @Test fun aPageOfOnlyUnknownItemsIsAnEmptyPageNotAFailure() {
        val page = Codec.snake.decodeFromString(ActivityListOut.serializer(), """
            {"items":[{"kind":"x","at":"2026-09-30T03:00:00Z","actor_ids":[]}],"next_cursor":"2026-09-30T03:00:00Z","read_at":"2026-09-30T00:00:00Z"}
        """.trimIndent())
        assertEquals(emptyList<ActivityItem>(), page.items)
        assertEquals("2026-09-30T03:00:00Z", page.nextCursor) // the next page still comes
    }

    // --- the calls ---

    private fun stubbed(handler: (String) -> String): OkHttpClient =
        OkHttpClient.Builder().addInterceptor(Interceptor { chain ->
            val request = chain.request()
            val body = handler("${request.method} ${request.url.encodedPath}?${request.url.encodedQuery ?: ""}")
            Response.Builder().request(request).protocol(Protocol.HTTP_1_1).code(200).message("stub")
                .body(body.toResponseBody("application/json".toMediaType())).build()
        }).build()

    @Test fun allFourCallsNameTheCanvasItems() = runBlocking {
        val seen = ArrayList<String>()
        val summary = """{"read_at":"2026-09-30T00:00:00Z","unread_count":1,"mention_unread":true}"""
        val client = ApiClient("http://server", stubbed { line ->
            seen.add(line)
            when {
                line.startsWith("GET /api/v1/sync/bootstrap") -> """
                    {"server_time":"2026-09-30T00:00:00Z",
                     "me":{"id":"u","username":"bob","display_name":"Bob","role":"member","created_at":"","updated_at":"","must_change_password":false},
                     "users":[],"channels":[],"limits":{"max_message_length":1,"max_attachment_bytes":1,"max_attachments_per_message":1},
                     "activity":$summary}
                """.trimIndent()
                line.startsWith("GET /api/v1/activity?") -> """{"items":[],"next_cursor":null,"read_at":"2026-09-30T00:00:00Z"}"""
                else -> summary
            }
        })
        client.accessToken = "a"
        assertEquals(1, client.bootstrap().activity?.unreadCount)
        client.listActivity("mentions")
        client.activitySummary()
        client.markActivityRead("2026-09-30T05:00:00Z")
        assertEquals(
            listOf(
                "GET /api/v1/sync/bootstrap?activity_include=canvas_mention",
                "GET /api/v1/activity?filter=mentions&limit=50&include=canvas_mention",
                "GET /api/v1/activity/summary?include=canvas_mention",
                "PUT /api/v1/activity/read?include=canvas_mention",
            ),
            seen,
        )
    }

    // --- the row ---

    private val names = mapOf("u1" to "佐藤", "u2" to "山田")
    private fun canvasItem(title: String = "議事録", actors: List<String> = listOf("u1")) =
        ActivityItem("canvas_mention", "2026-09-30T03:00:00Z", null, actors, emptyList(), ActivityCanvas("i1", "cv1", "c1", title, "抜粋", "r1"))

    private fun message() = MessageOut(
        id = "m1", channelId = "c2", senderId = "u1", seq = 1, updatedSeq = 1, body = "hi",
        createdAt = "2026-09-30T01:00:00Z", deleted = false,
    )

    @Test fun theCanvasRowSaysWhoMentionedMeInWhichCanvasAndWhere() {
        val item = canvasItem()
        assertEquals("佐藤 が「議事録」であなたをメンションしました", ActivityText.headline(item, names::get))
        assertEquals("誰か が「議事録」であなたをメンションしました", ActivityText.headline(canvasItem(actors = listOf("gone")), names::get))
        assertEquals("c1", ActivityText.channelId(item))
        assertEquals("#一般 のキャンバス", ActivityText.where(item, "#一般"))
        assertEquals("山田 のキャンバス", ActivityText.where(item, "山田")) // a DM: the other's name
        assertEquals("", ActivityText.where(item, "")) // a conversation not on this device
        val mention = ActivityItem("mention", "2026-09-30T01:00:00Z", message(), listOf("u1"))
        assertEquals("#一般", ActivityText.where(mention, "#一般"))
        assertEquals("c2", ActivityText.channelId(mention))
        assertEquals("未読 佐藤 が「議事録」であなたをメンションしました、#一般", ActivityText.spokenCanvas(item, names::get, "#一般", unread = true))
        assertEquals("佐藤 が「議事録」であなたをメンションしました", ActivityText.spokenCanvas(item, names::get, "", unread = false))
        // A canvas row is dotted, merged and newest like the others.
        assertTrue(ActivityRules.isUnread(item.at, "2026-09-30T00:00:00Z"))
        assertEquals("2026-09-30T03:00:00Z", ActivityText.newestAt(listOf(mention, item)))
        val moved = item.copy(at = "2026-09-30T04:00:00Z", canvas = item.canvas!!.copy(excerpt = "新しい抜粋"))
        assertEquals(listOf(moved, mention), ActivityText.merge(listOf(item, mention), listOf(moved), pageIsWhole = false))
    }

    // --- opening ---

    @Test fun aCanvasRowOpensTheCanvasOnTheActivityStack() {
        assertEquals(ActivityTarget.Canvas("c1", "cv1"), ActivityText.target(canvasItem()))
        val message = message()
        assertEquals(ActivityTarget.Message(message), ActivityText.target(ActivityItem("mention", "2026-09-30T01:00:00Z", message, listOf("u1"))))
        // Like the message rows: on the activity tab's stack, its conversation's 「キャンバス」 tab with that canvas; back
        // returns to the list (with its filter).
        val activity = listOf<Route>(Route.Activity(ActivitySegment.MENTIONS))
        val opened = MainNav.openCanvas(activity, "c1", "cv1")
        assertEquals(listOf(Route.Activity(ActivitySegment.MENTIONS), Route.Channel("c1", tab = ConversationTab.CANVAS, canvasId = "cv1")), opened)
        // Back: the conversation's 「メッセージ」 tab first (as for any canvas tab), then the activity list.
        assertEquals(ConversationTab.MESSAGES, (MainNav.back(opened).last() as Route.Channel).tab)
        assertEquals(activity, MainNav.back(MainNav.back(opened)))
        // From a message row's conversation already open on the stack: the canvas replaces it, the list stays below.
        val fromMessage = MainNav.openConversation(activity, "c2")
        assertEquals(activity + Route.Channel("c1", tab = ConversationTab.CANVAS, canvasId = "cv1"), MainNav.openCanvas(fromMessage, "c1", "cv1"))
        // The fallback for a conversation the store does not know yet is the M73 push's landing (pendingCanvas): the
        // 「キャンバス」 tab with that canvas, on home for a channel and on the DM tab for a DM.
        val channel = ChannelState(
            channel = ChannelOut(id = "c1", type = "public", name = "一般", archived = false, lastSeq = 0, createdAt = "", updatedAt = ""),
            isMember = true,
        )
        val landed = MainTabs.landCanvas(MainTabs.initial, MainTabs.landingTab(channel), "c1", "cv1")
        assertEquals(MainTab.HOME, landed.selected)
        assertEquals(Route.Channel("c1", tab = ConversationTab.CANVAS, canvasId = "cv1"), MainTabs.stack(landed).last())
        val dm = channel.copy(channel = channel.channel.copy(type = "dm"))
        assertEquals(MainTab.DM, MainTabs.landCanvas(MainTabs.initial, MainTabs.landingTab(dm), "c1", "cv1").selected)
    }

    // --- the badge ---

    private suspend fun settle(engine: SyncEngine) { repeat(20) { engine.idle(); yield() } }

    @Test fun canvasMentionedReadsTheBadgeAndTheListAgain() = runBlocking {
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
        assertEquals(0, api.activitySummaryCalls)

        server.activity[bob.id] = ActivitySummaryOut("2026-09-30T00:00:00Z", 1, true)
        server.emitCanvasMentioned(bob.id, "cv1", channel.id, "議事録", alice.id)
        engine.flushActivity(); settle(engine)
        assertEquals(1, api.activitySummaryCalls)
        assertEquals(ActivitySummaryOut("2026-09-30T00:00:00Z", 1, true), store.activity)
        assertEquals(1, store.activityRevision) // the list on screen reads its first page again
        assertEquals(MainTabs.ActivityBadge(1, mention = true), MainTabs.activityBadge(store.channels.values, store.threadSummary, store.activity))
        // The same canvas again (its unread item moves): read again too.
        server.emitCanvasMentioned(bob.id, "cv1", channel.id, "議事録", alice.id)
        engine.flushActivity(); settle(engine)
        assertEquals(2, api.activitySummaryCalls)
        assertEquals(2, store.activityRevision)
        engine.stop(); scope.cancel()
    }
}
