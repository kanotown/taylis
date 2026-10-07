package jp.chikuwachat.android

import java.time.Instant
import java.time.ZoneId
import jp.chikuwachat.android.api.AttendanceBoardOut
import jp.chikuwachat.android.api.AttendanceEntryOut
import jp.chikuwachat.android.api.AttendanceStateOut
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.NavItem
import jp.chikuwachat.android.api.ThreadSummary
import jp.chikuwachat.android.api.UserMe
import jp.chikuwachat.android.api.UserPublic
import jp.chikuwachat.android.sync.EngineOptions
import jp.chikuwachat.android.sync.Store
import jp.chikuwachat.android.sync.SyncEngine
import jp.chikuwachat.android.ui.AttendanceRules
import jp.chikuwachat.android.ui.HomeTile
import jp.chikuwachat.android.ui.HomeTiles
import jp.chikuwachat.android.ui.NavItems
import jp.chikuwachat.android.ui.Route
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** M140 (docs/PRESENCE.md §9): 「在室状況」 on Android — decoding, the board's groups, the buttons, live events, off and guests. */
class AttendanceTest {
    private val tokyo = ZoneId.of("Asia/Tokyo")
    /** 2026-10-07 10:00 in Tokyo. */
    private val now = Instant.parse("2026-10-07T01:00:00Z")

    private fun user(id: String, name: String, role: String = "member", deactivated: Boolean = false) =
        UserPublic(id, id, name, role, if (deactivated) "2026-10-01T00:00:00Z" else null, "2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z")

    private fun state(id: String, kind: String, position: Int, owner: String? = null, archived: Boolean = false, emoji: String? = null) =
        AttendanceStateOut(id = id, ownerId = owner, label = id, emoji = emoji, color = "green", kind = kind, position = position, archived = archived)

    private fun entry(user: String, state: String, since: String = "2026-10-07T00:15:00Z", note: String? = null) =
        AttendanceEntryOut(userId = user, stateId = state, since = since, note = note)

    private val states = listOf(
        state("gone", "gone", 3),
        state("on_site", "on_site", 1),
        state("room", "in_room", 0, emoji = "🟢"),
        state("meeting", "in_room", 0, owner = "bob"),  // Bob's own: after the workspace's in_room
        state("old", "off_site", 2, archived = true),     // deleted, still somebody's
        state("trip", "off_site", 0, owner = "carol"),
    )

    private val people = listOf(
        user("alice", "Alice"), user("bob", "Bob"), user("carol", "Carol"), user("dave", "Dave"), user("erin", "Erin", role = "admin"),
        user("guest", "Guest", role = "guest"), user("bot", "Bot", role = "bot"), user("gone-user", "Gone", deactivated = true),
    )

    private val board = AttendanceBoardOut(
        enabled = true, states = states, canPersonalize = true,
        entries = listOf(
            entry("alice", "room", since = "2026-10-07T00:30:00Z", note = "3 号室"),
            entry("erin", "room", since = "2026-10-07T00:10:00Z"),
            entry("bob", "meeting"),
            entry("carol", "old"),
            entry("guest", "room"),  // never on the board
        ),
    )

    /** M142 (docs/ROLES.md §1): a manager (「運営」) is a person on the board; guests, bots and unknown roles are not. */
    @Test fun managersAreOnTheBoard() {
        assertTrue(AttendanceRules.onBoard(user("m", "M", role = "manager")))
        assertTrue(AttendanceRules.onBoard(user("a", "A", role = "admin")))
        assertTrue(AttendanceRules.onBoard(user("b", "B")))
        assertFalse(AttendanceRules.onBoard(user("g", "G", role = "guest")))
        assertFalse(AttendanceRules.onBoard(user("x", "X", role = "bot")))
        assertFalse(AttendanceRules.onBoard(user("s", "S", role = "someday")))
        assertFalse(AttendanceRules.onBoard(user("d", "D", role = "manager", deactivated = true)))
    }

    @Test fun decodesTheServersBoard() {
        val json = """
            {"enabled": true, "can_personalize": false,
             "states": [{"id": "s1", "owner_id": null, "label": "在室", "emoji": "🟢", "color": "green", "kind": "in_room", "position": 0, "archived": false}],
             "entries": [{"user_id": "u1", "state_id": "s1", "since": "2026-10-07T00:15:00.123456Z", "note": null, "source": "integration"}]}
        """.trimIndent()
        val decoded = Codec.snake.decodeFromString(AttendanceBoardOut.serializer(), json)
        assertEquals("in_room", decoded.states.single().kind)
        assertNull(decoded.states.single().ownerId)
        assertEquals("integration", decoded.entries.single().source)
        assertFalse(decoded.canPersonalize)
    }

