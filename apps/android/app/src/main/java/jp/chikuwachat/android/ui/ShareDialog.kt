package jp.chikuwachat.android.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
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
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.sync.ChannelState
import jp.chikuwachat.android.sync.MessageState
import kotlinx.coroutines.launch
import jp.chikuwachat.android.R
import jp.chikuwachat.android.L10n
import androidx.compose.ui.res.stringResource

/**
 * 「別のチャンネルに共有」(M13c): pick a conversation, add a comment, post the quote and permalink there. `version` (M28c):
 * the conversations and their partners' names live in the Store; the comment and the choice survive a rotation.
 */
@Composable
fun ShareDialog(controller: AppController, message: MessageState, version: Int, onDismiss: () -> Unit) {
    val store = controller.store
    val scope = rememberCoroutineScope()
    val me = store.me?.id
    fun label(state: ChannelState): String {
        val channel = state.channel
        return if (channel.type == "dm" || channel.type == "group_dm") {
            (channel.dmUserIds ?: emptyList()).filter { it != me }.mapNotNull { store.users[it]?.displayName }.joinToString(", ").ifEmpty { L10n.str(R.string.common_you) }
        } else (if (channel.type == "private") "🔒" else "#") + (channel.name ?: "")
    }
    val targets = remember(version) { store.channels.values.filter { it.isMember && !it.channel.archived && it.id != message.channelId }.sortedBy { label(it) } }
    var targetId by rememberSaveable { mutableStateOf(targets.firstOrNull()?.id) }
    var comment by rememberSaveable { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.share_dialog_share_to_another_channel)) },
        text = {
            Column {
                OutlinedTextField(comment, { comment = it }, label = { Text(stringResource(R.string.share_dialog_comment_optional)) }, modifier = Modifier.fillMaxWidth(), maxLines = 3)
                LazyColumn(Modifier.heightIn(max = 280.dp).padding(top = 8.dp)) {
                    items(targets, key = { it.id }) { state ->
                        Row(Modifier.fillMaxWidth().clickable { targetId = state.id }.padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                            RadioButton(selected = targetId == state.id, onClick = { targetId = state.id })
                            Text(label(state), style = MaterialTheme.typography.bodyMedium)
                        }
                    }
                    if (targets.isEmpty()) item { Text(stringResource(R.string.share_dialog_no_conversations_to_share_to), color = MaterialTheme.colorScheme.onSurfaceVariant) }
                }
            }
        },
        confirmButton = {
            TextButton(enabled = !busy && targetId != null, onClick = {
                val id = targetId ?: return@TextButton
                scope.launch { busy = true; if (controller.shareMessage(message, id, comment)) onDismiss(); busy = false }
            }) { Text(stringResource(R.string.share_dialog_share)) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.common_cancel)) } },
    )
}
