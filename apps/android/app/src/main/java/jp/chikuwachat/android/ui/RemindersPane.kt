package jp.chikuwachat.android.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.api.ReminderOut
import jp.chikuwachat.android.app.AppController
import kotlinx.coroutines.launch

/** 「リマインダー」 (M12e): fired nudges wait for 完了 on top; pending ones list their time. */
@Composable
fun RemindersPane(controller: AppController, version: Int, onOpen: (ReminderOut) -> Unit) {
    val store = controller.store
    val rows = remember(version) { store.listReminders() }
    val fired = rows.filter { it.status == "fired" }
    val pending = rows.filter { it.status == "pending" }
    LazyColumn(Modifier.fillMaxSize()) {
        if (rows.isEmpty()) {
            item {
                Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 48.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("リマインダーはありません", style = MaterialTheme.typography.titleSmall)
                    Text("メッセージを長押しして「リマインド」を選ぶと、ここに集まります。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 4.dp))
                }
            }
        }
        if (fired.isNotEmpty()) {
            item { Text("届いたリマインド", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) }
            items(fired, key = { "f:" + it.id }) { row -> ReminderRow(row, controller, "完了", onOpen) }
        }
        if (pending.isNotEmpty()) {
            item { Text("予定", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) }
            items(pending, key = { "p:" + it.id }) { row -> ReminderRow(row, controller, "取り消し", onOpen) }
        }
    }
}

@Composable
private fun ReminderRow(row: ReminderOut, controller: AppController, action: String, onOpen: (ReminderOut) -> Unit) {
    val store = controller.store
    Column(Modifier.fillMaxWidth().clickable { onOpen(row) }.padding(horizontal = 16.dp, vertical = 8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(store.channel(row.channelId)?.let { channelTitle(it, store) } ?: "?", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
            Text(" · " + Schedule.label(row.remindAt) + if (row.status == "fired") " にリマインド" else " にリマインド予定", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        row.note?.takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium, modifier = Modifier.padding(top = 2.dp)) }
        Text(row.preview, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp))
        Row { TextButton(onClick = { controller.scope.launch { controller.closeReminder(row) } }) { Text(action) } }
    }
    HorizontalDivider()
}
