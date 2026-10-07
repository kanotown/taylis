package jp.chikuwachat.android

import jp.chikuwachat.android.api.ActivityItem
import jp.chikuwachat.android.api.ActivityListOut
import jp.chikuwachat.android.api.ActivitySummaryOut
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.MessageOut
import jp.chikuwachat.android.sync.ActivityRules
import jp.chikuwachat.android.sync.EngineOptions
import jp.chikuwachat.android.sync.Store
import jp.chikuwachat.android.sync.SyncEngine
import jp.chikuwachat.android.ui.ActivityFeed
import jp.chikuwachat.android.ui.ActivityText
import java.time.Instant
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * MOBILE_UI.md §6.4 (2026-10-07, 「開いたら既読」): looking at the activity reads nothing; an item stays unread until it
 * is opened (PUT /activity/items/read), read in its conversation, marked all read, or done — on any of my devices.
 */
class ActivityOpenedReadTest {
    private val readAt = "2026-10-07T00:00:00Z"

    private fun message(id: String, seq: Int, channelId: String) =
        MessageOut(
            id = id, channelId = channelId, senderId = "alice", seq = seq, updatedSeq = seq, body = "hi",
            createdAt = "2026-10-07T01:00:00Z", deleted = false,
        )

    private fun item(kind: String, message: MessageOut, at: String, id: String? = message.id, read: Boolean? = false) =
        ActivityItem(kind = kind, at = at, message = message, actorIds = listOf("alice"), read = read, id = id)

    private suspend fun settle(engine: SyncEngine) { repeat(20) { engine.idle(); yield() } }

    private class Setup(val server: FakeServer, val bob: String, val channel: String, val store: Store, val api: FakeServer.Api, val engine: SyncEngine, val scope: CoroutineScope)

    private suspend fun setup(): Setup {
        val server = FakeServer()
        val alice = server.addUser("alice")
        val bob = server.addUser("bob")
        val channel = server.createChannel("general", alice.id)
        server.join(channel.id, bob.id)
        server.activity[bob.id] = ActivitySummaryOut(readAt, 2, true)
        val store = Store()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val api = server.api(bob.id)
        val engine = SyncEngine(api, server.connector(bob.id), "ws://fake", store, { "token" }, scope, EngineOptions(sleep = {}, reconnectMinMs = 0, random = { 0.5 }))
        engine.isActive = { false }
        engine.start(); settle(engine)
        return Setup(server, bob.id, channel.id, store, api, engine, scope)
    }

    /** Two items after the read position: a mention (seq 50, not read in its conversation) and a reaction. */
    private fun page(channelId: String, ids: Boolean = true) = ActivityListOut(
        items = listOf(
            item("mention", message("00000000-0000-0000-0000-00000000000a", 50, channelId), "2026-10-07T02:00:00Z", read = if (ids) false else null)
                .let { if (ids) it else it.copy(id = null) },
            item("reaction", message("00000000-0000-0000-0000-00000000000b", 49, channelId), "2026-10-07T01:30:00Z", read = if (ids) false else null)
                .let { if (ids) it else it.copy(id = null) },
        ),
        nextCursor = null, readAt = readAt,
    )

    private fun feed(page: ActivityListOut) = ActivityFeed(null, list = { _, _ -> Result.success(page) })

    @Test fun theItemIdIsOptionalOnTheWire() {
        val json = """{"kind":"mention","at":"2026-10-07T01:00:00Z","message":{"id":"m1","channel_id":"c1","sender_id":"u1","seq":3,"updated_seq":3,"body":"x","created_at":"2026-10-07T01:00:00Z","deleted":false},"actor_ids":["u1"]"""
        val page = Codec.snake.decodeFromString(ActivityListOut.serializer(), """{"items":[$json,"id":"9f0c"},$json}],"next_cursor":null,"read_at":"$readAt"}""")
        assertEquals(listOf("9f0c", null), page.items.map { it.id })
    }

    @Test fun showingTheListReadsNothing() = runBlocking {
        val s = setup()
        val feed = feed(page(s.channel))
        feed.load("all")
        settle(s.engine)
        s.engine.flushActivity(); settle(s.engine)
        assertTrue(s.api.markActivityReadCalls.isEmpty())
        assertTrue(s.api.markActivityItemsReadCalls.isEmpty())
        assertEquals(2, s.store.activity?.unreadCount)
        assertEquals(listOf(true, true), feed.items!!.map { feed.unread(it, s.store) })
        // Another filter, a reload: still nothing read.
        feed.load("mentions"); feed.refresh()
        settle(s.engine)
        assertTrue(s.api.markActivityReadCalls.isEmpty())
        s.engine.stop(); s.scope.cancel()
    }

