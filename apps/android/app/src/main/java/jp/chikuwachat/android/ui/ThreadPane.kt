package jp.chikuwachat.android.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
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
import kotlinx.coroutines.launch

/** One thread: the parent, its replies (oldest first) and a composer that posts with parent_id. */
@Composable
fun ThreadPane(controller: AppController, channelId: String, parentId: String, version: Int) {
    val store = controller.store
    val parent = store.message(channelId, parentId)
    val replies = remember(version, parentId) { store.replies(channelId, parentId) }
    val scope = rememberCoroutineScope()
    var draft by rememberSaveable(parentId) { mutableStateOf("") }
    LaunchedEffect(parentId) { controller.engine?.loadReplies(channelId, parentId) }

    Column(Modifier.fillMaxSize().imePadding()) {
        LazyColumn(Modifier.weight(1f).fillMaxWidth()) {
            if (parent != null) {
                item(key = "parent") { ThreadMessage(parent, store, controller) }
                item(key = "divider") {
                    Text(
                        if (replies.isEmpty()) "返信はまだありません" else "${replies.size} 件の返信",
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
                    )
                    HorizontalDivider()
                }
            } else {
                item { Text("メッセージが見つかりません", modifier = Modifier.padding(16.dp)) }
            }
            items(replies, key = { it.id }) { reply -> ThreadMessage(reply, store, controller) }
        }
        HorizontalDivider()
        Row(Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = Alignment.Bottom) {
            OutlinedTextField(draft, { draft = it }, modifier = Modifier.weight(1f), placeholder = { Text("スレッドに返信") }, maxLines = 6)
            IconButton(
                onClick = {
                    val body = Mentions.encode(draft.trim(), store.users.values)
                    if (body.isEmpty()) return@IconButton
                    draft = ""
                    scope.launch { controller.engine?.send(channelId, body, parentId = parentId) }
                },
                enabled = draft.isNotBlank() && parent != null,
            ) { Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "返信を送信") }
        }
    }
}

@Composable
private fun ThreadMessage(message: jp.chikuwachat.android.sync.MessageState, store: jp.chikuwachat.android.sync.Store, controller: AppController) {
    val sender = store.users[message.senderId]?.displayName ?: store.me?.takeIf { it.id == message.senderId }?.displayName ?: "unknown"
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp)) {
        Text(sender, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        MessageBody(message.body, store.users)
        ReactionChips(message, store, onToggle = { emoji -> controller.scope.launch { controller.toggleReaction(message, emoji) } })
    }
}
