package jp.chikuwachat.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Place
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.api.CalendarEventOut
import jp.chikuwachat.android.api.TaskOut
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.sync.CalendarHub
import jp.chikuwachat.android.sync.CalendarWindow
import jp.chikuwachat.android.sync.CalendarWindowState
import jp.chikuwachat.android.sync.ChannelState
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import java.time.LocalDate
import jp.chikuwachat.android.R
import jp.chikuwachat.android.L10n
import androidx.compose.ui.res.stringResource

/** M52: the event form to show: an event (null = a new one from `initial`). */
data class CalendarForm(val event: CalendarEventOut?, val initial: EventDraft?)

/** The calendar's changes as Compose state (0 without a hub): the screens read their windows again on each. */
@Composable
fun calendarVersion(hub: CalendarHub?): Int {
    val flow = remember(hub) { hub?.version ?: MutableStateFlow(0) }
    return flow.collectAsState().value
}

/** Today, turning over at midnight while the screen stays open. */
@Composable
internal fun rememberToday(): LocalDate {
    val today by produceState(CalendarDates.today()) {
        while (true) {
            delay(60_000)
            val now = CalendarDates.today()
            if (now != value) value = now
        }
    }
    return today
}

/** The line a range shows when it could not be read. */
private fun windowNote(window: CalendarWindow?, available: Boolean): String? = when {
    !available -> L10n.str(R.string.calendar_screen_this_server_doesnt_support_the_calendar)
    window?.state == CalendarWindowState.UNSUPPORTED -> L10n.str(R.string.calendar_screen_this_server_doesnt_support_the_calendar)
    window?.state == CalendarWindowState.FAILED -> L10n.str(R.string.calendar_screen_couldnt_load_events_they_will_reload)
    else -> null
}

private const val MODE_KEY = "calendar.mode"

/**
 * M52 (CALENDAR.md §7, phone column): the calendar from the home's tile. 「一覧」: the days with events from today, 60 days
 * at a time; 「月」: the month with a dot per calendar on the days with events, and the chosen day's events under it.
 * Filter すべて / 自分 / each channel (its fixed colour). 「＋」 adds an event on the day shown (in the filtered channel when
 * I may add there).
 */
