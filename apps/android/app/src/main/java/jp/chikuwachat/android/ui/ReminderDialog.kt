package jp.chikuwachat.android.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.FilterChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import java.time.ZonedDateTime

/**
 * 「リマインド」 (M12e): a preset time and an optional note about the message. 「日時を指定…」 picks any time, as on iOS and
 * the desktop (tester, 2026-09-30).
 */
@Composable
fun ReminderDialog(onDismiss: () -> Unit, onPick: (ZonedDateTime, String?) -> Unit) {
    val presets = remember { Schedule.reminderPresets() }
    var chosen by remember { mutableStateOf(presets[1]) }
    var note by remember { mutableStateOf("") }
    var picking by remember { mutableStateOf(false) }
    // A picked time the dialog stayed open past.
    var tooSoon by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("リマインド") },
        text = {
            Column {
                androidx.compose.foundation.layout.FlowRow(horizontalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(6.dp)) {
                    presets.forEach { preset -> FilterChip(selected = chosen.key == preset.key, onClick = { chosen = preset; tooSoon = false }, label = { Text(preset.label) }) }
                    val custom = chosen.key == Schedule.CUSTOM
                    FilterChip(selected = custom, onClick = { picking = true }, label = { Text(if (custom) chosen.label else "日時を指定…") })
                }
                Text(
                    if (tooSoon) "1 分以上先の時刻を選んでください" else Schedule.label(chosen.at) + " にリマインドします",
                    style = MaterialTheme.typography.bodySmall,
                    color = if (tooSoon) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 6.dp),
                )
                OutlinedTextField(note, { note = it.take(200) }, singleLine = true, label = { Text("メモ (任意)") }, modifier = Modifier.fillMaxWidth().padding(top = 8.dp))
            }
        },
        confirmButton = {
            TextButton(onClick = {
                if (chosen.at.isAfter(ZonedDateTime.now().plusMinutes(1))) onPick(chosen.at, note.trim().ifEmpty { null }) else tooSoon = true
            }) { Text("設定") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("キャンセル") } },
    )
    if (picking) {
        ScheduleDialog(
            onDismiss = { picking = false }, title = "リマインド", confirm = "決定",
            describe = { Schedule.label(it) + " にリマインドします" },
        ) { at ->
            chosen = Schedule.customReminder(at)
            tooSoon = false
            picking = false
        }
    }
}
