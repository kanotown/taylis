package jp.chikuwachat.android

import jp.chikuwachat.android.widget.AttendanceWidgetRules
import jp.chikuwachat.android.widget.AttendanceWidgetSnapshot
import jp.chikuwachat.android.widget.TodayWidgetRules
import jp.chikuwachat.android.widget.TodayWidgetSnapshot
import jp.chikuwachat.android.widget.UnreadRow
import jp.chikuwachat.android.widget.UnreadWidgetRules
import jp.chikuwachat.android.widget.UnreadWidgetSnapshot
import jp.chikuwachat.android.widget.WidgetSnapshotKeys
import jp.chikuwachat.android.widget.WidgetWorkspaceRules
import jp.chikuwachat.android.widget.WidgetWorkspaceState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.ZoneId

/**
 * The home-screen widgets' workspaces: each widget's own choice (by appWidgetId) or the workspace on screen in the app,
 * the snapshots kept per workspace (and the migration of the one snapshot an older version kept), and what a workspace
 * that is not on screen gets from GET /sync/summary.
 */
class WidgetWorkspacesTest {
    private val a = "https://a.example.com"
    private val b = "https://b.example.com"

    // --- the choice per widget --------------------------------------------------------------------

    @Test
    fun aWidgetShowsItsChoiceElseTheWorkspaceOnScreen() {
        val state = WidgetWorkspaceState(current = a, choices = mapOf(7 to b))
        assertEquals(b, state.resolve(7))
        assertEquals(a, state.resolve(8)) // no choice: follows the app (every widget placed before the choice existed)
        assertNull(WidgetWorkspaceState().resolve(8)) // nothing signed in yet
        assertEquals(b, WidgetWorkspaceState(choices = mapOf(7 to b)).resolve(7))
    }

    @Test
    fun choosingFollowingAndRemovingWidgets() {
        var state = WidgetWorkspaceState(current = a)
        state = WidgetWorkspaceRules.choose(state, 7, b)
        state = WidgetWorkspaceRules.choose(state, 9, a)
        assertEquals(mapOf(7 to b, 9 to a), state.choices)
        state = WidgetWorkspaceRules.choose(state, 9, null) // back to 「アプリで開いているワークスペース」
        assertEquals(mapOf(7 to b), state.choices)
        state = WidgetWorkspaceRules.deleted(state, listOf(7, 42)) // onDeleted: the removed widget's choice goes
        assertTrue(state.choices.isEmpty())
        assertEquals(a, state.current)
    }

    @Test
    fun aWorkspaceThatLeftTheDeviceTakesItsChoicesWithIt() {
        val state = WidgetWorkspaceState(current = b, choices = mapOf(1 to a, 2 to b))
        val next = WidgetWorkspaceRules.registered(state, mapOf(a to "A lab"))
        assertEquals(mapOf(1 to a), next.choices)
        assertNull(next.current)
        assertEquals(mapOf(a to "A lab"), next.names)
        // Names change, nothing else.
        assertEquals(state.choices, WidgetWorkspaceRules.registered(state, mapOf(a to "A", b to "B")).choices)
    }

    @Test
    fun theWorkspacesShownAndThoseNeedingTheirOwnReads() {
        val state = WidgetWorkspaceState(current = a, choices = mapOf(1 to b, 2 to a))
        assertEquals(listOf(b, a), WidgetWorkspaceRules.shown(listOf(1, 2, 3), state))
        // Only a chosen workspace other than the one on screen needs the refresh worker.
        assertEquals(listOf(b), WidgetWorkspaceRules.elsewhere(listOf(1, 2, 3), state))
        assertTrue(WidgetWorkspaceRules.elsewhere(listOf(2, 3), state).isEmpty())
        assertTrue(WidgetWorkspaceRules.elsewhere(listOf(1), state.copy(current = b)).isEmpty())
    }

    @Test
    fun theStateIsSavedAndLoaded() {
        val state = WidgetWorkspaceState(current = a, choices = mapOf(5 to b, 12 to a), names = mapOf(a to "A", b to "B 研究室"))
        val saved = WidgetWorkspaceRules.save(state)
        assertEquals(state, WidgetWorkspaceRules.load(saved))
        // Unknown and broken keys are skipped.
        assertEquals(WidgetWorkspaceState(), WidgetWorkspaceRules.load(mapOf("choice.x" to a, "other" to "y", "current" to 3)))
    }

    // --- snapshots per workspace, and the migration ----------------------------------------------

    private fun unread(server: String, total: Int = 1) = UnreadWidgetSnapshot(server, "W", "me", mentions = total)

    private fun load(entries: Map<String, *>) = WidgetSnapshotKeys.load(entries, UnreadWidgetRules::decode) { it.serverUrl }

    @Test
    fun snapshotsAreKeptPerWorkspace() {
        val loaded = load(mapOf(WidgetSnapshotKeys.key(a) to UnreadWidgetRules.encode(unread(a)), WidgetSnapshotKeys.key(b) to UnreadWidgetRules.encode(unread(b, 4))))
        assertEquals(setOf(a, b), loaded.snapshots.keys)
        assertEquals(4, loaded.snapshots.getValue(b).total)
        assertNull(loaded.migrated)
        assertFalse(loaded.dropLegacy)
    }

    @Test
    fun theOneSnapshotOfAnOlderVersionMovesToItsWorkspace() {
        val loaded = load(mapOf(WidgetSnapshotKeys.LEGACY_KEY to UnreadWidgetRules.encode(unread(a, 3))))
        assertEquals(a, loaded.migrated) // and it becomes the workspace the following widgets show
        assertTrue(loaded.dropLegacy)
        assertEquals(3, loaded.snapshots.getValue(a).total)
    }

