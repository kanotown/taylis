package jp.chikuwachat.android

import jp.chikuwachat.android.sync.CACHED_MESSAGES_PER_CHANNEL
import jp.chikuwachat.android.sync.EngineOptions
import jp.chikuwachat.android.sync.MessageState
import jp.chikuwachat.android.sync.OutboxItem
import jp.chikuwachat.android.sync.Store
import jp.chikuwachat.android.sync.SyncApi
import jp.chikuwachat.android.sync.SyncEngine
import jp.chikuwachat.android.sync.TRIM_MARGIN
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * SYNC_PROTOCOL.md §7.7 (M22): a channel holds its newest 500 messages. Trimmed at start-up, when the reader leaves
 * it and when live rows pile up where nobody looks; never while it is open or a thread of it is.
 */
class HeldMessagesTest {
    private class World {
        val server = FakeServer()
        val alice = server.addUser("alice").id
        val bob = server.addUser("bob").id
        val channelId = server.createChannel("general", alice).id.also { server.join(it, bob) }
        val otherId = server.createChannel("random", alice).id.also { server.join(it, bob) }
        val store = Store()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val time = ManualTime()
        // Held as the interface (see SyncEngineTest.World).
        private val syncApi: SyncApi = server.api(bob)
        val api: FakeServer.Api get() = syncApi as FakeServer.Api
        // Pages of 3, like the desktop's tests.
        val engine = SyncEngine(syncApi, server.connector(bob), "ws://fake", store, { "t" }, scope,
            EngineOptions(pageSize = 3, sleep = {}, random = { 0.5 }, clock = time.clock, timer = time.timer))

        fun post(from: Int, to: Int) = (from..to).forEach { server.post(channelId, alice, "m$it") }
        fun bodies(): List<String> = store.messages(channelId).map { it.body }
        suspend fun settle() = repeat(20) { engine.idle(); yield() }
        fun close() { engine.stop(); scope.cancel() }

        /** The timeline's seqs are one unbroken run from the range start to the newest message. */
        fun unbroken(): Boolean {
            val seqs = store.messages(channelId).map { it.seq!! }
            return seqs.zipWithNext().all { (a, b) -> b == a + 1 } && seqs.first() == store.channel(channelId)?.oldestLoadedSeq
        }
    }

    @Test fun loadingKeepsTheNewest500MessagesPerChannelAndMovesTheRangeStartPastThePrunedOnes() {
        val server = FakeServer()
        val alice = server.addUser("alice")
        val channel = server.createChannel("general", alice.id)
        (1..520).forEach { server.post(channel.id, alice.id, "m$it") }
        val persistence = MemoryPersistence()
        val writer = Store(persistence)
        writer.upsertChannel(channel, isMember = true)
        writer.updateChannel(channel.id) { it.copy(syncedSeq = 520, oldestLoadedSeq = 0, hasOlder = false) }
        server.channels.getValue(channel.id).messages.forEach { writer.upsertMessage(it) }
        writer.putPlaceholder(MessageState.placeholder("c1", channel.id, alice.id, "unsent", "9999"))
        writer.addOutbox(OutboxItem("c1", channel.id, "unsent", "9999"))

        val reader = Store(persistence)
        reader.load()
        val timeline = reader.messages(channel.id)
        assertEquals(501, timeline.size)
        assertEquals(listOf("m21", "m520", "unsent"), listOf(timeline[0].body, timeline[499].body, timeline[500].body))
        assertEquals(21 to true, reader.channel(channel.id)!!.let { it.oldestLoadedSeq to it.hasOlder })
        assertEquals(520, reader.channel(channel.id)?.syncedSeq) // the delta still starts where it was
        // Pruned on disk too, and the range start with it.
        assertEquals(501, persistence.messages.size)
        assertEquals(21, persistence.channels.getValue(channel.id).oldestLoadedSeq)
        assertEquals(1, reader.outbox.size)
    }

    @Test fun messagesThatFailToLoadCostOnlyTheCachedRows() {
        val server = FakeServer()
        val alice = server.addUser("alice")
        val channel = server.createChannel("general", alice.id)
        (1..5).forEach { server.post(channel.id, alice.id, "m$it") }
        val persistence = MemoryPersistence()
        val writer = Store(persistence)
        writer.upsertChannel(channel, isMember = true)
        writer.updateChannel(channel.id) { it.copy(syncedSeq = 5, oldestLoadedSeq = 0, hasOlder = false) }
        server.channels.getValue(channel.id).messages.forEach { writer.upsertMessage(it) }
        writer.setDraft(channel.id) { it.copy(text = "half written") }
        writer.putPlaceholder(MessageState.placeholder("c1", channel.id, alice.id, "unsent", "9999"))
        writer.addOutbox(OutboxItem("c1", channel.id, "unsent", "9999"))

        persistence.failMessages = true
        val reader = Store(persistence)
        reader.load()
        assertEquals(listOf("c1"), reader.outbox.map { it.clientMsgId })
        assertEquals("half written", reader.draft(channel.id).text)
        // The timeline loads again from the latest page (a synced cursor over missing rows would leave a hole).
        val state = reader.channel(channel.id)!!
        assertEquals(Triple(null, null, true), Triple(state.syncedSeq, state.oldestLoadedSeq, state.hasOlder))
        assertEquals(listOf("unsent" to true), reader.messages(channel.id).map { it.body to it.pending })
        // The table is emptied so the next start does not fail again; the pending row stays with its outbox item.
        assertEquals(listOf("local:c1"), persistence.messages.keys.toList())
    }

