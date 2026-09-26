package jp.chikuwachat.android.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.Surface
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
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.sync.MessageState
import jp.chikuwachat.android.sync.Store
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

private val TIME_FORMAT: DateTimeFormatter = DateTimeFormatter.ofPattern("M/d HH:mm")

@Composable
fun ChannelPane(controller: AppController, channelId: String, version: Int) {
    val store = controller.store
    val channel = store.channel(channelId) ?: return
    val messages = remember(version, channelId) { store.messages(channelId) }
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()
    var draft by rememberSaveable(channelId) { mutableStateOf("") }
    var loadingOlder by remember { mutableStateOf(false) }
    // Viewing the newest messages marks them read (SYNC_PROTOCOL.md §10; debounced in the engine).
    LaunchedEffect(channel.lastSeq) { controller.engine?.markRead(channelId, channel.lastSeq) }

    Column(Modifier.fillMaxSize().imePadding()) {
        LazyColumn(state = listState, reverseLayout = true, modifier = Modifier.weight(1f).fillMaxWidth(), contentPadding = androidx.compose.foundation.layout.PaddingValues(vertical = 8.dp)) {
            items(messages.asReversed(), key = { it.id }) { message ->
                MessageRow(
                    message, store,
                    canEdit = !message.pending && message.senderId == store.me?.id,
                    canDelete = !message.pending && (message.senderId == store.me?.id || controller.isAdmin),
                    onRetry = { scope.launch { controller.engine?.retryFailed() } },
                    onDiscard = { controller.engine?.discardFailed(message.clientMsgId ?: "") },
                    onReact = { emoji -> scope.launch { controller.toggleReaction(message, emoji) } },
                    onEdit = { body -> scope.launch { controller.editMessage(message.id, Mentions.encode(body, store.users.values)) } },
                    onDelete = { scope.launch { controller.deleteMessage(message.id) } },
                )
            }
            if (channel.hasOlder && channel.syncedSeq != null) {
                item(key = "older") {
                    LaunchedEffect(messages.size) {
                        if (loadingOlder) return@LaunchedEffect
                        loadingOlder = true
                        try { controller.engine?.loadOlder(channelId) } finally { loadingOlder = false }
                    }
                    Box(Modifier.fillMaxWidth().padding(12.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.width(20.dp), strokeWidth = 2.dp) }
                }
            }
        }
        HorizontalDivider()
        if (channel.channel.archived) {
            Text("このチャンネルはアーカイブされています", modifier = Modifier.padding(16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
        } else {
            val query = Mentions.query(draft)
            val candidates = if (query != null) Mentions.candidates(query, store.users.values) else emptyList()
            if (candidates.isNotEmpty()) {
                LazyRow(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    items(candidates, key = { it.username }) { candidate ->
                        Surface(shape = MaterialTheme.shapes.small, color = MaterialTheme.colorScheme.secondaryContainer, modifier = Modifier.clickable { draft = Mentions.complete(draft, candidate.username) }) {
                            Text("@" + candidate.username + "  " + candidate.label, style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(horizontal = 10.dp, vertical = 6.dp))
                        }
                    }
                }
            }
            Row(Modifier.fillMaxWidth().padding(8.dp), verticalAlignment = Alignment.Bottom) {
                OutlinedTextField(draft, { draft = it }, modifier = Modifier.weight(1f), placeholder = { Text("メッセージ") }, maxLines = 6)
                IconButton(
                    onClick = {
                        val body = Mentions.encode(draft.trim(), store.users.values)
                        if (body.isEmpty()) return@IconButton
                        draft = ""
                        scope.launch { controller.engine?.send(channelId, body) }
                    },
                    enabled = draft.isNotBlank(),
                ) { Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "送信") }
            }
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun MessageRow(
    message: MessageState,
    store: Store,
    canEdit: Boolean,
    canDelete: Boolean,
    onRetry: () -> Unit,
    onDiscard: () -> Unit,
    onReact: (String) -> Unit,
    onEdit: (String) -> Unit,
    onDelete: () -> Unit,
) {
    val sender = store.users[message.senderId]?.displayName ?: store.me?.takeIf { it.id == message.senderId }?.displayName ?: "unknown"
    var menuOpen by remember { mutableStateOf(false) }
    var editing by remember { mutableStateOf(false) }
    var confirmingDelete by remember { mutableStateOf(false) }
    Box(Modifier.fillMaxWidth().combinedClickable(onClick = {}, onLongClick = { if (!message.pending) menuOpen = true })) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp).alpha(if (message.pending) 0.6f else 1f)) {
            Row(verticalAlignment = Alignment.Bottom) {
                Text(sender, fontWeight = FontWeight.SemiBold, style = MaterialTheme.typography.bodyMedium)
                Spacer(Modifier.width(8.dp))
                Text(formatTime(message.createdAt), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (message.editedAt != null) { Spacer(Modifier.width(4.dp)); Text("(編集済み)", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            }
            MessageBody(message.body, store.users)
            ReactionChips(message, store, onToggle = onReact)
            if (message.failed) {
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("送信に失敗しました", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.labelMedium)
                    TextButton(onClick = onRetry) { Text("再送") }
                    TextButton(onClick = onDiscard) { Text("破棄") }
                }
            }
        }
        MessageMenu(
            expanded = menuOpen, canEdit = canEdit, canDelete = canDelete, onDismiss = { menuOpen = false },
            onReact = onReact, onEdit = { editing = true }, onDelete = { confirmingDelete = true },
        )
    }
    if (editing) EditMessageDialog(Mentions.decode(message.body, store.users), onDismiss = { editing = false }, onSave = { editing = false; onEdit(it) })
    if (confirmingDelete) ConfirmDeleteDialog(onDismiss = { confirmingDelete = false }, onConfirm = { confirmingDelete = false; onDelete() })
}

private fun formatTime(iso: String): String =
    runCatching { TIME_FORMAT.format(Instant.parse(iso).atZone(ZoneId.systemDefault())) }.getOrDefault("")
