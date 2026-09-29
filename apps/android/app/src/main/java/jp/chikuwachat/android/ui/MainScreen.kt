package jp.chikuwachat.android.ui

import android.Manifest
import android.os.Build
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyItemScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Alarm
import androidx.compose.material.icons.filled.Bookmark
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Explore
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Forum
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.NotificationsNone
import androidx.compose.material.icons.filled.NotificationsOff
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.filled.Tag
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.StarBorder
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconToggleButton
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalWindowInfo
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import java.time.Instant
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
    val recentKey = controller.accountKey?.let { RecentSearches.key(it) }
    var recentSearches by remember(recentKey) { mutableStateOf(recentKey?.let { RecentSearches.read(controller.prefs, it) } ?: emptyList()) }
    // Saveable (M28c): an open dialog (and what was typed in it) survives a rotation.
    var dialog by rememberSaveable { mutableStateOf<MainDialog?>(null) }
    // M14f: the conversation whose long-press menu is open, and the section whose 「…」 is.
    var channelMenuFor by rememberSaveable { mutableStateOf<String?>(null) }
    var sectionMenuFor by remember { mutableStateOf<Pair<jp.chikuwachat.android.api.SidebarSectionOut, Int>?>(null) }
    // M26: making (no section) or editing one of my sections; the conversations a long-press 「新しいセクション…」 ticks.
    var sectionForm by remember { mutableStateOf<Pair<jp.chikuwachat.android.api.SidebarSectionOut?, List<String>>?>(null) }
    // M26: the default sections folded on this device.
    var folded by remember { mutableStateOf(FoldedSections.read(controller.prefs)) }
    var menuOpen by remember { mutableStateOf(false) }
    var bellOpen by remember { mutableStateOf(false) }
    // M28c: 「未読のみ」 as it was left on this device (like the folded sections), not only across a rotation.
    var unreadOnly by remember { mutableStateOf(UnreadFilter.read(controller.prefs)) }
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
                    MainTab.ACTIVITY -> (if ((top as? Route.Activity)?.segment == ActivitySegment.THREADS) threadsListState else mentionsListState).animateScrollToItem(0)
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
            controller.messageFocus = null
            if (reply == null) land(id)
            else scope.launch { if (controller.revealMessage(reply.first, id, reply.second)) land(id, reply.second) else land(id) }
        }
    }
    // M34 (8), MOBILE_UI.md §10 1.: the engine's open conversation is the selected tab's; one left on another tab is not.
    val conversation = MainTabs.openConversation(tabs)
    val selection = conversation?.id
    LaunchedEffect(selection) {
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
    }
    fun runSearch(params: SearchParams) {
        recentKey?.let { recentSearches = RecentSearches.push(controller.prefs, it, params) }
        // The files tab reads only the words and the channel: a search by sender, date, kind or thread shows messages.
        if (params.fromUserId != null || params.date != null || params.has.isNotEmpty() || params.isThread) searchTab = 0
        changeSearch(params)
        searchText = params.q
        stack = MainNav.runSearch(stack, params)
    }
    fun returnToSearch() { stack = MainNav.returnToSearch(stack) }
    /** A result: its conversation (or thread) around the message, with the way back to the results. */
    fun openFromSearch(messageId: String, channelId: String, parentId: String?, message: jp.chikuwachat.android.api.MessageOut? = null) {
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

    // M29 / M33: back (the system's, the app bar's ← and the search bar's) closes the details page, then a pins / files
    // tab (to 「メッセージ」), then the thread, then the conversation, then the list; on the search, the suggestions over
    // results then the search itself (MainNav.back).
    // M34: at a tab's root, back goes to the home tab (MainTabs.back); at the home tab's root the app closes as before.
    fun goBack() {
        val fromSearch = top is Route.Search
        tabs = MainTabs.back(tabs)
        if (fromSearch) searchText = (MainNav.top(stack) as? Route.Search)?.params?.q ?: ""
    }
    /** The keyboard goes with the composer when a page or tab covers the timeline. */
    fun openDetails() { focusManager.clearFocus(); stack = MainNav.openDetails(stack) }
    fun selectTab(tab: ConversationTab) { focusManager.clearFocus(); stack = MainNav.selectTab(stack, tab) }
    fun openThread(parentId: String) { stack = MainNav.openThread(stack, parentId) }
    // The suggestions fold through the search bar's own back handling (SearchBar → collapseSearch).
    BackHandler(enabled = MainTabs.canGoBack(tabs) && !searchExpanded) { goBack() }
    /** A card in the pins pane / saved list: show the message in its conversation. */
    fun reveal(message: jp.chikuwachat.android.api.MessageOut) {
        scope.launch {
            if (controller.revealMessage(message)) openConversation(message.channelId, message.parentId)
        }
    }

    val me = store.me
    val isChannel = selectedChannel != null && !selectedChannel.channel.isDm
    // M27 (SYNC_PROTOCOL.md §7.6.1): a public channel I have not joined opens read-only, until 「参加する」.
    val previewing = selectedChannel?.isMember == false

    // A permalink tapped in a body (M12b): the controller fetched the message; show it in its conversation.
    LaunchedEffect(controller.pendingReveal) {
        val message = controller.pendingReveal ?: return@LaunchedEffect
        controller.pendingReveal = null
        land(message.channelId, message.parentId)
    }
    Scaffold(
        snackbarHost = { SnackbarHost(snackbar) },
        // M34: the bottom tabs, on the roots and the lists pushed on them; hidden in a conversation, a thread or details.
        bottomBar = { if (MainTabs.barShown(stack)) MainTabBar(store, version, tabs.selected, onTab = ::selectMainTab) },
        topBar = {
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
                    placeholder = "${controller.workspaceName} を検索",
                )
            } else {
                TopAppBar(
                    title = {
                        when {
                            detailsOpen -> TwoLineTitle(channelTitle(selectedChannel, store), null)
                            threadId != null -> TwoLineTitle("スレッド", selectedChannel?.let { channelTitle(it, store) })
                            selectedChannel != null && previewing -> TwoLineTitle(channelTitle(selectedChannel, store), "プレビュー (未参加)")
                            // M29: the title opens the details page.
                            selectedChannel != null -> Column(Modifier.clickable(onClickLabel = "チャンネル情報") { openDetails() }) {
                                TwoLineTitle(
                                    channelTitle(selectedChannel, store),
                                    selectedChannel.channel.topic?.takeIf { it.isNotBlank() } ?: if (isChannel) "トピックを設定" else dmPresenceSubtitle(selectedChannel, store),
                                )
                            }
                            pane == Route.Threads -> Text("スレッド")
                            pane == Route.Saved -> Text("保存済み")
                            pane == Route.Mentions -> Text("メンション")
                            pane == Route.Drafts -> Text("下書き")
                            pane is Route.Files -> Text("ファイル")
                            pane == Route.Reminders -> Text("リマインダー")
                            top == Route.DmList -> Text("ダイレクトメッセージ", maxLines = 1, overflow = TextOverflow.Ellipsis)
                            top is Route.Activity -> Text("アクティビティ", maxLines = 1, overflow = TextOverflow.Ellipsis)
                            top == Route.You -> Text("自分", maxLines = 1, overflow = TextOverflow.Ellipsis)
                            else -> WorkspaceTitle(controller) // M16c: tap to switch workspaces
                        }
                    },
                    navigationIcon = {
                        when {
                            MainNav.canGoBack(stack) -> IconButton(onClick = ::goBack) {
                                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "戻る")
                            }
                            // M34: my avatar opens the 自分 tab (the settings were a dialog).
                            me != null && top != Route.You -> IconButton(onClick = { selectMainTab(MainTab.YOU) }, modifier = Modifier.semantics { contentDescription = "自分" }) {
                                Avatar(me.id, me.displayName, size = 32.dp)
                            }
                        }
                    },
                    actions = {
                        StatusBadge(status)
                        // THREADS.md §5: follow / unfollow the open thread.
                        val openId = threadId
                        val threadState = openId?.let { store.threads[it]?.state }
                        if (openId != null && threadState != null && selectedChannel?.isMember == true) {
                            // M25: the labelled chip only where 「スレッド」 still fits beside it (ConversationBar), else the bell alone.
                            val measurer = rememberTextMeasurer()
                            val density = LocalDensity.current
                            val labelled = with(density) {
                                ConversationBar.followLabelFits(
                                    barWidth = LocalWindowInfo.current.containerSize.width.toDp().value,
                                    title = measurer.measure("スレッド", MaterialTheme.typography.titleMedium).size.width.toDp().value,
                                    label = measurer.measure("フォロー中", MaterialTheme.typography.labelLarge).size.width.toDp().value,
                                )
                            }
                            val bell = if (threadState.following) Icons.Default.Notifications else Icons.Default.NotificationsNone
                            // Through the controller (M28c): offline it says so instead of silently doing nothing.
                            val toggle = { scope.launch { controller.setThreadFollow(openId, !threadState.following) } }
                            if (labelled) {
                                FilterChip(
                                    selected = threadState.following,
                                    onClick = { toggle() },
                                    label = { Text(if (threadState.following) "フォロー中" else "フォロー") },
                                    leadingIcon = { Icon(bell, contentDescription = null, modifier = Modifier.size(16.dp)) },
                                    modifier = Modifier.padding(end = 4.dp),
                                )
                            } else {
                                // A toggle: TalkBack says 「スレッドをフォロー」 with on / off.
                                IconToggleButton(checked = threadState.following, onCheckedChange = { toggle() }) {
                                    Icon(bell, contentDescription = "スレッドをフォロー")
                                }
                            }
                        }
                        // In a channel the icons were star, pin, files, bell and info: they left the channel's name no room (testers,
                        // 2026-09-28), so they are at the top of ⋮; the notification level still opens its own menu from there.
                        if (selectedChannel != null && selectedChannel.isMember && threadId == null && !detailsOpen) {
                            // M35: 「既定 (…)」 follows the overall setting (level null); 「ミュート」 lasts until unmuted.
                            val ownLevel = NotificationLevels.own(selectedChannel)
                            val overall = store.me?.notificationDefault ?: NotificationLevels.MENTIONS
                            val mutedOn = NotificationLevels.mutedUntilUnmuted(selectedChannel)
                            val mute = Timeline.muteLabel(selectedChannel.channel.notification?.mutedUntil)
                            DropdownMenu(expanded = bellOpen, onDismissRequest = { bellOpen = false }) {
                                (listOf<Pair<String?, String>>(null to NotificationLabels.defaultChoice(overall)) + NotificationLevels.levels.map { it to NotificationLabels.label(it) })
                                    .forEach { (value, label) ->
                                        DropdownMenuItem(
                                            text = { Text((if (ownLevel == value) "✓ " else "    ") + label) },
                                            onClick = { bellOpen = false; scope.launch { controller.setChannelLevel(selectedChannel.id, value) } },
                                        )
                                    }
                                HorizontalDivider()
                                DropdownMenuItem(
                                    text = { Text("ミュート") },
                                    trailingIcon = { Switch(checked = mutedOn, onCheckedChange = null) },
                                    onClick = { bellOpen = false; scope.launch { controller.setChannelMuted(selectedChannel.id, !mutedOn) } },
                                )
                                if (mute != null) {
                                    DropdownMenuItem(text = { Text("ミュート解除 ($mute)") }, onClick = { bellOpen = false; scope.launch { controller.setChannelTimedMute(selectedChannel.id, null) } })
                                } else {
                                    DropdownMenuItem(text = { Text("8 時間ミュート") }, onClick = {
                                        bellOpen = false
                                        scope.launch { controller.setChannelTimedMute(selectedChannel.id, Instant.now().plusSeconds(8 * 3600).toString()) }
                                    })
                                }
                            }
                        }
                        // The 自分 tab is the settings page: no search or menu over it.
                        if (top != Route.You) {
                            IconButton(onClick = ::openSearch) { Icon(Icons.Default.Search, contentDescription = "検索") }
                            IconButton(onClick = { menuOpen = true }) { Icon(Icons.Default.MoreVert, contentDescription = "メニュー") }
                        }
                        DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                            // M29: the pins and files are tabs under the app bar now; the details page does not list itself.
                            if (selectedChannel != null && selectedChannel.isMember && threadId == null && !detailsOpen) {
                                val starred = store.isFavorite(selectedChannel.id)
                                DropdownMenuItem(
                                    text = { Text(if (starred) "お気に入りから外す" else "お気に入りに追加") },
                                    leadingIcon = { Icon(if (starred) Icons.Filled.Star else Icons.Outlined.StarBorder, contentDescription = null) },
                                    onClick = { menuOpen = false; scope.launch { controller.toggleFavorite(selectedChannel.id) } },
                                )
                                // M35: the level resolved with my overall setting as it is now (a change shows at once).
                                val level = NotificationLevels.resolved(selectedChannel, store.me?.notificationDefault ?: NotificationLevels.MENTIONS, store.me?.id)
                                val mute = Timeline.muteLabel(selectedChannel.channel.notification?.mutedUntil)
                                val mutedOn = NotificationLevels.mutedUntilUnmuted(selectedChannel)
                                DropdownMenuItem(
                                    text = {
                                        Text(
                                            when {
                                                mutedOn -> "通知 (ミュート中)"
                                                mute != null -> "通知 ($mute)"
                                                else -> "通知: " + NotificationLabels.shortLabel(level)
                                            },
                                        )
                                    },
                                    leadingIcon = { Icon(if (level == NotificationLevels.NONE || mutedOn || mute != null) Icons.Default.NotificationsOff else Icons.Default.Notifications, contentDescription = null) },
                                    onClick = { menuOpen = false; bellOpen = true },
                                )
                                DropdownMenuItem(
                                    text = { Text("チャンネル情報") }, leadingIcon = { Icon(Icons.Default.Info, contentDescription = null) },
                                    onClick = { menuOpen = false; openDetails() },
                                )
                                HorizontalDivider()
                            }
                            DropdownMenuItem(text = { Text("ダイレクトメッセージ") }, onClick = { menuOpen = false; dialog = MainDialog.NEW_DM })
                            DropdownMenuItem(text = { Text("メンバー") }, onClick = { menuOpen = false; dialog = MainDialog.DIRECTORY })
                            if (!controller.isGuest) {
                                DropdownMenuItem(text = { Text("チャンネルを作成") }, onClick = { menuOpen = false; dialog = MainDialog.NEW_CHANNEL })
                                DropdownMenuItem(text = { Text("チャンネルを探す") }, onClick = { menuOpen = false; dialog = MainDialog.BROWSE })
                            }
                            DropdownMenuItem(text = { Text("新しいセクション") }, onClick = { menuOpen = false; sectionForm = null to emptyList() })
                            DropdownMenuItem(text = { Text("すべて既読にする") }, onClick = { menuOpen = false; scope.launch { controller.markAllRead() } })
                            if (isChannel && selectedChannel.isMember && !selectedChannel.channel.archived) {
                                DropdownMenuItem(text = { Text("メンバーを追加") }, onClick = { menuOpen = false; dialog = MainDialog.ADD_MEMBER })
                            }
                            HorizontalDivider()
                            DropdownMenuItem(text = { Text("設定") }, onClick = { menuOpen = false; selectMainTab(MainTab.YOU) })
                            // M16c: with several workspaces, say which one this signs out of (the others stay signed in).
                            val logoutLabel = if (controller.workspaces.size > 1) "${controller.workspaceName} からログアウト" else "ログアウト"
                            DropdownMenuItem(text = { Text(logoutLabel) }, onClick = { menuOpen = false; scope.launch { controller.logout() } })
                        }
                    },
                )
            }
        },
    ) { padding ->
        // The scaffold's insets are consumed here (M28c): the panes below add `imePadding()`, which otherwise counted the
        // navigation bar a second time and left a blank band of its height between the composer and the keyboard.
        Column(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding)) {
            // M29: the tab row sits directly under the app bar of a joined conversation's timeline.
            if (selectedChannel != null && ConversationNav.tabRowShown(true, selectedChannel.isMember, threadId != null, searching, detailsOpen)) {
                ConversationTabRow(controller, selectedChannel, version, conversationTab, onTab = ::selectTab)
            }
            ConnectionBanner(status)
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
                            onLoadMore = { scope.launch { searchResults.loadMore(controller) } },
                            onLoadMoreFiles = { scope.launch { searchResults.loadMoreFiles(controller) } },
                            onRetry = { scope.launch { searchResults.retry(controller) } },
                            onOpen = { message -> openFromSearch(message.id, message.channelId, message.parentId, message) },
                            onOpenFile = { item -> openFromSearch(item.messageId, item.channelId, item.parentId) },
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
                            onScreen = MainTabs.conversationOnScreen(tabs, tabs.selected),
                            onOpenThread = ::openThread,
                        )
                        when {
                            detailsOpen -> CoveringPage { ChannelDetailsPane(controller, selectedChannel, version, onClose = { stack = MainNav.closeDetails(stack) }) }
                            // A pin or a file shows its message under 「メッセージ」 (its thread too for a reply): openConversation
                            // goes back to that tab.
                            conversationTab == ConversationTab.PINS -> CoveringPage { PinsPane(controller, selectedChannel.id, version, onOpen = ::reveal) }
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
                } else if (pane == Route.Mentions) {
                    MentionsPane(controller, version, onOpen = ::reveal)
                } else if (pane == Route.Drafts) {
                    // A draft row opens its conversation (the composer restores the text); back returns to the list.
                    DraftsPane(controller, version) { channelId, parentId ->
                        controller.messageFocus = null
                        stack = MainNav.openDraft(stack, channelId, parentId)
                    }
                } else if (pane == Route.Threads) {
                    ThreadsPane(controller, version, onOpen = { entry ->
                        controller.messageFocus = null
                        stack = MainNav.openFromThreadList(stack, entry.state.channelId, entry.parent.id)
                    })
                } else if (top == Route.DmList) {
                    DmListScreen(
                        controller, version, dmListState,
                        onOpen = { controller.messageFocus = null; openConversation(it) },
                        onNew = { dialog = MainDialog.NEW_DM },
                    )
                } else if (top is Route.Activity) {
                    // Rows push their conversation / thread on this tab's stack (back returns here).
                    ActivityScreen(
                        controller, version, top.segment,
                        onSegment = { tabs = MainTabs.selectSegment(tabs, it) },
                        mentionsState = mentionsListState,
                        threadsState = threadsListState,
                        onOpenMessage = ::reveal,
                        onOpenThread = { entry ->
                            controller.messageFocus = null
                            stack = MainNav.openFromThreadList(stack, entry.state.channelId, entry.parent.id)
                        },
                    )
                } else if (top == Route.You) {
                    YouScreen(controller, version, youScrollState)
                } else {
                    // M34: 「メンション」 moved to the activity tab; 「スレッド」 stays.
                    ChannelList(
                        store, version, listState = homeListState, unreadOnly = unreadOnly, onToggleUnreadOnly = { unreadOnly = !unreadOnly; UnreadFilter.write(controller.prefs, unreadOnly) },
                        onSelect = { controller.messageFocus = null; openConversation(it) },
                        onThreads = { stack = MainNav.open(stack, Route.Threads) },
                        onSaved = { stack = MainNav.open(stack, Route.Saved) },
                        onDrafts = { stack = MainNav.open(stack, Route.Drafts) },
                        onFiles = { stack = MainNav.open(stack, Route.Files()) },
                        onReminders = { stack = MainNav.open(stack, Route.Reminders) },
                        onBrowse = { dialog = MainDialog.BROWSE },
                        isGuest = controller.isGuest,
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
                        // Made, in the Store as mine; a failure is the app's error (openDmWith sets it).
                        openSelfNotes = { controller.store.me?.id?.let { controller.openDmWith(it) } },
                    )
                }
            }
        }
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
    /** The connection dot (26, a 30 spinner while connecting), search and ⋮ (48 + 48), the bar's end padding (4). */
    private const val END = 30f + 96f + 4f
    /** The FilterChip around its label (paddings 8 + 8 + 16 and the 16 bell) and its end padding (4). */
    private const val CHIP = 48f + 4f

    fun followLabelFits(barWidth: Float, title: Float, label: Float): Boolean = barWidth - START - END - CHIP - label >= title
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
private fun TwoLineTitle(title: String, subtitle: String?) {
    Column {
        Text(title, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (subtitle != null) Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
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
        EngineStatus.CONNECTING -> "サーバに接続しています…" to MaterialTheme.colorScheme.primaryContainer
        EngineStatus.OFFLINE -> "オフラインです。再接続を待っています…" to MaterialTheme.colorScheme.errorContainer
        else -> return
    }
    Text(text, style = MaterialTheme.typography.labelMedium, modifier = Modifier.fillMaxWidth().background(color).padding(horizontal = 16.dp, vertical = 4.dp))
}

private const val BANNER_GRACE_MS = 2_000L

@Composable
private fun ChannelList(
    store: Store,
    version: Int,
    /** M34: the home tab keeps its scroll position (and a re-tap of the tab scrolls it up). */
    listState: LazyListState,
    unreadOnly: Boolean,
    onToggleUnreadOnly: () -> Unit,
    /** Opens a conversation; one under 「参加できるチャンネル」 opens as a preview (M27, SYNC_PROTOCOL.md §7.6.1). */
    onSelect: (String) -> Unit,
    onThreads: () -> Unit,
    onSaved: () -> Unit,
    onDrafts: () -> Unit,
    onBrowse: () -> Unit,
    isGuest: Boolean = false,
    onFiles: () -> Unit,
    onReminders: () -> Unit,
    /** M24: make (or open) my times. */
    onCreateTimes: () -> Unit = {},
    /** M14f: long-press on a conversation, and the 「…」 of one of my sections. */
    onChannelMenu: (String) -> Unit = {},
    onSectionMenu: (jp.chikuwachat.android.api.SidebarSectionOut, Int) -> Unit = { _, _ -> },
    /** M26: the default sections folded on this device (FoldedSections), and folding them. */
    folded: Set<String> = emptySet(),
    onToggleFolded: (String) -> Unit = {},
    /** M26: folding one of my sections (on all my devices), and drawing its icon. */
    onToggleSection: (jp.chikuwachat.android.api.SidebarSectionOut) -> Unit = {},
    sectionIcon: @Composable (String?) -> Unit = {},
    /** Makes my own DM (POST /dms with only me) and returns its id; null on a failure, which it reports itself. */
    openSelfNotes: suspend () -> String? = { null },
) {
    val meId = store.me?.id
    val sections = remember(version, unreadOnly, meId) {
        Channels.sections(store.channels.values, unreadOnly = unreadOnly, favorites = store.favorites, sidebar = store.sidebarSections, meId = meId)
    }
    // My own DM is always the first DM (Channels.sections); until it exists, a placeholder row with my picture and name
    // stands there, not while the section is folded or only unread conversations are listed.
    val myName = remember(version, meId) { myDisplayName(store) }
    val selfPlaceholder = remember(version, meId, unreadOnly, folded) {
        MainTabs.showsSelfNotesInDmSection(store.channels.values, meId, myName, collapsed = FoldedSections.DMS in folded, unreadOnly = unreadOnly)
    }
    val scope = rememberCoroutineScope()
    var creatingSelf by remember { mutableStateOf(false) }
    val onSelfPlaceholder: () -> Unit = {
        // One request at a time: a second tap while it runs does nothing.
        if (!creatingSelf) {
            creatingSelf = true
            scope.launch { try { openSelfNotes()?.let(onSelect) } finally { creatingSelf = false } }
        }
    }
    val draftCount = remember(version) { store.listDrafts().size + store.scheduled.size }
    // M24: offer to make my times until I have one (joined or not: a times I left is in 「参加できるチャンネル」).
    val canCreateTimes = remember(version, isGuest, meId) { !isGuest && meId != null && store.channels.values.none { it.channel.timesOwnerId == meId } }
    val channels = sections.channels
    val dms = sections.dms
    val browsable = sections.browse

    LazyColumn(Modifier.fillMaxSize(), state = listState) {
        item {
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                FilterChip(selected = unreadOnly, onClick = onToggleUnreadOnly, label = { Text("未読のみ") })
            }
        }
        item { ThreadsRow(store, version, onClick = onThreads) }
        if (draftCount > 0) item { ListRow(Icons.Default.Description, "下書き", trailing = draftCount.toString(), onClick = onDrafts) }
        val reminderCount = store.reminders.size
        val firedCount = store.firedReminderCount()
        if (reminderCount > 0) item { ListRow(Icons.Default.Alarm, "リマインダー", trailing = if (firedCount > 0) "$firedCount 件" else reminderCount.toString(), onClick = onReminders) }
        item { ListRow(Icons.Outlined.Folder, "ファイル", onClick = onFiles) }
        item { SavedRow(store, version, onClick = onSaved) }
        // M26: a folded section keeps its unread rows (Channels.shown); its hints and actions go.
        if (sections.favorites.isNotEmpty()) {
            val fold = FoldedSections.FAVORITES in folded
            item(key = "header:favorites") { Box(Modifier.folding(this)) { SectionHeader("お気に入り", fold) { onToggleFolded(FoldedSections.FAVORITES) } } }
            items(Channels.shown(sections.favorites, fold, meId), key = { "fav:" + it.id }) { ChannelRow(it, store, version, onClick = { onSelect(it.id) }, onLongClick = { onChannelMenu(it.id) }, modifier = Modifier.folding(this)) }
        }
        sections.custom.forEachIndexed { index, (section, members) ->
            item(key = "section:" + section.id) {
                // Every row of the sidebar slides into place when a section above it folds (testers, 2026-09-29).
                Box(Modifier.folding(this)) {
                    CustomSectionHeader(section.name, section.collapsed, icon = { sectionIcon(section.emoji) }, onToggle = { onToggleSection(section) }, onMenu = { onSectionMenu(section, index) })
                }
            }
            items(Channels.shown(members, section.collapsed, meId), key = { "sec:" + section.id + ":" + it.id }) { ChannelRow(it, store, version, onClick = { onSelect(it.id) }, onLongClick = { onChannelMenu(it.id) }, modifier = Modifier.folding(this)) }
            if (members.isEmpty() && !unreadOnly && !section.collapsed) item(key = "section-empty:" + section.id) { Box(Modifier.folding(this)) { EmptyHint("会話を長押し →「セクションに移動」で追加できます") } }
        }
        val channelsFolded = FoldedSections.CHANNELS in folded
        item(key = "header:channels") { Box(Modifier.folding(this)) { SectionHeader("チャンネル", channelsFolded) { onToggleFolded(FoldedSections.CHANNELS) } } }
        items(Channels.shown(channels, channelsFolded, meId), key = { it.id }) { ChannelRow(it, store, version, onClick = { onSelect(it.id) }, onLongClick = { onChannelMenu(it.id) }, modifier = Modifier.folding(this)) }
        if (!channelsFolded) {
            if (channels.isEmpty()) item(key = "channels-empty") { Box(Modifier.folding(this)) { EmptyHint(if (unreadOnly) "未読のチャンネルはありません" else "参加中のチャンネルはありません。メニューから作成できます。") } }
            if (!unreadOnly && !isGuest) item(key = "channels-browse") { Box(Modifier.folding(this)) { ListRow(Icons.Default.Explore, "チャンネルを探す", onClick = onBrowse) } }
        }
        // M24: everyone's work logs, after the channels; someone else's are quiet unread (SYNC_PROTOCOL.md §10.5).
        val offerTimes = canCreateTimes && !unreadOnly
        if (sections.times.isNotEmpty() || offerTimes) {
            val timesFolded = FoldedSections.TIMES in folded
            item(key = "header:times") { Box(Modifier.folding(this)) { SectionHeader("Times", timesFolded) { onToggleFolded(FoldedSections.TIMES) } } }
            items(Channels.shown(sections.times, timesFolded, meId), key = { "times:" + it.id }) { ChannelRow(it, store, version, onClick = { onSelect(it.id) }, onLongClick = { onChannelMenu(it.id) }, modifier = Modifier.folding(this)) }
            if (offerTimes && !timesFolded) item(key = "times-create") { Box(Modifier.folding(this)) { ListRow(Icons.Default.Add, "自分の times を作る", onClick = onCreateTimes) } }
        }
        val dmsFolded = FoldedSections.DMS in folded
        item(key = "header:dms") { Box(Modifier.folding(this)) { SectionHeader("ダイレクトメッセージ", dmsFolded) { onToggleFolded(FoldedSections.DMS) } } }
        if (selfPlaceholder && meId != null) {
            item(key = "dms-self-placeholder") { HomeSelfNotesRow(meId, myName, busy = creatingSelf, onClick = onSelfPlaceholder, modifier = Modifier.folding(this)) }
        }
        items(Channels.shown(dms, dmsFolded, meId), key = { it.id }) { ChannelRow(it, store, version, onClick = { onSelect(it.id) }, onLongClick = { onChannelMenu(it.id) }, modifier = Modifier.folding(this)) }
        if (dms.isEmpty() && !dmsFolded && !selfPlaceholder) item(key = "dms-empty") { Box(Modifier.folding(this)) { EmptyHint(if (unreadOnly) "未読の DM はありません" else "メニューの「ダイレクトメッセージ」から相手を選べます") } }
        if (browsable.isNotEmpty()) {
            item(key = "header:browse") { Box(Modifier.folding(this)) { SectionHeader("参加できるチャンネル") } }
            // M27: a tap reads the channel first (§7.6.1); joining is the button at the bottom of its preview.
            items(browsable, key = { "browse:" + it.id }) { channel ->
                Row(Modifier.folding(this).fillMaxWidth().clickable(onClickLabel = "プレビュー") { onSelect(channel.id) }.padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                    ChannelGlyph(channel)
                    Spacer(Modifier.width(12.dp))
                    Text(channel.channel.name ?: "", modifier = Modifier.weight(1f))
                }
            }
        }
        item { Spacer(Modifier.padding(bottom = 24.dp)) }
    }
}