    @Test fun theBoardGroupsByKindThenWorkspaceBeforePersonalThenUnset() {
        val groups = AttendanceRules.groups(board, people)
        assertEquals(listOf("room", "meeting", "old", null), groups.map { it.state?.id })
        // Within a state, who came first; the guest, the bot and the deactivated account are not on the board.
        assertEquals(listOf("erin", "alice"), groups[0].people.map { it.user.id })
        assertEquals(listOf("Dave"), groups.last().people.map { it.user.displayName })
        assertTrue(groups.flatMap { it.people }.none { it.user.id in setOf("guest", "bot", "gone-user") })
        // 「在室 n 人」: both in_room states (the workspace's and Bob's own), not the guest's row.
        assertEquals(3, AttendanceRules.inRoomCount(board, people))
    }

    @Test fun aRowWhoseStateIsUnknownCountsAsUnset() {
        val withStray = AttendanceRules.withEntry(board, entry("dave", "nope"))
        assertEquals(listOf("dave"), AttendanceRules.groups(withStray, people).last().people.map { it.user.id })
    }

    @Test fun myButtonsAreTheWorkspacesThenMineWithMyStatePressed() {
        val bob = AttendanceRules.choices(board, "bob")
        assertEquals(listOf("room", "on_site", "gone", "meeting"), bob.map { it.state.id })
        assertEquals(listOf("meeting"), bob.filter { it.selected }.map { it.state.id })
        // Carol's state was deleted: no button is pressed, and her own 「trip」 is offered to her only.
        val carol = AttendanceRules.choices(board, "carol")
        assertEquals(listOf("room", "on_site", "gone", "trip"), carol.map { it.state.id })
        assertTrue(carol.none { it.selected })
        assertEquals(listOf("trip"), AttendanceRules.myOwnStates(board, "carol").map { it.id })
        // Dave has none yet.
        assertTrue(AttendanceRules.choices(board, "dave").none { it.selected })
    }

    @Test fun pressingKeepsTheNoteOnlyForTheSameState() {
        assertEquals("3 号室", AttendanceRules.noteForPress(board, "alice", "room"))
        assertNull(AttendanceRules.noteForPress(board, "alice", "gone"))
        assertNull(AttendanceRules.noteForPress(board, "dave", "room"))
        assertNull(AttendanceRules.cleanNote("   "))
        assertEquals("15 時 に戻る", AttendanceRules.cleanNote(" 15 時   に戻る "))
    }

    @Test fun sinceIsTheTimeTodayAndTheDateBefore() {
        assertEquals("9:15 から", AttendanceRules.sinceLabel("2026-10-07T00:15:00Z", now, tokyo))
        assertEquals("10/6 18:02 から", AttendanceRules.sinceLabel("2026-10-06T09:02:00Z", now, tokyo))
        assertEquals("3 号室 · 9:30 から", AttendanceRules.detail(board.entries.first(), now, tokyo))
    }

    @Test fun offNullAndGuestsShowNothing() {
        assertTrue(AttendanceRules.shown(board, "member"))
        assertFalse(AttendanceRules.shown(board.copy(enabled = false), "member"))
        assertFalse(AttendanceRules.shown(null, "admin"))
        assertFalse(AttendanceRules.shown(board, "guest"))
        // The store keeps no board that is off, nor one for a guest.
        val store = Store()
        store.setAttendance(board.copy(enabled = false))
        assertNull(store.attendance)
        store.setMe(UserMe("g", "g", "G", "guest", null, "t", "t", null, false))
        store.setAttendance(board)
        assertNull(store.attendance)
    }

    @Test fun anEventReplacesTheRowAndSaysWhenTheStateIsUnknown() {
        val store = Store()
        store.setAttendance(board)
        assertTrue(store.applyAttendanceEntry(entry("alice", "gone", since = "2026-10-07T01:00:00Z")))
        assertEquals("gone", AttendanceRules.entryOf(store.attendance, "alice")?.stateId)
        assertEquals(board.entries.size, store.attendance!!.entries.size)
        assertFalse(store.applyAttendanceEntry(entry("dave", "brand-new")))
        assertEquals("brand-new", AttendanceRules.entryOf(store.attendance, "dave")?.stateId)
        // While off nothing is kept, and nothing needs reading.
        val off = Store()
        assertTrue(off.applyAttendanceEntry(entry("dave", "room")))
        assertNull(off.attendance)
    }

