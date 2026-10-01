package jp.chikuwachat.android

import jp.chikuwachat.android.api.MessageOut
import jp.chikuwachat.android.api.ParentThread
import jp.chikuwachat.android.api.PollOut
import jp.chikuwachat.android.sync.EngineOptions
import jp.chikuwachat.android.sync.MessageState
import jp.chikuwachat.android.sync.Store
import jp.chikuwachat.android.sync.SyncEngine
import jp.chikuwachat.android.sync.TIMELINE_BUFFER
import jp.chikuwachat.android.sync.TimelineEvent
import jp.chikuwachat.android.ui.ThreadRows
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * L8 review v0.1.15 #4 / #8: the rows the store takes otherwise than from a live event (a catch-up after a gap, the
 * answers to my own actions) reach the Times feed through one path, a full buffer asks the feed to read again, and a
 * thread opened from a feed-only post finds its parent.
 */
class TimesFeedSyncTest {
    private class World(val server: FakeServer, val alice: String, val bob: String, val channelId: String, val store: Store, val engine: SyncEngine, val scope: CoroutineScope)

    /** Bob reads alice's times (a channel with times_owner_id), as SyncEngineTest's world does for a plain channel. */
    private fun world(): World {
        val server = FakeServer()
        val alice = server.addUser("alice")
        val bob = server.addUser("bob")
        val channel = server.createChannel("times-alice", alice.id)
        server.channels.getValue(channel.id).channel = channel.copy(timesOwnerId = alice.id)
        server.join(channel.id, bob.id)
        val store = Store()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val time = ManualTime()
        val engine = SyncEngine(server.api(bob.id), server.connector(bob.id), "ws://fake", store, { "token" }, scope,
            EngineOptions(reconnectMinMs = 0, sleep = {}, random = { 0.5 }, clock = time.clock, timer = time.timer))
        engine.isActive = { false }
        return World(server, alice.id, bob.id, channel.id, store, engine, scope)
    }

    private suspend fun settle(engine: SyncEngine) { repeat(20) { engine.idle(); yield() } }

    @Test fun aRowRecoveredByTheConversationsCatchUpReachesTheFeed() = runBlocking {
        val w = world()
        val seen = ArrayList<TimelineEvent>()
        val collector = w.scope.launch { w.engine.timelineEvents.collect { seen.add(it) } }
        w.engine.start(); w.engine.openChannel(w.channelId); settle(w.engine)
        w.server.post(w.channelId, w.alice, "first"); settle(w.engine)
        // The WS event of "lost" never arrives; the next one shows the gap and the catch-up brings "lost" back.
        w.server.socketsOf(w.bob).first().dropNext = 1
        w.server.post(w.channelId, w.alice, "lost"); settle(w.engine)
        assertTrue(seen.none { it.message?.body == "lost" })
        w.server.post(w.channelId, w.alice, "gap"); settle(w.engine)
        assertEquals(listOf("first", "lost", "gap"), w.store.messages(w.channelId).map { it.body })
        assertTrue(seen.any { it.event == TimelineEvent.SYNCED && it.message?.body == "lost" })
        collector.cancel(); w.engine.stop(); w.scope.cancel()
    }

    @Test fun theAnswersToMyOwnActionsReachTheFeedWithoutTheirEvents() {
        val store = Store()
        val seen = ArrayList<Pair<String, TimelineEvent>>()
        store.onTimelineRow = { channel, event -> seen.add(channel to event) }
        val row = MessageOut(id = "m", channelId = "t", senderId = "me", seq = 3, updatedSeq = 5, body = "edited", createdAt = "2026-10-02T10:00:00Z", deleted = false)
        store.upsertMessage(row) // PATCH / reaction / pin answer
        val voted = row.copy(updatedSeq = 6, poll = PollOut(question = "q", options = listOf("a"), mine = listOf(0)))
        store.applyMyPollResponse(voted)
        store.applyParentThread("t", ParentThread(id = "m", replyCount = 1, updatedSeq = 7))
        // A pending send is no row yet.
        store.upsertMessage(MessageState.placeholder("k", "t", "me", "pending", "2026-10-02T10:01:00Z"))
        assertEquals(
            listOf(TimelineEvent.SYNCED to "m", TimelineEvent.SYNCED to "m", TimelineEvent.MY_POLL to "m", TimelineEvent.PARENT_THREAD to "m"),
            seen.map { (_, e) -> e.event to (e.message?.id ?: e.thread?.id) },
        )
        assertTrue(seen.all { it.first == "t" })
        assertEquals(listOf(0), seen[2].second.message?.poll?.mine)
    }

    @Test fun aFullBufferMarksTheFeedStale() = runBlocking {
        val w = world()
        w.engine.start(); settle(w.engine)
        // A collector that never takes the next event (the screen busy): the buffer fills.
        val collector = w.scope.launch { w.engine.timelineEvents.collect { awaitCancellation() } }
        assertEquals(0, w.engine.timelineStale.value)
        repeat(TIMELINE_BUFFER + 5) { i ->
            w.store.upsertMessage(MessageOut(id = "m$i", channelId = w.channelId, senderId = w.alice, seq = i + 1, updatedSeq = i + 1, body = "b$i", createdAt = "2026-10-02T10:00:00Z", deleted = false))
        }
        assertTrue(w.engine.timelineStale.value > 0)
        collector.cancel(); w.engine.stop(); w.scope.cancel()
    }

    @Test fun aThreadOpenedFromAFeedOnlyPostHasItsParent() {
        val store = Store()
        val parent = MessageOut(id = "p", channelId = "t", senderId = "u", seq = 1, updatedSeq = 1, body = "old post", createdAt = "2026-01-01T00:00:00Z", deleted = false, replyCount = 2)
        // Nowhere in the store, the threads list or a reveal: before, the pane had no parent (no thread state, no read).
        assertNull(ThreadRows.parent(store, "t", "p", null, emptyList(), null))
        assertEquals("old post", ThreadRows.parent(store, "t", "p", null, listOf(parent), null)?.body)
        // A reply also in the channel opened from the feed: its parent fetched by id.
        assertEquals("old post", ThreadRows.parent(store, "t", "p", null, emptyList(), MessageState.from(parent))?.body)
        // Another channel's row of that id is not it.
        assertNull(ThreadRows.parent(store, "x", "p", null, listOf(parent), MessageState.from(parent)))
        // The store's row comes first.
        store.upsertMessage(parent.copy(body = "held", updatedSeq = 2))
        assertEquals("held", ThreadRows.parent(store, "t", "p", null, listOf(parent), null)?.body)
    }
}
