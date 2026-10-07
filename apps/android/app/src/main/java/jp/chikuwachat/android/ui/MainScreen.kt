package jp.chikuwachat.android.ui

import android.Manifest
import android.os.Build
import androidx.activity.compose.BackHandler
import androidx.activity.compose.PredictiveBackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.DoneAll
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.NotificationsNone
import androidx.compose.material.icons.filled.NotificationsOff
import androidx.compose.material.icons.filled.PersonAdd
import androidx.compose.material.icons.filled.RssFeed
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.outlined.StarBorder
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.TextButton
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.VerticalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconToggleButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.key
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.MutableState
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlin.properties.ReadWriteProperty
import kotlin.reflect.KProperty
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.platform.NotificationPermission
import jp.chikuwachat.android.sync.ChannelState
import jp.chikuwachat.android.sync.EngineStatus
import jp.chikuwachat.android.sync.NotificationLevels
import jp.chikuwachat.android.sync.Store
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import jp.chikuwachat.android.R
import androidx.compose.ui.res.stringResource
import jp.chikuwachat.android.L10n

/** M34: the settings are the 自分 tab's page now, not a dialog. */
enum class MainDialog { NEW_DM, NEW_CHANNEL, ADD_MEMBER, BROWSE, DIRECTORY }

/** M33 / M34: `stack` in MainScreen, read and written as the selected tab's stack in [MainTabs]. */
private class SelectedStack(private val tabs: MutableState<TabStacks>) : ReadWriteProperty<Any?, List<Route>> {
    override fun getValue(thisRef: Any?, property: KProperty<*>): List<Route> = MainTabs.stack(tabs.value)

    override fun setValue(thisRef: Any?, property: KProperty<*>, value: List<Route>) {
        tabs.value = MainTabs.withStack(tabs.value, tabs.value.selected, value)
    }
}

