package jp.chikuwachat.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.navigationBars
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
import androidx.compose.foundation.lazy.rememberLazyListState
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
import androidx.compose.material.icons.filled.DynamicFeed
import androidx.compose.material.icons.filled.Groups
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
import androidx.compose.runtime.collectAsState
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
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.isTraversalGroup
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.api.CanvasMeta
import jp.chikuwachat.android.api.CanvasSearchHit
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
import jp.chikuwachat.android.R
import jp.chikuwachat.android.L10n
import androidx.compose.ui.res.stringResource

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
    /**
     * L8 (TIMES_FEED.md §6): the hits' channels I am not a member of (an `is:times` search finds times I have not joined,
     * archived ones too, which the store may not know): their names, and the preview a hit opens (M27).
     */
    var channels by mutableStateOf<Map<String, jp.chikuwachat.android.api.ChannelOut>>(emptyMap())
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
        channels = emptyMap()
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
                channels = (if (offset == 0) emptyMap() else channels) + out.channels.associateBy { it.id }
                loaded = true
            }.onFailure { failed = true }
        } finally {
            if (id == request) loading = false
        }
    }

    // --- M122: the 「ドキュメント」 tab (GET /search/pages, docs/WIKI.md §8.1) ---

    var pageHits by mutableStateOf<List<jp.chikuwachat.android.api.PageSearchHit>>(emptyList())
        private set
    var pageKeywords by mutableStateOf<List<String>>(emptyList())
        private set
    var pageTotal by mutableIntStateOf(0)
        private set
    var pageCapped by mutableStateOf(false)
        private set
    var pageHasMore by mutableStateOf(false)
        private set
    var pageLoading by mutableStateOf(false)
        private set
    var pageLoaded by mutableStateOf(false)
        private set
    var pageFailed by mutableStateOf(false)
        private set
    private var pageQuery: String? = null
    private var pageRequest = 0

    /** The pages for the words (the same ones again keep what is shown); nothing is sent without words. */
    suspend fun showPages(controller: AppController, q: String) {
        val words = q.trim()
        if (words == pageQuery && (pageLoaded || pageLoading)) return
        pageQuery = words
        pageHits = emptyList()
        pageKeywords = emptyList()
        pageTotal = 0
        pageCapped = false
        pageHasMore = false
        pageLoaded = false
        pageFailed = false
        loadPages(controller, 0)
    }

    suspend fun loadMorePages(controller: AppController) {
        if (pageHasMore && !pageLoading) loadPages(controller, pageHits.size)
    }

    suspend fun retryPages(controller: AppController) = loadPages(controller, pageHits.size)

    private suspend fun loadPages(controller: AppController, offset: Int) {
        val q = pageQuery?.takeIf { it.isNotEmpty() } ?: return
        val id = ++pageRequest
        pageLoading = true
        pageFailed = false
        try {
            val result = controller.searchPages(q, offset)
            if (id != pageRequest) return
            result.onSuccess { out ->
                pageHits = if (offset == 0) out.hits else (pageHits + out.hits).distinctBy { it.page.id }
                pageKeywords = out.keywords
                pageTotal = out.total
                pageCapped = out.totalCapped
                pageHasMore = out.hasMore
                pageLoaded = true
            }.onFailure { pageFailed = true }
        } finally {
            if (id == pageRequest) pageLoading = false
        }
    }

    // --- M58: the 「キャンバス」 tab (GET /search/canvases) ---

    var canvasHits by mutableStateOf<List<CanvasSearchHit>>(emptyList())
        private set
    var canvasKeywords by mutableStateOf<List<String>>(emptyList())
        private set
    var canvasTotal by mutableIntStateOf(0)
        private set
    var canvasCapped by mutableStateOf(false)
        private set
    var canvasHasMore by mutableStateOf(false)
        private set
    var canvasUnresolved by mutableStateOf<List<String>>(emptyList())
        private set
    var canvasLoading by mutableStateOf(false)
        private set
    var canvasLoaded by mutableStateOf(false)
        private set
    var canvasFailed by mutableStateOf(false)
        private set
    private var canvasParams: SearchParams? = null
    private var canvasRequest = 0

    /** The canvases for a search (the same one again keeps what is shown); nothing is sent without anything to look for. */
    suspend fun showCanvases(controller: AppController, next: SearchParams) {
        if (next == canvasParams && (canvasLoaded || canvasLoading)) return
        canvasParams = next
        canvasHits = emptyList()
        canvasKeywords = emptyList()
        canvasTotal = 0
        canvasCapped = false
        canvasHasMore = false
        canvasUnresolved = emptyList()
        canvasLoaded = false
        canvasFailed = false
        loadCanvases(controller, 0)
    }

    suspend fun loadMoreCanvases(controller: AppController) {
        if (canvasHasMore && !canvasLoading) loadCanvases(controller, canvasHits.size)
    }

    suspend fun retryCanvases(controller: AppController) = loadCanvases(controller, canvasHits.size)

    private suspend fun loadCanvases(controller: AppController, offset: Int) {
        val current = canvasParams ?: return
        if (Search.canvasEmpty(current)) return
        val id = ++canvasRequest
        canvasLoading = true
        canvasFailed = false
        try {
            val result = controller.searchCanvases(Search.canvasQuery(current), offset)
            if (id != canvasRequest) return
            result.onSuccess { out ->
                canvasHits = if (offset == 0) out.hits else (canvasHits + out.hits).distinctBy { it.canvas.id }
                canvasKeywords = out.keywords
                canvasTotal = out.total
                canvasCapped = out.totalCapped
                canvasHasMore = out.hasMore
                canvasUnresolved = out.filters?.unresolved ?: emptyList()
                canvasLoaded = true
            }.onFailure { canvasFailed = true }
        } finally {
            if (id == canvasRequest) canvasLoading = false
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
    /** M37: the home's 「移動・検索」 (MOBILE_UI.md §6.2): conversations and people to go to instead of search suggestions. */
    jump: JumpTargets? = null,
) {
    val store = controller.store
    val rows = remember(text, recent, version, jump != null) {
        // The jump screen's empty box keeps the recent searches and quick filters; typing lists conversations instead.
        if (jump != null && text.isNotBlank()) emptyList()
        else Search.suggestions(if (jump != null) "" else text, store.users.values, store.channels.values, recent) { channelTitle(it, store) }
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
                    leadingIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.common_back)) } },
                    trailingIcon = {
                        if (text.isNotEmpty()) IconButton(onClick = { onTextChange(""); onExpandedChange(true) }) { Icon(Icons.Default.Close, contentDescription = stringResource(R.string.common_clear)) }
                    },
                )
            },
            expanded = expanded,
            onExpandedChange = onExpandedChange,
            modifier = Modifier.align(Alignment.TopCenter),
        ) {
            if (jump != null) JumpList(store, version, text, rows, jump, onSearch = onSearch, onRemoveRecent = onRemoveRecent, onClearRecent = onClearRecent)
            else SuggestionList(store, rows, text, onPick = onSearch, onRemoveRecent = onRemoveRecent, onClearRecent = onClearRecent)
        }
    }
}

