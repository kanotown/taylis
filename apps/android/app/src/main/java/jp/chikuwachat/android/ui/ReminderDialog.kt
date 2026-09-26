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

/** 「リマインド」 (M12e): a preset time and an optional note about the message. */
@Composable
fun ReminderDialog(onDismiss: () -> Unit, onPick: (ZonedDateTime, String?) -> Unit) {
    val presets = remember { Schedule.reminderPresets() }
    var chosen by remember { mutableStateOf(presets[1]) }
    var note by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("リマインド") },
        text = {
            Column {
                androidx.compose.foundation.layout.FlowRow(horizontalArrangement = androidx.compose.foundation.layout.Arrangement.spacedBy(6.dp)) {
                    presets.forEach { preset -> FilterChip(selected = chosen.key == preset.key, onClick = { chosen = preset }, label = { Text(preset.label) }) }
                }
                Text(Schedule.label(chosen.at) + " にリマインドします", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 6.dp))
                OutlinedTextField(note, { note = it.take(200) }, singleLine = true, label = { Text("メモ (任意)") }, modifier = Modifier.fillMaxWidth().padding(top = 8.dp))
            }
        },
        confirmButton = { TextButton(onClick = { onPick(chosen.at, note.trim().ifEmpty { null }) }) { Text("設定") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("キャンセル") } },
    )
}
