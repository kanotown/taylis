package jp.chikuwachat.android.widget

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.LocalSize
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.lazy.LazyColumn
import androidx.glance.appwidget.lazy.items
import androidx.glance.appwidget.provideContent
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.ColumnScope
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxHeight
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.width
import androidx.glance.semantics.contentDescription
import androidx.glance.semantics.semantics
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextAlign
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import jp.chikuwachat.android.L10n
import jp.chikuwachat.android.R
import jp.chikuwachat.android.app.Workspaces
import jp.chikuwachat.android.ui.CalendarDates
import java.time.Instant
import java.time.LocalDate

/**
 * 今日の予定・締切 on the home screen ([TodayWidgetSnapshot] of the widget's workspace, [WidgetWorkspaces]): today's
 * events in my calendars (all-day ones first, then by time; a timed one leaves once over), each with its calendar's
 * colour and its time in an aligned column, and my open tasks due today or overdue (a checkbox, the due; 「期限切れ」 in
 * red).
 *
 * Sizes (exact): 2×1 the next event and the number of tasks due; 2×2 the next event large, the rest of the day under it
 * and the tasks at the foot; 4×1 the first two lines beside the tasks' number; 4×2 and up every line in a scrolling
 * list (events, then 「締切」 and the tasks). 「今日の予定はありません」 when the day holds nothing. A line opens its event
 * or task in the app (as its notification would); the tasks' number opens 「タスク」; anywhere else opens the calendar —
 * always in the widget's workspace.
 */
class TodayWidget : GlanceAppWidget() {
    override val sizeMode: SizeMode = SizeMode.Exact

    override val previewSizeMode = SizeMode.Responsive(WidgetPreviews.SIZES)

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val appWidgetId = WidgetWorkspaces.appWidgetId(context, id) ?: -1
        val snapshots = TodayWidgetData.flow(context)
        val workspaces = WidgetWorkspaces.flow(context)
        provideContent {
            val all by snapshots.collectAsState()
            val chosen by workspaces.collectAsState()
            val clock by TodayWidgetData.clock.collectAsState()
            val key = chosen.resolve(appWidgetId)
            WidgetTheme { TodayBody(context, key, key?.let { all[it] }, key?.let { chosen.names[it] }, clock) }
        }
    }

    override suspend fun providePreview(context: Context, widgetCategory: Int) {
        val morning = WidgetPreviews.morning()
        provideContent { WidgetTheme { TodayBody(context, WidgetPreviews.SERVER, WidgetPreviews.today(), null, morning, fixed = true) } }
    }

    companion object {
        val WIDE_FROM = 200.dp
        val TALL_FROM = WidgetLook.SHORT_BELOW
        const val ROW_DP = 30f
        /** The time column (「10:00〜11:30」 fits; 「終日」 and 「期限切れ」 too). */
        val TIME_COLUMN = 84.dp
    }
}

/** Placed or resized: read today's events and tasks at once; the last one removed: no more redraws planned. */
class TodayWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = TodayWidget()

    override fun onUpdate(context: Context, appWidgetManager: android.appwidget.AppWidgetManager, appWidgetIds: IntArray) {
        super.onUpdate(context, appWidgetManager, appWidgetIds)
        TodayWidgetWorker.requestRead(context, delayMs = 0L)
    }

    override fun onDeleted(context: Context, appWidgetIds: IntArray) {
        super.onDeleted(context, appWidgetIds)
        WidgetWorkspaces.deleted(context, appWidgetIds)
    }

    override fun onDisabled(context: Context) {
        super.onDisabled(context)
        TodayWidgetWorker.cancel(context)
    }
}

private val OVERDUE: ColorProvider get() = WidgetLook.OVERDUE

