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
    fun onBoard(user: UserPublic): Boolean = user.deactivatedAt == null && (user.role == "admin" || user.role == "member")

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

    /** A state's name with its emoji (「🟢 在室」); a custom emoji keeps its `:name:` here (TalkBack, plain text). */
    fun stateText(state: AttendanceStateOut): String = state.emoji?.let { "$it ${state.label}" } ?: state.label

    /** The person's line under the name: the note and since when. */
    fun detail(entry: AttendanceEntryOut, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): String =
        listOfNotNull(entry.note?.takeIf { it.isNotBlank() }, sinceLabel(entry.since, now, zone).ifEmpty { null }).joinToString(" · ")
}
