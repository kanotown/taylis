package jp.chikuwachat.android

import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.sync.EngineOptions
import jp.chikuwachat.android.sync.MessageState
import jp.chikuwachat.android.sync.Store
import jp.chikuwachat.android.sync.SyncApi
import jp.chikuwachat.android.sync.SyncEngine
import jp.chikuwachat.android.ui.OpenPosition
import jp.chikuwachat.android.ui.Timeline
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * User report 2026-10-10: in a long channel, jumped to a pinned message (the conversation shows the server's window
 * around it, far from the newest rows), then sent a message: it did not appear; 「最新へ」 showed it had been sent. A
 * top-level post sent from here now leaves the focus for the live conversation, which ends with the newest rows and the
 * post (SYNC_PROTOCOL.md §10.1 4.), as AppController wires SyncEngine.onPostedHere to MessageFocus.afterPost.
 */
class FocusSendTest {
    private class World {
        val server = FakeServer()
        val alice = server.addUser("alice").id
        val bob = server.addUser("bob").id
        val channelId = server.createChannel("general", alice).id.also { server.join(it, bob) }
        val otherId = server.createChannel("random", alice).id.also { server.join(it, bob) }
        val store = Store()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        private val syncApi: SyncApi = server.api(bob)
        val engine = SyncEngine(syncApi, server.connector(bob), "ws://fake", store, { "t" }, scope,
            EngineOptions(pageSize = 50, sleep = {}, random = { 0.5 }))
        /** The conversation's focus, kept like AppController keeps it. */
        var focus: AppController.MessageFocus? = null

        init {
            engine.isActive = { true }
            engine.onPostedHere = { channelId -> focus = focus?.afterPost(channelId) }
        }

        fun serverRows() = server.channels.getValue(channelId).messages.filter { it.parentId == null }
        /** Opened at the row of `seq`: the server's window, 25 before it and 25 after, as GET /messages/{id}/context. */
        fun focusAt(seq: Int) {
            val rows = serverRows()
            val at = rows.indexOfFirst { it.seq == seq }
            focus = AppController.MessageFocus(channelId, rows[at].id, null, rows.subList(maxOf(0, at - 25), minOf(rows.size, at + 26)).map { MessageState.from(it) })
        }
        suspend fun settle() = repeat(20) { engine.idle(); yield() }
        fun close() { engine.stop(); scope.cancel() }
    }

    private suspend fun longChannel(): World {
        val w = World()
        repeat(200) { w.server.post(w.channelId, w.alice, "m${it + 1}") }
        w.engine.start(); w.engine.openChannel(w.channelId); w.settle()
        w.focusAt(30) // a pin far from the newest rows: its window is 5..55, the store holds 151..200
        return w
    }

    @Test fun aPostSentFromAMessagesSurroundingsShowsWithTheNewestRows() = runBlocking {
        val w = longChannel()
        assertFalse(w.focus!!.context.any { it.seq == 200 })
        w.engine.send(w.channelId, "from the pin"); w.settle()
        assertNull(w.focus) // the view is the live conversation again: no window, no highlight
        val rows = w.store.messages(w.channelId)
        assertEquals("from the pin", rows.last().body)
        assertEquals(201, rows.last().seq)
        assertEquals((151..201).toList(), rows.map { it.seq })
        // ChannelPane's landing then: no divider (AppController.focusLeftByPost), so the newest row.
        val items = Timeline.build(rows, null, w.bob).asReversed()
        assertEquals(OpenPosition.Bottom, Timeline.openPosition(items, rows, null, null, w.bob))
        w.close()
    }

    @Test fun aPollOfMineLeavesTheFocusToo() = runBlocking {
        val w = longChannel()
        val (poll, _) = w.server.post(w.channelId, w.bob, "poll")
        w.engine.postedFromHere(poll)
        assertNull(w.focus)
        assertEquals(poll.id, w.store.messages(w.channelId).last().id)
        w.close()
    }

    @Test fun repliesOtherConversationsAndRowsFromOthersLeaveTheWindowAsItIs() = runBlocking {
        val w = longChannel()
        val focus = w.focus
        w.engine.send(w.channelId, "a reply", parentId = w.serverRows()[29].id); w.settle()
        w.engine.send(w.otherId, "elsewhere"); w.settle()
        w.server.post(w.channelId, w.alice, "from alice"); w.settle()
        assertEquals(focus, w.focus)
        assertNotNull(w.store.messages(w.channelId).lastOrNull { it.body == "from alice" }) // counted by 「新着」 in the live rows
        assertTrue(w.focus!!.context.none { it.body == "from alice" })
        w.close()
    }
}