/**
 * A sidebar row appearing, leaving or moving as a section folds (testers, 2026-09-29: it opened and closed at once):
 * leaving rows fade before the rows below slide over them.
 */
private fun Modifier.folding(scope: LazyItemScope): Modifier =
    with(scope) { this@folding.animateItem(fadeInSpec = tween(220), placementSpec = tween(260), fadeOutSpec = tween(120)) }

/**
 * 「スレッド」 (THREADS.md §5): followed threads with unread replies; red when one mentions me.
 * `version`: the summary lives in the Store, so without it strong skipping would keep the first badge.
 */
@Composable
private fun ThreadsRow(store: Store, version: Int, onClick: () -> Unit) {
    val summary = remember(version) { store.threadSummary }
    val unread = summary.unreadCount > 0
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier.size(36.dp).background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(9.dp)),
            contentAlignment = Alignment.Center,
        ) {
            Icon(Icons.Default.Forum, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(18.dp))
        }
        Spacer(Modifier.width(12.dp))
        Text("スレッド", fontWeight = if (unread) FontWeight.Bold else FontWeight.Normal, modifier = Modifier.weight(1f))
        if (unread) {
            Text(
                summary.unreadCount.toString(),
                color = MaterialTheme.colorScheme.onPrimary,
                style = MaterialTheme.typography.labelSmall,
                modifier = Modifier
                    .background(if (summary.mentionCount > 0) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary, CircleShape)
                    .padding(horizontal = 7.dp, vertical = 2.dp),
            )
        }
    }
}

