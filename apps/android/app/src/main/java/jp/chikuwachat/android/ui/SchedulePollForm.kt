package jp.chikuwachat.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowLeft
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.view.WindowCompat
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId

/** What the form starts with: empty, or what `/日程 題名 日付 …` read. */
data class SchedulePollInitial(val question: String = "", val slots: List<SlotDraft> = emptyList()) {
    /** Saveable (the composer keeps the open form across a rotation): the question, then the encoded slots. */
    fun encode(): List<String> = listOf(question) + slots.map(SchedulePolls::encode)

    companion object {
        fun decode(fields: List<String>): SchedulePollInitial =
            SchedulePollInitial(fields.firstOrNull() ?: "", fields.drop(1).mapNotNull(SchedulePolls::decode))
    }
}

/** Which time picker is up: the one for every candidate, or one candidate's. */
private const val ALL = -1

/**
 * 「日程調整を作成」 (M54, SCHEDULING.md §5; the desktop's ScheduleDialog), full screen: a title, the days picked on a month
 * calendar (Sunday first; days before today cannot be picked), a time (start and length) or 終日 for all of them, then the
 * candidates listed: each one's time can change, it can be removed, and another time on the same day added. 匿名 hides who
 * answered. Sent as a scheduling poll with the device's zone (the server writes the labels in it).
 */
@Composable
fun SchedulePollForm(
    initial: SchedulePollInitial,
    onDismiss: () -> Unit,
    onCreate: suspend (question: String, slots: List<SlotDraft>, anonymous: Boolean) -> Boolean,
    launch: (suspend () -> Unit) -> Unit,
) {
    val today = remember { CalendarDates.today() }
    val zone = remember { ZoneId.systemDefault() }
    var question by rememberSaveable { mutableStateOf(initial.question) }
    var encoded by rememberSaveable { mutableStateOf(SchedulePolls.sortSlots(initial.slots).map(SchedulePolls::encode)) }
    val slots = encoded.mapNotNull(SchedulePolls::decode)
    fun setSlots(next: List<SlotDraft>) { encoded = next.map(SchedulePolls::encode) }
    var month by rememberSaveable {
        val first = initial.slots.minByOrNull { it.day }?.day
        mutableStateOf((if (first != null && first.isAfter(today)) first else today).withDayOfMonth(1).toString())
    }
    val shownMonth = LocalDate.parse(month)
    var allDay by rememberSaveable { mutableStateOf(initial.slots.isNotEmpty() && initial.slots.all { it.allDay }) }
    var start by rememberSaveable { mutableStateOf((initial.slots.firstOrNull { !it.allDay }?.start ?: SchedulePolls.DEFAULT_START).toString()) }
    var minutes by rememberSaveable { mutableIntStateOf(initial.slots.firstOrNull { !it.allDay }?.minutes ?: SchedulePolls.DEFAULT_MINUTES) }
    var anonymous by rememberSaveable { mutableStateOf(false) }
    var tried by rememberSaveable { mutableStateOf(false) }
    var picking by rememberSaveable { mutableStateOf<Int?>(null) }
    var busy by remember { mutableStateOf(false) }
    val startTime = LocalTime.parse(start)
    val problem = SchedulePolls.problem(question, slots, zone)

    fun applyToAll(nextAllDay: Boolean = allDay, nextStart: LocalTime = startTime, nextMinutes: Int = minutes) {
        allDay = nextAllDay
        start = nextStart.toString()
        minutes = nextMinutes
        setSlots(SchedulePolls.applyToAll(slots, nextAllDay, nextStart, nextMinutes))
    }

    fun change(index: Int, slot: SlotDraft) = setSlots(slots.mapIndexed { i, s -> if (i == index) slot else s })

    fun submit() {
        tried = true
        if (problem != null || busy) return
        busy = true
        launch {
            val made = onCreate(question.trim(), SchedulePolls.sortSlots(slots), anonymous)
            busy = false
            if (made) onDismiss()
        }
    }

    Dialog(onDismissRequest = { if (!busy) onDismiss() }, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
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
                    IconButton(enabled = !busy, onClick = onDismiss) { Icon(Icons.Default.Close, contentDescription = "閉じる") }
                    Text("日程調整を作成", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f).semantics { heading() })
                    TextButton(enabled = !busy, onClick = ::submit) { Text(if (busy) "作成中…" else "作成") }
                }
                HorizontalDivider()
                Column(
                    Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState()).padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    OutlinedTextField(
                        value = question, onValueChange = { question = it.take(SchedulePolls.MAX_QUESTION) },
                        label = { Text("題名") }, placeholder = { Text("例: M2 中間発表の練習") }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                    )
                    Text("候補の日を選ぶと、メンバーが ○ △ × で答えます", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    PickMonth(
                        month = shownMonth, today = today, picked = slots.map { it.day }.toSet(),
                        onMonth = { month = CalendarDates.addMonths(shownMonth, it).toString() },
                        onToggle = { day -> setSlots(SchedulePolls.toggleDay(slots, day, allDay, startTime, minutes)) },
                    )

                    Text("時刻 (すべての候補)", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                        listOf(false to "時刻を決める", true to "終日").forEachIndexed { index, (value, label) ->
                            SegmentedButton(
                                selected = allDay == value, onClick = { if (allDay != value) applyToAll(nextAllDay = value) },
                                shape = SegmentedButtonDefaults.itemShape(index, 2), label = { Text(label) },
                            )
                        }
                    }
                    if (!allDay) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            OutlinedButton(onClick = { picking = ALL }, modifier = Modifier.semantics { contentDescription = "開始時刻 ${CalendarDates.clock(startTime)}" }) {
                                Text(CalendarDates.clock(startTime))
                            }
                            Text("から", color = MaterialTheme.colorScheme.onSurfaceVariant)
                            LengthChoice(minutes, label = "長さ") { applyToAll(nextMinutes = it) }
                        }
                    }
                    Text("カレンダーで日を選ぶと候補に入ります (もう一度押すと外れます)。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)

                    Row(Modifier.fillMaxWidth().padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text("候補", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
                        Text(
                            "${slots.size} / ${SchedulePolls.MAX_SLOTS}", style = MaterialTheme.typography.labelMedium,
                            color = if (slots.size > SchedulePolls.MAX_SLOTS) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    if (slots.isEmpty()) {
                        Text(
                            "カレンダーで日を選んでください", textAlign = TextAlign.Center, color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.fillMaxWidth().border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(10.dp)).padding(14.dp),
                        )
                    }
                    slots.forEachIndexed { index, slot ->
                        val label = SchedulePolls.slotLabel(slot, zone)
                        Column(
                            Modifier.fillMaxWidth().border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(10.dp)).padding(start = 12.dp, end = 4.dp, top = 2.dp, bottom = 4.dp),
                        ) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(label, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
                                IconButton(onClick = { setSlots(slots.filterIndexed { i, _ -> i != index }) }) {
                                    Icon(Icons.Default.Close, contentDescription = "$label を削除")
                                }
                            }
                            if (!slot.allDay) {
                                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    OutlinedButton(onClick = { picking = index }, modifier = Modifier.semantics { contentDescription = "$label の開始時刻" }) {
                                        Text(CalendarDates.clock(slot.start))
                                    }
                                    LengthChoice(slot.minutes, label = "$label の長さ") { change(index, slot.copy(minutes = it)) }
                                    TextButton(onClick = { setSlots(SchedulePolls.addAfter(slots, index, zone)) }, modifier = Modifier.semantics { contentDescription = "$label の後に同じ日の候補を追加" }) {
                                        Icon(Icons.Default.Add, contentDescription = null)
                                        Text("時刻を追加")
                                    }
                                }
                            }
                        }
                    }

                    Row(
                        Modifier.fillMaxWidth().padding(top = 4.dp).toggleable(value = anonymous, role = Role.Switch, onValueChange = { anonymous = it }),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Text("匿名にする (誰が答えたか表示しない)", style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
                        Switch(checked = anonymous, onCheckedChange = null)
                    }
                    Text("タイムゾーン: ${zone.id}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (tried && problem != null) Text(problem, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
                }
            }
        }
        picking?.let { which ->
            val time = if (which == ALL) startTime else slots.getOrNull(which)?.start ?: startTime
            TimePickDialog(time.hour, time.minute, title = "開始時刻", onDismiss = { picking = null }) { h, m ->
                val picked = LocalTime.of(h, m)
                if (which == ALL) applyToAll(nextStart = picked) else slots.getOrNull(which)?.let { change(which, it.copy(start = picked)) }
                picking = null
            }
        }
    }
}