/** M37: what the jump screen goes to: its recent conversations (newest first) and where a picked row leads. */
class JumpTargets(
    val recent: List<ChannelState>,
    val onOpenConversation: (String) -> Unit,
    /** A person: the DM with them (me: my own DM). */
    val onOpenPerson: (String) -> Unit,
    /** The AI bots (GET /ai/status): the only bots offered, as 「ボット」 after the people (jump-match.json `pick`). */
    val aiBotIds: Set<String> = emptySet(),
)

/**
 * M37 (MOBILE_UI.md §6.2): empty, 「最近の会話」 then the recent searches and quick filters (`rows`); typing, 「会話」 (at
 * most 20), 「人」 and the AI bots' 「ボット」 (at most 10 each) by jump-match.json's rule, then 「"語" をメッセージ検索」 (the results screen).
 */
@Composable
private fun ColumnScope.JumpList(
    store: Store,
    version: Int,
    text: String,
    rows: List<Suggestion>,
    jump: JumpTargets,
    onSearch: (SearchParams) -> Unit,
    onRemoveRecent: (SearchParams) -> Unit,
    onClearRecent: () -> Unit,
) {
    val query = text.trim()
    val meId = store.me?.id
    val userNames: (String) -> List<String> = { id ->
        val user = store.users[id]
        val me = store.me?.takeIf { it.id == id }
        listOfNotNull(user?.displayName ?: me?.displayName, user?.username ?: me?.username)
    }
    val conversations = remember(query, version) {
        if (query.isEmpty()) emptyList() else Jump.conversations(query, store.channels.values, meId, { channelTitle(it, store) }, userNames)
    }
    val people = remember(query, version) { if (query.isEmpty()) emptyList() else Jump.people(query, store.users.values) }
    val bots = remember(query, version) { if (query.isEmpty()) emptyList() else Jump.bots(query, store.users.values, jump.aiBotIds, Jump.MAX_PEOPLE) }
    // The last row (「"語" をメッセージ検索」) scrolls clear of the gesture bar.
    LazyColumn(Modifier.fillMaxWidth().weight(1f).imePadding(), contentPadding = WindowInsets.navigationBars.asPaddingValues()) {
        if (query.isEmpty()) {
            if (jump.recent.isNotEmpty()) {
                item(key = "h:recent-conversations") { SuggestionHeader(stringResource(R.string.search_pane_recent_conversations)) }
                items(jump.recent, key = { "rc:" + it.id }) { channel -> JumpConversationRow(store, channel) { jump.onOpenConversation(channel.id) } }
            }
            itemsIndexed(rows, key = { index, row -> "s:" + suggestionKey(row, index) }) { index, row ->
                val here = if (row is Suggestion.Recent) "recent" else "filter"
                val before = rows.getOrNull(index - 1)?.let { if (it is Suggestion.Recent) "recent" else "filter" }
                if (here != before) {
                    if (here == "recent") SuggestionHeader(stringResource(R.string.search_pane_recent_searches), action = stringResource(R.string.search_pane_clear_history) to onClearRecent) else SuggestionHeader(stringResource(R.string.search_pane_filters))
                }
                SuggestionRow(store, row, onClick = { onSearch(row.toParams()) }, onRemove = (row as? Suggestion.Recent)?.let { { onRemoveRecent(it.params) } })
            }
        } else {
            if (conversations.isNotEmpty()) {
                item(key = "h:conversations") { SuggestionHeader(stringResource(R.string.common_conversation)) }
                items(conversations, key = { "c:" + it.id }) { channel -> JumpConversationRow(store, channel) { jump.onOpenConversation(channel.id) } }
            }
            if (people.isNotEmpty()) {
                item(key = "h:people") { SuggestionHeader(stringResource(R.string.search_pane_people)) }
                items(people, key = { "u:" + it.id }) { user ->
                    val mine = user.id == meId
                    ListItem(
                        headlineContent = { Text(user.displayName + if (mine) stringResource(R.string.common_you_2) else "", fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                        supportingContent = { Text(if (mine) MainTabs.SELF_NOTES_HINT else "@" + user.username, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                        leadingContent = { Avatar(user.id, user.displayName, size = 28.dp, presence = store.presenceOf(user.id)) },
                        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                        modifier = Modifier.fillMaxWidth().clickable(onClickLabel = stringResource(R.string.search_pane_open_dm)) { jump.onOpenPerson(user.id) },
                    )
                }
            }
            if (bots.isNotEmpty()) {
                item(key = "h:bots") { SuggestionHeader(stringResource(R.string.search_pane_bots)) }
                items(bots, key = { "b:" + it.id }) { user ->
                    ListItem(
                        headlineContent = { Text(user.displayName, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                        supportingContent = { Text("@" + user.username, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                        leadingContent = { Avatar(user.id, user.displayName, size = 28.dp) },
                        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                        modifier = Modifier.fillMaxWidth().clickable(onClickLabel = stringResource(R.string.search_pane_open_dm)) { jump.onOpenPerson(user.id) },
                    )
                }
            }
            item(key = "search-words") {
                ListItem(
                    headlineContent = {
                        Text(
                            buildAnnotatedString {
                                append("\"")
                                withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(query) }
                                append(stringResource(R.string.search_pane_search_messages))
                            },
                            maxLines = 1, overflow = TextOverflow.Ellipsis,
                        )
                    },
                    leadingContent = { Icon(Icons.Default.Search, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant) },
                    colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                    modifier = Modifier.fillMaxWidth().clickable { onSearch(SearchParams(q = query)) },
                )
            }
        }
    }
}

/** A conversation on the jump screen: its glyph (a DM: the person), its name, bold when unread. */
@Composable
private fun JumpConversationRow(store: Store, channel: ChannelState, onClick: () -> Unit) {
    val meId = store.me?.id
    val unread = Channels.hasUnread(channel, meId)
    val others = (channel.channel.dmUserIds ?: emptyList()).filter { it != meId }
    val title = channelTitle(channel, store).removePrefix("#")
    ListItem(
        headlineContent = { Text(title, fontWeight = if (unread) FontWeight.Bold else FontWeight.Normal, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        supportingContent = if (channel.isMember) null else { { Text(stringResource(R.string.search_pane_not_joined_preview), color = MaterialTheme.colorScheme.onSurfaceVariant) } },
        leadingContent = {
            when {
                !channel.channel.isDm -> Icon(conversationIcon(channel), contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                others.size > 1 -> Icon(Icons.Default.Groups, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                else -> (others.firstOrNull() ?: meId ?: channel.id).let { id -> Avatar(id, store.users[id]?.displayName ?: title, size = 28.dp, presence = store.presenceOf(id)) }
            }
        },
        trailingContent = if (unread) { { Box(Modifier.size(8.dp).background(MaterialTheme.colorScheme.primary, androidx.compose.foundation.shape.CircleShape).semantics { contentDescription = L10n.str(R.string.common_unread) }) } } else null,
        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick),
    )
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
        is Suggestion.Kind, Suggestion.Thread, Suggestion.Times -> "filter"
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
                    "recent" -> SuggestionHeader(stringResource(R.string.search_pane_recent_searches), action = if (text.isBlank()) (stringResource(R.string.search_pane_clear_history) to onClearRecent) else null)
                    "filter" -> SuggestionHeader(stringResource(R.string.search_pane_filters))
                    "person" -> SuggestionHeader(stringResource(R.string.search_pane_people_their_posts))
                    "conversation" -> SuggestionHeader(stringResource(R.string.search_pane_channels_search_within))
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
                        append(stringResource(R.string.search_pane_search_for))
                        withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(row.q) }
                        append(stringResource(R.string.search_pane_search_for_end))
                    },
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                is Suggestion.Recent -> Text(describeSearch(store, row.params), maxLines = 1, overflow = TextOverflow.Ellipsis)
                is Suggestion.Person -> Text(row.user.displayName, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                is Suggestion.Conversation -> Text(channelTitle(row.channel, store).removePrefix("#"), maxLines = 1, overflow = TextOverflow.Ellipsis)
                is Suggestion.Kind -> Text((Search.HAS_LABELS[row.flag] ?: row.flag) + stringResource(R.string.search_pane_messages))
                Suggestion.Thread -> Text(stringResource(R.string.search_pane_messages_in_threads))
                Suggestion.Times -> Text(stringResource(R.string.search_pane_times_posts_is_times))
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
                Suggestion.Times -> Icon(Icons.Default.DynamicFeed, contentDescription = null, tint = muted)
            }
        },
        trailingContent = onRemove?.let { remove -> { IconButton(onClick = remove) { Icon(Icons.Default.Close, contentDescription = stringResource(R.string.search_pane_remove_from_history), tint = muted) } } },
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
        Text(stringResource(R.string.search_pane_back_to_results), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSecondaryContainer)
        Spacer(Modifier.width(8.dp))
        Text(description, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSecondaryContainer.copy(alpha = 0.8f), maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** Tab index of the files tab. */
const val SEARCH_TAB_FILES = 1

/** M58: tab index of the canvases tab (CANVAS.md §4.8: 「メッセージ / ファイル」 の隣). */
const val SEARCH_TAB_CANVASES = 2

/** M122: tab index of the 「ドキュメント」 tab (docs/WIKI.md §8.1: 「メッセージ / ファイル / キャンバス」 の隣). */
const val SEARCH_TAB_DOCS = 3

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
    canvasesState: LazyListState,
    onLoadMore: () -> Unit,
    onLoadMoreFiles: () -> Unit,
    onLoadMoreCanvases: () -> Unit,
    onRetry: () -> Unit,
    onRetryCanvases: () -> Unit,
    onOpen: (MessageOut) -> Unit,
    onOpenFile: (FileItem) -> Unit,
    onOpenCanvas: (CanvasMeta) -> Unit,
    /** M71: a message an AI answer cites (docs/AI.md §13.3), opened like a result. */
    onOpenCited: (messageId: String, channelId: String, parentId: String?) -> Unit = { _, _, _ -> },
    /** M122: the 「ドキュメント」 tab (the server keeps pages): its state, and a hit opening its page. */
    docs: Boolean = false,
    docsState: LazyListState? = null,
    onLoadMorePages: () -> Unit = {},
    onRetryPages: () -> Unit = {},
    onOpenPage: (String) -> Unit = {},
) {
    Column(Modifier.fillMaxSize()) {
        PrimaryTabRow(selectedTabIndex = tab) {
            Tab(selected = tab == 0, onClick = { onTabChange(0) }, text = { Text(L10n.str(R.string.common_message)) })
            Tab(selected = tab == SEARCH_TAB_FILES, onClick = { onTabChange(SEARCH_TAB_FILES) }, text = { Text(L10n.str(R.string.common_files)) })
            Tab(selected = tab == SEARCH_TAB_CANVASES, onClick = { onTabChange(SEARCH_TAB_CANVASES) }, text = { Text(L10n.str(R.string.common_canvas)) })
            if (docs) Tab(selected = tab == SEARCH_TAB_DOCS, onClick = { onTabChange(SEARCH_TAB_DOCS) }, text = { Text(L10n.str(R.string.docs_title), maxLines = 1, overflow = TextOverflow.Ellipsis) })
        }
        // M122: a page's search takes its modifiers in the words (from:@ before: in:<題名>); no chips.
        if (tab != SEARCH_TAB_DOCS) FilterRow(controller, version, params, onChange, tab)
        when (tab) {
            SEARCH_TAB_DOCS -> PageResults(controller, version, params, results, docsState ?: rememberLazyListState(), onLoadMorePages, onRetryPages, onOpenPage)
            SEARCH_TAB_FILES -> FileResults(controller, results, filesState, onLoadMoreFiles, onOpenFile)
            SEARCH_TAB_CANVASES -> CanvasResults(controller, version, params, results, onChange, canvasesState, onLoadMoreCanvases, onRetryCanvases, onOpenCanvas)
            else -> MessageResults(controller, version, params, results, onChange, listState, onLoadMore, onRetry, onOpen, onOpenCited)
        }
    }
}

/**
 * M58 (CANVAS.md §4.8, the desktop's CanvasSearch.tsx): canvases of my conversations whose title or body matches. A hit
 * shows its conversation, who changed it last and when, the title and the server's plain-text excerpt with the words
 * marked (an image reads 「[画像]」), and opens the canvas in its conversation's 「キャンバス」 tab.
 */
@Composable
private fun CanvasResults(
    controller: AppController,
    version: Int,
    params: SearchParams,
    results: SearchResults,
    onChange: (SearchParams) -> Unit,
    state: LazyListState,
    onLoadMore: () -> Unit,
    onRetry: () -> Unit,
    onOpen: (CanvasMeta) -> Unit,
) {
    val words = params.q.isNotBlank()
    LaunchedEffect(state, results) {
        snapshotFlow {
            val info = state.layoutInfo
            val count = results.canvasHits.size
            val last = info.visibleItemsInfo.lastOrNull()?.index ?: -1
            results.canvasHasMore && !results.canvasLoading && count > 0 && info.totalItemsCount >= count && last >= count - 5
        }.distinctUntilChanged().collect { near -> if (near) onLoadMore() }
    }
    if (Search.canvasEmpty(params)) {
        Text(
            stringResource(R.string.search_pane_type_words_to_search_canvas_titles), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 48.dp),
        )
        return
    }
    Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(
            if (results.canvasLoaded) Search.totalLabel(results.canvasTotal, results.canvasCapped) else "",
            style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f),
        )
        SortMenu(sort = if (words) params.sort else Search.NEWEST, enabled = words, onChange = { onChange(params.copy(sort = it)) })
    }
    if (results.canvasUnresolved.isNotEmpty()) {
        Row(
            Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp).background(MaterialTheme.colorScheme.errorContainer, RoundedCornerShape(8.dp)).padding(horizontal = 10.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Default.Warning, contentDescription = null, tint = MaterialTheme.colorScheme.onErrorContainer, modifier = Modifier.size(16.dp))
            Spacer(Modifier.width(6.dp))
            Text(stringResource(R.string.search_pane_some_filters_dont_apply_to_canvases) + results.canvasUnresolved.joinToString(" "), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onErrorContainer)
        }
    }
    LazyColumn(Modifier.fillMaxSize(), state = state) {
        when {
            results.canvasLoaded && results.canvasHits.isEmpty() -> item(key = "empty") {
                Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 48.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Icon(Icons.Default.SearchOff, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(40.dp))
                    Text(stringResource(R.string.search_pane_no_canvases_found), style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 12.dp))
                    Text(
                        stringResource(R.string.search_pane_searches_the_titles_and_text_of), style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 4.dp),
                    )
                }
            }
            else -> items(results.canvasHits, key = { it.canvas.id }) { hit ->
                CanvasResultRow(controller, version, hit, results.canvasKeywords, onOpen = { onOpen(hit.canvas) })
                HorizontalDivider()
            }
        }
        if (results.canvasLoading) {
            item(key = "loading:" + results.canvasHits.size) {
                Row(Modifier.fillMaxWidth().padding(16.dp), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.width(8.dp))
                    Text(if (results.canvasHits.isEmpty()) stringResource(R.string.search_pane_searching) else stringResource(R.string.search_pane_loading_more), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        } else if (results.canvasFailed) {
            item(key = "retry") {
                Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) {
                    OutlinedButton(onClick = onRetry) { Text(stringResource(R.string.common_load_again)) }
                }
            }
        }
    }
}

/**
 * M122 (docs/WIKI.md §8.1): pages I can read whose title or body matches. A hit shows where it is in the tree, who changed
 * it last and when, its icon and title and the server's excerpt with the words marked; it opens the page (the results
 * stay behind it).
 */
@Composable
private fun PageResults(
    controller: AppController,
    version: Int,
    params: SearchParams,
    results: SearchResults,
    state: LazyListState,
    onLoadMore: () -> Unit,
    onRetry: () -> Unit,
    onOpen: (String) -> Unit,
) {
    LaunchedEffect(state, results) {
        snapshotFlow {
            val info = state.layoutInfo
            val count = results.pageHits.size
            val last = info.visibleItemsInfo.lastOrNull()?.index ?: -1
            results.pageHasMore && !results.pageLoading && count > 0 && info.totalItemsCount >= count && last >= count - 5
        }.distinctUntilChanged().collect { near -> if (near) onLoadMore() }
    }
    if (params.q.isBlank()) {
        Text(
            stringResource(R.string.docs_search_hint), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center, modifier = Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 48.dp),
        )
        return
    }
    val hub = controller.wiki
    val wikiVersion = hub?.version?.collectAsState()?.value ?: 0
    Text(
        if (results.pageLoaded) Search.totalLabel(results.pageTotal, results.pageCapped) else "",
        style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
    )
    LazyColumn(Modifier.fillMaxSize(), state = state) {
        when {
            results.pageLoaded && results.pageHits.isEmpty() -> item(key = "empty") {
                Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 48.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Icon(Icons.Default.SearchOff, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(40.dp))
                    Text(stringResource(R.string.docs_search_empty), style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 12.dp))
                    Text(
                        stringResource(R.string.docs_search_hint), style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 4.dp),
                    )
                }
            }
            else -> items(results.pageHits, key = { it.page.id }) { hit ->
                val path = remember(wikiVersion, hit.page.id) {
                    hub?.let { jp.chikuwachat.android.sync.WikiTree.ancestors(it.pages, hit.page.id).joinToString(" / ") { page -> DocsText.title(page) } }.orEmpty()
                }
                PageResultRow(controller, version, hit, results.pageKeywords, path, onOpen = { onOpen(hit.page.id) })
                HorizontalDivider()
            }
        }
        if (results.pageLoading) {
            item(key = "loading:" + results.pageHits.size) {
                Row(Modifier.fillMaxWidth().padding(16.dp), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                    Spacer(Modifier.width(8.dp))
                    Text(if (results.pageHits.isEmpty()) stringResource(R.string.search_pane_searching) else stringResource(R.string.search_pane_loading_more), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        } else if (results.pageFailed) {
            item(key = "retry") {
                Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) {
                    OutlinedButton(onClick = onRetry) { Text(stringResource(R.string.common_load_again)) }
                }
            }
        }
    }
}