@Composable
private fun TodayBody(context: Context, key: String?, snapshot: TodayWidgetSnapshot?, name: String?, clock: Long, fixed: Boolean = false) {
    val size = LocalSize.current
    val wide = size.width >= TodayWidget.WIDE_FROM
    val tall = size.height >= TodayWidget.TALL_FROM
    val now = Instant.ofEpochMilli(if (fixed) clock else maxOf(clock, System.currentTimeMillis()))
    val today = now.atZone(CalendarDates.zone()).toLocalDate()
    val open = actionStartActivity(WidgetLinks.intent(context, WidgetLink.Screen(snapshot?.serverUrl ?: key, WidgetScreen.CALENDAR)))
    val rows = snapshot?.let { TodayWidgetRules.rows(it, today, now) } ?: emptyList()
    val events = rows.count { it is TodayRow.Event }
    val tasks = rows.size - events
    val label = when {
        key == null -> L10n.str(R.string.widget_sign_in)
        snapshot == null -> L10n.str(R.string.widget_loading)
        else -> L10n.str(R.string.today_widget_open, CalendarDates.dayLabel(today), events, tasks) +
            if (snapshot.failed || !TodayWidgetRules.covers(snapshot, today)) " " + L10n.str(R.string.widget_stale) else ""
    }
    WidgetFrame(open, label, short = !tall) {
        when {
            key == null -> WidgetNotice(null, L10n.str(R.string.widget_sign_in))
            snapshot == null -> WidgetNotice(name ?: Workspaces.hostLabel(key), L10n.str(R.string.widget_loading))
            else -> {
                val day = Day(context, snapshot, today, now, rows)
                when {
                    wide && tall -> TodayList(day, size.height.value)
                    wide -> TodayWideShort(day)
                    tall -> TodayCompactTall(day, size.height.value)
                    else -> TodayCompactShort(day)
                }
            }
        }
    }
}

/** What every layout draws from. */
private class Day(
    val context: Context, val snapshot: TodayWidgetSnapshot, val today: LocalDate, val now: Instant, val rows: List<TodayRow>,
) {
    val events: List<TodayEvent> = rows.mapNotNull { (it as? TodayRow.Event)?.event }
    val tasks: List<TodayRow.Task> = rows.filterIsInstance<TodayRow.Task>()
    val overdue: Boolean = tasks.any { it.overdue }
    val stale: Boolean = snapshot.failed || !TodayWidgetRules.covers(snapshot, today)
}

/** The header: the workspace, and the day on the right (「10/14 (水)」) in the primary colour. */
@Composable
private fun DayHeader(day: Day) {
    // Narrow widgets: 「10/14 (水)」, so the workspace's name keeps its room.
    val note = if (LocalSize.current.width >= TodayWidget.WIDE_FROM) CalendarDates.dayLabel(day.today)
    else "${day.today.monthValue}/${day.today.dayOfMonth} (${CalendarDates.weekdayLabel(CalendarDates.weekdayIndex(day.today))})"
    WidgetHeader(day.snapshot.workspaceName, note = note, noteColor = GlanceTheme.colors.primary, stale = day.stale)
}

/** 「14:00〜15:30」, 「終日」, 「〜15:30」 (began earlier). */
private fun timeText(event: TodayEvent, today: LocalDate): String =
    runCatching { CalendarDates.timeOnDay(event.toOut(), today) }.getOrDefault("")

/** A task's due: 「期限切れ」, its due time, or 「今日」. */
private fun dueText(task: TodayTask, overdue: Boolean): String = when {
    overdue -> L10n.str(R.string.today_widget_overdue)
    task.dueAt != null -> runCatching { CalendarDates.clock(task.dueAt) }.getOrDefault(L10n.str(R.string.common_today))
    else -> L10n.str(R.string.common_today)
}

/** The colour of the event's calendar (its channel's, or slate for my own), as the app's calendar draws it. */
private fun calendarColor(event: TodayEvent): ColorProvider = androidx.glance.unit.ColorProvider(Color(CalendarDates.channelColor(event.channelId)))

private fun eventLink(day: Day, event: TodayEvent) = WidgetLink.Event(
    day.snapshot.serverUrl, event.channelId, event.id,
    seriesId = event.seriesId.takeIf { event.recurring }, occurrenceStart = event.occurrenceStart.takeIf { event.recurring },
    day = day.today.toString(),
)

private fun openEvent(day: Day, event: TodayEvent) = actionStartActivity(WidgetLinks.intent(day.context, eventLink(day, event)))

private fun eventLabel(day: Day, event: TodayEvent) = L10n.str(R.string.today_widget_event_row, timeText(event, day.today), event.title)

/** The calendar's colour as a rounded bar in front of an event. */
@Composable
private fun Bar(color: ColorProvider, height: Dp) {
    Box(GlanceModifier.width(4.dp).height(height).rounded(color, 2.dp)) {}
}

