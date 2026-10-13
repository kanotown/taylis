package jp.chikuwachat.android.widget

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.graphics.Color
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
import androidx.glance.appwidget.appWidgetBackground
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxHeight
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.width
import androidx.glance.semantics.contentDescription
import androidx.glance.semantics.semantics
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import jp.chikuwachat.android.L10n
import jp.chikuwachat.android.R
import jp.chikuwachat.android.ui.CalendarDates
import java.time.Instant
import java.time.LocalDate

/**
 * 今日の予定・締切 on the home screen ([TodayWidgetSnapshot]): today's events in my calendars (all-day ones first, then by
 * time; a timed one leaves once over) and my open tasks due today or overdue (title and channel; 「期限切れ」 in red).
 *
 * Sizes (exact): compact (2×1, 2×2) the next event (time and title) and the number of tasks due; wide (4×1) the day and
 * the counts beside the first two lines; wide and tall (4×2 and up) the day above as many lines as fit, 「ほか n 件」 after.
 * 「今日の予定なし」 when the day holds nothing. A line opens its event or task in the app (as its notification would); the
 * task count opens 「タスク」; anywhere else opens the calendar — always in the widget's workspace.
 */
class TodayWidget : GlanceAppWidget() {
    override val sizeMode: SizeMode = SizeMode.Exact

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val flow = TodayWidgetData.flow(context)
        provideContent {
            val snapshot by flow.collectAsState()
            val clock by TodayWidgetData.clock.collectAsState()
            GlanceTheme { TodayBody(context, snapshot, clock) }
        }
    }

    companion object {
        val WIDE_FROM = 200.dp
        val TALL_FROM = 130.dp
        /** Most lines drawn (a Column draws at most 10 children: the lines have a Column of their own). */
        const val MAX_SHOWN = 10
        const val ROW_DP = 24f
    }
}

/** Placed or resized: read today's events and tasks at once; the last one removed: no more redraws planned. */
class TodayWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = TodayWidget()

    override fun onUpdate(context: Context, appWidgetManager: android.appwidget.AppWidgetManager, appWidgetIds: IntArray) {
        super.onUpdate(context, appWidgetManager, appWidgetIds)
        TodayWidgetWorker.requestRead(context, delayMs = 0L)
    }

    override fun onDisabled(context: Context) {
        super.onDisabled(context)
        TodayWidgetWorker.cancel(context)
    }
}

private val OVERDUE: ColorProvider = androidx.glance.color.ColorProvider(day = Color(0xFFC62828), night = Color(0xFFFF8A80))

@Composable
private fun TodayBody(context: Context, snapshot: TodayWidgetSnapshot?, clock: Long) {
    val size = LocalSize.current
    val wide = size.width >= TodayWidget.WIDE_FROM
    val tall = size.height >= TodayWidget.TALL_FROM
    val now = Instant.ofEpochMilli(maxOf(clock, System.currentTimeMillis()))
    val today = now.atZone(CalendarDates.zone()).toLocalDate()
    val open = actionStartActivity(WidgetLinks.intent(context, WidgetLink.Screen(snapshot?.serverUrl, WidgetScreen.CALENDAR)))
    val rows = snapshot?.let { TodayWidgetRules.rows(it, today, now) } ?: emptyList()
    val events = rows.count { it is TodayRow.Event }
    val tasks = rows.size - events
    val overdue = rows.any { it is TodayRow.Task && it.overdue }
    val label = when {
        snapshot == null -> L10n.str(R.string.widget_sign_in)
        else -> L10n.str(R.string.today_widget_open, CalendarDates.dayLabel(today), events, tasks) +
            if (snapshot.failed || !TodayWidgetRules.covers(snapshot, today)) " " + L10n.str(R.string.widget_stale) else ""
    }
    Box(
        GlanceModifier.fillMaxSize().appWidgetBackground().background(GlanceTheme.colors.widgetBackground).cornerRadius(16.dp)
            .clickable(open).semantics { contentDescription = label }
            .padding(horizontal = 12.dp, vertical = 8.dp),
        contentAlignment = Alignment.TopStart,
    ) {
        when {
            snapshot == null -> WidgetMessage(L10n.str(R.string.widget_sign_in), null)
            wide && tall -> TodayList(context, snapshot, today, rows, size.height.value)
            wide -> TodayWideShort(context, snapshot, today, rows, tasks, overdue)
            else -> TodayCompact(context, snapshot, today, now, tasks, overdue, tall, size.height.value)
        }
    }
}

/** 「10月14日 (水)」 and the workspace, or 「更新できません」 after a failed read (or data of another day). */
@Composable
private fun DayLine(snapshot: TodayWidgetSnapshot, today: LocalDate, workspace: Boolean) {
    val stale = snapshot.failed || !TodayWidgetRules.covers(snapshot, today)
    Row(GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Text(
            CalendarDates.dayLabel(today), maxLines = 1,
            style = TextStyle(color = GlanceTheme.colors.primary, fontSize = 12.sp, fontWeight = FontWeight.Bold),
        )
        Spacer(GlanceModifier.width(6.dp))
        if (stale) {
            Text(L10n.str(R.string.widget_stale), maxLines = 1, modifier = GlanceModifier.defaultWeight(), style = TextStyle(color = GlanceTheme.colors.error, fontSize = 11.sp))
        } else if (workspace) {
            WidgetSmallLine(snapshot.workspaceName, GlanceModifier.defaultWeight())
        }
    }
}

