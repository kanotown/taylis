package jp.chikuwachat.android.ui

import androidx.compose.material.icons.filled.Alarm
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material.icons.filled.Tag
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.NotificationsOff
import androidx.compose.material.icons.filled.NotificationsNone
import androidx.compose.material.icons.filled.Forum
import androidx.compose.material.icons.filled.Bookmark
import androidx.compose.material.icons.filled.AlternateEmail
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.Explore
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.filled.Star
import androidx.compose.material.icons.outlined.StarBorder
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.material.icons.filled.PushPin
import androidx.compose.material.icons.outlined.PushPin
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.FilterChip
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.sync.ChannelState
import jp.chikuwachat.android.sync.EngineStatus
import jp.chikuwachat.android.sync.Store
import kotlinx.coroutines.launch
import java.time.Instant

enum class MainDialog { NEW_DM, NEW_CHANNEL, ADD_MEMBER, CHANNEL_INFO, SETTINGS, BROWSE, DIRECTORY }

/** Channel list first; a selected channel opens as its own page (compact-width layout, like the iOS app). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MainScreen(controller: AppController) {
    val store = controller.store
    val version by store.version.collectAsState()
    val status = controller.engineStatus
    var selection by rememberSaveable { mutableStateOf<String?>(null) }
    var threadId by rememberSaveable { mutableStateOf<String?>(null) }
    var searching by rememberSaveable { mutableStateOf(false) }
    var dialog by remember { mutableStateOf<MainDialog?>(null) }
    var menuOpen by remember { mutableStateOf(false) }
    var bellOpen by remember { mutableStateOf(false) }
    var unreadOnly by rememberSaveable { mutableStateOf(false) }
    // THREADS.md §5: the followed-threads list replaces the channel list; a row opens its thread with the list behind it.
    var showThreads by rememberSaveable { mutableStateOf(false) }
    var threadFromList by rememberSaveable { mutableStateOf(false) }
    // M11c: 「保存済み」 replaces the channel list; the pins pane replaces the open channel's timeline.
    var showSaved by rememberSaveable { mutableStateOf(false) }
    var pinsOpen by rememberSaveable { mutableStateOf(false) }
    // M11h: 「メンション」 and 「下書き」 replace the channel list the same way.
    var showMentions by rememberSaveable { mutableStateOf(false) }
    var showDrafts by rememberSaveable { mutableStateOf(false) }
    // M11i: 「ファイル」 replaces the list (all channels) or the open channel's timeline (that channel only).
    var showFiles by rememberSaveable { mutableStateOf(false) }
    var filesChannelId by rememberSaveable { mutableStateOf<String?>(null) }
    var showReminders by rememberSaveable { mutableStateOf(false) }
    val listReplaced = showThreads || showSaved || showMentions || showDrafts || showFiles || showReminders
    val closeLists = { showThreads = false; showSaved = false; showMentions = false; showDrafts = false; showFiles = false; showReminders = false }
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()

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
    // A tapped notification opens its channel once the store knows it (after bootstrap / catch_up).
    LaunchedEffect(controller.pendingChannelId, version) {
        val id = controller.pendingChannelId ?: return@LaunchedEffect
        if (store.channel(id) != null) {
            selection = id
            controller.pendingChannelId = null
        }
    }
    LaunchedEffect(selection) {
        selection?.let { controller.openChannel(it) } ?: controller.closeChannel()
    }
    // A channel we were removed from (or that vanished) closes.
    if (selection != null && store.channel(selection!!) == null) selection = null

    val selectedChannel = selection?.let { store.channel(it) }
    if (selectedChannel == null) threadId = null
    val closeThread: () -> Unit = {
        threadId = null
        if (threadFromList) { threadFromList = false; selection = null } // back to the threads list
    }
    BackHandler(enabled = searching) { searching = false }
    BackHandler(enabled = !searching && pinsOpen && selectedChannel != null) { pinsOpen = false }
    BackHandler(enabled = !searching && !pinsOpen && showFiles && selectedChannel != null) { showFiles = false }
    BackHandler(enabled = !searching && !pinsOpen && threadId != null) { closeThread() }
    BackHandler(enabled = threadId == null && !pinsOpen && selectedChannel != null) { selection = null }
    BackHandler(enabled = !searching && selectedChannel == null && listReplaced) { closeLists() }
    /** A card in the pins pane / saved list: show the message in its conversation. */
    fun reveal(message: jp.chikuwachat.android.api.MessageOut) {
        scope.launch {
            if (controller.revealMessage(message)) {
                pinsOpen = false
                showSaved = false
                showMentions = false
                showFiles = false
                threadFromList = false
                selection = message.channelId
                threadId = message.parentId
            }
        }
    }

    val me = store.me
    val isChannel = selectedChannel != null && !selectedChannel.channel.isDm

    // A permalink tapped in a body (M12b): the controller fetched the message; show it in its conversation.
    LaunchedEffect(controller.pendingReveal) {
        val message = controller.pendingReveal ?: return@LaunchedEffect
        controller.pendingReveal = null
        pinsOpen = false
        showFiles = false
        threadFromList = false
        selection = message.channelId
        threadId = message.parentId
    }
    Scaffold(
        snackbarHost = { SnackbarHost(snackbar) },
        topBar = {
            TopAppBar(
                title = {
                    when {
                        searching -> Text("検索")
                        pinsOpen && selectedChannel != null -> TwoLineTitle("ピン留め", channelTitle(selectedChannel, store))
                        threadId != null -> TwoLineTitle("スレッド", selectedChannel?.let { channelTitle(it, store) })
                        selectedChannel != null -> Column(Modifier.clickable { dialog = MainDialog.CHANNEL_INFO }) {
                            TwoLineTitle(
                                channelTitle(selectedChannel, store),
                                selectedChannel.channel.topic?.takeIf { it.isNotBlank() } ?: if (isChannel) "トピックを設定" else dmPresenceSubtitle(selectedChannel, store),
                            )
                        }
                        showThreads -> Text("スレッド")
                        showSaved -> Text("保存済み")
                        showMentions -> Text("メンション")
                        showDrafts -> Text("下書き")
                        showFiles -> Text("ファイル")
                        showReminders -> Text("リマインダー")
                        else -> Text("ChikuwaChat")
                    }
                },
                navigationIcon = {
                    when {
                        searching -> IconButton(onClick = { searching = false }) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "戻る") }
                        selectedChannel != null -> IconButton(onClick = { if (pinsOpen) pinsOpen = false else if (showFiles) showFiles = false else if (threadId != null) closeThread() else selection = null }) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "戻る")
                        }
                        listReplaced -> IconButton(onClick = closeLists) { Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "戻る") }
                        me != null -> IconButton(onClick = { dialog = MainDialog.SETTINGS }) { Avatar(me.id, me.displayName, size = 32.dp) }
                    }
                },
                actions = {
                    StatusBadge(status)
                    // THREADS.md §5: follow / unfollow the open thread.
                    val openId = threadId
                    val threadState = openId?.let { store.threads[it]?.state }
                    if (openId != null && threadState != null && selectedChannel?.isMember == true && !searching) {
                        FilterChip(
                            selected = threadState.following,
                            onClick = { scope.launch { controller.engine?.setThreadFollow(openId, !threadState.following) } },
                            label = { Text(if (threadState.following) "フォロー中" else "フォロー") },
                            leadingIcon = {
                                Icon(
                                    if (threadState.following) Icons.Default.Notifications else Icons.Default.NotificationsNone,
                                    contentDescription = null,
                                    modifier = Modifier.size(16.dp),
                                )
                            },
                            modifier = Modifier.padding(end = 4.dp),
                        )
                    }
                    if (selectedChannel != null && selectedChannel.isMember && threadId == null && !searching) {
                        val starred = store.isFavorite(selectedChannel.id)
                        IconButton(onClick = { scope.launch { controller.toggleFavorite(selectedChannel.id) } }) {
                            Icon(if (starred) Icons.Filled.Star else Icons.Outlined.StarBorder, contentDescription = if (starred) "お気に入りから外す" else "お気に入りに追加",
                                 tint = if (starred) MaterialTheme.colorScheme.tertiary else LocalContentColor.current)
                        }
                        IconButton(onClick = { pinsOpen = !pinsOpen }) {
                            Icon(if (pinsOpen) Icons.Filled.PushPin else Icons.Outlined.PushPin, contentDescription = "ピン留め")
                        }
                        IconButton(onClick = { filesChannelId = selectedChannel.id; showFiles = !showFiles; pinsOpen = false }) {
                            Icon(if (showFiles) Icons.Filled.Folder else Icons.Outlined.Folder, contentDescription = "ファイル")
                        }
                        val level = selectedChannel.channel.notification?.level ?: if (selectedChannel.channel.isDm) "all" else "mentions"
                        val mute = Timeline.muteLabel(selectedChannel.channel.notification?.mutedUntil)
                        IconButton(onClick = { bellOpen = true }) {
                            Icon(if (level == "none" || mute != null) Icons.Default.NotificationsOff else Icons.Default.Notifications, contentDescription = "通知設定")
                        }
                        DropdownMenu(expanded = bellOpen, onDismissRequest = { bellOpen = false }) {
                            listOf("all" to "すべてのメッセージ", "mentions" to "メンションのみ", "none" to "通知しない").forEach { (value, label) ->
                                DropdownMenuItem(
                                    text = { Text((if (level == value) "✓ " else "    ") + label) },
                                    onClick = { bellOpen = false; scope.launch { controller.setNotification(selectedChannel.id, value, null) } },
                                )
                            }
                            HorizontalDivider()
                            if (mute != null) {
                                DropdownMenuItem(text = { Text("ミュート解除 ($mute)") }, onClick = { bellOpen = false; scope.launch { controller.setNotification(selectedChannel.id, level, null) } })
                            } else {
                                DropdownMenuItem(text = { Text("8 時間ミュート") }, onClick = {
                                    bellOpen = false
                                    scope.launch { controller.setNotification(selectedChannel.id, level, Instant.now().plusSeconds(8 * 3600).toString()) }
                                })
                            }
                        }
                        IconButton(onClick = { dialog = MainDialog.CHANNEL_INFO }) { Icon(Icons.Default.Info, contentDescription = "チャンネル情報") }
                    }
                    if (!searching) IconButton(onClick = { searching = true }) { Icon(Icons.Default.Search, contentDescription = "検索") }
                    IconButton(onClick = { menuOpen = true }) { Icon(Icons.Default.MoreVert, contentDescription = "メニュー") }
                    DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                        DropdownMenuItem(text = { Text("ダイレクトメッセージ") }, onClick = { menuOpen = false; dialog = MainDialog.NEW_DM })
                        DropdownMenuItem(text = { Text("メンバー") }, onClick = { menuOpen = false; dialog = MainDialog.DIRECTORY })
                        if (!controller.isGuest) {
                            DropdownMenuItem(text = { Text("チャンネルを作成") }, onClick = { menuOpen = false; dialog = MainDialog.NEW_CHANNEL })
                            DropdownMenuItem(text = { Text("チャンネルを探す") }, onClick = { menuOpen = false; dialog = MainDialog.BROWSE })
                        }
                        DropdownMenuItem(text = { Text("すべて既読にする") }, onClick = { menuOpen = false; scope.launch { controller.markAllRead() } })
                        if (isChannel && selectedChannel!!.isMember && !selectedChannel.channel.archived) {
                            DropdownMenuItem(text = { Text("メンバーを追加") }, onClick = { menuOpen = false; dialog = MainDialog.ADD_MEMBER })
                        }
                        HorizontalDivider()
                        DropdownMenuItem(text = { Text("設定") }, onClick = { menuOpen = false; dialog = MainDialog.SETTINGS })
                        DropdownMenuItem(text = { Text("ログアウト") }, onClick = { menuOpen = false; scope.launch { controller.logout() } })
                    }
                },
            )
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            ConnectionBanner(status)
            val openThread = threadId
            Box(Modifier.weight(1f).fillMaxWidth()) {
                if (searching) {
                    SearchPane(controller) { message ->
                        scope.launch {
                            if (controller.revealMessage(message)) {
                                selection = message.channelId
                                threadId = message.parentId
                                searching = false
                            }
                        }
                    }
                } else if (selectedChannel != null && pinsOpen) {
                    PinsPane(controller, selectedChannel.id, version, onOpen = ::reveal)
                } else if (showFiles) {
                    FilesPane(controller, version, channelId = filesChannelId, onScopeChange = { filesChannelId = it }) { messageId, channelId, parentId ->
                        scope.launch {
                            if (controller.revealMessage(messageId, channelId, parentId)) {
                                showFiles = false
                                threadFromList = false
                                selection = channelId
                                threadId = parentId
                            }
                        }
                    }
                } else if (selectedChannel != null && openThread != null) {
                    ThreadPane(controller, selectedChannel.id, openThread, version)
                } else if (showSaved) {
                    SavedPane(controller, version, onOpen = ::reveal)
                } else if (selectedChannel != null) {
                    ChannelPane(controller, selectedChannel.id, version, onOpenThread = { threadId = it })
                } else if (showReminders) {
                    RemindersPane(controller, version) { row -> scope.launch { controller.openPermalink(row.messageId) } }
                } else if (showMentions) {
                    MentionsPane(controller, version, onOpen = ::reveal)
                } else if (showDrafts) {
                    // A draft row opens its conversation (the composer restores the text); back returns to the list.
                    DraftsPane(controller, version) { channelId, parentId ->
                        controller.messageFocus = null
                        threadFromList = false
                        showDrafts = false
                        selection = channelId
                        threadId = parentId
                    }
                } else if (showThreads) {
                    ThreadsPane(controller, version) { entry ->
                        controller.messageFocus = null
                        threadFromList = true
                        selection = entry.state.channelId
                        threadId = entry.parent.id
                    }
                } else {
                    ChannelList(
                        store, version, unreadOnly = unreadOnly, onToggleUnreadOnly = { unreadOnly = !unreadOnly },
                        onSelect = { controller.messageFocus = null; threadFromList = false; selection = it },
                        onJoin = { id -> scope.launch { if (controller.joinChannel(id)) selection = id } },
                        onThreads = { showThreads = true },
                        onSaved = { showSaved = true },
                        onMentions = { showMentions = true },
                        onDrafts = { showDrafts = true },
                        onFiles = { filesChannelId = null; showFiles = true },
                        onReminders = { showReminders = true },
                        onBrowse = { dialog = MainDialog.BROWSE },
                        isGuest = controller.isGuest,
                    )
                }
            }
        }
    }

    when (dialog) {
        MainDialog.NEW_DM -> NewDmDialog(controller, onDismiss = { dialog = null }, onOpened = { selection = it })
        MainDialog.DIRECTORY -> DirectoryDialog(controller, onDismiss = { dialog = null }, onOpened = { selection = it })
        MainDialog.NEW_CHANNEL -> NewChannelDialog(controller, onDismiss = { dialog = null }, onOpened = { selection = it })
        MainDialog.ADD_MEMBER -> selectedChannel?.let { AddMemberDialog(controller, it.id, onDismiss = { dialog = null }) }
        MainDialog.CHANNEL_INFO -> selectedChannel?.let { ChannelInfoDialog(controller, it, onDismiss = { dialog = null }, onAddMember = { dialog = MainDialog.ADD_MEMBER }) }
        MainDialog.SETTINGS -> SettingsDialog(controller, onDismiss = { dialog = null })
        MainDialog.BROWSE -> ChannelBrowserDialog(
            controller, version, onDismiss = { dialog = null },
            onOpen = { controller.messageFocus = null; threadFromList = false; selection = it },
            onCreate = { dialog = MainDialog.NEW_CHANNEL },
        )
        null -> Unit
    }
}

