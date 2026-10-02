package jp.chikuwachat.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Place
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.view.WindowCompat
import jp.chikuwachat.android.app.AppController
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.util.UUID

/** The form's fields across a rotation (the form itself stays open: the controller holds it). */
val EventDraftSaver = listSaver<EventDraft, String>(
    save = { draft ->
        listOf(
            draft.title, draft.allDay.toString(), draft.startDay.toString(), draft.startTime.toString(), draft.endDay.toString(), draft.endTime.toString(),
            draft.calendar ?: "", draft.location, draft.description, draft.alarm?.toString() ?: "", CalendarRecurrence.save(draft.repeat),
        )
    },
    restore = { fields ->
        val start = LocalDate.parse(fields[2])
        EventDraft(
            title = fields[0], allDay = fields[1].toBoolean(), startDay = start, startTime = LocalTime.parse(fields[3]),
            endDay = LocalDate.parse(fields[4]), endTime = LocalTime.parse(fields[5]), calendar = fields[6].ifEmpty { null },
            location = fields[7], description = fields[8], alarm = fields[9].toIntOrNull(),
            repeat = fields.getOrNull(10)?.let { CalendarRecurrence.restore(it, start) } ?: CalendarRecurrence.noRepeat(start),
        )
    },
)

/** Which picker is up over the form (UNTIL: 「繰り返し」's last day). */
private enum class FormPicker { START_DAY, START_TIME, END_DAY, END_TIME, UNTIL }

/** M69: saving or deleting an occurrence of a recurring event asks which ones (the scopes offered). */
private data class ScopeAsk(val deleting: Boolean, val scopes: List<OccurrenceScope>)

