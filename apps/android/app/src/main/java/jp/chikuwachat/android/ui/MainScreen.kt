package jp.chikuwachat.android.ui

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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.sync.ChannelState
import jp.chikuwachat.android.sync.EngineStatus
import jp.chikuwachat.android.sync.Store
import kotlinx.coroutines.launch

enum class MainDialog { NEW_DM, NEW_CHANNEL, ADD_MEMBER }

/** Channel list first; a selected channel opens as its own page (compact-width layout, like the iOS app). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MainScreen(controller: AppController) {
    val store = controller.store
    val version by store.version.collectAsState()
    val status = controller.engineStatus
    var selection by rememberSaveable { mutableStateOf<String?>(null) }
    var dialog by remember { mutableStateOf<MainDialog?>(null) }
    var menuOpen by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

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
    BackHandler(enabled = selectedChannel != null) { selection = null }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(selectedChannel?.let { channelTitle(it, store) } ?: (store.me?.displayName ?: "ChikuwaChat")) },
                navigationIcon = {
                    if (selectedChannel != null) IconButton(onClick = { selection = null }) { Text("←", style = MaterialTheme.typography.titleLarge) }
                },
                actions = {
                    StatusBadge(status)
                    IconButton(onClick = { menuOpen = true }) { Icon(Icons.Default.MoreVert, contentDescription = "メニュー") }
                    DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                        DropdownMenuItem(text = { Text("ダイレクトメッセージ") }, onClick = { menuOpen = false; dialog = MainDialog.NEW_DM })
                        DropdownMenuItem(text = { Text("チャンネルを作成") }, onClick = { menuOpen = false; dialog = MainDialog.NEW_CHANNEL })
                        if (selectedChannel != null && !selectedChannel.channel.isDm && selectedChannel.isMember) {
                            DropdownMenuItem(text = { Text("メンバーを追加") }, onClick = { menuOpen = false; dialog = MainDialog.ADD_MEMBER })
                        }
                        HorizontalDivider()
                        DropdownMenuItem(text = { Text("ログアウト") }, onClick = { menuOpen = false; scope.launch { controller.logout() } })
                    }
                },
            )
        },
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            if (selectedChannel != null) {
                ChannelPane(controller, selectedChannel.id, version)
            } else {
                ChannelList(store, version, onSelect = { selection = it }, onJoin = { id -> scope.launch { if (controller.joinChannel(id)) selection = id } })
            }
        }
    }

    when (dialog) {
        MainDialog.NEW_DM -> NewDmDialog(controller, onDismiss = { dialog = null }, onOpened = { selection = it })
        MainDialog.NEW_CHANNEL -> NewChannelDialog(controller, onDismiss = { dialog = null }, onOpened = { selection = it })
        MainDialog.ADD_MEMBER -> selectedChannel?.let { AddMemberDialog(controller, it.id, onDismiss = { dialog = null }) }
        null -> Unit
    }
}

@Composable
private fun ChannelList(store: Store, version: Int, onSelect: (String) -> Unit, onJoin: (String) -> Unit) {
    val all = remember(version) { store.channels.values.toList() }
    val channels = all.filter { it.isMember && !it.channel.isDm && !it.channel.archived }.sortedBy { it.channel.name ?: "" }
    val dms = all.filter { it.isMember && it.channel.isDm }.sortedByDescending { it.channel.lastMessageAt ?: "" }
    val browsable = all.filter { !it.isMember && !it.channel.archived }.sortedBy { it.channel.name ?: "" }

    LazyColumn(Modifier.fillMaxSize()) {
        item { SectionHeader("チャンネル") }
        items(channels, key = { it.id }) { ChannelRow(it, store, onClick = { onSelect(it.id) }) }
        if (channels.isEmpty()) item { EmptyHint("参加中のチャンネルはありません") }
        item { SectionHeader("ダイレクトメッセージ") }
        items(dms, key = { it.id }) { ChannelRow(it, store, onClick = { onSelect(it.id) }) }
        if (dms.isEmpty()) item { EmptyHint("メニューから DM を開始できます") }
        if (browsable.isNotEmpty()) {
            item { SectionHeader("参加できるチャンネル") }
            items(browsable, key = { "browse:" + it.id }) { channel ->
                Row(Modifier.fillMaxWidth().clickable { onJoin(channel.id) }.padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("#" + (channel.channel.name ?: ""), modifier = Modifier.weight(1f))
                    Text("参加", color = MaterialTheme.colorScheme.primary)
                }
            }
        }
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

@Composable
private fun ChannelRow(channel: ChannelState, store: Store, onClick: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(channelTitle(channel, store), fontWeight = if (channel.hasUnread) FontWeight.Bold else FontWeight.Normal, modifier = Modifier.weight(1f))
        if (channel.mentionCount > 0 || (channel.hasUnread && channel.channel.isDm)) {
            val count = if (channel.channel.isDm) channel.unreadCount else channel.mentionCount
            Text(
                count.toString(),
                color = MaterialTheme.colorScheme.onPrimary,
                style = MaterialTheme.typography.labelSmall,
                modifier = Modifier.background(MaterialTheme.colorScheme.primary, CircleShape).padding(horizontal = 7.dp, vertical = 2.dp),
            )
        } else if (channel.hasUnread) {
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

fun channelTitle(channel: ChannelState, store: Store): String {
    if (!channel.channel.isDm) return "#" + (channel.channel.name ?: "")
    val others = (channel.channel.dmUserIds ?: emptyList()).filter { it != store.me?.id }
    if (others.isEmpty()) return "自分へのメモ"
    return others.joinToString(", ") { store.users[it]?.displayName ?: "…" }
}
