package jp.chikuwachat.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Edit
import androidx.compose.material.icons.filled.Group
import androidx.compose.material.icons.filled.NotificationsOff
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import java.time.ZonedDateTime
import androidx.compose.material.icons.filled.AccountCircle
import androidx.compose.material.icons.filled.ChatBubble
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.outlined.AccountCircle
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.Home
import androidx.compose.material.icons.outlined.Notifications
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.sync.ChannelState
import jp.chikuwachat.android.sync.Store
import kotlinx.coroutines.launch

/**
 * M34: the bottom tabs (MOBILE_UI.md §5) with their badges (§8, [MainTabs]): DM = the unread DMs, activity = the unread
 * activity items (M39; before it the unread followed threads and the channels with a mention), red with a mention,
 * home = a dot for an unread channel.
 * `version`: the counts come from the Store.
 */
@Composable
fun MainTabBar(store: Store, version: Int, selected: MainTab, onTab: (MainTab) -> Unit) {
    val meId = store.me?.id
    val dm = remember(version, meId) { MainTabs.dmBadge(store.channels.values, meId) }
    val activity = remember(version) { MainTabs.activityBadge(store.channels.values, store.threadSummary, store.activity) }
    val home = remember(version, meId) { MainTabs.homeDot(store.channels.values, meId) }
    NavigationBar {
        MainTab.entries.forEach { tab ->
            val isSelected = tab == selected
            val (filled, outlined) = tabIcons(tab)
            NavigationBarItem(
                selected = isSelected,
                onClick = { onTab(tab) },
                icon = {
                    // TalkBack reads each badge with the tab (the item merges its children).
                    BadgedBox(badge = {
                        when {
                            tab == MainTab.DM && dm > 0 -> Badge(Modifier.semantics { contentDescription = "未読 $dm 件" }) { Text(badgeText(dm)) }
                            tab == MainTab.ACTIVITY && activity.count > 0 -> Badge(
                                Modifier.semantics { contentDescription = "${activity.count} 件" + if (activity.mention) "、メンションあり" else "" },
                                containerColor = if (activity.mention) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.secondary,
                                contentColor = if (activity.mention) MaterialTheme.colorScheme.onError else MaterialTheme.colorScheme.onSecondary,
                            ) { Text(badgeText(activity.count)) }
                            tab == MainTab.HOME && home -> Badge(Modifier.semantics { contentDescription = "未読あり" }, containerColor = MaterialTheme.colorScheme.primary)
                        }
                    }) {
                        Icon(if (isSelected) filled else outlined, contentDescription = null)
                    }
                },
                label = { Text(tab.label, maxLines = 1, softWrap = false) },
            )
        }
    }
}

private fun badgeText(count: Int): String = if (count > 99) "99+" else count.toString()

private fun tabIcons(tab: MainTab): Pair<ImageVector, ImageVector> = when (tab) {
    MainTab.HOME -> Icons.Filled.Home to Icons.Outlined.Home
    MainTab.DM -> Icons.Filled.ChatBubble to Icons.Outlined.ChatBubbleOutline
    MainTab.ACTIVITY -> Icons.Filled.Notifications to Icons.Outlined.Notifications
    MainTab.YOU -> Icons.Filled.AccountCircle to Icons.Outlined.AccountCircle
}

/**
 * M34, the DM tab (MOBILE_UI.md §6.3): my DMs and group DMs, my own DM (titled with my name) first, then the newest. A
 * row shows the avatar with the presence, the name with the status emoji and the time, then the last message (M49,
 * DmPreview.kt; the status or presence, group DMs how many people, while there is none), unread in bold with its count;
 * a muted one is dimmed. Until my own DM exists, a placeholder row (my picture and name) stands first; a tap makes it
 * (POST /dms with only me) and opens it.
 */
@Composable
fun DmListScreen(controller: AppController, version: Int, listState: LazyListState, onOpen: (String) -> Unit, onNew: () -> Unit) {
    val store = controller.store
    val meId = store.me?.id
    var query by rememberSaveable { mutableStateOf("") }
    val rows = remember(version, meId, query) { MainTabs.dmList(store.channels.values, { channelTitle(it, store) }, meId, query) }
    val myName = remember(version, meId) { myDisplayName(store) }
    val placeholder = remember(version, meId, query) { MainTabs.showsSelfNotesPlaceholder(store.channels.values, meId, myName, query) }
    val scope = rememberCoroutineScope()
    var creating by remember { mutableStateOf(false) }
    val openSelfNotes: () -> Unit = {
        // One request at a time: a second tap while it runs does nothing.
        if (meId != null && !creating) {
            creating = true
            scope.launch {
                // Made, in the Store as mine, and opened; a failure is the app's error (openDmWith sets it).
                try { controller.openDmWith(meId)?.let(onOpen) } finally { creating = false }
            }
        }
    }
    val now = remember(version) { ZonedDateTime.now() }
    Box(Modifier.fillMaxSize()) {
        LazyColumn(Modifier.fillMaxSize(), state = listState, contentPadding = PaddingValues(bottom = 88.dp)) {
            item(key = "filter") {
                OutlinedTextField(
                    value = query,
                    onValueChange = { query = it.take(80) },
                    placeholder = { Text("DM を名前で絞り込む") },
                    leadingIcon = { Icon(Icons.Default.Search, contentDescription = null) },
                    trailingIcon = if (query.isEmpty()) null else {
                        { IconButton(onClick = { query = "" }) { Icon(Icons.Default.Close, contentDescription = "絞り込みを消す") } }
                    },
                    singleLine = true,
                    shape = RoundedCornerShape(12.dp),
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
                )
            }
            if (placeholder && meId != null) {
                item(key = "self-notes-placeholder") { SelfNotesPlaceholderRow(meId, myName, busy = creating, onClick = openSelfNotes) }
            }
            if (rows.isEmpty() && !placeholder) {
                item(key = "empty") {
                    Text(
                        if (query.isNotBlank()) "一致する DM はありません" else "まだ DM はありません",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 48.dp),
                    )
                }
            }
            items(rows, key = { it.id }) { channel -> DmRow(channel, controller, version, now, onClick = { onOpen(channel.id) }) }
        }
        ExtendedFloatingActionButton(
            onClick = onNew,
            icon = { Icon(Icons.Default.Edit, contentDescription = null) },
            text = { Text("新しいメッセージ") },
            modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp),
        )
    }
}