/** An event line: the bar, the time in a fixed column, the title and its channel; a tap opens it. */
@Composable
private fun EventLine(day: Day, event: TodayEvent, showPlace: Boolean) {
    val label = eventLabel(day, event)
    Row(
        GlanceModifier.fillMaxWidth().height(TodayWidget.ROW_DP.dp).clickable(openEvent(day, event)).semantics { contentDescription = label },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Bar(calendarColor(event), 18.dp)
        Spacer(GlanceModifier.width(10.dp))
        Text(
            timeText(event, day.today), maxLines = 1, modifier = GlanceModifier.width(TodayWidget.TIME_COLUMN),
            style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 12.sp),
        )
        Text(
            event.title, maxLines = 1, modifier = GlanceModifier.defaultWeight(),
            style = TextStyle(color = GlanceTheme.colors.onSurface, fontSize = 14.sp, fontWeight = FontWeight.Medium),
        )
        val place = TodayWidgetRules.place(event.channelId, event.channelName)
        if (showPlace && place != null) {
            Spacer(GlanceModifier.width(6.dp))
            Text(place, maxLines = 1, style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 11.sp))
        }
    }
}

/** A task line: a checkbox (red when overdue), the due in the time column, the title and its channel; a tap opens it. */
@Composable
private fun TaskLine(day: Day, row: TodayRow.Task, showPlace: Boolean) {
    val task = row.task
    val due = dueText(task, row.overdue)
    val label = L10n.str(R.string.today_widget_task_row, task.title, due)
    val open = actionStartActivity(WidgetLinks.intent(day.context, WidgetLink.Task(day.snapshot.serverUrl, task.channelId, task.id)))
    Row(
        GlanceModifier.fillMaxWidth().height(TodayWidget.ROW_DP.dp).clickable(open).semantics { contentDescription = label },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // The checkbox takes the place of an event's bar and its gap (14 dp), so the due and the title line up.
        Box(GlanceModifier.width(14.dp), contentAlignment = Alignment.CenterStart) {
            WidgetIcon(WidgetGlyphs.task, 13.dp, if (row.overdue) OVERDUE else GlanceTheme.colors.onSurfaceVariant)
        }
        Text(
            due, maxLines = 1, modifier = GlanceModifier.width(TodayWidget.TIME_COLUMN),
            style = TextStyle(
                color = if (row.overdue) OVERDUE else GlanceTheme.colors.onSurfaceVariant, fontSize = 12.sp,
                fontWeight = if (row.overdue) FontWeight.Bold else FontWeight.Normal,
            ),
        )
        Text(
            task.title, maxLines = 1, modifier = GlanceModifier.defaultWeight(),
            style = TextStyle(color = GlanceTheme.colors.onSurface, fontSize = 14.sp),
        )
        val place = TodayWidgetRules.place(task.channelId, task.channelName)
        if (showPlace && place != null) {
            Spacer(GlanceModifier.width(6.dp))
            Text(place, maxLines = 1, style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 11.sp))
        }
    }
}

/** 「今日の予定はありません」 with a calendar mark. */
@Composable
private fun NoEvents(centered: Boolean) {
    Row(
        GlanceModifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically,
        horizontalAlignment = if (centered) Alignment.CenterHorizontally else Alignment.Start,
    ) {
        WidgetIcon(WidgetGlyphs.noEvents, 18.dp, GlanceTheme.colors.primary)
        Spacer(GlanceModifier.width(8.dp))
        Text(L10n.str(R.string.today_widget_none_today), maxLines = 1, style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 13.sp))
    }
}

/** The tasks due as a compact chip (a checkbox and the number; red with an overdue one); a tap opens 「タスク」. */
@Composable
private fun TasksChip(day: Day, words: Boolean) {
    val count = day.tasks.size
    val text = when {
        count == 0 -> L10n.str(R.string.today_widget_no_tasks)
        words -> L10n.str(R.string.today_widget_tasks, count)
        else -> count.toString()
    }
    val open = actionStartActivity(WidgetLinks.intent(day.context, WidgetLink.Screen(day.snapshot.serverUrl, WidgetScreen.TASKS)))
    val label = L10n.str(R.string.today_widget_tasks_open, if (count == 0) text else L10n.str(R.string.today_widget_tasks, count))
    val color = when {
        day.overdue -> OVERDUE
        count > 0 -> GlanceTheme.colors.onSurface
        else -> GlanceTheme.colors.onSurfaceVariant
    }
    Row(
        GlanceModifier.clickable(open).semantics { contentDescription = label },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        WidgetIcon(if (count == 0) WidgetGlyphs.tasksDone else WidgetGlyphs.task, 16.dp, if (count == 0) GlanceTheme.colors.primary else color)
        Spacer(GlanceModifier.width(5.dp))
        Text(text, maxLines = 1, style = TextStyle(color = color, fontSize = 13.sp, fontWeight = if (count > 0) FontWeight.Bold else FontWeight.Normal))
    }
}