@Composable
private fun TwoLineTitle(title: String, subtitle: String?) {
    Column {
        Text(title, style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
        if (subtitle != null) Text(subtitle, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** Thin strip under the app bar while the socket is not live; nothing when online. */
@Composable
fun ConnectionBanner(status: EngineStatus) {
    val (text, color) = when (status) {
        EngineStatus.CONNECTING -> "サーバに接続しています…" to MaterialTheme.colorScheme.primaryContainer
        EngineStatus.OFFLINE -> "オフラインです。再接続を待っています…" to MaterialTheme.colorScheme.errorContainer
        else -> return
    }
    Text(text, style = MaterialTheme.typography.labelMedium, modifier = Modifier.fillMaxWidth().background(color).padding(horizontal = 16.dp, vertical = 4.dp))
}

@Composable
private fun ChannelList(
    store: Store,
    version: Int,
    unreadOnly: Boolean,
    onToggleUnreadOnly: () -> Unit,
    onSelect: (String) -> Unit,
    onJoin: (String) -> Unit,
    onThreads: () -> Unit,
    onSaved: () -> Unit,
    onMentions: () -> Unit,
    onDrafts: () -> Unit,
    onBrowse: () -> Unit,
    isGuest: Boolean = false,
    onFiles: () -> Unit,
    onReminders: () -> Unit,
) {
    val sections = remember(version, unreadOnly) { Channels.sections(store.channels.values, unreadOnly = unreadOnly, favorites = store.favorites) }
    val draftCount = remember(version) { store.listDrafts().size + store.scheduled.size }
    val channels = sections.channels
    val dms = sections.dms
    val browsable = sections.browse

    LazyColumn(Modifier.fillMaxSize()) {
        item {
            Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                FilterChip(selected = unreadOnly, onClick = onToggleUnreadOnly, label = { Text("未読のみ") })
            }
        }
        item { ThreadsRow(store, onClick = onThreads) }
        item { ListRow(Icons.Default.AlternateEmail, "メンション", onClick = onMentions) }
        if (draftCount > 0) item { ListRow(Icons.Default.Description, "下書き", trailing = draftCount.toString(), onClick = onDrafts) }
        val reminderCount = store.reminders.size
        val firedCount = store.firedReminderCount()
        if (reminderCount > 0) item { ListRow(Icons.Default.Alarm, "リマインダー", trailing = if (firedCount > 0) "$firedCount 件" else reminderCount.toString(), onClick = onReminders) }
        item { ListRow(Icons.Outlined.Folder, "ファイル", onClick = onFiles) }
        item { SavedRow(store, onClick = onSaved) }
        if (sections.favorites.isNotEmpty()) {
            item { SectionHeader("お気に入り") }
            items(sections.favorites, key = { "fav:" + it.id }) { ChannelRow(it, store, onClick = { onSelect(it.id) }) }
        }
        item { SectionHeader("チャンネル") }
        items(channels, key = { it.id }) { ChannelRow(it, store, onClick = { onSelect(it.id) }) }
        if (channels.isEmpty()) item { EmptyHint(if (unreadOnly) "未読のチャンネルはありません" else "参加中のチャンネルはありません。メニューから作成できます。") }
        if (!unreadOnly && !isGuest) item { ListRow(Icons.Default.Explore, "チャンネルを探す", onClick = onBrowse) }
        item { SectionHeader("ダイレクトメッセージ") }
        items(dms, key = { it.id }) { ChannelRow(it, store, onClick = { onSelect(it.id) }) }
        if (dms.isEmpty()) item { EmptyHint(if (unreadOnly) "未読の DM はありません" else "メニューの「ダイレクトメッセージ」から相手を選べます") }
        if (browsable.isNotEmpty()) {
            item { SectionHeader("参加できるチャンネル") }
            items(browsable, key = { "browse:" + it.id }) { channel ->
                Row(Modifier.fillMaxWidth().clickable { onJoin(channel.id) }.padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                    ChannelGlyph(channel)
                    Spacer(Modifier.width(12.dp))
                    Text(channel.channel.name ?: "", modifier = Modifier.weight(1f))
                    Text("参加", color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelLarge)
                }
            }
        }
        item { Spacer(Modifier.padding(bottom = 24.dp)) }
    }
}

/** 「スレッド」 (THREADS.md §5): followed threads with unread replies; red when one mentions me. */
@Composable
private fun ThreadsRow(store: Store, onClick: () -> Unit) {
    val summary = store.threadSummary
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

/** 「保存済み」 (M11c): my bookmarked messages. */
@Composable
private fun SavedRow(store: Store, onClick: () -> Unit) {
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
        if (store.bookmarks.isNotEmpty()) Text(store.bookmarks.size.toString(), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun SectionHeader(title: String) {
    Text(title, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 16.dp, top = 16.dp, bottom = 4.dp))
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

@Composable
private fun ChannelRow(channel: ChannelState, store: Store, onClick: () -> Unit) {
    val title = channelTitle(channel, store).let { if (channel.channel.isDm) it else it.removePrefix("#") }
    val muted = Channels.isMuted(channel)
    val unread = Channels.hasUnread(channel)
    val badge = Channels.badgeCount(channel)
    Row(
        Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 8.dp).alpha(if (muted && !unread) 0.6f else 1f),
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
        }
    }
}

@Composable
fun StatusBadge(status: EngineStatus) {
    when (status) {
        EngineStatus.ONLINE -> Box(Modifier.padding(8.dp).size(10.dp).background(Color(0xFF34C759), CircleShape))
        EngineStatus.CONNECTING -> CircularProgressIndicator(Modifier.padding(8.dp).size(14.dp), strokeWidth = 2.dp)
        EngineStatus.OFFLINE -> Box(Modifier.padding(8.dp).size(10.dp).background(Color(0xFFFF9500), CircleShape))
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

fun channelTitle(channel: ChannelState, store: Store): String {
    if (!channel.channel.isDm) return "#" + (channel.channel.name ?: "")
    val others = (channel.channel.dmUserIds ?: emptyList()).filter { it != store.me?.id }
    if (others.isEmpty()) return "自分へのメモ"
    return others.joinToString(", ") { store.users[it]?.displayName ?: "…" }
}