/** A plain sidebar entry (M11h: 「メンション」, 「下書き」, 「チャンネルを探す」). */
@Composable
private fun ListRow(icon: ImageVector, label: String, trailing: String? = null, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier.size(36.dp).background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(9.dp)),
            contentAlignment = Alignment.Center,
        ) {
            Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(18.dp))
        }
        Spacer(Modifier.width(12.dp))
        Text(label, modifier = Modifier.weight(1f))
        if (trailing != null) Text(trailing, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** 「保存済み」 (M11c): my bookmarked messages (`version` keeps the count current). */
@Composable
private fun SavedRow(store: Store, version: Int, onClick: () -> Unit) {
    val saved = remember(version) { store.bookmarks.size }
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier.size(36.dp).background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(9.dp)),
            contentAlignment = Alignment.Center,
        ) {
            Icon(Icons.Default.Bookmark, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(18.dp))
        }
        Spacer(Modifier.width(12.dp))
        Text("保存済み", modifier = Modifier.weight(1f))
        if (saved > 0) Text(saved.toString(), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** A custom section's title with its icon and 「…」 (M14f); M26: tapping the title folds it on all my devices. */
@Composable
private fun CustomSectionHeader(title: String, collapsed: Boolean, icon: @Composable () -> Unit, onToggle: () -> Unit, onMenu: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Row(Modifier.weight(1f).foldable(collapsed, onToggle).padding(start = 12.dp, top = 12.dp, bottom = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            FoldChevron(collapsed)
            Spacer(Modifier.width(4.dp))
            icon()
            Text(title, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 4.dp))
        }
        IconButton(onClick = onMenu) { Icon(Icons.Default.MoreHoriz, contentDescription = "$title のメニュー") }
    }
}

