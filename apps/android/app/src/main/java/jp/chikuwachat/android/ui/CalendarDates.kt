package jp.chikuwachat.android.ui

import jp.chikuwachat.android.api.CalendarEventCreate
import jp.chikuwachat.android.api.CalendarEventOut
import jp.chikuwachat.android.api.CalendarEventUpdate
import jp.chikuwachat.android.api.ChannelOut
import jp.chikuwachat.android.sync.ChannelState
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import java.text.Collator
import java.time.Duration
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import java.util.Locale

/** M52: the calendar's two phone views (CALENDAR.md §7): the agenda from today and the month with dots. */
enum class CalendarMode(val label: String) {
    LIST("一覧"),
    MONTH("月"),
}

/**
 * M52 (CALENDAR.md §7): the calendar's date math in the device's zone, as the desktop's ui/calendarDates.ts. Weeks start
 * on Sunday (日曜始まり, as Japanese wall calendars do). A timed event covers the local days from its start to the instant
 * before its end; an all-day one its dates (the end included), whatever the zone. The zone is read each time (the tests
 * set it), so nothing here keeps one.
 */
object CalendarDates {
    /** How far ahead the agenda and a channel's 「予定」 tab read. */
    const val LIST_DAYS = 60L
    /** The longest events (the server refuses longer ones: 400 calendar_event_too_long). */
    const val MAX_TIMED_DAYS = 14L
    const val MAX_ALL_DAY_DAYS = 60L
    const val MAX_TITLE = 200
    const val MAX_LOCATION = 200
    const val MAX_DESCRIPTION = 4000
    /** Today and tomorrow (the 「予定 N」 count on a channel's tab). */
    const val UPCOMING_DAYS = 2

    private val WEEKDAYS = listOf("日", "月", "火", "水", "木", "金", "土")
    private val OFFSET_FORMAT: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ssxxx")
    private val collator: Collator = Collator.getInstance(Locale.JAPANESE)

    fun zone(): ZoneId = ZoneId.systemDefault()

    fun today(now: ZonedDateTime = ZonedDateTime.now(zone())): LocalDate = now.withZoneSameInstant(zone()).toLocalDate()

    /** An instant from the server ("…Z" or with an offset). */
    fun instant(iso: String): Instant = runCatching { OffsetDateTime.parse(iso).toInstant() }.getOrElse { Instant.parse(iso) }

    fun local(iso: String): ZonedDateTime = instant(iso).atZone(zone())

    fun localDay(iso: String): LocalDate = local(iso).toLocalDate()

    /** 0 = Sunday … 6 = Saturday. */
    fun weekdayIndex(day: LocalDate): Int = day.dayOfWeek.value % 7

    /** The Sunday on or before the day. */
    fun weekStart(day: LocalDate): LocalDate = day.minusDays(weekdayIndex(day).toLong())

    /** The 1st of the month `months` away. */
    fun addMonths(day: LocalDate, months: Long): LocalDate = day.withDayOfMonth(1).plusMonths(months)

    /** The weeks (Sunday first) that hold the month of `day`: 4 to 6 rows of 7 days. */
    fun monthGrid(day: LocalDate): List<List<LocalDate>> {
        val first = day.withDayOfMonth(1)
        val last = first.plusMonths(1).minusDays(1)
        val weeks = ArrayList<List<LocalDate>>()
        var start = weekStart(first)
        while (!start.isAfter(last)) {
            weeks += (0L until 7L).map { start.plusDays(it) }
            start = start.plusDays(7)
        }
        return weeks
    }

    /** The days a mode shows around `anchor`: [start, end) (end excluded). The list starts at `anchor` itself. */
    fun rangeFor(mode: CalendarMode, anchor: LocalDate): Pair<LocalDate, LocalDate> = when (mode) {
        CalendarMode.MONTH -> monthGrid(anchor).let { weeks -> weeks.first().first() to weeks.last().last().plusDays(1) }
        CalendarMode.LIST -> anchor to anchor.plusDays(LIST_DAYS)
    }

    /** An instant with the device's offset ("2026-10-01T00:00:00+09:00"): the server reads all-day dates in it. */
    fun isoLocal(at: ZonedDateTime): String = at.withZoneSameInstant(zone()).format(OFFSET_FORMAT)

    /** GET /calendar/events's `from` / `to` for the days [start, end): local midnights. */
    fun rangeParams(start: LocalDate, end: LocalDate): Pair<String, String> =
        isoLocal(start.atStartOfDay(zone())) to isoLocal(end.atStartOfDay(zone()))