@Composable
fun CalendarPane(controller: AppController, version: Int) {
    val hub = controller.calendar
    val calendarVersion = calendarVersion(hub)
    val today = rememberToday()
    var mode by rememberSaveable { mutableStateOf(CalendarMode.entries.firstOrNull { it.name == controller.prefs.getString(MODE_KEY) } ?: CalendarMode.LIST) }
    var anchorText by rememberSaveable { mutableStateOf(today.toString()) }
    var selectedText by rememberSaveable { mutableStateOf(today.toString()) }
    var filter by rememberSaveable { mutableStateOf(CalendarDates.FILTER_ALL) }
    val anchor = LocalDate.parse(anchorText)
    val selected = LocalDate.parse(selectedText)
    val (start, end) = CalendarDates.rangeFor(mode, anchor)
    val (from, to) = CalendarDates.rangeParams(start, end)
    LaunchedEffect(hub, from, to) { hub?.open(WINDOW_KEY, from, to) }
    DisposableEffect(hub) { onDispose { hub?.close(WINDOW_KEY) } }
    val window = remember(calendarVersion, hub) { hub?.window(WINDOW_KEY) }
    val channels = remember(version) { controller.calendarChannels() }
    // A channel left (or a filter from before) falls back to all.
    if (filter != CalendarDates.FILTER_ALL && filter != CalendarDates.FILTER_ME && channels.none { it.id == filter }) filter = CalendarDates.FILTER_ALL
    val events = remember(window, filter) { CalendarDates.filterEvents(window?.events ?: emptyList(), filter) }
    val loading = window == null || window.state == CalendarWindowState.LOADING
    // M56 (TASKS.md §6): the tasks due in the range, as all-day rows 「☐ 題名」; a tap opens the task.
    val taskHub = controller.tasks
    val taskChanges = taskVersion(taskHub)
    LaunchedEffect(taskHub, start, end) { if (taskHub?.available == true) taskHub.openDue(TASK_WINDOW_KEY, start.toString(), end.toString()) }
    DisposableEffect(taskHub) { onDispose { taskHub?.closeDue(TASK_WINDOW_KEY) } }
    val dueTasks = remember(taskChanges, taskHub, filter) {
        TaskRules.filterTasks(taskHub?.dueWindow(TASK_WINDOW_KEY)?.tasks ?: emptyList(), filter, controller.store.me?.id)
    }
    val openTask: (TaskOut) -> Unit = { controller.taskForm = TaskForm(it, null) }

    fun setMode(next: CalendarMode) {
        controller.prefs.putString(MODE_KEY, next.name)
        mode = next
        anchorText = today.toString()
        selectedText = today.toString()
    }
    fun step(direction: Long) {
        anchorText = when (mode) {
            CalendarMode.MONTH -> CalendarDates.addMonths(anchor, direction)
            CalendarMode.LIST -> anchor.plusDays(CalendarDates.LIST_DAYS * direction)
        }.toString()
        if (mode == CalendarMode.MONTH) selectedText = LocalDate.parse(anchorText).let { if (it.month == today.month && it.year == today.year) today else it }.toString()
    }
    fun create(day: LocalDate) {
        val writable = controller.writableCalendars()
        val calendar = filter.takeIf { id -> writable.any { it.id == id } }
        controller.calendarForm = CalendarForm(null, CalendarDates.newDraft(day, calendar))
    }

    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize()) {
            SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
                CalendarMode.entries.forEachIndexed { index, entry ->
                    SegmentedButton(
                        selected = mode == entry,
                        onClick = { setMode(entry) },
                        shape = SegmentedButtonDefaults.itemShape(index, CalendarMode.entries.size),
                    ) { Text(entry.label) }
                }
            }
            CalendarFilterRow(channels, filter, onFilter = { filter = it })
            Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                IconButton(onClick = { step(-1) }) { Icon(Icons.AutoMirrored.Filled.KeyboardArrowLeft, contentDescription = stringResource(R.string.calendar_screen_previous)) }
                Text(
                    CalendarDates.rangeTitle(mode, anchor), style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center,
                    modifier = Modifier.weight(1f).semantics { heading() },
                )
                IconButton(onClick = { step(1) }) { Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = stringResource(R.string.common_next)) }
                TextButton(onClick = { anchorText = today.toString(); selectedText = today.toString() }) { Text(stringResource(R.string.common_today)) }
            }
            windowNote(window, hub?.available == true)?.let { NoteStrip(it) }
            HorizontalDivider()
            when (mode) {
                CalendarMode.LIST -> AgendaList(
                    events, start, end, today, onOpen = { controller.calendarForm = CalendarForm(it, null) }, loading = loading,
                    modifier = Modifier.weight(1f), tasks = dueTasks, onOpenTask = openTask,
                )
                CalendarMode.MONTH -> {
                    MonthGrid(anchor, events, today, selected, onSelect = { selectedText = it.toString() }, tasks = dueTasks)
                    HorizontalDivider()
                    DayList(events, selected, today, onOpen = { controller.calendarForm = CalendarForm(it, null) }, modifier = Modifier.weight(1f), tasks = dueTasks, onOpenTask = openTask)
                }
            }
        }
        if (hub?.available == true) {
            FloatingActionButton(
                onClick = { create(if (mode == CalendarMode.MONTH) selected else maxOf(today, anchor)) },
                modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp),
            ) { Icon(Icons.Default.Add, contentDescription = stringResource(R.string.common_add_event)) }
        }
    }
}

private const val WINDOW_KEY = "view"
private const val TASK_WINDOW_KEY = "calendar"

