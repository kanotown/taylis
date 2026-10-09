package jp.chikuwachat.android

import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.UserMe
import jp.chikuwachat.android.api.UserPublic
import jp.chikuwachat.android.sync.EngineOptions
import jp.chikuwachat.android.sync.Store
import jp.chikuwachat.android.sync.SyncEngine
import jp.chikuwachat.android.ui.DndDuration
import jp.chikuwachat.android.ui.PresenceChoice
import jp.chikuwachat.android.ui.PresenceRules
import jp.chikuwachat.android.ui.YouSettings
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.time.Instant
import java.time.ZoneId

/**
 * docs/PRESENCE.md §11: the quick status menu's rules against the shared vectors (apps/shared/presence-rules.json, the
 * file iOS and Desktop / Web test against too), what the vectors leave out, the Store's look, and my choice from my
 * other devices.
 */
class PresenceTest {
    private val tokyo = ZoneId.of("Asia/Tokyo")
    private val now = Instant.parse("2026-10-09T03:00:00Z") // 12:00 in Tokyo
    private val forever = "9999-12-31T00:00:00Z"

    private fun me(dndUntil: String? = null, hidden: Boolean = false, manual: String? = null, updatedAt: String = "2026-10-09T02:00:00Z") =
        UserMe("u", "u", "U", "member", null, "2026-01-01T00:00:00Z", updatedAt, null, false, dndUntil = dndUntil, presenceHidden = hidden, presenceManual = manual)

    private fun user(id: String, dndUntil: String? = null, updatedAt: String = "2026-10-09T02:00:00Z") =
        UserPublic(id, id, id, "member", createdAt = "2026-01-01T00:00:00Z", updatedAt = updatedAt, dndUntil = dndUntil)

    // --- the shared vectors ---

    @Serializable
    private data class ChoiceCase(val name: String, val dndUntil: String? = null, val presenceHidden: Boolean, val presenceManual: String? = null, val choice: String)

    @Serializable
    private data class LookCase(val name: String, val connection: String, val dndUntil: String? = null, val look: String)

    @Serializable
    private data class IndefiniteCase(val dndUntil: String? = null, val indefinite: Boolean)

    /** `label`, or `until_cleared` for the indefinite pause (「解除するまで」 in the device's words). */
    @Serializable
    private data class EndLabelCase(val dndUntil: String, val label: String? = null, val untilCleared: Boolean = false)

    @Serializable
    private data class EndLabels(val tz: String, val cases: List<EndLabelCase>)

    @Serializable
    private data class SoonestCase(val name: String, val dndUntil: List<String?>, val end: String? = null)

    @Serializable
    private data class RequestCase(val status: String, val duration: String? = null, val tz: String? = null, val body: JsonObject)

    @Serializable
    private data class Vectors(
        val now: String, val myChoice: List<ChoiceCase>, val look: List<LookCase>, val indefinite: List<IndefiniteCase>,
        val endLabel: EndLabels, val soonestEnd: List<SoonestCase>, val request: List<RequestCase>, val durations: List<String>,
    )

    /** The file the other clients test against: from the module (apps/android/app), ../../shared (as ChannelsTest reads unread-rules.json). */
    private fun vectors(): Vectors {
        val file = File("../../shared/presence-rules.json")
        check(file.isFile) { "apps/shared/presence-rules.json not found from ${File("").absolutePath}" }
        return Codec.snake.decodeFromString(Vectors.serializer(), file.readText())
    }

    @Test fun sharedMyChoiceReadsTheColumnsInOrder() { // §11.1
        val v = vectors()
        val at = Instant.parse(v.now)
        assertTrue(v.myChoice.isNotEmpty())
        for (case in v.myChoice) {
            assertEquals(case.name, case.choice, PresenceRules.myChoice(me(dndUntil = case.dndUntil, hidden = case.presenceHidden, manual = case.presenceManual), at).api)
        }
    }

    @Test fun sharedLookPutsDoNotDisturbOverTheConnection() { // §11.5
        val v = vectors()
        val at = Instant.parse(v.now)
        assertTrue(v.look.isNotEmpty())
        for (case in v.look) assertEquals(case.name, case.look, PresenceRules.look(case.connection, case.dndUntil, at))
    }

    @Test fun sharedIndefiniteFromTheYear9999() { // §11.2
        val cases = vectors().indefinite
        assertTrue(cases.isNotEmpty())
        for (case in cases) assertEquals(case.dndUntil ?: "null", case.indefinite, PresenceRules.isIndefinite(case.dndUntil))
    }

    @Test fun sharedEndLabelsInTheGivenZone() { // §11.6
        val v = vectors()
        val at = Instant.parse(v.now)
        val zone = ZoneId.of(v.endLabel.tz)
        assertTrue(v.endLabel.cases.isNotEmpty())
        for (case in v.endLabel.cases) {
            val expected = if (case.untilCleared) "解除するまで" else case.label!!
            assertEquals(case.dndUntil, expected, PresenceRules.endLabel(case.dndUntil, at, zone))
        }
    }