    /** The first and last local day an event covers. */
    fun eventDays(event: CalendarEventOut): Pair<LocalDate, LocalDate> {
        if (event.allDay) {
            val first = LocalDate.parse(event.startDate)
            return first to (event.endDate?.let { LocalDate.parse(it) } ?: first)
        }
        val start = instant(event.startsAt!!)
        val end = instant(event.endsAt!!).minusMillis(1)
        val first = start.atZone(zone()).toLocalDate()
        return first to if (end.isBefore(start)) first else end.atZone(zone()).toLocalDate()
    }

    fun coversDay(event: CalendarEventOut, day: LocalDate): Boolean {
        val (first, last) = eventDays(event)
        return !day.isBefore(first) && !day.isAfter(last)
    }

    /**
     * The server's overlap rule (CALENDAR.md §4) for [from, to), both instants with an offset: timed events by instant,
     * all-day ones by the local dates of `from` and of the instant before `to`.
     */
    fun overlapsRange(event: CalendarEventOut, from: String, to: String): Boolean {
        val start = instant(from)
        val end = instant(to)
        if (!event.allDay) return instant(event.startsAt!!).isBefore(end) && instant(event.endsAt!!).isAfter(start)
        val first = start.atZone(zone()).toLocalDate()
        val last = end.minusMillis(1).atZone(zone()).toLocalDate()
        val (eventFirst, eventLast) = eventDays(event)
        return !eventFirst.isAfter(last) && !eventLast.isBefore(first)
    }

    private fun sortKey(event: CalendarEventOut): String =
        if (event.allDay) "${event.startDate}T" else local(event.startsAt!!).let { "${it.toLocalDate()}T${hhmm(it)}" }

    private fun pad(n: Int): String = n.toString().padStart(2, '0')

    private fun hhmm(at: ZonedDateTime): String = "${pad(at.hour)}:${pad(at.minute)}"

    /** Earliest first; on a day, all-day events before timed ones; then by title. */
    val eventOrder: Comparator<CalendarEventOut> = Comparator { a, b ->
        val byTime = sortKey(a).compareTo(sortKey(b))
        if (byTime != 0) byTime else collator.compare(a.title, b.title)
    }

    /** The events on a day, in order: all-day ones and those that began earlier first. */
    fun eventsOn(events: Iterable<CalendarEventOut>, day: LocalDate): List<CalendarEventOut> {
        fun rank(event: CalendarEventOut) = if (event.allDay || eventDays(event).first.isBefore(day)) 0 else 1
        return events.filter { coversDay(it, day) }.sortedWith(compareBy<CalendarEventOut> { rank(it) }.then(eventOrder))
    }

    /** The days with events in [start, end), each with its events in order (the agenda). */
    fun agenda(events: List<CalendarEventOut>, start: LocalDate, end: LocalDate): List<Pair<LocalDate, List<CalendarEventOut>>> {
        val out = ArrayList<Pair<LocalDate, List<CalendarEventOut>>>()
        var day = start
        while (day.isBefore(end)) {
            val list = eventsOn(events, day)
            if (list.isNotEmpty()) out += day to list
            day = day.plusDays(1)
        }
        return out
    }

    /** The days of [start, end) that hold an event (the month's dots). */
    fun busyDays(events: List<CalendarEventOut>, start: LocalDate, end: LocalDate): Set<LocalDate> {
        val out = HashSet<LocalDate>()
        events.forEach { event ->
            val (first, last) = eventDays(event)
            var day = if (first.isBefore(start)) start else first
            while (!day.isAfter(last) && day.isBefore(end)) {
                out += day
                day = day.plusDays(1)
            }
        }
        return out
    }

    /** "14:00" in local time. */
    fun clock(iso: String): String = local(iso).let { "${it.hour}:${pad(it.minute)}" }

    /** "14:00" for the form's time buttons. */
    fun clock(time: LocalTime): String = "${time.hour}:${pad(time.minute)}"

    /** "10月1日 (木)". */
    fun dayLabel(day: LocalDate): String = "${day.monthValue}月${day.dayOfMonth}日 (${WEEKDAYS[weekdayIndex(day)]})"

    fun weekdayLabel(index: Int): String = WEEKDAYS[index]

    fun monthLabel(day: LocalDate): String = "${day.year}年${day.monthValue}月"

