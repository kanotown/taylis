package jp.chikuwachat.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.automirrored.outlined.Article
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.api.CanvasMeta
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.sync.EngineStatus
import jp.chikuwachat.android.sync.MyCanvasList
import jp.chikuwachat.android.sync.MyCanvasesState
import jp.chikuwachat.android.sync.Store
import kotlinx.coroutines.launch
import java.time.ZonedDateTime
import jp.chikuwachat.android.R
import jp.chikuwachat.android.L10n
import androidx.compose.ui.res.stringResource

/** M78 (CANVAS.md §21.2): one row of the home's 「キャンバス」. */
data class MyCanvasRow(
    val canvas: CanvasMeta,
    /** 「#lab」, a DM's other members, or 「会話」 for one this device does not know. */
    val where: String,
    /** Who saved it last (「メンバー」 when unknown). */
    val editor: String,
    val updated: String,
    /** 「3/5」 with tasks, else null. */
    val progress: String?,
)

/** Where a row's tap goes (§21.2): onto the home stack, or the `/c/` link's way for a conversation this device lacks. */
sealed interface MyCanvasOpen {
    data class Push(val stack: List<Route>) : MyCanvasOpen
    data class Link(val canvasId: String) : MyCanvasOpen
}

/** M78 (CANVAS.md §21.2): the home's 「キャンバス」 as pure functions (tested in MyCanvasesTest). */
object MyCanvases {
    /**
     * The rows shown: what the device knows newer (canvas.* events of a conversation opened) wins over the page; a
     * canvas the conversation's list no longer has (the trash) and conversations I am not in leave; then the title
     * filter (NFKC, case-insensitive, as the desktop's) and the newest first.
     */
    fun rows(items: List<CanvasMeta>, store: Store, query: String, now: ZonedDateTime = ZonedDateTime.now()): List<MyCanvasRow> {
        val needle = Search.fold(query.trim())
        return items
            .map { canvas ->
                val live = store.canvasesOf(canvas.channelId)?.firstOrNull { it.id == canvas.id }
                if (live != null && live.version >= canvas.version) live else canvas
            }
            .filter { canvas -> store.canvasesOf(canvas.channelId)?.any { it.id == canvas.id } ?: true }
            .filter { store.channel(it.channelId)?.isMember != false }
            .filter { needle.isEmpty() || Search.fold(it.title).contains(needle) }
            .let { MyCanvasList.sortCanvases(it) }
            .map { canvas -> row(canvas, store, now) }
    }

    fun row(canvas: CanvasMeta, store: Store, now: ZonedDateTime): MyCanvasRow = MyCanvasRow(
        canvas = canvas,
        where = store.channel(canvas.channelId)?.let { channelTitle(it, store) } ?: L10n.str(R.string.common_conversation),
        editor = store.users[canvas.updatedBy]?.displayName?.takeIf { it.isNotBlank() } ?: L10n.str(R.string.common_member),
        updated = Timeline.sinceLabel(canvas.updatedAt, now) ?: "",
        progress = CanvasText.taskProgress(canvas.taskTotal, canvas.taskDone),
    )

    fun title(canvas: CanvasMeta): String = canvas.title.ifBlank { L10n.str(R.string.canvases_pane_untitled_canvas) }

    /** The row's second line: 「#lab · 山田 · 14:05」. */
    fun subtitle(row: MyCanvasRow): String = listOf(row.where, row.editor, row.updated).filter { it.isNotEmpty() }.joinToString(" · ")

    /** What TalkBack reads for a row: 「キャンバス「議事録」、#lab、タブ、最後に編集 山田、14:05、タスク 3/5」. */
    fun spoken(row: MyCanvasRow): String = buildList {
        add(L10n.str(R.string.canvases_pane_canvas, title(row.canvas)))
        add(row.where)
        if (row.canvas.isChannelTab) add(L10n.str(R.string.common_tab))
        add(L10n.str(R.string.canvases_pane_last_edited_by, row.editor))
        if (row.updated.isNotEmpty()) add(row.updated)
        row.progress?.let { add(L10n.str(R.string.canvases_pane_tasks, it)) }
    }.joinToString(L10n.str(R.string.common_list_separator))

    /** The text of an empty list: [headline, detail]. */
    fun empty(query: String, offline: Boolean): Pair<String, String> = when {
        query.isNotBlank() -> L10n.str(R.string.canvases_pane_no_canvases_match_the_title) to L10n.str(R.string.canvases_pane_use_search_text_too_to_find)
        offline -> L10n.str(R.string.canvases_pane_no_canvases_on_this_device) to L10n.str(R.string.canvases_pane_the_list_loads_when_youre_online)
        else -> L10n.str(R.string.canvases_pane_no_canvases_yet) to L10n.str(R.string.canvases_pane_create_one_from_a_conversations_canvas)
    }

