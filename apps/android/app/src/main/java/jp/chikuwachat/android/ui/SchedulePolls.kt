package jp.chikuwachat.android.ui

import jp.chikuwachat.android.api.PollAnswerIn
import jp.chikuwachat.android.api.PollOut
import jp.chikuwachat.android.api.ScheduleSlotIn
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZonedDateTime
import jp.chikuwachat.android.R
import jp.chikuwachat.android.L10n

/** One candidate in the form: a day, and its start and length (or the whole day). Times are the device's local time. */
data class SlotDraft(val day: LocalDate, val allDay: Boolean, val start: LocalTime = SchedulePolls.DEFAULT_START, val minutes: Int = SchedulePolls.DEFAULT_MINUTES)

/** How many said ○ / △ / × for one candidate. */
data class SlotCounts(val yes: Int, val maybe: Int, val no: Int)

/**
 * M54 (SCHEDULING.md, the desktop's ui/scheduling.ts): scheduling polls (日程調整): the form's candidates and their labels,
 * and the card's reading of the answers. The server keeps UTC instants (all-day candidates stay dates) and writes the
 * labels itself in the zone the form sends (`tz`), by the same rule as [slotLabel] here. Answers are "yes" (○), "maybe"
 * (△) and "no" (×); null is unanswered.
 */
object SchedulePolls {
    /** The server's limits (messages/schedule.py). */
    const val MIN_SLOTS = 2
    const val MAX_SLOTS = 20
    const val MIN_MINUTES = 15
    const val MAX_MINUTES = 12 * 60
    const val MAX_COMMENT = 100
    const val MAX_QUESTION = 200
    val DEFAULT_START: LocalTime = LocalTime.of(10, 0)
    const val DEFAULT_MINUTES = 60

    const val YES = "yes"
    const val MAYBE = "maybe"
    const val NO = "no"
    val ANSWERS = listOf(YES, MAYBE, NO)

    /** The lengths the form offers. */
    val DURATIONS = listOf(15, 30, 45, 60, 90, 120, 180, 240, 360)

    fun mark(answer: String?): String = when (answer) {
        YES -> "○"
        MAYBE -> "△"
        NO -> "×"
        else -> "-"
    }

    fun answerName(answer: String?): String = when (answer) {
        YES -> L10n.str(R.string.schedule_polls_can_attend)
        MAYBE -> L10n.str(R.string.schedule_polls_maybe)
        NO -> L10n.str(R.string.schedule_polls_cant_attend)
        else -> L10n.str(R.string.schedule_polls_no_answer)
    }

    /** 「30 分」「1 時間」「1 時間半」「2 時間 15 分」. */
    fun durationLabel(minutes: Int): String {
        val hours = minutes / 60
        val rest = minutes % 60
        return when {
            hours == 0 -> L10n.str(R.string.schedule_polls_min, rest)
            rest == 0 -> L10n.str(R.string.common_h, hours)
            rest == 30 -> L10n.str(R.string.schedule_polls_5_h, hours)
            else -> L10n.str(R.string.schedule_polls_h_min, hours, rest)
        }
    }

    /** The length choices, with a length the candidate already has (from `/日程 … 13:00-14:20`) kept in the list. */
    fun lengthChoices(current: Int): List<Int> = if (current in DURATIONS) DURATIONS else (DURATIONS + current).sorted()

    private fun startOf(slot: SlotDraft, zone: ZoneId): ZonedDateTime = ZonedDateTime.of(slot.day, slot.start, zone)

    private fun endOf(slot: SlotDraft, zone: ZoneId): ZonedDateTime = startOf(slot, zone).plusMinutes(slot.minutes.toLong())

    private fun clock(at: ZonedDateTime): String = "${at.hour}:${at.minute.toString().padStart(2, '0')}"

    /** 「10/3 (土)」. */
    fun shortDay(day: LocalDate): String = "${day.monthValue}/${day.dayOfMonth} (${CalendarDates.weekdayLabel(CalendarDates.weekdayIndex(day))})"

    /** 「10/3 (土) 14:00〜15:00」, 「10/5 (月) 終日」, past midnight 「22:00〜24:00」 / 「23:00〜翌1:30」 (the server's rule). */
    fun slotLabel(slot: SlotDraft, zone: ZoneId = CalendarDates.zone()): String {
        if (slot.allDay) return L10n.str(R.string.common_all_day_2, shortDay(slot.day))
        val start = startOf(slot, zone)
        val end = endOf(slot, zone)
        val endDay = end.toLocalDate()
        val until = when {
            endDay == slot.day -> clock(end)
            endDay == slot.day.plusDays(1) && end.hour == 0 && end.minute == 0 -> "24:00"
            else -> L10n.str(R.string.schedule_polls_next_day) + clock(end)
        }
        return L10n.str(R.string.schedule_polls_fmt, shortDay(slot.day), clock(start), until)
    }

