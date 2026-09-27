package jp.chikuwachat.android.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.api.SidebarSectionOut
import jp.chikuwachat.android.app.AppController
import kotlinx.coroutines.launch

/** Long-press on a conversation (M14f): star it, or move it into one of my sections. */
@Composable
fun ChannelSectionDialog(controller: AppController, channelId: String, onDismiss: () -> Unit) {
    val store = controller.store
    val channel = store.channels[channelId] ?: return onDismiss()
    val current = store.sectionOf(channelId)
    val starred = channelId in store.favorites
    val scope = rememberCoroutineScope()
    var naming by remember { mutableStateOf(false) }
    var name by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(channelTitle(channel, store)) },
        text = {
            Column {
                TextButton(onClick = { scope.launch { controller.toggleFavorite(channelId); onDismiss() } }) {
                    Text(if (starred) "お気に入りから外す" else "お気に入りに追加")
                }
                HorizontalDivider()
                Text("セクションに移動", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp))
                store.sidebarSections.forEach { section ->
                    Row(
                        Modifier.fillMaxWidth().clickable(enabled = section.id != current) { scope.launch { if (controller.moveToSection(channelId, section.id)) onDismiss() } }.padding(vertical = 4.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RadioButton(selected = section.id == current, onClick = null)
                        Text(section.name, modifier = Modifier.padding(start = 8.dp))
                    }
                }
                if (naming) {
                    OutlinedTextField(name, { name = it.take(40) }, label = { Text("新しいセクション名") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                    TextButton(enabled = name.isNotBlank(), onClick = { scope.launch { if (controller.createSection(name.trim(), channelId)) onDismiss() } }) { Text("作成して移動") }
                } else {
                    TextButton(onClick = { naming = true }) { Text("新しいセクション…") }
                }
                if (current != null) {
                    TextButton(onClick = { scope.launch { if (controller.moveToSection(channelId, null)) onDismiss() } }) { Text("セクションから外す") }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("閉じる") } },
    )
}

/** The 「…」 on a custom section: rename, move up / down, new section, delete. */
@Composable
fun SectionActionsDialog(controller: AppController, section: SidebarSectionOut, index: Int, count: Int, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    var name by remember { mutableStateOf(section.name) }
    var newName by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(section.name) },
        text = {
            Column {
                OutlinedTextField(name, { name = it.take(40) }, label = { Text("セクション名") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                TextButton(enabled = name.isNotBlank() && name.trim() != section.name, onClick = { scope.launch { if (controller.renameSection(section.id, name.trim())) onDismiss() } }) { Text("名前を保存") }
                Row {
                    TextButton(enabled = index > 0, onClick = { scope.launch { if (controller.moveSection(section.id, index - 1)) onDismiss() } }) { Text("上へ") }
                    TextButton(enabled = index < count - 1, onClick = { scope.launch { if (controller.moveSection(section.id, index + 1)) onDismiss() } }) { Text("下へ") }
                }
                HorizontalDivider()
                OutlinedTextField(newName, { newName = it.take(40) }, label = { Text("新しいセクション名") }, singleLine = true, modifier = Modifier.fillMaxWidth().padding(top = 8.dp))
                TextButton(enabled = newName.isNotBlank(), onClick = { scope.launch { if (controller.createSection(newName.trim(), null)) onDismiss() } }) { Text("新しいセクションを作成") }
                HorizontalDivider()
                TextButton(onClick = { scope.launch { if (controller.deleteSection(section.id)) onDismiss() } }) {
                    Text("セクションを削除 (会話は元の場所へ)", color = MaterialTheme.colorScheme.error)
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("閉じる") } },
    )
}