    @Test fun sharedSoonestEndSkipsThePastAndTheIndefinite() { // §11.3
        val v = vectors()
        val at = Instant.parse(v.now)
        assertTrue(v.soonestEnd.isNotEmpty())
        for (case in v.soonestEnd) assertEquals(case.name, case.end?.let { Instant.parse(it) }, PresenceRules.nextDndEnd(case.dndUntil, at))
    }

    @Test fun sharedRequestBodiesAndDurations() { // §11.4, §11.2
        val v = vectors()
        assertTrue(v.request.isNotEmpty())
        for (case in v.request) {
            val choice = PresenceChoice.entries.first { it.api == case.status }
            val duration = case.duration?.let { d -> DndDuration.entries.first { it.api == d } }
            val body = if (case.tz != null) PresenceRules.body(choice, duration, case.tz) else PresenceRules.body(choice, duration)
            assertEquals("${case.status} ${case.duration ?: ""}".trim(), case.body, body)
        }
        assertEquals(v.durations, DndDuration.entries.map { it.api })
    }

    // --- what the vectors leave out ---

    @Test fun rulesBeyondTheVectors() {
        assertEquals(PresenceChoice.AUTO, PresenceRules.myChoice(null, now))
        assertEquals("online", PresenceRules.look("online", "garbage", now)) // an unreadable end is no pause
        // My own dot: what I chose, or the frames' while automatic.
        assertEquals("offline", PresenceRules.myLook(PresenceChoice.AUTO, "offline"))
        assertEquals("online", PresenceRules.myLook(PresenceChoice.AUTO, "online"))
        assertEquals("away", PresenceRules.myLook(PresenceChoice.AWAY, "online"))
        assertEquals("offline", PresenceRules.myLook(PresenceChoice.INVISIBLE, "online"))
        assertEquals("dnd", PresenceRules.myLook(PresenceChoice.DND, "offline"))
        // The indefinite end written with an offset, and garbage.
        assertTrue(PresenceRules.isIndefinite("9999-12-31T09:00:00+09:00"))
        assertFalse(PresenceRules.isIndefinite("nope"))
        // An unreadable end among the others is skipped by the timer.
        assertEquals(Instant.parse("2026-10-09T04:00:00Z"), PresenceRules.nextDndEnd(listOf("bad", "2026-10-09T04:00:00Z", null), now))
    }

    @Test fun linesInTheDevicesZone() {
        assertEquals("取り込み中（〜15:30）", PresenceRules.dndLine("2026-10-09T06:30:00Z", now, tokyo))
        assertEquals("取り込み中（解除するまで）", PresenceRules.dndLine(forever, now, tokyo))
        assertEquals("取り込み中（解除するまで）", PresenceRules.myLine(me(dndUntil = forever), now, tokyo))
        assertEquals("取り込み中（〜15:30）", PresenceRules.myLine(me(dndUntil = "2026-10-09T06:30:00+00:00"), now, tokyo))
        assertEquals("オンライン（自動）", PresenceRules.myLine(me(), now, tokyo))
        assertEquals("離席中", PresenceRules.myLine(me(manual = "away"), now, tokyo))
        assertEquals("オフライン表示", PresenceRules.myLine(me(hidden = true), now, tokyo))
        assertEquals("取り込み中（〜15:30）", PresenceRules.lookLabel("dnd", "2026-10-09T06:30:00Z", now, tokyo))
        assertEquals("オンライン", PresenceRules.lookLabel("online", null, now, tokyo))
        // 自分 → 「通知を一時停止」 is the same state: 「解除するまで」, not 「12/31 09:00 まで」.
        assertEquals("解除するまで", YouSettings.pauseSummary(forever, now, tokyo))
        assertEquals("15:30 まで", YouSettings.pauseSummary("2026-10-09T06:30:00Z", now, tokyo))
    }

    @Test fun theRequestBodyBeyondTheVectors() {
        assertEquals(JsonPrimitive(ZoneId.systemDefault().id), PresenceRules.body(PresenceChoice.DND, DndDuration.MINUTES_30)["tz"]) // the device's zone
        assertEquals(buildJsonObject { put("status", "away") }, PresenceRules.body(PresenceChoice.AWAY, DndDuration.HOUR_1, "Asia/Tokyo")) // a length only with dnd
        assertEquals(listOf("auto", "away", "dnd", "invisible"), PresenceChoice.entries.map { it.api })
        // The menu's 「解除」 is Settings' 「再開」: PATCH /users/me ends the pause alone (`{status: "auto"}` also dropped
        // 離席中 and 「在席を隠す」 set in Settings underneath it); the next column then shows, as the vectors say.
        assertEquals(buildJsonObject { put("dnd_until", JsonNull) }, PresenceRules.clearPauseBody())
        val paused = me(dndUntil = forever, manual = "away")
        assertEquals(PresenceChoice.DND, PresenceRules.myChoice(paused, now))
        assertEquals(PresenceChoice.AWAY, PresenceRules.myChoice(paused.copy(dndUntil = null), now))
    }