/** The next event large: the bar, its time over its title (one or two lines). */
@Composable
private fun NextEvent(day: Day, event: TodayEvent, titleLines: Int, titleSize: Int) {
    val label = eventLabel(day, event)
    Row(
        GlanceModifier.fillMaxWidth().clickable(openEvent(day, event)).semantics { contentDescription = label },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Bar(calendarColor(event), if (titleLines > 1) 44.dp else 36.dp)
        Spacer(GlanceModifier.width(10.dp))
        Column(GlanceModifier.defaultWeight()) {
            Text(timeText(event, day.today), maxLines = 1, style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 12.sp))
            Text(event.title, maxLines = titleLines, style = TextStyle(color = GlanceTheme.colors.onSurface, fontSize = titleSize.sp, fontWeight = FontWeight.Bold))
        }
    }
}

/** 2×1: the header, then the next event beside the number of tasks due. */
@Composable
private fun ColumnScope.TodayCompactShort(day: Day) {
    DayHeader(day)
    Spacer(GlanceModifier.defaultWeight())
    val next = TodayWidgetRules.next(day.snapshot, day.today, day.now)
    Row(GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Box(GlanceModifier.defaultWeight()) {
            if (next == null) NoEventsShort() else NextEvent(day, next, titleLines = 1, titleSize = 14)
        }
        if (day.tasks.isNotEmpty()) {
            Spacer(GlanceModifier.width(8.dp))
            TasksChip(day, words = false)
        }
    }
}

/** The empty day in the 2×1 widget: the mark over the words (they do not fit beside it). */
@Composable
private fun NoEventsShort() {
    Row(verticalAlignment = Alignment.CenterVertically) {
        WidgetIcon(WidgetGlyphs.noEvents, 18.dp, GlanceTheme.colors.primary)
        Spacer(GlanceModifier.width(6.dp))
        Text(L10n.str(R.string.today_widget_empty), maxLines = 2, style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 13.sp))
    }
}

/** 2×2: the header, the next event large, the rest of the day as fits, the tasks due at the foot. */
@Composable
private fun ColumnScope.TodayCompactTall(day: Day, heightDp: Float) {
    DayHeader(day)
    Spacer(GlanceModifier.height(12.dp))
    val next = TodayWidgetRules.next(day.snapshot, day.today, day.now)
    if (next == null) {
        Spacer(GlanceModifier.defaultWeight())
        NoEventsBig()
        Spacer(GlanceModifier.defaultWeight())
    } else {
        val fit = UnreadWidgetRules.rowsThatFit(heightDp, usedDp = 28f + 20f + 12f + 52f + 8f + 26f, rowDp = 24f, max = 5)
        val later = TodayWidgetRules.laterToday(day.snapshot, day.today, day.now, next).take(fit)
        NextEvent(day, next, titleLines = if (later.isEmpty()) 2 else 1, titleSize = 16)
        if (later.isNotEmpty()) Spacer(GlanceModifier.height(8.dp))
        later.forEach { event ->
            val label = eventLabel(day, event)
            Row(
                GlanceModifier.fillMaxWidth().height(24.dp).clickable(openEvent(day, event)).semantics { contentDescription = label },
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Bar(calendarColor(event), 14.dp)
                Spacer(GlanceModifier.width(8.dp))
                Text(
                    timeText(event, day.today) + "  " + event.title, maxLines = 1,
                    style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 12.sp),
                )
            }
        }
        Spacer(GlanceModifier.defaultWeight())
    }
    TasksChip(day, words = true)
}