@Composable
private fun PageResultRow(controller: AppController, version: Int, hit: jp.chikuwachat.android.api.PageSearchHit, keywords: List<String>, path: String, onOpen: () -> Unit) {
    val store = controller.store
    val page = hit.page
    val who = store.users[page.updatedBy]?.displayName ?: stringResource(R.string.common_member)
    val snippet = remember(hit.snippet, version) { CanvasText.readableSnippet(Mentions.toNames(hit.snippet, store.users, store.groups)) }
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Column(Modifier.fillMaxWidth().clickable(onClickLabel = stringResource(R.string.docs_open_page), onClick = onOpen).padding(horizontal = 16.dp, vertical = 10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                listOf(path.ifEmpty { stringResource(R.string.docs_title) }, who).joinToString(" · "),
                style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, color = muted,
                maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
            )
            Spacer(Modifier.width(8.dp))
            Text(YouSettings.lastUsedLabel(page.updatedAt), style = MaterialTheme.typography.labelSmall, color = muted, maxLines = 1)
        }
        Row(Modifier.padding(top = 6.dp), verticalAlignment = Alignment.Top) {
            Box(Modifier.size(36.dp).background(MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.5f), RoundedCornerShape(8.dp)), contentAlignment = Alignment.Center) {
                EmojiLineText(page.icon?.takeIf { it.isNotBlank() } ?: "📄", controller, version, MaterialTheme.typography.titleMedium, MaterialTheme.colorScheme.onSurface)
            }
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text(highlighted(page.title.ifBlank { stringResource(R.string.docs_untitled) }, keywords), style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (snippet.isNotBlank()) Text(highlighted(snippet, keywords), style = MaterialTheme.typography.bodyMedium, maxLines = 3, overflow = TextOverflow.Ellipsis)
            }
        }
    }
}

