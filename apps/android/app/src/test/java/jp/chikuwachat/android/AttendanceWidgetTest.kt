package jp.chikuwachat.android

import jp.chikuwachat.android.api.ApiClient
import jp.chikuwachat.android.api.AttendanceBoardOut
import jp.chikuwachat.android.api.AttendanceEntryOut
import jp.chikuwachat.android.api.AttendanceStateOut
import jp.chikuwachat.android.api.UserPublic
import jp.chikuwachat.android.ui.AttendanceRules
import jp.chikuwachat.android.widget.AttendanceWidgetRules
import jp.chikuwachat.android.widget.AttendanceWidgetSnapshot
import jp.chikuwachat.android.widget.WidgetPress
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The 在室状況 home-screen widget's pure parts: the snapshot, its count, the buttons, presses and their answers. */
class AttendanceWidgetTest {
    private val server = "https://lab.example.com"

    private fun user(id: String, role: String = "member", deactivated: Boolean = false) =
        UserPublic(id, id, id.replaceFirstChar { it.uppercase() }, role, if (deactivated) "2026-10-01T00:00:00Z" else null, "2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z")

    private fun state(id: String, kind: String, position: Int, owner: String? = null, archived: Boolean = false, icon: String? = null) =
        AttendanceStateOut(id = id, ownerId = owner, label = id, icon = icon, color = "green", kind = kind, position = position, archived = archived)

    private fun entry(user: String, state: String, note: String? = null) =
        AttendanceEntryOut(userId = user, stateId = state, since = "2026-10-13T00:15:00Z", note = note)

    private val states = listOf(
        state("room", "in_room", 0, icon = "in_room"),
        state("campus", "on_site", 1, icon = "on_site"),
        state("out", "off_site", 2, icon = "off_site"),
        state("home", "gone", 3, icon = "gone"),
        state("old", "off_site", 4, archived = true),
        state("lab", "in_room", 0, owner = "me", icon = "lab"),
        state("bobs", "in_room", 0, owner = "bob"),
    )

    private val people = listOf(
        user("me"), user("bob"), user("carol"), user("dave"),
        user("guest", role = "guest"), user("bot", role = "bot"), user("gone", deactivated = true),
    )

    private fun board(vararg entries: AttendanceEntryOut, enabled: Boolean = true) =
        AttendanceBoardOut(enabled = enabled, states = states, entries = entries.toList())

    private fun snap(board: AttendanceBoardOut?, users: Collection<UserPublic>? = people, me: String = "me") =
        AttendanceWidgetRules.snapshot(server, "Kano Lab", me, board, users, 1_000L)

    // --- the snapshot -----------------------------------------------------------------------------

    @Test
    fun snapshotHoldsMyStateTheButtonsAndTheCount() {
        val s = snap(board(entry("me", "room", note = "until 18"), entry("bob", "bobs"), entry("carol", "home"), entry("dave", "room")))
        assertTrue(s.enabled)
        assertEquals("Kano Lab", s.workspaceName)
        assertEquals("room", s.myState?.id)
        assertEquals("until 18", s.myNote)
        // The app's buttons: the workspace's states in order (archived never), then my own; nobody else's.
        assertEquals(listOf("room", "campus", "out", "home", "lab"), s.states.map { it.id })
        assertTrue(s.states.single { it.id == "lab" }.personal)
        assertEquals(3, s.inRoomCount) // me, bob (his own in_room state), dave
        assertEquals(1_000L, s.updatedAt)
    }

    @Test
    fun countFollowsTheAppsRule() {
        val b = board(
            entry("me", "lab"), entry("bob", "room"), entry("carol", "campus"),
            entry("guest", "room"), entry("bot", "room"), entry("gone", "room"), entry("stranger", "room"),
        )
        // Only the board's people: no guests, bots, deactivated or unknown people (AttendanceRules.inRoomCount).
        assertEquals(AttendanceRules.inRoomCount(b, people), snap(b).inRoomCount)
        assertEquals(2, snap(b).inRoomCount)
        // Without the people at hand (a press while the workspace is not loaded): the server's rows are its people already.
        assertEquals(6, snap(b, users = null).inRoomCount)
    }

    @Test
    fun anOffBoardOrNoBoardIsOff() {
        assertFalse(snap(null).enabled)
        assertFalse(snap(board(enabled = false)).enabled)
        assertTrue(snap(null).states.isEmpty())
        assertNull(AttendanceWidgetRules.toggle(snap(null)))
        assertTrue(AttendanceWidgetRules.wideButtons(snap(null), 4).isEmpty())
    }

