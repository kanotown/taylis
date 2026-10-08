package jp.chikuwachat.android

import jp.chikuwachat.android.api.MessageOut
import jp.chikuwachat.android.api.ThreadItem
import jp.chikuwachat.android.api.ThreadState
import jp.chikuwachat.android.api.ThreadSummary
import jp.chikuwachat.android.sync.EngineOptions
import jp.chikuwachat.android.sync.Store
import jp.chikuwachat.android.sync.SyncEngine
import jp.chikuwachat.android.ui.MainNav
import jp.chikuwachat.android.ui.Route
import jp.chikuwachat.android.ui.SearchParams
import jp.chikuwachat.android.ui.ThreadFrom
import jp.chikuwachat.android.ui.ThreadRootWatch
import jp.chikuwachat.android.ui.ThreadRootWatch.Outcome
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
 * THREADS.md: a thread whose root is deleted. Shown live, it closes (with 「元のメッセージが削除されたため、スレッドを閉じました」
 * unless I deleted the root from the thread's root row); opened on a root already deleted, it shows the deleted state.
 * The store drops the thread's row from 「スレッド」 and its local draft.
 */
class ThreadRootDeletedTest {
    private class World(
        val server: FakeServer, val alice: String, val bob: String, val channelId: String, val store: Store, val engine: SyncEngine,
        val scope: CoroutineScope, val parentId: String, val watch: ThreadRootWatch = ThreadRootWatch(),
    ) {
        fun outcome() = watch.outcome(parentId, store.isRootDeleted(parentId))
        fun close() = watch.close(parentId, store.isRootDeleted(parentId))
        /** ThreadPane's open: watched, then the replies fetched (live when they load). */
        suspend fun open(): Boolean {
            watch.opened(parentId)
            return engine.loadReplies(channelId, parentId).also { if (it) watch.loaded(parentId, store.isRootDeleted(parentId)) }
        }
    }

    private suspend fun settle(engine: SyncEngine) { repeat(20) { engine.idle(); yield() } }

    /** Bob (me); `rootBy` posts the topic, both reply (Bob follows the thread). `timeline`: Bob's engine holds the channel's rows. */
    private suspend fun world(rootBy: String = "alice", timeline: Boolean = true, start: Boolean = true): World {
        val server = FakeServer()
        val alice = server.addUser("alice")
        val bob = server.addUser("bob")
        val channel = server.createChannel("general", alice.id)
        server.join(channel.id, bob.id)
        val author = if (rootBy == "alice") alice.id else bob.id
        val (parent, _) = server.post(channel.id, author, "topic")
        server.post(channel.id, alice.id, "first", parentId = parent.id)
        server.post(channel.id, bob.id, "second", parentId = parent.id)
        val store = Store()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val time = ManualTime()
        val engine = SyncEngine(server.api(bob.id), server.connector(bob.id), "ws://fake", store, { "token" }, scope,
            EngineOptions(pageSize = 50, reconnectMinMs = 0, sleep = {}, random = { 0.5 }, clock = time.clock, timer = time.timer))
        engine.isActive = { true }
        if (start) {
            engine.start()
            if (timeline) engine.openChannel(channel.id)
            settle(engine)
            engine.loadThreads("all")
        }
        return World(server, alice.id, bob.id, channel.id, store, engine, scope, parent.id)
    }

    @Test fun rootDeletedByEventClosesTheThreadWithNotice() = runBlocking {
        val w = world()
        assertTrue(w.open())
        assertEquals(Outcome.SHOWN, w.outcome())
        w.server.delete(w.channelId, w.alice, w.parentId); settle(w.engine)
        assertTrue(w.store.isRootDeleted(w.parentId))
        assertEquals(Outcome.CLOSE_WITH_NOTICE, w.close())
        // Taken once: asked again (the screen still composed for a frame), it only shows the deleted state.
        assertEquals(Outcome.DELETED_STATE, w.close())
        w.engine.stop(); w.scope.cancel()
    }

    @Test fun selfDeleteFromTheThreadViewClosesWithoutNotice() = runBlocking {
        val w = world(rootBy = "bob")
        assertTrue(w.open())
        // AppController.deleteMessage(fromThreadRoot = true): marked before the call, the answer applied to the store.
        w.watch.deletingFromThread(w.parentId)
        w.store.upsertMessage(w.server.delete(w.channelId, w.bob, w.parentId)); settle(w.engine)
        assertEquals(Outcome.CLOSE, w.close())
        w.engine.stop(); w.scope.cancel()
    }

    @Test fun aFailedSelfDeleteLeavesTheNoticeForALaterDeletion() = runBlocking {
        val w = world(rootBy = "bob")
        assertTrue(w.open())
        w.watch.deletingFromThread(w.parentId)
        w.watch.deleteFailed(w.parentId)
        w.server.delete(w.channelId, w.alice, w.parentId); settle(w.engine) // e.g. an admin, or another device
        assertEquals(Outcome.CLOSE_WITH_NOTICE, w.close())
        w.engine.stop(); w.scope.cancel()
    }

    @Test fun aThreadHeldOnlyThroughTheListTakesItsRootsDeletion() = runBlocking {
        // No timeline for the channel, the replies not fetched: the root is held only as the 「スレッド」 list's row.
        val w = world(timeline = false)
        assertTrue(w.store.threads.containsKey(w.parentId))
        assertNull(w.store.message(w.channelId, w.parentId))
        w.store.setDraft(w.channelId, w.parentId) { it.copy(text = "unsent reply") }
        w.server.delete(w.channelId, w.alice, w.parentId); settle(w.engine)
        assertTrue(w.store.isRootDeleted(w.parentId))
        assertFalse(w.store.threads.containsKey(w.parentId))
        assertEquals("", w.store.draft(w.channelId, w.parentId).text)
        w.engine.stop(); w.scope.cancel()
    }

    @Test fun aRefetchAnswering404ClosesALiveThread() = runBlocking {
        val w = world()
        assertTrue(w.open())
        // The event is lost (disconnected); the refetch after the reconnect answers 404 message_not_found.
        w.engine.stop()
        w.server.delete(w.channelId, w.alice, w.parentId)
        w.engine.start(); settle(w.engine)
        assertFalse(w.engine.loadReplies(w.channelId, w.parentId)) // no exception: not an error to show
        assertTrue(w.store.isRootDeleted(w.parentId))
        assertEquals(Outcome.CLOSE_WITH_NOTICE, w.close())
        w.engine.stop(); w.scope.cancel()
    }

    @Test fun openedOnARootAlreadyDeletedShowsTheDeletedStateAndDoesNotClose() = runBlocking {
        val w = world(start = false)
        w.server.delete(w.channelId, w.alice, w.parentId)
        w.engine.start(); settle(w.engine)
        // A stale link / activity row / notification: the replies answer 404, which is no error.
        assertFalse(w.open())
        assertTrue(w.store.isRootDeleted(w.parentId))
        assertEquals(Outcome.DELETED_STATE, w.outcome())
        assertEquals(Outcome.DELETED_STATE, w.close())
        w.engine.stop(); w.scope.cancel()
    }

    @Test fun theStoreDropsTheThreadRowAndItsDraft() {
        val store = Store()
        val parent = MessageOut(id = "p", channelId = "c1", senderId = "u2", seq = 1, updatedSeq = 1, body = "topic", createdAt = "2026-10-09T00:00:00Z", deleted = false, replyCount = 2)
        val state = ThreadState("p", "c1", following = true, lastReadSeq = 0, unreadCount = 2, mentionCount = 1, replyCount = 2)
        store.setThreadPage("all", listOf(ThreadItem(parent, state, null)), null, append = false, pageSize = 50)
        store.setThreadSummary(ThreadSummary(1, 1))
        store.upsertMessage(parent)
        store.setDraft("c1", "p") { it.copy(text = "reply") }
        store.setDraft("c1") { it.copy(text = "channel draft") }

        store.upsertMessage(parent.copy(body = "", deleted = true, updatedSeq = 5))
        assertTrue(store.isRootDeleted("p"))
        assertNull(store.threads["p"])
        assertEquals(ThreadSummary(0, 0), store.threadSummary)
        assertEquals("", store.draft("c1", "p").text)
        assertTrue(store.listDrafts().none { it.parentId == "p" })
        assertEquals("channel draft", store.draft("c1").text) // the channel's own draft stays
        // A late thread state, list page or an older copy of the root brings nothing back.
        store.applyThreadState(state, parent)
        store.setThreadPage("all", listOf(ThreadItem(parent, state, null)), null, append = false, pageSize = 50)
        assertNull(store.threads["p"])
        store.upsertMessage(parent)
        assertNull(store.message("c1", "p"))
        // A deleted reply is no root.
        store.upsertMessage(MessageOut(id = "r", channelId = "c1", senderId = "u2", seq = 6, updatedSeq = 7, parentId = "q", body = "", createdAt = "t", deleted = true))
        assertFalse(store.isRootDeleted("r"))
    }

    @Test fun closingPopsToWhereTheThreadWasOpenedFrom() {
        val root = listOf<Route>(Route.ChannelList)
        // From its conversation: back to it.
        assertEquals(root + Route.Channel("c1"), MainNav.threadGone(root + Route.Channel("c1") + Route.Thread("c1", "p1"), "p1"))
        // From the 「スレッド」 list: back to the list.
        val fromList = MainNav.openFromThreadList(MainNav.open(root, Route.Threads), "c1", "p1")
        assertEquals(root + Route.Threads, MainNav.threadGone(fromList, "p1"))
        // From the search's results: back to them.
        val params = SearchParams(q = "x")
        val searched = MainNav.runSearch(MainNav.openSearch(root), params)
        assertEquals(MainNav.returnToSearch(MainNav.openFromSearch(searched, "c1", "p1")), MainNav.threadGone(MainNav.openFromSearch(searched, "c1", "p1"), "p1"))
        // Nothing under it to return to: its conversation instead.
        assertEquals(root + Route.Channel("c1"), MainNav.threadGone(root + Route.Thread("c1", "p1", ThreadFrom.CHANNEL), "p1"))
        // Another thread, or none: unchanged.
        val other = root + Route.Channel("c1") + Route.Thread("c1", "p2")
        assertEquals(other, MainNav.threadGone(other, "p1"))
        // A search over it: the thread leaves from under it.
        val covered = root + Route.Channel("c1") + Route.Thread("c1", "p1") + Route.Search()
        assertEquals(root + Route.Channel("c1") + Route.Search(), MainNav.threadGone(covered, "p1"))
    }
}
