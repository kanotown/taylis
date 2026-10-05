package jp.chikuwachat.android.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.rememberLazyListState
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
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.api.MessageOut
import jp.chikuwachat.android.app.AppController
import kotlinx.coroutines.launch
import jp.chikuwachat.android.R
import androidx.compose.ui.res.stringResource

/** 「メンション」 (M11h): messages that mention me or everyone, newest first; a row reveals the message. */
@Composable
fun MentionsPane(controller: AppController, version: Int, onOpen: (MessageOut) -> Unit, listState: LazyListState = rememberLazyListState()) {
    val store = controller.store
    var items by remember { mutableStateOf<List<MessageOut>?>(null) }
    var cursor by remember { mutableStateOf<String?>(null) }
    var hasMore by remember { mutableStateOf(false) }
    suspend fun load(more: Boolean) {
        controller.listMentions(cursor = if (more) cursor else null).onSuccess { page ->
            items = if (more) (items ?: emptyList()) + page.items else page.items
            cursor = page.nextCursor
            hasMore = page.items.size >= 50
        }.onFailure { controller.error = controller.describe(it) }
    }
    LaunchedEffect(controller.engineStatus) { load(more = false) } // a reconnect re-reads
    val list = items
    LazyColumn(Modifier.fillMaxSize(), state = listState) {
        when {
            list == null -> item { Text(stringResource(R.string.common_loading), modifier = Modifier.padding(16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant) }
            list.isEmpty() -> item {
                Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 48.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(stringResource(R.string.common_no_mentions_yet), style = MaterialTheme.typography.titleSmall)
                    Text(stringResource(R.string.common_messages_to_you_and_channel_show), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 4.dp))
                }
            }
            else -> {
                items(list, key = { it.id }) { message ->
                    MessageCard(message, store, version, { controller.loadEmojiImage(it) }, onClick = { onOpen(message) })
                    HorizontalDivider()
                }
                if (hasMore) item { TextButton(onClick = { controller.scope.launch { load(more = true) } }, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.common_load_more)) } }
            }
        }
    }
}