    /** Earliest first; a day's all-day candidate before its times. */
    fun sortSlots(slots: List<SlotDraft>): List<SlotDraft> =
        slots.sortedWith(compareBy<SlotDraft>({ it.day }, { !it.allDay }, { if (it.allDay) LocalTime.MIDNIGHT else it.start }, { it.minutes }))

    private fun slotKey(slot: SlotDraft, zone: ZoneId): String =
        if (slot.allDay) "d:${slot.day}" else "t:${startOf(slot, zone).toInstant().toEpochMilli()}:${slot.minutes}"

    /** What stops the form from being sent (the server's rules, said first here), or null. */
    fun problem(question: String, slots: List<SlotDraft>, zone: ZoneId = CalendarDates.zone()): String? {
        if (question.isBlank()) return L10n.str(R.string.common_enter_a_title)
        if (question.trim().length > MAX_QUESTION) return L10n.str(R.string.common_the_title_can_be_up_to, MAX_QUESTION)
        if (slots.size < MIN_SLOTS) return L10n.str(R.string.schedule_polls_choose_at_least_candidates, MIN_SLOTS)
        if (slots.size > MAX_SLOTS) return L10n.str(R.string.schedule_polls_up_to_candidates, MAX_SLOTS)
        if (slots.any { !it.allDay && (it.minutes < MIN_MINUTES || it.minutes > MAX_MINUTES) }) return L10n.str(R.string.schedule_polls_the_length_must_be_between_15)
        if (slots.map { slotKey(it, zone) }.toSet().size != slots.size) return L10n.str(R.string.schedule_polls_some_candidates_are_the_same)
        return null
    }

    /** POST …/messages `poll.slots`: local times become UTC instants; all-day candidates stay dates. */
    fun slotToIn(slot: SlotDraft, zone: ZoneId = CalendarDates.zone()): ScheduleSlotIn =
        if (slot.allDay) ScheduleSlotIn(date = slot.day.toString())
        else ScheduleSlotIn(startsAt = startOf(slot, zone).toInstant().toString(), endsAt = endOf(slot, zone).toInstant().toString())

    /** `/日程 ゼミ 10/3 10/5 13:00-14:30` ([Templates.readSchedule]) → candidates: a time without an end lasts an hour. */
    fun slotsFromEntries(entries: List<Templates.ScheduleEntry>, zone: ZoneId = CalendarDates.zone()): List<SlotDraft> {
        val seen = HashSet<String>()
        val slots = ArrayList<SlotDraft>()
        for (entry in entries) {
            val from = entry.from
            val slot = if (from == null) SlotDraft(entry.day, allDay = true)
            else SlotDraft(
                entry.day, allDay = false, start = LocalTime.of(from / 60, from % 60),
                minutes = ((entry.to ?: (from + DEFAULT_MINUTES)) - from).coerceIn(MIN_MINUTES, MAX_MINUTES),
            )
            if (seen.add(slotKey(slot, zone))) slots += slot
        }
        return sortSlots(slots)
    }

    // --- the form's edits ---------------------------------------------------------------------------

    /** A day picked on the calendar: its candidate (the form's time, or the whole day) goes in; picked again, all of that day's go. */
    fun toggleDay(slots: List<SlotDraft>, day: LocalDate, allDay: Boolean, start: LocalTime, minutes: Int): List<SlotDraft> =
        if (slots.any { it.day == day }) slots.filter { it.day != day } else sortSlots(slots + SlotDraft(day, allDay, start, minutes))

    /** The time chosen above goes to every candidate; several times on one day become one when they turn all-day. */
    fun applyToAll(slots: List<SlotDraft>, allDay: Boolean, start: LocalTime, minutes: Int): List<SlotDraft> {
        val seen = HashSet<String>()
        return sortSlots(
            slots.map { it.copy(allDay = allDay, start = start, minutes = minutes) }
                .filter { seen.add(if (it.allDay) "${it.day}" else "${it.day} ${it.start} ${it.minutes}") },
        )
    }

