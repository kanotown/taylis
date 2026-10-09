package jp.chikuwachat.android

import jp.chikuwachat.android.api.MessageOut
import jp.chikuwachat.android.api.ThreadItem
import jp.chikuwachat.android.api.ThreadState
import jp.chikuwachat.android.sync.EngineOptions
import jp.chikuwachat.android.sync.Store
import jp.chikuwachat.android.sync.SyncEngine
import jp.chikuwachat.android.ui.ThreadCardRules
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

/** The threads list's reply previews (THREADS.md §5): GET /threads `latest_replies`, kept live by message events. */
class ThreadPreviewsTest {
    private class World(val server: FakeServer, val alice: String, val bob: String, val carol: String, val channelId: String, val store: Store, val engine: SyncEngine, val scope: CoroutineScope, val parentId: String)

    private suspend fun settle(engine: SyncEngine) { repeat(20) { engine.idle(); yield() } }

    /** Bob (me) follows his own topic; Alice and Carol reply three times. */
    private suspend fun world(previews: Boolean = true): World {
        val server = FakeServer()
        server.threadPreviews = previews
        val alice = server.addUser("alice")
        val bob = server.addUser("bob")
        val carol = server.addUser("carol")
        val channel = server.createChannel("general", alice.id)
        server.join(channel.id, bob.id)
        server.join(channel.id, carol.id)
        val store = Store()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val time = ManualTime()
        val engine = SyncEngine(server.api(bob.id), server.connector(bob.id), "ws://fake", store, { "token" }, scope,
            EngineOptions(pageSize = 50, reconnectMinMs = 0, sleep = {}, random = { 0.5 }, clock = time.clock, timer = time.timer))
        engine.isActive = { true }
        engine.start(); engine.openChannel(channel.id)
        engine.send(channel.id, "topic"); settle(engine)
        val parent = server.messageByBody(channel.id, "topic")
        server.post(channel.id, alice.id, "first", parentId = parent.id)
        server.post(channel.id, carol.id, "second", parentId = parent.id)
        server.post(channel.id, alice.id, "third", parentId = parent.id)
        engine.flushThreads(); settle(engine)
        engine.loadThreads("all")
        return World(server, alice.id, bob.id, carol.id, channel.id, store, engine, scope, parent.id)
    }

    private fun World.preview() = store.threads[parentId]?.latestReplies?.map { it.body }

    @Test fun theListShowsTheNewestTwoAndEventsKeepThem() = runBlocking {
        val w = world()
        assertEquals(listOf("second", "third"), w.preview())
        val card = ThreadCardRules.replies(w.store.threads[w.parentId]!!, w.bob) { false }!!
        assertEquals(1, card.more)
        assertEquals(listOf(true, true), card.replies.map { it.unread })

        w.server.post(w.channelId, w.carol, "fourth", parentId = w.parentId); settle(w.engine)
        assertEquals(listOf("third", "fourth"), w.preview())
        val fourth = w.server.messageByBody(w.channelId, "fourth")
        w.server.edit(w.channelId, w.carol, fourth.id, "fourth (edited)"); settle(w.engine)
        assertEquals(listOf("third", "fourth (edited)"), w.preview())
        // A shown reply deleted: the next newest one held here takes its place.
        w.engine.loadReplies(w.channelId, w.parentId)
        w.server.delete(w.channelId, w.carol, fourth.id); settle(w.engine)
        assertEquals(listOf("second", "third"), w.preview())
        w.engine.stop(); w.scope.cancel()
    }

    @Test fun anOlderServerSendsNoPreviews() = runBlocking {
        val w = world(previews = false)
        assertNotNull(w.store.threads[w.parentId])
        assertNull(w.preview())
        assertNull(ThreadCardRules.replies(w.store.threads[w.parentId]!!, w.bob) { false })
        w.server.post(w.channelId, w.carol, "fourth", parentId = w.parentId); settle(w.engine)
        assertNull(w.preview())
        w.engine.stop(); w.scope.cancel()
    }

