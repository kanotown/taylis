package jp.chikuwachat.android.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.sync.ChannelState
import jp.chikuwachat.android.sync.EngineStatus
import jp.chikuwachat.android.sync.MessageState
import kotlinx.coroutines.launch

/**
 * A public channel read before joining (SYNC_PROTOCOL.md §7.6.1, M27): its latest messages (older pages as the reader
 * scrolls up), read-only, with 「#name に参加する」 where the composer would be. Apart from ChannelPane on purpose: none
 * of the member timeline applies here (no cursor, read position, divider, typing or drafts). A link's message shows
 * with the rows around it (the context), like the channel view, until 「最新の会話へ」. Tapping a row opens its thread,
 * read-only too ([PreviewThreadPane]). `version` is read: the rows live in the Store.
 */
@Composable
fun PreviewPane(controller: AppController, channelId: String, version: Int, onOpenThread: (String) -> Unit) {
    val store = controller.store
    val channel = store.channel(channelId) ?: return
    val focus = controller.messageFocus?.takeIf { it.channelId == channelId }
    val preview = remember(version, channelId) { store.preview?.takeIf { it.channelId == channelId } }
    val me = remember(version) { store.me?.id }
    val messages = remember(preview, focus) { focus?.context?.filter { !it.deleted } ?: preview?.messages ?: emptyList() }
    val items = remember(messages, me) { Timeline.build(messages, null, me).asReversed() }
    val listState = rememberLazyListState()
    var loadingOlder by remember(channelId) { mutableStateOf(false) }
    // A link's message (or its thread's parent) centred once its rows are there.
    LaunchedEffect(channelId, focus?.messageId, items.isEmpty()) {
        val id = focus?.let { it.parentId ?: it.messageId } ?: return@LaunchedEffect
        val index = Timeline.indexOf(items, id)
        if (index >= 0) listState.centerOn(index)
    }
    Column(Modifier.fillMaxSize()) {
        if (focus != null) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("リンク先の前後の会話", style = MaterialTheme.typography.labelMedium, modifier = Modifier.weight(1f))
                TextButton(onClick = { controller.messageFocus = null }) { Text("最新の会話へ") }
            }
        }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            if (focus == null && preview?.loaded != true) {
                PreviewLoading(failed = preview?.failed == true, onRetry = { controller.scope.launch { controller.openChannel(channelId) } })
            } else {
                LazyColumn(state = listState, reverseLayout = true, modifier = Modifier.fillMaxSize(), contentPadding = PaddingValues(vertical = 8.dp)) {
                    items(items, key = { it.key }) { item ->
                        when (item) {
                            is TimelineItem.DateSeparator -> DaySeparator(item.label)
                            is TimelineItem.UnreadSeparator -> Unit // never drawn here: a preview has no read position
                            is TimelineItem.Message -> PreviewRow(item.message, controller, version, compact = item.compact) {
                                onOpenThread(item.message.parentId ?: item.message.id)
                            }
                        }
                    }
                    if (focus == null && preview?.hasOlder == true) {
                        item(key = "older") {
                            LaunchedEffect(messages.size, controller.engineStatus) {
                                if (controller.engineStatus != EngineStatus.ONLINE || loadingOlder) return@LaunchedEffect
                                loadingOlder = true
                                try { controller.loadOlderPreview(channelId) } finally { loadingOlder = false }
                            }
                            Box(Modifier.fillMaxWidth().padding(12.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.width(20.dp), strokeWidth = 2.dp) }
                        }
                    } else if (messages.isEmpty()) {
                        item(key = "empty") {
                            Text("まだメッセージはありません", style = MaterialTheme.typography.titleMedium, modifier = Modifier.fillMaxWidth().padding(32.dp))
                        }
                    } else if (focus == null) {
                        item(key = "start") { ChannelIntro(channel, store) }
                    }
                }
            }
        }
        HorizontalDivider()
        JoinBar(controller, channel)
    }
}

/**
 * A thread opened from a preview (§7.6.1): the parent and its replies, fetched when it opens and kept with the preview.
 * No composer, follow toggle or read position; the join bar stays at the bottom.
 */
@Composable
fun PreviewThreadPane(controller: AppController, channelId: String, parentId: String, version: Int) {
    val store = controller.store
    val channel = store.channel(channelId) ?: return
    val focus = controller.messageFocus?.takeIf { it.channelId == channelId }
    val preview = remember(version, channelId) { store.preview?.takeIf { it.channelId == channelId } }
    val parent = remember(preview, focus, parentId) {
        preview?.messages?.firstOrNull { it.id == parentId } ?: focus?.context?.firstOrNull { it.id == parentId }
    }
    val replies = preview?.replies?.get(parentId)
    val listState = rememberLazyListState()
    LaunchedEffect(parentId, controller.engineStatus) {
        if (replies == null && controller.engineStatus == EngineStatus.ONLINE) controller.loadPreviewReplies(channelId, parentId)
    }
    // A link to a reply: centred once the replies are there (the parent and the count line come first).
    LaunchedEffect(parentId, focus?.messageId, replies == null) {
        val index = replies?.indexOfFirst { it.id == focus?.messageId } ?: -1
        if (index >= 0) listState.centerOn(index + 2)
    }
    Column(Modifier.fillMaxSize()) {
        LazyColumn(Modifier.weight(1f).fillMaxWidth(), state = listState) {
            item(key = "parent") {
                if (parent != null) PreviewRow(parent, controller, version)
                else Text("元のメッセージはこのプレビューにありません", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(16.dp))
            }
            item(key = "divider") {
                Text(
                    when {
                        replies == null -> "返信を読み込んでいます…"
                        replies.isEmpty() -> "返信はまだありません"
                        else -> "${replies.size} 件の返信"
                    },
                    style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
                )
                HorizontalDivider()
            }
            items(replies ?: emptyList(), key = { it.id }) { PreviewRow(it, controller, version) }
        }
        HorizontalDivider()
        JoinBar(controller, channel)
    }
}

/** One read-only row (MessageRow without its actions); `onOpenThread` null in a thread. */
@Composable
private fun PreviewRow(message: MessageState, controller: AppController, version: Int, compact: Boolean = false, onOpenThread: (() -> Unit)? = null) {
    MessageRow(
        message, controller.store, controller, version, compact = compact, canEdit = false, canDelete = false,
        onRetry = {}, onDiscard = {}, onReact = {}, onEdit = { false }, onDelete = {}, onOpenThread = onOpenThread, readOnly = true,
    )
}

@Composable
private fun PreviewLoading(failed: Boolean, onRetry: () -> Unit) {
    Column(Modifier.fillMaxSize().padding(32.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        if (failed) {
            Text("メッセージを読み込めませんでした", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            TextButton(onClick = onRetry) { Text("再読み込み") }
        } else {
            CircularProgressIndicator(Modifier.width(24.dp), strokeWidth = 2.dp)
        }
    }
}

/** Where the composer would be: 「#name に参加する」, after which the conversation carries on as a joined one. */
@Composable
private fun JoinBar(controller: AppController, channel: ChannelState) {
    var joining by remember(channel.id) { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        if (channel.channel.archived) {
            Text("このチャンネルはアーカイブされています", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyMedium)
        } else {
            Text("参加すると投稿やリアクションができます", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Button(
                enabled = !joining,
                // The controller's scope: joining replaces this pane, which must not cancel the join half-way.
                onClick = { joining = true; controller.scope.launch { try { controller.joinChannel(channel.id) } finally { joining = false } } },
                modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
            ) {
                Text("#${channel.channel.name ?: ""} に参加する", maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}
