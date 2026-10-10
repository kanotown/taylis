package jp.chikuwachat.android

import jp.chikuwachat.android.api.ActivityItem
import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.ThreadReadAllRow
import jp.chikuwachat.android.api.ThreadSummary
import jp.chikuwachat.android.api.ThreadsReadAllOut
import jp.chikuwachat.android.sync.ActivityRules
import jp.chikuwachat.android.sync.EngineOptions
import jp.chikuwachat.android.sync.Store
import jp.chikuwachat.android.sync.SyncEngine
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** 「すべて既読にする」 on the 「スレッド」 list (THREADS.md §3.2, §4): POST /threads/read-all and threads.read_all. */
class ThreadsReadAllTest {
    private class World(
        val server: FakeServer, val api: FakeServer.Api, val bob: String, val alice: String, val channelId: String,
        val store: Store, val engine: SyncEngine, val scope: CoroutineScope, val first: String, val second: String,
    )

    private suspend fun settle(engine: SyncEngine) { repeat(20) { engine.idle(); yield() } }

    /** Bob (me) follows two topics of his; Alice replies twice to the first (once naming him) and once to the second. */
    private suspend fun world(): World {
        val server = FakeServer()
        val alice = server.addUser("alice")
        val bob = server.addUser("bob")
        val channel = server.createChannel("general", alice.id)
        server.join(channel.id, bob.id)
        val store = Store()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val time = ManualTime()
        val api = server.api(bob.id)
        val engine = SyncEngine(api, server.connector(bob.id), "ws://fake", store, { "token" }, scope,
            EngineOptions(pageSize = 50, reconnectMinMs = 0, sleep = {}, random = { 0.5 }, clock = time.clock, timer = time.timer))
        engine.isActive = { true }
        engine.start(); engine.openChannel(channel.id)
        engine.send(channel.id, "first topic"); engine.send(channel.id, "second topic"); settle(engine)
        val first = server.messageByBody(channel.id, "first topic")
        val second = server.messageByBody(channel.id, "second topic")
        server.post(channel.id, alice.id, "one", parentId = first.id)
        server.post(channel.id, alice.id, "two <@${bob.id}>", parentId = first.id)
        server.post(channel.id, alice.id, "three", parentId = second.id)
        engine.flushThreads(); settle(engine)
        engine.loadThreads("all")
        return World(server, api, bob.id, alice.id, channel.id, store, engine, scope, first.id, second.id)
    }

    private fun World.state(id: String) = store.threads.getValue(id).state
    private fun World.seq(body: String) = server.messageByBody(channelId, body).seq

    @Test fun theRowsReadAtOnceThenTakeTheAnswer() = runBlocking {
        val w = world()
        assertEquals(2, w.state(w.first).unreadCount)
        assertEquals(ThreadSummary(2, 1), w.store.threadSummary)

        val gate = CompletableDeferred<Unit>()
        w.api.threadsReadAllGate = gate
        val call = w.scope.launch { w.engine.markAllThreadsRead() }
        settle(w.engine)
        // Optimistic: no unread, positions at the newest reply held (the list's previews), the badge 0 / 0.
        assertEquals(0, w.state(w.first).unreadCount)
        assertEquals(0, w.state(w.first).mentionCount)
        assertEquals(w.seq("two <@${w.bob}>"), w.state(w.first).lastReadSeq)
        assertEquals(w.seq("three"), w.state(w.second).lastReadSeq)
        assertEquals(ThreadSummary(), w.store.threadSummary)
        assertEquals(ThreadSummary(2, 1), w.server.threadSummary(w.bob)) // the server has not moved yet

        gate.complete(Unit); call.join(); settle(w.engine)
        assertEquals(ThreadSummary(), w.server.threadSummary(w.bob))
        assertEquals(w.seq("two <@${w.bob}>"), w.store.threadReadSeqs[w.first]) // the activity list's dots follow
        assertEquals(w.seq("three"), w.store.threadReadSeqs[w.second])
        assertEquals(ThreadSummary(), w.store.threadSummary)
        w.engine.stop(); w.scope.cancel()
    }

    @Test fun aFailurePutsTheRowsBackAndIsRethrown() = runBlocking {
        val w = world()
        val before = w.state(w.first)
        w.api.pendingFailure = ApiException.Api(500, "internal", "boom")
        try {
            w.engine.markAllThreadsRead()
            fail("expected the failure")
        } catch (e: ApiException.Api) {
            assertEquals(500, e.status)
        }
        settle(w.engine)
        assertEquals(before, w.state(w.first))
        assertEquals(1, w.state(w.second).unreadCount)
        assertEquals(ThreadSummary(2, 1), w.store.threadSummary)
        w.engine.stop(); w.scope.cancel()
    }

