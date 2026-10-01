package jp.chikuwachat.android.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
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
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.api.MessageOut
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.sync.EngineStatus
import jp.chikuwachat.android.sync.MessageState
import kotlinx.coroutines.launch

/**
 * L8 (docs/TIMES_FEED.md §5, §7): the top-level posts of the times I am in and have not muted, newest at the top (not
 * reversed: it reads from the top down), one row per message with its times' name, never grouped. The first page is read
 * on opening, after reconnecting and on pull to refresh; the next as the end comes near; live message events keep it while
 * it is on screen. Looking at it never moves a read position: a dot marks the rows after their times' one.
 *
 * `onOpen`: a row tapped (shown in its channel); `onOpenThread`: 「返信 N 件」 or 「スレッドで返信」 (its thread).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TimesFeedPane(
    controller: AppController,
    version: Int,
    listState: LazyListState,
    onOpen: (MessageOut) -> Unit,
    onOpenThread: (MessageOut) -> Unit,
) {
    val store = controller.store
    val scope = rememberCoroutineScope()
    val feed = controller.timesFeedState
    val online = controller.engineStatus == EngineStatus.ONLINE
    var refreshing by remember { mutableStateOf(false) }
    var failed by remember { mutableStateOf(false) }
    var moreFailed by remember { mutableStateOf(false) }
    var loadingMore by remember { mutableStateOf(false) }
    // The newest read wins: an answer to an older one (a reconnect during a pull) is dropped.
    var request by remember { mutableIntStateOf(0) }

    suspend fun refresh() {
        val id = ++request
        controller.loadTimesFeed()
            .onSuccess { page ->
                if (id != request) return@onSuccess
                controller.timesFeedState = TimesFeed.firstPage(page)
                failed = false
                moreFailed = false
            }
            .onFailure { if (id == request) failed = true; controller.report(it) }
    }

    suspend fun loadMore() {
        val cursor = controller.timesFeedState.nextCursor ?: return
        if (loadingMore) return
        loadingMore = true
        val id = request
        try {
            controller.loadTimesFeed(cursor)
                .onSuccess { page ->
                    // A first page read meanwhile replaced the rows (and their cursor): this page belongs to the old ones.
                    if (id == request && controller.timesFeedState.nextCursor == cursor) {
                        controller.timesFeedState = TimesFeed.nextPage(controller.timesFeedState, page)
                    }
                    moreFailed = false
                }
                .onFailure { moreFailed = true; controller.report(it) }
        } finally {
            loadingMore = false
        }
    }

    // On opening and whenever the connection comes back (§5).
    LaunchedEffect(online) { if (online) refresh() }
    // Live rows while on screen only (feedVisible): leaving the pane ends the collection, the next opening reads again.
    val engine = controller.engine
    LaunchedEffect(engine) {
        engine?.timelineEvents?.collect { event ->
            controller.timesFeedState = TimesFeed.applyEvent(
                controller.timesFeedState, event.event, event.message, event.thread, store.channel(event.message.channelId),
            )
        }
    }
    // A times left, muted or no longer a times takes its rows along (§5).
    LaunchedEffect(version) { controller.timesFeedState = TimesFeed.pruned(controller.timesFeedState, { store.channel(it) }) }

    PullToRefreshBox(
        isRefreshing = refreshing,
        onRefresh = {
            refreshing = true
            scope.launch { try { refresh() } finally { refreshing = false } }
        },
        modifier = Modifier.fillMaxSize(),
    ) {
        LazyColumn(Modifier.fillMaxSize(), state = listState, contentPadding = PaddingValues(vertical = 4.dp)) {
            when {
                !feed.loaded -> item(key = "state") {
                    when {
                        !online -> Notice("オフラインです", "接続が戻ると読み込みます。")
                        failed -> LoadFailedRow("フィードを読み込めませんでした") { scope.launch { refresh() } }
                        else -> Box(Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.width(24.dp), strokeWidth = 2.dp) }
                    }
                }
                feed.rows.isEmpty() -> item(key = "empty") {
                    // §7's text when I follow no times at all; joined times without posts yet say just that.
                    val following = store.channels.values.any { TimesFeed.isFeedChannel(it) }
                    if (following) Notice("まだ投稿はありません", null) else Notice(null, TimesFeed.EMPTY_TEXT)
                }
                else -> {
                    items(feed.rows, key = { it.id }) { message ->
                        FeedRow(controller, message, version, onOpen = { onOpen(message) }, onOpenThread = { onOpenThread(message) })
                        HorizontalDivider()
                    }
                    if (feed.nextCursor != null) item(key = "more") {
                        // Composed as the end comes near: the next page (once per cursor; a failure offers a retry).
                        LaunchedEffect(feed.nextCursor, moreFailed, online) { if (online && !moreFailed) loadMore() }
                        if (moreFailed) LoadFailedRow("続きを読み込めませんでした") { moreFailed = false }
                        else Box(Modifier.fillMaxWidth().padding(12.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.width(20.dp), strokeWidth = 2.dp) }
                    }
                }
            }
        }
    }
}

/** A feed row: the conversation row (actions, reactions, 「返信 N 件」) with its times' name and the 「新しい」 dot. */
@Composable
private fun FeedRow(controller: AppController, message: MessageOut, version: Int, onOpen: () -> Unit, onOpenThread: () -> Unit) {
    val store = controller.store
    val state = remember(message) { MessageState.from(message) }
    val channel = store.channel(message.channelId)
    val mine = message.senderId == store.me?.id
    MessageRow(
        state, store, controller, version,
        canEdit = mine,
        canDelete = mine || controller.isAdmin,
        onRetry = {}, onDiscard = {},
        onReact = { emoji -> controller.scope.launch { controller.toggleReaction(state, emoji) } },
        onEdit = { body -> controller.editMessage(message.id, Mentions.encode(body, store.users.values, store.groups.values)).isSuccess },
        onDelete = { controller.scope.launch { controller.deleteMessage(message.id) } },
        onOpenThread = onOpenThread,
        // An archived times takes no reactions or edits (its rows can still be read and opened).
        readOnly = channel?.channel?.archived == true,
        channelLabel = channel?.let { channelTitle(it, store) } ?: "?",
        newDot = TimesFeed.isNew(message, channel),
        onTap = onOpen,
    )
}

@Composable
private fun Notice(title: String?, detail: String?) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 48.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        if (title != null) Text(title, style = MaterialTheme.typography.titleSmall)
        if (detail != null) {
            Text(
                detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center,
                modifier = Modifier.padding(top = 4.dp),
            )
        }
    }
}