/** My own DM before it exists: my picture and my name, like any DM row; disabled while the tap's request runs. */
@Composable
private fun SelfNotesPlaceholderRow(meId: String, name: String, busy: Boolean, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = 72.dp).clickable(enabled = !busy, onClick = onClick).padding(horizontal = 16.dp, vertical = 8.dp)
            .alpha(if (busy) 0.6f else 1f),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Avatar(meId, name, size = 40.dp)
        Spacer(Modifier.width(12.dp))
        Text(name, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
    }
}

/** `version`: the names, presence and statuses come from the Store, not from `channel`. */
@Composable
private fun DmRow(channel: ChannelState, controller: AppController, version: Int, now: ZonedDateTime, onClick: () -> Unit) {
    val store = controller.store
    val meId = store.me?.id
    val title = remember(version, channel) { channelTitle(channel, store) }
    val others = (channel.channel.dmUserIds ?: emptyList()).filter { it != meId }
    val single = others.singleOrNull()
    val self = MainTabs.isSelfNotes(channel, meId)
    val statusUser = if (single != null) store.users[single] else if (self && meId != null) store.users[meId] else null
    val status = jp.chikuwachat.android.api.activeStatus(statusUser)
    val presence = single?.let { store.presenceOf(it) }
    val unread = Channels.hasUnread(channel, meId)
    val muted = Channels.isMuted(channel)
    val badge = Channels.badgeCount(channel)
    val time = MainTabs.dmTimeLabel(channel.channel.lastMessageAt, now)
    // M49: the last message (「あなた: …」 / 「佐藤: …」, DmPreview.kt); without one, the size, status or presence as before.
    val preview = remember(version, channel) { previewLine(channel.channel, meId, store.users) }
    val second = when {
        preview.isNotEmpty() -> preview
        others.size > 1 -> "${others.size + 1} 人"
        status != null && status.second.isNotBlank() -> status.second
        presence != null -> presenceLabel(presence)
        else -> null
    }
    Row(
        Modifier.fillMaxWidth().heightIn(min = 72.dp).clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 8.dp)
            .alpha(if (muted && !unread) 0.6f else 1f),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (others.size > 1) {
            Box(Modifier.size(40.dp).background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(10.dp)), contentAlignment = Alignment.Center) {
                Icon(Icons.Default.Group, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(20.dp))
            }
        } else {
            val id = single ?: meId ?: channel.id
            Avatar(id, store.users[id]?.displayName ?: title, size = 40.dp, presence = presence)
        }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                // The name takes the room the time leaves; the status emoji stays right after it.
                Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        title, fontWeight = if (unread) FontWeight.Bold else FontWeight.Normal, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                    StatusEmoji(statusUser, controller, version, modifier = Modifier.padding(start = 4.dp))
                }
                if (time != null) {
                    Text(
                        time, style = MaterialTheme.typography.labelMedium, maxLines = 1,
                        fontWeight = if (unread) FontWeight.Bold else FontWeight.Normal,
                        color = if (unread) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(start = 8.dp),
                    )
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 2.dp)) {
                // The preview is bold while unread (MOBILE_UI.md §6.3, as Slack); the status / presence line never is.
                val loud = unread && preview.isNotEmpty()
                // Custom emoji as their pictures, as in the message (2026-10-05: previews showed `:ckw-yay:`).
                EmojiLineText(
                    second ?: "", controller, version, MaterialTheme.typography.bodySmall,
                    if (loud) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
                    Modifier.weight(1f), fontWeight = if (loud) FontWeight.SemiBold else FontWeight.Normal,
                )
                if (muted) Icon(Icons.Default.NotificationsOff, contentDescription = "通知オフ", tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 6.dp).size(14.dp))
                if (unread && badge > 0) {
                    Text(
                        badgeText(badge),
                        color = MaterialTheme.colorScheme.onError,
                        style = MaterialTheme.typography.labelSmall,
                        modifier = Modifier.padding(start = 6.dp).background(MaterialTheme.colorScheme.error, CircleShape).padding(horizontal = 7.dp, vertical = 2.dp)
                            .semantics { contentDescription = "未読 $badge 件" },
                    )
                } else if (unread) {
                    Box(Modifier.padding(start = 6.dp).size(8.dp).background(MaterialTheme.colorScheme.primary, CircleShape).semantics { contentDescription = "未読" })
                }
            }
        }
    }
}
