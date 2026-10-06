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
 * MOBILE_UI.md §6.4 (2026-10-06): a mention or thread reply read in its conversation or thread is read in the activity
 * too: the `read` flag, the dots, and the badge read again on read.updated / thread.updated (reason "read").
 */
class ActivityReadRuleTest {
    private fun message(id: String, seq: Int, parentId: String? = null, alsoInChannel: Boolean = false, channelId: String = "c1") =
        MessageOut(
            id = id, channelId = channelId, senderId = "alice", seq = seq, updatedSeq = seq, parentId = parentId, body = "hi",
            createdAt = "2026-10-06T01:00:00Z", deleted = false, alsoInChannel = alsoInChannel,
        )

    private fun item(kind: String, message: MessageOut, at: String = "2026-10-06T01:00:00Z", read: Boolean? = null) =
        ActivityItem(kind = kind, at = at, message = message, actorIds = listOf("alice"), read = read)

    @Test fun theReadFlagIsOptional() {
        val page = Codec.snake.decodeFromString(ActivityListOut.serializer(), """
            {"items":[
              {"kind":"mention","at":"2026-10-06T01:00:00Z","message":{"id":"m1","channel_id":"c1","sender_id":"u1","seq":3,"updated_seq":3,"body":"x","created_at":"2026-10-06T01:00:00Z","deleted":false},"actor_ids":["u1"],"read":true},
              {"kind":"mention","at":"2026-10-06T00:59:00Z","message":{"id":"m2","channel_id":"c1","sender_id":"u1","seq":2,"updated_seq":2,"body":"x","created_at":"2026-10-06T00:59:00Z","deleted":false},"actor_ids":["u1"],"read":null},
              {"kind":"mention","at":"2026-10-06T00:58:00Z","message":{"id":"m3","channel_id":"c1","sender_id":"u1","seq":1,"updated_seq":1,"body":"x","created_at":"2026-10-06T00:58:00Z","deleted":false},"actor_ids":["u1"]}
            ],"next_cursor":null,"read_at":"2026-10-06T00:00:00Z"}
        """.trimIndent())
        assertEquals(listOf(true, null, null), page.items.map { it.read })
    }

    @Test fun aTimelineRowIsReadByTheChannelPositionAReplyByItsThreads() {
        val channels = mapOf("c1" to 5)
        val threads = mapOf("p" to 8)
        fun read(item: ActivityItem) = ActivityRules.readInConversation(item, { channels[it] }, { threads[it] })
        // Top level: the channel's position.
        assertTrue(read(item("mention", message("a", 5))))
        assertFalse(read(item("mention", message("b", 6))))
        assertFalse(read(item("mention", message("c", 5, channelId = "c2")))) // no position held: 0
        // A reply: its thread's position, not the channel's.
        assertTrue(read(item("thread_reply", message("d", 8, parentId = "p"))))
        assertFalse(read(item("thread_reply", message("e", 9, parentId = "p"))))
        assertFalse(read(item("thread_reply", message("f", 3, parentId = "q")))) // channel 5 does not cover a thread reply
        assertTrue(read(item("mention", message("g", 4, parentId = "p"))))
        // A reply also sent to the channel: either one.
        assertTrue(read(item("thread_reply", message("h", 4, parentId = "q", alsoInChannel = true))))
        assertTrue(read(item("thread_reply", message("i", 7, parentId = "p", alsoInChannel = true))))
        assertFalse(read(item("thread_reply", message("j", 9, parentId = "p", alsoInChannel = true))))
        // Reactions keep the read-position rule only.
        assertFalse(read(item("reaction", message("k", 1))))
    }

    @Test fun theDotFollowsTheBaselineAndTheConversation() {
        val newer = item("mention", message("a", 5), at = "2026-10-06T02:00:00Z")
        val baseline = "2026-10-06T01:30:00Z"
        assertTrue(ActivityRules.showsUnread(newer, baseline, conversationRule = true, serverRead = false, readHere = false))
        assertFalse(ActivityRules.showsUnread(newer, baseline, conversationRule = true, serverRead = true, readHere = false))
        assertFalse(ActivityRules.showsUnread(newer, baseline, conversationRule = true, serverRead = false, readHere = true))
        // An older server (no `read`): the time alone, as before.
        assertTrue(ActivityRules.showsUnread(newer, baseline, conversationRule = false, serverRead = false, readHere = true))
        // Older than the baseline: never a dot.
        assertFalse(ActivityRules.showsUnread(newer, "2026-10-06T03:00:00Z", conversationRule = true, serverRead = false, readHere = false))
    }