/** A default section's title; M26: tapping it folds it on this device. */
@Composable
private fun SectionHeader(title: String, collapsed: Boolean, onToggle: () -> Unit) {
    Row(Modifier.fillMaxWidth().foldable(collapsed, onToggle).padding(start = 12.dp, end = 16.dp, top = 12.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        FoldChevron(collapsed)
        Text(title, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 4.dp))
    }
}

@Composable
private fun SectionHeader(title: String) {
    Text(title, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 16.dp, top = 16.dp, bottom = 4.dp))
}

/** A section header that folds: TalkBack reads 「折りたたみ中」 / 「展開中」 and offers the action by name. */
private fun Modifier.foldable(collapsed: Boolean, onToggle: () -> Unit): Modifier =
    clickable(onClickLabel = if (collapsed) "開く" else "折りたたむ", onClick = onToggle).semantics { stateDescription = if (collapsed) "折りたたみ中" else "展開中" }

@Composable
private fun FoldChevron(collapsed: Boolean) {
    val angle by animateFloatAsState(if (collapsed) -90f else 0f, label = "fold")
    Icon(Icons.Default.ExpandMore, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(18.dp).rotate(angle))
}

@Composable
private fun EmptyHint(text: String) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
}

/** "#" / "🔒" glyph for a channel, coloured like an avatar so lists have a consistent left rail. */
@Composable
private fun ChannelGlyph(channel: ChannelState) {
    Box(
        Modifier.size(36.dp).background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(9.dp)),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            if (channel.channel.type == "private") Icons.Default.Lock else Icons.Default.Tag,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(18.dp),
        )
    }
}

