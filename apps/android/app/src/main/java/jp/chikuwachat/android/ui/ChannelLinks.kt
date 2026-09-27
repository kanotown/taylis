package jp.chikuwachat.android.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.api.ChannelLinkOut
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.sync.ChannelState
import kotlinx.coroutines.launch

/** M15f: rules shared by the link bar and its editor. */
object ChannelLinks {
    /** Only http(s) links (the server refuses the rest). */
    fun validUrl(text: String): Boolean {
        val trimmed = text.trim()
        if (trimmed.any { it.isWhitespace() }) return false
        val uri = runCatching { java.net.URI(trimmed) }.getOrNull() ?: return false
        val scheme = uri.scheme?.lowercase() ?: return false
        return (scheme == "http" || scheme == "https") && !uri.host.isNullOrEmpty()
    }

    /** Whether I may change this conversation's links (the server says the same). */
    fun canEdit(channel: ChannelState, role: String?): Boolean =
        channel.isMember && !channel.channel.archived && role != "guest" && channel.canPostTopLevel(isAdmin = role == "admin")
}

/** M15f: the conversation's pinned links at the top (Slack's bookmarks bar); hidden while empty. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun ChannelLinksRow(controller: AppController, channel: ChannelState, onAdd: () -> Unit, onEdit: (ChannelLinkOut) -> Unit) {
    val links = controller.store.linksOf(channel.id)
    if (links.isEmpty()) return
    val editable = ChannelLinks.canEdit(channel, controller.store.me?.role)
    val uriHandler = LocalUriHandler.current
    val scope = rememberCoroutineScope()
    LazyRow(Modifier.fillMaxWidth().padding(vertical = 4.dp), contentPadding = PaddingValues(horizontal = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        itemsIndexed(links, key = { _, link -> link.id }) { index, link ->
            var menu by remember { mutableStateOf(false) }
            Box {
                Surface(
                    shape = RoundedCornerShape(8.dp),
                    color = MaterialTheme.colorScheme.surfaceVariant,
                    modifier = Modifier.combinedClickable(onClick = { runCatching { uriHandler.openUri(link.url) } }, onLongClick = { if (editable) menu = true }),
                ) {
                    Row(Modifier.padding(horizontal = 10.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Outlined.Link, contentDescription = null, modifier = Modifier.size(14.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text(" " + link.title, style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 200.dp))
                    }
                }
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    DropdownMenuItem(text = { Text("編集") }, onClick = { menu = false; onEdit(link) })
                    DropdownMenuItem(text = { Text("左へ移動") }, enabled = index > 0, onClick = { menu = false; scope.launch { controller.updateChannelLink(channel.id, link.id, position = index - 1) } })
                    DropdownMenuItem(text = { Text("右へ移動") }, enabled = index < links.size - 1, onClick = { menu = false; scope.launch { controller.updateChannelLink(channel.id, link.id, position = index + 1) } })
                    HorizontalDivider()
                    DropdownMenuItem(text = { Text("削除", color = MaterialTheme.colorScheme.error) }, onClick = { menu = false; scope.launch { controller.deleteChannelLink(channel.id, link.id) } })
                }
            }
        }
        if (editable) {
            item(key = "add") {
                TextButton(onClick = onAdd, contentPadding = PaddingValues(horizontal = 8.dp)) {
                    Icon(Icons.Default.Add, contentDescription = null, modifier = Modifier.size(14.dp))
                    Text(" リンク", style = MaterialTheme.typography.labelMedium)
                }
            }
        }
    }
    HorizontalDivider()
}

/** Add a link, or edit one (URL and title). */
@Composable
fun ChannelLinkDialog(controller: AppController, channelId: String, link: ChannelLinkOut?, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    var url by remember { mutableStateOf(link?.url ?: "") }
    var title by remember { mutableStateOf(link?.title ?: "") }
    var busy by remember { mutableStateOf(false) }
    val urlOk = ChannelLinks.validUrl(url)
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (link == null) "リンクを追加" else "リンクを編集") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(url, { url = it }, singleLine = true, label = { Text("URL") }, placeholder = { Text("https://") }, modifier = Modifier.fillMaxWidth())
                if (url.isNotBlank() && !urlOk) Text("http:// か https:// で始まる URL を入れてください", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                OutlinedTextField(title, { title = it.take(80) }, singleLine = true, label = { Text("名前") }, placeholder = { Text("例: デザイン資料") }, modifier = Modifier.fillMaxWidth())
            }
        },
        confirmButton = {
            TextButton(enabled = !busy && urlOk && title.isNotBlank(), onClick = {
                busy = true
                scope.launch {
                    val ok = if (link == null) controller.addChannelLink(channelId, title.trim(), url.trim())
                    else controller.updateChannelLink(channelId, link.id, title = title.trim(), url = url.trim())
                    busy = false
                    if (ok) onDismiss()
                }
            }) { Text(if (link == null) "追加" else "保存") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("キャンセル") } },
    )
}