    /** The header of a mode's range: 「2026年10月」, 「10月1日 (木) から」. */
    fun rangeTitle(mode: CalendarMode, anchor: LocalDate): String = when (mode) {
        CalendarMode.MONTH -> monthLabel(anchor)
        CalendarMode.LIST -> "${dayLabel(anchor)} から"
    }

    /** What a row says of the time on `day`: 「終日」, 「14:00〜15:30」, 「〜15:30」 (began earlier), 「14:00〜」 (ends later). */
    fun timeOnDay(event: CalendarEventOut, day: LocalDate): String {
        if (event.allDay) return "終日"
        val (first, last) = eventDays(event)
        val start = if (first == day) clock(event.startsAt!!) else ""
        val end = if (last == day) clock(event.endsAt!!) else ""
        if (start.isEmpty() && end.isEmpty()) return "終日"
        return "$start〜$end"
    }

    /** The whole time of an event: 「10月1日 (木) 14:00〜15:00」, 「10月1日 (木)〜10月3日 (土) 終日」. */
    fun eventWhen(event: CalendarEventOut): String {
        val (first, last) = eventDays(event)
        if (event.allDay) return if (first == last) "${dayLabel(first)} 終日" else "${dayLabel(first)}〜${dayLabel(last)} 終日"
        val startDay = localDay(event.startsAt!!)
        val endDay = localDay(event.endsAt!!)
        val start = "${dayLabel(startDay)} ${clock(event.startsAt)}"
        val end = if (endDay == startDay) clock(event.endsAt) else "${dayLabel(endDay)} ${clock(event.endsAt)}"
        return "$start〜$end"
    }

    /** What an alarm says when it fires while the app is open, as the server's push does (PUSH_NOTIFICATIONS.md). */
    fun alarmText(event: CalendarEventOut): String {
        val whenText = if (event.allDay) "終日" else clock(event.startsAt!!)
        return "$whenText ${event.title}" + (event.channelName?.let { " (#$it)" } ?: "")
    }

    /**
     * Review v0.1.22 #9 (CALENDAR.md §10.11): the line for a fired alarm whose occurrence may not be known here. Known: as
     * [alarmText] (its channel's name, else `channelName`). Unknown (null): 「予定の通知があります (#ch)」 (my own calendar:
     * no channel), never another occurrence's title or time.
     */
    fun alarmText(event: CalendarEventOut?, channelName: String?): String {
        if (event == null) return "予定の通知があります" + (channelName?.let { " (#$it)" } ?: "")
        return alarmText(if (event.channelName == null && channelName != null) event.copy(channelName = channelName) else event)
    }

    // --- colours ---------------------------------------------------------------------------------

    /** One fixed colour per channel (from its id, the same on every device); my own calendar is slate. ARGB. */
    val PALETTE: List<Long> = listOf(0xFF2563EB, 0xFF16A34A, 0xFFDC2626, 0xFF9333EA, 0xFF0891B2, 0xFFDB2777, 0xFFEA580C, 0xFFA16207, 0xFF4F46E5)
    const val OWN_COLOR: Long = 0xFF64748B

    /** FNV-1a of the id's UTF-16 units (JavaScript's charCodeAt), as the desktop computes it. */
    fun channelColor(channelId: String?): Long {
        if (channelId == null) return OWN_COLOR
        var hash = 0x811c9dc5L
        for (unit in channelId) {
            hash = hash xor unit.code.toLong()
            hash = (hash * 0x01000193L) and 0xFFFFFFFFL
        }
        return PALETTE[(hash % PALETTE.size).toInt()]
    }

    // --- alarms ----------------------------------------------------------------------------------

    data class AlarmChoice(val value: Int?, val label: String)

    val TIMED_ALARMS = listOf(
        AlarmChoice(null, "なし"),
        AlarmChoice(0, "開始時"),
        AlarmChoice(5, "5 分前"),
        AlarmChoice(10, "10 分前"),
        AlarmChoice(15, "15 分前"),
        AlarmChoice(30, "30 分前"),
        AlarmChoice(60, "1 時間前"),
        AlarmChoice(1440, "前日 (24 時間前)"),
    )

    /** An all-day event's alarm goes out at 8:00: the day before (1440) or on the day (-480). */
    val ALL_DAY_ALARMS = listOf(
        AlarmChoice(null, "なし"),
        AlarmChoice(1440, "前日 8:00"),
        AlarmChoice(-480, "当日 8:00"),
    )

