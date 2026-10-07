package jp.chikuwachat.android.ui

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyItemScope
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.automirrored.outlined.Article
import androidx.compose.material.icons.automirrored.outlined.MenuBook
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Alarm
import androidx.compose.material.icons.filled.AlarmOn
import androidx.compose.material.icons.filled.Bookmark
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.Checklist
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.DynamicFeed
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Forum
import androidx.compose.material.icons.filled.Group
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.filled.NotificationsOff
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Tag
import androidx.compose.material.icons.outlined.ConfirmationNumber
import androidx.compose.material.icons.outlined.MeetingRoom
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.RadioButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.api.SidebarSectionOut
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.sync.ChannelState
import kotlinx.coroutines.launch
import jp.chikuwachat.android.R
import jp.chikuwachat.android.L10n
import androidx.compose.ui.res.stringResource

/** The home's rows are at least this tall (MOBILE_UI.md §6.1: 44 pt / 48 dp). */
private val ROW_MIN = 48.dp

/** Glyphs and avatars on the home's rows (§6.1: 20–24). */
private val ROW_ICON = 24.dp

/**
 * M37 (MOBILE_UI.md §6.1): the home tab's root at phone widths. 「移動・検索」 under the app bar (opens the jump screen,
 * §6.2), then, pulled to refresh (the engine's resync), the tiles and the sections: [未読 (「未読をまとめる」)], お気に入り,
 * my own sections, チャンネル (and 「チャンネルを追加」), Times, ダイレクトメッセージ (my own DM, the five newest, 「すべての
 * DM」). A folded section still shows its unread rows. The ✏️ button is the scaffold's (MainScreen).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(
    controller: AppController,
    version: Int,
    /** M34: the home tab keeps its scroll position (and a re-tap of the tab scrolls it up). */
    listState: LazyListState,
    groupUnread: Boolean,
    onJump: () -> Unit,
    /** Opens a conversation from a row. */
    onSelect: (String) -> Unit,
    onTile: (HomeTile) -> Unit,
    /** 「チャンネルを追加」: the channel browser (which also makes one). */
    onAddChannel: () -> Unit,
    /** 「すべての DM」: the DM tab. */
    onAllDms: () -> Unit,
    /** M24: make (or open) my times. */
    onCreateTimes: () -> Unit,
    /** L8 (TIMES_FEED.md §7): the Times section header's 「フィード」. */
    onTimesFeed: () -> Unit,
    /** M14f: long-press on a conversation, and the 「…」 of one of my sections. */
    onChannelMenu: (String) -> Unit,
    onSectionMenu: (SidebarSectionOut, Int) -> Unit,
    /** M26: the default sections folded on this device (FoldedSections), and folding them. */
    folded: Set<String>,
    onToggleFolded: (String) -> Unit,
    /** M26: folding one of my sections (on all my devices), and drawing its icon. */
    onToggleSection: (SidebarSectionOut) -> Unit,
    sectionIcon: @Composable (String?) -> Unit,
    /** T1: the conversation open beside the list (wide), marked. */
    selectedId: String? = null,
    /**
     * DATA_MODEL.md 「並べ替え」: the 「手動」 section being reordered with arrows ("favorites", "channels", "dms",
     * "custom:<id>"), shown whole and unfolded; 「完了」 in its header ends it.
     */
    editing: String? = null,
    onEditing: (String?) -> Unit = {},
) {
    val store = controller.store
    val meId = store.me?.id
    val isGuest = controller.isGuest
    val sections = remember(version, groupUnread, meId) {
        Channels.sections(store.channels.values, groupUnread = groupUnread, favorites = store.favorites, sidebar = store.sidebarSections, meId = meId,
            defaults = store.sidebarDefaults, title = { channelTitle(it, store) }, dmPins = store.dmPins, closedDms = store.closedDms)
    }
    val dmsFolded = FoldedSections.DMS in folded && editing != "dms"
    val dmSection = remember(sections, meId, editing) {
        Channels.dmSection(sections.dms, meId, manual = store.defaultSort("dms").sort == "manual", limit = if (editing == "dms") Int.MAX_VALUE else Channels.HOME_DMS, dmPins = store.dmPins)
    }
    // My own DM is always the first DM; until it exists, a placeholder row with my picture and name stands there (not
    // while the section is folded).
    val myName = remember(version, meId) { myDisplayName(store) }
    val selfPlaceholder = remember(version, meId, dmsFolded) {
        MainTabs.showsSelfNotesInDmSection(store.channels.values, meId, myName, collapsed = dmsFolded)
    }
    val tiles = remember(version) {
        HomeTiles.tiles(store.threadSummary, drafts = store.listDrafts().size + store.scheduled.size, saved = store.bookmarks.size, firedReminders = store.firedReminderCount(),
            navItems = store.me?.navItems,
            reservations = store.reservationPools?.let { pools ->
                HomeTiles.ReservationTile(ReservationRules.todoCount(pools), pools.any { it.canOperate })
            },
            attendance = AttendanceRules.shown(store.attendance, store.me?.role))
    }
    // M24: offer to make my times until I have one (joined or not: a times I left is in the channel browser).
    val canCreateTimes = remember(version, isGuest, meId) { !isGuest && meId != null && store.channels.values.none { it.channel.timesOwnerId == meId } }
    val scope = rememberCoroutineScope()
    var creatingSelf by remember { mutableStateOf(false) }
    val onSelfPlaceholder: () -> Unit = {
        // One request at a time: a second tap while it runs does nothing. Made, in the Store as mine; a failure is the
        // app's error (openDmWith sets it).
        if (!creatingSelf && meId != null) {
            creatingSelf = true
            scope.launch { try { controller.openDmWith(meId)?.let(onSelect) } finally { creatingSelf = false } }
        }
    }
    var refreshing by remember { mutableStateOf(false) }
    val row: @Composable LazyItemScope.(ChannelState) -> Unit = { channel ->
        HomeChannelRow(channel, controller, version, onClick = { onSelect(channel.id) }, onLongClick = { onChannelMenu(channel.id) }, modifier = Modifier.folding(this), selected = channel.id == selectedId)
    }
    // 「順番を編集」: a row with ↑ / ↓ that move it one place within its section (TalkBack reads them with its name).
    val reorderRow: @Composable LazyItemScope.(ChannelState, List<ChannelState>, AppController.SortTarget) -> Unit = { channel, rows, target ->
        val ids = rows.map { it.id }
        val index = ids.indexOf(channel.id)
        val title = remember(version, channel) { channelTitle(channel, store).removePrefix("#") }
        val move = { delta: Int ->
            val next = ids.toMutableList().apply { add(index + delta, removeAt(index)) }
            scope.launch { controller.reorderSection(target, next) }
            Unit
        }
        Row(Modifier.folding(this).fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.weight(1f)) { HomeChannelRow(channel, controller, version, onClick = {}, selected = false) }
            IconButton(enabled = index > 0, onClick = { move(-1) }) { Icon(Icons.Default.KeyboardArrowUp, contentDescription = stringResource(R.string.you_screens_move_up, title)) }
            IconButton(enabled = index < ids.size - 1, onClick = { move(1) }) { Icon(Icons.Default.KeyboardArrowDown, contentDescription = stringResource(R.string.you_screens_move_down, title)) }
        }
    }
    val done: @Composable () -> Unit = { TextButton(onClick = { onEditing(null) }) { Text(stringResource(R.string.common_done_2)) } }
    // A default section's 「…」 (並べ替え), or 「完了」 while it is being reordered.
    val sortAction = { key: String, rows: List<ChannelState>, folded: Boolean ->
        @Composable {
            if (editing == key) done()
            else DefaultSortMenu(
                store.defaultSort(key).sort, canEdit = !folded && !groupUnread, title = key,
                onSort = { sort -> scope.launch { controller.setSectionSort(AppController.SortTarget.Default(key), sort, rows.map { it.id }) } },
                onEditOrder = { onEditing(key) },
            )
        }
    }

    Column(Modifier.fillMaxSize()) {
        JumpBar(onJump)
        PullToRefreshBox(
            isRefreshing = refreshing,
            onRefresh = {
                refreshing = true
                scope.launch { try { controller.resync() } finally { refreshing = false } }
            },
            modifier = Modifier.weight(1f).fillMaxWidth(),
        ) {
            // Room at the bottom for the ✏️ button over the last rows.
            LazyColumn(Modifier.fillMaxSize(), state = listState, contentPadding = PaddingValues(bottom = 88.dp)) {
                item(key = "tiles") { TileRow(tiles, onTile) }
                // 仕上げ A (MOBILE_POLISH.md H3): with nothing unread there is no 「未読」 section (as on iOS), not an empty one.
                if (sections.unreadShown) {
                    item(key = "header:unread") { Box(Modifier.folding(this)) { PlainSectionHeader(stringResource(R.string.common_unread)) } }
                    items(sections.unread, key = { "unread:" + it.id }) { row(it) }
                }
                if (sections.favorites.isNotEmpty()) {
                    val fold = FoldedSections.FAVORITES in folded && editing != "favorites"
                    item(key = "header:favorites") { Box(Modifier.folding(this)) { SectionHeader(stringResource(R.string.common_star), fold, action = sortAction("favorites", sections.favorites, fold)) { onToggleFolded(FoldedSections.FAVORITES) } } }
                    if (editing == "favorites") items(sections.favorites, key = { "fav:" + it.id }) { reorderRow(it, sections.favorites, AppController.SortTarget.Default("favorites")) }
                    else items(Channels.shown(sections.favorites, fold, meId), key = { "fav:" + it.id }) { row(it) }
                }
                sections.custom.forEachIndexed { index, (section, members) ->
                    item(key = "section:" + section.id) {
                        // Every row slides into place when a section above it folds (testers, 2026-09-29).
                        Box(Modifier.folding(this)) {
                            CustomSectionHeader(section.name, section.collapsed, icon = { sectionIcon(section.emoji) }, onToggle = { onToggleSection(section) }, onMenu = { onSectionMenu(section, index) },
                                done = if (editing == "custom:" + section.id) done else null)
                        }
                    }
                    if (editing == "custom:" + section.id) {
                        items(members, key = { "sec:" + section.id + ":" + it.id }) { reorderRow(it, members, AppController.SortTarget.Section(section.id)) }
                    } else {
                        items(Channels.shown(members, section.collapsed, meId), key = { "sec:" + section.id + ":" + it.id }) { row(it) }
                    }
                    if (members.isEmpty() && !section.collapsed && !groupUnread) {
                        item(key = "section-empty:" + section.id) { Box(Modifier.folding(this)) { EmptyHint(stringResource(R.string.home_screen_long_press_a_conversation_move_to)) } }
                    }
                }
                val channelsFolded = FoldedSections.CHANNELS in folded && editing != "channels"
                item(key = "header:channels") { Box(Modifier.folding(this)) { SectionHeader(stringResource(R.string.common_channels), channelsFolded, action = sortAction("channels", sections.channels, channelsFolded)) { onToggleFolded(FoldedSections.CHANNELS) } } }
                if (editing == "channels") items(sections.channels, key = { it.id }) { reorderRow(it, sections.channels, AppController.SortTarget.Default("channels")) }
                else items(Channels.shown(sections.channels, channelsFolded, meId), key = { it.id }) { row(it) }
                if (!channelsFolded) {
                    if (sections.channels.isEmpty() && !groupUnread) {
                        item(key = "channels-empty") { Box(Modifier.folding(this)) { EmptyHint(stringResource(R.string.home_screen_you_havent_joined_any_channels)) } }
                    }
                    if (!isGuest) item(key = "channels-add") { ActionRow(Icons.Default.Add, stringResource(R.string.home_screen_add_channels), onClick = onAddChannel, modifier = Modifier.folding(this)) }
                }
                // M24: everyone's work logs, after the channels; someone else's are quiet unread (SYNC_PROTOCOL.md §10.5).
                if (sections.times.isNotEmpty() || canCreateTimes) {
                    val timesFolded = FoldedSections.TIMES in folded
                    item(key = "header:times") {
                        Box(Modifier.folding(this)) {
                            // L8: 「フィード」 at the header's end, folded or not (TIMES_FEED.md §7). In the header's
                            // grey like its title: the primary colour read as "selected" all the time (2026-10-02).
                            SectionHeader("Times", timesFolded, action = {
                                TextButton(onClick = onTimesFeed, colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurfaceVariant)) {
                                    Icon(Icons.Default.DynamicFeed, contentDescription = null, modifier = Modifier.size(16.dp))
                                    Spacer(Modifier.width(4.dp))
                                    Text(stringResource(R.string.home_screen_feed), style = MaterialTheme.typography.labelLarge)
                                }
                            }) { onToggleFolded(FoldedSections.TIMES) }
                        }
                    }
                    items(Channels.shown(sections.times, timesFolded, meId), key = { "times:" + it.id }) { row(it) }
                    if (canCreateTimes && !timesFolded) item(key = "times-create") { ActionRow(Icons.Default.Add, stringResource(R.string.common_create_your_times), onClick = onCreateTimes, modifier = Modifier.folding(this)) }
                }
                item(key = "header:dms") { Box(Modifier.folding(this)) { SectionHeader(stringResource(R.string.common_direct_message), dmsFolded, action = sortAction("dms", sections.dms, dmsFolded)) { onToggleFolded(FoldedSections.DMS) } } }
                if (selfPlaceholder && meId != null && editing != "dms") {
                    item(key = "dms-self-placeholder") { HomeSelfNotesRow(meId, myName, busy = creatingSelf, onClick = onSelfPlaceholder, modifier = Modifier.folding(this)) }
                }
                if (editing == "dms") items(dmSection.rows, key = { it.id }) { reorderRow(it, dmSection.rows, AppController.SortTarget.Default("dms")) }
                else items(Channels.shown(dmSection.rows, dmsFolded, meId), key = { it.id }) { row(it) }
                if (!dmsFolded) {
                    if (dmSection.rows.isEmpty() && !selfPlaceholder && !groupUnread) {
                        item(key = "dms-empty") { Box(Modifier.folding(this)) { EmptyHint(stringResource(R.string.home_screen_pick_someone_from_at_the_bottom)) } }
                    }
                    if (dmSection.more) item(key = "dms-all") { ActionRow(Icons.AutoMirrored.Filled.ArrowForward, stringResource(R.string.home_screen_all_dms), onClick = onAllDms, modifier = Modifier.folding(this)) }
                }
            }
        }
    }
}

