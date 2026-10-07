package jp.chikuwachat.android.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color as AndroidColor
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawingPadding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.OpenInNew
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
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
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import java.io.Closeable
import java.io.File
import jp.chikuwachat.android.api.AttachmentOut
import jp.chikuwachat.android.api.AttachmentPreviewOut
import jp.chikuwachat.android.app.AppController
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import jp.chikuwachat.android.R
import jp.chikuwachat.android.L10n
import androidx.compose.ui.res.stringResource

/**
 * M108 (docs/PREVIEWS.md §5): how a PDF's or Office file's card looks, apart from Compose so it can be unit tested.
 * The first page is as wide as the card and keeps its shape up to [MAX_THUMB_HEIGHT] (a portrait page shows its top, a
 * slide whole), from the server's numbers: the row has its final height before the picture arrives.
 */
object DocumentCards {
    const val CARD_WIDTH = 260
    const val MAX_THUMB_HEIGHT = 200

    /** A preview being made or ready; a failed or missing one keeps the plain file row. */
    fun showsCard(attachment: AttachmentOut): Boolean = attachment.preview?.let { it.isPending || it.isReady } == true

    fun thumbHeight(preview: AttachmentPreviewOut?): Int? {
        val w = preview?.width ?: return null
        val h = preview.height ?: return null
        if (!preview.isReady || w <= 0 || h <= 0) return null
        return minOf(MAX_THUMB_HEIGHT, Math.round(CARD_WIDTH.toFloat() * h / w))
    }

    fun pagesLabel(pages: Int?): String? = pages?.takeIf { it > 0 }?.let { L10n.str(R.string.document_preview_pages, it) }

    /** The card's second line: 「プレビューを作成中…」 while the server works, else the size and page count. */
    fun detail(attachment: AttachmentOut): String =
        if (attachment.preview?.isPending == true) L10n.str(R.string.document_preview_creating_preview)
        else listOfNotNull(formatSize(attachment.sizeBytes), pagesLabel(attachment.preview?.pages)).joinToString(" · ")

    /** Where the preview PDF is kept for the viewer: the attachment's folder under the cache's `previews/`. */
    fun cachePath(attachmentId: String): String = DownloadCache.path(attachmentId, "preview.pdf")
}

/**
 * A PDF or Office file with a preview: the first page (a tap opens every page in [PdfPreviewViewer]) over the name, size
 * and page count; 「他のアプリで開く」 hands the original to another app, as the plain row does.
 */