    /** Another time on the same day, right after this one (10:00 when that would pass midnight). */
    fun addAfter(slots: List<SlotDraft>, index: Int, zone: ZoneId = CalendarDates.zone()): List<SlotDraft> {
        val slot = slots.getOrNull(index) ?: return slots
        val end = endOf(slot, zone).toLocalTime()
        val next = if (end.isAfter(slot.start)) slot.copy(start = end) else slot.copy(start = DEFAULT_START)
        return sortSlots(slots + next)
    }

    /** The slots across a rotation: "day|allDay|HH:MM|minutes". */
    fun encode(slot: SlotDraft): String = "${slot.day}|${slot.allDay}|${slot.start}|${slot.minutes}"

    fun decode(text: String): SlotDraft? = runCatching {
        val (day, allDay, start, minutes) = text.split("|")
        SlotDraft(LocalDate.parse(day), allDay.toBoolean(), LocalTime.parse(start), minutes.toInt())
    }.getOrNull()

    // --- the card -------------------------------------------------------------------------------------

    fun counts(poll: PollOut): List<SlotCounts> = poll.options.indices.map { index ->
        val answers = poll.answers.getOrNull(index)
        SlotCounts(answers?.yesCount ?: 0, answers?.maybeCount ?: 0, answers?.noCount ?: 0)
    }

    /** What `userId` answered for a candidate in a named poll (the lists), or null. */
    fun answerOf(poll: PollOut, userId: String, index: Int): String? {
        val answers = poll.answers.getOrNull(index) ?: return null
        return when (userId) {
            in answers.yes -> YES
            in answers.maybe -> MAYBE
            in answers.no -> NO
            else -> null
        }
    }

    /**
     * My answer per candidate (null = unanswered). A named poll's answers come with every change, events too, so they are
     * read from the lists (always current); an anonymous poll lists nobody, and `my_answers` (responses to me only, kept by
     * the store across events) is all there is.
     */
    fun myAnswers(poll: PollOut, meId: String?): List<String?> =
        if (!poll.anonymous) poll.options.indices.map { index -> meId?.let { answerOf(poll, it, index) } }
        else poll.options.indices.map { index -> poll.myAnswers?.getOrNull(index) }

    /** My comment ("" = none), by the same rule as [myAnswers]. */
    fun myComment(poll: PollOut, meId: String?): String =
        if (!poll.anonymous) meId?.let { me -> poll.comments.firstOrNull { it.userId == me }?.text } ?: ""
        else poll.myComment ?: ""

    /** My answers after pressing `answer` on candidate `index`: pressing the answer I already gave takes it back. */
    fun pressAnswer(current: List<String?>, index: Int, answer: String): List<String?> =
        current.mapIndexed { i, value -> if (i == index) (if (value == answer) null else answer) else value }

    /** The table's cell: ○ → △ → × → unanswered → ○. */
    fun nextAnswer(current: String?): String? = when (current) {
        null -> YES
        YES -> MAYBE
        MAYBE -> NO
        else -> null
    }

    /** PUT …/poll/answers `answers`: the answered candidates only. */
    fun answersBody(answers: List<String?>): List<PollAnswerIn> =
        answers.mapIndexedNotNull { index, answer -> answer?.let { PollAnswerIn(index, it) } }

    /** The candidates with the most ○ (none when nobody said ○ yet). */
    fun bestSlots(poll: PollOut): List<Int> {
        val yes = counts(poll).map { it.yes }
        val top = yes.maxOrNull() ?: 0
        if (top == 0) return emptyList()
        return yes.indices.filter { yes[it] == top }
    }

    /** How many people answered (named: the respondents; anonymous: the most answers any candidate got). */
    fun respondentCount(poll: PollOut): Int =
        if (!poll.anonymous) poll.respondents.size else counts(poll).maxOfOrNull { it.yes + it.maybe + it.no } ?: 0

    /** Who may decide (SCHEDULING.md §1): the poll's author, the channel's owners, administrators. */
    fun canDecide(meId: String?, senderId: String, isAdmin: Boolean, channelRole: String?): Boolean =
        meId != null && (senderId == meId || isAdmin || channelRole == "owner")

    /** The footer: 「3 人が回答」, after the decision or the close 「決定済み · …」 / 「締め切りました · …」. */
    fun footer(poll: PollOut): String {
        val count = L10n.str(R.string.schedule_polls_answered, respondentCount(poll))
        return when {
            poll.decided != null -> L10n.str(R.string.schedule_polls_decided, count)
            poll.closedAt != null -> L10n.str(R.string.schedule_polls_closed, count)
            else -> count
        }
    }
}