    @Test fun openingARowReadsOnlyThatItem() = runBlocking {
        val s = setup()
        val feed = feed(page(s.channel))
        feed.load("all")
        val (mention, reaction) = feed.items!!
        assertTrue(s.engine.markActivityItemsRead(listOf(reaction)))
        settle(s.engine)
        assertEquals(listOf(listOf(reaction.id!!)), s.api.markActivityItemsReadCalls)
        assertTrue(s.api.markActivityReadCalls.isEmpty())
        assertFalse(feed.unread(reaction, s.store))
        assertTrue(feed.unread(mention, s.store))
        assertEquals(1, s.store.activity?.unreadCount) // the server's answer is the badge
        // 「未読のみ」: the opened row leaves the list.
        feed.unreadOnly = true
        assertEquals(listOf(mention.key), feed.shown(s.store)!!.map { it.key })
        // A newer reaction to the same message (its `at` moves on): unread again.
        val again = reaction.copy(at = "2999-01-01T00:00:00Z") // later than any opened time, whatever the clock says
        assertTrue(feed.unread(again, s.store))
        s.engine.stop(); s.scope.cancel()
    }

    @Test fun theDotGoesAtOnceWithTheRowsOwnTime() = runBlocking {
        val s = setup()
        val feed = feed(page(s.channel))
        feed.load("all")
        val mention = feed.items!!.first()
        s.api.pendingFailure = java.io.IOException("offline") // the request fails: the dot is gone already (read as shown)
        runCatching { s.engine.markActivityItemsRead(listOf(mention)) }
        assertEquals(mention.at, s.store.openedActivityItems[mention.id])
        assertFalse(feed.unread(mention, s.store))
        s.engine.stop(); s.scope.cancel()
    }

    @Test fun markAllReadsEverything() = runBlocking {
        val s = setup()
        val feed = feed(page(s.channel))
        feed.load("all")
        val at = ActivityRules.markAllAt(feed.items!!, Instant.parse("2026-10-07T03:00:00Z"))
        assertEquals("2026-10-07T03:00:00Z", at)
        // A device clock behind the server's: the newest row held at least.
        assertEquals("2026-10-07T02:00:00Z", ActivityRules.markAllAt(feed.items!!, Instant.parse("2026-10-07T01:00:00Z")))
        s.engine.markActivityRead(at)
        settle(s.engine)
        assertEquals(listOf(at), s.api.markActivityReadCalls)
        assertEquals(0, s.store.activity?.unreadCount)
        assertEquals(listOf(false, false), feed.items!!.map { feed.unread(it, s.store) })
        s.engine.stop(); s.scope.cancel()
    }

    @Test fun myOtherDevicesClearTheDotsLive() = runBlocking {
        val s = setup()
        val feed = feed(page(s.channel))
        feed.load("all")
        val (mention, reaction) = feed.items!!
        // Opened on another device: activity.items_read.
        s.server.emitActivityItemsRead(s.bob, listOf(mention.id!!), "2026-10-07T05:00:00Z")
        settle(s.engine)
        assertFalse(feed.unread(mention, s.store))
        assertTrue(feed.unread(reaction, s.store))
        // An older time for the same item does not move it back.
        s.store.noteActivityItemsRead(listOf(mention.id!!), "2026-10-07T00:30:00Z")
        assertEquals("2026-10-07T05:00:00Z", s.store.openedActivityItems[mention.id])
        // 「すべて既読にする」 on another device: activity.read.
        s.server.activity[s.bob] = ActivitySummaryOut("2026-10-07T06:00:00Z", 0, false)
        s.server.emitActivityRead(s.bob, "2026-10-07T06:00:00Z")
        settle(s.engine)
        assertFalse(feed.unread(reaction, s.store)) // at once, before the summary comes
        s.engine.flushActivity(); settle(s.engine)
        assertEquals(0, s.store.activity?.unreadCount)
        s.engine.stop(); s.scope.cancel()
    }

    @Test fun anOlderServerWithoutItemIdsIsNotAskedAndItsItemsWaitForTheReadPosition() = runBlocking {
        val s = setup()
        val feed = feed(page(s.channel, ids = false))
        feed.load("all")
        val mention = feed.items!!.first()
        assertNull(mention.id)
        assertFalse(s.engine.markActivityItemsRead(listOf(mention)))
        assertTrue(s.api.markActivityItemsReadCalls.isEmpty())
        assertTrue(feed.unread(mention, s.store)) // still unread: 「すべて既読にする」 or its conversation reads it
        // 「すべて既読にする」 reads it (as the read position always did).
        s.engine.markActivityRead("2026-10-07T03:00:00Z")
        assertFalse(feed.unread(mention, s.store))
        s.engine.stop(); s.scope.cancel()
    }

    @Test fun theHeaderCountsTheUnread() {
        assertEquals("未読はありません", ActivityText.unreadLabel(0))
        assertEquals("未読 3 件", ActivityText.unreadLabel(3))
        assertEquals("未読 99+ 件", ActivityText.unreadLabel(99))
    }
}