/** すべて / 自分 / each channel I belong to (with its colour). */
@Composable
private fun CalendarFilterRow(channels: List<ChannelState>, filter: String, onFilter: (String) -> Unit) {
    LazyRow(contentPadding = PaddingValues(horizontal = 12.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        item(key = "all") { FilterChip(selected = filter == CalendarDates.FILTER_ALL, onClick = { onFilter(CalendarDates.FILTER_ALL) }, label = { Text(stringResource(R.string.common_all)) }) }
        item(key = "me") {
            FilterChip(
                selected = filter == CalendarDates.FILTER_ME, onClick = { onFilter(CalendarDates.FILTER_ME) }, label = { Text(stringResource(R.string.common_you)) },
                leadingIcon = { ColorDot(null) },
            )
        }
        items(channels, key = { it.id }) { channel ->
            FilterChip(
                selected = filter == channel.id, onClick = { onFilter(channel.id) },
                label = { Text("#" + (channel.channel.name ?: ""), maxLines = 1) },
                leadingIcon = { ColorDot(channel.id) },
            )
        }
    }
}

@Composable
private fun ColorDot(channelId: String?, size: Int = 10) {
    Box(Modifier.size(size.dp).background(Color(CalendarDates.channelColor(channelId)), CircleShape))
}

@Composable
internal fun NoteStrip(text: String) {
    Text(
        text, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.errorContainer.copy(alpha = 0.4f)).padding(horizontal = 16.dp, vertical = 6.dp),
    )
}

/** Day by day, the days with events only (「今日」 and 「明日」 marked). */
@Composable
fun AgendaList(
    events: List<CalendarEventOut>, start: LocalDate, end: LocalDate, today: LocalDate, onOpen: (CalendarEventOut) -> Unit,
    loading: Boolean, modifier: Modifier = Modifier, empty: String = L10n.str(R.string.calendar_screen_no_events_in_this_period), showCalendar: Boolean = true,
    /** M56: the tasks due in the range (all-day rows after the all-day events). */
    tasks: List<TaskOut> = emptyList(), onOpenTask: (TaskOut) -> Unit = {},
) {
    val days = remember(events, tasks, start, end) { TaskRules.agendaDays(CalendarDates.agenda(events, start, end), tasks, start, end) }
    if (days.isEmpty()) {
        EmptyNote(if (loading) L10n.str(R.string.common_loading) else empty, modifier)
        return
    }
    LazyColumn(modifier.fillMaxWidth(), contentPadding = PaddingValues(bottom = 88.dp)) {
        days.forEach { (day, list) ->
            item(key = "d:$day") { DayHeader(day, today) }
            dayRows(day, list, tasks, onOpen, onOpenTask, showCalendar)
        }
    }
}

/** A day's rows: all-day events (and those running through it), the tasks due, then the timed events (as the web's). */
private fun androidx.compose.foundation.lazy.LazyListScope.dayRows(
    day: LocalDate, events: List<CalendarEventOut>, tasks: List<TaskOut>, onOpen: (CalendarEventOut) -> Unit, onOpenTask: (TaskOut) -> Unit,
    showCalendar: Boolean,
) {
    val (allDay, timed) = events.partition { CalendarDates.timeOnDay(it, day) == L10n.str(R.string.common_all_day) }
    items(allDay, key = { "e:$day:${it.id}" }) { event -> EventRow(event, day, onOpen, showCalendar) }
    items(TaskRules.tasksForDay(tasks, day.toString()), key = { "t:$day:${it.id}" }) { task -> TaskDayRow(task, onOpenTask, showBoard = showCalendar) }
    items(timed, key = { "e:$day:${it.id}" }) { event -> EventRow(event, day, onOpen, showCalendar) }
}

