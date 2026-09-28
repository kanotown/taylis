package jp.chikuwachat.android

import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.sync.EngineOptions
import jp.chikuwachat.android.sync.MessageState
import jp.chikuwachat.android.sync.Store
import jp.chikuwachat.android.sync.SyncEngine
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** Runs the shared contract fixtures (the JSON files under server/tests/contract, SYNC_PROTOCOL.md §13). */
class ContractTest {
    private class Scenario {
        val server = FakeServer()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        var channelId = ""
        var store = Store()
        var engine: SyncEngine? = null
        var clientUser = ""
        var options: JsonObject = JsonObject(emptyMap())
        var posted = 0
    }

    private fun fixtureDir(): File {
        var dir: File? = File("").absoluteFile
        while (dir != null) {
            val candidate = File(dir, "server/tests/contract")
            if (candidate.isDirectory) return candidate
            dir = dir.parentFile
        }
        error("server/tests/contract not found")
    }

    private fun JsonObject.str(key: String) = this[key]?.jsonPrimitive?.contentOrNull
    private fun JsonObject.int(key: String) = this[key]?.jsonPrimitive?.intOrNull
    private fun JsonObject.bool(key: String) = this[key]?.jsonPrimitive?.booleanOrNull

    private fun key(step: JsonObject): String = "00000000-0000-5000-8000-" + step.str("key")!!.padStart(12, '0')

    private fun newEngine(s: Scenario, store: Store): SyncEngine {
        val user = s.server.user(s.clientUser)
        return SyncEngine(s.server.api(user.id), s.server.connector(user.id), "ws://fake", store, { "t" }, s.scope,
            EngineOptions(pageSize = s.options.int("page_size") ?: 50, gapLimit = s.options.int("gap_limit") ?: 5000, sleep = {}))
    }

    private suspend fun settle(engine: SyncEngine?) { engine ?: return; repeat(20) { engine.idle(); yield() } }

    private suspend fun run(step: JsonObject, s: Scenario) {
        when (val op = step.str("op")) {
            "users" -> step["names"]!!.jsonArray.forEach { s.server.addUser(it.jsonPrimitive.content) }
            "channel" -> {
                val owner = s.server.user(step.str("owner")!!)
                s.channelId = s.server.createChannel(step.str("name")!!, owner.id).id
                step["members"]?.jsonArray?.forEach { s.server.join(s.channelId, s.server.user(it.jsonPrimitive.content).id) }
            }
            "post" -> {
                val sender = s.server.user(step.str("as")!!)
                repeat(step.int("count") ?: 1) {
                    s.posted += 1
                    var body = step.str("body")!!.replace("{i}", s.posted.toString())
                    s.server.users.values.forEach { body = body.replace("{${it.username}}", it.id) }
                    s.server.post(s.channelId, sender.id, body)
                }
            }
            "read" -> s.server.markRead(s.server.user(step.str("as")!!).id, s.channelId, step.int("seq")!!)
            // A visible-range read; `force` is an explicit one (Esc, 「既読にする」, §10.1).
            "client.read" -> { s.engine!!.markRead(s.channelId, step.int("seq")!!, force = step.bool("force") ?: false); s.engine!!.flushReads(); settle(s.engine) }
            "client.load_first_unread" -> { s.engine!!.loadFirstUnread(s.channelId); settle(s.engine) }
            "edit" -> {
                val user = s.server.user(step.str("as")!!)
                s.server.edit(s.channelId, user.id, s.server.messageByBody(s.channelId, step.str("body_of")!!).id, step.str("body")!!)
            }
            "delete" -> {
                val user = s.server.user(step.str("as")!!)
                s.server.delete(s.channelId, user.id, s.server.messageByBody(s.channelId, step.str("body_of")!!).id)
            }
            "react", "unreact" -> {
                val user = s.server.user(step.str("as")!!)
                s.server.react(s.channelId, user.id, s.server.messageByBody(s.channelId, step.str("body_of")!!).id, step.str("emoji")!!, present = op == "react")
            }
            "client.start" -> {
                s.clientUser = step.str("as")!!
                s.options = step
                s.store = Store()
                s.engine = newEngine(s, s.store).also { it.openChannel(s.channelId); it.start() }
                settle(s.engine)
            }
            "client.stop" -> s.engine?.stop()
            "client.restart" -> {
                val snapshot = s.store.snapshot()
                s.engine?.stop()
                s.store = Store.fromSnapshot(snapshot)
                s.engine = newEngine(s, s.store).also { it.openChannel(s.channelId); it.start() }
                settle(s.engine)
            }
            "client.receive" -> settle(s.engine)
            "client.drop_next" -> s.server.socketsOf(s.server.user(s.clientUser).id).forEach { it.dropNext += step.int("count") ?: 0 }
            "client.send" -> { s.engine!!.send(s.channelId, step.str("body")!!, key(step)); settle(s.engine) }
            "client.send_event_first" -> {
                val user = s.server.user(s.clientUser)
                val k = key(step)
                s.store.putPlaceholder(MessageState.placeholder(k, s.channelId, user.id, step.str("body")!!, "9999"))
                val (message, _) = s.server.post(s.channelId, user.id, step.str("body")!!, k)
                settle(s.engine)
                s.store.upsertMessage(message)
            }
            "expect" -> {
                val bodies = s.store.messages(s.channelId).map { it.body }
                val channel = s.store.channel(s.channelId)
                step["messages"]?.jsonArray?.let { assertEquals(it.map { e -> e.jsonPrimitive.content }, bodies) }
                step.int("message_count")?.let { assertEquals(it, bodies.size) }
                step.str("first_body")?.let { assertEquals(it, bodies.first()) }
                step.str("last_body")?.let { assertEquals(it, bodies.last()) }
                step.int("synced_seq")?.let { assertEquals(it, channel?.syncedSeq) }
                step.int("last_read_seq")?.let { assertEquals("last_read_seq", it, channel?.lastReadSeq) }
                step.int("unread_count")?.let { assertEquals("unread_count", it, channel?.unreadCount) }
                step.int("mention_count")?.let { assertEquals("mention_count", it, channel?.mentionCount) }
                step.int("catch_ups")?.let { assertEquals(it, s.engine?.catchUps) }
                step.int("reloads")?.let { assertEquals(it, s.engine?.reloads) }
                step.int("server_message_count")?.let { assertEquals(it, s.server.channels.getValue(s.channelId).messages.size) }
                (step["reactions"] as? JsonObject)?.forEach { (body, emojis) ->
                    val message = s.store.messages(s.channelId).first { it.body == body }
                    assertEquals(body, emojis.jsonArray.map { it.jsonPrimitive.content }, message.reactions.map { it.emoji })
                }
            }
            else -> error("unknown op $op")
        }
    }

    @Test fun contractFixtures() = runBlocking {
        val files = fixtureDir().listFiles { f -> f.extension == "json" }!!.sortedBy { it.name }
        assertTrue(files.size >= 7)
        for (file in files) {
            val spec = Codec.plain.parseToJsonElement(file.readText()).jsonObject
            val scenario = Scenario()
            try {
                for (step in spec["steps"]!!.jsonArray) run(step.jsonObject, scenario)
            } catch (e: AssertionError) {
                throw AssertionError("${file.name}: ${e.message}", e)
            } finally {
                scenario.engine?.stop()
                scenario.scope.cancel()
            }
        }
    }
}