    @Test
    fun anArchivedStateOfMineIsStillShown() {
        val s = snap(board(entry("me", "old")))
        assertEquals("old", s.myState?.id)
        assertTrue(s.states.none { it.id == "old" })
        assertEquals(0, s.inRoomCount)
    }

    @Test
    fun encodesAndDecodes() {
        val s = AttendanceWidgetRules.pressed(snap(board(entry("me", "room", note = "メモ"), entry("bob", "room"))), "home", 5_000L)!!
        val text = AttendanceWidgetRules.encode(s)
        assertEquals(s, AttendanceWidgetRules.decode(text))
        assertNull(AttendanceWidgetRules.decode(null))
        assertNull(AttendanceWidgetRules.decode(""))
        assertNull(AttendanceWidgetRules.decode("{not json"))
        // A later version's extra fields are skipped; missing optional ones take their defaults.
        val old = AttendanceWidgetRules.decode(
            """{"serverUrl":"$server","workspaceName":"W","meId":"me","enabled":true,"future":1,""" +
                """"states":[{"id":"room","label":"在室","kind":"in_room"}],"myState":{"id":"room","label":"在室","kind":"in_room"}}""",
        )!!
        assertEquals("gray", old.myState?.color)
        assertEquals(1, old.inRoomCount)
        assertFalse(old.failed)
    }

    // --- the buttons ------------------------------------------------------------------------------

    @Test
    fun compactToggleGoesHomeFromTheRoomAndToTheRoomFromAnythingElse() {
        assertEquals("home", AttendanceWidgetRules.toggle(snap(board(entry("me", "room"))))?.state?.id)
        // My own in_room state counts as being in the room too.
        assertEquals("home", AttendanceWidgetRules.toggle(snap(board(entry("me", "lab"))))?.state?.id)
        assertEquals("room", AttendanceWidgetRules.toggle(snap(board(entry("me", "home"))))?.state?.id)
        assertEquals("room", AttendanceWidgetRules.toggle(snap(board(entry("me", "campus"))))?.state?.id)
        assertEquals("room", AttendanceWidgetRules.toggle(snap(board()))?.state?.id) // no state yet
        // A workspace without a gone state: no toggle while in the room.
        val noHome = snap(AttendanceBoardOut(true, states.filter { it.kind != "gone" }, listOf(entry("me", "room"))))
        assertNull(AttendanceWidgetRules.toggle(noHome))
    }

    @Test
    fun toggleFollowsThePendingPress() {
        val s = AttendanceWidgetRules.pressed(snap(board(entry("me", "home"))), "room", 10L)!!
        assertEquals("home", AttendanceWidgetRules.toggle(s)?.state?.id)
    }

    @Test
    fun wideButtonsAreAllStatesWhenTheyFit() {
        val s = snap(board(entry("me", "campus")))
        val buttons = AttendanceWidgetRules.wideButtons(s, 6)
        assertEquals(listOf("room", "campus", "out", "home", "lab"), buttons.map { it.state.id })
        assertEquals(listOf("campus"), buttons.filter { it.selected }.map { it.state.id })
    }

    @Test
    fun wideButtonsKeepOneOfEachKindWhenTight() {
        val crowded = AttendanceBoardOut(
            true,
            listOf(
                state("room", "in_room", 0), state("seminar", "in_room", 1), state("meeting", "in_room", 2),
                state("campus", "on_site", 3), state("out", "off_site", 4), state("home", "gone", 5),
            ),
            listOf(entry("me", "room")),
        )
        val s = snap(crowded)
        assertEquals(listOf("room", "campus", "out", "home"), AttendanceWidgetRules.wideButtons(s, 4).map { it.state.id })
        assertEquals(listOf("room", "seminar", "campus", "out", "home"), AttendanceWidgetRules.wideButtons(s, 5).map { it.state.id })
        // Fewer places: arriving and leaving first.
        assertEquals(listOf("room", "home"), AttendanceWidgetRules.wideButtons(s, 2).map { it.state.id })
        assertEquals(listOf("room", "campus", "home"), AttendanceWidgetRules.wideButtons(s, 3).map { it.state.id })
    }

