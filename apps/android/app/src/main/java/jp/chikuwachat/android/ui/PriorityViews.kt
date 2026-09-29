package jp.chikuwachat.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.DoneAll
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.Warning
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
import androidx.compose.ui.text.style.TextOverflow
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

/**
 * M15e: 「確認しました」 for readers, and who has acknowledged so far. M27: the first names are on the line (「山田、佐藤 が確認」,
 * then 「… ほか N 人が確認」); tapping it lists everyone, oldest first. `readOnly`: a channel only previewed (§7.6.1), where
 * nobody acknowledges. `version` keeps the names current.
 */
@Composable
fun AckBar(message: MessageState, store: Store, controller: AppController, version: Int = 0, readOnly: Boolean = false) {
    val me = remember(version) { store.me }
    val mine = me != null && message.acks.any { it.userId == me.id }
    val own = me?.id == message.senderId
    val people = remember(version, message.acks) { PeopleText.people(store, message.acks.map { it.userId }) }
    var showNames by remember { mutableStateOf(false) }
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 4.dp)) {
        if (!own && !readOnly) {
            OutlinedButton(onClick = { controller.scope.launch { controller.toggleAck(message) } }, contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 10.dp, vertical = 0.dp)) {
                Icon(Icons.Outlined.DoneAll, contentDescription = null, modifier = Modifier.size(16.dp), tint = if (mine) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
                Text(if (mine) " 確認済み" else " 確認しました", style = MaterialTheme.typography.labelMedium)
            }
        }
        // M28c: a 48 dp touch target around the names line (the row's layout is unchanged).
        Text(
            if (people.isEmpty()) "まだ誰も確認していません" else PeopleText.acknowledged(people.map { it.name }),
            style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 2, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false).padding(start = if (!own && !readOnly) 8.dp else 0.dp).touchTarget { source ->
                Modifier.clickable(interactionSource = source, indication = null, enabled = people.isNotEmpty(), onClickLabel = "確認した人") { showNames = true }
            },
        )
    }
    if (showNames) PeopleDialog("確認した人", people, onDismiss = { showNames = false })
}
