package jp.chikuwachat.android

import jp.chikuwachat.android.api.MessageOut
import jp.chikuwachat.android.sync.EngineOptions
import jp.chikuwachat.android.sync.ReadGate
import jp.chikuwachat.android.sync.Store
import jp.chikuwachat.android.sync.SyncApi
import jp.chikuwachat.android.sync.SyncEngine
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * SYNC_PROTOCOL.md §10.6 (2026-10-09): a message deleted before it was read leaves the conversation's unread and mention
 * counts, by the rules shared with the other clients (apps/shared/unread-delete-rules.json), and in the engine.
 */
class UnreadDeleteTest {
    /** The file the other clients test against: from the module (apps/android/app), ../../shared. */
    private val rules: JsonObject by lazy {
        val file = File("../../shared/unread-delete-rules.json")
        check(file.isFile) { "apps/shared/unread-delete-rules.json not found from ${File("").absolutePath}" }
        Json.parseToJsonElement(file.readText()).jsonObject
    }

    private fun JsonObject.str(key: String): String? = this[key]?.let { if (it is JsonNull) null else it.jsonPrimitive.content }
    private fun JsonObject.int(key: String): Int = this[key]!!.jsonPrimitive.int

    @Test fun theSharedCases() {
        val me = rules.str("me")
        val cases = rules["cases"]!!.jsonArray.map { it.jsonObject }
        assertTrue(cases.isNotEmpty())
        for (case in cases) {
            val name = case.str("name")!!
            val channel = case["channel"]!!.jsonObject
            val m = case["message"]!!.jsonObject
            val message = MessageOut(
                id = "m", channelId = "c", senderId = m.str("sender_id")!!, seq = m.int("seq"), updatedSeq = case.int("event_seq"),
                parentId = m.str("parent_id"), alsoInChannel = m["also_in_channel"]!!.jsonPrimitive.boolean, type = m.str("type")!!,
                body = "", createdAt = m.str("created_at")!!, deleted = true,
            )
            val held = (case["held"] as? JsonObject)?.let { ReadGate.HeldRow(it["deleted"]!!.jsonPrimitive.boolean, it["mentions_me"]!!.jsonPrimitive.boolean) }
            val next = ReadGate.countsAfterDelete(
                channel.int("last_read_seq"), channel.int("counted_to"), channel.int("unread"), channel.int("mentions"), channel.str("first_unread_at"),
                case.int("event_seq"), message, held, me,
            )
            val expect = case["expect"]!!.jsonObject
            assertEquals(name, ReadGate.DeleteCounts(expect.int("unread"), expect.int("mentions"), expect.str("first_unread_at"), expect["refetch"]!!.jsonPrimitive.boolean), next)
        }
    }

    private class World(type: String) {
        val server = FakeServer()
        val alice = server.addUser("alice").id
        val bob = server.addUser("bob").id
        val channelId = server.createChannel("general", alice, type).id.also { server.join(it, bob) }
        val store = Store()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        private val syncApi: SyncApi = server.api(bob)
        val api: FakeServer.Api get() = syncApi as FakeServer.Api
        val engine = SyncEngine(syncApi, server.connector(bob), "ws://fake", store, { "t" }, scope, EngineOptions(sleep = {}, random = { 0.5 }))
        val cleared = ArrayList<String>()

        init {
            engine.isActive = { false }
            engine.onRead = { cleared.add(it) }
        }

        fun counts() = store.channel(channelId)!!.let { Triple(it.unreadCount, it.mentionCount, it.firstUnreadAt) }
        suspend fun settle() { repeat(20) { engine.idle(); yield() }; engine.flushReads(); repeat(5) { engine.idle(); yield() } }
        fun close() { engine.stop(); scope.cancel() }
    }

    @Test fun anUnreadDmDeletedBeforeItWasOpenedLeavesNoBadge() = runBlocking {
        val w = World("dm")
        w.engine.start(); w.settle()
        val (message, _) = w.server.post(w.channelId, w.alice, "oops"); w.settle()
        assertEquals(1, w.counts().first)
        w.server.delete(w.channelId, w.alice, message.id); w.settle()
        assertEquals(Triple(0, 0, null), w.counts())
        assertEquals(listOf(w.channelId), w.cleared) // its notification goes, as with a read
        assertEquals(emptyList<Int>(), w.api.readCalls) // the rule knew it: no request
        w.close()
    }

    @Test fun aMentionNotHeldIsAskedOfTheServer() = runBlocking {
        val w = World("public")
        w.server.post(w.channelId, w.alice, "one")
        val (mention, _) = w.server.post(w.channelId, w.alice, "hi <@${w.bob}>")
        w.server.post(w.channelId, w.alice, "three")
        w.engine.start(); w.settle() // the channel is never opened: no row is held
        assertEquals(3 to 1, w.counts().let { it.first to it.second })
        w.server.delete(w.channelId, w.alice, mention.id); w.settle()
        assertEquals(listOf(0), w.api.readCalls) // PUT /read {last_read_seq: 0}: answers the counts, moves nothing
        assertEquals(2 to 0, w.counts().let { it.first to it.second })
        assertEquals(0, w.server.readState(w.bob, w.channelId).lastReadSeq)
        w.close()
    }

    @Test fun aHeldMentionDropsWithoutARequest() = runBlocking {
        val w = World("public")
        w.server.post(w.channelId, w.alice, "one")
        val (mention, _) = w.server.post(w.channelId, w.alice, "hi <@${w.bob}>")
        w.server.post(w.channelId, w.alice, "three")
        w.engine.start(); w.settle()
        w.engine.openChannel(w.channelId); w.settle()
        w.server.delete(w.channelId, w.alice, mention.id); w.settle()
        assertEquals(2 to 0, w.counts().let { it.first to it.second })
        assertEquals(emptyList<Int>(), w.api.readCalls)
        w.close()
    }

    @Test fun aStaleCountIsSettledWhenTheConversationOpens() = runBlocking {
        val w = World("dm")
        w.server.post(w.channelId, w.alice, "still here")
        w.engine.start(); w.settle()
        // A count no held row backs (a store from an older build kept the deleted message's count).
        w.store.updateChannel(w.channelId) { it.copy(unreadCount = 2) }
        w.engine.openChannel(w.channelId); w.settle()
        assertEquals(listOf(0), w.api.readCalls)
        assertEquals(1, w.counts().first)
        // Backed by the rows held: no request.
        w.engine.openChannel(w.channelId); w.settle()
        assertEquals(listOf(0), w.api.readCalls)
        w.close()
    }
}