@Composable
internal fun DocumentCard(attachment: AttachmentOut, controller: AppController) {
    val height = DocumentCards.thumbHeight(attachment.preview)
    var thumb by remember(attachment.id, height != null) { mutableStateOf<ImageBitmap?>(null) }
    var viewing by remember(attachment.id) { mutableStateOf(false) }
    if (height != null) LaunchedEffect(attachment.id) { thumb = fetchPreviewThumbnail(controller, attachment.id) }
    val shape = RoundedCornerShape(8.dp)
    Column(Modifier.width(DocumentCards.CARD_WIDTH.dp).clip(shape).background(MaterialTheme.colorScheme.surfaceVariant, shape)) {
        if (height != null) {
            Box(
                Modifier.fillMaxWidth().height(height.dp).background(Color.White)
                    .clickable(onClickLabel = stringResource(R.string.common_preview)) { viewing = true }
                    .semantics { contentDescription = L10n.str(R.string.document_preview_preview_of, attachment.filename) },
                contentAlignment = Alignment.Center,
            ) {
                val image = thumb
                if (image != null) {
                    Image(image, contentDescription = null, contentScale = ContentScale.Crop, alignment = Alignment.TopCenter, modifier = Modifier.fillMaxSize())
                } else {
                    CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                }
            }
            HorizontalDivider()
        }
        Row(
            Modifier.fillMaxWidth().clickable { if (height != null) viewing = true else controller.openAttachment(attachment) }.padding(start = 10.dp, top = 6.dp, bottom = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Outlined.Description, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
            Column(Modifier.weight(1f)) {
                FileNameText(attachment.filename, style = MaterialTheme.typography.bodyMedium)
                Text(DocumentCards.detail(attachment), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            IconButton(onClick = { controller.openAttachment(attachment) }) { Icon(Icons.Outlined.OpenInNew, stringResource(R.string.common_open_in_another_app)) }
        }
    }
    if (viewing) PdfPreviewViewer(attachment, controller, onDismiss = { viewing = false })
}

private suspend fun fetchPreviewThumbnail(controller: AppController, attachmentId: String): ImageBitmap? = try {
    val bytes = controller.fetchBytes("/api/v1/attachments/$attachmentId/preview/thumbnail")
    withContext(Dispatchers.Default) { BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap() }
} catch (e: CancellationException) {
    throw e
} catch (e: Exception) {
    null
}

/**
 * The preview PDF opened with the platform's PdfRenderer. It renders one page at a time (not thread-safe), so every
 * use goes through [lock]; the page sizes are read once at open for the boxes of the list.
 */
private class PdfPages(file: File) : Closeable {
    private val descriptor = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
    private val renderer = PdfRenderer(descriptor)
    private val lock = Mutex()
    val sizes: List<Pair<Int, Int>> = (0 until renderer.pageCount).map { index ->
        renderer.openPage(index).use { it.width to it.height }
    }

    @Volatile private var closed = false
    private var released = false

    suspend fun render(index: Int, widthPx: Int): ImageBitmap? = lock.withLock {
        if (closed) { release(); return@withLock null }
        try {
            draw(index, widthPx)
        } finally {
            if (closed) release() // closed while this page was drawn
        }
    }

    private suspend fun draw(index: Int, widthPx: Int): ImageBitmap? =
        withContext(Dispatchers.IO) {
            val (w, h) = sizes[index]
            if (w <= 0 || h <= 0) return@withContext null
            val width = widthPx.coerceIn(1, 2400)
            val height = (width.toLong() * h / w).toInt().coerceIn(1, 2400 * 4)
            val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
            bitmap.eraseColor(AndroidColor.WHITE)
            renderer.openPage(index).use { it.render(bitmap, null, null, PdfRenderer.Page.RENDER_MODE_FOR_DISPLAY) }
            bitmap.asImageBitmap()
        }

    /** From the UI thread when the viewer goes; a page being drawn finishes first and then releases it. */
    override fun close() {
        closed = true
        if (lock.tryLock()) {
            try { release() } finally { lock.unlock() }
        }
    }

    private fun release() {
        if (released) return
        released = true
        runCatching { renderer.close() }
        runCatching { descriptor.close() }
    }
}

/** Every page of the preview PDF in a list (drawn as they come into view), with 閉じる and 「他のアプリで開く」. */
@Composable
internal fun PdfPreviewViewer(attachment: AttachmentOut, controller: AppController, onDismiss: () -> Unit) {
    val context = LocalContext.current
    var pages by remember(attachment.id) { mutableStateOf<PdfPages?>(null) }
    var error by remember(attachment.id) { mutableStateOf<String?>(null) }
    var attempt by remember(attachment.id) { mutableIntStateOf(0) }
    LaunchedEffect(attachment.id, attempt) {
        error = null
        try {
            val bytes = controller.fetchBytes("/api/v1/attachments/${attachment.id}/preview/pdf")
            val opened = withContext(Dispatchers.IO) {
                val file = File(File(context.cacheDir, "previews"), DocumentCards.cachePath(attachment.id))
                file.parentFile?.mkdirs()
                file.writeBytes(bytes)
                PdfPages(file)
            }
            pages = opened
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = if (e is java.io.IOException || e is SecurityException) L10n.str(R.string.document_preview_couldnt_show_this_preview) else controller.describe(e)
        }
    }
    val current = pages
    DisposableEffect(current) { onDispose { current?.close() } }
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize()) {
            Column(Modifier.fillMaxSize().safeDrawingPadding()) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = onDismiss) { Icon(Icons.Outlined.Close, stringResource(R.string.document_preview_close_preview)) }
                    Column(Modifier.weight(1f)) {
                        FileNameText(attachment.filename)
                        val count = current?.sizes?.size ?: attachment.preview?.pages
                        DocumentCards.pagesLabel(count)?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    }
                    IconButton(onClick = { controller.openAttachment(attachment) }) { Icon(Icons.Outlined.OpenInNew, stringResource(R.string.common_open_in_another_app)) }
                }
                Box(Modifier.weight(1f).fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant), contentAlignment = Alignment.Center) {
                    when {
                        current != null -> PdfPageList(current)
                        error != null -> Column(Modifier.padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                            Text(stringResource(R.string.document_preview_couldnt_load_the_preview), style = MaterialTheme.typography.titleMedium)
                            Text(error!!, Modifier.padding(vertical = 12.dp))
                            Button(onClick = { attempt += 1 }) { Text(stringResource(R.string.common_retry)) }
                        }
                        else -> CircularProgressIndicator()
                    }
                }
            }
        }
    }
}

@Composable
private fun PdfPageList(pages: PdfPages) {
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val widthPx = with(LocalDensity.current) { (maxWidth - 24.dp).roundToPx() }
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            itemsIndexed(pages.sizes) { index, (w, h) ->
                var bitmap by remember(index, widthPx) { mutableStateOf<ImageBitmap?>(null) }
                LaunchedEffect(index, widthPx) { bitmap = runCatching { pages.render(index, widthPx) }.getOrNull() }
                val ratio = if (w > 0 && h > 0) w.toFloat() / h else 0.707f
                Box(
                    Modifier.fillMaxWidth().aspectRatio(ratio).background(Color.White)
                        .semantics { contentDescription = L10n.str(R.string.document_preview_page, index + 1) },
                    contentAlignment = Alignment.Center,
                ) {
                    val image = bitmap
                    if (image != null) Image(image, contentDescription = null, contentScale = ContentScale.FillWidth, modifier = Modifier.fillMaxSize())
                    else CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
                }
            }
        }
    }
}
