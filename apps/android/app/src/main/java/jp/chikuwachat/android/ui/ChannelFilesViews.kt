package jp.chikuwachat.android.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
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
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.R
import jp.chikuwachat.android.api.ChannelOut
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.sync.ChannelFiles
import kotlinx.coroutines.launch

/**
 * CF4 (docs/CHANNEL_FILES.md §9, §12.7): 「投稿したファイルをチャンネルのドライブに保存する」 in the channel's details, for
 * owners and admins — a menu of 「ワークスペースに従う（する）」 / 「する」 / 「しない」 (PATCH /channels/{id}
 * `files_to_drive`: null / true / false). A change applies to the posts after it.
 */
@Composable
internal fun ChannelFilesChoice(controller: AppController, channel: ChannelOut) {
    val scope = rememberCoroutineScope()
    var open by remember { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    val workspace = controller.store.workspaceSettings.channelFilesToDrive
    val current = ChannelFiles.Choice.of(channel.filesToDrive)
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth().padding(top = 4.dp)) {
        Column(Modifier.weight(1f)) {
            Text(stringResource(R.string.channel_files_setting), style = MaterialTheme.typography.bodyMedium)
            Text(stringResource(R.string.channel_files_setting_note), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Box {
            TextButton(enabled = !saving, onClick = { open = true }) {
                Text(ChannelFiles.choiceLabel(current, workspace), maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                ChannelFiles.Choice.entries.forEach { choice ->
                    DropdownMenuItem(
                        text = { Text(ChannelFiles.choiceLabel(choice, workspace) + if (choice == current) "  ✓" else "") },
                        onClick = {
                            open = false
                            if (choice != current) {
                                saving = true
                                scope.launch { try { controller.setChannelFilesToDrive(channel.id, choice.value) } finally { saving = false } }
                            }
                        },
                    )
                }
            }
        }
    }
}
