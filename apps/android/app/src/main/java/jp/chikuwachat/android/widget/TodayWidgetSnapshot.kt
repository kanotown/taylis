package jp.chikuwachat.android.widget

import jp.chikuwachat.android.api.CalendarEventOut
import jp.chikuwachat.android.api.TaskOut
import jp.chikuwachat.android.api.TaskStatus
import jp.chikuwachat.android.ui.CalendarDates
import jp.chikuwachat.android.ui.DeadlineRules
import jp.chikuwachat.android.ui.TaskRules
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/**
 * The 今日の予定・締切 home-screen widget's data: the events of my calendars (mine and my channels', CALENDAR.md §4) and
 * my open tasks with a due date (「自分のタスク」: personal ones and shared ones assigned to me, TASKS.md) for [day] and
 * the day after, so the widget rolls over at midnight from what it holds even before the next read. What it shows is
 * chosen when it is drawn, for the device's day and time ([TodayWidgetRules]).
 *
 * Read by the app (GET /calendar/events for the two days and GET /tasks/mine, through the workspace's own client) after
 * it connects, when a calendar or task event arrives, after a calendar or task push, and at midnight.
 */
@Serializable
data class TodayWidgetSnapshot(
    val serverUrl: String,
    val workspaceName: String,
    val meId: String,
    /** The first local date ("YYYY-MM-DD") the events and tasks were read for; they cover it and the next day. */
    val day: String,
    val events: List<TodayEvent> = emptyList(),
    val tasks: List<TodayTask> = emptyList(),
    /** When this was read (epoch ms). */
    val updatedAt: Long = 0,
    /** The last read failed (offline, signed out): what is held stays, with 「更新できません」. */
    val failed: Boolean = false,
)

/** One event (or one occurrence of a series) as the widget draws and opens it: a copy of [CalendarEventOut]'s parts. */
@Serializable
data class TodayEvent(
    val id: String,
    val title: String,
    val channelId: String? = null,
    val channelName: String? = null,
    val allDay: Boolean = false,
    val startsAt: String? = null,
    val endsAt: String? = null,
    val startDate: String? = null,
    val endDate: String? = null,
    val seriesId: String? = null,
    val occurrenceStart: String? = null,
    val recurring: Boolean = false,
) {
    fun toOut(): CalendarEventOut = CalendarEventOut(
        id = id, channelId = channelId, channelName = channelName, title = title, allDay = allDay, startsAt = startsAt,
        endsAt = endsAt, startDate = startDate, endDate = endDate, seriesId = seriesId, occurrenceStart = occurrenceStart,
        recurring = recurring,
    )

    companion object {
        fun of(event: CalendarEventOut) = TodayEvent(
            event.id, event.title, event.channelId, event.channelName, event.allDay, event.startsAt, event.endsAt,
            event.startDate, event.endDate, event.seriesId, event.occurrenceStart, event.recurring,
        )
    }
}

/** One of my open tasks with a due date: the title and where it is (its channel; none for a personal one). */
@Serializable
data class TodayTask(
    val id: String,
    val title: String,
    val channelId: String? = null,
    val channelName: String? = null,
    val dueOn: String,
    val dueAt: String? = null,
) {
    fun toOut(): TaskOut = TaskOut(id = id, channelId = channelId, channelName = channelName, title = title, dueOn = dueOn, dueAt = dueAt)

    companion object {
        fun of(task: TaskOut) = TodayTask(task.id, task.title, task.channelId, task.channelName, task.dueOn ?: "", task.dueAt)
    }
}

/** One line of the wide widget, in order: today's events, then my tasks due today or overdue. */
sealed interface TodayRow {
    data class Event(val event: TodayEvent) : TodayRow
    data class Task(val task: TodayTask, val overdue: Boolean) : TodayRow
}

