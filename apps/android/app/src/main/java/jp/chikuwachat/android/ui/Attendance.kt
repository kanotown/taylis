package jp.chikuwachat.android.ui

import java.text.Collator
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneId
import jp.chikuwachat.android.L10n
import jp.chikuwachat.android.R
import jp.chikuwachat.android.api.AttendanceBoardOut
import jp.chikuwachat.android.api.AttendanceEntryOut
import jp.chikuwachat.android.api.AttendanceStateOut
import jp.chikuwachat.android.api.UserPublic

/**
 * M140 (docs/PRESENCE.md §7, §9): the pure parts of 「在室状況」, shared by the page, the chip and the tests (the web's
 * ui/attendance.ts).
 *
 * The board groups people by state, the states in kind order (in_room → on_site → off_site → gone), the workspace's
 * states before personal ones, then by position; people without a row are 「未設定」 at the end. 「在室 n 人」 counts the
 * in_room kind.
 */
object AttendanceRules {
    val KINDS = listOf("in_room", "on_site", "off_site", "gone")

    /** The text emoji palette's keys (apps/shared/text-emoji.json): the states' colours. */
    val COLORS: List<String> get() = SectionLetterIcon.COLORS.map { it.first }

    fun kindLabel(kind: String): String = when (kind) {
        "in_room" -> L10n.str(R.string.attendance_kind_in_room)
        "on_site" -> L10n.str(R.string.attendance_kind_on_site)
        "off_site" -> L10n.str(R.string.attendance_kind_off_site)
        "gone" -> L10n.str(R.string.attendance_kind_gone)
        else -> kind
    }

    /** Whether this app shows 「在室状況」 at all: the board is on, and I am not a guest (the server gives guests none). */
    fun shown(board: AttendanceBoardOut?, myRole: String?): Boolean = board != null && board.enabled && myRole != "guest"

    /** Who can be on the board: active people, not guests, not bots (the server's rule). */
    fun onBoard(user: UserPublic): Boolean = user.deactivatedAt == null && user.role in PERSON_ROLES

    /** M142: the roles of people (not guests, not bots); 「運営」 (manager) is one (docs/ROLES.md §1). */
    val PERSON_ROLES = setOf("admin", "manager", "member")

    /** The buttons for me: the workspace's states in their order, then mine (archived ones are never offered). */
    fun myChoices(board: AttendanceBoardOut, meId: String?): List<AttendanceStateOut> {
        val live = board.states.filter { !it.archived }
        return live.filter { it.ownerId == null }.sortedBy { it.position } +
            live.filter { meId != null && it.ownerId == meId }.sortedBy { it.position }
    }

    /** A state button: pressed (selected) when it is my current state. */
    data class Choice(val state: AttendanceStateOut, val selected: Boolean)

    fun choices(board: AttendanceBoardOut, meId: String?): List<Choice> {
        val mine = meId?.let { entryOf(board, it) }
        return myChoices(board, meId).map { Choice(it, it.id == mine?.stateId) }
    }

    /** What a press sends as the note: the current one when pressing my current state again, else none (a new state starts clean). */
    fun noteForPress(board: AttendanceBoardOut, meId: String?, stateId: String): String? {
        val mine = meId?.let { entryOf(board, it) } ?: return null
        return if (mine.stateId == stateId) mine.note else null
    }

    /** The note as it is sent: spaces folded, blank = none (the server's rule). */
    fun cleanNote(text: String): String? = text.trim().split(Regex("\\s+")).joinToString(" ").ifEmpty { null }

    /** My own personal states (the editor). */
    fun myOwnStates(board: AttendanceBoardOut, meId: String?): List<AttendanceStateOut> =
        board.states.filter { !it.archived && meId != null && it.ownerId == meId }.sortedBy { it.position }

    fun entryOf(board: AttendanceBoardOut?, userId: String): AttendanceEntryOut? = board?.entries?.firstOrNull { it.userId == userId }

    fun stateOf(board: AttendanceBoardOut?, stateId: String?): AttendanceStateOut? =
        stateId?.let { id -> board?.states?.firstOrNull { it.id == id } }

    /** attendance.updated: the person's row replaced (or added). */
    fun withEntry(board: AttendanceBoardOut, entry: AttendanceEntryOut): AttendanceBoardOut =
        board.copy(entries = board.entries.filter { it.userId != entry.userId } + entry)

    data class Person(val user: UserPublic, val entry: AttendanceEntryOut?)

    /** A group of the board: [state] null is 「未設定」. */
    data class Group(val state: AttendanceStateOut?, val people: List<Person>)

    private val stateOrder: Comparator<AttendanceStateOut> = compareBy<AttendanceStateOut>(
        { KINDS.indexOf(it.kind).let { k -> if (k < 0) KINDS.size else k } },
        { if (it.ownerId == null) 0 else 1 },
        { it.position },
    ).thenBy(Collator.getInstance(java.util.Locale.JAPANESE)) { it.label }