/**
 * M52 (CALENDAR.md §7, phone column): an event's full-screen form. New: 題名, 終日, 開始 / 終了 (Material date and time
 * pickers in the device's zone; timed events go out as UTC instants, all-day ones as dates), カレンダー (自分 or a channel I
 * may post in; not DMs), 場所, 説明 and my 通知. Someone who may not change the event (`can_edit` false) sees it read-only,
 * with only their own alarm to set. Deleting asks first.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CalendarEventForm(controller: AppController, form: CalendarForm, onDismiss: () -> Unit) {
    val hub = controller.calendar
    val event = form.event
    val initial = remember(form) { event?.let { CalendarDates.draftFromEvent(it) } ?: form.initial ?: CalendarDates.newDraft(CalendarDates.today()) }
    var draft by rememberSaveable(form, stateSaver = EventDraftSaver) { mutableStateOf(initial) }
    var busy by remember(form) { mutableStateOf(false) }
    var error by rememberSaveable(form) { mutableStateOf<String?>(null) }
    var confirmDelete by rememberSaveable(form) { mutableStateOf(false) }
    var picker by rememberSaveable(form) { mutableStateOf<FormPicker?>(null) }
    // The idempotency key of this form's create (CALENDAR.md §9 4.): a retry after a lost answer returns the same event.
    val clientId = rememberSaveable(form) { UUID.randomUUID().toString() }
    val editable = event == null || event.canEdit
    val recurring = event?.recurring == true
    var askScope by remember(form) { mutableStateOf<ScopeAsk?>(null) }
    val calendars = remember(form) { controller.writableCalendars() }
    val alarmChanged = event?.alarm?.minutesBefore != draft.alarm
    fun change(next: EventDraft) {
        draft = next
        error = null
    }

    /** Runs a change, closing the form when it went through and saying why when not. */
    fun attempt(block: suspend () -> Unit) {
        busy = true
        controller.scope.launch {
            try {
                block()
                onDismiss()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = controller.describe(e)
            } finally {
                busy = false
            }
        }
    }

    fun save() {
        if (hub == null || busy) return
        val problem = if (editable) CalendarDates.draftProblem(draft) else null
        if (problem != null) {
            error = problem
            return
        }
        // M69: a change to an occurrence of a series (not only my alarm) asks which occurrences it is for.
        if (event != null && recurring && editable && CalendarDates.occurrenceChanged(draft, initial, event.rrule)) {
            askScope = ScopeAsk(deleting = false, scopes = CalendarDates.scopesFor(false, draft, event))
            return
        }
        attempt {
            if (event == null) {
                hub.create(CalendarDates.draftToCreate(draft, ZoneId.systemDefault().id, clientId))
            } else {
                if (editable && !recurring) hub.update(event.id, CalendarDates.draftToPatch(draft, ZoneId.systemDefault().id))
                // The server remaps the alarm when the event turns all-day (or back); what was chosen here wins. A series'
                // alarm is the series' (every occurrence).
                if (alarmChanged || (editable && draft.allDay != event.allDay && draft.alarm != null)) hub.setAlarm(event.series, draft.alarm)
            }
        }
    }

    fun remove() {
        if (hub == null || event == null || busy) return
        attempt { hub.remove(event.id) }
    }

    /** M69: a recurring event's occurrence saved or deleted, for the occurrences chosen. */
    fun applyScope(ask: ScopeAsk, scope: OccurrenceScope) {
        if (hub == null || event == null || busy) return
        askScope = null
        attempt {
            if (ask.deleting) {
                hub.removeOccurrence(event.series, event.occurrenceKey, scope)
            } else {
                val result = hub.updateOccurrence(event.series, event.occurrenceKey, CalendarDates.occurrenceUpdate(scope, draft, initial, event.rrule))
                if (alarmChanged) hub.setAlarm(result.series, draft.alarm)
            }
        }
    }

    val formTitle = when {
        event == null -> "予定を追加"
        editable -> "予定を編集"
        else -> "予定"
    }
    val canSave = !busy && hub != null && (editable || alarmChanged)
    // Full screen, edge to edge like the app's pages (as 新しいメッセージ).
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        val view = LocalView.current
        val lightBars = !isSystemInDarkTheme()
        SideEffect {
            (view.parent as? DialogWindowProvider)?.window?.let { window ->
                WindowCompat.getInsetsController(window, view).apply {
                    isAppearanceLightStatusBars = lightBars
                    isAppearanceLightNavigationBars = lightBars
                }
            }
        }
        Surface(Modifier.fillMaxSize()) {
            Column(Modifier.fillMaxSize().systemBarsPadding().imePadding()) {
                Row(Modifier.fillMaxWidth().padding(4.dp), verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = onDismiss) { Icon(Icons.Default.Close, contentDescription = "閉じる") }
                    Text(formTitle, style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f).semantics { heading() })
                    if (editable || event != null) {
                        TextButton(enabled = canSave, onClick = ::save) { Text(if (busy) "保存中…" else "保存") }
                    }
                }
                HorizontalDivider()
                Column(
                    Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState()).padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    if (editable) {
                        OutlinedTextField(
                            value = draft.title, onValueChange = { change(draft.copy(title = it.take(CalendarDates.MAX_TITLE))) },
                            label = { Text("題名") }, placeholder = { Text("ゼミ") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                        )
                        // The whole row switches (the label too), read as one switch.
                        Row(
                            Modifier.fillMaxWidth().toggleable(value = draft.allDay, role = Role.Switch, onValueChange = { change(CalendarDates.withAllDay(draft, it)) }),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Text("終日", style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
                            Switch(checked = draft.allDay, onCheckedChange = null)
                        }
                        WhenRow("開始", draft.startDay, draft.startTime.takeIf { !draft.allDay }, onDay = { picker = FormPicker.START_DAY }, onTime = { picker = FormPicker.START_TIME })
                        WhenRow("終了", draft.endDay, draft.endTime.takeIf { !draft.allDay }, onDay = { picker = FormPicker.END_DAY }, onTime = { picker = FormPicker.END_TIME })
                        RepeatSection(draft.repeat, draft.startDay, onChange = { change(draft.copy(repeat = it)) }, onPickUntil = { picker = FormPicker.UNTIL })
                        val calendarName = calendarName(controller, draft.calendar, event?.channelName)
                        if (event == null) {
                            ChoiceField(
                                "カレンダー", calendarName, dot = draft.calendar ?: OWN,
                                options = listOf<Pair<String?, String>>(null to "自分") + calendars.map { it.id to "#" + (it.channel.name ?: "") },
                                onPick = { change(draft.copy(calendar = it)) },
                            )
                        } else {
                            // An event cannot move to another calendar (PATCH has no channel_id).
                            ChoiceField<String?>("カレンダー", calendarName, dot = draft.calendar ?: OWN, options = emptyList(), enabled = false, onPick = {})
                        }
                        OutlinedTextField(
                            value = draft.location, onValueChange = { change(draft.copy(location = it.take(CalendarDates.MAX_LOCATION))) },
                            label = { Text("場所") }, placeholder = { Text("5 号館 301 または URL") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                        )
                        OutlinedTextField(
                            value = draft.description, onValueChange = { change(draft.copy(description = it.take(CalendarDates.MAX_DESCRIPTION))) },
                            label = { Text("説明") }, minLines = 3, modifier = Modifier.fillMaxWidth(),
                        )
                    } else if (event != null) {
                        ReadOnlyEvent(controller, event)
                    }
                    ChoiceField(
                        "通知", CalendarDates.alarmLabel(draft.alarm, draft.allDay),
                        options = CalendarDates.alarmChoices(draft.allDay).map { it.value to it.label },
                        enabled = hub != null,
                        onPick = { change(draft.copy(alarm = it)) },
                    )
                    Text(
                        if (draft.allDay) "終日の予定の通知は 8:00 に届きます (タイムゾーン: ${ZoneId.systemDefault().id})" else "タイムゾーン: ${ZoneId.systemDefault().id}",
                        style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium) }
                    if (event != null && editable) {
                        Spacer(Modifier.size(8.dp))
                        TextButton(enabled = !busy, onClick = {
                            if (recurring) askScope = ScopeAsk(deleting = true, scopes = OccurrenceScope.entries) else confirmDelete = true
                        }) {
                            Icon(Icons.Default.Delete, contentDescription = null, tint = MaterialTheme.colorScheme.error, modifier = Modifier.size(18.dp))
                            Text(" 予定を削除", color = MaterialTheme.colorScheme.error)
                        }
                    }
                }
            }
        }
        when (picker) {
            FormPicker.START_DAY, FormPicker.END_DAY, FormPicker.UNTIL -> {
                val which = picker
                val shown = when (which) {
                    FormPicker.START_DAY -> draft.startDay
                    FormPicker.UNTIL -> draft.repeat.until ?: draft.startDay
                    else -> draft.endDay
                }
                val state = rememberDatePickerState(initialSelectedDateMillis = Schedule.pickerMillis(shown))
                DatePickerDialog(
                    onDismissRequest = { picker = null },
                    confirmButton = {
                        TextButton(enabled = state.selectedDateMillis != null, onClick = {
                            state.selectedDateMillis?.let { millis ->
                                val day = Schedule.pickerDate(millis)
                                change(
                                    when (which) {
                                        FormPicker.START_DAY -> CalendarDates.withStart(draft, day)
                                        FormPicker.UNTIL -> draft.copy(repeat = draft.repeat.copy(until = day))
                                        else -> draft.copy(endDay = day)
                                    },
                                )
                            }
                            picker = null
                        }) { Text("決定") }
                    },
                    dismissButton = { TextButton(onClick = { picker = null }) { Text("キャンセル") } },
                ) { DatePicker(state = state) }
            }
            FormPicker.START_TIME, FormPicker.END_TIME -> {
                val start = picker == FormPicker.START_TIME
                val time = if (start) draft.startTime else draft.endTime
                TimePickDialog(time.hour, time.minute, title = if (start) "開始時刻" else "終了時刻", onDismiss = { picker = null }) { h, m ->
                    val picked = LocalTime.of(h, m)
                    change(if (start) CalendarDates.withStart(draft, draft.startDay, picked) else draft.copy(endTime = picked))
                    picker = null
                }
            }
            null -> Unit
        }
        if (confirmDelete && event != null) {
            AlertDialog(
                onDismissRequest = { confirmDelete = false },
                title = { Text("予定を削除しますか？") },
                text = {
                    Text(
                        "「${event.title}」を削除します。" + if (event.channelId != null) "チャンネルのメンバー全員のカレンダーから消えます。" else "",
                    )
                },
                confirmButton = { TextButton(onClick = { confirmDelete = false; remove() }) { Text("削除", color = MaterialTheme.colorScheme.error) } },
                dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text("キャンセル") } },
            )
        }
        askScope?.let { ask ->
            // M69 (CALENDAR.md §10.7): 「この予定」「これ以降すべて」「すべての予定」 (「この予定」 only when the change fits one occurrence).
            AlertDialog(
                onDismissRequest = { askScope = null },
                title = { Text(if (ask.deleting) "繰り返しの予定の削除" else "繰り返しの予定の変更") },
                text = {
                    Column(Modifier.fillMaxWidth()) {
                        ask.scopes.forEach { scope ->
                            TextButton(onClick = { applyScope(ask, scope) }, modifier = Modifier.fillMaxWidth()) {
                                Text(
                                    scope.label, modifier = Modifier.fillMaxWidth(),
                                    color = if (ask.deleting) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
                                )
                            }
                        }
                    }
                },
                confirmButton = {},
                dismissButton = { TextButton(onClick = { askScope = null }) { Text("キャンセル") } },
            )
        }
    }
}

