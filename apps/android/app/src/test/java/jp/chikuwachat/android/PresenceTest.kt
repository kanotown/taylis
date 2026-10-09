package jp.chikuwachat.android

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
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.ZoneId

/** docs/PRESENCE.md §11: the quick status menu's rules, the Store's look, and my choice from my other devices. */
class PresenceTest {
    private val tokyo = ZoneId.of("Asia/Tokyo")
    private val now = Instant.parse("2026-10-09T03:00:00Z") // 12:00 in Tokyo
    private val forever = "9999-12-31T00:00:00Z"

    private fun me(dndUntil: String? = null, hidden: Boolean = false, manual: String? = null, updatedAt: String = "2026-10-09T02:00:00Z") =
        UserMe("u", "u", "U", "member", null, "2026-01-01T00:00:00Z", updatedAt, null, false, dndUntil = dndUntil, presenceHidden = hidden, presenceManual = manual)

    private fun user(id: String, dndUntil: String? = null, updatedAt: String = "2026-10-09T02:00:00Z") =
        UserPublic(id, id, id, "member", createdAt = "2026-01-01T00:00:00Z", updatedAt = updatedAt, dndUntil = dndUntil)

    // --- the rules ---

    @Test fun myChoiceReadsTheColumnsInOrder() {
        assertEquals(PresenceChoice.AUTO, PresenceRules.myChoice(null, now))
        assertEquals(PresenceChoice.AUTO, PresenceRules.myChoice(me(), now))
        assertEquals(PresenceChoice.AWAY, PresenceRules.myChoice(me(manual = "away"), now))
        assertEquals(PresenceChoice.AUTO, PresenceRules.myChoice(me(manual = "lunch"), now)) // unknown = automatic
        assertEquals(PresenceChoice.INVISIBLE, PresenceRules.myChoice(me(hidden = true, manual = "away"), now))
        assertEquals(PresenceChoice.DND, PresenceRules.myChoice(me(dndUntil = "2026-10-09T06:30:00Z", hidden = true, manual = "away"), now))
        // A pause that ran out is not 取り込み中 any more: the next column counts.
        assertEquals(PresenceChoice.INVISIBLE, PresenceRules.myChoice(me(dndUntil = "2026-10-09T02:59:00Z", hidden = true), now))
        assertEquals(PresenceChoice.DND, PresenceRules.myChoice(me(dndUntil = forever), now))
    }

    @Test fun theLookPutsDoNotDisturbOverTheConnection() {
        for (connection in listOf("online", "away", "offline")) {
            assertEquals("dnd", PresenceRules.look(connection, "2026-10-09T03:30:00Z", now))
            assertEquals(connection, PresenceRules.look(connection, "2026-10-09T03:00:00Z", now)) // ended exactly now
            assertEquals(connection, PresenceRules.look(connection, null, now))
        }
        assertEquals("dnd", PresenceRules.look("offline", forever, now))
        assertEquals("online", PresenceRules.look("online", "garbage", now))
        // My own dot: what I chose, or the frames' while automatic.
        assertEquals("offline", PresenceRules.myLook(PresenceChoice.AUTO, "offline"))
        assertEquals("online", PresenceRules.myLook(PresenceChoice.AUTO, "online"))
        assertEquals("away", PresenceRules.myLook(PresenceChoice.AWAY, "online"))
        assertEquals("offline", PresenceRules.myLook(PresenceChoice.INVISIBLE, "online"))
        assertEquals("dnd", PresenceRules.myLook(PresenceChoice.DND, "offline"))
    }

    @Test fun indefiniteFromTheYear9999() {
        assertTrue(PresenceRules.isIndefinite(forever))
        assertTrue(PresenceRules.isIndefinite("9999-01-01T00:00:00Z"))
        assertTrue(PresenceRules.isIndefinite("9999-12-31T09:00:00+09:00"))
        assertFalse(PresenceRules.isIndefinite("9998-12-31T23:59:59Z"))
        assertFalse(PresenceRules.isIndefinite(null))
        assertFalse(PresenceRules.isIndefinite("nope"))
    }

    @Test fun labelsInTheDevicesZone() {
        assertEquals("15:30", PresenceRules.endLabel("2026-10-09T06:30:00Z", now, tokyo))
        assertEquals("10/10 23:59", PresenceRules.endLabel("2026-10-10T14:59:59Z", now, tokyo))
        assertEquals("解除するまで", PresenceRules.endLabel(forever, now, tokyo))
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

    @Test fun theRequestBody() {
        assertEquals(buildJsonObject { put("status", "dnd"); put("duration", "today"); put("tz", "Asia/Tokyo") }, PresenceRules.body(PresenceChoice.DND, DndDuration.TODAY, "Asia/Tokyo"))
        assertEquals(buildJsonObject { put("status", "away") }, PresenceRules.body(PresenceChoice.AWAY, DndDuration.HOUR_1, "Asia/Tokyo"))
        assertEquals(buildJsonObject { put("status", "auto") }, PresenceRules.body(PresenceChoice.AUTO))
        assertEquals(buildJsonObject { put("status", "invisible") }, PresenceRules.body(PresenceChoice.INVISIBLE))
        assertEquals(JsonPrimitive(ZoneId.systemDefault().id), PresenceRules.body(PresenceChoice.DND, DndDuration.MINUTES_30)["tz"])
        assertEquals(listOf("30m", "1h", "2h", "4h", "today", "tomorrow", "forever"), DndDuration.entries.map { it.api })
        assertEquals(listOf("auto", "away", "dnd", "invisible"), PresenceChoice.entries.map { it.api })
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

    @Test fun theSoonestEndSkipsThePastAndTheIndefinite() {
        val untils = listOf(null, "2026-10-09T02:00:00Z", forever, "2026-10-09T05:00:00Z", "2026-10-09T04:00:00Z", "bad")
        assertEquals(Instant.parse("2026-10-09T04:00:00Z"), PresenceRules.nextDndEnd(untils, now))
        assertNull(PresenceRules.nextDndEnd(listOf(forever, null), now))
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
