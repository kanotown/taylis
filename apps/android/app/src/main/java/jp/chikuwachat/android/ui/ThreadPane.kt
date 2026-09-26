package jp.chikuwachat.android.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.app.AppController
import kotlinx.coroutines.launch

/** One thread: the parent, its replies (oldest first) and a composer that posts with parent_id. */
@Composable
fun ThreadPane(controller: AppController, channelId: String, parentId: String, version: Int) {
    val store = controller.store
    val parent = store.message(channelId, parentId) ?: controller.messageFocus?.context?.firstOrNull { it.id == parentId }
    val replies = remember(version, parentId) { store.replies(channelId, parentId) }
    val listState = rememberLazyListState()
    var positioned by remember(parentId) { mutableStateOf(false) }
    LaunchedEffect(parentId, replies.size) {
        if (!positioned && replies.isNotEmpty()) {
            val focus = controller.messageFocus?.takeIf { it.parentId == parentId }
            val index = replies.indexOfFirst { it.id == focus?.messageId }
            listState.scrollToItem(if (index >= 0) index + 2 else replies.size + 1)
            positioned = true
        }
    }
    LaunchedEffect(parentId, controller.engineStatus) {
        try { controller.engine?.loadReplies(channelId, parentId) }
        catch (e: Exception) { controller.error = controller.describe(e) }
    }

    Column(Modifier.fillMaxSize().imePadding()) {
        LazyColumn(Modifier.weight(1f).fillMaxWidth(), state = listState) {
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
        val channel = store.channel(channelId)
        if (parent != null && channel?.isMember == true && !channel.channel.archived) {
            ConversationComposer(controller, channelId, parentId)
        }
    }
}

@Composable
private fun ThreadMessage(message: jp.chikuwachat.android.sync.MessageState, store: jp.chikuwachat.android.sync.Store, controller: AppController) {
    MessageRow(
        message, store, controller,
        canEdit = !message.pending && message.senderId == store.me?.id,
        canDelete = !message.pending && (message.senderId == store.me?.id || controller.isAdmin),
        onRetry = { controller.scope.launch { controller.engine?.retryFailed() } },
        onDiscard = { controller.engine?.discardFailed(message.clientMsgId ?: "") },
        onReact = { emoji -> controller.scope.launch { controller.toggleReaction(message, emoji) } },
        onEdit = { body -> controller.scope.launch { controller.editMessage(message.id, Mentions.encode(body, store.users.values)) } },
        onDelete = { controller.scope.launch { controller.deleteMessage(message.id) } },
    )
}