    fun alarmChoices(allDay: Boolean): List<AlarmChoice> = if (allDay) ALL_DAY_ALARMS else TIMED_ALARMS

    fun alarmLabel(minutes: Int?, allDay: Boolean): String = alarmChoices(allDay).firstOrNull { it.value == minutes }?.label ?: "なし"

    /** The alarm kept when the event turns all-day or back (the server does the same, CALENDAR.md §2). */
    fun remapAlarm(minutes: Int?, allDay: Boolean): Int? {
        if (minutes == null || minutes == 1440) return minutes
        if (allDay) return -480
        return if (minutes == -480) 60 else minutes
    }

    // --- the form --------------------------------------------------------------------------------

    /** A new event on `day`: the next whole hour for an hour (today), else 10:00. `calendar` null = my own. */
    fun newDraft(day: LocalDate, calendar: String? = null, now: ZonedDateTime = ZonedDateTime.now(zone())): EventDraft {
        val hour = if (day == today(now)) minOf(now.withZoneSameInstant(zone()).hour + 1, 23) else 10
        return EventDraft(
            title = "",
            allDay = false,
            startDay = day,
            startTime = LocalTime.of(hour, 0),
            endDay = day,
            endTime = if (hour == 23) LocalTime.of(23, 59) else LocalTime.of(hour + 1, 0),
            calendar = calendar,
            repeat = CalendarRecurrence.noRepeat(day),
        )
    }

    fun draftFromEvent(event: CalendarEventOut): EventDraft {
        val common = EventDraft(
            title = event.title,
            allDay = event.allDay,
            startDay = LocalDate.now(),
            startTime = LocalTime.of(10, 0),
            endDay = LocalDate.now(),
            endTime = LocalTime.of(11, 0),
            calendar = event.channelId,
            location = event.location ?: "",
            description = event.description ?: "",
            alarm = event.alarm?.minutesBefore,
        )
        // M69: 「繰り返し」 is the series' rule, read on the opened occurrence's day (as the desktop's draftFromEvent).
        if (event.allDay) {
            val (first, last) = eventDays(event)
            return common.copy(startDay = first, endDay = last, repeat = CalendarRecurrence.rruleToRepeat(event.rrule, first))
        }
        val start = local(event.startsAt!!)
        val end = local(event.endsAt!!)
        return common.copy(
            startDay = start.toLocalDate(), startTime = start.toLocalTime().truncatedTo(ChronoUnit.MINUTES),
            endDay = end.toLocalDate(), endTime = end.toLocalTime().truncatedTo(ChronoUnit.MINUTES),
            repeat = CalendarRecurrence.rruleToRepeat(event.rrule, start.toLocalDate()),
        )
    }

    private fun at(day: LocalDate, time: LocalTime): ZonedDateTime = ZonedDateTime.of(day, time, zone())

    /** What stops the form from being saved (the server's rules, said first here), or null. */
    fun draftProblem(draft: EventDraft): String? {
        val title = draft.title.trim()
        if (title.isEmpty()) return "題名を入れてください"
        if (title.length > MAX_TITLE) return "題名は $MAX_TITLE 文字までです"
        if (draft.location.trim().length > MAX_LOCATION) return "場所は $MAX_LOCATION 文字までです"
        if (draft.description.trim().length > MAX_DESCRIPTION) return "説明は $MAX_DESCRIPTION 文字までです"
        CalendarRecurrence.repeatProblem(draft.repeat, draft.startDay)?.let { return it }
        if (draft.allDay) {
            if (draft.endDay.isBefore(draft.startDay)) return "終了日は開始日より後にしてください"
            if (ChronoUnit.DAYS.between(draft.startDay, draft.endDay) >= MAX_ALL_DAY_DAYS) return "終日の予定は $MAX_ALL_DAY_DAYS 日までです"
            return null
        }
        val start = at(draft.startDay, draft.startTime)
        val end = at(draft.endDay, draft.endTime)
        if (!end.isAfter(start)) return "終了は開始より後にしてください"
        if (Duration.between(start, end) > Duration.ofDays(MAX_TIMED_DAYS)) return "時刻の予定は $MAX_TIMED_DAYS 日までです"
        return null
    }

    /** Moving the start carries the end along (the event keeps its length). */
    fun withStart(draft: EventDraft, day: LocalDate, time: LocalTime = draft.startTime): EventDraft {
        // M69: before a rule is chosen, 毎週's weekday follows the start (it is the start's weekday by default).
        val moved = if (draft.repeat.kind == RepeatKind.NONE) draft.copy(repeat = draft.repeat.copy(weekdays = CalendarRecurrence.noRepeat(day).weekdays)) else draft
        return movedStart(moved, day, time)
    }

