package jp.chikuwachat.android.ui

import android.content.Intent
import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.Movie
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import jp.chikuwachat.android.sync.ChannelFiles
import jp.chikuwachat.android.sync.DriveLinkState
import jp.chikuwachat.android.sync.DriveNames
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
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
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
import jp.chikuwachat.android.R
import androidx.compose.ui.res.stringResource
import jp.chikuwachat.android.L10n

fun formatSize(bytes: Long): String = when {
    bytes >= 1_048_576 -> "%.1f MB".format(bytes / 1_048_576.0)
    bytes >= 1024 -> "%.0f KB".format(bytes / 1024.0)
    else -> "$bytes B"
}

/**
 * Images show their thumbnail; videos a tile with the server's poster (M82, [VideoAttachment]); PDFs and Office files
 * with a preview a card with the first page (M108, [DocumentCard]); other files show a row
 * that downloads and opens them. A video is told by its `content_type`, never by its thumbnail flags. Several photos sit side by side
 * as square tiles (testers, 2026-09-29: they came one under another), two in a row for two or four, three otherwise.
 */
@Composable
fun AttachmentList(attachments: List<AttachmentOut>, controller: AppController, channelId: String? = null) {
    if (attachments.isEmpty()) return
    // CF4 (docs/CHANNEL_FILES.md §12.1): a posted file moved to another location shows as usual only when I can read it
    // there (GET /drive/items/{id}, the /d/ cards' minute of cache); one in the trash or deleted never shows its name.
    val hub = controller.drive
    hub?.version?.collectAsState()?.value
    fun readable(attachment: AttachmentOut): Boolean = when (ChannelFiles.look(attachment)) {
        ChannelFiles.Look.PLAIN -> true
        ChannelFiles.Look.MOVED -> attachment.drive?.itemId?.let { hub?.peekLink(it) } is DriveLinkState.Ok
        ChannelFiles.Look.DELETED -> false
    }
    if (attachments.any { ChannelFiles.look(it) != ChannelFiles.Look.PLAIN }) PostedFilesWatch(controller, attachments, channelId)
    val photos = attachments.filter { it.isImage && readable(it) }
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
            val look = ChannelFiles.look(attachment)
            when {
                look == ChannelFiles.Look.DELETED -> DeletedFileRow(attachment, controller, channelId)
                look == ChannelFiles.Look.MOVED && !readable(attachment) -> MovedFileRow(attachment, controller)
                attachment.isImage -> if (photos.size == 1) ThumbnailImage(attachment, controller)
                attachment.isVideo -> VideoAttachment(attachment, controller)
                // M108: a PDF / Office file with a preview (being made, or ready).
                DocumentCards.showsCard(attachment) -> DocumentCard(attachment, controller)
                else -> FileRow(attachment, controller)
            }
            // A moved file I can read: where it is now, under it (「研究室ドライブ › 論文」).
            if (look == ChannelFiles.Look.MOVED) {
                (attachment.drive?.itemId?.let { hub?.peekLink(it) } as? DriveLinkState.Ok)?.let { ok ->
                    Text(
                        DriveNames.pathLine(ok.detail.path, ok.detail.locationKind, hub?.systemFolders ?: emptySet()),
                        style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}

/**
 * CF4: reads what the message's moved files are for me (once each, the hub's minute of cache), and whether I can write
 * the channel's drive when a file is in its trash (「戻す」, §6.5: the locations, read once when not yet).
 */
@Composable
private fun PostedFilesWatch(controller: AppController, attachments: List<AttachmentOut>, channelId: String?) {
    val hub = controller.drive ?: return
    val moved = attachments.filter { ChannelFiles.look(it) == ChannelFiles.Look.MOVED }.mapNotNull { it.drive?.itemId }
    val epoch = hub.version.collectAsState().value
    LaunchedEffect(moved, epoch) { moved.forEach { if (hub.peekLink(it) == null) hub.link(it) } }
    val trashed = attachments.any { it.drive?.state == "trashed" }
    if (trashed && channelId != null && hub.locations == null) LaunchedEffect(channelId) { hub.reloadLocations() }
}

/** §12.1: a file in the trash or deleted for good: one quiet line, no name or picture; 「戻す」 for who can write the drive. */
@Composable
private fun DeletedFileRow(attachment: AttachmentOut, controller: AppController, channelId: String?) {
    val hub = controller.drive
    val canRestore = channelId != null && ChannelFiles.canRestore(attachment, hub?.canWriteChannelDrive(channelId))
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val shape = RoundedCornerShape(8.dp)
    var busy by remember(attachment.id) { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    Row(
        Modifier.widthIn(max = 420.dp).fillMaxWidth().border(1.dp, MaterialTheme.colorScheme.outlineVariant, shape).padding(start = 10.dp, end = 4.dp)
            .heightIn(min = 40.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(Icons.Outlined.Delete, contentDescription = null, tint = muted, modifier = Modifier.size(18.dp))
        Text(
            stringResource(R.string.channel_files_deleted) + if (canRestore) " · " + stringResource(R.string.channel_files_in_trash) else "",
            style = MaterialTheme.typography.bodySmall, color = muted, modifier = Modifier.weight(1f), maxLines = 2, overflow = TextOverflow.Ellipsis,
        )
        if (canRestore) {
            val itemId = attachment.drive?.itemId
            TextButton(enabled = !busy && itemId != null, onClick = {
                itemId ?: return@TextButton
                busy = true
                scope.launch { try { controller.restoreDriveFile(itemId) } finally { busy = false } }
            }) { Text(stringResource(R.string.channel_files_restore)) }
        }
    }
}

/** §12.1: a file moved where I may not read it (or not read yet): 「表示できないファイル」 and why, never its name. */
@Composable
private fun MovedFileRow(attachment: AttachmentOut, controller: AppController) {
    val hub = controller.drive
    val itemId = attachment.drive?.itemId
    val state = itemId?.let { hub?.peekLink(it) }
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val shape = RoundedCornerShape(8.dp)
    val scope = rememberCoroutineScope()
    val failed = state == DriveLinkState.Failed
    Row(
        Modifier.widthIn(max = 420.dp).fillMaxWidth().border(1.dp, MaterialTheme.colorScheme.outlineVariant, shape)
            .then(if (failed && itemId != null) Modifier.clickable(onClickLabel = stringResource(R.string.common_retry)) { scope.launch { hub?.link(itemId, force = true) } } else Modifier)
            .padding(horizontal = 10.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        when (state) {
            null -> {
                CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
                Text(stringResource(R.string.channel_files_checking), style = MaterialTheme.typography.bodySmall, color = muted)
            }
            DriveLinkState.Failed -> {
                Icon(Icons.Outlined.WarningAmber, contentDescription = null, tint = muted, modifier = Modifier.size(18.dp))
                Column {
                    Text(stringResource(R.string.drive_card_failed), style = MaterialTheme.typography.bodySmall)
                    Text(stringResource(R.string.drive_card_retry), style = MaterialTheme.typography.labelSmall, color = muted)
                }
            }
            else -> {
                Icon(Icons.Outlined.Lock, contentDescription = null, tint = muted, modifier = Modifier.size(18.dp))
                Column {
                    Text(stringResource(R.string.drive_card_unavailable), style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.Medium)
                    Text(stringResource(R.string.channel_files_moved_note), style = MaterialTheme.typography.labelSmall, color = muted)
                }
            }
        }
    }
}

private val PHOTO_GRID_WIDTH = 280.dp

/**
 * The picture at `/attachments/{id}/thumbnail` (an image's thumbnail, a video's poster since M79), with the session;
 * null when it cannot be fetched or decoded (the caller shows its fallback).
 */
internal suspend fun fetchThumbnail(controller: AppController, attachmentId: String): ImageBitmap? = try {
    val bytes = controller.fetchBytes("/api/v1/attachments/$attachmentId/thumbnail")
    withContext(Dispatchers.Default) { BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap() }
} catch (e: kotlinx.coroutines.CancellationException) {
    throw e
} catch (e: Exception) {
    null
}

/**
 * M82: a video in a message. With the server's size and poster (M79) it is a tile of the clip's final shape showing the
 * poster, a play mark and 「0:42 · 1.9 MB」 at the bottom left; the clip is fetched only when the tile is tapped (the
 * in-app player). Without a poster the tile shows a film icon; with nothing known (an older server) it is the file row
 * it was before. No frame is read on the device.
 */
@Composable
private fun VideoAttachment(attachment: AttachmentOut, controller: AppController) {
    var poster by remember(attachment.id) { mutableStateOf<ImageBitmap?>(null) }
    var posterFailed by remember(attachment.id) { mutableStateOf(false) }
    var viewing by remember(attachment.id) { mutableStateOf(false) }
    if (attachment.hasPoster) LaunchedEffect(attachment.id) {
        poster = fetchThumbnail(controller, attachment.id)
        posterFailed = poster == null
    }
    val look = VideoTiles.look(attachment, posterFailed)
    if (look == VideoTiles.Look.ROW) {
        FileRow(attachment, controller, onClick = { viewing = true })
    } else {
        val box = VideoTiles.box(attachment)
        Box(
            Modifier.size(box.width.dp, box.height.dp).clip(RoundedCornerShape(8.dp)).background(MaterialTheme.colorScheme.surfaceVariant)
                .clickable(onClickLabel = stringResource(R.string.attachments_play)) { viewing = true }
                .semantics { contentDescription = VideoTiles.description(attachment) },
            contentAlignment = Alignment.Center,
        ) {
            val image = poster
            if (image != null) Image(image, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.matchParentSize())
            else if (look == VideoTiles.Look.PLAIN) Icon(Icons.Outlined.Movie, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(32.dp).offset(y = (-14).dp))
            Box(Modifier.size(44.dp).clip(CircleShape).background(Color.Black.copy(alpha = 0.5f)), contentAlignment = Alignment.Center) {
                Icon(Icons.Filled.PlayArrow, contentDescription = null, tint = Color.White, modifier = Modifier.size(28.dp))
            }
            Text(
                VideoTiles.label(attachment), color = Color.White, fontSize = 11.sp, maxLines = 1,
                modifier = Modifier.align(Alignment.BottomStart).padding(6.dp).clip(RoundedCornerShape(4.dp))
                    .background(Color.Black.copy(alpha = 0.55f)).padding(horizontal = 5.dp, vertical = 1.dp),
            )
        }
    }
    if (viewing) VideoViewer(attachment, controller, poster, onDismiss = { viewing = false })
}

@Composable
private fun ThumbnailImage(attachment: AttachmentOut, controller: AppController, square: Dp? = null) {
    var bitmap by remember(attachment.id) { mutableStateOf<ImageBitmap?>(null) }
    var viewing by remember(attachment.id) { mutableStateOf(false) }
    LaunchedEffect(attachment.id) { bitmap = fetchThumbnail(controller, attachment.id) }
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
private fun FileRow(attachment: AttachmentOut, controller: AppController, onClick: () -> Unit = { controller.openAttachment(attachment) }) {
    val shape = RoundedCornerShape(8.dp)
    Row(
        Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant, shape).clickable(onClick = onClick).padding(10.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(if (attachment.isVideo) Icons.Outlined.Movie else Icons.Outlined.Description, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
        Column {
            Text(attachment.filename, style = MaterialTheme.typography.bodyMedium)
            Text(if (attachment.isVideo) VideoTiles.label(attachment) else formatSize(attachment.sizeBytes), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
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
                CircularProgressIndicator(Modifier.size(20.dp).semantics { contentDescription = L10n.str(R.string.attachments_uploading) }, strokeWidth = 2.dp)
            }
        }
    }
}

private val PENDING_TILE = 64.dp

@Composable
private fun PendingTile(item: AttachmentOut, controller: AppController, onRemove: () -> Unit) {
    var bitmap by remember(item.id) { mutableStateOf<ImageBitmap?>(null) }
    var viewing by remember(item.id) { mutableStateOf(false) }
    var posterFailed by remember(item.id) { mutableStateOf(false) }
    // M82: a video's poster from the server, as a photo's thumbnail.
    if (item.hasPreviewPicture) LaunchedEffect(item.id) {
        bitmap = fetchThumbnail(controller, item.id)
        posterFailed = bitmap == null
    }
    val video = item.isVideo
    val shape = RoundedCornerShape(10.dp)
    // Room above and to the right for the × over the corner.
    Box(Modifier.padding(top = 6.dp, end = 6.dp)) {
        Box(
            Modifier.size(PENDING_TILE).clip(shape).background(MaterialTheme.colorScheme.surfaceVariant)
                .clickable(onClickLabel = stringResource(R.string.common_preview)) { if (item.isImage || video) viewing = true else controller.openAttachment(item) }
                .semantics { contentDescription = if (video) VideoTiles.description(item) else L10n.str(if (item.isImage) R.string.attachments_photo_named else R.string.attachments_file_named, item.filename) },
            contentAlignment = Alignment.Center,
        ) {
            val image = bitmap
            if (image != null) {
                Image(image, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.size(PENDING_TILE))
                if (video) {
                    Icon(Icons.Filled.PlayArrow, contentDescription = null, tint = Color.White, modifier = Modifier.size(22.dp).clip(CircleShape).background(Color.Black.copy(alpha = 0.5f)))
                    formatDuration(item.durationMs)?.let {
                        Text(it, color = Color.White, fontSize = 9.sp, lineHeight = 10.sp, modifier = Modifier.align(Alignment.BottomStart).padding(3.dp)
                            .clip(RoundedCornerShape(3.dp)).background(Color.Black.copy(alpha = 0.55f)).padding(horizontal = 3.dp))
                    }
                }
            }
            else if (item.hasPreviewPicture && !posterFailed) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
            else Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.padding(4.dp)) {
                Icon(if (video) Icons.Outlined.Movie else Icons.Outlined.Description, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                FileNameTwoLines(item.filename, fontSize = 9.sp, lineHeight = 10.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        // M28c: the × keeps its 22 dp look but takes touches from 48 dp around it (over the tile's corner, being on top).
        Box(
            Modifier.align(Alignment.TopEnd).offset(x = 6.dp, y = (-6).dp)
                .touchTarget { source ->
                    Modifier.semantics { contentDescription = L10n.str(R.string.attachments_remove, item.filename) }.clickable(interactionSource = source, indication = null, onClick = onRemove)
                }
                .size(22.dp).clip(CircleShape).background(MaterialTheme.colorScheme.inverseSurface),
            contentAlignment = Alignment.Center,
        ) {
            Icon(Icons.Outlined.Close, contentDescription = null, tint = MaterialTheme.colorScheme.inverseOnSurface, modifier = Modifier.size(14.dp))
        }
    }
    if (viewing) {
        if (video) VideoViewer(item, controller, bitmap, onDismiss = { viewing = false })
        else ImageViewer(item, controller, onDismiss = { viewing = false })
    }
}

/**
 * Where a download sits under the cache's `downloads/` (the FileProvider's path). 仕上げ A (MOBILE_POLISH.md V1): the
 * viewer shows the file's own name, so the attachment id is a folder (two files of the same name stay apart) rather
 * than a prefix of the name (「01a0f275-…_ゼミ資料.pdf」). Neither part can leave its folder: separators become 「_」, and a
 * name of only dots (or none) is 「file」.
 */
object DownloadCache {
    fun path(attachmentId: String, filename: String): String = segment(attachmentId, "attachment") + "/" + segment(filename, "file")

    private fun segment(name: String, fallback: String): String {
        val safe = name.map { if (it == '/' || it == '\\' || it == '\u0000') '_' else it }.joinToString("").trim()
        return if (safe.isEmpty() || safe.all { it == '.' }) fallback else safe
    }
}

/** Download to the cache and hand the file to another app (FileProvider; SECURITY.md §4: never inline HTML). */
suspend fun openDownloaded(context: android.content.Context, attachment: AttachmentOut, bytes: ByteArray) {
    val file = File(File(context.cacheDir, "downloads"), DownloadCache.path(attachment.id, attachment.filename))
    withContext(Dispatchers.IO) {
        file.parentFile?.mkdirs()
        file.writeBytes(bytes)
    }
    openCachedFile(context, attachment, file)
}

/** Hand a file already in the cache's `downloads/` to another app. */
fun openCachedFile(context: android.content.Context, attachment: AttachmentOut, file: File) {
    val uri = FileProvider.getUriForFile(context, context.packageName + ".files", file)
    val intent = Intent(Intent.ACTION_VIEW).setDataAndType(uri, attachment.contentType).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    context.startActivity(Intent.createChooser(intent, attachment.filename).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
}
