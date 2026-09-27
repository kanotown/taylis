package jp.chikuwachat.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.AlternateEmail
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.Category
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.DateRange
import androidx.compose.material.icons.filled.Forum
import androidx.compose.material.icons.filled.History
import androidx.compose.material.icons.filled.Link
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.SearchOff
import androidx.compose.material.icons.filled.SwapVert
import androidx.compose.material.icons.filled.Tag
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.DateRangePicker
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.PrimaryTabRow
import androidx.compose.material3.SearchBar
import androidx.compose.material3.SearchBarDefaults
import androidx.compose.material3.SelectableDates
import androidx.compose.material3.Surface
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDateRangePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.isTraversalGroup
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.FileItem
import jp.chikuwachat.android.api.MessageOut
import jp.chikuwachat.android.api.SearchHit
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.sync.ChannelState
import jp.chikuwachat.android.sync.Store
import kotlinx.coroutines.flow.distinctUntilChanged
import java.time.LocalDate
import java.time.ZoneOffset

// M16b: the search screen. A Material 3 search bar whose expanded state offers suggestions (recent searches and
// quick filters, or while typing: the words, people and conversations), and the results under it: count, the
// メッセージ / ファイル tabs, filter chips, the sort menu and an endless list. Same behaviour and wording as the
// desktop (search.ts, SearchBar.tsx, SearchView.tsx).

/** The search on screen survives rotation (and a trip to a result) as JSON. */
val SearchParamsSaver: Saver<SearchParams?, String> = Saver(
    save = { value -> value?.let { Codec.plain.encodeToString(SearchParams.serializer(), it) } },
    restore = { raw -> runCatching { Codec.plain.decodeFromString(SearchParams.serializer(), raw) }.getOrNull() },
)

/**
 * The results of the search on screen, kept while a result is open so that 「検索結果に戻る」 shows the same page
 * without asking again (the list position lives in the caller's LazyListState).
 */
@Stable
class SearchResults {
    var params by mutableStateOf<SearchParams?>(null)
        private set
    var hits by mutableStateOf<List<SearchHit>>(emptyList())
        private set
    var keywords by mutableStateOf<List<String>>(emptyList())
        private set
    var total by mutableIntStateOf(0)
        private set
    var capped by mutableStateOf(false)
        private set
    var hasMore by mutableStateOf(false)
        private set
    var unresolved by mutableStateOf<List<String>>(emptyList())
        private set
    var loading by mutableStateOf(false)
        private set
    var loaded by mutableStateOf(false)
        private set
    var failed by mutableStateOf(false)
        private set
    private var request = 0

    /** Files tab (GET /files: file names, newest first) for the words and the channel filter. */
    var files by mutableStateOf<List<FileItem>?>(null)
        private set
    var filesCursor by mutableStateOf<String?>(null)
        private set
    var filesLoading by mutableStateOf(false)
        private set
    private var filesKey: Pair<String?, String?>? = null
    private var filesRequest = 0

    /** A different search: the first page of it (the same one again keeps what is shown). */
    suspend fun show(controller: AppController, next: SearchParams) {
        if (next == params && (loaded || loading)) return
        params = next
        hits = emptyList()
        keywords = emptyList()
        total = 0
        capped = false
        hasMore = false
        unresolved = emptyList()
        loaded = false
        load(controller, 0)
    }

    suspend fun retry(controller: AppController) = load(controller, hits.size)

    suspend fun loadMore(controller: AppController) {
        if (hasMore && !loading) load(controller, hits.size)
    }

    private suspend fun load(controller: AppController, offset: Int) {
        val current = params ?: return
        if (Search.isEmpty(current)) return
        val id = ++request
        loading = true
        failed = false
        try {
            val result = controller.searchMessages(Search.toQuery(current), offset)
            if (id != request) return
            result.onSuccess { out ->
                hits = if (offset == 0) out.hits else (hits + out.hits).distinctBy { it.message.id }
                keywords = out.keywords
                total = out.total
                capped = out.totalCapped
                hasMore = out.hasMore
                unresolved = out.filters?.unresolved ?: emptyList()
                loaded = true
            }.onFailure { failed = true }
        } finally {
            if (id == request) loading = false
        }
    }

    suspend fun showFiles(controller: AppController, q: String?, channelId: String?) {
        val key = q to channelId
        if (key == filesKey && (files != null || filesLoading)) return
        filesKey = key
        files = null
        filesCursor = null
        loadFiles(controller, more = false)
    }

