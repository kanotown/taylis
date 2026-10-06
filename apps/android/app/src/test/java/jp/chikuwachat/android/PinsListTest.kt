package jp.chikuwachat.android

import jp.chikuwachat.android.api.MessageOut
import jp.chikuwachat.android.sync.EngineOptions
import jp.chikuwachat.android.sync.Store
import jp.chikuwachat.android.sync.SyncEngine
import jp.chikuwachat.android.sync.TimelineEvent
import jp.chikuwachat.android.ui.PinsList
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 2026-10-06: a pinned message deleted or unpinned leaves the pins pane at once (it stayed until the pane was read again). */
class PinsListTest {
    private fun row(id: String, updatedSeq: Int, pinnedAt: String? = "2026-10-06T10:00:00Z", deleted: Boolean = false) =
        MessageOut(id = id, channelId = "c", senderId = "u", seq = 1, updatedSeq = updatedSeq, body = "b$updatedSeq", createdAt = "2026-10-06T09:00:00Z", deleted = deleted, pinnedAt = pinnedAt, pinnedBy = pinnedAt?.let { "u" })

    @Test fun deletedAndUnpinnedRowsLeaveAndEditsReplace() {
        val list = listOf(row("a", 2), row("b", 3))
        // Deleted: the server clears pinned_at with it (MessageOut on delete); either one alone takes the row out.
        assertEquals(listOf("b"), PinsList.applied(list, row("a", 4, pinnedAt = null, deleted = true))?.map { it.id })
        assertEquals(listOf("b"), PinsList.applied(list, row("a", 4, deleted = true))?.map { it.id })
        assertEquals(listOf("a"), PinsList.applied(list, row("b", 5, pinnedAt = null))?.map { it.id })
        // An edit keeps its place; an older version than the one shown changes nothing.
        assertEquals(listOf("a" to "b6", "b" to "b3"), PinsList.applied(list, row("a", 6))?.map { it.id to it.body })
        assertEquals(list, PinsList.applied(list, row("a", 1, pinnedAt = null)))
        // A row the list does not hold: unpinned or deleted, nothing; pinned now, the list is read again (null).
        assertEquals(list, PinsList.applied(list, row("z", 9, pinnedAt = null, deleted = true)))
        assertNull(PinsList.applied(list, row("z", 9)))
    }

    private suspend fun settle(engine: SyncEngine) { repeat(20) { engine.idle(); yield() } }

    @Test fun everyConversationsRowsReachThePinsPaneHeldOrNot() = runBlocking {
        val server = FakeServer()
        val alice = server.addUser("alice").id
        val bob = server.addUser("bob").id
        val channelId = server.createChannel("general", alice).id // a plain channel (the Times feed's flow skips it)
        server.join(channelId, bob)
        val (kept, _) = server.post(channelId, alice, "keep")
        val (gone, _) = server.post(channelId, alice, "gone")
        val keptPinned = server.pin(channelId, alice, kept.id, true)
        val gonePinned = server.pin(channelId, alice, gone.id, true)
        val store = Store()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val time = ManualTime()
        val engine = SyncEngine(server.api(bob), server.connector(bob), "ws://fake", store, { "token" }, scope,
            EngineOptions(reconnectMinMs = 0, sleep = {}, random = { 0.5 }, clock = time.clock, timer = time.timer))
        engine.isActive = { false }
        val rows = ArrayList<TimelineEvent>()
        val feed = ArrayList<TimelineEvent>()
        val collectors = listOf(scope.launch { engine.rowEvents.collect { rows.add(it) } }, scope.launch { engine.timelineEvents.collect { feed.add(it) } })
        // The conversation is not open: the store holds none of its rows (as for a pin older than the loaded range).
        engine.start(); settle(engine)
        var pins: List<MessageOut> = listOf(gonePinned, keptPinned) // GET /channels/{id}/pins: most recently pinned first
        fun apply() { rows.mapNotNull { it.message }.forEach { m -> pins = PinsList.applied(pins, m) ?: pins }; rows.clear() }

        // Someone else deletes a pinned message: message.deleted with pinned_at null.
        server.delete(channelId, alice, gone.id); settle(engine)
        apply()
        assertEquals(listOf(kept.id), pins.map { it.id })
        // Someone unpins: message.updated.
        server.pin(channelId, alice, kept.id, false); settle(engine)
        apply()
        assertTrue(pins.isEmpty())
        // My own delete's answer, taken by the store, comes the same way.
        val (mine, _) = server.post(channelId, bob, "mine")
        val pinned = server.pin(channelId, bob, mine.id, true); settle(engine)
        pins = listOf(pinned); rows.clear()
        store.upsertMessage(pinned.copy(updatedSeq = pinned.updatedSeq + 1, deleted = true, pinnedAt = null, pinnedBy = null))
        apply()
        assertTrue(pins.isEmpty())
        assertTrue(feed.isEmpty()) // the Times feed still gets only the times
        collectors.forEach { it.cancel() }; engine.stop(); scope.cancel()
    }
}
