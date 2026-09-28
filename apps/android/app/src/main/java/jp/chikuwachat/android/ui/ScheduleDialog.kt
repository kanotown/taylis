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

/** Local calendar/time selection. Conversion to UTC still happens in the existing send path. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ScheduleDialog(onDismiss: () -> Unit, onPick: (ZonedDateTime) -> Unit) {
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
        title = { Text("後で送信") },
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
                    else Schedule.label(at) + " に送信します",
                    style = MaterialTheme.typography.bodySmall,
                    color = if (valid && !tooSoon) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.error,
                )
            }
        },
        confirmButton = {
            TextButton(enabled = valid, onClick = {
                // The dialog may have remained open past the selected time.
                if (at != null && at.isAfter(ZonedDateTime.now().plusMinutes(1))) onPick(at) else tooSoon = true
            }) { Text("予約") }
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
        val state = rememberTimePickerState(initialHour = hour, initialMinute = minute, is24Hour = true)
        var input by rememberSaveable { mutableStateOf(false) }
        Dialog(onDismissRequest = { picker = null }) {
            Surface(shape = MaterialTheme.shapes.extraLarge, tonalElevation = 6.dp) {
                Column(Modifier.widthIn(max = 360.dp).verticalScroll(rememberScrollState()).padding(24.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    Text("時刻を選択", style = MaterialTheme.typography.titleLarge)
                    if (input) TimeInput(state = state) else TimePicker(state = state)
                    TextButton(onClick = { input = !input }) { Text(if (input) "時計で選択" else "数字で入力") }
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                        TextButton(onClick = { picker = null }) { Text("キャンセル") }
                        TextButton(onClick = {
                            hour = state.hour
                            minute = state.minute
                            tooSoon = false
                            picker = null
                        }) { Text("決定") }
                    }
                }
            }
        }
    }
}
