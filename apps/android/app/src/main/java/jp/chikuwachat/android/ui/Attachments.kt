package jp.chikuwachat.android.ui

import android.content.Intent
import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.Movie
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.FileProvider
import java.io.File
import jp.chikuwachat.android.api.AttachmentOut
import jp.chikuwachat.android.app.AppController
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

fun formatSize(bytes: Long): String = when {
    bytes >= 1_048_576 -> "%.1f MB".format(bytes / 1_048_576.0)
    bytes >= 1024 -> "%.0f KB".format(bytes / 1024.0)
    else -> "$bytes B"
}

/**
 * Images show their thumbnail; other files show a row that downloads and opens them. Several photos sit side by side
 * as square tiles (testers, 2026-09-29: they came one under another), two in a row for two or four, three otherwise.
 */
@Composable
fun AttachmentList(attachments: List<AttachmentOut>, controller: AppController) {
    if (attachments.isEmpty()) return
    val photos = attachments.filter { it.isImage }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.padding(top = 4.dp)) {
        if (photos.size > 1) {
            val columns = if (photos.size == 2 || photos.size == 4) 2 else 3
            val side = (PHOTO_GRID_WIDTH - 4.dp * (columns - 1)) / columns
            FlowRow(
                Modifier.width(PHOTO_GRID_WIDTH), horizontalArrangement = Arrangement.spacedBy(4.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp), maxItemsInEachRow = columns,
            ) {
                photos.forEach { ThumbnailImage(it, controller, square = side) }
            }
        }
        attachments.forEach { attachment ->
            if (attachment.isImage) { if (photos.size == 1) ThumbnailImage(attachment, controller) } else FileRow(attachment, controller)
        }
    }
}

private val PHOTO_GRID_WIDTH = 280.dp

@Composable
private fun ThumbnailImage(attachment: AttachmentOut, controller: AppController, square: Dp? = null) {
    var bitmap by remember(attachment.id) { mutableStateOf<ImageBitmap?>(null) }
    var viewing by remember(attachment.id) { mutableStateOf(false) }
    LaunchedEffect(attachment.id) {
        bitmap = runCatching {
            val bytes = controller.fetchBytes("/api/v1/attachments/${attachment.id}/thumbnail")
            withContext(Dispatchers.Default) { BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap() }
        }.getOrNull()
    }
    val image = bitmap
    val shape = RoundedCornerShape(8.dp)
    val modifier = (if (square != null) Modifier.size(square) else Modifier.widthIn(max = 280.dp).heightIn(max = 240.dp))
        .clip(shape).clickable { viewing = true }
    if (image != null) {
        Image(image, contentDescription = attachment.filename, contentScale = if (square != null) ContentScale.Crop else ContentScale.Fit, modifier = modifier)
    } else if (square != null) {
        Box(modifier.background(MaterialTheme.colorScheme.surfaceVariant))
    } else {
        Text(attachment.filename, modifier = modifier.background(MaterialTheme.colorScheme.surfaceVariant, shape).padding(12.dp))
    }
    if (viewing) ImageViewer(attachment, controller, onDismiss = { viewing = false })
}