private val REPEAT_UNITS = RepeatFreq.entries

/**
 * M69 (CALENDAR.md §10.7): 「繰り返し」: しない / 毎日 / 毎週 (曜日) / 毎月 (日付・第 N 曜日・月末・最終 X 曜日) / 毎年 /
 * カスタム (間隔), 終了 (なし / 日付 / 回数) whenever it repeats, and the rule in words under it.
 */
@Composable
private fun RepeatSection(repeat: RepeatDraft, start: LocalDate, onChange: (RepeatDraft) -> Unit, onPickUntil: () -> Unit) {
    val freq = CalendarRecurrence.freq(repeat)
    val rrule = CalendarRecurrence.repeatToRrule(repeat, start)
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        ChoiceField(
            "繰り返し", repeat.kind.label, options = RepeatKind.entries.map { it to it.label },
            onPick = { kind ->
                var next = repeat.copy(kind = kind)
                if (kind == RepeatKind.CUSTOM && repeat.kind != RepeatKind.CUSTOM) next = next.copy(freq = freq ?: RepeatFreq.WEEKLY)
                if (CalendarRecurrence.freq(next) == RepeatFreq.WEEKLY && next.weekdays.isEmpty()) next = next.copy(weekdays = CalendarRecurrence.noRepeat(start).weekdays)
                onChange(next)
            },
        )
        if (repeat.kind == RepeatKind.CUSTOM) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                NumberField(repeat.interval, label = "間隔", onValue = { onChange(repeat.copy(interval = it)) })
                Box(Modifier.width(120.dp)) {
                    ChoiceField("単位", repeat.freq.label, options = REPEAT_UNITS.map { it to it.label }, onPick = { unit ->
                        var next = repeat.copy(freq = unit)
                        if (unit == RepeatFreq.WEEKLY && next.weekdays.isEmpty()) next = next.copy(weekdays = CalendarRecurrence.noRepeat(start).weekdays)
                        onChange(next)
                    })
                }
                Text("ごと", style = MaterialTheme.typography.bodyLarge)
            }
        }
        if (freq == RepeatFreq.WEEKLY) {
            Row(Modifier.fillMaxWidth().semantics { contentDescription = "曜日" }, horizontalArrangement = Arrangement.SpaceBetween) {
                CalendarRecurrence.WEEKDAY_NAMES.forEachIndexed { day, name ->
                    val on = day in repeat.weekdays
                    Box(
                        Modifier.size(40.dp)
                            .background(if (on) MaterialTheme.colorScheme.primary else Color.Transparent, CircleShape)
                            .border(1.dp, if (on) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outline, CircleShape)
                            .toggleable(value = on, role = Role.Checkbox, onValueChange = { checked ->
                                onChange(repeat.copy(weekdays = if (checked) repeat.weekdays + day else repeat.weekdays - day))
                            })
                            .semantics { contentDescription = "${name}曜日" },
                        contentAlignment = Alignment.Center,
                    ) {
                        Text(name, color = if (on) MaterialTheme.colorScheme.onPrimary else weekdayColor(day) ?: MaterialTheme.colorScheme.onSurface)
                    }
                }
            }
        }
        if (freq == RepeatFreq.MONTHLY) {
            val choices = CalendarRecurrence.monthlyChoices(start)
            val current = choices.firstOrNull { it.value == repeat.monthly }?.label ?: CalendarRecurrence.describeRrule(rrule, start)
            ChoiceField("毎月の日", current, options = choices.map { it.value to it.label }, onPick = { onChange(repeat.copy(monthly = it)) })
        }
        if (repeat.kind != RepeatKind.NONE) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Box(Modifier.width(120.dp)) {
                    ChoiceField("終了", repeat.end.label, options = RepeatEnd.entries.map { it to it.label }, onPick = { end ->
                        // A last day to start from: a month after the start (the picker changes it).
                        onChange(repeat.copy(end = end, until = repeat.until ?: if (end == RepeatEnd.UNTIL) start.plusMonths(1) else null))
                    })
                }
                when (repeat.end) {
                    RepeatEnd.UNTIL -> OutlinedButton(onClick = onPickUntil, modifier = Modifier.weight(1f).padding(top = 20.dp)) {
                        Text(repeat.until?.let { CalendarDates.dayLabel(it) + " まで" } ?: "終了日", maxLines = 1)
                    }
                    RepeatEnd.COUNT -> Row(Modifier.padding(top = 20.dp), verticalAlignment = Alignment.CenterVertically) {
                        NumberField(repeat.count, label = "回数", onValue = { onChange(repeat.copy(count = it)) })
                        Text(" 回", style = MaterialTheme.typography.bodyLarge)
                    }
                    RepeatEnd.NEVER -> Unit
                }
            }
        }
        if (rrule != null) {
            Text(
                "🔁 " + CalendarRecurrence.describeRrule(rrule, start),
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

/** A small number field (間隔, 回数): what cannot be read as a number is 0, which the form's check refuses. */
@Composable
private fun NumberField(value: Int, label: String, onValue: (Int) -> Unit) {
    var text by remember { mutableStateOf(value.toString()) }
    OutlinedTextField(
        value = text,
        onValueChange = { typed ->
            text = typed.filter { it.isDigit() }.take(3)
            onValue(text.toIntOrNull() ?: 0)
        },
        label = { Text(label) }, singleLine = true,
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
        modifier = Modifier.width(88.dp),
    )
}

/** The colour dot of my own calendar in [ChoiceField]. */
private const val OWN = ""

private fun calendarName(controller: AppController, calendar: String?, knownName: String?): String =
    if (calendar == null) "自分" else "#" + (controller.store.channel(calendar)?.channel?.name ?: knownName ?: "?")

/** 開始 / 終了: the day, and the time for a timed event, each a button that opens its picker. */
@Composable
private fun WhenRow(label: String, day: LocalDate, time: LocalTime?, onDay: () -> Unit, onTime: () -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(label, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.width(40.dp))
        OutlinedButton(onClick = onDay, modifier = Modifier.weight(1f)) { Text(CalendarDates.dayLabel(day), maxLines = 1) }
        if (time != null) OutlinedButton(onClick = onTime) { Text(CalendarDates.clock(time)) }
    }
}

/** A labelled choice (a button that opens its menu); `dot`: a calendar's colour (OWN = mine), null for none. */
@Composable
private fun <T> ChoiceField(label: String, value: String, options: List<Pair<T, String>>, onPick: (T) -> Unit, enabled: Boolean = true, dot: String? = null) {
    var open by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth()) {
        Text(label, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(bottom = 4.dp))
        Box {
            OutlinedButton(onClick = { open = true }, enabled = enabled && options.isNotEmpty(), modifier = Modifier.fillMaxWidth()) {
                if (dot != null) {
                    Box(Modifier.size(10.dp).background(Color(CalendarDates.channelColor(dot.ifEmpty { null })), CircleShape))
                    Spacer(Modifier.width(8.dp))
                }
                Text(value, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (enabled && options.isNotEmpty()) Icon(Icons.Default.ArrowDropDown, contentDescription = null)
            }
            DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                options.forEach { (key, text) ->
                    DropdownMenuItem(text = { Text(text) }, onClick = { open = false; onPick(key) })
                }
            }
        }
    }
}

/** An event I may not change: what, when, where, and the note why. */
@Composable
private fun ReadOnlyEvent(controller: AppController, event: jp.chikuwachat.android.api.CalendarEventOut) {
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        SelectionContainer { Text(event.title, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold) }
        Text(CalendarDates.eventWhen(event), style = MaterialTheme.typography.bodyLarge)
        CalendarDates.repeatLine(event)?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(10.dp).background(Color(CalendarDates.channelColor(event.channelId)), CircleShape))
            Spacer(Modifier.width(8.dp))
            Text(calendarName(controller, event.channelId, event.channelName), style = MaterialTheme.typography.bodyMedium)
        }
        event.location?.takeIf { it.isNotBlank() }?.let { place ->
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Default.Place, contentDescription = "場所", modifier = Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.width(6.dp))
                SelectionContainer { Text(place, style = MaterialTheme.typography.bodyMedium) }
            }
        }
        event.description?.takeIf { it.isNotBlank() }?.let { SelectionContainer { Text(it, style = MaterialTheme.typography.bodyMedium) } }
        Text(
            "この予定を変更できるのは作成者・チャンネルのオーナー・管理者だけです。自分の通知は付けられます。",
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        HorizontalDivider(Modifier.padding(top = 4.dp))
    }
}