    /** The board's groups: states with people (in kind order), then 「未設定」. Empty states are left out. */
    fun groups(board: AttendanceBoardOut, users: Collection<UserPublic>): List<Group> {
        val collator = Collator.getInstance(java.util.Locale.JAPANESE)
        val people = users.filter(::onBoard).sortedWith(compareBy(collator) { it.displayName })
        val byUser = board.entries.associateBy { it.userId }
        val grouped = LinkedHashMap<String, MutableList<Person>>()
        val unset = mutableListOf<Person>()
        for (user in people) {
            val entry = byUser[user.id]
            val state = stateOf(board, entry?.stateId)
            if (entry == null || state == null) unset += Person(user, null)
            else grouped.getOrPut(state.id) { mutableListOf() } += Person(user, entry)
        }
        val ordered = grouped.map { (id, list) -> Group(stateOf(board, id)!!, list.sortedBy { instant(it.entry!!.since) ?: Instant.EPOCH }) }
            .sortedWith { a, b -> stateOrder.compare(a.state!!, b.state!!) }
        return if (unset.isEmpty()) ordered else ordered + Group(null, unset)
    }

    /** 「在室 n 人」: people on the board whose state is of the in_room kind. */
    fun inRoomCount(board: AttendanceBoardOut, users: Collection<UserPublic>): Int {
        val present = users.filter(::onBoard).map { it.id }.toSet()
        return board.entries.count { it.userId in present && stateOf(board, it.stateId)?.kind == "in_room" }
    }

    private fun instant(iso: String): Instant? =
        runCatching { Instant.parse(iso) }.getOrNull() ?: runCatching { OffsetDateTime.parse(iso).toInstant() }.getOrNull()

    /** 「9:15 から」 today, 「10/6 18:02 から」 earlier. */
    fun sinceLabel(since: String, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): String {
        val at = instant(since)?.atZone(zone) ?: return ""
        val time = "%d:%02d".format(at.hour, at.minute)
        val sameDay = at.toLocalDate() == now.atZone(zone).toLocalDate()
        return L10n.str(R.string.attendance_since, if (sameDay) time else "${at.monthValue}/${at.dayOfMonth} $time")
    }

    /**
     * A state as plain text: the name, with the emoji in front only when the state has no icon this app draws (「🟢 在室」;
     * a custom emoji keeps its `:name:`). Where a picture can be drawn, use StateBadge (AttendancePane.kt).
     */
    fun stateText(state: AttendanceStateOut): String =
        state.emoji?.takeIf { AttendanceIcons.vector(state.icon) == null }?.let { "$it ${state.label}" } ?: state.label

    /** My state now (null: none, or the board is off). */
    fun myState(board: AttendanceBoardOut?, meId: String?): AttendanceStateOut? =
        meId?.let { stateOf(board, entryOf(board, it)?.stateId) }

    /** A new state's icon until one is picked (§2.1): its kind's default. [picked] null = picked 「なし」. */
    fun formIcon(picked: String?, pickedYet: Boolean, kind: String): String? =
        if (pickedYet) picked else AttendanceIcons.DEFAULT_OF_KIND[kind]

    // --- the quick switch (§7.1, §9.1) ----------------------------------------------------------------

    /** The status chip in the home header and on 「自分」: while the board is on, signed in, never for a guest. */
    fun quickSwitchShown(board: AttendanceBoardOut?, myRole: String?, meId: String?): Boolean = meId != null && shown(board, myRole)

    /** The chip's TalkBack name: 「在室状況：学外」, or 「在室状況」 while I have none. */
    fun chipLabel(state: AttendanceStateOut?): String =
        state?.let { L10n.str(R.string.attendance_pill_label, it.label) } ?: L10n.str(R.string.attendance_pill_none)

    /** What a row of the sheet sends: the state, with my note kept only when it is my state already (as [noteForPress]). */
    data class Press(val stateId: String, val note: String?)

    fun sheetPress(board: AttendanceBoardOut, meId: String?, stateId: String): Press = Press(stateId, noteForPress(board, meId, stateId))

    /** The sheet's note saved: my current state with the cleaned note; null when there is no state or nothing changed. */
    fun sheetNote(board: AttendanceBoardOut, meId: String?, text: String): Press? {
        val mine = meId?.let { entryOf(board, it) } ?: return null
        val cleaned = cleanNote(text)
        return if (cleaned == mine.note) null else Press(mine.stateId, cleaned)
    }

    /** The chip's name: cut to [CHIP_CHARS] characters (Web's 8em), with 「…」. */
    fun chipText(label: String): String {
        if (label.codePointCount(0, label.length) <= CHIP_CHARS) return label
        return label.substring(0, label.offsetByCodePoints(0, CHIP_CHARS - 1)) + "…"
    }

    const val CHIP_CHARS = 8

    enum class ChipMode { FULL, ICON, HIDDEN }

    /** The workspace name keeps at least this many characters before the chip gives way (Web's NAME_MIN_EM). */
    const val NAME_MIN_CHARS = 4

    /**
     * How the chip fits beside the workspace name (dp): with its name while the whole name and the whole chip fit, else
     * only its icon (the name gives up its tail down to [NAME_MIN_CHARS] characters), else hidden (Web's pillMode).
     * [room] = the row's width minus everything but the name and the chip.
     */
    fun chipMode(room: Float, nameNatural: Float, nameMin: Float, full: Float, iconOnly: Float, gap: Float): ChipMode = when {
        room - nameNatural - gap >= full -> ChipMode.FULL
        room - minOf(nameNatural, nameMin) - gap >= iconOnly -> ChipMode.ICON
        else -> ChipMode.HIDDEN
    }

    /** The person's line under the name: the note and since when. */
    fun detail(entry: AttendanceEntryOut, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): String =
        listOfNotNull(entry.note?.takeIf { it.isNotBlank() }, sinceLabel(entry.since, now, zone).ifEmpty { null }).joinToString(" · ")
}