    @Test fun theStoreFollowsRepliesWithoutTheListAndLeavesBlockedPeopleOut() {
        val store = Store()
        fun reply(id: String, seq: Int, sender: String = "u2") =
            MessageOut(id = id, channelId = "c1", senderId = sender, seq = seq, updatedSeq = seq, parentId = "p", body = id, createdAt = "2026-10-07T01:00:00Z", deleted = false)
        val parent = MessageOut(id = "p", channelId = "c1", senderId = "me", seq = 1, updatedSeq = 1, body = "topic", createdAt = "2026-10-07T00:00:00Z", deleted = false, replyCount = 3)
        val state = ThreadState("p", "c1", following = true, lastReadSeq = 3, unreadCount = 1, mentionCount = 0, replyCount = 3)
        store.setThreadPage("all", listOf(ThreadItem(parent, state, listOf(reply("b", 3), reply("c", 4)))), null, append = false, pageSize = 50)
        store.upsertMessage(reply("d", 5))
        assertEquals(listOf("c", "d"), store.threads["p"]?.latestReplies?.map { it.id })
        store.setBlocked("u9", true)
        store.upsertMessage(reply("e", 6, sender = "u9"))
        assertEquals(listOf("c", "d"), store.threads["p"]?.latestReplies?.map { it.id })
        val card = ThreadCardRules.replies(store.threads["p"]!!, "me") { store.isBlocked(it) }!!
        assertEquals(listOf(true, true), card.replies.map { it.unread }) // both after my position 3
        assertEquals(1, card.more)
        // Someone blocked after the list came leaves the card at once; my own reply is never unread.
        val mine = ThreadCardRules.replies(store.threads["p"]!!.copy(latestReplies = listOf(jp.chikuwachat.android.sync.MessageState.from(reply("m", 7, sender = "me")))), "me") { false }!!
        assertEquals(listOf(false), mine.replies.map { it.unread })
        store.setBlocked("u2", true)
        assertEquals(emptyList<String>(), ThreadCardRules.replies(store.threads["p"]!!, "me") { store.isBlocked(it) }!!.replies.map { it.message.id })
    }

    @Test fun theFilterSwitchesLocallyBeforeTheFetch() {
        // 「すべて」/「未読」: the rows held are filtered at once; a page for the filter left meanwhile only adds rows.
        val store = Store()
        fun item(id: String, unread: Int, minute: Int): ThreadItem {
            val at = "2026-10-07T01:%02d:00Z".format(minute)
            val parent = MessageOut(id = id, channelId = "c1", senderId = "me", seq = minute, updatedSeq = minute, body = id, createdAt = at, deleted = false, replyCount = 1)
            return ThreadItem(parent, ThreadState(id, "c1", following = true, lastReadSeq = 0, unreadCount = unread, mentionCount = 0, replyCount = 1, lastReplyAt = at), null)
        }
        store.setThreadPage("all", listOf(item("a", 1, 3), item("b", 0, 2), item("c", 2, 1)), "next", append = false, pageSize = 3)
        assertEquals(true, store.threadsHasMore)
        store.selectThreadsFilter("unread")
        assertEquals("unread", store.threadsFilter)
        assertEquals(listOf("a", "c"), store.threadList().map { it.parent.id })
        assertEquals(false, store.threadsHasMore) // 「さらに表示」 waits for the unread page's cursor
        assertNull(store.threadsCursor)
        store.selectThreadsFilter("all")
        assertEquals(listOf("a", "b", "c"), store.threadList().map { it.parent.id })
        // The unread page arrives after the switch back: its rows merge; the filter, cursor and held rows stay.
        store.setThreadPage("unread", listOf(item("d", 1, 4)), "u", append = false, pageSize = 1)
        assertEquals("all", store.threadsFilter)
        assertNull(store.threadsCursor)
        assertEquals(listOf("d", "a", "b", "c"), store.threadList().map { it.parent.id })
        // The page of the filter shown sets it all, as before.
        store.setThreadPage("all", listOf(item("d", 1, 4)), "n2", append = false, pageSize = 1)
        assertEquals("n2", store.threadsCursor)
        assertEquals(true, store.threadsHasMore)
    }
}