/** The month (Sunday first, 日 red, 土 blue) to pick days on: picked days filled, today ringed, earlier days off. */
@Composable
private fun PickMonth(month: LocalDate, today: LocalDate, picked: Set<LocalDate>, onMonth: (Long) -> Unit, onToggle: (LocalDate) -> Unit) {
    val weeks = remember(month) { CalendarDates.monthGrid(month) }
    Column(Modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = { onMonth(-1) }) { Icon(Icons.AutoMirrored.Filled.KeyboardArrowLeft, contentDescription = "前の月") }
            Text(CalendarDates.monthLabel(month), style = MaterialTheme.typography.titleMedium, textAlign = TextAlign.Center, modifier = Modifier.weight(1f))
            IconButton(onClick = { onMonth(1) }) { Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = "次の月") }
        }
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
                    val chosen = day in picked
                    val past = day.isBefore(today)
                    val inMonth = day.month == month.month
                    val shape = RoundedCornerShape(8.dp)
                    var cell = Modifier.weight(1f).height(44.dp).padding(2.dp)
                    if (chosen) cell = cell.background(MaterialTheme.colorScheme.primary, shape)
                    else if (day == today) cell = cell.border(1.5.dp, MaterialTheme.colorScheme.primary, shape)
                    Box(
                        cell.clickable(enabled = chosen || !past, onClickLabel = if (chosen) "候補から外す" else "候補に入れる") { onToggle(day) }
                            .semantics { contentDescription = CalendarDates.dayLabel(day); selected = chosen },
                        contentAlignment = Alignment.Center,
                    ) {
                        val base = weekdayColor(index) ?: MaterialTheme.colorScheme.onSurface
                        val color = when {
                            chosen -> MaterialTheme.colorScheme.onPrimary
                            past -> MaterialTheme.colorScheme.onSurface.copy(alpha = 0.3f)
                            !inMonth -> base.copy(alpha = 0.45f)
                            else -> base
                        }
                        Text(day.dayOfMonth.toString(), color = color, fontWeight = if (chosen) FontWeight.Bold else FontWeight.Normal)
                    }
                }
            }
        }
    }
}

/** A length out of [SchedulePolls.DURATIONS] (with the current one kept), as a button with its menu. */
@Composable
private fun LengthChoice(minutes: Int, label: String, onPick: (Int) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        OutlinedButton(onClick = { open = true }, modifier = Modifier.semantics { contentDescription = "$label ${SchedulePolls.durationLabel(minutes)}" }) {
            Text(SchedulePolls.durationLabel(minutes))
            Icon(Icons.Default.ArrowDropDown, contentDescription = null)
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            SchedulePolls.lengthChoices(minutes).forEach { choice ->
                DropdownMenuItem(text = { Text(SchedulePolls.durationLabel(choice)) }, onClick = { open = false; onPick(choice) })
            }
        }
    }
}