    suspend fun loadMoreFiles(controller: AppController) {
        if (filesCursor != null && !filesLoading) loadFiles(controller, more = true)
    }

    private suspend fun loadFiles(controller: AppController, more: Boolean) {
        val (q, channelId) = filesKey ?: return
        val id = ++filesRequest
        filesLoading = true
        try {
            val result = controller.listFiles(channelId, q, if (more) filesCursor else null)
            if (id != filesRequest) return
            result.onSuccess { page ->
                files = if (more) (files ?: emptyList()) + page.items else page.items
                filesCursor = page.nextCursor?.takeIf { page.items.isNotEmpty() }
            }.onFailure {
                controller.error = controller.describe(it)
                if (files == null) {
                    files = emptyList()
                    filesKey = null // asked again when the tab or the search comes back
                }
            }
        } finally {
            if (id == filesRequest) filesLoading = false
        }
    }
}

// --- the search bar and its suggestions -------------------------------------------------------------------

/**
 * The bar across the top while searching. Expanded (full screen) it lists suggestions; collapsed it shows the
 * words of the search on screen. `onSearch` runs a search picked here (it goes to the recent searches).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SearchTopBar(
    controller: AppController,
    version: Int,
    text: String,
    onTextChange: (String) -> Unit,
    expanded: Boolean,
    onExpandedChange: (Boolean) -> Unit,
    recent: List<SearchParams>,
    onRemoveRecent: (SearchParams) -> Unit,
    onClearRecent: () -> Unit,
    onSearch: (SearchParams) -> Unit,
    onBack: () -> Unit,
    placeholder: String,
) {
    val store = controller.store
    val rows = remember(text, recent, version) {
        Search.suggestions(text, store.users.values, store.channels.values, recent) { channelTitle(it, store) }
    }
    // Opening the suggestions puts the cursor in the box (the bar only follows focus by itself).
    val focus = remember { FocusRequester() }
    LaunchedEffect(expanded) { if (expanded) runCatching { focus.requestFocus() } }
    Box(Modifier.fillMaxWidth().semantics { isTraversalGroup = true }) {
        SearchBar(
            inputField = {
                SearchBarDefaults.InputField(
                    // A hardware Enter searches too (tablets, Chromebooks; the soft keyboard uses the IME action).
                    modifier = Modifier.focusRequester(focus).onPreviewKeyEvent { event ->
                        if (event.key != Key.Enter && event.key != Key.NumPadEnter) return@onPreviewKeyEvent false
                        if (event.type == KeyEventType.KeyDown && text.isNotBlank()) onSearch(SearchParams(q = text.trim()))
                        true
                    },
                    query = text,
                    onQueryChange = onTextChange,
                    onSearch = { words -> if (words.isNotBlank()) onSearch(SearchParams(q = words.trim())) },
                    expanded = expanded,
                    onExpandedChange = onExpandedChange,
                    placeholder = { Text(placeholder, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    leadingIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "戻る") } },
                    trailingIcon = {
                        if (text.isNotEmpty()) IconButton(onClick = { onTextChange(""); onExpandedChange(true) }) { Icon(Icons.Default.Close, contentDescription = "入力を消す") }
                    },
                )
            },
            expanded = expanded,
            onExpandedChange = onExpandedChange,
            modifier = Modifier.align(Alignment.TopCenter),
        ) {
            SuggestionList(store, rows, text, onPick = onSearch, onRemoveRecent = onRemoveRecent, onClearRecent = onClearRecent)
        }
    }
}

@Composable
private fun ColumnScope.SuggestionList(
    store: Store,
    rows: List<Suggestion>,
    text: String,
    onPick: (SearchParams) -> Unit,
    onRemoveRecent: (SearchParams) -> Unit,
    onClearRecent: () -> Unit,
) {
    fun group(row: Suggestion?): String? = when (row) {
        null -> null
        is Suggestion.Kind, Suggestion.Thread -> "filter"
        is Suggestion.Recent -> "recent"
        is Suggestion.Words -> "words"
        is Suggestion.Person -> "person"
        is Suggestion.Conversation -> "conversation"
    }
    LazyColumn(Modifier.fillMaxWidth().weight(1f).imePadding()) {
        itemsIndexed(rows, key = { index, row -> suggestionKey(row, index) }) { index, row ->
            val here = group(row)
            if (here != group(rows.getOrNull(index - 1))) {
                when (here) {
                    "recent" -> SuggestionHeader("最近の検索", action = if (text.isBlank()) ("履歴を消去" to onClearRecent) else null)
                    "filter" -> SuggestionHeader("絞り込み")
                    "person" -> SuggestionHeader("人 (この人の投稿)")
                    "conversation" -> SuggestionHeader("チャンネル (この中を検索)")
                }
            }
            SuggestionRow(store, row, onClick = { onPick(row.toParams()) }, onRemove = (row as? Suggestion.Recent)?.let { { onRemoveRecent(it.params) } })
        }
    }
}

private fun suggestionKey(row: Suggestion, index: Int): String = when (row) {
    is Suggestion.Person -> "u:" + row.user.id
    is Suggestion.Conversation -> "c:" + row.channel.id
    is Suggestion.Kind -> "h:" + row.flag
    else -> "$index:" + row::class.simpleName
}

@Composable
private fun SuggestionHeader(title: String, action: Pair<String, () -> Unit>? = null) {
    Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 8.dp, top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(title, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
        if (action != null) TextButton(onClick = action.second) { Text(action.first) }
    }
}

@Composable
private fun SuggestionRow(store: Store, row: Suggestion, onClick: () -> Unit, onRemove: (() -> Unit)?) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    ListItem(
        headlineContent = {
            when (row) {
                is Suggestion.Words -> Text(
                    buildAnnotatedString {
                        append("「")
                        withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(row.q) }
                        append("」を検索")
                    },
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                is Suggestion.Recent -> Text(describeSearch(store, row.params), maxLines = 1, overflow = TextOverflow.Ellipsis)
                is Suggestion.Person -> Text(row.user.displayName, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                is Suggestion.Conversation -> Text(channelTitle(row.channel, store).removePrefix("#"), maxLines = 1, overflow = TextOverflow.Ellipsis)
                is Suggestion.Kind -> Text((Search.HAS_LABELS[row.flag] ?: row.flag) + "のメッセージ")
                Suggestion.Thread -> Text("スレッド内のメッセージ")
            }
        },
        supportingContent = (row as? Suggestion.Person)?.let { { Text("@" + it.user.username, color = muted) } },
        leadingContent = {
            when (row) {
                is Suggestion.Words -> Icon(Icons.Default.Search, contentDescription = null, tint = muted)
                is Suggestion.Recent -> Icon(Icons.Default.History, contentDescription = null, tint = muted)
                is Suggestion.Person -> Avatar(row.user.id, row.user.displayName, size = 28.dp, presence = store.presenceOf(row.user.id))
                is Suggestion.Conversation -> Icon(conversationIcon(row.channel), contentDescription = null, tint = muted)
                is Suggestion.Kind -> Icon(kindIcon(row.flag), contentDescription = null, tint = muted)
                Suggestion.Thread -> Icon(Icons.Default.Forum, contentDescription = null, tint = muted)
            }
        },
        trailingContent = onRemove?.let { remove -> { IconButton(onClick = remove) { Icon(Icons.Default.Close, contentDescription = "履歴から消す", tint = muted) } } },
        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick),
    )
}

/** One line for a search, with names from the store (「設計」 · 送信者: 田中 · #general · 過去 7 日間). */
fun describeSearch(store: Store, params: SearchParams): String =
    Search.describe(params, userName = { store.users[it]?.displayName }, channelName = { id -> store.channel(id)?.let { channelTitle(it, store) } })