    private fun movedStart(draft: EventDraft, day: LocalDate, time: LocalTime): EventDraft {
        if (draft.allDay) {
            val length = maxOf(0L, ChronoUnit.DAYS.between(draft.startDay, draft.endDay))
            return draft.copy(startDay = day, endDay = day.plusDays(length))
        }
        val before = at(draft.startDay, draft.startTime)
        val after = at(day, time)
        val end = at(draft.endDay, draft.endTime).plus(Duration.between(before, after))
        return draft.copy(startDay = day, startTime = time, endDay = end.toLocalDate(), endTime = end.toLocalTime().truncatedTo(ChronoUnit.MINUTES))
    }

    /** 終日 on or off: an all-day event cannot end before it starts, and the alarm follows the kind (remapAlarm). */
    fun withAllDay(draft: EventDraft, allDay: Boolean): EventDraft = draft.copy(
        allDay = allDay,
        endDay = if (draft.endDay.isBefore(draft.startDay)) draft.startDay else draft.endDay,
        alarm = remapAlarm(draft.alarm, allDay),
    )

    private fun utc(at: ZonedDateTime): String = at.toInstant().toString()

    /** POST /calendar/events: local times become UTC instants, all-day days stay dates. */
    fun draftToCreate(draft: EventDraft, tz: String, clientEventId: String): CalendarEventCreate {
        val timed = !draft.allDay
        return CalendarEventCreate(
            channelId = draft.calendar,
            title = draft.title.trim(),
            allDay = draft.allDay,
            startsAt = if (timed) utc(at(draft.startDay, draft.startTime)) else null,
            endsAt = if (timed) utc(at(draft.endDay, draft.endTime)) else null,
            startDate = if (timed) null else draft.startDay.toString(),
            endDate = if (timed) null else draft.endDay.toString(),
            location = draft.location.trim().ifEmpty { null },
            description = draft.description.trim().ifEmpty { null },
            alarmMinutes = draft.alarm,
            tz = tz,
            clientEventId = clientEventId,
            rrule = CalendarRecurrence.repeatToRrule(draft.repeat, draft.startDay),
        )
    }

    /**
     * M69: what the form changed against the event as it was opened, and only that (an occurrence's 「この予定」 must not
     * mark the fields it left alone as its own, CALENDAR.md §10.8). The time goes whole when any of it changed; an emptied
     * 場所 / 説明 goes as null. The desktop's draftChanges.
     */
    fun draftChanges(draft: EventDraft, before: EventDraft): JsonObject = buildJsonObject {
        if (draft.title.trim() != before.title.trim()) put("title", JsonPrimitive(draft.title.trim()))
        if (draft.location.trim() != before.location.trim()) put("location", draft.location.trim().ifEmpty { null }?.let { JsonPrimitive(it) } ?: JsonNull)
        if (draft.description.trim() != before.description.trim()) put("description", draft.description.trim().ifEmpty { null }?.let { JsonPrimitive(it) } ?: JsonNull)
        val now = draftToPatch(draft)
        val then = draftToPatch(before)
        if (now.allDay != then.allDay || now.startsAt != then.startsAt || now.endsAt != then.endsAt || now.startDate != then.startDate || now.endDate != then.endDate) {
            put("all_day", JsonPrimitive(now.allDay))
            put("starts_at", now.startsAt?.let { JsonPrimitive(it) } ?: JsonNull)
            put("ends_at", now.endsAt?.let { JsonPrimitive(it) } ?: JsonNull)
            put("start_date", now.startDate?.let { JsonPrimitive(it) } ?: JsonNull)
            put("end_date", now.endDate?.let { JsonPrimitive(it) } ?: JsonNull)
        }
    }

    /**
     * PATCH /calendar/events/{series_id}/occurrences/{occurrence_start}: the scope, what changed, and (「これ以降」 /
     * 「すべて」 only) the rule when the picker changed it (null: no longer repeating). The desktop's applyScope.
     */
    fun occurrenceUpdate(scope: OccurrenceScope, draft: EventDraft, opened: EventDraft, rrule: String?): JsonObject = buildJsonObject {
        put("scope", JsonPrimitive(scope.wire))
        draftChanges(draft, opened).forEach { (key, value) -> put(key, value) }
        if (scope != OccurrenceScope.THIS && CalendarRecurrence.ruleChanged(draft.repeat, draft.startDay, rrule)) {
            put("rrule", CalendarRecurrence.repeatToRrule(draft.repeat, draft.startDay)?.let { JsonPrimitive(it) } ?: JsonNull)
        }
    }

