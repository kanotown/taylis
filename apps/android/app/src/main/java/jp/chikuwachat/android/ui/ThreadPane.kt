package jp.chikuwachat.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.sync.MessageState
import jp.chikuwachat.android.sync.toOut
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

/**
 * One thread: the parent, its replies (oldest first) and a composer that posts with parent_id.
 * Replies that were fully shown advance the thread read position (THREADS.md §5); the follow toggle
 * lives in the app bar (MainScreen).
 */
@Composable
fun ThreadPane(controller: AppController, channelId: String, parentId: String, version: Int) {
    val store = controller.store
    val entry = store.threads[parentId]
    val parent = store.message(channelId, parentId)
        ?: entry?.parent?.let { MessageState.from(it) }
        ?: controller.messageFocus?.context?.firstOrNull { it.id == parentId }
    val replies = remember(version, parentId) { store.replies(channelId, parentId) }
    val listState = rememberLazyListState()
    var positioned by remember(parentId) { mutableStateOf(false) }
    // 「新しい返信」 sits before the first reply from someone else past my read position.
    val me = store.me?.id
    val firstUnreadId = entry?.state?.let { state -> replies.firstOrNull { (it.seq ?: 0) > state.lastReadSeq && it.senderId != me }?.id }

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
        catch (e: Exception) { controller.report(e) }
    }
    // THREADS.md §5: my relation to the thread (follow flag, read position) is fetched once per thread.
    LaunchedEffect(parentId, controller.engineStatus, parent?.seq) {
        if (store.threads[parentId] != null) return@LaunchedEffect
        val out = parent?.toOut() ?: return@LaunchedEffect
        try { controller.engine?.loadThreadState(parentId, out) }
        catch (e: Exception) { controller.report(e) }
    }
    // Read position = the newest reply fully shown (never just "opened"), like the timeline.
    LaunchedEffect(parentId, positioned, controller.engineStatus, controller.appForeground, replies) {
        if (!positioned) return@LaunchedEffect
        snapshotFlow { listState.layoutInfo }.collectLatest { layout ->
            val seq = layout.visibleItemsInfo.mapNotNull { visible ->
                val fullyVisible = visible.offset >= layout.viewportStartOffset &&
                    visible.offset + visible.size <= layout.viewportEndOffset
                val tall = visible.size > layout.viewportEndOffset - layout.viewportStartOffset
                if (!fullyVisible && !tall) null else replies.firstOrNull { it.id == visible.key }?.seq
            }.maxOrNull()
            if (seq != null) controller.engine?.markThreadRead(parentId, seq)
        }
    }

    Column(Modifier.fillMaxSize().imePadding()) {
        LazyColumn(Modifier.weight(1f).fillMaxWidth(), state = listState) {
            if (parent != null) {
                item(key = "parent") { ThreadMessage(parent, store, controller, version) }
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
            items(replies, key = { it.rowKey }) { reply ->
                Column {
                    if (reply.id == firstUnreadId) NewRepliesDivider()
                    ThreadMessage(reply, store, controller, version)
                }
            }
        }
        HorizontalDivider()
        val channel = store.channel(channelId)
        if (parent != null && channel?.isMember == true && !channel.channel.archived) {
            TypingLine(controller, channelId, parentId, version)
            ConversationComposer(controller, channelId, version, parentId)
        }
    }
}

@Composable
private fun NewRepliesDivider() {
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.weight(1f).height(1.dp).background(MaterialTheme.colorScheme.error.copy(alpha = 0.6f)))
        Text(
            "  新しい返信",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.error,
            fontWeight = FontWeight.Bold,
        )
    }
}

@Composable
private fun ThreadMessage(message: MessageState, store: jp.chikuwachat.android.sync.Store, controller: AppController, version: Int) {
    MessageRow(
        message, store, controller, version,
        canEdit = !message.pending && message.senderId == store.me?.id,
        canDelete = !message.pending && (message.senderId == store.me?.id || controller.isAdmin),
        onRetry = { controller.scope.launch { controller.engine?.retryFailed() } },
        onDiscard = { controller.engine?.discardFailed(message.clientMsgId ?: "") },
        onReact = { emoji -> controller.scope.launch { controller.toggleReaction(message, emoji) } },
        onEdit = { body -> controller.scope.launch { controller.editMessage(message.id, Mentions.encode(body, store.users.values, store.groups.values)) } },
        onDelete = { controller.scope.launch { controller.deleteMessage(message.id) } },
    )
}