/** 「移動・検索」: looks like a search box, opens the full-screen jump screen (§6.2). */
@Composable
private fun JumpBar(onClick: () -> Unit) {
    Surface(
        shape = RoundedCornerShape(24.dp),
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp).heightIn(min = ROW_MIN)
            .clickable(role = Role.Button, onClickLabel = stringResource(R.string.common_open), onClick = onClick)
            .clearAndSetSemantics { contentDescription = L10n.str(R.string.common_jump_or_search); role = Role.Button },
    ) {
        Row(Modifier.padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Default.Search, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(12.dp))
            Text(stringResource(R.string.home_screen_jump_or_search), color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyLarge)
        }
    }
}

/** The tiles (§6.1), scrolling sideways; a 0 is dimmed but opens its list all the same. */
@Composable
private fun TileRow(tiles: List<TileState>, onTile: (HomeTile) -> Unit) {
    Row(
        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp, vertical = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        tiles.forEach { state -> Tile(state, onClick = { onTile(state.tile) }) }
    }
}

@Composable
private fun Tile(state: TileState, onClick: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    Surface(
        shape = RoundedCornerShape(12.dp),
        color = colors.surfaceContainerHigh,
        modifier = Modifier.heightIn(min = ROW_MIN)
            .clickable(role = Role.Button, onClick = onClick)
            .clearAndSetSemantics { contentDescription = HomeTiles.description(state); role = Role.Button },
    ) {
        Row(
            Modifier.alpha(if (state.dimmed) 0.5f else 1f).padding(horizontal = 12.dp, vertical = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(tileIcon(state.tile), contentDescription = null, tint = colors.onSurfaceVariant, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(6.dp))
            Text(state.tile.label, style = MaterialTheme.typography.labelLarge, maxLines = 1)
            val count = state.count
            if (count != null && count > 0) {
                Spacer(Modifier.width(6.dp))
                if (state.alert) {
                    Text(
                        count.toString(), color = colors.onError, style = MaterialTheme.typography.labelSmall,
                        modifier = Modifier.background(colors.error, CircleShape).padding(horizontal = 7.dp, vertical = 2.dp),
                    )
                } else {
                    Text(count.toString(), style = MaterialTheme.typography.labelLarge, color = colors.onSurfaceVariant)
                }
            }
        }
    }
}

private fun tileIcon(tile: HomeTile): ImageVector = when (tile) {
    HomeTile.THREADS -> Icons.Default.Forum
    HomeTile.TIMES -> Icons.Default.DynamicFeed
    HomeTile.DRAFTS -> Icons.Default.Description
    HomeTile.SAVED -> Icons.Default.Bookmark
    HomeTile.REMINDERS -> Icons.Default.Alarm
    HomeTile.CALENDAR -> Icons.Default.CalendarMonth
    HomeTile.TASKS -> Icons.Default.Checklist
    HomeTile.DEADLINES -> Icons.Default.AlarmOn
    HomeTile.RESERVATIONS -> Icons.Outlined.ConfirmationNumber
    HomeTile.ATTENDANCE -> Icons.Outlined.MeetingRoom
    HomeTile.FILES -> Icons.Outlined.Folder
    HomeTile.CANVASES -> Icons.AutoMirrored.Outlined.Article
    HomeTile.DOCS -> Icons.AutoMirrored.Outlined.MenuBook
}

/**
 * A sidebar row appearing, leaving or moving as a section folds (testers, 2026-09-29: it opened and closed at once):
 * leaving rows fade before the rows below slide over them.
 */
private fun Modifier.folding(scope: LazyItemScope): Modifier =
    with(scope) { this@folding.animateItem(fadeInSpec = tween(220), placementSpec = tween(260), fadeOutSpec = tween(120)) }

/** A row that does something rather than open a conversation (「チャンネルを追加」, 「すべての DM」). */
@Composable
private fun ActionRow(icon: ImageVector, label: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Row(
        modifier.fillMaxWidth().heightIn(min = ROW_MIN).clickable(role = Role.Button, onClick = onClick).padding(horizontal = 16.dp, vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(ROW_ICON), contentAlignment = Alignment.Center) {
            Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(20.dp))
        }
        Spacer(Modifier.width(12.dp))
        Text(label, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
    }
}

/** A custom section's title with its icon and 「…」 (M14f); M26: tapping the title folds it on all my devices. */
@Composable
private fun CustomSectionHeader(title: String, collapsed: Boolean, icon: @Composable () -> Unit, onToggle: () -> Unit, onMenu: () -> Unit, done: (@Composable () -> Unit)? = null) {
    Row(Modifier.fillMaxWidth().padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Row(
            Modifier.weight(1f).heightIn(min = ROW_MIN).foldable(title, collapsed, onToggle).padding(start = 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            FoldChevron(collapsed)
            Spacer(Modifier.width(4.dp))
            icon()
            Text(title, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 4.dp))
        }
        if (done != null) done() else IconButton(onClick = onMenu) { Icon(Icons.Default.MoreHoriz, contentDescription = stringResource(R.string.common_menu_for, title)) }
    }
}

/**
 * A default section's 「…」: 「並べ替え」 (名前順 / 最近の活動順 / 手動, DATA_MODEL.md sidebar_sections), and in 「手動」
 * 「順番を編集」 (not while the section is folded or unread conversations are gathered: rows would be missing).
 */
@Composable
private fun DefaultSortMenu(sort: String, canEdit: Boolean, title: String, onSort: (String) -> Unit, onEditOrder: () -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        IconButton(onClick = { open = true }) { Icon(Icons.Default.MoreHoriz, contentDescription = stringResource(R.string.common_menu_for, sectionLabel(title))) }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            Text(stringResource(R.string.sidebar_dialogs_sort), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
            SIDEBAR_SORTS.forEach { (value, label) ->
                DropdownMenuItem(
                    text = { Text(stringResource(label)) },
                    leadingIcon = { RadioButton(selected = sort == value, onClick = null) },
                    onClick = { open = false; if (sort != value) onSort(value) },
                )
            }
            if (sort == "manual") {
                HorizontalDivider()
                DropdownMenuItem(text = { Text(stringResource(R.string.sidebar_dialogs_edit_order)) }, enabled = canEdit, onClick = { open = false; onEditOrder() })
            }
        }
    }
}