    @Test fun theServerFlagCountsAsReadInTheConversationOnlyPastThePagesReadPosition() {
        val readAt = "2026-10-06T01:30:00Z"
        assertTrue(ActivityRules.readByServerInConversation(item("mention", message("a", 1), at = "2026-10-06T02:00:00Z", read = true), readAt))
        assertFalse(ActivityRules.readByServerInConversation(item("mention", message("a", 1), at = "2026-10-06T02:00:00Z", read = false), readAt))
        assertFalse(ActivityRules.readByServerInConversation(item("mention", message("a", 1), at = "2026-10-06T02:00:00Z"), readAt))
        // Covered by the read position: read by time (the list's baseline keeps its dot while it is looked at).
        assertFalse(ActivityRules.readByServerInConversation(item("mention", message("a", 1), at = "2026-10-06T01:00:00Z", read = true), readAt))
    }

    private suspend fun settle(engine: SyncEngine) { repeat(20) { engine.idle(); yield() } }

    @Test fun readingInTheConversationOrThreadReadsTheBadgeAgain() = runBlocking {
        val server = FakeServer()
        val alice = server.addUser("alice")
        val bob = server.addUser("bob")
        val channel = server.createChannel("general", alice.id)
        server.join(channel.id, bob.id)
        server.activity[bob.id] = ActivitySummaryOut("2026-10-06T00:00:00Z", 0, false)
        val store = Store()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val api = server.api(bob.id)
        val engine = SyncEngine(api, server.connector(bob.id), "ws://fake", store, { "token" }, scope, EngineOptions(sleep = {}, reconnectMinMs = 0, random = { 0.5 }))
        engine.isActive = { false }
        engine.start(); settle(engine)

        // A mention in a thread: the badge counts it.
        val (topic, _) = server.post(channel.id, alice.id, "topic")
        server.activity[bob.id] = ActivitySummaryOut("2026-10-06T00:00:00Z", 1, true)
        val (reply, _) = server.post(channel.id, alice.id, "<@${bob.id}> 見て", parentId = topic.id)
        engine.flushActivity(); settle(engine)
        assertEquals(1, api.activitySummaryCalls)
        assertEquals(1, store.activity?.unreadCount)

        // Read in the thread (on any of my devices): thread.updated, reason "read".
        server.activity[bob.id] = ActivitySummaryOut("2026-10-06T00:00:00Z", 0, false)
        server.markThreadRead(bob.id, topic.id, reply.seq)
        engine.flushActivity(); settle(engine)
        assertEquals(2, api.activitySummaryCalls)
        assertEquals(0, store.activity?.unreadCount)
        assertEquals(reply.seq, store.threadReadSeqs[topic.id]) // the list's dots follow it

        // Read in the channel: read.updated.
        val (mention, _) = server.post(channel.id, alice.id, "<@${bob.id}> こっちも")
        engine.flushActivity(); settle(engine)
        assertEquals(3, api.activitySummaryCalls)
        server.markRead(bob.id, channel.id, mention.seq)
        engine.flushActivity(); settle(engine)
        assertEquals(4, api.activitySummaryCalls)
        assertEquals(0, store.activityReloads)

        // 「ここから未読にする」: the position goes back, and the list on screen loads again.
        server.markRead(bob.id, channel.id, 1, mode = "set")
        engine.flushActivity(); settle(engine)
        assertEquals(5, api.activitySummaryCalls)
        assertEquals(1, store.activityReloads)
        engine.stop(); scope.cancel()
    }

    @Test fun anOlderServerIsNotAskedOnReads() = runBlocking {
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
        val (m, _) = server.post(channel.id, alice.id, "hello")
        server.markRead(bob.id, channel.id, m.seq)
        server.markRead(bob.id, channel.id, 0, mode = "set")
        engine.flushActivity(); settle(engine)
        assertNull(store.activity)
        assertEquals(0, api.activitySummaryCalls)
        assertEquals(0, store.activityReloads)
        engine.stop(); scope.cancel()
    }
}
