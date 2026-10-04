package jp.chikuwachat.android.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.api.BookmarkItem
import jp.chikuwachat.android.api.MessageOut
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.sync.Store
import kotlinx.coroutines.launch

/** 「保存済み」 (M11c): my bookmarked messages, newest saved first; a row reveals the message. */
@Composable
fun SavedPane(controller: AppController, version: Int, onOpen: (MessageOut) -> Unit) {
    val store = controller.store
    var items by remember { mutableStateOf<List<BookmarkItem>?>(null) }
    var cursor by remember { mutableStateOf<String?>(null) }
    var hasMore by remember { mutableStateOf(false) }
    val signature = remember(version) { store.bookmarks.sorted().joinToString(",") } // bookmark.updated re-reads
    suspend fun load(more: Boolean) {
        controller.listBookmarks(cursor = if (more) cursor else null).onSuccess { page ->
            items = if (more) (items ?: emptyList()) + page.items else page.items
            cursor = page.nextCursor
            hasMore = page.items.size >= 50
        }.onFailure { controller.error = controller.describe(it) }
    }
    LaunchedEffect(signature, controller.engineStatus) { load(more = false) }
    val list = items
    LazyColumn(Modifier.fillMaxSize()) {
        when {
            list == null -> item { Text("読み込み中…", modifier = Modifier.padding(16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant) }
            list.isEmpty() -> item {
                Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 48.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("保存したメッセージはありません", style = MaterialTheme.typography.titleSmall)
                    Text("メッセージを長押しして「あとで見る」を選ぶと、ここに集まります。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 4.dp))
                }
            }
            else -> {
                items(list, key = { it.message.id }) { item ->
                    MessageCard(item.message, store, version, { controller.loadEmojiImage(it) }, onClick = { onOpen(item.message) })
                    HorizontalDivider()
                }
                if (hasMore) item { TextButton(onClick = { controller.scope.launch { load(more = true) } }, modifier = Modifier.fillMaxWidth()) { Text("さらに読み込む") } }
            }
        }
    }
}

/** A compact message card shared by the pins pane and the saved pane. */
@Composable
fun MessageCard(message: MessageOut, store: Store, version: Int, onNeedEmojiImage: (jp.chikuwachat.android.api.CustomEmojiOut) -> Unit, onClick: () -> Unit) {
    val sender = store.users[message.senderId]?.displayName ?: "?"
    val channel = store.channel(message.channelId)
    val text = messageLine(message.body, message.attachments, store)
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.Top) {
        Avatar(message.senderId, sender, size = 32.dp)
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(sender, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
                Spacer(Modifier.width(8.dp))
                Text(channel?.let { channelTitle(it, store) } ?: "?", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                Spacer(Modifier.weight(1f))
                Text(Timeline.timeLabel(message.createdAt), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            EmojiLineText(
                text, store, onNeedEmojiImage, version, MaterialTheme.typography.bodyMedium, androidx.compose.ui.graphics.Color.Unspecified,
                Modifier.padding(top = 2.dp), maxLines = 4,
            )
        }
    }
}