    @Test fun trimsAConversationWhenTheReaderLeavesItNeverWhileOpenAndPagesItBackIn() = runBlocking {
        val w = World()
        w.engine.start(); w.engine.openChannel(w.channelId)
        w.post(1, 620); w.settle()
        assertEquals(620, w.bodies().size) // open: every live row stays

        w.engine.openChannel(w.otherId); w.settle()
        val kept = w.bodies()
        assertEquals(CACHED_MESSAGES_PER_CHANNEL, kept.size)
        assertEquals(listOf("m121", "m620"), listOf(kept.first(), kept.last()))
        val trimmed = w.store.channel(w.channelId)!!
        assertEquals(Triple(121, true, 620), Triple(trimmed.oldestLoadedSeq, trimmed.hasOlder, trimmed.syncedSeq))

        w.engine.openChannel(w.channelId)
        w.engine.loadOlder(w.channelId) // back from the new range start, with no gap
        assertEquals(listOf("m118", "m119", "m120", "m121"), w.bodies().take(4))
        assertEquals(listOf(121 to 3), w.api.historyCalls.takeLast(1))
        assertTrue(w.unbroken())
        w.close()
    }

    @Test fun aPageStillLoadingWhenTheReaderLeavesLandsBeforeTheTrim() = runBlocking {
        val w = World()
        w.post(1, 10)
        w.engine.start(); w.engine.openChannel(w.channelId) // the latest page: 8..10
        w.post(11, 610); w.settle()
        assertEquals(603, w.bodies().size)

        val gate = CompletableDeferred<Unit>()
        w.api.historyGate = gate
        val older = async { w.engine.loadOlder(w.channelId) }
        repeat(10) { yield() }
        assertEquals(8 to 3, w.api.historyCalls.last()) // on its way
        val leaving = async { w.engine.openChannel(w.otherId) }
        repeat(10) { yield() }
        assertEquals(603, w.bodies().size) // the trim waits behind the page
        gate.complete(Unit)
        older.await(); leaving.await(); w.settle()
        // The page (5..7) landed first; trimmed after it, the range starts at the newest 500 with nothing missing.
        assertEquals(CACHED_MESSAGES_PER_CHANNEL, w.bodies().size)
        assertEquals(111 to "m610", w.store.channel(w.channelId)?.oldestLoadedSeq to w.bodies().last())
        assertTrue(w.unbroken())
        w.close()
    }

    @Test fun aConversationOpenedAgainBeforeItsTrimRunsKeepsItsRows() = runBlocking {
        val w = World()
        w.post(1, 10)
        w.engine.start(); w.engine.openChannel(w.channelId) // the latest page: 8..10
        w.post(11, 520); w.settle()
        val gate = CompletableDeferred<Unit>()
        w.api.historyGate = gate
        val busy = async { w.engine.loadOlder(w.channelId) } // holds the queue: the trim below waits behind it
        repeat(10) { yield() }
        val leaving = async { w.engine.openChannel(w.otherId) }
        val back = async { w.engine.openChannel(w.channelId) }
        repeat(10) { yield() }
        gate.complete(Unit)
        busy.await(); leaving.await(); back.await(); w.settle()
        assertEquals(516, w.bodies().size) // open again when the trim's turn came: the page (5..7) and every live row
        assertEquals(5, w.store.channel(w.channelId)?.oldestLoadedSeq)
        assertTrue(w.unbroken())
        w.close()
    }

    @Test fun trimsAChannelNobodyLooksAtOnceLiveRowsPassTheCapByTheMargin() = runBlocking {
        val w = World()
        w.engine.start()
        w.engine.openChannel(w.channelId) // synced: its live rows are kept
        w.engine.openChannel(w.otherId); w.settle()
        w.post(1, CACHED_MESSAGES_PER_CHANNEL + TRIM_MARGIN); w.settle()
        assertEquals(600, w.bodies().size) // not on every row
        w.post(601, 650); w.settle()
        val held = w.bodies()
        assertTrue(held.size in CACHED_MESSAGES_PER_CHANNEL..CACHED_MESSAGES_PER_CHANNEL + TRIM_MARGIN)
        assertEquals("m650", held.last())
        assertTrue(w.unbroken())
        val state = w.store.channel(w.channelId)!!
        assertEquals(true to 650, state.hasOlder to state.syncedSeq)
        w.close()
    }

    @Test fun anOpenThreadKeepsItsChannelWholeUntilItCloses() = runBlocking {
        val w = World()
        w.engine.start(); w.engine.openChannel(w.channelId)
        val (parent, _) = w.server.post(w.channelId, w.alice, "topic")
        w.server.post(w.channelId, w.alice, "answer", parentId = parent.id)
        w.post(1, 520); w.settle()
        assertTrue(w.engine.loadReplies(w.channelId, parent.id))
        assertTrue(w.engine.threadComplete(parent.id))

        val pane = w.engine.viewing(w.channelId)
        val second = w.engine.viewing(w.channelId) // e.g. a pane recomposed before the old one went
        w.engine.openChannel(w.otherId); w.settle()
        assertEquals(521, w.bodies().size) // the thread's channel is not trimmed
        pane(); pane() // once only: the second view still holds it
        w.settle()
        assertEquals(521, w.bodies().size)
        assertTrue(w.engine.threadComplete(parent.id))

        second(); w.settle()
        assertEquals(CACHED_MESSAGES_PER_CHANNEL, w.bodies().size)
        assertTrue(w.unbroken())
        // The thread's older rows went (§10.2): opening it fetches the replies again.
        assertFalse(w.engine.threadComplete(parent.id))
        assertNull(w.store.message(w.channelId, parent.id))
        w.close()
    }
}