/** Channel list first; a selected channel opens as its own page (compact-width layout, like the iOS app). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MainScreen(controller: AppController) {
    val store = controller.store
    val version by store.version.collectAsState()
    val status = controller.engineStatus
    // M33: the screen is a back stack of routes (MainNav): the channel list at the bottom, what shows on top. M34: each
    // bottom tab has its own (MainTabs); `stack` is the selected tab's. Saved as one string, so they survive a rotation,
    // and AppRoot keeps them per workspace (M16c).
    val tabsState = rememberSaveable(stateSaver = TabStacksSaver) { mutableStateOf(MainTabs.initial) }
    var tabs by tabsState
    val selectedStack = remember(tabsState) { SelectedStack(tabsState) }
    var stack by selectedStack
    val top = MainNav.top(stack)
    // M34: each tab root's scroll position stays while another tab or a pushed screen shows (and a re-tap scrolls it up).
    val homeListState = rememberLazyListState()
    val dmListState = rememberLazyListState()
    val mentionsListState = rememberLazyListState()
    val threadsListState = rememberLazyListState()
    val activityListState = rememberLazyListState()
    // L8: the Times feed keeps its place while a row's conversation is open over it.
    val timesFeedListState = rememberLazyListState()
    // M78 (CANVAS.md §21.2): the home's 「キャンバス」, kept (pages and place) while a row's canvas is open over it; a new
    // store (another workspace, signing in again) starts it over.
    val myCanvases = remember(store) {
        jp.chikuwachat.android.sync.MyCanvasList({ controller.myCanvasesApi }, cached = {
            kotlinx.coroutines.withContext(kotlinx.coroutines.Dispatchers.IO) { store.allCachedCanvases().map { it.canvas.meta } }
        })
    }
    val canvasesListState = rememberLazyListState()
    // M122: the tree's place, kept while a page is open over it.
    val docsListState = rememberLazyListState()
    var docsOpenRows by rememberSaveable { mutableStateOf("") }
    var docsQuery by rememberSaveable { mutableStateOf("") }
    var confirmReadTimes by remember { mutableStateOf(false) }
    val youScrollState = rememberScrollState()
    // M16b: the search screen (its route: the bar expanded = suggestions, the search on screen). The results stay while
    // a result's conversation is open, so going back shows them as they were.
    val searching = top is Route.Search
    val searchExpanded = (top as? Route.Search)?.expanded == true
    val searchParams = MainNav.search(stack)?.params
    var searchText by rememberSaveable { mutableStateOf("") }
    var searchTab by rememberSaveable { mutableIntStateOf(0) }
    /** The conversation on screen was opened from the results: back (and 「検索結果に戻る」) returns to them. */
    val backToSearch = MainNav.backToSearch(stack)
    val searchResults = remember { SearchResults() }
    val searchListState = rememberLazyListState()
    val searchFilesState = rememberLazyListState()
    val searchCanvasesState = rememberLazyListState()
    val searchDocsState = rememberLazyListState()
    val recentKey = controller.accountKey?.let { RecentSearches.key(it) }
    var recentSearches by remember(recentKey) { mutableStateOf(recentKey?.let { RecentSearches.read(controller.prefs, it) } ?: emptyList()) }
    // Saveable (M28c): an open dialog (and what was typed in it) survives a rotation.
    var dialog by rememberSaveable { mutableStateOf<MainDialog?>(null) }
    // M14f: the conversation whose long-press menu is open, and the section whose 「…」 is.
    var channelMenuFor by rememberSaveable { mutableStateOf<String?>(null) }
    var sectionMenuFor by remember { mutableStateOf<Pair<jp.chikuwachat.android.api.SidebarSectionOut, Int>?>(null) }
    // M26: making (no section) or editing one of my sections; the conversations a long-press 「新しいセクション…」 ticks.
    var sectionForm by remember { mutableStateOf<Pair<jp.chikuwachat.android.api.SidebarSectionOut?, List<String>>?>(null) }
    // DATA_MODEL.md 「並べ替え」: the 「手動」 section the home shows with ↑ / ↓ (「順番を編集」).
    var editingSection by remember { mutableStateOf<String?>(null) }
    // M26: the default sections folded on this device.
    var folded by remember { mutableStateOf(FoldedSections.read(controller.prefs)) }
    var bellOpen by remember { mutableStateOf(false) }
    // M117 (docs/CALLS.md §7): the 📞's question, for this conversation.
    var confirmCallIn by rememberSaveable { mutableStateOf<String?>(null) }
    // M37: 「未読をまとめる」 as it was left on this device (like the folded sections); it replaced M28c's 「未読のみ」.
    var groupUnread by remember { mutableStateOf(GroupUnread.read(controller.prefs)) }
    // M37: the home's ⋮ 「すべて既読にする」 asks first; ✏️ 新しいメッセージ's picker.
    var confirmReadAll by rememberSaveable { mutableStateOf(false) }
    // M40: 「ログアウト」 asks first (the 自分 list's red row and the ⋮ menus).
    var confirmLogout by rememberSaveable { mutableStateOf(false) }
    // M40: from this width the 自分 tab shows its list and the chosen screen side by side.
    val youTwoPane = with(LocalDensity.current) { YouSettings.twoPane(LocalWindowInfo.current.containerSize.width.toDp().value) }
    // T1 (MOBILE_UI.md §12): the phone's pages, or a tablet's panes; read again whenever the window changes size (a
    // rotation, a freeform window, a foldable), the stacks staying as they are.
    val layout = with(LocalDensity.current) {
        val size = LocalWindowInfo.current.containerSize
        AdaptiveLayout.of(size.width.toDp().value, size.height.toDp().value)
    }
    var composing by rememberSaveable { mutableStateOf(false) }
    // M37 (MOBILE_UI.md §6.2): the conversations last opened on this device, for the jump screen.
    val recentConversationsKey = controller.accountKey?.let { RecentConversations.key(it) }
    var recentConversations by remember(recentConversationsKey) {
        mutableStateOf(recentConversationsKey?.let { RecentConversations.read(controller.prefs, it) } ?: emptyList())
    }
    // Issue #1: the conversation each tab left last, for the left swipe on its root (SwipeNav.noteLeft).
    var lastConversations by rememberSaveable(stateSaver = LastConversationsSaver) { mutableStateOf(emptyMap<MainTab, String>()) }
    val previousTabs = remember { arrayOf(tabs) }
    LaunchedEffect(tabs) {
        lastConversations = SwipeNav.noteLeft(lastConversations, previousTabs[0], tabs)
        previousTabs[0] = tabs
    }
    val focusManager = LocalFocusManager.current
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    // M28c: the notification permission (Android 13+) is asked once, here after the first sign-in (it was asked at every
    // start of the activity, a rotation included); a refusal shows in the settings with the way to the system's page.
    val askNotifications = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {}
    LaunchedEffect(Unit) {
        if (Build.VERSION.SDK_INT >= 33 && NotificationPermission.shouldAsk(controller.prefs, Build.VERSION.SDK_INT, controller.notificationsPermitted)) {
            NotificationPermission.markAsked(controller.prefs)
            askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }
    /**
     * Opens a conversation (and optionally one of its threads) from anywhere: a notification, a profile's
     * 「メッセージを送る」, /dm, /join, the dialogs, a list row. Whatever belonged to the previous one closes,
     * or its open thread would take replies for the wrong conversation (MainNav.openConversation).
     */
    fun openConversation(channelId: String, parentId: String? = null) {
        stack = MainNav.openConversation(stack, channelId, parentId)
    }

    /**
     * M34 (7): a notification, a permalink, /dm, /join or a profile's 「メッセージを送る」: a DM lands on the DM tab, a
     * channel (and its thread) on the home tab, replacing that tab's stack and selecting it.
     */
    fun land(channelId: String, parentId: String? = null) {
        focusManager.clearFocus()
        tabs = MainTabs.land(tabs, MainTabs.landingTab(store.channel(channelId)), channelId, parentId)
    }

    /**
     * M37: a conversation picked on the jump screen or ✏️'s picker: the jump screen closes and the conversation lands
     * as a notification's does (a DM on the DM tab, a channel on home). `focusComposer`: its input takes the cursor.
     */
    fun openPicked(channelId: String, focusComposer: Boolean = false) {
        focusManager.clearFocus()
        controller.messageFocus = null
        controller.composerFocus = if (focusComposer) channelId else null
        tabs = MainTabs.landFromHome(tabs, MainTabs.landingTab(store.channel(channelId)), channelId)
    }

    /**
     * A tap on the bottom bar (MOBILE_UI.md §5): another tab comes back as it was left; the selected one pops to its
     * root, or at its root scrolls its list to the top.
     */
    fun selectMainTab(tab: MainTab) {
        val tap = MainTabs.tap(tabs, tab)
        if (tap.scrollToTop) {
            scope.launch {
                when (tab) {
                    MainTab.HOME -> homeListState.animateScrollToItem(0)
                    MainTab.DM -> dmListState.animateScrollToItem(0)
                    MainTab.ACTIVITY -> when {
                        store.activity != null -> activityListState
                        (top as? Route.Activity)?.segment == ActivitySegment.THREADS -> threadsListState
                        else -> mentionsListState
                    }.animateScrollToItem(0)
                    MainTab.YOU -> youScrollState.animateScrollTo(0)
                }
            }
            return
        }
        focusManager.clearFocus()
        // A focused message belongs to the conversation it was revealed in, not to one on another tab.
        if (tap.state.selected != tabs.selected) controller.messageFocus = null
        tabs = tap.state
        searchText = MainNav.search(stack)?.params?.q ?: ""
    }

    // Errors from actions on this screen (edit, upload, settings…) surface as a snackbar.
    LaunchedEffect(controller.error) {
        val message = controller.error ?: return@LaunchedEffect
        snackbar.showSnackbar(message)
        if (controller.error == message) controller.error = null
    }
    LaunchedEffect(controller.notice) {
        val message = controller.notice ?: return@LaunchedEffect
        snackbar.showSnackbar(message, duration = SnackbarDuration.Short)
        if (controller.notice == message) controller.notice = null
    }
    // A tapped notification (or /dm, /join, a profile's DM button) opens its channel once the store knows it. M28c: a
    // reply's notification opens its thread at the reply, as a permalink does (the reveal fetches its context first).
    LaunchedEffect(controller.pendingChannelId, version) {
        val id = controller.pendingChannelId ?: return@LaunchedEffect
        if (store.channel(id) != null) {
            controller.pendingChannelId = null
            val reply = controller.pendingReply
            controller.pendingReply = null
            // M39: a reaction's notification: the message reacted to (the permalink path lands it, in its thread for a reply).
            val revealId = controller.pendingRevealId
            controller.pendingRevealId = null
            controller.messageFocus = null
            when {
                reply != null -> scope.launch { if (controller.revealMessage(reply.first, id, reply.second)) land(id, reply.second) else land(id) }
                revealId != null -> scope.launch { if (!controller.openPermalink(revealId)) land(id) }
                else -> land(id)
            }
        }
    }
    // M34 (8), MOBILE_UI.md §10 1.: the engine's open conversation is the selected tab's; one left on another tab is not.
    val conversation = MainTabs.openConversation(tabs)
    val selection = conversation?.id
    LaunchedEffect(selection) {
        // M37: a conversation opened on any tab is the jump screen's most recent one; a composer waiting for the focus
        // (✏️) gives it up when another conversation opens first.
        if (selection != null) recentConversationsKey?.let { recentConversations = RecentConversations.push(controller.prefs, it, selection) }
        if (controller.composerFocus != selection) controller.composerFocus = null
        selection?.let { controller.openChannel(it) } ?: controller.closeChannel()
    }
    // A channel we were removed from (or that vanished) closes, with its thread, on whichever tab it is.
    MainTabs.conversations(tabs).filter { store.channel(it) == null }.fold(tabs, MainTabs::channelGone).let { if (it != tabs) tabs = it }

    val selectedChannel = selection?.let { store.channel(it) }
    val threadId = if (selectedChannel != null) MainNav.thread(stack)?.parentId else null
    // The tabs and the details belong to a joined conversation (closed, left, or removed from it: they go too).
    MainTabs.conversations(tabs).filter { store.channel(it)?.isMember == false }.fold(tabs, MainTabs::notMember).let { if (it != tabs) tabs = it }
    val conversationTab = if (selectedChannel != null) conversation.tab else ConversationTab.MESSAGES
    val detailsOpen = selectedChannel != null && conversation.detailsOpen
    /** The list replacing the channel list, when it is the page on screen. */
    val pane = top as? Route.Pane

    // --- search (M16b) ---
    fun openSearch() {
        stack = MainNav.openSearch(stack)
        searchText = ""
    }
    /** M37: the home's 「移動・検索」. */
    fun openJump() {
        stack = MainNav.openJump(stack)
        searchText = ""
    }
    val jumping = (top as? Route.Search)?.jump == true
    /** Back from the suggestions: to the results on screen, or out of search when there are none. */
    fun collapseSearch() {
        val params = searchParams
        stack = MainNav.collapseSearch(stack)
        searchText = params?.q ?: ""
    }
    /** Filters, sort and chips change the search on screen (only searches run from the bar are remembered). */
    fun changeSearch(params: SearchParams) {
        stack = MainNav.changeSearch(stack, params)
        searchListState.requestScrollToItem(0)
        searchFilesState.requestScrollToItem(0)
        searchCanvasesState.requestScrollToItem(0)
    }
    fun runSearch(params: SearchParams) {
        recentKey?.let { recentSearches = RecentSearches.push(controller.prefs, it, params) }
        // The files tab reads only the words and the channel: a search by sender, date, kind or thread shows messages.
        // M58: the canvases tab also reads the person and the dates, not kinds nor 「スレッド内」.
        val kinds = params.has.isNotEmpty() || params.isThread
        if (kinds || (searchTab == SEARCH_TAB_FILES && (params.fromUserId != null || params.date != null))) searchTab = 0
        changeSearch(params)
        searchText = params.q
        stack = MainNav.runSearch(stack, params)
    }
    fun returnToSearch() { stack = MainNav.returnToSearch(stack) }
    /** A result: its conversation (or thread) around the message, with the way back to the results. */
    fun openFromSearch(messageId: String, channelId: String, parentId: String?, message: jp.chikuwachat.android.api.MessageOut? = null) {
        // L8: a times I have not joined (an archived one too) is known from the answer; it opens as a preview (M27).
        searchResults.channels[channelId]?.let { if (store.channel(channelId) == null) store.upsertChannel(it, isMember = false) }
        scope.launch {
            val shown = if (message != null) controller.revealMessage(message) else controller.revealMessage(messageId, channelId, parentId)
            if (!shown) return@launch
            // M34 (7): on its tab (a DM on the DM tab, a channel on home); on the search's own tab the results stay behind it.
            tabs = MainTabs.landFromSearch(tabs, MainTabs.landingTab(store.channel(channelId)), channelId, parentId)
        }
    }
    LaunchedEffect(searchParams) { searchParams?.let { searchResults.show(controller, it) } }
    LaunchedEffect(searching, searchTab, searchParams?.q, searchParams?.channelId) {
        val params = searchParams
        if (searching && searchTab == SEARCH_TAB_FILES && params != null) searchResults.showFiles(controller, params.q.trim().ifEmpty { null }, params.channelId)
    }
    // M58: the 「キャンバス」 tab asks when it shows (and again for a different search).
    LaunchedEffect(searching, searchTab, searchParams) {
        val params = searchParams
        if (searching && searchTab == SEARCH_TAB_CANVASES && params != null) searchResults.showCanvases(controller, params)
    }
    // M122: the 「ドキュメント」 tab asks when it shows (and again for other words).
    LaunchedEffect(searching, searchTab, searchParams?.q) {
        val params = searchParams
        if (searching && searchTab == SEARCH_TAB_DOCS && params != null) searchResults.showPages(controller, params.q)
    }
    /** M58: a canvas found by the search, in its conversation's 「キャンバス」 tab with the results kept behind it. */
    fun openCanvasFromSearch(canvas: jp.chikuwachat.android.api.CanvasMeta) {
        val channel = store.channel(canvas.channelId)
        if (channel?.isMember != true) {
            scope.launch { controller.openCanvasLink(canvas.id) } // says why it cannot open
            return
        }
        focusManager.clearFocus()
        controller.messageFocus = null
        tabs = MainTabs.landCanvasFromSearch(tabs, MainTabs.landingTab(channel), canvas.channelId, canvas.id)
    }

    // M29 / M33: back (the system's, the app bar's ← and the search bar's) closes the details page, then a pins / files
    // tab (to 「メッセージ」), then the thread, then the conversation, then the list; on the search, the suggestions over
    // results then the search itself (MainNav.back).
    // M34: at a tab's root, back goes to the home tab (MainTabs.back); at the home tab's root the app closes as before.
    fun goBack() {
        val fromSearch = top is Route.Search
        tabs = MainTabs.back(tabs)
        if (fromSearch) searchText = (MainNav.top(stack) as? Route.Search)?.params?.q ?: ""
    }
    /** T1: the main pane's ← (wide): back from the page it shows, a thread in the pane beside it closing too. */
    fun goBackIn(view: List<Route>) {
        val fromSearch = MainNav.top(view) is Route.Search
        stack = MainNav.back(view)
        if (fromSearch) searchText = (MainNav.top(stack) as? Route.Search)?.params?.q ?: ""
    }
    /** A change of the conversation's own state; wide, a thread beside it closes first (AdaptiveLayout.surfaceConversation). */
    fun changeConversation(change: (List<Route>) -> List<Route>) {
        stack = change(if (layout == PaneLayout.PHONE) stack else AdaptiveLayout.surfaceConversation(stack))
    }
    /** The keyboard goes with the composer when a page or tab covers the timeline. */
    fun openDetails() { focusManager.clearFocus(); changeConversation(MainNav::openDetails) }
    fun selectTab(tab: ConversationTab) { focusManager.clearFocus(); changeConversation { MainNav.selectTab(it, tab) } }
    // T1: wide, the timeline stays usable beside an open thread: another thread replaces it.
    fun openThread(parentId: String) {
        stack = if (layout == PaneLayout.PHONE) MainNav.openThread(stack, parentId) else AdaptiveLayout.openThread(stack, parentId)
    }
    // Issue #1 (MOBILE_UI.md §5.1): on the phone, a conversation's back plays the swipe's slide — the system's back
    // gesture follows the finger (predictive back), the button slides it at once. What it goes to: SwipeNav.backTarget.
    val swipe = remember { SwipeNavState(scope) }
    val slideBack = if (layout == PaneLayout.PHONE) SwipeNav.backTarget(tabs) else null
    val swipeOn = layout == PaneLayout.PHONE && controller.swipeNavigation
    val swipeBack = slideBack.takeIf { swipeOn }
    // A left swipe on a tab's root brings back its last conversation, but not while a dialog or a sheet is open.
    val sheetOpen = dialog != null || composing || channelMenuFor != null || sectionMenuFor != null || sectionForm != null ||
        bellOpen || confirmReadAll || confirmReadTimes || confirmLogout
    val swipeForward = if (swipeOn && !sheetOpen) SwipeNav.forwardTarget(tabs, lastConversations) { store.channel(it) != null } else null
    fun commitSwipe(target: TabStacks) {
        focusManager.clearFocus()
        // A focused message belongs to the conversation it was revealed in.
        controller.messageFocus = null
        tabs = target
    }
    PredictiveBackHandler(enabled = slideBack != null) { events ->
        val target = SwipeNav.backTarget(tabs)
        if (target == null || swipe.active) {
            events.collect {}
            return@PredictiveBackHandler
        }
        swipe.begin(target, forward = false)
        try {
            events.collect { swipe.shift = it.progress }
            swipe.settle(complete = true, velocity = 0f, onCommit = ::commitSwipe)
        } catch (e: kotlin.coroutines.cancellation.CancellationException) {
            swipe.settle(complete = false, velocity = 0f, onCommit = ::commitSwipe)
            throw e
        }
    }
    // The suggestions fold through the search bar's own back handling (SearchBar → collapseSearch).
    BackHandler(enabled = MainTabs.canGoBack(tabs) && !searchExpanded && slideBack == null) { goBack() }
    /** A card in the pins pane / saved list: show the message in its conversation. */
    fun reveal(message: jp.chikuwachat.android.api.MessageOut) {
        scope.launch {
            if (controller.revealMessage(message)) openConversation(message.channelId, message.parentId)
        }
    }

    /**
     * A 「スレッド」 card's conversation header / 「チャンネルを開く」: the conversation itself, its timeline around the
     * thread's parent (as a search result lands); back returns to the list. Without the parent's context (offline) the
     * conversation still opens, at its usual position.
     */
    /**
     * A threads-list card (THREADS.md §5) opens its thread on this tab's stack; a reply under the card lands on that reply:
     * the focus is set first (the thread places itself once, on the focus), as an activity reply's. Without it (offline)
     * the thread still opens, at its usual position.
     */
    fun openThreadFromList(entry: jp.chikuwachat.android.sync.ThreadEntry, reply: jp.chikuwachat.android.sync.MessageState?) {
        val channelId = entry.state.channelId
        controller.messageFocus = null
        if (reply == null) {
            stack = MainNav.openFromThreadList(stack, channelId, entry.parent.id)
            return
        }
        scope.launch {
            controller.revealMessage(reply.id, channelId, entry.parent.id)
            stack = MainNav.openFromThreadList(stack, channelId, entry.parent.id)
        }
    }

    fun openThreadConversation(entry: jp.chikuwachat.android.sync.ThreadEntry) {
        val channelId = entry.state.channelId
        controller.messageFocus = null
        scope.launch {
            controller.revealMessage(entry.parent.id, channelId, null)
            stack = MainNav.openConversationFromThreadList(stack, channelId)
        }
    }

    val me = store.me
    val isChannel = selectedChannel != null && !selectedChannel.channel.isDm
    // M27 (SYNC_PROTOCOL.md §7.6.1): a public channel I have not joined opens read-only, until 「参加する」.
    val previewing = selectedChannel?.isMember == false

    // A permalink tapped in a body (M12b): the controller fetched the message; show it in its conversation.
    // M40: my profile card's 「ステータスを設定」 opens the 自分 tab's status screen.
    LaunchedEffect(controller.pendingSettings) {
        val page = controller.pendingSettings ?: return@LaunchedEffect
        controller.pendingSettings = null
        focusManager.clearFocus()
        tabs = MainTabs.openSettings(tabs, page)
    }
    // T1: Ctrl+K (MainActivity): 「移動・検索」 over the home tab (a pick lands like the home's, MainTabs.landFromHome).
    LaunchedEffect(controller.pendingJump) {
        if (!controller.pendingJump) return@LaunchedEffect
        controller.pendingJump = false
        focusManager.clearFocus()
        if (!(tabs.selected == MainTab.HOME && jumping)) {
            tabs = MainTabs.update(tabs.copy(selected = MainTab.HOME), MainNav::openJump)
            searchText = ""
        }
    }
    LaunchedEffect(controller.pendingReveal) {
        val message = controller.pendingReveal ?: return@LaunchedEffect
        controller.pendingReveal = null
        land(message.channelId, message.parentId)
    }
    // M46: a `/c/<id>` link tapped in a body: the canvas opens in its conversation's 「キャンバス」 tab, landing like a permalink.
    LaunchedEffect(controller.pendingCanvas, version) {
        val (channelId, canvasId) = controller.pendingCanvas ?: return@LaunchedEffect
        val channel = store.channel(channelId) ?: return@LaunchedEffect
        controller.pendingCanvas = null
        controller.messageFocus = null
        focusManager.clearFocus()
        tabs = MainTabs.landCanvas(tabs, MainTabs.landingTab(channel), channelId, canvasId)
    }
    // M122 (docs/WIKI.md §9.3): a tapped page notification: the page over 「ドキュメント」 on the home tab.
    LaunchedEffect(controller.pendingPage) {
        val pageId = controller.pendingPage ?: return@LaunchedEffect
        controller.pendingPage = null
        controller.messageFocus = null
        focusManager.clearFocus()
        tabs = MainTabs.landPage(tabs, pageId)
    }
    // M122: links to pages (`page:` and `/p/`) and files in every body on this screen (DocLinks.kt).
    val wikiHub = controller.wiki
    val wikiVersion = wikiHub?.version?.collectAsState()?.value ?: 0
    val pageLinks = remember(wikiHub, wikiVersion) {
        wikiHub?.let { hub ->
            PageLinks(
                open = { id ->
                    focusManager.clearFocus()
                    tabs = MainTabs.update(tabs) { MainNav.openPage(it, id) }
                },
                label = { id -> hub.label(id) },
                openFile = { id -> controller.openAttachmentById(id) },
                version = wikiVersion,
            )
        }
    }
    // M112: a tapped reservation notice (or an activity row): 「予約」 on the home tab.
    LaunchedEffect(controller.pendingReservations) {
        if (!controller.pendingReservations) return@LaunchedEffect
        controller.pendingReservations = false
        controller.messageFocus = null
        focusManager.clearFocus()
        tabs = MainTabs.landReservations(tabs)
    }
    // M52: a tapped calendar alarm: its channel's 「予定」 tab (once the store knows the channel), or the calendar for my own
    // calendar's event, then the event's form over it (read from the server: it may be outside every range on screen).
    LaunchedEffect(controller.pendingEvent, version) {
        val target = controller.pendingEvent ?: return@LaunchedEffect
        val channelId = target.channelId
        if (channelId != null && store.channel(channelId)?.isMember != true) return@LaunchedEffect
        controller.pendingEvent = null
        controller.messageFocus = null
        focusManager.clearFocus()
        tabs = if (channelId != null) MainTabs.landEvents(tabs, channelId) else MainTabs.landCalendar(tabs)
        val hub = controller.calendar ?: return@LaunchedEffect
        scope.launch {
            runCatching { hub.get(target.eventId) }
                .onSuccess { controller.calendarForm = CalendarForm(it, null) }
                .onFailure { controller.report(it) }
        }
    }
    // M52: 「予定 N」 on the open channel's tab (today and tomorrow, CALENDAR.md §7); read when it opens and when the
    // connection comes back (the hub reads the counts it holds again after reconnecting, and when one of its events changes).
    val calendarHub = controller.calendar
    val calendarChanges = calendarVersion(calendarHub)
    val upcomingChannel = selection?.takeIf { id -> store.channel(id)?.let { it.isMember && CalendarChannels.hasCalendar(it.channel) } == true }
    LaunchedEffect(calendarHub, upcomingChannel, status == EngineStatus.ONLINE) {
        if (calendarHub != null && upcomingChannel != null && status == EngineStatus.ONLINE) calendarHub.loadUpcoming(upcomingChannel)
    }
    val upcomingEvents = remember(calendarChanges, upcomingChannel) { upcomingChannel?.let { calendarHub?.upcomingOf(it)?.size } ?: 0 }
    controller.calendarForm?.let { form -> CalendarEventForm(controller, form, onDismiss = { controller.calendarForm = null }) }
    controller.calendarFeeds?.let { feeds -> CalendarFeedsScreen(controller, feeds, onDismiss = { controller.calendarFeeds = null }) }
    // M56: a tapped task notification: its channel's 「タスク」 tab (once the store knows the channel), or 「タスク」 for a
    // personal one, then the task's form over it (read from the server when no window on screen holds it).
    LaunchedEffect(controller.pendingTask, version) {
        val target = controller.pendingTask ?: return@LaunchedEffect
        val channelId = target.channelId
        if (channelId != null && store.channel(channelId)?.isMember != true) return@LaunchedEffect
        controller.pendingTask = null
        controller.messageFocus = null
        focusManager.clearFocus()
        // A DM has no board (L9): its shared tasks show in 「タスク」 (自分の担当 / 自分が依頼した).
        val board = channelId?.takeIf { store.channel(it)?.channel?.isDm != true }
        tabs = if (board != null) MainTabs.landTasks(tabs, board) else MainTabs.landMyTasks(tabs)
        val hub = controller.tasks ?: return@LaunchedEffect
        scope.launch {
            runCatching { hub.load(target.taskId) }
                .onSuccess { controller.taskForm = TaskForm(it, null) }
                .onFailure { controller.report(it) }
        }
    }
    controller.taskForm?.let { form -> TaskFormScreen(controller, form, version, onDismiss = { controller.taskForm = null }) }
    // M95 (WORKFLOWS.md §8 4.): a workflow's form, from the ＋ menu, channel details, `/name` or a 「⚡ name」 label.
    controller.workflowForm?.let { session -> WorkflowFormScreen(controller, session, version, onDismiss = { controller.workflowForm = null }) }
    AiSheets(controller) // M66: the 「要約」 choices and the summary sheet (docs/AI.md §6)
    val openChannel = selectedChannel

    /**
     * The app bar of the page `view` is the top of (T1: one per pane when wide, [pageView]). `back`: the ← (or, with
     * `closes`, the ✕ of the thread's pane); `barWidth`: the bar's width in dp (whether the follow chip keeps its label).
     */
    @Composable
    fun Bar(view: List<Route>, back: (() -> Unit)?, barWidth: Float, closes: Boolean = false, open: ChannelState? = openChannel) {
        val (top, searching, searchExpanded, jumping, pane, selectedChannel, threadId, detailsOpen, isChannel, previewing) = pageView(view, open)
        var menuOpen by remember { mutableStateOf(false) }
        if (searching) {
            SearchTopBar(
                controller, version,
                text = searchText,
                onTextChange = { searchText = it },
                expanded = searchExpanded,
                onExpandedChange = { open -> if (open) stack = MainNav.expandSearch(stack) else collapseSearch() },
                recent = recentSearches,
                onRemoveRecent = { params -> recentKey?.let { recentSearches = RecentSearches.remove(controller.prefs, it, params) } },
                onClearRecent = {
                    recentKey?.let { RecentSearches.clear(controller.prefs, it) }
                    recentSearches = emptyList()
                },
                onSearch = ::runSearch,
                onBack = ::goBack,
                placeholder = if (jumping) stringResource(R.string.common_jump_or_search) else stringResource(R.string.main_screen_search, controller.workspaceName),
                jump = if (!jumping) null else JumpTargets(
                    recent = RecentConversations.shown(recentConversations) { store.channel(it) },
                    onOpenConversation = { openPicked(it) },
                    // Made when there is none; a failure is the app's error (openDmWith sets it).
                    onOpenPerson = { userId -> scope.launch { controller.openDmWith(userId)?.let { openPicked(it) } } },
                    aiBotIds = controller.aiBotIds,
                ),
            )
        } else if (top == Route.ChannelList) {
            // M37 (MOBILE_UI.md §6.1): the home's own bar: the workspace (a switcher with two or more) and ⋮.
            TopAppBar(
                title = { WorkspaceTitle(controller, switchable = controller.workspaces.size >= 2) },
                actions = {
                    IconButton(onClick = { menuOpen = true }) { Icon(Icons.Default.MoreVert, contentDescription = stringResource(R.string.common_menu)) }
                    DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                        DropdownMenuItem(text = { Text(stringResource(R.string.main_screen_mark_all_as_read)) }, onClick = { menuOpen = false; confirmReadAll = true })
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.main_screen_group_unread)) },
                            trailingIcon = { Checkbox(checked = groupUnread, onCheckedChange = null) },
                            onClick = {
                                menuOpen = false
                                groupUnread = !groupUnread
                                GroupUnread.write(controller.prefs, groupUnread)
                            },
                            modifier = Modifier.semantics { stateDescription = if (groupUnread) L10n.str(R.string.main_screen_on) else L10n.str(R.string.common_off) },
                        )
                        if (!controller.isGuest) {
                            DropdownMenuItem(text = { Text(stringResource(R.string.common_browse_channels)) }, onClick = { menuOpen = false; dialog = MainDialog.BROWSE })
                            DropdownMenuItem(text = { Text(stringResource(R.string.common_create_channel)) }, onClick = { menuOpen = false; dialog = MainDialog.NEW_CHANNEL })
                        }
                        DropdownMenuItem(text = { Text(stringResource(R.string.main_screen_member_directory)) }, onClick = { menuOpen = false; dialog = MainDialog.DIRECTORY })
                        HorizontalDivider()
                        DropdownMenuItem(text = { Text(stringResource(R.string.common_direct_message)) }, onClick = { menuOpen = false; dialog = MainDialog.NEW_DM })
                        DropdownMenuItem(text = { Text(stringResource(R.string.common_new_section)) }, onClick = { menuOpen = false; sectionForm = null to emptyList() })
                        // With one workspace the title does not open the switcher, which is where another is added.
                        if (controller.workspaces.size < 2) {
                            DropdownMenuItem(text = { Text(stringResource(R.string.common_add_workspace)) }, onClick = { menuOpen = false; controller.beginAddWorkspace() })
                        }
                        HorizontalDivider()
                        DropdownMenuItem(text = { Text(stringResource(R.string.common_settings)) }, onClick = { menuOpen = false; selectMainTab(MainTab.YOU) })
                        val logoutLabel = if (controller.workspaces.size > 1) stringResource(R.string.common_sign_out_of, controller.workspaceName) else stringResource(R.string.common_sign_out)
                        DropdownMenuItem(text = { Text(logoutLabel) }, onClick = { menuOpen = false; confirmLogout = true })
                    }
                },
            )
        } else {
            TopAppBar(
                title = {
                    when {
                        // D1: the page's own header shows the name large.
                        detailsOpen -> Text(if (isChannel) stringResource(R.string.main_screen_channel_details) else stringResource(R.string.main_screen_details), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        threadId != null -> TwoLineTitle(stringResource(R.string.common_thread), selectedChannel?.let { channelTitle(it, store) })
                        selectedChannel != null && previewing -> TwoLineTitle(channelTitle(selectedChannel, store), stringResource(R.string.main_screen_preview_not_joined))
                        // M29: the title opens the details page.
                        selectedChannel != null -> Column(Modifier.clickable(onClickLabel = stringResource(R.string.main_screen_channel_details)) { openDetails() }) {
                            TwoLineTitle(
                                channelTitle(selectedChannel, store),
                                selectedChannel.channel.topic?.takeIf { it.isNotBlank() } ?: if (isChannel) stringResource(R.string.main_screen_set_a_topic) else dmPresenceSubtitle(selectedChannel, store),
                                emoji = controller to version, // a custom status emoji in a DM's subtitle as its image
                            )
                        }
                        pane == Route.Threads -> Text(stringResource(R.string.common_thread))
                        pane == Route.TimesFeed -> Text(stringResource(R.string.main_screen_times_feed))
                        pane == Route.Saved -> Text(stringResource(R.string.common_saved))
                        pane == Route.Mentions -> Text(stringResource(R.string.common_mention))
                        pane == Route.Drafts -> Text(stringResource(R.string.common_drafts))
                        pane is Route.Files -> Text(stringResource(R.string.common_files))
                        pane == Route.Canvases -> Text(stringResource(R.string.common_canvas))
                        pane == Route.Docs -> Text(stringResource(R.string.docs_title))
                        pane is Route.DocPage -> DocPageBarTitle(controller, pane.id)
                        pane == Route.Reminders -> Text(stringResource(R.string.common_reminders))
                        pane == Route.Calendar -> Text(stringResource(R.string.common_calendar))
                        pane == Route.Tasks -> Text(stringResource(R.string.common_tasks))
                        pane == Route.Deadlines -> Text(stringResource(R.string.common_deadlines))
                        pane == Route.Reservations -> Text(stringResource(R.string.common_reservations))
                        pane == Route.Attendance -> Text(stringResource(R.string.common_attendance))
                        // 仕上げ A (MOBILE_POLISH.md C5): 「DM」 as on iOS and on the tab (「ダイレクトメッセ…」 was cut).
                        top == Route.DmList -> Text("DM", maxLines = 1, overflow = TextOverflow.Ellipsis)
                        top is Route.Activity -> Text(stringResource(R.string.common_activity), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        top == Route.You -> Text(stringResource(R.string.common_you), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        top is Route.Settings -> Text(top.page.title, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        else -> WorkspaceTitle(controller) // M16c: tap to switch workspaces
                    }
                },
                navigationIcon = {
                    when {
                        back != null && closes -> IconButton(onClick = back) {
                            Icon(Icons.Default.Close, contentDescription = stringResource(R.string.main_screen_close_thread))
                        }
                        back != null -> IconButton(onClick = back) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.common_back))
                        }
                        // M34: my avatar opens the 自分 tab (the settings were a dialog). T1: wide, the rail has it.
                        me != null && top != Route.You && layout == PaneLayout.PHONE -> IconButton(onClick = { selectMainTab(MainTab.YOU) }, modifier = Modifier.semantics { contentDescription = L10n.str(R.string.common_you) }) {
                            Avatar(me.id, me.displayName, size = 32.dp)
                        }
                    }
                },
                actions = {
                    // 仕上げ A (MOBILE_POLISH.md C5): no connection dot here; ConnectionBanner says when the socket is down.
                    // C6: the ⋮ holds this screen's own actions only (BarMenu), and is not shown without any.
                    val conversationPage = selectedChannel != null && selectedChannel.isMember && threadId == null && !detailsOpen
                    val menuItems = BarMenu.items(
                        conversation = conversationPage,
                        channel = isChannel,
                        archived = selectedChannel?.channel?.archived == true,
                        activityFeed = top is Route.Activity && store.activity != null,
                        timesFeed = top == Route.TimesFeed,
                        myTimes = TimesFeed.myTimes(store.channels.values, me?.id) != null || !controller.isGuest,
                        // M66: a joined conversation's thread; summaries while the server takes them (GET /ai/status).
                        thread = selectedChannel != null && selectedChannel.isMember && threadId != null && !detailsOpen,
                        summaries = controller.aiSummaryAvailable,
                        // M69: 「カレンダーを購読 (iCal)」 on the calendar's own page.
                        calendar = pane == Route.Calendar && !searching && controller.calendar?.available == true,
                    )
                    val barButtons = top != Route.You && top !is Route.Settings
                    // THREADS.md §5: follow / unfollow the open thread.
                    val openId = threadId
                    val threadState = openId?.let { store.threads[it]?.state }
                    if (openId != null && threadState != null && selectedChannel?.isMember == true) {
                        // M25: the labelled chip only where 「スレッド」 still fits beside it (ConversationBar), else the bell alone.
                        val measurer = rememberTextMeasurer()
                        val density = LocalDensity.current
                        val labelled = with(density) {
                            ConversationBar.followLabelFits(
                                barWidth = barWidth,
                                title = measurer.measure(stringResource(R.string.common_thread), MaterialTheme.typography.titleMedium).size.width.toDp().value,
                                label = measurer.measure(stringResource(R.string.main_screen_following), MaterialTheme.typography.labelLarge).size.width.toDp().value,
                                menu = barButtons && menuItems.isNotEmpty(),
                            )
                        }
                        val bell = if (threadState.following) Icons.Default.Notifications else Icons.Default.NotificationsNone
                        // Through the controller (M28c): offline it says so instead of silently doing nothing.
                        val toggle = { scope.launch { controller.setThreadFollow(openId, !threadState.following) } }
                        if (labelled) {
                            FilterChip(
                                selected = threadState.following,
                                onClick = { toggle() },
                                label = { Text(if (threadState.following) stringResource(R.string.main_screen_following) else stringResource(R.string.main_screen_follow)) },
                                leadingIcon = { Icon(bell, contentDescription = null, modifier = Modifier.size(16.dp)) },
                                modifier = Modifier.padding(end = 4.dp),
                            )
                        } else {
                            // A toggle: TalkBack says 「スレッドをフォロー」 with on / off.
                            IconToggleButton(checked = threadState.following, onCheckedChange = { toggle() }) {
                                Icon(bell, contentDescription = stringResource(R.string.main_screen_follow_thread))
                            }
                        }
                    }
                    // In a channel the icons were star, pin, files, bell and info: they left the channel's name no room (testers,
                    // 2026-09-28), so they are at the top of ⋮; the notification level still opens its own menu from there.
                    if (conversationPage && selectedChannel != null) {
                        // M35 (D1: the same menu as the details page's 「通知」).
                        ChannelNotificationMenu(controller, selectedChannel, bellOpen, onDismiss = { bellOpen = false })
                    }
                    // M117 (docs/CALLS.md §7): 📞 on a conversation's own page while I may start one there.
                    if (barButtons && conversationPage && Calls.canStart(store.workspaceSettings, selectedChannel, controller.isAdmin)) {
                        IconButton(onClick = { confirmCallIn = selectedChannel?.id }) { Icon(Icons.Default.Call, contentDescription = stringResource(R.string.calls_start_call)) }
                    }
                    // The 自分 tab is the settings page: no search or menu over it.
                    if (barButtons) {
                        IconButton(onClick = ::openSearch) { Icon(Icons.Default.Search, contentDescription = stringResource(R.string.common_search)) }
                        if (menuItems.isNotEmpty()) {
                            IconButton(onClick = { menuOpen = true }) { Icon(Icons.Default.MoreVert, contentDescription = stringResource(R.string.common_menu)) }
                        }
                    }
                    DropdownMenu(expanded = menuOpen && menuItems.isNotEmpty(), onDismissRequest = { menuOpen = false }) {
                        menuItems.forEach { item ->
                            when (item) {
                                // M29: the pins and files are tabs under the app bar now; the details page does not list itself.
                                BarMenuItem.FAVORITE -> selectedChannel?.let { open ->
                                    val starred = store.isFavorite(open.id)
                                    DropdownMenuItem(
                                        text = { Text(if (starred) stringResource(R.string.common_remove_from_favorites) else stringResource(R.string.common_add_to_favorites)) },
                                        leadingIcon = { Icon(if (starred) Icons.Filled.Star else Icons.Outlined.StarBorder, contentDescription = null) },
                                        onClick = { menuOpen = false; scope.launch { controller.toggleFavorite(open.id) } },
                                    )
                                }
                                BarMenuItem.NOTIFICATIONS -> selectedChannel?.let { open ->
                                    // M35: the level resolved with my overall setting as it is now (a change shows at once).
                                    val level = NotificationLevels.resolved(open, store.me?.notificationDefault ?: NotificationLevels.MENTIONS, store.me?.id)
                                    val mute = Timeline.muteLabel(open.channel.notification?.mutedUntil)
                                    val mutedOn = NotificationLevels.mutedUntilUnmuted(open)
                                    DropdownMenuItem(
                                        text = {
                                            Text(
                                                when {
                                                    mutedOn -> stringResource(R.string.main_screen_notifications_muted)
                                                    mute != null -> stringResource(R.string.main_screen_notifications, mute)
                                                    else -> stringResource(R.string.main_screen_notifications_2) + NotificationLabels.shortLabel(level)
                                                },
                                            )
                                        },
                                        leadingIcon = { Icon(if (level == NotificationLevels.NONE || mutedOn || mute != null) Icons.Default.NotificationsOff else Icons.Default.Notifications, contentDescription = null) },
                                        onClick = { menuOpen = false; bellOpen = true },
                                    )
                                }
                                BarMenuItem.DETAILS -> DropdownMenuItem(
                                    text = { Text(stringResource(R.string.main_screen_channel_details)) }, leadingIcon = { Icon(Icons.Default.Info, contentDescription = null) },
                                    onClick = { menuOpen = false; openDetails() },
                                )
                                // L8 (TIMES_FEED.md §4, §7): the feed's channels only, asked first like the home's.
                                BarMenuItem.READ_ALL_TIMES -> DropdownMenuItem(
                                    text = { Text(stringResource(R.string.main_screen_mark_all_as_read)) }, leadingIcon = { Icon(Icons.Default.DoneAll, contentDescription = null) },
                                    onClick = { menuOpen = false; confirmReadTimes = true },
                                )
                                BarMenuItem.MY_TIMES -> {
                                    val mine = TimesFeed.myTimes(store.channels.values, me?.id)
                                    DropdownMenuItem(
                                        text = { Text(if (mine != null) stringResource(R.string.main_screen_write_in_your_times) else stringResource(R.string.common_create_your_times)) },
                                        leadingIcon = { Icon(if (mine != null) Icons.Default.Edit else Icons.Default.Add, contentDescription = null) },
                                        onClick = {
                                            menuOpen = false
                                            scope.launch {
                                                // The server makes it on the first call (M24); either way its composer takes the cursor.
                                                val id = mine?.id ?: controller.ensureTimes() ?: return@launch
                                                controller.messageFocus = null
                                                controller.composerFocus = id
                                                openConversation(id)
                                            }
                                        },
                                    )
                                }
                                // M66 (docs/AI.md §6): the choices open as a sheet; the result shows in its own sheet.
                                BarMenuItem.SUMMARIZE -> selectedChannel?.let { open ->
                                    DropdownMenuItem(
                                        text = { Text(stringResource(R.string.common_summary)) }, leadingIcon = { Icon(Icons.Default.AutoAwesome, contentDescription = null) },
                                        onClick = { menuOpen = false; controller.aiSummaryChooser = open.id },
                                    )
                                }
                                BarMenuItem.SUMMARIZE_THREAD -> selectedChannel?.let { open ->
                                    threadId?.let { parentId ->
                                        // Review v0.1.18 #2: the menu's content composes as it opens: read where the summary would go.
                                        LaunchedEffect(open.id) { controller.loadSummaryTarget(open.id) }
                                        val target = controller.aiSummaryTargets[open.id]
                                        DropdownMenuItem(
                                            text = { Text(stringResource(R.string.main_screen_summarize_this_thread)) }, leadingIcon = { Icon(Icons.Default.AutoAwesome, contentDescription = null) },
                                            enabled = !AiTexts.choicesDisabled(target),
                                            onClick = { menuOpen = false; controller.requestSummary(AiTexts.threadRequest(open.id, parentId)) },
                                        )
                                        AiSummaryTargetLine(target, Modifier.widthIn(max = 280.dp).padding(horizontal = 12.dp, vertical = 4.dp))
                                    }
                                }
                                BarMenuItem.CALENDAR_FEEDS -> DropdownMenuItem(
                                    text = { Text(stringResource(R.string.common_subscribe_to_the_calendar_ical)) }, leadingIcon = { Icon(Icons.Default.RssFeed, contentDescription = null) },
                                    onClick = { menuOpen = false; controller.openCalendarFeeds() },
                                )
                                BarMenuItem.ADD_MEMBER -> DropdownMenuItem(
                                    text = { Text(stringResource(R.string.common_add_members)) }, leadingIcon = { Icon(Icons.Default.PersonAdd, contentDescription = null) },
                                    onClick = { menuOpen = false; dialog = MainDialog.ADD_MEMBER },
                                )
                            }
                        }
                    }
                },
            )
        }
    }

    /** The page `view` is the top of, under its bar (T1: the list pane's root, the main pane's page; [pageView]). */
    @Composable
    fun Page(view: List<Route>, modifier: Modifier, banner: Boolean = true, open: ChannelState? = openChannel) {
        val (top, searching, _, _, pane, selectedChannel, threadId, detailsOpen, _, previewing, backToSearch, conversationTab) = pageView(view, open)
        CompositionLocalProvider(LocalPageLinks provides pageLinks) {
        Column(modifier) {
            // M29: the tab row sits directly under the app bar of a joined conversation's timeline.
            if (selectedChannel != null && ConversationNav.tabRowShown(true, selectedChannel.isMember, threadId != null, searching, detailsOpen)) {
                // M86 (DEADLINES.md §8 2.): the channel's next deadline, a line of its own over the tabs.
                DeadlineChipRow(controller, selectedChannel)
                ConversationTabRow(controller, selectedChannel, version, conversationTab, onTab = ::selectTab, upcoming = upcomingEvents)
            }
            if (banner) ConnectionBanner(status)
            val shownSearch = searchParams
            if (!searching && backToSearch && shownSearch != null && selectedChannel != null) {
                BackToSearchStrip(describeSearch(store, shownSearch), onClick = ::returnToSearch)
            }
            val openThread = threadId
            Box(Modifier.weight(1f).fillMaxWidth()) {
                if (searching) {
                    if (shownSearch != null) {
                        SearchResultsPane(
                            controller, version, shownSearch, searchResults,
                            tab = searchTab,
                            onTabChange = { searchTab = it },
                            onChange = ::changeSearch,
                            listState = searchListState,
                            filesState = searchFilesState,
                            canvasesState = searchCanvasesState,
                            onLoadMore = { scope.launch { searchResults.loadMore(controller) } },
                            onLoadMoreFiles = { scope.launch { searchResults.loadMoreFiles(controller) } },
                            onLoadMoreCanvases = { scope.launch { searchResults.loadMoreCanvases(controller) } },
                            onRetry = { scope.launch { searchResults.retry(controller) } },
                            onRetryCanvases = { scope.launch { searchResults.retryCanvases(controller) } },
                            onOpen = { message -> openFromSearch(message.id, message.channelId, message.parentId, message) },
                            onOpenFile = { item -> openFromSearch(item.messageId, item.channelId, item.parentId) },
                            onOpenCanvas = ::openCanvasFromSearch,
                            // M71: a message the AI's answer cites opens like a result (the results stay behind it).
                            onOpenCited = { messageId, channelId, parentId -> openFromSearch(messageId, channelId, parentId) },
                            // M122: pages I can read (the server keeps 「ドキュメント」); a hit opens over the results.
                            docs = controller.wiki?.available == true,
                            docsState = searchDocsState,
                            onLoadMorePages = { scope.launch { searchResults.loadMorePages(controller) } },
                            onRetryPages = { scope.launch { searchResults.retryPages(controller) } },
                            onOpenPage = { id -> focusManager.clearFocus(); stack = MainNav.openPage(stack, id) },
                        )
                    }
                } else if (pane == Route.Docs) {
                    // M122 (docs/WIKI.md §9.2): the tree; a row opens its page over it, the search key looks in the bodies.
                    DocsPane(
                        controller, docsListState, docsOpenRows, { docsOpenRows = it }, docsQuery, { docsQuery = it },
                        onOpen = { id -> focusManager.clearFocus(); stack = MainNav.openPage(stack, id) },
                        onSearchBodies = { q ->
                            focusManager.clearFocus()
                            openSearch()
                            searchTab = SEARCH_TAB_DOCS
                            runSearch(SearchParams(q = q))
                        },
                    )
                } else if (pane is Route.DocPage) {
                    // M122: a page (over the tree, another page, a conversation or the results); pages stack.
                    key(pane.id) {
                        DocPagePane(
                            controller, pane.id,
                            onOpenPage = { id -> focusManager.clearFocus(); stack = MainNav.openPage(stack, id) },
                            onOpenCrumb = { id -> focusManager.clearFocus(); stack = MainNav.openCrumb(stack, id) },
                        )
                    }
                } else if (pane is Route.Files) {
                    FilesPane(controller, version, channelId = pane.channelId, onScopeChange = { stack = MainNav.scopeFiles(stack, it) }) { messageId, channelId, parentId ->
                        scope.launch {
                            if (controller.revealMessage(messageId, channelId, parentId)) openConversation(channelId, parentId)
                        }
                    }
                } else if (selectedChannel != null && openThread != null) {
                    if (previewing) PreviewThreadPane(controller, selectedChannel.id, openThread, version)
                    else ThreadPane(controller, selectedChannel.id, openThread, version)
                } else if (pane == Route.Saved) {
                    SavedPane(controller, version, onOpen = ::reveal)
                } else if (selectedChannel != null) {
                    if (previewing) PreviewPane(controller, selectedChannel.id, version, onOpenThread = ::openThread)
                    else {
                        // M29: the timeline stays composed under the tabs and the details page (scroll position, read
                        // anchor, draft), but counts as not on screen while they cover it (SYNC_PROTOCOL.md §10.1 2.).
                        // M34: only the selected tab's top screen is composed at all; another tab's conversation is not.
                        ChannelPane(
                            controller, selectedChannel.id, version,
                            onScreen = AdaptiveLayout.conversationOnScreen(tabs, layout),
                            onOpenThread = ::openThread,
                        )
                        when {
                            detailsOpen -> CoveringPage {
                                ChannelDetailsPane(
                                    controller, selectedChannel, version, onClose = { changeConversation(MainNav::closeDetails) },
                                    // D1: 「検索」 searches this conversation (newest first; words can be added), back returns here.
                                    onSearch = { openSearch(); runSearch(SearchParams(channelId = selectedChannel.id, sort = Search.NEWEST)) },
                                )
                            }
                            // A pin or a file shows its message under 「メッセージ」 (its thread too for a reply): openConversation
                            // goes back to that tab.
                            conversationTab == ConversationTab.PINS -> CoveringPage { PinsPane(controller, selectedChannel.id, version, onOpen = ::reveal) }
                            // M46 (CANVAS.md §4.1): the conversation's canvas (or the one picked from its list / a /c/ link).
                            conversationTab == ConversationTab.CANVAS -> CoveringPage {
                                CanvasPane(controller, selectedChannel, version, conversation?.canvasId, onSelect = { id ->
                                    focusManager.clearFocus()
                                    changeConversation { MainNav.selectCanvas(it, id) }
                                }, onOpenThread = { parentId ->
                                    // M58 「コメント」: the shared message's thread over the canvas (back returns to it).
                                    focusManager.clearFocus()
                                    openThread(parentId)
                                })
                            }
                            // M52 (CALENDAR.md §7): the channel's shared calendar, the next 60 days.
                            conversationTab == ConversationTab.EVENTS -> CoveringPage { ChannelEventsPane(controller, selectedChannel, version) }
                            // M56 (TASKS.md §6): the channel's board, a column at a time.
                            conversationTab == ConversationTab.TASKS -> CoveringPage { ChannelTasksPane(controller, selectedChannel, version) }
                            conversationTab == ConversationTab.FILES -> CoveringPage {
                                FilesPane(controller, version, channelId = selectedChannel.id, onScopeChange = null) { messageId, channelId, parentId ->
                                    scope.launch {
                                        if (controller.revealMessage(messageId, channelId, parentId)) openConversation(channelId, parentId)
                                    }
                                }
                            }
                        }
                    }
                } else if (pane == Route.Reminders) {
                    RemindersPane(controller, version) { row -> scope.launch { controller.openPermalink(row.messageId) } }
                } else if (pane == Route.Canvases) {
                    // M78 (CANVAS.md §21.2): a row opens its canvas over the list (back returns here); the keyboard's
                    // search looks in the bodies on the search's 「キャンバス」 tab (back returns here too).
                    CanvasesPane(
                        controller, version, myCanvases, canvasesListState,
                        onOpen = { canvas ->
                            when (val target = MyCanvases.open(stack, store, canvas)) {
                                is MyCanvasOpen.Push -> {
                                    controller.messageFocus = null
                                    focusManager.clearFocus()
                                    stack = target.stack
                                }
                                is MyCanvasOpen.Link -> scope.launch { controller.openCanvasLink(target.canvasId) }
                            }
                        },
                        onSearchBodies = { q ->
                            focusManager.clearFocus()
                            openSearch()
                            searchTab = SEARCH_TAB_CANVASES
                            runSearch(SearchParams(q = q))
                        },
                    )
                } else if (pane == Route.Calendar) {
                    // M52 (CALENDAR.md §7): 一覧 and 月, filtered by calendar; a row opens the event's form.
                    CalendarPane(controller, version)
                } else if (pane == Route.Tasks) {
                    // M56 (TASKS.md §6): 「自分のタスク」 and 「自分の担当」; a channel's name opens its 「タスク」 tab.
                    MyTasksPane(controller, version, onOpenBoard = { channelId ->
                        controller.messageFocus = null
                        focusManager.clearFocus()
                        stack = MainNav.openTasks(stack, channelId)
                    })
                } else if (pane == Route.Deadlines) {
                    // M86 (DEADLINES.md §8 3.): 今週 / 今月 / それ以降 / 過ぎたもの; a row opens the deadline's form.
                    DeadlinesPane(controller, version)
                } else if (pane == Route.Reservations) {
                    // M112 (RESERVATIONS.md §6): per pool mine, 予約する / 今すぐ, the operators' to-do and a day's hours.
                    ReservationsPane(controller, version)
                } else if (pane == Route.Attendance) {
                    // M140 (PRESENCE.md §9): my one-tap buttons and note, my own states, the board by state.
                    AttendancePane(controller, version)
                } else if (pane == Route.Mentions) {
                    MentionsPane(controller, version, onOpen = ::reveal)
                } else if (pane == Route.Drafts) {
                    // A draft row opens its conversation (the composer restores the text); back returns to the list.
                    DraftsPane(controller, version) { channelId, parentId ->
                        controller.messageFocus = null
                        stack = MainNav.openDraft(stack, channelId, parentId)
                    }
                } else if (pane == Route.TimesFeed) {
                    // L8: a row shows its message in its channel, 「返信 N 件」 its thread; back returns to the feed.
                    // A reply also sent to the channel shows as the channel's row (TIMES_FEED §7); its thread opens with its
                    // parent from the feed, or fetched by id when the feed does not hold it (ThreadRows.parent).
                    TimesFeedPane(
                        controller, version, timesFeedListState,
                        onOpen = { reveal(TimesFeed.revealTarget(it)) },
                        onOpenThread = { message ->
                            controller.messageFocus = null
                            stack = MainNav.openFromThreadList(stack, message.channelId, TimesFeed.threadOf(message))
                        },
                    )
                } else if (pane == Route.Threads) {
                    ThreadsPane(controller, version, onOpen = ::openThreadFromList, onOpenConversation = ::openThreadConversation)
                } else if (top == Route.DmList) {
                    DmListScreen(
                        controller, version, dmListState,
                        onOpen = { controller.messageFocus = null; openConversation(it) },
                        onNew = { dialog = MainDialog.NEW_DM },
                        selectedId = selection.takeIf { layout != PaneLayout.PHONE },
                    )
                } else if (top is Route.Activity) {
                    // Rows push their conversation / thread on this tab's stack (back returns here).
                    ActivityScreen(
                        controller, version, top.segment,
                        onSegment = {
                            tabs = MainTabs.selectSegment(tabs, it)
                            activityListState.requestScrollToItem(0)
                        },
                        listState = activityListState,
                        mentionsState = mentionsListState,
                        threadsState = threadsListState,
                        onOpenMessage = ::reveal,
                        onOpenThread = ::openThreadFromList,
                        onOpenThreadConversation = ::openThreadConversation,
                        // M77 (CANVAS.md §20.7): a canvas row opens its conversation's 「キャンバス」 tab on this tab's
                        // stack, like the message rows (back returns here). A conversation the store does not know yet
                        // lands like the canvas push (M73) once it does.
                        onOpenReservations = { controller.pendingReservations = true },
                        // M122: a page row opens the page on this tab's stack (back returns here).
                        onOpenPage = { pageId ->
                            controller.messageFocus = null
                            stack = MainNav.openPage(stack, pageId)
                        },
                        onOpenCanvas = { channelId, canvasId ->
                            if (store.channel(channelId) != null) {
                                controller.messageFocus = null
                                stack = MainNav.openCanvas(stack, channelId, canvasId)
                            } else {
                                controller.openCanvasFromActivity(channelId, canvasId)
                            }
                        },
                    )
                } else if (top == Route.You || top is Route.Settings) {
                    // M40 (MOBILE_UI.md §6.5): the list and its screens; wide, the list with the chosen screen beside it.
                    YouTab(
                        controller, version, stack, youTwoPane, youScrollState,
                        onSelect = { page ->
                            focusManager.clearFocus()
                            stack = if (youTwoPane) MainNav.selectSettings(stack, page) else MainNav.openSettings(stack, page)
                        },
                        onOpen = { page -> focusManager.clearFocus(); stack = MainNav.openSettings(stack, page) },
                        onClose = { focusManager.clearFocus(); goBack() },
                        onLogout = { confirmLogout = true },
                    )
                } else {
                    // M37 (MOBILE_UI.md §6.1): 移動・検索, the tiles and the sections. 「メンション」 is the activity tab's (M34).
                    HomeScreen(
                        controller, version, listState = homeListState, groupUnread = groupUnread,
                        onJump = ::openJump,
                        onSelect = { controller.messageFocus = null; openConversation(it) },
                        onTile = { tile ->
                            stack = AdaptiveLayout.openFromList(
                                stack,
                                when (tile) {
                                    HomeTile.THREADS -> Route.Threads
                                    HomeTile.TIMES -> Route.TimesFeed
                                    HomeTile.DRAFTS -> Route.Drafts
                                    HomeTile.SAVED -> Route.Saved
                                    HomeTile.REMINDERS -> Route.Reminders
                                    HomeTile.CALENDAR -> Route.Calendar
                                    HomeTile.TASKS -> Route.Tasks
                                    HomeTile.DEADLINES -> Route.Deadlines
                                    HomeTile.RESERVATIONS -> Route.Reservations
                                    HomeTile.ATTENDANCE -> Route.Attendance
                                    HomeTile.FILES -> Route.Files()
                                    HomeTile.DOCS -> Route.Docs
                                    HomeTile.CANVASES -> {
                                        // Afresh from the tile (back from a canvas keeps the pages and the place).
                                        myCanvases.clear()
                                        canvasesListState.requestScrollToItem(0)
                                        Route.Canvases
                                    }
                                },
                                layout,
                            )
                        },
                        onAddChannel = { dialog = MainDialog.BROWSE },
                        onTimesFeed = { stack = AdaptiveLayout.openFromList(stack, Route.TimesFeed, layout) },
                        onAllDms = { selectMainTab(MainTab.DM) },
                        onCreateTimes = {
                            scope.launch {
                                val id = controller.ensureTimes() ?: return@launch
                                controller.messageFocus = null
                                openConversation(id)
                            }
                        },
                        onChannelMenu = { channelMenuFor = it },
                        onSectionMenu = { section, index -> sectionMenuFor = section to index },
                        folded = folded,
                        onToggleFolded = { folded = FoldedSections.toggle(controller.prefs, it) },
                        onToggleSection = { section -> scope.launch { controller.setSectionCollapsed(section.id, !section.collapsed) } },
                        sectionIcon = { emoji -> SectionIcon(controller, emoji, version) },
                        selectedId = selection.takeIf { layout != PaneLayout.PHONE },
                        editing = editingSection,
                        onEditing = { editingSection = it },
                    )
                }
            }
        }
        }
    }

    val windowWidth = with(LocalDensity.current) { LocalWindowInfo.current.containerSize.width.toDp().value }
    if (layout == PaneLayout.PHONE) {
        // Issue #1 (MOBILE_UI.md §5.1): the page on screen, and while a swipe (or the system's back gesture) slides it the
        // page it goes to, drawn under or over it (SwipeNavHost). Each is a whole page: its bar, its content, the tabs.
        SwipeNavHost(
            current = tabs,
            swipe = swipe,
            backTarget = swipeBack,
            forwardTarget = swipeForward,
            onCommit = ::commitSwipe,
        ) { state, isCurrent ->
            val view = MainTabs.stack(state)
            val viewTop = MainNav.top(view)
            // A page under the swipe shows its own conversation (the one a left swipe brings back is not open yet).
            val open = MainNav.conversation(view)?.id?.let { id -> if (id == selection) openChannel else store.channel(id) }
            Scaffold(
                snackbarHost = { if (isCurrent) SnackbarHost(snackbar) },
                // M34: the bottom tabs, on the roots and the lists pushed on them; hidden in a conversation, a thread or details.
                // M40: wide, the 自分 tab's list stays beside its screens, and so does the bar.
                bottomBar = {
                    if (MainTabs.barShown(view) || (youTwoPane && viewTop is Route.Settings)) MainTabBar(store, version, state.selected, onTab = ::selectMainTab)
                },
                // M37 (MOBILE_UI.md §6.1): ✏️ 新しいメッセージ, bottom right over the tab bar, on the home's list.
                floatingActionButton = {
                    if (viewTop == Route.ChannelList) {
                        FloatingActionButton(onClick = { focusManager.clearFocus(); composing = true }) {
                            Icon(Icons.Default.Edit, contentDescription = stringResource(R.string.common_new_message))
                        }
                    }
                },
                topBar = { Bar(view, back = if (MainNav.canGoBack(view)) ({ goBack() }) else null, barWidth = windowWidth, open = open) },
            ) { padding ->
                // The scaffold's insets are consumed here (M28c): the panes below add `imePadding()`, which otherwise counted the
                // navigation bar a second time and left a blank band of its height between the composer and the keyboard.
                Page(view, Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding), open = open)
            }
        }
    } else {
        // T1 (MOBILE_UI.md §12): the rail, the tab's list, the page opened from it and (three panes) the thread. The
        // stacks are the phone's: only where their routes are drawn differs (AdaptiveLayout).
        val listPane = AdaptiveLayout.listPane(layout, tabs.selected)
        val listWidth = AdaptiveLayout.listWidth(windowWidth)
        val threadRoute = AdaptiveLayout.threadPane(stack, layout)
        val view = AdaptiveLayout.mainView(stack, layout)
        val mainWidth = windowWidth - AdaptiveLayout.RAIL_WIDTH - (if (listPane) listWidth else 0f) - (if (threadRoute != null) AdaptiveLayout.THREAD_WIDTH else 0f)
        Scaffold(snackbarHost = { SnackbarHost(snackbar) }) { padding ->
            Row(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding)) {
                MainTabRail(store, version, tabs.selected, onTab = ::selectMainTab, onCompose = { focusManager.clearFocus(); composing = true })
                if (listPane) {
                    val root = listOf(MainNav.rootOf(stack))
                    Column(Modifier.width(listWidth.dp).fillMaxHeight()) {
                        Bar(root, back = null, barWidth = listWidth)
                        Page(root, Modifier.weight(1f).fillMaxWidth(), banner = false)
                    }
                    VerticalDivider()
                }
                Column(Modifier.weight(1f).fillMaxHeight()) {
                    if (listPane && AdaptiveLayout.placeholder(view)) {
                        ConnectionBanner(status)
                        EmptyMainPane(tabs.selected)
                    } else {
                        // The ← of a page with something of its own under it (the list beside it is the way to the rest).
                        val back: (() -> Unit)? = when {
                            !listPane -> if (MainNav.canGoBack(stack)) ({ goBack() }) else null
                            AdaptiveLayout.backShown(view) -> ({ goBackIn(view) })
                            else -> null
                        }
                        Bar(view, back = back, barWidth = mainWidth)
                        Page(view, Modifier.weight(1f).fillMaxWidth())
                    }
                }
                if (threadRoute != null && openChannel != null) {
                    VerticalDivider()
                    Column(Modifier.width(AdaptiveLayout.THREAD_WIDTH.dp).fillMaxHeight()) {
                        Bar(stack, back = { focusManager.clearFocus(); stack = AdaptiveLayout.closeThread(stack) }, barWidth = AdaptiveLayout.THREAD_WIDTH, closes = true)
                        Box(Modifier.weight(1f).fillMaxWidth()) {
                            if (openChannel.isMember) ThreadPane(controller, openChannel.id, threadRoute.parentId, version)
                            else PreviewThreadPane(controller, openChannel.id, threadRoute.parentId, version)
                        }
                    }
                }
            }
        }
    }

    if (composing) {
        NewMessageDialog(controller, version, onDismiss = { composing = false }, onOpen = { id ->
            composing = false
            openPicked(id, focusComposer = true)
        })
    }
    if (confirmLogout) LogoutConfirmDialog(controller, onDismiss = { confirmLogout = false })
    confirmCallIn?.let { id ->
        // Outside the screen's scope: leaving the conversation does not cancel a call being started.
        StartCallDialog(onDismiss = { confirmCallIn = null }, onConfirm = { confirmCallIn = null; controller.scope.launch { controller.startCall(id) } })
    }
    if (confirmReadTimes) {
        AlertDialog(
            onDismissRequest = { confirmReadTimes = false },
            title = { Text(stringResource(R.string.main_screen_mark_everything_as_read)) },
            text = { Text(stringResource(R.string.main_screen_marks_the_times_in_the_feed)) },
            confirmButton = { TextButton(onClick = { confirmReadTimes = false; scope.launch { controller.markAllRead(TimesFeed.READ_ALL_SCOPE) } }) { Text(stringResource(R.string.common_mark_as_read)) } },
            dismissButton = { TextButton(onClick = { confirmReadTimes = false }) { Text(stringResource(R.string.common_cancel)) } },
        )
    }
    if (confirmReadAll) {
        AlertDialog(
            onDismissRequest = { confirmReadAll = false },
            title = { Text(stringResource(R.string.main_screen_mark_everything_as_read)) },
            text = { Text(stringResource(R.string.main_screen_marks_all_your_channels_and_dms)) },
            confirmButton = { TextButton(onClick = { confirmReadAll = false; scope.launch { controller.markAllRead() } }) { Text(stringResource(R.string.common_mark_as_read)) } },
            dismissButton = { TextButton(onClick = { confirmReadAll = false }) { Text(stringResource(R.string.common_cancel)) } },
        )
    }

    when (dialog) {
        MainDialog.NEW_DM -> NewDmDialog(controller, onDismiss = { dialog = null }, onOpened = { controller.messageFocus = null; openConversation(it) })
        MainDialog.DIRECTORY -> DirectoryDialog(controller, onDismiss = { dialog = null }, onOpened = { controller.messageFocus = null; openConversation(it) })
        MainDialog.NEW_CHANNEL -> NewChannelDialog(controller, onDismiss = { dialog = null }, onOpened = { controller.messageFocus = null; openConversation(it) })
        MainDialog.ADD_MEMBER -> selectedChannel?.let { AddMemberDialog(controller, it.id, onDismiss = { dialog = null }) }
        MainDialog.BROWSE -> ChannelBrowserDialog(
            controller, version, onDismiss = { dialog = null },
            onOpen = { controller.messageFocus = null; openConversation(it) },
            onCreate = { dialog = MainDialog.NEW_CHANNEL },
        )
        null -> Unit
    }
    channelMenuFor?.let { id ->
        ChannelSectionDialog(controller, id, version, onDismiss = { channelMenuFor = null }, onNewSection = { channelMenuFor = null; sectionForm = null to listOf(id) })
    }
    sectionMenuFor?.let { (section, index) ->
        SectionActionsDialog(
            controller, section, index, controller.store.sidebarSections.size, version, onDismiss = { sectionMenuFor = null },
            onEdit = { sectionMenuFor = null; sectionForm = section to emptyList() },
            onNewSection = { sectionMenuFor = null; sectionForm = null to emptyList() },
            shownIds = {
                val store = controller.store
                Channels.sections(store.channels.values, favorites = store.favorites, sidebar = store.sidebarSections, meId = store.me?.id,
                    defaults = store.sidebarDefaults, title = { channelTitle(it, store) }, dmPins = store.dmPins)
                    .custom.firstOrNull { it.first.id == section.id }?.second?.map { it.id }.orEmpty()
            },
            onEditOrder = { sectionMenuFor = null; editingSection = "custom:" + section.id },
        )
    }
    sectionForm?.let { (section, preselected) -> SectionDialog(controller, section, preselected, version, onDismiss = { sectionForm = null }) }
}