/** The name of a default section by its key, for TalkBack. */
@Composable
private fun sectionLabel(key: String): String = when (key) {
    "favorites" -> stringResource(R.string.common_star)
    "channels" -> stringResource(R.string.common_channels)
    else -> stringResource(R.string.common_direct_message)
}

/** A default section's title; M26: tapping it folds it on this device. */
@Composable
private fun SectionHeader(title: String, collapsed: Boolean, action: (@Composable () -> Unit)? = null, onToggle: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        Row(
            Modifier.weight(1f).heightIn(min = ROW_MIN).foldable(title, collapsed, onToggle).padding(start = 12.dp, end = 16.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            FoldChevron(collapsed)
            Text(title, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 4.dp))
        }
        // Beside the folding part, not in it: its own button for TalkBack (L8's 「フィード」).
        if (action != null) Box(Modifier.padding(end = 4.dp)) { action() }
    }
}

/**
 * 「未読」: not folded (everything in it is unread, which a fold keeps anyway), so no chevron. 仕上げ A (H3): its title
 * starts where the other headers' chevrons do (the rows' icons, 16 dp), as iOS's plain header does, instead of under
 * their titles, which read as a header missing its ∨.
 */
@Composable
private fun PlainSectionHeader(title: String) {
    Row(Modifier.fillMaxWidth().padding(top = 4.dp).heightIn(min = ROW_MIN).padding(start = 16.dp, end = 16.dp).semantics { heading() }, verticalAlignment = Alignment.CenterVertically) {
        Text(title, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** A section header that folds: TalkBack reads its name as a heading with 「折りたたみ中」 / 「展開中」 and offers the action by name. */
private fun Modifier.foldable(title: String, collapsed: Boolean, onToggle: () -> Unit): Modifier =
    clickable(onClickLabel = if (collapsed) L10n.str(R.string.common_open) else L10n.str(R.string.home_screen_collapse), onClick = onToggle)
        .semantics(mergeDescendants = true) { heading(); contentDescription = title; stateDescription = if (collapsed) L10n.str(R.string.home_screen_collapsed) else L10n.str(R.string.home_screen_expanded) }

@Composable
private fun FoldChevron(collapsed: Boolean) {
    val angle by animateFloatAsState(if (collapsed) -90f else 0f, label = "fold")
    Icon(Icons.Default.ExpandMore, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(18.dp).rotate(angle))
}

@Composable
private fun EmptyHint(text: String) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
}

/** "#" / "🔒" for a channel, the size of a row's avatar (§6.1: 20–24). */
@Composable
private fun ChannelGlyph(channel: ChannelState) {
    Box(Modifier.size(ROW_ICON), contentAlignment = Alignment.Center) {
        Icon(
            if (channel.channel.type == "private") Icons.Default.Lock else Icons.Default.Tag,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(20.dp),
        )
    }
}

/**
 * One line per conversation (§6.1: 48 dp, no topic line): unread in bold with its number, a muted one dimmed.
 * `version`: the partner's name, presence dot and status emoji come from the Store, not from `channel`.
 */
@OptIn(androidx.compose.foundation.ExperimentalFoundationApi::class)
@Composable
private fun HomeChannelRow(channel: ChannelState, controller: AppController, version: Int, onClick: () -> Unit, modifier: Modifier = Modifier, onLongClick: (() -> Unit)? = null, selected: Boolean = false) {
    val store = controller.store
    val meId = store.me?.id
    val title = remember(version, channel) { channelTitle(channel, store).let { if (channel.channel.isDm) it else it.removePrefix("#") } }
    val muted = Channels.isMuted(channel)
    val unread = Channels.hasUnread(channel, meId)
    // M24: someone else's times with new posts but no mention: not bold, a faint dot (SYNC_PROTOCOL.md §10.5).
    val quietDot = Channels.showsQuietDot(channel, meId)
    val badge = Channels.badgeCount(channel)
    val others = (channel.channel.dmUserIds ?: emptyList()).filter { it != meId }
    Row(
        modifier.fillMaxWidth().heightIn(min = ROW_MIN).selectedRow(selected).combinedClickable(onClick = onClick, onLongClick = onLongClick, onLongClickLabel = stringResource(R.string.common_menu))
            .padding(horizontal = 16.dp, vertical = 4.dp).alpha(if (muted && !unread) 0.6f else 1f),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        when {
            !channel.channel.isDm -> ChannelGlyph(channel)
            others.size > 1 -> Box(Modifier.size(ROW_ICON), contentAlignment = Alignment.Center) {
                Icon(Icons.Default.Group, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(20.dp))
            }
            else -> {
                val other = others.firstOrNull() ?: meId ?: channel.id
                Avatar(other, store.users[other]?.displayName ?: title, size = ROW_ICON, presence = store.presenceOf(other))
            }
        }
        Spacer(Modifier.width(12.dp))
        // The name takes the room the badge leaves; the status emoji stays right after it.
        Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) {
            Text(title, fontWeight = if (unread) FontWeight.Bold else FontWeight.Normal, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
            if (channel.channel.isDm && others.size == 1) StatusEmoji(store.users[others[0]], controller, version, modifier = Modifier.padding(start = 4.dp))
        }
        if (channel.channel.isDm && store.isDmPinned(channel.id)) DmPinMark(Modifier.padding(end = 6.dp))  // M118
        if (muted) Icon(Icons.Default.NotificationsOff, contentDescription = stringResource(R.string.common_notifications_off), tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(end = 6.dp).size(14.dp))
        if (unread && badge > 0) {
            Text(
                badge.toString(),
                color = MaterialTheme.colorScheme.onPrimary,
                style = MaterialTheme.typography.labelSmall,
                modifier = Modifier.background(MaterialTheme.colorScheme.primary, CircleShape).padding(horizontal = 7.dp, vertical = 2.dp)
                    .semantics { contentDescription = L10n.str(R.string.common_unread_2, badge) },
            )
        } else if (unread) {
            Box(Modifier.size(8.dp).background(MaterialTheme.colorScheme.primary, CircleShape).semantics { contentDescription = L10n.str(R.string.common_unread) })
        } else if (quietDot) {
            Box(Modifier.size(6.dp).background(MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.4f), CircleShape))
        }
    }
}

/** My own DM before it exists: my picture and my name, like a DM row; disabled while the tap's request runs. */
@Composable
private fun HomeSelfNotesRow(meId: String, name: String, busy: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier) {
    Row(
        modifier.fillMaxWidth().heightIn(min = ROW_MIN).clickable(enabled = !busy, onClick = onClick).padding(horizontal = 16.dp, vertical = 4.dp).alpha(if (busy) 0.6f else 1f),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Avatar(meId, name, size = ROW_ICON)
        Spacer(Modifier.width(12.dp))
        Text(name, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
    }
}