    @Test
    fun wideButtonCountFitsTheWidth() {
        // A 4×1 cell on a phone is about 360 dp: four round buttons beside my state and the faces.
        assertEquals(4, AttendanceWidgetRules.wideButtonCount(360f, tall = false))
        assertEquals(3, AttendanceWidgetRules.wideButtonCount(320f, tall = false))
        assertEquals(1, AttendanceWidgetRules.wideButtonCount(230f, tall = false))
        assertEquals(5, AttendanceWidgetRules.wideButtonCount(360f, tall = true))
        assertEquals(4, AttendanceWidgetRules.wideButtonCount(320f, tall = true))
        assertEquals(1, AttendanceWidgetRules.wideButtonCount(100f, tall = false))
        assertEquals(AttendanceWidgetRules.MAX_WIDE_BUTTONS, AttendanceWidgetRules.wideButtonCount(900f, tall = true))
    }

    // --- presses ----------------------------------------------------------------------------------

    @Test
    fun aPressIsDrawnAtOnceAndCountsMe() {
        val s = snap(board(entry("me", "home"), entry("bob", "room")))
        assertEquals(1, s.inRoomCount)
        val pressed = AttendanceWidgetRules.pressed(s, "room", 50L)!!
        assertEquals("room", pressed.shownState?.id)
        assertEquals("home", pressed.myState?.id)
        assertEquals(2, pressed.inRoomCount)
        // Not one of my buttons, or the board off: nothing.
        assertNull(AttendanceWidgetRules.pressed(s, "bobs", 50L))
        assertNull(AttendanceWidgetRules.pressed(snap(null), "room", 50L))
    }

    @Test
    fun aFailedPressKeepsTheLastKnownState() {
        val pressed = AttendanceWidgetRules.pressed(snap(board(entry("me", "home"))), "room", 50L)!!
        val failed = AttendanceWidgetRules.failedPress(pressed, "room")!!
        assertTrue(failed.failed)
        assertEquals("home", failed.shownState?.id)
        assertNull(failed.pendingStateId)
        // A newer press is waiting: the old failure leaves it alone.
        val newer = AttendanceWidgetRules.pressed(pressed, "out", 60L)!!
        assertEquals(newer, AttendanceWidgetRules.failedPress(newer, "room"))
        // The next press clears the hint.
        assertFalse(AttendanceWidgetRules.pressed(failed, "room", 70L)!!.failed)
    }

    @Test
    fun anAnswerReplacesThePressUnlessANewerOneWaits() {
        val start = snap(board(entry("me", "home")))
        val first = AttendanceWidgetRules.pressed(start, "room", 100L)!!
        val fresh = snap(board(entry("me", "room")))
        assertEquals(fresh, AttendanceWidgetRules.answered(first, fresh, "room", 200L))
        val second = AttendanceWidgetRules.pressed(first, "out", 150L)!!
        val kept = AttendanceWidgetRules.answered(second, fresh, "room", 200L)
        assertEquals("out", kept.shownState?.id)
        assertEquals("room", kept.myState?.id)
    }

    @Test
    fun theAppsSnapshotKeepsAWaitingPress() {
        val pressed = AttendanceWidgetRules.pressed(snap(board(entry("me", "home"))), "room", 1_000L)!!
        val fromApp = snap(board(entry("me", "home"), entry("bob", "room")))
        val merged = AttendanceWidgetRules.merge(pressed, fromApp, 2_000L)
        assertEquals("room", merged.shownState?.id)
        assertEquals(2, merged.inRoomCount)
        // Too old, another workspace or person, or a state that went away: the app's snapshot as it is.
        assertEquals(fromApp, AttendanceWidgetRules.merge(pressed, fromApp, 1_000L + AttendanceWidgetRules.PENDING_TTL_MS))
        assertEquals(fromApp.copy(serverUrl = "x"), AttendanceWidgetRules.merge(pressed, fromApp.copy(serverUrl = "x"), 2_000L))
        val withoutRoom = AttendanceWidgetSnapshot(server, "W", "me", enabled = true, states = fromApp.states.filter { it.id != "room" })
        assertEquals(withoutRoom, AttendanceWidgetRules.merge(pressed, withoutRoom, 2_000L))
        assertEquals(fromApp, AttendanceWidgetRules.merge(null, fromApp, 2_000L))
    }

    @Test
    fun sameIgnoresTheTime() {
        val a = snap(board(entry("me", "room")))
        assertTrue(AttendanceWidgetRules.same(a, a.copy(updatedAt = 99L)))
        assertFalse(AttendanceWidgetRules.same(a, a.copy(failed = true)))
    }

    // --- the request ------------------------------------------------------------------------------