private fun conversationIcon(channel: ChannelState?): ImageVector = when (channel?.channel?.type) {
    "private" -> Icons.Default.Lock
    "public" -> Icons.Default.Tag
    else -> Icons.Default.AlternateEmail
}

private fun kindIcon(flag: String): ImageVector = when (flag) {
    "file" -> Icons.Default.AttachFile
    "link" -> Icons.Default.Link
    "pin" -> Icons.Default.PushPin
    else -> Icons.Default.Category
}

// --- results ----------------------------------------------------------------------------------------------

/** 「検索結果に戻る」 over a conversation opened from the results (the page comes back as it was). */
@Composable
fun BackToSearchStrip(description: String, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.secondaryContainer).clickable(onClick = onClick).padding(horizontal = 12.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = null, tint = MaterialTheme.colorScheme.onSecondaryContainer, modifier = Modifier.size(16.dp))
        Spacer(Modifier.width(6.dp))
        Text("検索結果に戻る", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSecondaryContainer)
        Spacer(Modifier.width(8.dp))
        Text(description, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSecondaryContainer.copy(alpha = 0.8f), maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** Tab index of the files tab. */
const val SEARCH_TAB_FILES = 1

@Composable
fun SearchResultsPane(
    controller: AppController,
    version: Int,
    params: SearchParams,
    results: SearchResults,
    tab: Int,
    onTabChange: (Int) -> Unit,
    onChange: (SearchParams) -> Unit,
    listState: LazyListState,
    filesState: LazyListState,
    onLoadMore: () -> Unit,
    onLoadMoreFiles: () -> Unit,
    onRetry: () -> Unit,
    onOpen: (MessageOut) -> Unit,
    onOpenFile: (FileItem) -> Unit,
) {
    val filesOnly = tab == SEARCH_TAB_FILES
    Column(Modifier.fillMaxSize()) {
        PrimaryTabRow(selectedTabIndex = tab) {
            Tab(selected = tab == 0, onClick = { onTabChange(0) }, text = { Text("メッセージ") })
            Tab(selected = filesOnly, onClick = { onTabChange(SEARCH_TAB_FILES) }, text = { Text("ファイル") })
        }
        FilterRow(controller, version, params, onChange, filesOnly)
        if (filesOnly) {
            FileResults(controller, results, filesState, onLoadMoreFiles, onOpenFile)
        } else {
            MessageResults(controller, version, params, results, onChange, listState, onLoadMore, onRetry, onOpen)
        }
    }
}

@Composable
private fun MessageResults(
    controller: AppController,
    version: Int,
    params: SearchParams,
    results: SearchResults,
    onChange: (SearchParams) -> Unit,
    listState: LazyListState,
    onLoadMore: () -> Unit,
    onRetry: () -> Unit,
    onOpen: (MessageOut) -> Unit,
) {
    val words = params.q.isNotBlank()
    // Endless list: the next page once the end is near (and again after it arrived, while still near). The
    // layout must already hold the rows: a stale one would ask for page 2 before page 1 is even on screen.
    LaunchedEffect(listState, results) {
        snapshotFlow {
            val info = listState.layoutInfo
            val count = results.hits.size
            val last = info.visibleItemsInfo.lastOrNull()?.index ?: -1
            results.hasMore && !results.loading && count > 0 && info.totalItemsCount >= count && last >= count - 5
        }.distinctUntilChanged().collect { near -> if (near) onLoadMore() }
    }
    Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(
            if (results.loaded) Search.totalLabel(results.total, results.capped) else "",
            style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f),
        )
        SortMenu(sort = if (words) params.sort else Search.NEWEST, enabled = words, onChange = { onChange(params.copy(sort = it)) })
    }
    if (results.unresolved.isNotEmpty()) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp).background(MaterialTheme.colorScheme.errorContainer, RoundedCornerShape(8.dp)).padding(horizontal = 10.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Default.Warning, contentDescription = null, tint = MaterialTheme.colorScheme.onErrorContainer, modifier = Modifier.size(16.dp))
            Spacer(Modifier.width(6.dp))
            Text("見つからない条件があります: " + results.unresolved.joinToString(" "), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onErrorContainer)
        }
    }
    LazyColumn(Modifier.fillMaxSize(), state = listState) {
        when {
            results.loaded && results.hits.isEmpty() -> item(key = "empty") {
                EmptyResults(filtered = Search.hasFilters(params), onClear = { onChange(Search.cleared(params)) })
            }
            else -> items(results.hits, key = { it.message.id }) { hit ->
                ResultRow(controller, version, hit.message, results.keywords, onOpen = { onOpen(hit.message) })
                HorizontalDivider()
            }
        }
        if (results.loading) {
            // Keyed by page: the list keeps its place by the first row's key, and a first-page spinner that
            // stayed on as the page-2 spinner would scroll the list to the end.
            item(key = "loading:" + results.hits.size) {
                Row(Modifier.fillMaxWidth().padding(16.dp), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.width(8.dp))
                    Text(if (results.hits.isEmpty()) "検索しています…" else "続きを読み込んでいます…", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        } else if (results.failed) {
            item(key = "retry") {
                Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) {
                    OutlinedButton(onClick = onRetry) { Text("もう一度読み込む") }
                }
            }
        }
    }
}