/** 「14:00〜15:30」, 「終日」, 「〜15:30」 (began earlier). */
private fun timeText(event: TodayEvent, today: LocalDate): String =
    runCatching { CalendarDates.timeOnDay(event.toOut(), today) }.getOrDefault("")

/** A task's left column: 「期限切れ」, its due time, or 「今日」. */
private fun dueText(task: TodayTask, overdue: Boolean): String = when {
    overdue -> L10n.str(R.string.today_widget_overdue)
    task.dueAt != null -> runCatching { CalendarDates.clock(task.dueAt) }.getOrDefault(L10n.str(R.string.common_today))
    else -> L10n.str(R.string.common_today)
}

private fun eventLink(snapshot: TodayWidgetSnapshot, event: TodayEvent, today: LocalDate) = WidgetLink.Event(
    snapshot.serverUrl, event.channelId, event.id,
    seriesId = event.seriesId.takeIf { event.recurring }, occurrenceStart = event.occurrenceStart.takeIf { event.recurring },
    day = today.toString(),
)

/** One line: the time (or the due) in a fixed column, then the title and its place; a tap opens it. */
@Composable
private fun TodayLine(context: Context, snapshot: TodayWidgetSnapshot, row: TodayRow, today: LocalDate) {
    val (left, title, place, link, label, red) = when (row) {
        is TodayRow.Event -> {
            val time = timeText(row.event, today)
            Line(time, row.event.title, TodayWidgetRules.place(row.event.channelId, row.event.channelName), eventLink(snapshot, row.event, today),
                L10n.str(R.string.today_widget_event_row, time, row.event.title), false)
        }
        is TodayRow.Task -> {
            val due = dueText(row.task, row.overdue)
            Line(due, row.task.title, TodayWidgetRules.place(row.task.channelId, row.task.channelName),
                WidgetLink.Task(snapshot.serverUrl, row.task.channelId, row.task.id),
                L10n.str(R.string.today_widget_task_row, row.task.title, due), row.overdue)
        }
    }
    Row(
        GlanceModifier.fillMaxWidth().height(TodayWidget.ROW_DP.dp).cornerRadius(6.dp)
            .clickable(actionStartActivity(WidgetLinks.intent(context, link))).semantics { contentDescription = label },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // A task's mark: a narrow bar in front of its due, so tasks read apart from events at a glance.
        Box(
            GlanceModifier.width(3.dp).height(14.dp).cornerRadius(2.dp)
                .background(if (row is TodayRow.Task) (if (red) OVERDUE else GlanceTheme.colors.tertiary) else GlanceTheme.colors.primary),
        ) {}
        Spacer(GlanceModifier.width(6.dp))
        Text(
            left, maxLines = 1, modifier = GlanceModifier.width(76.dp),
            style = TextStyle(color = if (red) OVERDUE else GlanceTheme.colors.onSurfaceVariant, fontSize = 11.sp, fontWeight = if (red) FontWeight.Bold else FontWeight.Normal),
        )
        Text(
            title, maxLines = 1, modifier = GlanceModifier.defaultWeight(),
            style = TextStyle(color = GlanceTheme.colors.onSurface, fontSize = 13.sp, fontWeight = FontWeight.Medium),
        )
        if (place != null) {
            Spacer(GlanceModifier.width(4.dp))
            Text(place, maxLines = 1, style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 11.sp))
        }
    }
}

private data class Line(val left: String, val title: String, val place: String?, val link: WidgetLink, val label: String, val red: Boolean)

@Composable
private fun Empty() {
    Text(L10n.str(R.string.today_widget_empty), maxLines = 1, style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 13.sp))
}

/** 4×2 and taller: the day, then the lines that fit, then 「ほか n 件」. */
@Composable
private fun TodayList(context: Context, snapshot: TodayWidgetSnapshot, today: LocalDate, rows: List<TodayRow>, heightDp: Float) {
    val fit = UnreadWidgetRules.rowsThatFit(heightDp, usedDp = 16f + 22f + 16f, rowDp = TodayWidget.ROW_DP, max = TodayWidget.MAX_SHOWN)
    val shown = if (rows.size > fit) rows.take((fit - 1).coerceAtLeast(0)) else rows
    Column(GlanceModifier.fillMaxSize()) {
        DayLine(snapshot, today, workspace = true)
        Spacer(GlanceModifier.height(4.dp))
        if (rows.isEmpty()) Empty()
        Column(GlanceModifier.fillMaxWidth()) { shown.forEach { TodayLine(context, snapshot, it, today) } }
        if (shown.size < rows.size) WidgetSmallLine(L10n.str(R.string.widget_more, rows.size - shown.size), GlanceModifier.padding(start = 9.dp))
    }
}