/** `version`: the partner's name, presence dot and status emoji come from the Store, not from `channel`. */
@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
private fun ChannelRow(channel: ChannelState, store: Store, version: Int, onClick: () -> Unit, modifier: Modifier = Modifier, onLongClick: (() -> Unit)? = null) {
    val title = remember(version, channel) { channelTitle(channel, store).let { if (channel.channel.isDm) it else it.removePrefix("#") } }
    val muted = Channels.isMuted(channel)
    val unread = Channels.hasUnread(channel, store.me?.id)
    // M24: someone else's times with new posts but no mention: not bold, a faint dot (SYNC_PROTOCOL.md §10.5).
    val quietDot = Channels.showsQuietDot(channel, store.me?.id)
    val badge = Channels.badgeCount(channel)
    Row(
        modifier.fillMaxWidth().combinedClickable(onClick = onClick, onLongClick = onLongClick).padding(horizontal = 16.dp, vertical = 8.dp).alpha(if (muted && !unread) 0.6f else 1f),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (channel.channel.isDm) {
            val other = (channel.channel.dmUserIds ?: emptyList()).firstOrNull { it != store.me?.id } ?: store.me?.id ?: channel.id
            Avatar(other, store.users[other]?.displayName ?: title, size = 36.dp, presence = store.presenceOf(other))
        } else {
            ChannelGlyph(channel)
        }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(title, fontWeight = if (unread) FontWeight.Bold else FontWeight.Normal, maxLines = 1, overflow = TextOverflow.Ellipsis)
            val subtitle = channel.channel.topic?.takeIf { it.isNotBlank() && !channel.channel.isDm }
            if (subtitle != null) Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (channel.channel.isDm) {
            val other = (channel.channel.dmUserIds ?: emptyList()).firstOrNull { it != store.me?.id }
            if (other != null) StatusEmoji(store.users[other], modifier = Modifier.padding(end = 6.dp))
        }
        if (muted) Icon(Icons.Default.NotificationsOff, contentDescription = "通知オフ", tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(end = 6.dp).size(14.dp))
        if (unread && badge > 0) {
            Text(
                badge.toString(),
                color = MaterialTheme.colorScheme.onPrimary,
                style = MaterialTheme.typography.labelSmall,
                modifier = Modifier.background(MaterialTheme.colorScheme.primary, CircleShape).padding(horizontal = 7.dp, vertical = 2.dp),
            )
        } else if (unread) {
            Box(Modifier.size(8.dp).background(MaterialTheme.colorScheme.primary, CircleShape))
        } else if (quietDot) {
            Box(Modifier.size(6.dp).background(MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.4f), CircleShape))
        }
    }
}