/**
 * M25 (MUI-1): the thread's app bar at phone widths. At 360 dp the labelled 「フォロー中」 chip cut the title to
 * 「スレ…」 (emulator, 2026-09-28), so the chip keeps its label only where the title still fits beside it. Widths in
 * dp, the fixed parts as Material 3's TopAppBar lays them out (measured on the emulator).
 */
object ConversationBar {
    /** The back button with the bar's start padding (4 + 48) and the title's own padding (4 + 4). */
    private const val START = 52f + 8f
    /**
     * Search (48) and the bar's end padding (4); ⋮ (48) when the screen has a menu (BarMenu: a thread has none). 仕上げ A
     * (MOBILE_POLISH.md C5): the connection dot (26, a 30 spinner while connecting) is gone from the bar.
     */
    private const val END = 48f + 4f
    private const val MENU = 48f
    /** The FilterChip around its label (paddings 8 + 8 + 16 and the 16 bell) and its end padding (4). */
    private const val CHIP = 48f + 4f

    fun followLabelFits(barWidth: Float, title: Float, label: Float, menu: Boolean = false): Boolean =
        barWidth - START - END - (if (menu) MENU else 0f) - CHIP - label >= title
}

/**
 * T1: what one pane draws, read from the stack it shows the top of ([AdaptiveLayout]): the whole stack on the phone; wide,
 * the root alone in the list pane, the stack less a thread with a pane of its own in the main pane, the whole stack in
 * the thread's pane. [selectedChannel] is the open conversation only where the view holds it.
 */