    /**
     * Review v0.1.49 #4: the failed read-all put the list and the badge back but left the activity list's thread
     * positions forward, so its replies showed read (and left 「未読のみ」), even after the list was fetched again.
     */
    @Test fun aFailureAlsoPutsTheActivityReadPositionsBack() = runBlocking {
        val w = world()
        val reply = w.server.messageByBody(w.channelId, "two <@${w.bob}>")
        val item = ActivityItem(kind = "thread_reply", at = reply.createdAt, message = reply, actorIds = listOf(w.alice))
        fun readHere() = ActivityRules.readInConversation(item, { w.store.channel(it)?.lastReadSeq }, { w.store.threadReadSeqs[it] })
        assertFalse(readHere())
        val positionBefore = w.store.threadReadSeqs[w.first]
        w.api.pendingFailure = ApiException.Api(500, "internal", "boom")
        try {
            w.engine.markAllThreadsRead()
            fail("expected the failure")
        } catch (e: ApiException.Api) {
            assertEquals(500, e.status)
        }
        settle(w.engine)
        assertEquals(positionBefore, w.store.threadReadSeqs[w.first])
        assertFalse("the reply is unread in the activity again", readHere())
        // The list is fetched again (the failure schedules it): the positions are the server's, still unread.
        w.engine.flushThreads(); settle(w.engine)
        assertEquals(w.server.threadState(w.bob, w.first).lastReadSeq, w.store.threadReadSeqs[w.first])
        assertFalse(readHere())
        assertEquals(1, w.state(w.second).unreadCount)
        w.engine.stop(); w.scope.cancel()
    }

    /** A newer read that came while the call was on its way (another device read the thread) is not undone. */
    @Test fun aFailureKeepsANewerReadPosition() = runBlocking {
        val w = world()
        val undo = w.store.readAllThreadsLocally()
        val newer = w.seq("two <@${w.bob}>") + 5
        w.store.noteThreadRead(w.first, newer)
        w.store.restoreThreadsReadAll(undo)
        assertEquals(newer, w.store.threadReadSeqs[w.first])
        assertEquals(undo.readSeqsBefore[w.second], w.store.threadReadSeqs[w.second])
        w.engine.stop(); w.scope.cancel()
    }

    @Test fun restoringKeepsRowsChangedMeanwhile() = runBlocking {
        val w = world()
        val undo = w.store.readAllThreadsLocally()
        // A reply came to the second thread while the call was on its way: its new state stays.
        val newer = w.state(w.second).copy(unreadCount = 1, lastReadSeq = 0)
        w.store.applyThreadState(newer)
        w.store.restoreThreadsReadAll(undo)
        assertEquals(2, w.state(w.first).unreadCount)
        assertEquals(1, w.state(w.first).mentionCount)
        assertEquals(newer, w.state(w.second))
        w.engine.stop(); w.scope.cancel()
    }

    @Test fun theEventFromAnotherDeviceMovesForwardOnlyAndSetsTheBadge() = runBlocking {
        val w = world()
        // Read to the end of the first thread here (thread.updated, reason "read").
        w.server.markThreadRead(w.bob, w.first, w.seq("two <@${w.bob}>")); settle(w.engine)
        assertEquals(w.seq("two <@${w.bob}>"), w.state(w.first).lastReadSeq)

        // An event naming an older position (a stale one) never moves the row back (nor the dots).
        w.server.emitThreadsReadAll(w.bob, ThreadsReadAllOut(w.server.threadSummary(w.bob), listOf(ThreadReadAllRow(w.first, w.channelId, w.seq("one"), 0, 0))))
        settle(w.engine)
        assertEquals(w.seq("two <@${w.bob}>"), w.state(w.first).lastReadSeq)
        assertEquals(w.seq("two <@${w.bob}>"), w.store.threadReadSeqs[w.first])

        // Another device's real read-all: the second thread reads, and the list / badge are the server's again.
        w.server.readAllThreads(w.bob); settle(w.engine)
        w.engine.flushThreads(); settle(w.engine)
        assertEquals(0, w.state(w.second).unreadCount)
        assertEquals(w.seq("three"), w.state(w.second).lastReadSeq)
        assertEquals(w.seq("three"), w.store.threadReadSeqs[w.second])
        assertEquals(ThreadSummary(), w.store.threadSummary)
        w.engine.flushActivity()

        // A thread not held: its dots still follow.
        w.server.emitThreadsReadAll(w.bob, ThreadsReadAllOut(ThreadSummary(), listOf(ThreadReadAllRow("elsewhere", w.channelId, 7, 0, 0))))
        settle(w.engine)
        assertEquals(7, w.store.threadReadSeqs["elsewhere"])
        assertTrue("elsewhere" !in w.store.threads)
        w.engine.stop(); w.scope.cancel()
    }

    @Test fun theAnswerSetsTheBadgeAndCountsButNeverLowersAPosition() = runBlocking {
        val w = world()
        val held = w.state(w.second).lastReadSeq
        // A read still on its way (the floor) is ahead of the answer's position.
        w.store.applyThreadsReadAll(
            listOf(ThreadReadAllRow(w.first, w.channelId, 1, 0, 0), ThreadReadAllRow(w.second, w.channelId, 0, 1, 0)),
            ThreadSummary(3, 1),
        ) { if (it == w.first) 99 else null }
        assertEquals(ThreadSummary(3, 1), w.store.threadSummary)
        assertEquals(99, w.state(w.first).lastReadSeq)
        assertEquals(0, w.state(w.first).unreadCount)
        assertEquals(held, w.state(w.second).lastReadSeq)
        assertEquals(1, w.state(w.second).unreadCount)
        w.engine.stop(); w.scope.cancel()
    }

    @Test fun nothingToReadSendsNoEvent() = runBlocking {
        val w = world()
        w.engine.markAllThreadsRead(); settle(w.engine)
        val again = w.server.readAllThreads(w.bob)
        assertEquals(emptyList<ThreadReadAllRow>(), again.threads)
        assertEquals(ThreadSummary(), again.summary)
        w.engine.stop(); w.scope.cancel()
    }
}