@Composable
private fun SortMenu(sort: String, enabled: Boolean, onChange: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        TextButton(onClick = { open = true }, enabled = enabled) {
            Icon(Icons.Default.SwapVert, contentDescription = null, modifier = Modifier.size(18.dp))
            Spacer(Modifier.width(4.dp))
            Text(if (sort == Search.RELEVANCE) "関連度順" else "新しい順")
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            listOf(Search.RELEVANCE to "関連度順", Search.NEWEST to "新しい順").forEach { (value, label) ->
                DropdownMenuItem(
                    text = { Text(label) },
                    leadingIcon = { if (sort == value) Icon(Icons.Default.Check, contentDescription = null) else Spacer(Modifier.size(24.dp)) },
                    onClick = { open = false; if (value != sort) onChange(value) },
                )
            }
        }
    }
}

@Composable
private fun EmptyResults(filtered: Boolean, onClear: () -> Unit) {
    Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 48.dp), horizontalAlignment = Alignment.CenterHorizontally) {
        Icon(Icons.Default.SearchOff, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(40.dp))
        Text("見つかりませんでした", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 12.dp))
        Text(
            if (filtered) "条件を減らすと見つかるかもしれません。" else "別の言葉や、より短い言葉で試してください。",
            style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 4.dp),
        )
        if (filtered) Button(onClick = onClear, modifier = Modifier.padding(top = 16.dp)) { Text("条件をクリアして検索") }
    }
}