    @Test
    fun aWorkspacesOwnSnapshotWinsOverTheLegacyOne() {
        val loaded = load(mapOf(WidgetSnapshotKeys.LEGACY_KEY to UnreadWidgetRules.encode(unread(a, 3)), WidgetSnapshotKeys.key(a) to UnreadWidgetRules.encode(unread(a, 9))))
        assertEquals(9, loaded.snapshots.getValue(a).total)
        assertTrue(loaded.dropLegacy)
    }

    @Test
    fun unreadableTextIsLeftOut() {
        val loaded = load(mapOf(WidgetSnapshotKeys.LEGACY_KEY to "{broken", WidgetSnapshotKeys.key(a) to "nope", WidgetSnapshotKeys.key(b) to UnreadWidgetRules.encode(unread(a))))
        assertTrue(loaded.snapshots.isEmpty()) // b's key holding a's snapshot is not b's
        assertNull(loaded.migrated)
        assertTrue(loaded.dropLegacy)
    }

    @Test
    fun theMigrationWorksForEveryKind() {
        val attendance = AttendanceWidgetSnapshot(a, "W", "me", enabled = true, inRoomOthers = 2)
        val loadedAttendance = WidgetSnapshotKeys.load(mapOf(WidgetSnapshotKeys.LEGACY_KEY to AttendanceWidgetRules.encode(attendance)), AttendanceWidgetRules::decode) { it.serverUrl }
        assertEquals(attendance, loadedAttendance.snapshots[a])
        val today = TodayWidgetSnapshot(b, "W", "me", day = "2026-10-14")
        val loadedToday = WidgetSnapshotKeys.load(mapOf(WidgetSnapshotKeys.LEGACY_KEY to TodayWidgetRules.encode(today)), TodayWidgetRules::decode) { it.serverUrl }
        assertEquals(b, loadedToday.migrated)
        assertEquals(today, loadedToday.snapshots[b])
    }

    // --- a workspace that is not on screen: GET /sync/summary -------------------------------------

    private val rows = listOf(UnreadRow("c1", "#c1", 2, dm = false), UnreadRow("d1", "Bob", 3, dm = true, userId = "bob"))

    @Test
    fun aSummaryWithoutASnapshotGivesTheNumberAlone() {
        val s = UnreadWidgetRules.summarized(null, b, "B lab", "me", 5, 1_000L)
        assertEquals(5, s.total)
        assertEquals("B lab", s.workspaceName)
        assertTrue(s.rows.isEmpty())
        assertFalse(s.partsKnown) // 「@n・DM n」 is not drawn: the number does not say how it splits
    }

    @Test
    fun aSummaryOfZeroClearsTheRows() {
        val old = UnreadWidgetSnapshot(b, "B", "me", mentions = 2, dms = 3, rows = rows, conversations = 2)
        val s = UnreadWidgetRules.summarized(old, b, "B", "me", 0, 1_000L)
        assertEquals(0, s.total)
        assertTrue(s.rows.isEmpty())
        assertTrue(s.partsKnown)
    }

    @Test
    fun anotherNumberKeepsTheLastKnownRows() {
        val old = UnreadWidgetSnapshot(b, "B", "me", mentions = 2, dms = 3, rows = rows, conversations = 2)
        val s = UnreadWidgetRules.summarized(old, b, "B", "me", 7, 1_000L)
        assertEquals(7, s.total)
        assertEquals(rows, s.rows)
        assertFalse(s.partsKnown)
        // The same number as the app's count changes nothing (the same snapshot, no redraw).
        assertSame(old, UnreadWidgetRules.summarized(old, b, "B", "me", 5, 1_000L))
        assertTrue(old.partsKnown)
    }

    @Test
    fun anotherAccountsSnapshotIsNotKept() {
        val old = UnreadWidgetSnapshot(b, "B", "someone-else", mentions = 2, rows = rows, conversations = 1)
        val s = UnreadWidgetRules.summarized(old, b, "B", "me", 4, 1_000L)
        assertEquals("me", s.meId)
        assertTrue(s.rows.isEmpty())
    }

    // --- the 今日 widget over several workspaces ----------------------------------------------

    @Test
    fun theNextRedrawIsTheSoonestOfTheWorkspacesShown() {
        val zone = ZoneId.of("Asia/Tokyo")
        val now = Instant.parse("2026-10-14T01:00:00Z") // 10:00 in Tokyo
        val early = TodayWidgetSnapshot(a, "A", "me", "2026-10-14", events = listOf(event("e1", "2026-10-14T02:00:00Z")))
        val late = TodayWidgetSnapshot(b, "B", "me", "2026-10-14", events = listOf(event("e2", "2026-10-14T05:00:00Z")))
        val soonest = TodayWidgetRules.nextRefresh(listOf(late, early), now, zone)
        assertEquals(Instant.parse("2026-10-14T02:00:05Z"), soonest)
        // None held: midnight.
        assertEquals(Instant.parse("2026-10-14T15:00:05Z"), TodayWidgetRules.nextRefresh(emptyList(), now, zone))
    }

    private fun event(id: String, ends: String) = jp.chikuwachat.android.widget.TodayEvent(id, id, startsAt = "2026-10-14T00:30:00Z", endsAt = ends)

    @Test
    fun theWideListKeepsTheTasksNumberAtTheFootWhenItScrolls() {
        // 230 dp: room for about 5 lines.
        assertFalse(TodayWidgetRules.listOverflows(230f, events = 2, tasks = 1))
        assertTrue(TodayWidgetRules.listOverflows(230f, events = 5, tasks = 2))
        assertFalse(TodayWidgetRules.listOverflows(230f, events = 5, tasks = 0))
    }
}