/** My own DM before it exists, in the home list: my picture and my name, like a DM row; disabled while the tap's request runs. */
@Composable
private fun HomeSelfNotesRow(meId: String, name: String, busy: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Row(
        modifier.fillMaxWidth().clickable(enabled = !busy, onClick = onClick).padding(horizontal = 16.dp, vertical = 8.dp).alpha(if (busy) 0.6f else 1f),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Avatar(meId, name, size = 36.dp)
        Spacer(Modifier.width(12.dp))
        Text(name, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
    }
}

/** The connection dot in the app bar; M28c: TalkBack reads the state it shows (the dot said nothing). */
@Composable
fun StatusBadge(status: EngineStatus) {
    val label = when (status) {
        EngineStatus.ONLINE -> "サーバに接続中"
        EngineStatus.CONNECTING -> "サーバに接続しています"
        EngineStatus.OFFLINE -> "オフライン"
        else -> null
    }
    val described = if (label == null) Modifier else Modifier.semantics { contentDescription = label }
    when (status) {
        EngineStatus.ONLINE -> Box(described.padding(8.dp).size(10.dp).background(Color(0xFF34C759), CircleShape))
        EngineStatus.CONNECTING -> CircularProgressIndicator(described.padding(8.dp).size(14.dp), strokeWidth = 2.dp)
        EngineStatus.OFFLINE -> Box(described.padding(8.dp).size(10.dp).background(Color(0xFFFF9500), CircleShape))
        else -> Spacer(Modifier.width(0.dp))
    }
}

/** 1:1 DM: the other person's presence (SYNC_PROTOCOL.md §5.2) as the app bar subtitle. */
private fun dmPresenceSubtitle(channel: ChannelState, store: Store): String? {
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