/** Conversation, 「スレッドの返信」, sender, time, the body with the matched words marked, attached file names. */
@Composable
private fun ResultRow(controller: AppController, version: Int, message: MessageOut, keywords: List<String>, onOpen: () -> Unit) {
    val store = controller.store
    val channel = store.channel(message.channelId)
    val sender = store.users[message.senderId]?.displayName ?: "?"
    val text = remember(message.id, message.body, version) { plainText(Mentions.toNames(message.body, store.users, store.groups), maxLength = 400) }
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Column(Modifier.fillMaxWidth().clickable(onClickLabel = if (message.parentId != null) "スレッドで表示" else "会話で表示", onClick = onOpen).padding(horizontal = 16.dp, vertical = 10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) {
                Icon(conversationIcon(channel), contentDescription = null, tint = muted, modifier = Modifier.size(14.dp))
                Spacer(Modifier.width(4.dp))
                Text(
                    channel?.let { channelTitle(it, store).removePrefix("#") } ?: "?",
                    style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, color = muted,
                    maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false),
                )
                if (message.parentId != null) {
                    Spacer(Modifier.width(6.dp))
                    Surface(shape = RoundedCornerShape(4.dp), color = MaterialTheme.colorScheme.secondaryContainer) {
                        Text("スレッドの返信", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSecondaryContainer, maxLines = 1, modifier = Modifier.padding(horizontal = 6.dp, vertical = 1.dp))
                    }
                }
            }
            Spacer(Modifier.width(8.dp))
            Text(Timeline.fullLabel(message.createdAt), style = MaterialTheme.typography.labelSmall, color = muted, maxLines = 1)
        }
        Row(Modifier.padding(top = 6.dp)) {
            Avatar(message.senderId, sender, size = 36.dp)
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text(sender, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (text.isNotEmpty()) Text(highlighted(text, keywords), style = MaterialTheme.typography.bodyMedium, maxLines = 3, overflow = TextOverflow.Ellipsis)
                message.attachments.take(3).forEach { attachment ->
                    Row(Modifier.padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Outlined.Description, contentDescription = null, tint = muted, modifier = Modifier.size(14.dp))
                        Spacer(Modifier.width(4.dp))
                        Text(highlighted(attachment.filename, keywords), style = MaterialTheme.typography.labelMedium, color = muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
                if (message.attachments.size > 3) Text("ほか ${message.attachments.size - 3} 件のファイル", style = MaterialTheme.typography.labelSmall, color = muted)
            }
        }
    }
}

