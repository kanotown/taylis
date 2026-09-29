package jp.chikuwachat.android.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.People
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.filled.Tag
import androidx.compose.material3.Button
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import jp.chikuwachat.android.api.ChannelOut
import jp.chikuwachat.android.app.AppController
import kotlinx.coroutines.launch

/**
 * 「チャンネルを探す」 (M11h): every public channel plus my private ones, with member counts; join, leave or
 * create. Archived channels are left out of the sidebar, so this is where they are opened (read-only; an
 * owner or admin can unarchive from its channel info). M27: tapping a public channel I have not joined opens its
 * preview (read before joining).
 */
@Composable
fun ChannelBrowserDialog(controller: AppController, version: Int, onDismiss: () -> Unit, onOpen: (String) -> Unit, onCreate: () -> Unit) {
    val store = controller.store
    var listed by remember { mutableStateOf<List<ChannelOut>?>(null) }
    var query by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    suspend fun load() {
        controller.browseChannels().onSuccess { listed = it }.onFailure(controller::report)
    }
    LaunchedEffect(Unit) { load() }
    val rows = remember(listed, query) {
        val needle = query.trim().lowercase()
        (listed ?: emptyList())
            .filter { c ->
                needle.isEmpty() || (c.name ?: "").lowercase().contains(needle) ||
                    (c.topic ?: "").lowercase().contains(needle) || (c.purpose ?: "").lowercase().contains(needle)
            }
            .sortedWith(compareBy<ChannelOut> { it.archived }.thenByDescending { it.memberCount ?: 0 }.thenBy { it.name ?: "" })
    }
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxWidth().fillMaxHeight(0.9f).padding(12.dp), shape = RoundedCornerShape(20.dp), tonalElevation = 2.dp) {
            Column(Modifier.fillMaxSize()) {
                Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 4.dp, top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("チャンネルを探す", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
                    TextButton(onClick = { onDismiss(); onCreate() }) { Text("作成") }
                    IconButton(onClick = onDismiss) { Icon(Icons.Default.Close, contentDescription = "閉じる") }
                }
                OutlinedTextField(
                    query, { query = it }, singleLine = true,
                    placeholder = { Text("名前やトピックで絞り込む") },
                    leadingIcon = { Icon(Icons.Default.Search, contentDescription = null) },
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp),
                )
                LazyColumn(Modifier.weight(1f)) {
                    when {
                        listed == null -> item { Text("読み込み中…", modifier = Modifier.padding(16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant) }
                        rows.isEmpty() -> item { Text("見つかりません", modifier = Modifier.padding(16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant) }
                        else -> items(rows, key = { it.id }) { channel ->
                            // `version` keeps membership current after a join / leave elsewhere.
                            val mine = remember(version, channel.id) { store.channel(channel.id)?.isMember ?: (channel.membership != null) }
                            // M27: a public channel I have not joined opens to be read first (SYNC_PROTOCOL.md §7.6.1);
                            // 「参加」 still joins at once.
                            val previewable = !mine && channel.type == "public" && !controller.isGuest
                            Row(
                                Modifier.fillMaxWidth()
                                    .clickable(enabled = mine || previewable) {
                                        if (!mine) controller.notePublicChannel(channel)
                                        onOpen(channel.id); onDismiss()
                                    }
                                    .padding(horizontal = 16.dp, vertical = 10.dp)
                                    .alpha(if (channel.archived) 0.6f else 1f),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                Icon(
                                    if (channel.type == "private") Icons.Default.Lock else Icons.Default.Tag,
                                    contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(20.dp),
                                )
                                Spacer(Modifier.width(12.dp))
                                Column(Modifier.weight(1f)) {
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        Text(channel.name ?: "", fontWeight = FontWeight.Medium)
                                        when {
                                            channel.archived -> Text("アーカイブ済み", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 6.dp))
                                            mine -> Text("参加中", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(start = 6.dp))
                                        }
                                    }
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        Icon(Icons.Default.People, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(14.dp))
                                        Text(
                                            " ${channel.memberCount ?: 0} 人" + ((channel.purpose ?: channel.topic)?.takeIf { it.isNotBlank() }?.let { " · $it" } ?: ""),
                                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                                            maxLines = 1, overflow = TextOverflow.Ellipsis,
                                        )
                                    }
                                }
                                if (!channel.archived) {
                                    if (mine) {
                                        TextButton(enabled = busy != channel.id, onClick = {
                                            scope.launch { busy = channel.id; if (controller.leaveChannel(channel.id)) load(); busy = null }
                                        }) { Text("退出") }
                                    } else {
                                        Button(enabled = busy != channel.id, contentPadding = PaddingValues(horizontal = 14.dp), onClick = {
                                            scope.launch { busy = channel.id; if (controller.joinChannel(channel.id)) { onOpen(channel.id); onDismiss() }; busy = null }
                                        }) { Text("参加") }
                                    }
                                }
                            }
                            HorizontalDivider()
                        }
                    }
                }
            }
        }
    }
}
