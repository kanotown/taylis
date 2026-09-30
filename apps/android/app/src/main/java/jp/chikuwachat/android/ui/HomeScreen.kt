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
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Alarm
import androidx.compose.material.icons.filled.Bookmark
import androidx.compose.material.icons.filled.CalendarMonth
import androidx.compose.material.icons.filled.Description
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.Forum
import androidx.compose.material.icons.filled.Group
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.filled.NotificationsOff
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Tag
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
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
import jp.chikuwachat.android.sync.Store
import kotlinx.coroutines.launch

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
    /** M14f: long-press on a conversation, and the 「…」 of one of my sections. */
    onChannelMenu: (String) -> Unit,
    onSectionMenu: (SidebarSectionOut, Int) -> Unit,
    /** M26: the default sections folded on this device (FoldedSections), and folding them. */
    folded: Set<String>,
    onToggleFolded: (String) -> Unit,
    /** M26: folding one of my sections (on all my devices), and drawing its icon. */
    onToggleSection: (SidebarSectionOut) -> Unit,
    sectionIcon: @Composable (String?) -> Unit,
) {
    val store = controller.store
    val meId = store.me?.id
    val isGuest = controller.isGuest
    val sections = remember(version, groupUnread, meId) {
        Channels.sections(store.channels.values, groupUnread = groupUnread, favorites = store.favorites, sidebar = store.sidebarSections, meId = meId)
    }
    val dmsFolded = FoldedSections.DMS in folded
    val dmSection = remember(sections, meId) { Channels.dmSection(sections.dms, meId) }
    // My own DM is always the first DM; until it exists, a placeholder row with my picture and name stands there (not
    // while the section is folded).
    val myName = remember(version, meId) { myDisplayName(store) }
    val selfPlaceholder = remember(version, meId, dmsFolded) {
        MainTabs.showsSelfNotesInDmSection(store.channels.values, meId, myName, collapsed = dmsFolded)
    }
    val tiles = remember(version) {
        HomeTiles.tiles(store.threadSummary, drafts = store.listDrafts().size + store.scheduled.size, saved = store.bookmarks.size, firedReminders = store.firedReminderCount())
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
        HomeChannelRow(channel, store, version, onClick = { onSelect(channel.id) }, onLongClick = { onChannelMenu(channel.id) }, modifier = Modifier.folding(this))
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
                    item(key = "header:unread") { Box(Modifier.folding(this)) { PlainSectionHeader("未読") } }
                    items(sections.unread, key = { "unread:" + it.id }) { row(it) }
                }
                if (sections.favorites.isNotEmpty()) {
                    val fold = FoldedSections.FAVORITES in folded
                    item(key = "header:favorites") { Box(Modifier.folding(this)) { SectionHeader("お気に入り", fold) { onToggleFolded(FoldedSections.FAVORITES) } } }
                    items(Channels.shown(sections.favorites, fold, meId), key = { "fav:" + it.id }) { row(it) }
                }
                sections.custom.forEachIndexed { index, (section, members) ->
                    item(key = "section:" + section.id) {
                        // Every row slides into place when a section above it folds (testers, 2026-09-29).
                        Box(Modifier.folding(this)) {
                            CustomSectionHeader(section.name, section.collapsed, icon = { sectionIcon(section.emoji) }, onToggle = { onToggleSection(section) }, onMenu = { onSectionMenu(section, index) })
                        }
                    }
                    items(Channels.shown(members, section.collapsed, meId), key = { "sec:" + section.id + ":" + it.id }) { row(it) }
                    if (members.isEmpty() && !section.collapsed && !groupUnread) {
                        item(key = "section-empty:" + section.id) { Box(Modifier.folding(this)) { EmptyHint("会話を長押し →「セクションに移動」で追加できます") } }
                    }
                }
                val channelsFolded = FoldedSections.CHANNELS in folded
                item(key = "header:channels") { Box(Modifier.folding(this)) { SectionHeader("チャンネル", channelsFolded) { onToggleFolded(FoldedSections.CHANNELS) } } }
                items(Channels.shown(sections.channels, channelsFolded, meId), key = { it.id }) { row(it) }
                if (!channelsFolded) {
                    if (sections.channels.isEmpty() && !groupUnread) {
                        item(key = "channels-empty") { Box(Modifier.folding(this)) { EmptyHint("参加中のチャンネルはありません") } }
                    }
                    if (!isGuest) item(key = "channels-add") { ActionRow(Icons.Default.Add, "チャンネルを追加", onClick = onAddChannel, modifier = Modifier.folding(this)) }
                }
                // M24: everyone's work logs, after the channels; someone else's are quiet unread (SYNC_PROTOCOL.md §10.5).
                if (sections.times.isNotEmpty() || canCreateTimes) {
                    val timesFolded = FoldedSections.TIMES in folded
                    item(key = "header:times") { Box(Modifier.folding(this)) { SectionHeader("Times", timesFolded) { onToggleFolded(FoldedSections.TIMES) } } }
                    items(Channels.shown(sections.times, timesFolded, meId), key = { "times:" + it.id }) { row(it) }
                    if (canCreateTimes && !timesFolded) item(key = "times-create") { ActionRow(Icons.Default.Add, "自分の times を作る", onClick = onCreateTimes, modifier = Modifier.folding(this)) }
                }
                item(key = "header:dms") { Box(Modifier.folding(this)) { SectionHeader("ダイレクトメッセージ", dmsFolded) { onToggleFolded(FoldedSections.DMS) } } }
                if (selfPlaceholder && meId != null) {
                    item(key = "dms-self-placeholder") { HomeSelfNotesRow(meId, myName, busy = creatingSelf, onClick = onSelfPlaceholder, modifier = Modifier.folding(this)) }
                }
                items(Channels.shown(dmSection.rows, dmsFolded, meId), key = { it.id }) { row(it) }
                if (!dmsFolded) {
                    if (dmSection.rows.isEmpty() && !selfPlaceholder && !groupUnread) {
                        item(key = "dms-empty") { Box(Modifier.folding(this)) { EmptyHint("右下の ✏️ から相手を選べます") } }
                    }
                    if (dmSection.more) item(key = "dms-all") { ActionRow(Icons.AutoMirrored.Filled.ArrowForward, "すべての DM", onClick = onAllDms, modifier = Modifier.folding(this)) }
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
            .clickable(role = Role.Button, onClickLabel = "開く", onClick = onClick)
            .clearAndSetSemantics { contentDescription = "移動・検索"; role = Role.Button },
    ) {
        Row(Modifier.padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Default.Search, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(20.dp))
            Spacer(Modifier.width(12.dp))
            Text("移動・検索…", color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyLarge)
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
    HomeTile.DRAFTS -> Icons.Default.Description
    HomeTile.SAVED -> Icons.Default.Bookmark
    HomeTile.REMINDERS -> Icons.Default.Alarm
    HomeTile.CALENDAR -> Icons.Default.CalendarMonth
    HomeTile.FILES -> Icons.Outlined.Folder
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
private fun CustomSectionHeader(title: String, collapsed: Boolean, icon: @Composable () -> Unit, onToggle: () -> Unit, onMenu: () -> Unit) {
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
        IconButton(onClick = onMenu) { Icon(Icons.Default.MoreHoriz, contentDescription = "$title のメニュー") }
    }
}

/** A default section's title; M26: tapping it folds it on this device. */
@Composable
private fun SectionHeader(title: String, collapsed: Boolean, onToggle: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(top = 4.dp).heightIn(min = ROW_MIN).foldable(title, collapsed, onToggle).padding(start = 12.dp, end = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        FoldChevron(collapsed)
        Text(title, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 4.dp))
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
    clickable(onClickLabel = if (collapsed) "開く" else "折りたたむ", onClick = onToggle)
        .semantics(mergeDescendants = true) { heading(); contentDescription = title; stateDescription = if (collapsed) "折りたたみ中" else "展開中" }

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
private fun HomeChannelRow(channel: ChannelState, store: Store, version: Int, onClick: () -> Unit, modifier: Modifier = Modifier, onLongClick: (() -> Unit)? = null) {
    val meId = store.me?.id
    val title = remember(version, channel) { channelTitle(channel, store).let { if (channel.channel.isDm) it else it.removePrefix("#") } }
    val muted = Channels.isMuted(channel)
    val unread = Channels.hasUnread(channel, meId)
    // M24: someone else's times with new posts but no mention: not bold, a faint dot (SYNC_PROTOCOL.md §10.5).
    val quietDot = Channels.showsQuietDot(channel, meId)
    val badge = Channels.badgeCount(channel)
    val others = (channel.channel.dmUserIds ?: emptyList()).filter { it != meId }
    Row(
        modifier.fillMaxWidth().heightIn(min = ROW_MIN).combinedClickable(onClick = onClick, onLongClick = onLongClick, onLongClickLabel = "メニュー")
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
            if (channel.channel.isDm && others.size == 1) StatusEmoji(store.users[others[0]], modifier = Modifier.padding(start = 4.dp))
        }
        if (muted) Icon(Icons.Default.NotificationsOff, contentDescription = "通知オフ", tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(end = 6.dp).size(14.dp))
        if (unread && badge > 0) {
            Text(
                badge.toString(),
                color = MaterialTheme.colorScheme.onPrimary,
                style = MaterialTheme.typography.labelSmall,
                modifier = Modifier.background(MaterialTheme.colorScheme.primary, CircleShape).padding(horizontal = 7.dp, vertical = 2.dp)
                    .semantics { contentDescription = "未読 $badge 件" },
            )
        } else if (unread) {
            Box(Modifier.size(8.dp).background(MaterialTheme.colorScheme.primary, CircleShape).semantics { contentDescription = "未読" })
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