    @Test
    fun aPressSendsTheStateAndTheAppsNoteRule() {
        val b = board(entry("me", "room", note = "until 18"))
        // Pressing my current state again keeps the note; a new state starts clean (AttendanceRules.noteForPress).
        assertEquals(WidgetPress("room", "until 18"), AttendanceWidgetRules.press(b, "me", "room"))
        assertEquals(WidgetPress("home", null), AttendanceWidgetRules.press(b, "me", "home"))
        assertEquals(WidgetPress("room", null), AttendanceWidgetRules.press(board(), "me", "room"))
    }

    @Test
    fun theRequestBodyIsWhatTheAppSends() {
        assertEquals(
            buildJsonObject { put("state_id", JsonPrimitive("home")); put("note", JsonNull) },
            ApiClient.setMyAttendanceBody("home", null),
        )
        assertEquals(
            buildJsonObject { put("state_id", JsonPrimitive("room")); put("note", JsonPrimitive("until 18")) },
            ApiClient.setMyAttendanceBody("room", "until 18"),
        )
    }

    // --- who is in the room (the faces) -----------------------------------------------------------

    @Test
    fun theFacesAreThePeopleInTheRoomLongestThereFirstWithMeFirstWhileIAmIn() {
        val b = AttendanceBoardOut(
            enabled = true, states = states,
            entries = listOf(
                AttendanceEntryOut("carol", "room", since = "2026-10-13T09:00:00Z"),
                AttendanceEntryOut("bob", "lab", since = "2026-10-13T08:00:00Z"),
                AttendanceEntryOut("dave", "home", since = "2026-10-13T07:00:00Z"),
                AttendanceEntryOut("guest", "room", since = "2026-10-13T06:00:00Z"),
                AttendanceEntryOut("me", "room", since = "2026-10-13T10:00:00Z"),
            ),
        )
        val s = snap(b)
        // bob's own in_room state counts; dave is gone; a guest is not on the board.
        assertEquals(listOf("bob", "carol"), s.present.map { it.id })
        assertEquals(listOf("Bob", "Carol"), s.present.map { it.name })
        assertEquals("Me", s.meName)
        assertEquals(listOf("me", "bob", "carol"), s.faces.map { it.id })
        assertEquals(3, s.inRoomCount)
        // Pressed 帰宅: I leave the faces at once.
        val pressed = AttendanceWidgetRules.pressed(s, "home", 2_000L)!!
        assertEquals(listOf("bob", "carol"), pressed.faces.map { it.id })
    }

    @Test
    fun withoutThePeopleTheNamesComeFromTheLastSnapshot() {
        val first = snap(board(entry("bob", "room"), entry("me", "room")))
        val later = AttendanceWidgetRules.snapshot(server, "Kano Lab", "me", board(entry("bob", "room"), entry("carol", "room")), null, 3_000L, known = first)
        assertEquals(listOf("Bob", ""), later.present.map { it.name })
        assertEquals("Me", later.meName)
    }

    @Test
    fun namedFacesFitTheWidthWithRoomForThePlus() {
        assertEquals(3, AttendanceWidgetRules.namedFacesThatFit(300f, 3))
        // 300 dp holds 5 places: 7 people show 4 faces and 「+3」.
        assertEquals(4, AttendanceWidgetRules.namedFacesThatFit(300f, 7))
        assertEquals(9, AttendanceWidgetRules.namedFacesThatFit(2000f, 30))
        assertEquals(0, AttendanceWidgetRules.namedFacesThatFit(10f, 5))
    }

    @Test
    fun theNameUnderAFaceIsTheFirstWordShortened() {
        assertEquals("佐藤", AttendanceWidgetRules.shortName("佐藤 花子"))
        assertEquals("Hana", AttendanceWidgetRules.shortName("Hana Sato"))
        assertEquals("android1", AttendanceWidgetRules.shortName("android1"))
        assertEquals("Christo…", AttendanceWidgetRules.shortName("Christopher"))
        assertEquals("ながいな…", AttendanceWidgetRules.shortName("ながいなまえのひと"))
        assertEquals("", AttendanceWidgetRules.shortName(""))
    }

    @Test
    fun anOlderSnapshotWithoutTheFacesStillReads() {
        val old = """{"serverUrl":"https://lab.example.com","workspaceName":"Kano Lab","meId":"me","enabled":true,"inRoomOthers":2}"""
        val s = AttendanceWidgetRules.decode(old)!!
        assertTrue(s.present.isEmpty())
        assertEquals("", s.meName)
        assertEquals(2, s.inRoomCount)
    }
}
