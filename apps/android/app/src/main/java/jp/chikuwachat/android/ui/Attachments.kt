package jp.chikuwachat.android.ui

import androidx.compose.material3.Icon
import androidx.compose.material3.InputChip
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.Icons
import android.content.Intent
import android.graphics.BitmapFactory
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import jp.chikuwachat.android.api.AttachmentOut
import jp.chikuwachat.android.app.AppController
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.io.File

fun formatSize(bytes: Long): String = when {
    bytes >= 1_048_576 -> "%.1f MB".format(bytes / 1_048_576.0)
    bytes >= 1024 -> "%.0f KB".format(bytes / 1024.0)
    else -> "$bytes B"
}

/** Images show their thumbnail; other files show a row that downloads and opens them. */
@Composable
fun AttachmentList(attachments: List<AttachmentOut>, controller: AppController) {
    if (attachments.isEmpty()) return
    Column(verticalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.padding(top = 4.dp)) {
        attachments.forEach { attachment ->
            if (attachment.isImage) ThumbnailImage(attachment, controller) else FileRow(attachment, controller)
        }
    }
}

@Composable
private fun ThumbnailImage(attachment: AttachmentOut, controller: AppController) {
    var bitmap by remember(attachment.id) { mutableStateOf<ImageBitmap?>(null) }
    LaunchedEffect(attachment.id) {
        bitmap = runCatching {
            val bytes = controller.fetchBytes("/api/v1/attachments/${attachment.id}/thumbnail")
            withContext(Dispatchers.Default) { BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap() }
        }.getOrNull()
    }
    val image = bitmap
    val shape = RoundedCornerShape(8.dp)
    val modifier = Modifier.widthIn(max = 280.dp).heightIn(max = 240.dp).clip(shape).clickable { controller.openAttachment(attachment) }
    if (image != null) {
        Image(image, contentDescription = attachment.filename, contentScale = ContentScale.Fit, modifier = modifier)
    } else {
        Text(attachment.filename, modifier = modifier.background(MaterialTheme.colorScheme.surfaceVariant, shape).padding(12.dp))
    }
}

@Composable
private fun FileRow(attachment: AttachmentOut, controller: AppController) {
    val shape = RoundedCornerShape(8.dp)
    Row(
        Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant, shape).clickable { controller.openAttachment(attachment) }.padding(10.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(Icons.Outlined.Description, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
        Column {
            Text(attachment.filename, style = MaterialTheme.typography.bodyMedium)
            Text(formatSize(attachment.sizeBytes), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/** Chips for uploads waiting in the composer. */
@Composable
fun PendingAttachments(items: List<AttachmentOut>, onRemove: (AttachmentOut) -> Unit) {
    if (items.isEmpty()) return
    LazyRow(Modifier.fillMaxWidth(), contentPadding = PaddingValues(horizontal = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        items(items, key = { it.id }) { item ->
            InputChip(
                selected = false,
                onClick = { onRemove(item) },
                label = { Text(item.filename, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                trailingIcon = { Icon(Icons.Outlined.Close, contentDescription = null) },
                modifier = Modifier.widthIn(max = 260.dp).semantics { contentDescription = "${item.filename} を取り消す" },
            )
        }
    }
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