    @Test fun currentMeTakesTheNewerPublicCopy() {
        val held = me()
        val newer = user("u", dndUntil = forever, updatedAt = "2026-10-09T02:30:00Z")
        assertEquals(forever, PresenceRules.currentMe(held, newer)?.dndUntil)
        assertEquals("2026-10-09T02:30:00Z", PresenceRules.currentMe(held, newer)?.updatedAt)
        val older = user("u", dndUntil = forever, updatedAt = "2026-10-09T01:00:00Z")
        assertNull(PresenceRules.currentMe(held, older)?.dndUntil)
        assertNull(PresenceRules.currentMe(held, user("other", dndUntil = forever, updatedAt = "2026-10-09T05:00:00Z"))?.dndUntil)
        // A newer public copy that cleared it wins too (取り込み中 解除 on my phone).
        assertNull(PresenceRules.currentMe(me(dndUntil = forever), user("u", updatedAt = "2026-10-09T02:30:00Z"))?.dndUntil)
    }

    // --- the Store ---

    @Test fun theStoreGivesTheLookAndKeepsTheConnection() {
        val store = Store()
        store.upsertUser(user("a", dndUntil = "2026-10-09T04:00:00Z"))
        store.upsertUser(user("b", dndUntil = forever))
        store.upsertUser(user("c"))
        store.setPresence("a", "online")
        store.setPresence("c", "away")
        assertEquals("dnd", store.presenceOf("a", now))
        assertEquals("online", store.connectionOf("a"))
        assertEquals("dnd", store.presenceOf("b", now)) // offline, still 取り込み中
        assertEquals("offline", store.connectionOf("b"))
        assertEquals("away", store.presenceOf("c", now))
        assertEquals("online", store.presenceOf("a", Instant.parse("2026-10-09T04:00:01Z"))) // ran out
        assertEquals(Instant.parse("2026-10-09T04:00:00Z"), store.nextDndEnd(now))
        assertNull(store.nextDndEnd(Instant.parse("2026-10-09T04:00:01Z")))
        // The timer's tick makes the screen read again.
        val before = store.version.value
        store.dndEnded()
        assertTrue(store.version.value > before)
    }

    // --- the engine: my choice from another device, and no local notification while 取り込み中 ---

    private suspend fun settle(engine: SyncEngine) { repeat(20) { engine.idle(); yield() } }

    @Test fun anotherDeviceChoosesAndThisOneFollows() = runBlocking {
        val server = FakeServer()
        val alice = server.addUser("alice")
        val bob = server.addUser("bob")
        val dm = server.createChannel("", alice.id, type = "dm")
        server.join(dm.id, bob.id)
        val store = Store()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val time = ManualTime()
        val engine = SyncEngine(server.api(bob.id), server.connector(bob.id), "ws://fake", store, { "token" }, scope,
            EngineOptions(pageSize = 50, reconnectMinMs = 0, sleep = {}, random = { 0.5 }, clock = time.clock, timer = time.timer))
        val notified = ArrayList<String>()
        engine.isActive = { false }
        engine.onNotify = { message, _ -> notified.add(message.body) }
        engine.start(); settle(engine)
        server.post(dm.id, alice.id, "before"); settle(engine)
        assertEquals(listOf("before"), notified)

        // 取り込み中 until I turn it off, chosen on my phone: the public copy at once, my settings read again.
        server.setMyPresence(bob.id, "dnd", forever); settle(engine)
        assertEquals(forever, store.users[bob.id]?.dndUntil)
        val current = PresenceRules.currentMe(store.me, store.users[bob.id])
        assertEquals(PresenceChoice.DND, PresenceRules.myChoice(current))
        assertEquals(forever, store.me?.dndUntil)
        assertEquals("dnd", store.presenceOf(bob.id))
        // Nothing is said while 取り込み中 (the server holds the pushes too).
        server.post(dm.id, alice.id, "during"); settle(engine)
        assertEquals(listOf("before"), notified)

        // 離席中 from my phone: my private column comes with GET /users/me; the pause is gone.
        server.setMyPresence(bob.id, "away"); settle(engine)
        assertEquals("away", store.me?.presenceManual)
        assertNull(store.me?.dndUntil)
        assertEquals(PresenceChoice.AWAY, PresenceRules.myChoice(PresenceRules.currentMe(store.me, store.users[bob.id])))
        server.post(dm.id, alice.id, "after"); settle(engine)
        assertEquals(listOf("before", "after"), notified)

        server.setMyPresence(bob.id, "invisible"); settle(engine)
        assertEquals(PresenceChoice.INVISIBLE, PresenceRules.myChoice(store.me))
        assertNull(store.me?.presenceManual)
        server.setMyPresence(bob.id, "auto"); settle(engine)
        assertEquals(PresenceChoice.AUTO, PresenceRules.myChoice(store.me))
        engine.stop(); scope.cancel()
    }
}
