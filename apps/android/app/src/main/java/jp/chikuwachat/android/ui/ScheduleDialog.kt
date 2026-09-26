package jp.chikuwachat.android.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
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
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter

/** 「日時を指定」 for a scheduled message (M12d): a typed local date and time. */
@Composable
fun ScheduleDialog(onDismiss: () -> Unit, onPick: (ZonedDateTime) -> Unit) {
    val format = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm")
    var text by remember { mutableStateOf(ZonedDateTime.now().plusHours(1).withSecond(0).withNano(0).format(format)) }
    val parsed = runCatching { LocalDateTime.parse(text.trim(), format).atZone(ZoneId.systemDefault()) }.getOrNull()
    val valid = parsed != null && parsed.isAfter(ZonedDateTime.now().plusMinutes(1))
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("後で送信") },
        text = {
            Column {
                OutlinedTextField(text, { text = it }, singleLine = true, label = { Text("送信日時 (yyyy-MM-dd HH:mm)") }, isError = !valid, modifier = Modifier.fillMaxWidth())
                Text(
                    if (parsed == null) "日時の形式が違います" else if (!valid) "1 分以上先の時刻を選んでください" else Schedule.label(parsed) + " に送信します",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 6.dp),
                )
            }
        },
        confirmButton = { TextButton(enabled = valid, onClick = { parsed?.let(onPick) }) { Text("予約") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("キャンセル") } },
    )
}
