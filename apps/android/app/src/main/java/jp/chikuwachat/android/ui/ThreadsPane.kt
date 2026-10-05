package jp.chikuwachat.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.sync.EngineStatus
import jp.chikuwachat.android.sync.Store
import jp.chikuwachat.android.sync.ThreadEntry
import kotlinx.coroutines.launch
import jp.chikuwachat.android.R
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.res.pluralStringResource

/** Followed threads (THREADS.md §5): newest reply first, an all / unread filter; a row opens the thread. */
@Composable
fun ThreadsPane(controller: AppController, version: Int, onOpen: (ThreadEntry) -> Unit, listState: LazyListState = rememberLazyListState()) {
    val store = controller.store
    val rows = remember(version) { store.threadList() }
    val filter = store.threadsFilter
    val scope = rememberCoroutineScope()
    // M28c: offline the list says so instead of 「読み込んでいます…」 for good (the engine's load returns at once), and a
    // failed load offers 「再読み込み」; the reconnect loads again by itself (keyed on the status).
    var failed by remember { mutableStateOf(false) }
    var attempt by remember { mutableIntStateOf(0) }
    val offline = controller.engineStatus == EngineStatus.OFFLINE
    LaunchedEffect(controller.engineStatus, attempt) {
        failed = false
        try { controller.engine?.loadThreads(store.threadsFilter) } catch (e: Exception) { failed = true; controller.report(e) }
    }
    fun load(next: String, more: Boolean = false) {
        scope.launch {
            failed = false
            try { controller.engine?.loadThreads(next, more) } catch (e: Exception) { failed = true; controller.report(e) }
        }
    }

    LazyColumn(Modifier.fillMaxSize(), state = listState) {
        item {
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(selected = filter == "all", onClick = { load("all") }, label = { Text(stringResource(R.string.common_all)) })
                FilterChip(selected = filter == "unread", onClick = { load("unread") }, label = { Text(stringResource(R.string.common_unread)) })
            }
        }
        if (rows.isEmpty()) {
            item {
                Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 48.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(
                        when {
                            !store.threadsLoaded && offline -> stringResource(R.string.threads_pane_cant_load_threads_while_offline)
                            !store.threadsLoaded && failed -> stringResource(R.string.threads_pane_couldnt_load_threads)
                            !store.threadsLoaded -> stringResource(R.string.common_loading_2)
                            filter == "unread" -> stringResource(R.string.threads_pane_no_unread_threads)
                            else -> stringResource(R.string.threads_pane_no_followed_threads)
                        },
                        style = MaterialTheme.typography.titleSmall,
                    )
                    Text(
                        if (!store.threadsLoaded && offline) stringResource(R.string.common_it_will_load_when_the_connection) else stringResource(R.string.threads_pane_threads_you_posted_in_replied_to),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.padding(top = 4.dp),
                    )
                    if (!store.threadsLoaded && failed && !offline) TextButton(onClick = { attempt += 1 }) { Text(stringResource(R.string.common_reload)) }
                }
            }
        } else {
            items(rows, key = { it.id }) { entry ->
                ThreadRow(entry, store, version, { controller.loadEmojiImage(it) }, onClick = { onOpen(entry) })
                HorizontalDivider()
            }
            if (store.threadsHasMore) {
                item { TextButton(onClick = { load(filter, more = true) }, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.threads_pane_show_more)) } }
            }
        }
    }
}

@Composable
private fun ThreadRow(entry: ThreadEntry, store: Store, version: Int, onNeedEmojiImage: (jp.chikuwachat.android.api.CustomEmojiOut) -> Unit, onClick: () -> Unit) {
    val parent = entry.parent
    val state = entry.state
    val unread = state.unreadCount > 0
    val author = store.users[parent.senderId]?.displayName ?: "…"
    val last = state.lastReplyAt ?: parent.createdAt
    val excerpt = messageLine(parent.body, parent.attachments, store)
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.Top,
    ) {
        Avatar(parent.senderId, author, size = 36.dp)
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                val channel = store.channel(state.channelId)
                Text(
                    channel?.let { channelTitle(it, store) } ?: "",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                Spacer(Modifier.weight(1f))
                Text(Timeline.timeLabel(last), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Text(author, style = MaterialTheme.typography.titleSmall, fontWeight = if (unread) FontWeight.Bold else FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            EmojiLineText(
                excerpt, store, onNeedEmojiImage, version, MaterialTheme.typography.bodyMedium,
                if (unread) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 2,
            )
            Row(Modifier.padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    pluralStringResource(R.plurals.common_replies_count, state.replyCount, state.replyCount),
                    style = MaterialTheme.typography.labelMedium,
                    color = if (unread) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                    fontWeight = if (unread) FontWeight.SemiBold else FontWeight.Normal,
                )
                if (unread) Text(stringResource(R.string.threads_pane_unread, state.unreadCount), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(Modifier.weight(1f))
                if (unread) {
                    Text(
                        if (state.mentionCount > 0) "@${state.mentionCount}" else state.unreadCount.toString(),
                        color = MaterialTheme.colorScheme.onPrimary,
                        style = MaterialTheme.typography.labelSmall,
                        modifier = Modifier
                            .background(if (state.mentionCount > 0) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary, CircleShape)
                            .padding(horizontal = 7.dp, vertical = 2.dp),
                    )
                }
            }
        }
    }
}
