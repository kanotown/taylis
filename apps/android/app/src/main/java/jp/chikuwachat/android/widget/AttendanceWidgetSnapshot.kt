package jp.chikuwachat.android.widget

import jp.chikuwachat.android.api.AttendanceBoardOut
import jp.chikuwachat.android.api.AttendanceStateOut
import jp.chikuwachat.android.api.UserPublic
import jp.chikuwachat.android.ui.AttendanceRules
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * The 在室状況 home-screen widget's data (docs/PRESENCE.md §1–§9): a small snapshot the app writes for the workspace on
 * screen (after the bootstrap, attendance.updated / GET /attendance, my own change in the app or from the widget) and the
 * widget draws. The widget never reads the server itself; its buttons run in the app process ([AttendanceWidgetWorker]).
 *
 * [states]: my buttons ([AttendanceRules.myChoices]: the workspace's states in order, then my own). [myState]: my
 * confirmed state (it may be archived, so not among [states]). [pendingStateId]: a widget press not answered yet (drawn
 * as the state at once, the optimistic update). [failed]: the last press could not reach the server: the last known
 * state stays, with 「更新できません」.
 */
@Serializable
data class AttendanceWidgetSnapshot(
    val serverUrl: String,
    val workspaceName: String,
    val meId: String,
    /** False while the board is off (or I am a guest): the widget says so and offers no buttons. */
    val enabled: Boolean,
    val states: List<WidgetState> = emptyList(),
    val myState: WidgetState? = null,
    val myNote: String? = null,
    /** People in an in_room state other than me (the board's rule, [AttendanceRules.inRoomCount]). */
    val inRoomOthers: Int = 0,
    /** Whether I count myself (I am one of the board's people: active, not a guest, not a bot). */
    val meCounted: Boolean = true,
    /** When the app wrote this (epoch ms). */
    val updatedAt: Long = 0,
    val pendingStateId: String? = null,
    val pendingAt: Long = 0,
    val failed: Boolean = false,
) {
    /** What the widget shows as my state: the press waiting for its answer, else the confirmed one. */
    val shownState: WidgetState? get() = pendingStateId?.let { id -> states.firstOrNull { it.id == id } } ?: myState

    /** 「在室 n 人」 as the app counts it, with my shown state. */
    val inRoomCount: Int get() = inRoomOthers + if (meCounted && shownState?.kind == "in_room") 1 else 0
}

/** One state as the widget draws it (a copy of [AttendanceStateOut]'s visible parts). */
@Serializable
data class WidgetState(
    val id: String,
    val label: String,
    val icon: String? = null,
    val emoji: String? = null,
    val color: String = "gray",
    val kind: String,
    /** One of my own states (「（自分用）」). */
    val personal: Boolean = false,
) {
    companion object {
        fun of(state: AttendanceStateOut) = WidgetState(state.id, state.label, state.icon, state.emoji, state.color, state.kind, state.ownerId != null)
    }
}

/** One button: [selected] when it is the state shown as mine. */
data class WidgetButton(val state: WidgetState, val selected: Boolean)

/** What a widget press sends to PUT /attendance/me (the app's own one-tap rule, [AttendanceRules.noteForPress]). */
data class WidgetPress(val stateId: String, val note: String?)

object AttendanceWidgetRules {
    /** A press that has had no answer for this long is no longer drawn (the app's next snapshot wins). */
    const val PENDING_TTL_MS = 60_000L

    /** At most this many state buttons on the wide layout. */
    const val MAX_WIDE_BUTTONS = 6

    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
        explicitNulls = false
    }

    fun encode(snapshot: AttendanceWidgetSnapshot): String = json.encodeToString(AttendanceWidgetSnapshot.serializer(), snapshot)

    /** Null for nothing saved or text this version cannot read (the widget then asks to open the app). */
    fun decode(text: String?): AttendanceWidgetSnapshot? =
        text?.takeIf { it.isNotBlank() }?.let { runCatching { json.decodeFromString(AttendanceWidgetSnapshot.serializer(), it) }.getOrNull() }

    /**
     * The snapshot of a workspace's board for me. [board] null: off, or I am a guest (the Store keeps none then).
     * [users]: the people this device knows (the app's count rule, [AttendanceRules.onBoard]); null when they are not at
     * hand (a widget press while the workspace is not loaded): the server's board lists only its people's rows already.
     */
    fun snapshot(
        serverUrl: String, workspaceName: String, meId: String, board: AttendanceBoardOut?, users: Collection<UserPublic>?, now: Long,
    ): AttendanceWidgetSnapshot {
        if (board == null || !board.enabled) return AttendanceWidgetSnapshot(serverUrl, workspaceName, meId, enabled = false, updatedAt = now)
        val people = users?.filter(AttendanceRules::onBoard)?.map { it.id }?.toSet()
        val others = board.entries.count { entry ->
            entry.userId != meId && (people == null || entry.userId in people) && AttendanceRules.stateOf(board, entry.stateId)?.kind == "in_room"
        }
        val mine = AttendanceRules.entryOf(board, meId)
        return AttendanceWidgetSnapshot(
            serverUrl = serverUrl,
            workspaceName = workspaceName,
            meId = meId,
            enabled = true,
            states = AttendanceRules.myChoices(board, meId).map(WidgetState::of),
            myState = AttendanceRules.stateOf(board, mine?.stateId)?.let(WidgetState::of),
            myNote = mine?.note,
            inRoomOthers = others,
            meCounted = people == null || meId in people,
            updatedAt = now,
        )
    }

    /** Two snapshots that draw the same widget (the time written aside). */
    fun same(a: AttendanceWidgetSnapshot?, b: AttendanceWidgetSnapshot?): Boolean = a?.copy(updatedAt = 0) == b?.copy(updatedAt = 0)

    /**
     * A new snapshot from the app replaces the saved one, except that a widget press still waiting for its answer (same
     * workspace and person, younger than [PENDING_TTL_MS]) stays drawn until the press itself finishes.
     */
    fun merge(old: AttendanceWidgetSnapshot?, new: AttendanceWidgetSnapshot, now: Long): AttendanceWidgetSnapshot {
        if (old?.pendingStateId == null || old.serverUrl != new.serverUrl || old.meId != new.meId) return new
        if (now - old.pendingAt >= PENDING_TTL_MS || new.states.none { it.id == old.pendingStateId }) return new
        return new.copy(pendingStateId = old.pendingStateId, pendingAt = old.pendingAt)
    }

    /** The optimistic update of a press: drawn as my state at once, 「更新できません」 cleared. Null: not a button of mine. */
    fun pressed(snapshot: AttendanceWidgetSnapshot, stateId: String, now: Long): AttendanceWidgetSnapshot? {
        if (!snapshot.enabled || snapshot.states.none { it.id == stateId }) return null
        return snapshot.copy(pendingStateId = stateId, pendingAt = now, failed = false)
    }

    /** The press failed: the last confirmed state, with 「更新できません」. */
    fun failed(snapshot: AttendanceWidgetSnapshot): AttendanceWidgetSnapshot = snapshot.copy(pendingStateId = null, pendingAt = 0, failed = true)

    /**
     * The press of [stateId] was answered with [fresh] (the board after the change). A newer press made meanwhile (two
     * quick taps) stays drawn until its own answer, so the widget does not flick back to the first one.
     */
    fun answered(old: AttendanceWidgetSnapshot?, fresh: AttendanceWidgetSnapshot, stateId: String, now: Long): AttendanceWidgetSnapshot =
        if (old?.pendingStateId != null && old.pendingStateId != stateId) merge(old, fresh, now) else fresh

    /** The press of [stateId] failed; a newer press waiting for its answer is left alone. */
    fun failedPress(old: AttendanceWidgetSnapshot?, stateId: String): AttendanceWidgetSnapshot? = when {
        old == null -> null
        old.pendingStateId != null && old.pendingStateId != stateId -> old
        else -> failed(old)
    }

    /** What a press sends: the state, my note kept only when it is my state already (a new state starts clean, as in the app). */
    fun press(board: AttendanceBoardOut, meId: String, stateId: String): WidgetPress =
        WidgetPress(stateId, AttendanceRules.noteForPress(board, meId, stateId))

    // --- the buttons -------------------------------------------------------------------------------

    /**
     * The compact layout's one button: a toggle between arriving and leaving, the two changes made every day. While my
     * shown state is of the in_room kind it offers the first gone state (帰宅), otherwise the first in_room state (在室);
     * when the workspace has no state of that kind, none. The workspace's states come before my own ([states]' order).
     */
    fun toggle(snapshot: AttendanceWidgetSnapshot): WidgetButton? {
        if (!snapshot.enabled) return null
        val target = if (snapshot.shownState?.kind == "in_room") "gone" else "in_room"
        return snapshot.states.firstOrNull { it.kind == target }?.let { WidgetButton(it, selected = false) }
    }

    /**
     * The wide layout's buttons: all my states when [max] of them fit; otherwise the first state of each kind (so
     * 在室・学内・学外・帰宅 are offered; with fewer places arriving and leaving first: in_room, gone, on_site, off_site),
     * then the next ones in order, shown in the app's order. My shown state is the selected one.
     */
    fun wideButtons(snapshot: AttendanceWidgetSnapshot, max: Int): List<WidgetButton> {
        if (!snapshot.enabled || max <= 0) return emptyList()
        val all = snapshot.states
        val chosen: List<WidgetState> = if (all.size <= max) all else {
            val picked = LinkedHashSet<String>()
            KIND_PRIORITY.forEach { kind -> all.firstOrNull { it.kind == kind }?.let { if (picked.size < max) picked += it.id } }
            all.forEach { if (picked.size < max) picked += it.id }
            all.filter { it.id in picked }
        }
        val shown = snapshot.shownState?.id
        return chosen.map { WidgetButton(it, it.id == shown) }
    }

    private val KIND_PRIORITY = listOf("in_room", "gone", "on_site", "off_site")

    /**
     * How many state buttons fit across a wide widget [widthDp] wide: [tall] = a row of buttons with their names under
     * the icons below my state; short = round icon buttons beside my state (about 120 dp).
     */
    fun wideButtonCount(widthDp: Float, tall: Boolean): Int {
        val room = if (tall) widthDp - 16f else widthDp - 16f - 120f
        val each = if (tall) 60f else 44f
        return (room / each).toInt().coerceIn(1, MAX_WIDE_BUTTONS)
    }
}
