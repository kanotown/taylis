package jp.chikuwachat.android.ui

import androidx.compose.foundation.Image
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
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Search
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material.icons.outlined.Movie
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.api.FileItem
import jp.chikuwachat.android.app.AppController
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import jp.chikuwachat.android.R
import androidx.compose.ui.res.stringResource

/** 「ファイル」 (M11i): attachments in my channels (or one channel), newest first; a row reveals its message. */
@Composable
fun FilesPane(
    controller: AppController,
    version: Int,
    channelId: String?,
    /** Picks the channel (null = all). Null (M29, a conversation's 「ファイル」 tab): that channel only, no selector. */
    onScopeChange: ((String?) -> Unit)?,
    onOpen: (messageId: String, channelId: String, parentId: String?) -> Unit,
) {
    val store = controller.store
    var query by remember { mutableStateOf("") }
    var items by remember { mutableStateOf<List<FileItem>?>(null) }
    var cursor by remember { mutableStateOf<String?>(null) }
    val channels = remember(version) {
        store.channels.values.filter { it.isMember }.sortedBy { channelTitle(it, store) }
    }
    suspend fun load(more: Boolean) {
        controller.listFiles(channelId, query.trim().ifEmpty { null }, if (more) cursor else null).onSuccess { page ->
            items = if (more) (items ?: emptyList()) + page.items else page.items
            cursor = page.nextCursor
        }.onFailure { controller.error = controller.describe(it) }
    }
    LaunchedEffect(channelId, query, controller.engineStatus) {
        if (query.isNotEmpty()) delay(250)
        load(more = false)
    }
    Column(Modifier.fillMaxSize()) {
        OutlinedTextField(
            query, { query = it }, singleLine = true,
            placeholder = { Text(stringResource(R.string.files_pane_filter_by_file_name)) },
            leadingIcon = { Icon(Icons.Default.Search, contentDescription = null) },
            modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 6.dp),
        )
        if (onScopeChange != null) {
            LazyRow(Modifier.fillMaxWidth().padding(horizontal = 12.dp)) {
                item { FilterChip(selected = channelId == null, onClick = { onScopeChange(null) }, label = { Text(stringResource(R.string.common_all)) }, modifier = Modifier.padding(horizontal = 4.dp)) }
                items(channels, key = { it.id }) { channel ->
                    FilterChip(selected = channelId == channel.id, onClick = { onScopeChange(channel.id) }, label = { Text(channelTitle(channel, store)) }, modifier = Modifier.padding(horizontal = 4.dp))
                }
            }
        }
        val list = items
        LazyColumn(Modifier.weight(1f)) {
            when {
                list == null -> item { Text(stringResource(R.string.common_loading), modifier = Modifier.padding(16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant) }
                list.isEmpty() -> item {
                    Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 48.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(if (query.isEmpty()) stringResource(R.string.files_pane_no_files_yet) else stringResource(R.string.common_nothing_found), style = MaterialTheme.typography.titleSmall)
                        Text(stringResource(R.string.files_pane_files_attached_to_messages_show_up), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 4.dp))
                    }
                }
                else -> {
                    items(list, key = { it.attachment.id }) { item ->
                        FileRow(item, controller, onClick = { onOpen(item.messageId, item.channelId, item.parentId) })
                        HorizontalDivider()
                    }
                    if (cursor != null) item { TextButton(onClick = { controller.scope.launch { load(more = true) } }, modifier = Modifier.fillMaxWidth()) { Text(stringResource(R.string.common_load_more)) } }
                }
            }
        }
    }
}

/** Thumbnail or file icon, name, and where / who / when; the trailing button downloads and opens the file. */
@Composable
fun FileRow(item: FileItem, controller: AppController, onClick: () -> Unit) {
    val store = controller.store
    val attachment = item.attachment
    var bitmap by remember(attachment.id) { mutableStateOf<ImageBitmap?>(null) }
    LaunchedEffect(attachment.id) {
        // A photo's thumbnail, or since M79 / M82 a video's poster (never the clip itself).
        if (!attachment.hasPreviewPicture) return@LaunchedEffect
        bitmap = fetchThumbnail(controller, attachment.id)
    }
    val uploader = store.users[item.uploaderId]?.displayName ?: "?"
    val channel = store.channel(item.channelId)?.let { channelTitle(it, store) } ?: "?"
    Row(Modifier.fillMaxWidth().clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        val shape = RoundedCornerShape(8.dp)
        Box(Modifier.size(48.dp).clip(shape).background(MaterialTheme.colorScheme.surfaceVariant), contentAlignment = Alignment.Center) {
            val image = bitmap
            if (image != null) {
                Image(image, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
                if (attachment.isVideo) Icon(Icons.Filled.PlayArrow, contentDescription = null, tint = Color.White, modifier = Modifier.size(20.dp).clip(CircleShape).background(Color.Black.copy(alpha = 0.5f)))
            } else {
                Icon(if (attachment.isImage) Icons.Outlined.Image else if (attachment.isVideo) Icons.Outlined.Movie else Icons.Outlined.Description, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text(attachment.filename, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(
                "${if (attachment.isVideo) VideoTiles.label(attachment) else formatSize(attachment.sizeBytes)} · $uploader · $channel · ${Timeline.timeLabel(item.attachedAt)}",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
        }
        IconButton(onClick = { controller.openAttachment(attachment) }) { Icon(Icons.Default.Download, contentDescription = stringResource(R.string.files_pane_download)) }
    }
}