    /** The notice over a list read from the device. */
    val OFFLINE_NOTICE: String get() = L10n.str(R.string.canvases_pane_offline_showing_the_list_on_this)

    /**
     * A row tapped: a conversation I am in opens on its 「キャンバス」 tab with that canvas, pushed onto the home stack
     * over this list (MainNav.openCanvas keeps the list under it: back → 「メッセージ」 → the list). One this device does
     * not have (or is not a member of) goes the `/c/` link's way (AppController.openCanvasLink: it says why it cannot
     * open, or lands it once the conversation is known).
     */
    fun open(stack: List<Route>, store: Store, canvas: CanvasMeta): MyCanvasOpen =
        if (store.channel(canvas.channelId)?.isMember == true) MyCanvasOpen.Push(MainNav.openCanvas(stack, canvas.channelId, canvas.id))
        else MyCanvasOpen.Link(canvas.id)
}

/**
 * M78 (CANVAS.md §21.2): the home's 「キャンバス」 — the canvases of all my conversations, most recently updated first,
 * 50 at a time as the end comes near; filtered by title, the keyboard's search (and 「本文も検索する」) searching their
 * bodies in the search's 「キャンバス」 tab. Pulled to refresh; offline, the copies kept on this device (marked so).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun CanvasesPane(
    controller: AppController,
    version: Int,
    list: MyCanvasList,
    listState: LazyListState,
    onOpen: (CanvasMeta) -> Unit,
    onSearchBodies: (String) -> Unit,
) {
    val store = controller.store
    val state by list.state.collectAsState()
    var query by rememberSaveable { mutableStateOf("") }
    var refreshing by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    // The first page when the list opens (the tile clears it); again when the connection comes back after an offline list.
    LaunchedEffect(list) { if (list.state.value.items == null) list.refresh() }
    LaunchedEffect(controller.engineStatus) {
        if (controller.engineStatus == EngineStatus.ONLINE && list.state.value.offline) list.refresh()
    }
    val now = remember(version, state) { ZonedDateTime.now() }
    val rows = remember(version, state, query) { MyCanvases.rows(state.items ?: emptyList(), store, query, now) }
    val nearEnd by remember(listState) {
        derivedStateOf {
            val info = listState.layoutInfo
            val last = info.visibleItemsInfo.lastOrNull()?.index ?: return@derivedStateOf false
            last >= info.totalItemsCount - 4
        }
    }
    // Without a filter the next page comes as the end comes near; with one, 「さらに読み込む」 (a filter matching few rows
    // would otherwise read every page). Not again after a failed page (its row retries).
    LaunchedEffect(nearEnd, state.nextCursor, query.isBlank()) {
        if (nearEnd && query.isBlank() && state.canLoadMore && state.failure == null) list.loadMore()
    }
    val submit = { val q = query.trim(); if (q.isNotEmpty()) onSearchBodies(q) }

    Column(Modifier.fillMaxSize()) {
        OutlinedTextField(
            query, { query = it }, singleLine = true,
            placeholder = { Text(stringResource(R.string.canvases_pane_filter_by_title)) },
            leadingIcon = { Icon(Icons.Default.Search, contentDescription = null) },
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
            keyboardActions = KeyboardActions(onSearch = { submit() }),
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp)
                .semantics { contentDescription = L10n.str(R.string.canvases_pane_filter_by_title_press_search_to) },
        )
        if (state.offline) OfflineStrip(onRetry = { scope.launch { list.refresh() } })
        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = {
                refreshing = true
                scope.launch { try { list.refresh() } finally { refreshing = false } }
            },
            modifier = Modifier.weight(1f).fillMaxWidth(),
        ) {
            LazyColumn(Modifier.fillMaxSize(), state = listState) {
                val items = state.items
                when {
                    items == null -> item(key = "loading") {
                        Box(Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) {
                            CircularProgressIndicator(Modifier.size(28.dp).semantics { contentDescription = L10n.str(R.string.canvases_pane_loading) })
                        }
                    }
                    rows.isEmpty() -> item(key = "empty") {
                        EmptyCanvases(query, state, controller, onSearchBodies = submit, onRetry = { scope.launch { list.refresh() } })
                    }
                    else -> {
                        items(rows, key = { it.canvas.id }) { row ->
                            CanvasListRow(row, onClick = { onOpen(row.canvas) })
                            HorizontalDivider()
                        }
                        if (query.isNotBlank()) {
                            item(key = "bodies") {
                                TextButton(onClick = submit, modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                                    Text(stringResource(R.string.canvases_pane_search_canvas_text_for, query.trim()))
                                }
                            }
                        }
                        item(key = "more") { MoreRow(state, controller, manual = query.isNotBlank(), onMore = { scope.launch { list.loadMore() } }) }
                    }
                }
            }
        }
    }
}

@Composable
private fun CanvasListRow(row: MyCanvasRow, onClick: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    val spoken = MyCanvases.spoken(row)
    Row(
        Modifier.fillMaxWidth().heightIn(min = 56.dp)
            .clickable(role = Role.Button, onClickLabel = stringResource(R.string.common_open), onClick = onClick)
            .clearAndSetSemantics {
                contentDescription = spoken
                role = Role.Button
                onClick(label = L10n.str(R.string.common_open)) { onClick(); true }
            }
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(40.dp).background(colors.primaryContainer, RoundedCornerShape(10.dp)), contentAlignment = Alignment.Center) {
            Icon(Icons.AutoMirrored.Outlined.Article, contentDescription = null, tint = colors.onPrimaryContainer, modifier = Modifier.size(22.dp))
        }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    MyCanvases.title(row.canvas), style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold,
                    maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false),
                )
                if (row.canvas.isChannelTab) {
                    Spacer(Modifier.width(6.dp))
                    Surface(shape = RoundedCornerShape(6.dp), color = colors.secondaryContainer) {
                        Text(stringResource(R.string.common_tab), style = MaterialTheme.typography.labelSmall, color = colors.onSecondaryContainer, modifier = Modifier.padding(horizontal = 6.dp, vertical = 1.dp))
                    }
                }
            }
            Text(MyCanvases.subtitle(row), style = MaterialTheme.typography.bodySmall, color = colors.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        row.progress?.let {
            Spacer(Modifier.width(8.dp))
            Text(it, style = MaterialTheme.typography.labelMedium, color = colors.onSurfaceVariant)
        }
    }
}

@Composable
private fun OfflineStrip(onRetry: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    Row(
        Modifier.fillMaxWidth().background(colors.surfaceContainerHigh).padding(start = 16.dp, end = 4.dp)
            .semantics { liveRegion = LiveRegionMode.Polite },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Outlined.CloudOff, contentDescription = null, tint = colors.onSurfaceVariant, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(8.dp))
        Text(MyCanvases.OFFLINE_NOTICE, style = MaterialTheme.typography.bodySmall, color = colors.onSurfaceVariant, modifier = Modifier.weight(1f))
        TextButton(onClick = onRetry) { Text(stringResource(R.string.common_reload)) }
    }
}

@Composable
private fun EmptyCanvases(query: String, state: MyCanvasesState, controller: AppController, onSearchBodies: () -> Unit, onRetry: () -> Unit) {
    val failure = state.failure
    Column(
        Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 48.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        if (failure != null && !state.offline) {
            Text(stringResource(R.string.common_couldnt_load_the_canvas), style = MaterialTheme.typography.titleSmall)
            Text(controller.describe(failure), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
            OutlinedButton(onClick = onRetry, modifier = Modifier.padding(top = 8.dp)) { Text(stringResource(R.string.common_reload)) }
            return@Column
        }
        val (headline, detail) = MyCanvases.empty(query, state.offline)
        Text(headline, style = MaterialTheme.typography.titleSmall, textAlign = TextAlign.Center)
        Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
        if (query.isNotBlank()) {
            OutlinedButton(onClick = onSearchBodies, modifier = Modifier.padding(top = 8.dp)) {
                Icon(Icons.Default.Search, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(6.dp))
                Text(stringResource(R.string.canvases_pane_search_text_too))
            }
        }
    }
}

/** The list's end: a page on its way, a failed page (to retry), or — filtering — 「さらに読み込む」. */
@Composable
private fun MoreRow(state: MyCanvasesState, controller: AppController, manual: Boolean, onMore: () -> Unit) {
    val failure = state.failure
    when {
        state.loadingMore -> Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) {
            CircularProgressIndicator(Modifier.size(24.dp).semantics { contentDescription = L10n.str(R.string.canvases_pane_loading_more) })
        }
        state.offline -> Unit
        failure != null && state.nextCursor != null -> Column(Modifier.fillMaxWidth().padding(8.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text(controller.describe(failure), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error, textAlign = TextAlign.Center)
            TextButton(onClick = onMore) { Text(stringResource(R.string.common_load_again)) }
        }
        manual && state.nextCursor != null -> TextButton(onClick = onMore, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.common_load_more)) }
        else -> Spacer(Modifier.size(1.dp))
    }
}