    @Test fun theTileAndTheSettingsRowOnlyWhileOn() {
        val off = HomeTiles.tiles(ThreadSummary(0, 0), 0, 0, 0, navItems = null)
        assertTrue(off.none { it.tile == HomeTile.ATTENDANCE })
        val on = HomeTiles.tiles(ThreadSummary(0, 0), 0, 0, 0, navItems = null, attendance = true)
        assertEquals(HomeTile.ATTENDANCE, on.last().tile)  // last in the mobile default order
        assertNull(on.last().count)
        assertEquals("attendance", HomeTile.ATTENDANCE.navKey)
        assertFalse("attendance" in NavItems.implemented)
        assertTrue("attendance" in NavItems.implemented(attendance = true))
        val hidden = HomeTiles.tiles(ThreadSummary(0, 0), 0, 0, 0, navItems = listOf(NavItem("attendance", false)), attendance = true)
        assertTrue(hidden.none { it.tile == HomeTile.ATTENDANCE })
        val first = NavItems.full(listOf(NavItem("attendance", true)))
        assertEquals("attendance", NavItems.shown(first, implemented = NavItems.implemented(true)).first().key)
        assertTrue(NavItems.shown(first).none { it.key == "attendance" })
        assertTrue(Route.Attendance.keptUnderConversation)
    }

    // --- live ----------------------------------------------------------------------------------

    private fun onBoard() = AttendanceBoardOut(
        enabled = true, canPersonalize = false,
        states = listOf(state("room", "in_room", 0), state("gone", "gone", 1)),
    )

    @Test fun theBoardComesWithTheBootstrapAndFollowsTheEvents() = runBlocking {
        val server = FakeServer()
        val alice = server.addUser("alice"); val bob = server.addUser("bob")
        server.createChannel("general", alice.id)
        server.attendance = onBoard().copy(entries = listOf(entry(alice.id, "room")))
        val store = Store()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val engine = SyncEngine(server.api(bob.id), server.connector(bob.id), "ws://fake", store, { "t" }, scope, EngineOptions(sleep = {}))
        engine.start(); engine.idle()
        assertEquals("room", AttendanceRules.entryOf(store.attendance, alice.id)?.stateId)
        val reads = server.attendanceReads
        // attendance.updated replaces the row; no read for a known state.
        server.setAttendanceEntry(entry(alice.id, "gone", note = "また明日"))
        engine.idle()
        assertEquals("gone", AttendanceRules.entryOf(store.attendance, alice.id)?.stateId)
        assertEquals("また明日", AttendanceRules.entryOf(store.attendance, alice.id)?.note)
        delay(400)
        assertEquals(reads, server.attendanceReads)
        // A state this app does not know (someone's new own state): the board is read again.
        server.attendance = server.attendance.copy(states = server.attendance.states + state("lab", "in_room", 0, owner = alice.id))
        server.setAttendanceEntry(entry(alice.id, "lab"))
        engine.idle()
        delay(500)
        assertEquals(reads + 1, server.attendanceReads)
        assertEquals("lab", AttendanceRules.stateOf(store.attendance, "lab")?.id)
        // A burst of config_updated: one read.
        repeat(3) { server.configureAttendance(server.attendance.copy(canPersonalize = true)) }
        engine.idle()
        delay(500)
        assertEquals(reads + 2, server.attendanceReads)
        assertTrue(store.attendance!!.canPersonalize)
        // Turned off: the board goes (the tile with it).
        server.configureAttendance(server.attendance.copy(enabled = false))
        engine.idle()
        delay(500)
        assertNull(store.attendance)
        engine.stop(); scope.cancel()
    }

    @Test fun aGuestNeverHasTheBoard() = runBlocking {
        val server = FakeServer()
        val alice = server.addUser("alice"); val guest = server.addUser("visitor", role = "guest")
        server.createChannel("general", alice.id)
        server.attendance = onBoard()
        val store = Store()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val engine = SyncEngine(server.api(guest.id), server.connector(guest.id), "ws://fake", store, { "t" }, scope, EngineOptions(sleep = {}))
        engine.start(); engine.idle()
        assertNull(store.attendance)
        engine.loadAttendance()  // not even asked
        assertEquals(0, server.attendanceReads)
        server.setAttendanceEntry(entry(alice.id, "room"))
        engine.idle()
        assertNull(store.attendance)
        engine.stop(); scope.cancel()
    }

    @Test fun offInTheBootstrapIsNoBoard() = runBlocking {
        val server = FakeServer()
        val alice = server.addUser("alice")
        server.createChannel("general", alice.id)
        val store = Store()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val engine = SyncEngine(server.api(alice.id), server.connector(alice.id), "ws://fake", store, { "t" }, scope, EngineOptions(sleep = {}))
        engine.start(); engine.idle()
        assertNull(store.attendance)
        // Turned on: config_updated reads it.
        server.configureAttendance(onBoard())
        engine.idle()
        delay(500)
        assertTrue(AttendanceRules.shown(store.attendance, "member"))
        engine.stop(); scope.cancel()
    }
}
