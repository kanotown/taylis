package jp.chikuwachat.android

import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.ChannelOut
import jp.chikuwachat.android.api.ReadStateOut
import jp.chikuwachat.android.sync.DmCloses
import jp.chikuwachat.android.sync.EngineOptions
import jp.chikuwachat.android.sync.Store
import jp.chikuwachat.android.sync.SyncEngine
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.boolean
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Review v0.1.43 #6 / #7 (SYNC_PROTOCOL.md §7.9): the rules shared with the other clients (apps/shared/dm-close-rules.json),
 * a close delivered after a newer message, and a refused close that must not undo what came meanwhile.
 */
class DmCloseRacesTest {
    /** The file the other clients test against: from the module (apps/android/app), ../../shared. */
    private val rules: JsonObject by lazy {
        val file = File("../../shared/dm-close-rules.json")
        check(file.isFile) { "apps/shared/dm-close-rules.json not found from ${File("").absolutePath}" }
        Json.parseToJsonElement(file.readText()).jsonObject
    }

    private fun JsonObject.intOrNull(key: String): Int? = this[key]!!.let { if (it is JsonNull) null else it.jsonPrimitive.int }
    private fun JsonObject.strings(key: String): List<String> = this[key]!!.jsonArray.map { it.jsonPrimitive.content }
    private fun JsonObject.mark(key: String): DmCloses.ReadMark = this[key]!!.jsonObject.let {
        DmCloses.ReadMark(it["last_seq"]!!.jsonPrimitive.int, it["last_read_seq"]!!.jsonPrimitive.int, it["unread_count"]!!.jsonPrimitive.int, it["mention_count"]!!.jsonPrimitive.int)
    }

    @Test fun theSharedCloseEventCases() {
        for (case in rules["close_event"]!!.jsonArray.map { it.jsonObject }) {
            val name = case["name"]!!.jsonPrimitive.content
            val takes = DmCloses.takesEvent(case["closed"]!!.jsonPrimitive.boolean, case.intOrNull("closed_seq"), case.intOrNull("last_message_seq"))
            assertEquals(name, case["apply"]!!.jsonPrimitive.boolean, takes)
        }
    }

    @Test fun theSharedRestorePinCases() {
        for (case in rules["restore_pin"]!!.jsonArray.map { it.jsonObject }) {
            val channel = case["channel"]!!.jsonPrimitive.content
            val place = case.strings("pins_before").indexOf(channel).takeIf { it >= 0 }
            assertEquals(case["name"]!!.jsonPrimitive.content, case.strings("expect"), DmCloses.restoredPins(case.strings("pins_now"), channel, place))
        }
    }

    @Test fun theSharedReadFallbackCases() {
        for (case in rules["read_fallback"]!!.jsonArray.map { it.jsonObject }) {
            val snapshot = DmCloses.readFallbackTakesSnapshot(case.mark("optimistic"), case.mark("now"))
            assertEquals(case["name"]!!.jsonPrimitive.content, case["expect"]!!.jsonPrimitive.content == "snapshot", snapshot)
        }
    }

    private suspend fun settle(engine: SyncEngine) { repeat(20) { engine.idle(); yield() } }

    @Test fun aCloseOlderThanAMessageHeldHereLeavesItOpen() = runBlocking {
        val server = FakeServer()
        val alice = server.addUser("alice")
        val bob = server.addUser("bob")
        val conversation = server.createChannel("", alice.id, type = "dm")
        server.join(conversation.id, bob.id)
        server.post(conversation.id, alice.id, "earlier")
        server.closedDms = hashMapOf()
        val store = Store()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val engine = SyncEngine(server.api(bob.id), server.connector(bob.id), "ws://fake", store, { "token" }, scope, EngineOptions(sleep = {}, reconnectMinMs = 0, random = { 0.5 }))
        engine.isActive = { false }
        engine.start(); settle(engine)
        val stale = store.channel(conversation.id)!!.lastSeq

        // The close read `stale`; alice's message committed meanwhile and its event came first.
        val (fresh, _) = server.post(conversation.id, alice.id, "while you were closing"); settle(engine)
        server.emitDmCloseEvent(bob.id, conversation.id, closed = true, closedSeq = stale); settle(engine)
        assertFalse(store.isDmClosed(conversation.id))
        assertEquals(2, store.channel(conversation.id)!!.unreadCount)

        // A close that includes the newest message is taken; one from an older server (no closed_seq) as before.
        server.emitDmCloseEvent(bob.id, conversation.id, closed = true, closedSeq = fresh.seq); settle(engine)
        assertTrue(store.isDmClosed(conversation.id))
        server.emitDmCloseEvent(bob.id, conversation.id, closed = false, closedSeq = null)
        server.emitDmCloseEvent(bob.id, conversation.id, closed = true, closedSeq = null); settle(engine)
        assertTrue(store.isDmClosed(conversation.id))
        engine.stop(); scope.cancel()
    }

    private fun heldStore(): Store {
        val store = Store()
        store.replaceClosedDms(emptyList())
        store.upsertChannel(ChannelOut(id = "a", type = "dm", archived = false, lastSeq = 3, createdAt = "t", updatedAt = "t", dmUserIds = listOf("me", "u1")), isMember = true)
        store.updateChannel("a") { it.copy(lastSeq = 3, lastReadSeq = 3, unreadCount = 0, mentionCount = 0, firstUnreadAt = null) }
        store.replaceDmPins(listOf("b", "a", "c"))
        return store
    }

    /** What the engine does meanwhile: another device pins d, a message comes to a (seq 4, unread). */
    private fun meanwhile(store: Store) {
        store.setDmPin("d", true)
        store.updateChannel("a") { it.copy(lastSeq = 4, unreadCount = it.unreadCount + 1, firstUnreadAt = "2026-10-07T00:00:00Z") }
    }

    private suspend fun refusedWhile(store: Store, readState: suspend () -> ReadStateOut) {
        val answer = CompletableDeferred<Unit>()
        val closing = CoroutineScope(Dispatchers.Unconfined).async(start = CoroutineStart.UNDISPATCHED) {
            runCatching { DmCloses.close(store, "a", readState) { answer.await() } }
        }
        assertEquals(listOf("b", "c"), store.dmPins)
        meanwhile(store)
        answer.completeExceptionally(ApiException.Api(503, "unavailable", "busy"))
        assertTrue(closing.await().isFailure)
    }

    @Test fun aRefusedCloseKeepsWhatCameMeanwhile() = runBlocking {
        val store = heldStore()
        var asked = 0
        refusedWhile(store) { asked++; ReadStateOut(lastReadSeq = 3, unreadCount = 1, mentionCount = 0, firstUnreadAt = "2026-10-07T00:00:00Z") }
        assertFalse(store.isDmClosed("a"))
        assertEquals(listOf("b", "a", "c", "d"), store.dmPins) // d's pin stays, a back in its own place
        assertEquals(1, asked) // the server's read state, asked again
        val row = store.channel("a")!!
        assertEquals(4, row.lastSeq)
        assertEquals(3, row.lastReadSeq)
        assertEquals(1, row.unreadCount)
        assertEquals("2026-10-07T00:00:00Z", row.firstUnreadAt)
    }

    @Test fun theReadStateUnreachableTooKeepsWhatCameMeanwhile() = runBlocking {
        val store = heldStore()
        refusedWhile(store) { throw ApiException.Network(java.io.IOException("offline")) }
        val row = store.channel("a")!!
        assertEquals(4, row.lastSeq)
        assertEquals(1, row.unreadCount)
        assertEquals(listOf("b", "a", "c", "d"), store.dmPins)
    }
}