private data class PageView(
    val top: Route,
    val searching: Boolean,
    val searchExpanded: Boolean,
    val jumping: Boolean,
    val pane: Route.Pane?,
    val selectedChannel: ChannelState?,
    val threadId: String?,
    val detailsOpen: Boolean,
    val isChannel: Boolean,
    val previewing: Boolean,
    val backToSearch: Boolean,
    val conversationTab: ConversationTab,
)

private fun pageView(view: List<Route>, open: ChannelState?): PageView {
    val top = MainNav.top(view)
    // M122: a page of 「ドキュメント」 opened over a conversation (a /p/ link) is its own page, not the conversation's.
    val conversation = if (top is Route.Docs || top is Route.DocPage) null else MainNav.conversation(view)
    val channel = open?.takeIf { conversation?.id == it.id }
    return PageView(
        top = top,
        searching = top is Route.Search,
        searchExpanded = (top as? Route.Search)?.expanded == true,
        jumping = (top as? Route.Search)?.jump == true,
        pane = top as? Route.Pane,
        selectedChannel = channel,
        threadId = if (channel != null) MainNav.thread(view)?.parentId else null,
        detailsOpen = channel != null && conversation?.detailsOpen == true,
        isChannel = channel != null && !channel.channel.isDm,
        previewing = channel?.isMember == false,
        backToSearch = MainNav.backToSearch(view),
        conversationTab = if (channel != null && conversation != null) conversation.tab else ConversationTab.MESSAGES,
    )
}