@Composable
private fun FileResults(controller: AppController, results: SearchResults, state: LazyListState, onLoadMore: () -> Unit, onOpen: (FileItem) -> Unit) {
    LaunchedEffect(state, results) {
        snapshotFlow {
            val info = state.layoutInfo
            val count = results.files?.size ?: 0
            val last = info.visibleItemsInfo.lastOrNull()?.index ?: -1
            results.filesCursor != null && !results.filesLoading && count > 0 && info.totalItemsCount >= count && last >= count - 5
        }.distinctUntilChanged().collect { near -> if (near) onLoadMore() }
    }
    val files = results.files
    LazyColumn(Modifier.fillMaxSize(), state = state) {
        when {
            files == null -> Unit
            files.isEmpty() -> item(key = "empty") {
                Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 48.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Icon(Icons.Default.SearchOff, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(40.dp))
                    Text("ファイルは見つかりませんでした", style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 12.dp))
                    Text("ファイル名で探します。", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp))
                }
            }
            else -> items(files, key = { it.attachment.id }) { item ->
                FileRow(item, controller, onClick = { onOpen(item) })
                HorizontalDivider()
            }
        }
        if (results.filesLoading) {
            item(key = "loading:" + (files?.size ?: -1)) {
                Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp) }
            }
        }
    }
}

// --- filter chips ---------------------------------------------------------------------------------------

@Composable
private fun FilterRow(controller: AppController, version: Int, params: SearchParams, onChange: (SearchParams) -> Unit, filesOnly: Boolean) {
    val store = controller.store
    var picker by remember { mutableStateOf<String?>(null) }
    val sender = params.fromUserId?.let { store.users[it] }
    val channel = params.channelId?.let { store.channel(it) }
    // Per tab: the row keeps its place by the first chip's key, which would hide 送信者 after the files tab.
    key(filesOnly) { LazyRow(
        Modifier.fillMaxWidth(),
        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (!filesOnly) item(key = "from") {
            FilterPill(
                label = if (params.fromUserId != null) "送信者: " + (sender?.displayName ?: "?") else "送信者",
                icon = Icons.Default.Person,
                selected = params.fromUserId != null,
                onClick = { picker = "from" },
                onClear = { onChange(params.copy(fromUserId = null)) },
            )
        }
        item(key = "in") {
            FilterPill(
                label = if (params.channelId != null) channel?.let { channelTitle(it, store) } ?: "?" else "チャンネル",
                icon = Icons.Default.Tag,
                selected = params.channelId != null,
                onClick = { picker = "in" },
                onClear = { onChange(params.copy(channelId = null)) },
            )
        }
        if (!filesOnly) {
            item(key = "date") { DateFilter(params, onChange) }
            item(key = "kind") { KindFilter(params, onChange) }
            item(key = "thread") {
                FilterChip(
                    selected = params.isThread,
                    onClick = { onChange(params.copy(isThread = !params.isThread)) },
                    label = { Text("スレッド内") },
                    leadingIcon = { Icon(if (params.isThread) Icons.Default.Check else Icons.Default.Forum, contentDescription = null, modifier = Modifier.size(FilterChipDefaults.IconSize)) },
                )
            }
        }
        val clearable = if (filesOnly) params.channelId != null else Search.hasFilters(params)
        if (clearable) item(key = "clear") {
            TextButton(onClick = { onChange(Search.cleared(params)) }) { Text("条件をクリア") }
        }
    } }
    when (picker) {
        "from" -> PersonPicker(controller, version, selected = params.fromUserId, onDismiss = { picker = null }) { id ->
            picker = null
            onChange(params.copy(fromUserId = if (id == params.fromUserId) null else id))
        }
        "in" -> ConversationPicker(controller, version, selected = params.channelId, onDismiss = { picker = null }) { id ->
            picker = null
            onChange(params.copy(channelId = if (id == params.channelId) null else id))
        }
    }
}

/** A filter chip: tapping picks a value; × (shown once set) removes the filter. */
@Composable
private fun FilterPill(label: String, icon: ImageVector, selected: Boolean, onClick: () -> Unit, onClear: () -> Unit) {
    FilterChip(
        selected = selected,
        onClick = onClick,
        label = { Text(label, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 220.dp)) },
        leadingIcon = { Icon(icon, contentDescription = null, modifier = Modifier.size(FilterChipDefaults.IconSize)) },
        trailingIcon = {
            if (selected) {
                Icon(Icons.Default.Close, contentDescription = "この条件を外す", modifier = Modifier.size(FilterChipDefaults.IconSize).clickable(onClick = onClear))
            } else {
                Icon(Icons.Default.ArrowDropDown, contentDescription = null, modifier = Modifier.size(FilterChipDefaults.IconSize))
            }
        },
    )
}