object TodayWidgetRules {
    /** The days a snapshot covers from its [TodayWidgetSnapshot.day]: today and tomorrow. */
    const val DAYS = 2L
    /** What a snapshot keeps at most (the tallest widget shows fewer). */
    const val MAX_EVENTS = 40
    const val MAX_TASKS = 30
    /** The earliest the next scheduled redraw comes (WorkManager's own floor is about this anyway). */
    const val MIN_REFRESH_MS = 60_000L
    /** A little after the moment itself, so the redraw lands on the new side of it. */
    const val REFRESH_SLACK_MS = 5_000L

    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
        explicitNulls = false
    }

    fun encode(snapshot: TodayWidgetSnapshot): String = json.encodeToString(TodayWidgetSnapshot.serializer(), snapshot)

    fun decode(text: String?): TodayWidgetSnapshot? =
        text?.takeIf { it.isNotBlank() }?.let { runCatching { json.decodeFromString(TodayWidgetSnapshot.serializer(), it) }.getOrNull() }

    fun same(a: TodayWidgetSnapshot?, b: TodayWidgetSnapshot?): Boolean = a?.copy(updatedAt = 0) == b?.copy(updatedAt = 0)

    /** GET /calendar/events's range for a snapshot of [day]: its local midnight to the one [DAYS] later. */
    fun range(day: LocalDate): Pair<String, String> = CalendarDates.rangeParams(day, day.plusDays(DAYS))

    /**
     * The snapshot of what the server answered for [day]: every event of the two days (the server's range), and my open
     * tasks due by the end of the next day (overdue ones too) — 「自分のタスク」's rule, [TaskRules.isMine].
     */
    fun snapshot(
        serverUrl: String, workspaceName: String, meId: String, day: LocalDate,
        events: List<CalendarEventOut>, tasks: List<TaskOut>, now: Long,
    ): TodayWidgetSnapshot {
        val last = day.plusDays(DAYS - 1).toString()
        val mine = tasks.filter { task ->
            val due = TaskRules.dueDay(task.dueOn, task.dueAt)
            task.status != TaskStatus.DONE && task.dueOn != null && due != null && due <= last && TaskRules.isMine(task, meId)
        }.sortedWith(DeadlineRules.order)
        return TodayWidgetSnapshot(
            serverUrl = serverUrl, workspaceName = workspaceName, meId = meId, day = day.toString(),
            events = events.sortedWith(CalendarDates.eventOrder).take(MAX_EVENTS).map(TodayEvent::of),
            tasks = mine.take(MAX_TASKS).map(TodayTask::of),
            updatedAt = now,
        )
    }

    /** Whether the snapshot holds [today] (its day or the next); otherwise it is too old to say anything about today. */
    fun covers(snapshot: TodayWidgetSnapshot, today: LocalDate): Boolean {
        val first = runCatching { LocalDate.parse(snapshot.day) }.getOrNull() ?: return false
        return !today.isBefore(first) && today.isBefore(first.plusDays(DAYS))
    }

    private fun ended(event: TodayEvent, now: Instant): Boolean =
        !event.allDay && event.endsAt != null && runCatching { !CalendarDates.instant(event.endsAt).isAfter(now) }.getOrDefault(false)

    /**
     * Today's events still to come or under way, as the calendar orders a day ([CalendarDates.eventsOn]): all-day ones
     * and those that began on an earlier day first, then by start time, then by title. A timed event that is over leaves.
     */
    fun eventsToday(snapshot: TodayWidgetSnapshot, today: LocalDate, now: Instant): List<TodayEvent> {
        if (!covers(snapshot, today)) return emptyList()
        val byId = snapshot.events.associateBy { key(it) }
        val shown = snapshot.events.filter { !ended(it, now) }.map { it.toOut() }
        return CalendarDates.eventsOn(shown, today).mapNotNull { byId[key(TodayEvent.of(it))] }
    }

    private fun key(event: TodayEvent): String = event.id + "|" + (event.occurrenceStart ?: "")

    /** My open tasks due today or earlier (overdue first: by date, then due time, then id), as 「自分のタスク」 orders them. */
    fun tasksDue(snapshot: TodayWidgetSnapshot, today: LocalDate): List<TodayTask> {
        if (!covers(snapshot, today)) return emptyList()
        val day = today.toString()
        return snapshot.tasks.filter { task -> TaskRules.dueDay(task.dueOn, task.dueAt)?.let { it <= day } == true }
            .sortedWith(compareBy(DeadlineRules.order) { it.toOut() })
    }

    fun overdue(task: TodayTask, today: LocalDate, now: Instant): Boolean = TaskRules.isOverdue(task.toOut(), today.toString(), now)

    /** The wide widget's lines: today's events, then the tasks due. */
    fun rows(snapshot: TodayWidgetSnapshot, today: LocalDate, now: Instant): List<TodayRow> =
        eventsToday(snapshot, today, now).map { TodayRow.Event(it) } +
            tasksDue(snapshot, today).map { TodayRow.Task(it, overdue(it, today, now)) }

    /**
     * The compact widget's one event: the timed one under way or next to start today; with none, the first all-day one,
     * else one that began on an earlier day and is still going; null when today holds nothing more.
     */
    fun next(snapshot: TodayWidgetSnapshot, today: LocalDate, now: Instant): TodayEvent? {
        val events = eventsToday(snapshot, today, now)
        val timed = events.filter { !it.allDay && it.startsAt != null && CalendarDates.localDay(it.startsAt) == today }
            .minByOrNull { CalendarDates.instant(it.startsAt!!) }
        return timed ?: events.firstOrNull { it.allDay } ?: events.firstOrNull()
    }

    /** The tall compact widget's lines under [next]: the rest of today's events, in the day's order. */
    fun laterToday(snapshot: TodayWidgetSnapshot, today: LocalDate, now: Instant, next: TodayEvent): List<TodayEvent> =
        eventsToday(snapshot, today, now).filter { it.id != next.id || it.occurrenceStart != next.occurrenceStart }

    /**
     * When the widget must be drawn again without new data: the next local midnight (the day rolls over), and the next
     * end of a timed event (it leaves the list) or due time of a task (it turns overdue) after [now]. Null-free: midnight
     * always comes. At least [MIN_REFRESH_MS] away; [REFRESH_SLACK_MS] after the moment itself.
     */
    fun nextRefresh(snapshot: TodayWidgetSnapshot?, now: Instant, zone: ZoneId = CalendarDates.zone()): Instant {
        val midnight = now.atZone(zone).toLocalDate().plusDays(1).atStartOfDay(zone).toInstant()
        val moments = ArrayList<Instant>()
        moments += midnight
        snapshot?.events?.forEach { event ->
            if (!event.allDay) event.endsAt?.let { runCatching { CalendarDates.instant(it) }.getOrNull() }?.let { moments += it }
        }
        snapshot?.tasks?.forEach { task -> task.dueAt?.let { runCatching { CalendarDates.instant(it) }.getOrNull() }?.let { moments += it } }
        val target = moments.filter { it.isAfter(now) }.minOrNull() ?: midnight
        val at = target.plusMillis(REFRESH_SLACK_MS)
        val floor = now.plusMillis(MIN_REFRESH_MS)
        return if (at.isBefore(floor)) floor else at
    }

    /** Whether a scheduled redraw at [now] should read the server again: the snapshot is not of today (a new day). */
    fun needsRead(snapshot: TodayWidgetSnapshot?, today: LocalDate): Boolean = snapshot == null || snapshot.day != today.toString()

    /** 「#name」 for a channel's, nothing for a personal task or my own calendar's event (or a DM's, which has no name). */
    fun place(channelId: String?, channelName: String?): String? = if (channelId != null && !channelName.isNullOrBlank()) "#$channelName" else null
}