/** T1: the main pane with nothing open beside a list (wide). */
@Composable
private fun EmptyMainPane(tab: MainTab) {
    Box(Modifier.fillMaxSize(), contentAlignment = androidx.compose.ui.Alignment.Center) {
        Text(
            when (tab) {
                MainTab.DM -> stringResource(R.string.main_screen_choose_a_dm_from_the_list)
                MainTab.ACTIVITY -> stringResource(R.string.common_choose_an_item_from_the_list)
                else -> stringResource(R.string.main_screen_choose_a_channel_from_the_list)
            },
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(24.dp),
        )
    }
}

/**
 * M29: a page drawn over the conversation's timeline (a tab, the details). Opaque, and it takes every touch, so none
 * reaches the timeline below; the keyboard of a field on it pushes its content up.
 */
@Composable
private fun CoveringPage(content: @Composable () -> Unit) {
    Surface(Modifier.fillMaxSize()) {
        Box(Modifier.fillMaxSize().imePadding()) { content() }
    }
}

@Composable
private fun TwoLineTitle(title: String, subtitle: String?, emoji: Pair<AppController, Int>? = null) {
    Column {
        Text(title, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (subtitle != null) {
            val style = MaterialTheme.typography.bodySmall
            val color = MaterialTheme.colorScheme.onSurfaceVariant
            if (emoji != null) EmojiLineText(subtitle, emoji.first, emoji.second, style, color)
            else Text(subtitle, style = style, color = color, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

/**
 * Thin strip under the app bar while the socket stays down. A reconnect that finishes within [BANNER_GRACE_MS]
 * (launch, return from the background) shows nothing: the strip would only flash and push the list down and back.
 * Once shown, it follows the status until the socket is live again (same 2 s on every client).
 */
@Composable
fun ConnectionBanner(status: EngineStatus) {
    var shown by remember { mutableStateOf<EngineStatus?>(null) }
    LaunchedEffect(status) {
        if (status != EngineStatus.CONNECTING && status != EngineStatus.OFFLINE) {
            shown = null
            return@LaunchedEffect
        }
        if (shown == null) delay(BANNER_GRACE_MS)
        shown = status
    }
    val (text, color) = when (shown) {
        EngineStatus.CONNECTING -> stringResource(R.string.main_screen_connecting_to_the_server) to MaterialTheme.colorScheme.primaryContainer
        EngineStatus.OFFLINE -> stringResource(R.string.main_screen_offline_waiting_to_reconnect) to MaterialTheme.colorScheme.errorContainer
        else -> return
    }
    Text(text, style = MaterialTheme.typography.labelMedium, modifier = Modifier.fillMaxWidth().background(color).padding(horizontal = 16.dp, vertical = 4.dp))
}

private const val BANNER_GRACE_MS = 2_000L

/** 1:1 DM: the other person's presence (SYNC_PROTOCOL.md §5.2) as the app bar subtitle. */
internal fun dmPresenceSubtitle(channel: ChannelState, store: Store): String? {
    val others = (channel.channel.dmUserIds ?: emptyList()).filter { it != store.me?.id }
    if (others.size != 1) return null
    val presence = presenceLabel(store.presenceOf(others[0]))
    val status = jp.chikuwachat.android.api.activeStatus(store.users[others[0]]) ?: return presence
    return "$presence · ${status.first} ${status.second}".trim()
}

/**
 * `#name` for channels, the other members for DMs. My own DM (a DM with nobody but me, Slack / Mattermost style) is
 * named after me.
 */
fun channelTitle(channel: ChannelState, store: Store): String {
    if (!channel.channel.isDm) return "#" + (channel.channel.name ?: "")
    val others = (channel.channel.dmUserIds ?: emptyList()).filter { it != store.me?.id }
    if (others.isEmpty()) return myDisplayName(store)
    return others.joinToString(", ") { store.users[it]?.displayName ?: "…" }
}

/** My name as the lists show it (my own DM's title, and its placeholder row's): see MainTabs.myName. */
fun myDisplayName(store: Store): String {
    val me = store.me
    val user = me?.id?.let { store.users[it] }
    return MainTabs.myName(user?.displayName?.takeIf { it.isNotBlank() } ?: me?.displayName, user?.username ?: me?.username)
}