    /** Whether saving a recurring event's occurrence changes anything but my alarm (then the scope is asked). */
    fun occurrenceChanged(draft: EventDraft, opened: EventDraft, rrule: String?): Boolean =
        draftChanges(draft, opened).isNotEmpty() || CalendarRecurrence.ruleChanged(draft.repeat, draft.startDay, rrule)

    /** 「この予定」 is offered only when the change fits one occurrence (not its rule, not all-day ↔ timed). */
    fun scopesFor(deleting: Boolean, draft: EventDraft, event: CalendarEventOut): List<OccurrenceScope> {
        val single = deleting || (!CalendarRecurrence.ruleChanged(draft.repeat, draft.startDay, event.rrule) && draft.allDay == event.allDay)
        return OccurrenceScope.entries.filter { single || it != OccurrenceScope.THIS }
    }

    /** A one-off event's PATCH: the whole form, and the rule (with its zone) when the picker makes it recurring. */
    fun draftToPatch(draft: EventDraft, tz: String): CalendarEventUpdate {
        val rrule = CalendarRecurrence.repeatToRrule(draft.repeat, draft.startDay)
        return draftToPatch(draft).copy(rrule = rrule, tz = rrule?.let { tz })
    }

    /** 🔁 and the rule in words for an occurrence (null: a one-off event). */
    fun repeatLine(event: CalendarEventOut): String? =
        if (!event.recurring) null else "🔁 " + CalendarRecurrence.describeRrule(event.rrule, eventDays(event).first)

    /** PATCH /calendar/events/{id}: the whole form (its calendar cannot move). */
    fun draftToPatch(draft: EventDraft): CalendarEventUpdate {
        val timed = !draft.allDay
        return CalendarEventUpdate(
            title = draft.title.trim(),
            allDay = draft.allDay,
            startsAt = if (timed) utc(at(draft.startDay, draft.startTime)) else null,
            endsAt = if (timed) utc(at(draft.endDay, draft.endTime)) else null,
            startDate = if (timed) null else draft.startDay.toString(),
            endDate = if (timed) null else draft.endDay.toString(),
            location = draft.location.trim().ifEmpty { null },
            description = draft.description.trim().ifEmpty { null },
        )
    }

    /** The event's filter (「すべて」, 「自分」, or a channel id). */
    fun filterEvents(events: List<CalendarEventOut>, filter: String): List<CalendarEventOut> = when (filter) {
        FILTER_ALL -> events
        FILTER_ME -> events.filter { it.channelId == null }
        else -> events.filter { it.channelId == filter }
    }

    const val FILTER_ALL = "all"
    const val FILTER_ME = "me"
}

/** M52: which conversations have a shared calendar (CALENDAR.md §3, §9 5.): public and private channels, never DMs. */
object CalendarChannels {
    private val collator: Collator = Collator.getInstance(Locale.JAPANESE)

    fun hasCalendar(channel: ChannelOut): Boolean = channel.type == "public" || channel.type == "private"

    /** The calendars I see and filter by: the channels with one that I belong to, by name. */
    fun readable(channels: Collection<ChannelState>): List<ChannelState> =
        channels.filter { it.isMember && hasCalendar(it.channel) }.sortedWith { a, b -> collator.compare(a.channel.name ?: "", b.channel.name ?: "") }

    /** The ones I may add to: I may post in them (the announcement rule) and they are not archived. */
    fun writable(channels: Collection<ChannelState>, isAdmin: Boolean): List<ChannelState> =
        readable(channels).filter { !it.channel.archived && it.canPostTopLevel(isAdmin) }
}

/** The event form's fields (CALENDAR.md §7). `calendar` null: my own calendar, else a channel id. */
data class EventDraft(
    val title: String,
    val allDay: Boolean,
    val startDay: LocalDate,
    val startTime: LocalTime,
    val endDay: LocalDate,
    val endTime: LocalTime,
    val calendar: String?,
    val location: String = "",
    val description: String = "",
    val alarm: Int? = null,
    /** M69: 「繰り返し」 (the rule of the series an occurrence belongs to). */
    val repeat: RepeatDraft = RepeatDraft(),
)
