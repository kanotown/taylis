package jp.chikuwachat.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.DoneAll
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.Warning
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.sync.MessageState
import jp.chikuwachat.android.sync.Store
import kotlinx.coroutines.launch

/** M15e: 「重要」 / 「緊急」 above a message and in the composer. */
@Composable
fun PriorityLabel(priority: String, modifier: Modifier = Modifier) {
    val urgent = priority == "urgent"
    val color = if (urgent) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary
    Row(
        modifier.background(color.copy(alpha = 0.12f), RoundedCornerShape(4.dp)).padding(horizontal = 6.dp, vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(if (urgent) Icons.Outlined.Warning else Icons.Outlined.Info, contentDescription = null, tint = color, modifier = Modifier.size(12.dp))
        Text(if (urgent) " 緊急" else " 重要", style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold, color = color)
    }
}

/** M15e: 「確認しました」 for readers, and who has acknowledged so far (`version` keeps their names current). */
@Composable
fun AckBar(message: MessageState, store: Store, controller: AppController, version: Int = 0) {
    val me = store.me
    val mine = me != null && message.acks.any { it.userId == me.id }
    val own = me?.id == message.senderId
    val names = remember(version, message.acks) { message.acks.map { store.users[it.userId]?.displayName ?: "?" } }
    var showNames by remember { mutableStateOf(false) }
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 4.dp)) {
        if (!own) {
            OutlinedButton(onClick = { controller.scope.launch { controller.toggleAck(message) } }, contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 10.dp, vertical = 0.dp)) {
                Icon(Icons.Outlined.DoneAll, contentDescription = null, modifier = Modifier.size(16.dp), tint = if (mine) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
                Text(if (mine) " 確認済み" else " 確認しました", style = MaterialTheme.typography.labelMedium)
            }
        }
        Box(Modifier.padding(start = 8.dp)) {
            Text(
                if (names.isEmpty()) "まだ誰も確認していません" else "${names.size} 人が確認",
                style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.clickable(enabled = names.isNotEmpty()) { showNames = true },
            )
            DropdownMenu(expanded = showNames, onDismissRequest = { showNames = false }) {
                names.forEach { name -> DropdownMenuItem(text = { Text(name) }, onClick = { showNames = false }) }
            }
        }
    }
}