@Composable
private fun FileRow(attachment: AttachmentOut, controller: AppController) {
    val shape = RoundedCornerShape(8.dp)
    Row(
        Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant, shape).clickable { controller.openAttachment(attachment) }.padding(10.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(if (attachment.contentType.startsWith("video/")) Icons.Outlined.Movie else Icons.Outlined.Description, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
        Column {
            Text(attachment.filename, style = MaterialTheme.typography.bodyMedium)
            Text(formatSize(attachment.sizeBytes), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/**
 * Uploads waiting in the composer, as Slack and Mattermost show them (testers, 2026-09-29): small square thumbnails
 * with a × to take one out; a tap previews a photo (the same viewer as in the conversation) or opens a video or file
 * in another app. They were chips with the file name, and a tap took the file out. `uploading` adds a tile with a
 * spinner for each file still on its way.
 */
@Composable
fun PendingAttachments(items: List<AttachmentOut>, controller: AppController, uploading: Int = 0, onRemove: (AttachmentOut) -> Unit) {
    if (items.isEmpty() && uploading == 0) return
    LazyRow(
        Modifier.fillMaxWidth(), contentPadding = PaddingValues(start = 12.dp, end = 12.dp, top = 8.dp, bottom = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        items(items, key = { it.id }) { item -> PendingTile(item, controller) { onRemove(item) } }
        items(uploading) {
            Box(Modifier.size(PENDING_TILE).clip(RoundedCornerShape(10.dp)).background(MaterialTheme.colorScheme.surfaceVariant), contentAlignment = Alignment.Center) {
                CircularProgressIndicator(Modifier.size(20.dp).semantics { contentDescription = "アップロード中" }, strokeWidth = 2.dp)
            }
        }
    }
}

private val PENDING_TILE = 64.dp

@Composable
private fun PendingTile(item: AttachmentOut, controller: AppController, onRemove: () -> Unit) {
    var bitmap by remember(item.id) { mutableStateOf<ImageBitmap?>(null) }
    var viewing by remember(item.id) { mutableStateOf(false) }
    if (item.isImage) LaunchedEffect(item.id) {
        bitmap = runCatching {
            val bytes = controller.fetchBytes("/api/v1/attachments/${item.id}/thumbnail")
            withContext(Dispatchers.Default) { BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap() }
        }.getOrNull()
    }
    val video = item.contentType.startsWith("video/")
    val shape = RoundedCornerShape(10.dp)
    // Room above and to the right for the × over the corner.
    Box(Modifier.padding(top = 6.dp, end = 6.dp)) {
        Box(
            Modifier.size(PENDING_TILE).clip(shape).background(MaterialTheme.colorScheme.surfaceVariant)
                .clickable(onClickLabel = "プレビュー") { if (item.isImage) viewing = true else controller.openAttachment(item) }
                .semantics { contentDescription = "${if (item.isImage) "写真" else if (video) "動画" else "ファイル"} ${item.filename}" },
            contentAlignment = Alignment.Center,
        ) {
            val image = bitmap
            if (image != null) Image(image, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.size(PENDING_TILE))
            else if (item.isImage) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
            else Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.padding(4.dp)) {
                Icon(if (video) Icons.Outlined.Movie else Icons.Outlined.Description, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(item.filename, fontSize = 9.sp, lineHeight = 10.sp, maxLines = 2, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.Center, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        Box(
            Modifier.align(Alignment.TopEnd).offset(x = 6.dp, y = (-6).dp).size(22.dp).clip(CircleShape)
                .background(MaterialTheme.colorScheme.inverseSurface).clickable(onClick = onRemove)
                .semantics { contentDescription = "${item.filename} を取り消す" },
            contentAlignment = Alignment.Center,
        ) {
            Icon(Icons.Outlined.Close, contentDescription = null, tint = MaterialTheme.colorScheme.inverseOnSurface, modifier = Modifier.size(14.dp))
        }
    }
    if (viewing) ImageViewer(item, controller, onDismiss = { viewing = false })
}

/** Download to the cache and hand the file to another app (FileProvider; SECURITY.md §4: never inline HTML). */
suspend fun openDownloaded(context: android.content.Context, attachment: AttachmentOut, bytes: ByteArray) {
    val dir = File(context.cacheDir, "downloads").apply { mkdirs() }
    val file = File(dir, attachment.id + "_" + attachment.filename.replace('/', '_'))
    withContext(Dispatchers.IO) { file.writeBytes(bytes) }
    val uri = FileProvider.getUriForFile(context, context.packageName + ".files", file)
    val intent = Intent(Intent.ACTION_VIEW).setDataAndType(uri, attachment.contentType).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    context.startActivity(Intent.createChooser(intent, attachment.filename).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
}