/** 4×1: the day and the counts on the left, the first two lines on the right. */
@Composable
private fun TodayWideShort(context: Context, snapshot: TodayWidgetSnapshot, today: LocalDate, rows: List<TodayRow>, tasks: Int, overdue: Boolean) {
    Row(GlanceModifier.fillMaxSize(), verticalAlignment = Alignment.CenterVertically) {
        Column(GlanceModifier.width(96.dp)) {
            DayLine(snapshot, today, workspace = false)
            WidgetSmallLine(snapshot.workspaceName)
            TasksLine(context, snapshot, tasks, overdue)
        }
        Spacer(GlanceModifier.width(6.dp))
        Column(GlanceModifier.defaultWeight().fillMaxHeight(), verticalAlignment = Alignment.CenterVertically) {
            if (rows.isEmpty()) Empty()
            rows.take(2).forEach { TodayLine(context, snapshot, it, today) }
        }
    }
}

/** 「タスク n 件」 (red with an overdue one among them); a tap opens 「タスク」. */
@Composable
private fun TasksLine(context: Context, snapshot: TodayWidgetSnapshot, tasks: Int, overdue: Boolean) {
    val text = if (tasks == 0) L10n.str(R.string.today_widget_no_tasks) else L10n.str(R.string.today_widget_tasks, tasks)
    val open = actionStartActivity(WidgetLinks.intent(context, WidgetLink.Screen(snapshot.serverUrl, WidgetScreen.TASKS)))
    val label = L10n.str(R.string.today_widget_tasks_open, text)
    Text(
        text, maxLines = 1,
        modifier = GlanceModifier.clickable(open).semantics { contentDescription = label },
        style = TextStyle(
            color = if (overdue) OVERDUE else if (tasks > 0) GlanceTheme.colors.onSurface else GlanceTheme.colors.onSurfaceVariant,
            fontSize = 12.sp, fontWeight = if (tasks > 0) FontWeight.Medium else FontWeight.Normal,
        ),
    )
}

/**
 * 2×1 / 2×2: the next event and the number of tasks due. Short: one line 「14:00〜15:00 ゼミ」 (the day above it when there
 * is room); tall: the day and the workspace, the time over the title, then the rest of the day's events as fit.
 */
@Composable
private fun TodayCompact(
    context: Context, snapshot: TodayWidgetSnapshot, today: LocalDate, now: Instant, tasks: Int, overdue: Boolean, tall: Boolean, heightDp: Float,
) {
    val next = TodayWidgetRules.next(snapshot, today, now)
    val later = if (tall && next != null) {
        val fit = UnreadWidgetRules.rowsThatFit(heightDp, usedDp = 16f + 22f + 6f + 40f + 22f, rowDp = 20f, max = 4)
        TodayWidgetRules.laterToday(snapshot, today, now, next).take(fit)
    } else emptyList()
    val showDay = tall || LocalSize.current.height >= 72.dp
    Column(GlanceModifier.fillMaxSize(), verticalAlignment = if (tall) Alignment.Top else Alignment.CenterVertically) {
        if (showDay) DayLine(snapshot, today, workspace = tall)
        if (tall) Spacer(GlanceModifier.height(6.dp))
        if (next == null) {
            Empty()
        } else {
            val time = timeText(next, today)
            val label = L10n.str(R.string.today_widget_event_row, time, next.title)
            val modifier = GlanceModifier.fillMaxWidth().cornerRadius(6.dp)
                .clickable(actionStartActivity(WidgetLinks.intent(context, eventLink(snapshot, next, today))))
                .semantics { contentDescription = label }
            if (tall) {
                Column(modifier) {
                    Text(time, maxLines = 1, style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 11.sp))
                    Text(next.title, maxLines = if (later.isEmpty()) 2 else 1, style = TextStyle(color = GlanceTheme.colors.onSurface, fontSize = 14.sp, fontWeight = FontWeight.Bold))
                }
                if (later.isNotEmpty()) Spacer(GlanceModifier.height(4.dp))
                later.forEach { event ->
                    val laterTime = timeText(event, today)
                    val laterLabel = L10n.str(R.string.today_widget_event_row, laterTime, event.title)
                    Text(
                        "$laterTime  ${event.title}", maxLines = 1,
                        modifier = GlanceModifier.fillMaxWidth().height(20.dp)
                            .clickable(actionStartActivity(WidgetLinks.intent(context, eventLink(snapshot, event, today))))
                            .semantics { contentDescription = laterLabel },
                        style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 12.sp),
                    )
                }
            } else {
                Row(modifier, verticalAlignment = Alignment.CenterVertically) {
                    Text(time, maxLines = 1, style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 11.sp))
                    Spacer(GlanceModifier.width(4.dp))
                    Text(next.title, maxLines = 1, style = TextStyle(color = GlanceTheme.colors.onSurface, fontSize = 13.sp, fontWeight = FontWeight.Bold))
                }
            }
        }
        if (tall) Spacer(GlanceModifier.defaultWeight())
        TasksLine(context, snapshot, tasks, overdue)
    }
}