/** The empty day, centred with a larger mark (the tall widgets). */
@Composable
private fun NoEventsBig() {
    Column(GlanceModifier.fillMaxWidth(), horizontalAlignment = Alignment.CenterHorizontally) {
        WidgetIcon(WidgetGlyphs.noEvents, 28.dp, GlanceTheme.colors.primary)
        Spacer(GlanceModifier.height(6.dp))
        Text(
            L10n.str(R.string.today_widget_none_today), maxLines = 2,
            style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 13.sp, textAlign = TextAlign.Center),
        )
    }
}

/** 4×1: the header; the first two lines on the left, the number of tasks due on the right. */
@Composable
private fun ColumnScope.TodayWideShort(day: Day) {
    DayHeader(day)
    Spacer(GlanceModifier.height(2.dp))
    Row(GlanceModifier.fillMaxWidth().defaultWeight(), verticalAlignment = Alignment.CenterVertically) {
        Column(GlanceModifier.defaultWeight(), verticalAlignment = Alignment.CenterVertically) {
            if (day.events.isEmpty()) {
                NoEvents(centered = false)
            } else {
                day.events.take(2).forEach { EventLine(day, it, showPlace = false) }
            }
        }
        Spacer(GlanceModifier.width(10.dp))
        DueBlock(day)
    }
}

/** The tasks due as a big number with 「締切」 under it (red with an overdue one); a tap opens 「タスク」. */
@Composable
private fun DueBlock(day: Day) {
    val count = day.tasks.size
    val open = actionStartActivity(WidgetLinks.intent(day.context, WidgetLink.Screen(day.snapshot.serverUrl, WidgetScreen.TASKS)))
    val label = L10n.str(R.string.today_widget_tasks_open, if (count == 0) L10n.str(R.string.today_widget_no_tasks) else L10n.str(R.string.today_widget_tasks, count))
    val color = if (day.overdue) OVERDUE else if (count > 0) GlanceTheme.colors.onSurface else GlanceTheme.colors.onSurfaceVariant
    Column(
        GlanceModifier.width(56.dp).fillMaxHeight().rounded(GlanceTheme.colors.secondaryContainer, 14.dp)
            .clickable(open).semantics { contentDescription = label },
        verticalAlignment = Alignment.CenterVertically, horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(count.toString(), maxLines = 1, style = TextStyle(color = color, fontSize = 22.sp, fontWeight = FontWeight.Bold))
        Text(L10n.str(R.string.today_widget_deadlines), maxLines = 1, style = TextStyle(color = GlanceTheme.colors.onSecondaryContainer, fontSize = 11.sp))
    }
}

/** 4×2 and taller: the header, then every line in a scrolling list — the events, then 「締切」 and the tasks. */
@Composable
private fun ColumnScope.TodayList(day: Day, heightDp: Float) {
    DayHeader(day)
    Spacer(GlanceModifier.height(8.dp))
    if (day.rows.isEmpty()) {
        Spacer(GlanceModifier.defaultWeight())
        NoEventsBig()
        Spacer(GlanceModifier.defaultWeight())
        TasksChip(day, words = true)
        return
    }
    LazyColumn(GlanceModifier.fillMaxWidth().defaultWeight()) {
        if (day.events.isEmpty()) item { Box(GlanceModifier.height(TodayWidget.ROW_DP.dp), contentAlignment = Alignment.CenterStart) { NoEvents(centered = false) } }
        items(day.events, itemId = { (it.id + "|" + it.occurrenceStart).hashCode().toLong() }) { EventLine(day, it, showPlace = true) }
        if (day.tasks.isNotEmpty()) {
            item {
                Text(
                    L10n.str(R.string.today_widget_due_count, day.tasks.size), maxLines = 1,
                    modifier = GlanceModifier.padding(top = 8.dp, bottom = 2.dp),
                    style = TextStyle(color = if (day.overdue) OVERDUE else GlanceTheme.colors.primary, fontSize = 12.sp, fontWeight = FontWeight.Bold),
                )
            }
            items(day.tasks, itemId = { ("task|" + it.task.id).hashCode().toLong() }) { TaskLine(day, it, showPlace = true) }
        }
    }
    // The tasks are below the events: when the list scrolls them out of sight, their number stays at the foot.
    if (day.tasks.isNotEmpty() && TodayWidgetRules.listOverflows(heightDp, day.events.size, day.tasks.size)) {
        Spacer(GlanceModifier.height(6.dp))
        TasksChip(day, words = true)
    }
}