@Composable
internal fun EmptyNote(text: String, modifier: Modifier = Modifier) {
    Box(modifier.fillMaxWidth().padding(vertical = 48.dp), contentAlignment = Alignment.TopCenter) {
        Text(text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun DayHeader(day: LocalDate, today: LocalDate) {
    val isToday = day == today
    Row(
        Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 4.dp).semantics(mergeDescendants = true) { heading() },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val color = if (isToday) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant
        Text(CalendarDates.dayLabel(day), style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold, color = color)
        when (day) {
            today -> Text(stringResource(R.string.calendar_screen_today), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary)
            today.plusDays(1) -> Text(stringResource(R.string.calendar_screen_tomorrow), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/** An event on a day: its time there, its calendar's colour, its title, calendar and place. */
@Composable
private fun EventRow(event: CalendarEventOut, day: LocalDate, onOpen: (CalendarEventOut) -> Unit, showCalendar: Boolean) {
    val calendar = event.channelName?.let { "#$it" } ?: stringResource(R.string.common_you)
    val time = CalendarDates.timeOnDay(event, day)
    // M69: a recurring event's occurrence says so, with its rule in words (「🔁 毎週 火曜日」).
    val repeat = remember(event) { CalendarDates.repeatLine(event) }
    Row(
        Modifier.fillMaxWidth().heightIn(min = TouchTarget.MIN).clickable(onClickLabel = stringResource(R.string.common_open)) { onOpen(event) }
            .padding(horizontal = 16.dp, vertical = 8.dp)
            .semantics(mergeDescendants = true) {
                contentDescription = L10n.str(R.string.calendar_screen_event_description, time, event.title, calendar) + (event.location?.let { L10n.str(R.string.common_comma_then, it) } ?: "") +
                    (repeat?.let { L10n.str(R.string.calendar_screen_repeats) + it.removePrefix("🔁 ") } ?: "")
            },
        verticalAlignment = Alignment.Top,
    ) {
        Text(time, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.width(92.dp).padding(top = 2.dp))
        Box(Modifier.padding(top = 3.dp).width(4.dp).height(16.dp).background(Color(CalendarDates.channelColor(event.channelId)), RoundedCornerShape(2.dp)))
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(event.title, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium, maxLines = 2, overflow = TextOverflow.Ellipsis)
            val details = listOfNotNull(calendar.takeIf { showCalendar }, event.location?.takeIf { it.isNotBlank() })
            if (details.isNotEmpty()) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (showCalendar) Text(calendar, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
                    event.location?.takeIf { it.isNotBlank() }?.let { place ->
                        if (showCalendar) Spacer(Modifier.width(8.dp))
                        Icon(Icons.Default.Place, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(12.dp))
                        Text(place, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
            repeat?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis) }
        }
    }
}

/** The month, Sunday first (日 red, 土 blue): a dot per calendar (up to 3) on the days with events; a tap picks the day. */
@Composable
private fun MonthGrid(
    anchor: LocalDate, events: List<CalendarEventOut>, today: LocalDate, selected: LocalDate, onSelect: (LocalDate) -> Unit,
    tasks: List<TaskOut> = emptyList(),
) {
    val weeks = remember(anchor) { CalendarDates.monthGrid(anchor) }
    val dots = remember(events, tasks, anchor) {
        val first = weeks.first().first()
        val last = weeks.last().last()
        val out = HashMap<LocalDate, MutableList<String?>>()
        events.forEach { event ->
            CalendarDates.busyDays(listOf(event), first, last.plusDays(1)).forEach { day ->
                val list = out.getOrPut(day) { ArrayList() }
                if (event.channelId !in list) list += event.channelId
            }
        }
        // M56: a task's day gets its board's dot too.
        tasks.forEach { task ->
            val day = task.dueOn?.let { runCatching { LocalDate.parse(it) }.getOrNull() } ?: return@forEach
            val list = out.getOrPut(day) { ArrayList() }
            if (task.channelId !in list) list += task.channelId
        }
        out
    }
    Column(Modifier.fillMaxWidth().padding(horizontal = 8.dp)) {
        Row(Modifier.fillMaxWidth()) {
            (0 until 7).forEach { index ->
                Text(
                    CalendarDates.weekdayLabel(index), style = MaterialTheme.typography.labelSmall, textAlign = TextAlign.Center,
                    color = weekdayColor(index) ?: MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f).padding(vertical = 4.dp),
                )
            }
        }
        weeks.forEach { week ->
            Row(Modifier.fillMaxWidth()) {
                week.forEachIndexed { index, day ->
                    val inMonth = day.month == anchor.month
                    val chosen = day == selected
                    val count = dots[day]?.size ?: 0
                    Column(
                        Modifier.weight(1f).aspectRatio(1.1f).padding(1.dp)
                            .background(if (chosen) MaterialTheme.colorScheme.secondaryContainer else Color.Transparent, RoundedCornerShape(8.dp))
                            .clickable(onClickLabel = stringResource(R.string.calendar_screen_events_on_this_day)) { onSelect(day) }
                            .semantics(mergeDescendants = true) { contentDescription = CalendarDates.dayLabel(day) + if (count > 0) L10n.str(R.string.calendar_screen_has_events) else "" },
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.Center,
                    ) {
                        val base = weekdayColor(index) ?: MaterialTheme.colorScheme.onSurface
                        val numberModifier = if (day == today) Modifier.size(26.dp).border(1.5.dp, MaterialTheme.colorScheme.primary, CircleShape) else Modifier.size(26.dp)
                        Box(numberModifier, contentAlignment = Alignment.Center) {
                            Text(
                                day.dayOfMonth.toString(), style = MaterialTheme.typography.bodyMedium,
                                fontWeight = if (day == today) FontWeight.Bold else FontWeight.Normal,
                                color = if (inMonth) base else base.copy(alpha = 0.4f),
                            )
                        }
                        Row(Modifier.height(8.dp), horizontalArrangement = Arrangement.spacedBy(2.dp), verticalAlignment = Alignment.CenterVertically) {
                            dots[day]?.take(3)?.forEach { channelId -> ColorDot(channelId, size = 5) }
                        }
                    }
                }
            }
        }
    }
}

internal fun weekdayColor(index: Int): Color? = when (index) {
    0 -> Color(0xFFDC2626)
    6 -> Color(0xFF2563EB)
    else -> null
}

/** The month's chosen day: its events. */
@Composable
private fun DayList(
    events: List<CalendarEventOut>, day: LocalDate, today: LocalDate, onOpen: (CalendarEventOut) -> Unit, modifier: Modifier = Modifier,
    tasks: List<TaskOut> = emptyList(), onOpenTask: (TaskOut) -> Unit = {},
) {
    val list = remember(events, day) { CalendarDates.eventsOn(events, day) }
    val due = remember(tasks, day) { tasks.any { it.dueOn == day.toString() } }
    LazyColumn(modifier.fillMaxWidth(), contentPadding = PaddingValues(bottom = 88.dp)) {
        item(key = "h") { DayHeader(day, today) }
        if (list.isEmpty() && !due) item(key = "empty") { EmptyNote(L10n.str(R.string.calendar_screen_no_events_on_this_day)) }
        dayRows(day, list, tasks, onOpen, onOpenTask, showCalendar = true)
    }
}

/**
 * M52: a channel's 「予定」 tab (CALENDAR.md §7): its events for the next 60 days, and 「予定を追加」 for those who may post.
 */
@Composable
fun ChannelEventsPane(controller: AppController, channel: ChannelState, version: Int) {
    val hub = controller.calendar
    val calendarVersion = calendarVersion(hub)
    val today = rememberToday()
    val end = today.plusDays(CalendarDates.LIST_DAYS)
    val (from, to) = CalendarDates.rangeParams(today, end)
    val key = "channel:" + channel.id
    LaunchedEffect(hub, key, from, to) { hub?.open(key, from, to, channel.id) }
    DisposableEffect(hub, key) { onDispose { hub?.close(key) } }
    val window = remember(calendarVersion, hub, key) { hub?.window(key) }
    val canAdd = remember(version, channel.id) { controller.writableCalendars().any { it.id == channel.id } }
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp, top = 4.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(stringResource(R.string.calendar_screen_next_days, CalendarDates.LIST_DAYS), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
            if (canAdd && hub?.available == true) {
                FilledTonalButton(onClick = { controller.calendarForm = CalendarForm(null, CalendarDates.newDraft(today, channel.id)) }) {
                    Icon(Icons.Default.Add, contentDescription = null, modifier = Modifier.size(16.dp))
                    Text(stringResource(R.string.calendar_screen_add_event))
                }
            }
        }
        windowNote(window, hub?.available == true)?.let { NoteStrip(it) }
        HorizontalDivider()
        AgendaList(
            window?.events ?: emptyList(), today, end, today, onOpen = { controller.calendarForm = CalendarForm(it, null) },
            loading = hub?.available == true && (window == null || window.state == CalendarWindowState.LOADING),
            modifier = Modifier.weight(1f), empty = stringResource(R.string.calendar_screen_no_upcoming_events), showCalendar = false,
        )
    }
}