@Composable
private fun DateFilter(params: SearchParams, onChange: (SearchParams) -> Unit) {
    var menu by remember { mutableStateOf(false) }
    var custom by remember { mutableStateOf(false) }
    val label = Search.dateLabel(params.date)
    Box {
        FilterPill(label = label ?: "期間", icon = Icons.Default.DateRange, selected = params.date != null, onClick = { menu = true }, onClear = { onChange(params.copy(date = null)) })
        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
            Search.DATE_PRESETS.forEach { (preset, text) ->
                DropdownMenuItem(
                    text = { Text(text) },
                    leadingIcon = { if (params.date?.preset == preset) Icon(Icons.Default.Check, contentDescription = null) else Spacer(Modifier.size(24.dp)) },
                    onClick = { menu = false; onChange(params.copy(date = SearchDate(preset = preset))) },
                )
            }
            HorizontalDivider()
            DropdownMenuItem(
                text = { Text("日付を指定…") },
                leadingIcon = { if (params.date != null && params.date.preset == null) Icon(Icons.Default.Check, contentDescription = null) else Spacer(Modifier.size(24.dp)) },
                onClick = { menu = false; custom = true },
            )
        }
    }
    if (custom) DateRangeDialog(params.date, onDismiss = { custom = false }) { from, to ->
        custom = false
        onChange(params.copy(date = SearchDate(from = from, to = to)))
    }
}

/** The Material 3 range picker; days are calendar days (UTC midnights in the picker), read in this device's zone. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun DateRangeDialog(current: SearchDate?, onDismiss: () -> Unit, onPick: (from: String?, to: String?) -> Unit) {
    val today = LocalDate.now()
    fun millis(day: String?): Long? = day?.let { runCatching { LocalDate.parse(it) }.getOrNull() }?.atStartOfDay(ZoneOffset.UTC)?.toInstant()?.toEpochMilli()
    fun day(millis: Long?): String? = millis?.let { java.time.Instant.ofEpochMilli(it).atZone(ZoneOffset.UTC).toLocalDate().toString() }
    val state = rememberDateRangePickerState(
        initialSelectedStartDateMillis = millis(current?.from),
        initialSelectedEndDateMillis = millis(current?.to),
        yearRange = 2000..today.year,
        selectableDates = object : SelectableDates {
            override fun isSelectableDate(utcTimeMillis: Long): Boolean =
                !java.time.Instant.ofEpochMilli(utcTimeMillis).atZone(ZoneOffset.UTC).toLocalDate().isAfter(today)
        },
    )
    DatePickerDialog(
        onDismissRequest = onDismiss,
        confirmButton = {
            TextButton(
                enabled = state.selectedStartDateMillis != null,
                onClick = {
                    val from = day(state.selectedStartDateMillis)
                    onPick(from, day(state.selectedEndDateMillis) ?: from)
                },
            ) { Text("この期間で絞り込む") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("キャンセル") } },
    ) {
        DateRangePicker(
            state = state,
            title = { Text("期間を指定", modifier = Modifier.padding(start = 24.dp, end = 12.dp, top = 16.dp)) },
            modifier = Modifier.weight(1f),
        )
    }
}

/** 種類: any of the five flags, all required (the menu stays open while ticking). */
@Composable
private fun KindFilter(params: SearchParams, onChange: (SearchParams) -> Unit) {
    var menu by remember { mutableStateOf(false) }
    Box {
        FilterPill(
            label = if (params.has.isEmpty()) "種類" else params.has.joinToString("・") { Search.HAS_LABELS[it] ?: it },
            icon = Icons.Default.AttachFile,
            selected = params.has.isNotEmpty(),
            onClick = { menu = true },
            onClear = { onChange(params.copy(has = emptyList())) },
        )
        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
            Search.HAS_FLAGS.forEach { flag ->
                val on = flag in params.has
                DropdownMenuItem(
                    text = { Text(Search.HAS_LABELS[flag] ?: flag) },
                    leadingIcon = { Checkbox(checked = on, onCheckedChange = null) },
                    onClick = { onChange(params.copy(has = if (on) params.has - flag else Search.HAS_FLAGS.filter { it in params.has || it == flag })) },
                )
            }
        }
    }
}

