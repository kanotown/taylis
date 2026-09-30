package jp.chikuwachat.android.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter

/**
 * Local calendar/time selection. Conversion to UTC still happens in the existing send path. M40: also 「通知を一時停止」's
 * 「日時を指定」 (`title`, `confirm` and `describe` say what the time is for).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ScheduleDialog(
    onDismiss: () -> Unit,
    title: String = "後で送信",
    confirm: String = "予約",
    describe: (ZonedDateTime) -> String = { Schedule.label(it) + " に送信します" },
    onPick: (ZonedDateTime) -> Unit,
) {
    val initial = remember { ZonedDateTime.now().plusHours(1) }
    var dateText by rememberSaveable { mutableStateOf(initial.toLocalDate().toString()) }
    var hour by rememberSaveable { mutableIntStateOf(initial.hour) }
    var minute by rememberSaveable { mutableIntStateOf(initial.minute) }
    var picker by rememberSaveable { mutableStateOf<String?>(null) }
    var tooSoon by remember { mutableStateOf(false) }
    val date = LocalDate.parse(dateText)
    val time = LocalTime.of(hour, minute)
    val at = Schedule.atDateTime(date, time)
    val valid = at != null && at.isAfter(ZonedDateTime.now().plusMinutes(1))
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(title) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedButton(onClick = { picker = "date" }, modifier = Modifier.fillMaxWidth()) {
                    Text("日付: " + date.format(DateTimeFormatter.ofPattern("yyyy年M月d日")))
                }
                OutlinedButton(onClick = { picker = "time" }, modifier = Modifier.fillMaxWidth()) {
                    Text("時刻: " + time.format(DateTimeFormatter.ofPattern("HH:mm")))
                }
                Text("タイムゾーン: ${ZoneId.systemDefault().id}", style = MaterialTheme.typography.bodySmall)
                Text(
                    if (at == null) "この地域に存在しない時刻です。別の時刻を選んでください"
                    else if (!valid || tooSoon) "1 分以上先の時刻を選んでください"
                    else describe(at),
                    style = MaterialTheme.typography.bodySmall,
                    color = if (valid && !tooSoon) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.error,
                )
            }
        },
        confirmButton = {
            TextButton(enabled = valid, onClick = {
                // The dialog may have remained open past the selected time.
                if (at != null && at.isAfter(ZonedDateTime.now().plusMinutes(1))) onPick(at) else tooSoon = true
            }) { Text(confirm) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("キャンセル") } },
    )
    if (picker == "date") {
        val state = rememberDatePickerState(
            initialSelectedDateMillis = Schedule.pickerMillis(date),
            selectableDates = object : SelectableDates {
                override fun isSelectableDate(utcTimeMillis: Long) = !Schedule.pickerDate(utcTimeMillis).isBefore(LocalDate.now())
            },
        )
        DatePickerDialog(
            onDismissRequest = { picker = null },
            confirmButton = {
                TextButton(enabled = state.selectedDateMillis != null, onClick = {
                    state.selectedDateMillis?.let { dateText = Schedule.pickerDate(it).toString() }
                    tooSoon = false
                    picker = null
                }) { Text("決定") }
            },
            dismissButton = { TextButton(onClick = { picker = null }) { Text("キャンセル") } },
        ) { DatePicker(state = state) }
    }
    if (picker == "time") {
        TimePickDialog(hour, minute, onDismiss = { picker = null }) { h, m ->
            hour = h
            minute = m
            tooSoon = false
            picker = null
        }
    }
}

/** A 24-hour time picker (dial or digits) in a dialog; M40: also the quiet hours' start and end. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TimePickDialog(hour: Int, minute: Int, title: String = "時刻を選択", onDismiss: () -> Unit, onPick: (Int, Int) -> Unit) {
    val state = rememberTimePickerState(initialHour = hour, initialMinute = minute, is24Hour = true)
    var input by rememberSaveable { mutableStateOf(false) }
    Dialog(onDismissRequest = onDismiss) {
        Surface(shape = MaterialTheme.shapes.extraLarge, tonalElevation = 6.dp) {
            Column(Modifier.widthIn(max = 360.dp).verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                Text(title, style = MaterialTheme.typography.titleLarge)
                if (input) TimeInput(state = state) else TimePicker(state = state)
                TextButton(onClick = { input = !input }) { Text(if (input) "時計で選択" else "数字で入力") }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                    TextButton(onClick = onDismiss) { Text("キャンセル") }
                    TextButton(onClick = { onPick(state.hour, state.minute) }) { Text("決定") }
                }
            }
        }
    }
}