@Composable
private fun CanvasResultRow(controller: AppController, version: Int, hit: CanvasSearchHit, keywords: List<String>, onOpen: () -> Unit) {
    val store = controller.store
    val canvas = hit.canvas
    val channel = store.channel(canvas.channelId)
    val who = store.users[canvas.updatedBy]?.displayName ?: stringResource(R.string.common_member)
    val progress = CanvasText.taskProgress(canvas.taskTotal, canvas.taskDone)
    val snippet = remember(hit.snippet, version) { CanvasText.readableSnippet(Mentions.toNames(hit.snippet, store.users, store.groups)) }
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Column(Modifier.fillMaxWidth().clickable(onClickLabel = stringResource(R.string.common_open_canvas), onClick = onOpen).padding(horizontal = 16.dp, vertical = 10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                (channel?.let { channelTitle(it, store) } ?: stringResource(R.string.common_conversation)) + " · " + who,
                style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, color = muted,
                maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
            )
            Spacer(Modifier.width(8.dp))
            Text(YouSettings.lastUsedLabel(canvas.updatedAt), style = MaterialTheme.typography.labelSmall, color = muted, maxLines = 1)
        }
        Row(Modifier.padding(top = 6.dp)) {
            Box(Modifier.size(36.dp).background(MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.5f), RoundedCornerShape(8.dp)), contentAlignment = Alignment.Center) {
                Icon(Icons.Outlined.Description, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(20.dp))
            }
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(highlighted(canvas.title, keywords), style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                    if (progress != null) Text(progress, style = MaterialTheme.typography.labelSmall, color = muted, modifier = Modifier.padding(start = 8.dp))
                }
                if (snippet.isNotBlank()) Text(highlighted(snippet, keywords), style = MaterialTheme.typography.bodyMedium, maxLines = 3, overflow = TextOverflow.Ellipsis)
            }
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
    onOpenCited: (messageId: String, channelId: String, parentId: String?) -> Unit,
) {
    val words = params.q.isNotBlank()
    // M71: the 「AI に聞く」 history sheet (the answer sheet follows the controller's question).
    var askHistoryOpen by remember { mutableStateOf(false) }
    AskSheets(controller, version, askHistoryOpen, onCloseHistory = { askHistoryOpen = false }, onOpenSource = onOpenCited)
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
            Text(stringResource(R.string.search_pane_some_filters_matched_nothing) + results.unresolved.joinToString(" "), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onErrorContainer)
        }
    }
    LazyColumn(Modifier.fillMaxSize(), state = listState) {
        // M71 (docs/AI.md §13.6): always an item (empty while hidden), so its arrival never pushes the first hit's anchor.
        item(key = "ai-ask") { AskBar(controller, version, params, onHistory = { askHistoryOpen = true }) }
        when {
            results.loaded && results.hits.isEmpty() -> item(key = "empty") {
                EmptyResults(filtered = Search.hasFilters(params), onClear = { onChange(Search.cleared(params)) })
            }
            else -> items(results.hits, key = { it.message.id }) { hit ->
                ResultRow(controller, version, hit.message, results.keywords, results.channels[hit.message.channelId], onOpen = { onOpen(hit.message) })
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
                    Text(if (results.hits.isEmpty()) stringResource(R.string.search_pane_searching) else stringResource(R.string.search_pane_loading_more), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        } else if (results.failed) {
            item(key = "retry") {
                Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) {
                    OutlinedButton(onClick = onRetry) { Text(stringResource(R.string.common_load_again)) }
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
            Text(if (sort == Search.RELEVANCE) stringResource(R.string.search_pane_most_relevant) else stringResource(R.string.search_pane_newest))
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            listOf(Search.RELEVANCE to stringResource(R.string.search_pane_most_relevant), Search.NEWEST to stringResource(R.string.search_pane_newest)).forEach { (value, label) ->
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
        Text(stringResource(R.string.search_pane_nothing_found), style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 12.dp))
        Text(
            if (filtered) stringResource(R.string.search_pane_try_fewer_filters) else stringResource(R.string.search_pane_try_different_or_shorter_words),
            style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 4.dp),
        )
        if (filtered) Button(onClick = onClear, modifier = Modifier.padding(top = 16.dp)) { Text(stringResource(R.string.search_pane_clear_filters_and_search)) }
    }
}

/** Conversation, 「スレッドの返信」, sender, time, the body with the matched words marked, attached file names. */
@Composable
private fun ResultRow(
    controller: AppController, version: Int, message: MessageOut, keywords: List<String>,
    /** L8: the hit's channel from the answer when I am not a member (the store may not know it). */
    outside: jp.chikuwachat.android.api.ChannelOut? = null,
    onOpen: () -> Unit,
) {
    val store = controller.store
    val channel = store.channel(message.channelId) ?: outside?.let { ChannelState(it, isMember = false) }
    val sender = store.users[message.senderId]?.displayName ?: "?"
    // 仕上げ A (MOBILE_POLISH.md X1): the one-line excerpt every list uses (apps/shared/dm-preview.json's rule); the
    // attachments are listed below it by name, so no 「画像を送信しました」 stands in for an empty body.
    val text = remember(message.id, message.body, version) { messageLine(message.body, emptyList(), store.users, store.groups, maxLength = 400) }
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Column(Modifier.fillMaxWidth().clickable(onClickLabel = if (message.parentId != null) stringResource(R.string.common_view_in_thread) else stringResource(R.string.common_view_in_conversation), onClick = onOpen).padding(horizontal = 16.dp, vertical = 10.dp)) {
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
                        Text(stringResource(R.string.search_pane_thread_reply), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSecondaryContainer, maxLines = 1, modifier = Modifier.padding(horizontal = 6.dp, vertical = 1.dp))
                    }
                }
            }
            Spacer(Modifier.width(8.dp))
            Text(Timeline.stampLabel(message.createdAt), style = MaterialTheme.typography.labelSmall, color = muted, maxLines = 1)
        }
        Row(Modifier.padding(top = 6.dp)) {
            Avatar(message.senderId, sender, size = 36.dp)
            Spacer(Modifier.width(10.dp))
            Column(Modifier.weight(1f)) {
                Text(sender, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (text.isNotEmpty()) {
                    EmojiLineText(
                        text, store, { controller.loadEmojiImage(it) }, version, MaterialTheme.typography.bodyMedium, Color.Unspecified,
                        maxLines = 3, keywords = keywords,
                    )
                }
                message.attachments.take(3).forEach { attachment ->
                    Row(Modifier.padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Outlined.Description, contentDescription = null, tint = muted, modifier = Modifier.size(14.dp))
                        Spacer(Modifier.width(4.dp))
                        FileNameText(attachment.filename, text = highlighted(attachment.filename, keywords), style = MaterialTheme.typography.labelMedium, color = muted)
                    }
                }
                if (message.attachments.size > 3) Text(stringResource(R.string.search_pane_more_files, message.attachments.size - 3), style = MaterialTheme.typography.labelSmall, color = muted)
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
                    Text(stringResource(R.string.search_pane_no_files_found), style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(top = 12.dp))
                    Text(stringResource(R.string.search_pane_searches_file_names), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp))
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
private fun FilterRow(controller: AppController, version: Int, params: SearchParams, onChange: (SearchParams) -> Unit, tab: Int) {
    val store = controller.store
    var picker by remember { mutableStateOf<String?>(null) }
    val sender = params.fromUserId?.let { store.users[it] }
    val channel = params.channelId?.let { store.channel(it) }
    val filesOnly = tab == SEARCH_TAB_FILES
    // M58: a canvas's person is whoever made it or changed it last; its kinds and 「スレッド内」 do not apply.
    val canvases = tab == SEARCH_TAB_CANVASES
    val personLabel = if (canvases) stringResource(R.string.search_pane_created_or_updated_by) else stringResource(R.string.search_pane_from)
    // Per tab: the row keeps its place by the first chip's key, which would hide 送信者 after the files tab.
    key(tab) { LazyRow(
        Modifier.fillMaxWidth(),
        contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (!filesOnly) item(key = "from") {
            FilterPill(
                label = if (params.fromUserId != null) "$personLabel: " + (sender?.displayName ?: "?") else personLabel,
                icon = Icons.Default.Person,
                selected = params.fromUserId != null,
                onClick = { picker = "from" },
                onClear = { onChange(params.copy(fromUserId = null)) },
            )
        }
        item(key = "in") {
            FilterPill(
                label = if (params.channelId != null) channel?.let { channelTitle(it, store) } ?: "?" else stringResource(R.string.common_channels),
                icon = Icons.Default.Tag,
                selected = params.channelId != null,
                onClick = { picker = "in" },
                onClear = { onChange(params.copy(channelId = null)) },
            )
        }
        if (canvases) item(key = "date") { DateFilter(params, onChange) }
        if (!filesOnly && !canvases) {
            item(key = "date") { DateFilter(params, onChange) }
            item(key = "kind") { KindFilter(params, onChange) }
            item(key = "thread") {
                FilterChip(
                    selected = params.isThread,
                    onClick = { onChange(params.copy(isThread = !params.isThread)) },
                    label = { Text(stringResource(R.string.common_in_threads)) },
                    leadingIcon = { Icon(if (params.isThread) Icons.Default.Check else Icons.Default.Forum, contentDescription = null, modifier = Modifier.size(FilterChipDefaults.IconSize)) },
                )
            }
            // L8 (TIMES_FEED.md §6): the times only, those I have not joined included.
            item(key = "times") {
                FilterChip(
                    selected = params.isTimes,
                    onClick = { onChange(params.copy(isTimes = !params.isTimes)) },
                    label = { Text("Times") },
                    leadingIcon = { Icon(if (params.isTimes) Icons.Default.Check else Icons.Default.DynamicFeed, contentDescription = null, modifier = Modifier.size(FilterChipDefaults.IconSize)) },
                )
            }
        }
        val clearable = when {
            filesOnly -> params.channelId != null
            canvases -> params.channelId != null || params.fromUserId != null || params.date != null
            else -> Search.hasFilters(params)
        }
        if (clearable) item(key = "clear") {
            TextButton(onClick = { onChange(Search.cleared(params)) }) { Text(stringResource(R.string.search_pane_clear_filters)) }
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
                Icon(Icons.Default.Close, contentDescription = stringResource(R.string.search_pane_remove_this_filter), modifier = Modifier.size(FilterChipDefaults.IconSize).clickable(onClick = onClear))
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
        FilterPill(label = label ?: stringResource(R.string.search_pane_date), icon = Icons.Default.DateRange, selected = params.date != null, onClick = { menu = true }, onClear = { onChange(params.copy(date = null)) })
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
                text = { Text(stringResource(R.string.search_pane_pick_dates)) },
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
            ) { Text(stringResource(R.string.search_pane_apply_these_dates)) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.common_cancel)) } },
    ) {
        DateRangePicker(
            state = state,
            title = { Text(stringResource(R.string.search_pane_choose_dates), modifier = Modifier.padding(start = 24.dp, end = 12.dp, top = 16.dp)) },
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
            label = if (params.has.isEmpty()) stringResource(R.string.common_type) else params.has.joinToString(stringResource(R.string.common_list_separator_dot)) { Search.HAS_LABELS[it] ?: it },
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
        title = { Text(stringResource(R.string.search_pane_from)) },
        text = {
            Column {
                OutlinedTextField(query, { query = it }, placeholder = { Text(stringResource(R.string.common_filter_by_name)) }, singleLine = true, modifier = Modifier.fillMaxWidth())
                LazyColumn(Modifier.heightIn(max = 380.dp).padding(top = 8.dp)) {
                    items(people, key = { it.id }) { user ->
                        Row(Modifier.fillMaxWidth().clickable { onPick(user.id) }.padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                            Avatar(user.id, user.displayName, size = 28.dp)
                            Spacer(Modifier.width(10.dp))
                            Text(user.displayName, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                            Spacer(Modifier.width(6.dp))
                            Text("@" + user.username, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, modifier = Modifier.weight(1f))
                            if (user.id == selected) Icon(Icons.Default.Check, contentDescription = stringResource(R.string.search_pane_selected), tint = MaterialTheme.colorScheme.primary)
                        }
                    }
                    if (people.isEmpty()) item { Text(stringResource(R.string.common_nothing_found), color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 12.dp)) }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.common_close)) } },
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
        title = { Text(stringResource(R.string.common_channels)) },
        text = {
            Column {
                OutlinedTextField(query, { query = it }, placeholder = { Text(stringResource(R.string.search_pane_filter_by_conversation_name)) }, singleLine = true, modifier = Modifier.fillMaxWidth())
                LazyColumn(Modifier.heightIn(max = 380.dp).padding(top = 8.dp)) {
                    items(list, key = { it.id }) { channel ->
                        Row(Modifier.fillMaxWidth().clickable { onPick(channel.id) }.padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                            Icon(conversationIcon(channel), contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(18.dp))
                            Spacer(Modifier.width(10.dp))
                            Text(channelTitle(channel, store).removePrefix("#"), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                            if (channel.id == selected) Icon(Icons.Default.Check, contentDescription = stringResource(R.string.search_pane_selected), tint = MaterialTheme.colorScheme.primary)
                        }
                    }
                    if (list.isEmpty()) item { Text(stringResource(R.string.common_nothing_found), color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(vertical = 12.dp)) }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.common_close)) } },
    )
}

// --- keyword highlighting --------------------------------------------------------------------------------

/** Case-insensitive keyword highlighting done on the client (the server only returns the keywords). */
/** A keyword hit in a result (also EmojiLineText with keywords). */
val SEARCH_HIT = SpanStyle(fontWeight = FontWeight.Bold, background = Color(0x55FFD54F))

fun highlighted(text: String, keywords: List<String>) = buildAnnotatedString {
    val ranges = keywordRanges(text, keywords)
    var cursor = 0
    for ((start, end) in ranges) {
        if (start > cursor) append(text.substring(cursor, start))
        withStyle(SEARCH_HIT) { append(text.substring(start, end)) }
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