/** 送信者: people who can post (deactivated accounts are left out), by name. */
@Composable
private fun PersonPicker(controller: AppController, version: Int, selected: String?, onDismiss: () -> Unit, onPick: (String) -> Unit) {
    val store = controller.store
    var query by remember { mutableStateOf("") }
    val collator = remember { java.text.Collator.getInstance(java.util.Locale.JAPANESE) }
    val people = remember(version, query) {
        val needle = Search.fold(query.trim().removePrefix("@"))
        store.users.values
            .filter { it.deactivatedAt == null && (needle.isEmpty() || Search.fold(it.displayName).contains(needle) || Search.fold(it.username).contains(needle)) }
            .sortedWith { a, b -> collator.compare(a.displayName, b.displayName) }
            .take(100)
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("送信者") },
        text = {
            Column {
                OutlinedTextField(query, { query = it }, placeholder = { Text("名前で絞り込む") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                LazyColumn(Modifier.heightIn(max = 380.dp).padding(top = 8.dp)) {
                    items(people, key = { it.id }) { user ->
                        Row(Modifier.fillMaxWidth().clickable { onPick(user.id) }.padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                            Avatar(user.id, user.displayName, size = 28.dp)
                            Spacer(Modifier.width(10.dp))
                            Text(user.displayName, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                            Spacer(Modifier.width(6.dp))
                            Text("@" + user.username, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, modifier = Modifier.weight(1f))
                            if (user.id == selected) Icon(Icons.Default.Check, contentDescription = "選択中", tint = MaterialTheme.colorScheme.primary)
                        }
                    }
                    if (people.isEmpty()) item { Text("見つかりません", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 12.dp)) }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("閉じる") } },
    )
}

/** チャンネル: conversations I am in (channels and DMs), by name. */
@Composable
private fun ConversationPicker(controller: AppController, version: Int, selected: String?, onDismiss: () -> Unit, onPick: (String) -> Unit) {
    val store = controller.store
    var query by remember { mutableStateOf("") }
    val collator = remember { java.text.Collator.getInstance(java.util.Locale.JAPANESE) }
    val list = remember(version, query) {
        val needle = Search.fold(query.trim().removePrefix("#"))
        store.channels.values
            .filter { it.isMember && (needle.isEmpty() || Search.fold(channelTitle(it, store)).contains(needle)) }
            .sortedWith { a, b -> collator.compare(channelTitle(a, store), channelTitle(b, store)) }
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("チャンネル") },
        text = {
            Column {
                OutlinedTextField(query, { query = it }, placeholder = { Text("会話の名前で絞り込む") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                LazyColumn(Modifier.heightIn(max = 380.dp).padding(top = 8.dp)) {
                    items(list, key = { it.id }) { channel ->
                        Row(Modifier.fillMaxWidth().clickable { onPick(channel.id) }.padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                            Icon(conversationIcon(channel), contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(18.dp))
                            Spacer(Modifier.width(10.dp))
                            Text(channelTitle(channel, store).removePrefix("#"), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                            if (channel.id == selected) Icon(Icons.Default.Check, contentDescription = "選択中", tint = MaterialTheme.colorScheme.primary)
                        }
                    }
                    if (list.isEmpty()) item { Text("見つかりません", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 12.dp)) }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("閉じる") } },
    )
}

// --- keyword highlighting --------------------------------------------------------------------------------

/** Case-insensitive keyword highlighting done on the client (the server only returns the keywords). */
fun highlighted(text: String, keywords: List<String>) = buildAnnotatedString {
    val ranges = keywordRanges(text, keywords)
    var cursor = 0
    for ((start, end) in ranges) {
        if (start > cursor) append(text.substring(cursor, start))
        withStyle(SpanStyle(fontWeight = FontWeight.Bold, background = Color(0x55FFD54F))) { append(text.substring(start, end)) }
        cursor = end
    }
    if (cursor < text.length) append(text.substring(cursor))
}

/** Sorted, non-overlapping [start, end) ranges of every keyword occurrence. */
fun keywordRanges(text: String, keywords: List<String>): List<Pair<Int, Int>> {
    val lower = text.lowercase()
    val found = ArrayList<Pair<Int, Int>>()
    for (keyword in keywords.map { it.lowercase() }.filter { it.isNotEmpty() }.sortedByDescending { it.length }) {
        var index = lower.indexOf(keyword)
        while (index >= 0) {
            found.add(index to index + keyword.length)
            index = lower.indexOf(keyword, index + keyword.length)
        }
    }
    found.sortBy { it.first }
    val merged = ArrayList<Pair<Int, Int>>()
    for (range in found) {
        val last = merged.lastOrNull()
        if (last != null && range.first <= last.second) { if (range.second > last.second) merged[merged.size - 1] = last.first to range.second } else merged.add(range)
    }
    return merged
}
