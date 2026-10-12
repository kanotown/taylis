package jp.chikuwachat.android.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color as AndroidColor
import android.graphics.pdf.PdfRenderer
import android.os.ParcelFileDescriptor
import android.view.WindowManager
import androidx.compose.animation.core.LinearOutSlowInEasing
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animate
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.Stable
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.composed
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.platform.LocalViewConfiguration
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.dismiss
import androidx.compose.ui.unit.Velocity
import androidx.compose.ui.window.DialogWindowProvider
import kotlin.math.abs
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
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

/**
 * Every page of the preview PDF in a list (drawn as they come into view), with 閉じる and 「他のアプリで開く」. Pulled down
 * from the header, or from the first page's top, it follows the finger and closes past a distance or on a flick, else
 * springs back ([PullToClose]); the back gesture and TalkBack's dismiss close it too.
 */
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
        val scope = rememberCoroutineScope()
        val density = LocalDensity.current.density
        val pull = remember { PullToClose(scope, density, onDismiss) }
        val listState = rememberLazyListState()
        val window = (LocalView.current.parent as? DialogWindowProvider)?.window
        // The conversation shows through as the document is pulled away: the dialog's dim fades with the distance.
        LaunchedEffect(window) {
            window ?: return@LaunchedEffect
            window.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
            snapshotFlow { pull.progress }.collect { window.setDimAmount(0.6f * (1f - it)) }
        }
        val closeLabel = stringResource(R.string.document_preview_close_preview)
        Surface(
            Modifier.fillMaxSize().onSizeChanged { pull.extent = it.height.toFloat() }
                .graphicsLayer { translationY = pull.offset }
                .semantics { dismiss(closeLabel) { onDismiss(); true } },
        ) {
            Column(Modifier.fillMaxSize().safeDrawingPadding()) {
                Row(
                    // Pulled down from the header at any time (as from the first page's top below).
                    Modifier.fillMaxWidth().pullToCloseHandle(pull),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    IconButton(onClick = onDismiss) { Icon(Icons.Outlined.Close, stringResource(R.string.document_preview_close_preview)) }
                    Column(Modifier.weight(1f)) {
                        FileNameText(attachment.filename)
                        val count = current?.sizes?.size ?: attachment.preview?.pages
                        DocumentCards.pagesLabel(count)?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    }
                    IconButton(onClick = { controller.openAttachment(attachment) }) { Icon(Icons.Outlined.OpenInNew, stringResource(R.string.common_open_in_another_app)) }
                }
                Box(
                    Modifier.weight(1f).fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant)
                        .pointerInput(listState) {
                            // Whether the pages were at their top when the finger came down: only such a drag may pull.
                            awaitEachGesture {
                                awaitFirstDown(requireUnconsumed = false, pass = PointerEventPass.Initial)
                                pull.startedAtTop = !listState.canScrollBackward
                            }
                        }
                        .nestedScroll(pull.connection),
                    contentAlignment = Alignment.Center,
                ) {
                    when {
                        current != null -> PdfPageList(current, listState)
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
private fun PdfPageList(pages: PdfPages, state: LazyListState) {
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val widthPx = with(LocalDensity.current) { (maxWidth - 24.dp).roundToPx() }
        LazyColumn(Modifier.fillMaxSize(), state = state, contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
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

/**
 * Pull a document down to close it, as photos close on iOS (`ViewerDismiss`): from its header at any time, from the
 * pages only with a drag that began while they were at their top (otherwise the drag scrolls the list). Distances and
 * speeds in px; `density` turns the dp rules into px.
 */
internal object DocumentDismiss {
    /** dp/s outward that closes whatever the distance (a flick), and back towards the start that keeps it open. */
    const val FLICK_SPEED = 900f
    const val RETURN_SPEED = 300f

    /** How far a slow pull must go to close: about a fifth of the screen, at most 140 dp. */
    fun threshold(extent: Float, density: Float): Float = minOf(140f * density, extent * 0.22f)

    /** 0…1: how far the pull has gone, for the backdrop's fade (gone at half the screen). */
    fun progress(offset: Float, extent: Float): Float = if (extent > 0f) minOf(1f, abs(offset) / (extent * 0.5f)) else 0f

    fun shouldClose(offset: Float, velocity: Float, extent: Float, density: Float): Boolean {
        if (offset <= 0f || density <= 0f) return false
        val speed = velocity / density
        if (speed > FLICK_SPEED) return true
        if (speed < -RETURN_SPEED) return false
        return offset > threshold(extent, density)
    }

    /** What a pull takes of a drag's move before the list scrolls: a move back up while pulled, down to where it began. */
    fun takeBeforeList(pull: Float, availableY: Float, byUser: Boolean): Float =
        if (byUser && pull > 0f && availableY < 0f) maxOf(availableY, -pull) else 0f

    /** What a pull takes of what the list left: a move down by the finger in a drag that began at the top. */
    fun takeAfterList(availableY: Float, startedAtTop: Boolean, byUser: Boolean): Float =
        if (byUser && startedAtTop && availableY > 0f) availableY else 0f

    /** The document's offset for a drag: it follows the finger down, not above where it was. */
    fun pulled(pull: Float, delta: Float): Float = maxOf(0f, pull + delta)
}

/**
 * The document viewer's pull to close: the offset (the dialog's content follows the finger), the list's nested scroll
 * that feeds it, and the release that closes past a distance or on a flick (the content carries on down, then
 * [onClose]) or springs back.
 */
@Stable
internal class PullToClose(private val scope: CoroutineScope, private val density: Float, private val onClose: () -> Unit) {
    var offset by mutableFloatStateOf(0f)
        private set
    var extent by mutableFloatStateOf(0f)
    var startedAtTop = true
    private var closing = false
    private var settle: Job? = null

    val progress: Float get() = DocumentDismiss.progress(offset, extent)

    fun drag(delta: Float) {
        if (closing) return
        settle?.cancel()
        offset = DocumentDismiss.pulled(offset, delta)
    }

    fun release(velocity: Float) {
        if (closing || offset == 0f) return
        settle?.cancel()
        if (DocumentDismiss.shouldClose(offset, velocity, extent, density)) {
            closing = true
            val distance = (extent - offset).coerceAtLeast(0f)
            val millis = (distance / maxOf(velocity, 1500f) * 1000f).toInt().coerceIn(120, 300)
            settle = scope.launch {
                animate(offset, extent, animationSpec = tween(millis, easing = LinearOutSlowInEasing)) { v, _ -> offset = v }
                onClose()
            }
        } else {
            settle = scope.launch {
                animate(offset, 0f, initialVelocity = velocity,
                    animationSpec = spring(dampingRatio = 0.85f, stiffness = Spring.StiffnessMediumLow)) { v, _ -> offset = v }
            }
        }
    }

    val connection = object : NestedScrollConnection {
        override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
            val take = DocumentDismiss.takeBeforeList(offset, available.y, source == NestedScrollSource.UserInput)
            if (take != 0f) drag(take)
            return Offset(0f, take)
        }

        override fun onPostScroll(consumed: Offset, available: Offset, source: NestedScrollSource): Offset {
            val take = DocumentDismiss.takeAfterList(available.y, startedAtTop, source == NestedScrollSource.UserInput)
            if (take != 0f) drag(take)
            return Offset(0f, take)
        }

        override suspend fun onPreFling(available: Velocity): Velocity {
            if (offset == 0f) return Velocity.Zero
            release(available.y)
            return available
        }
    }
}

/**
 * A strip that pulls the viewer at any time (its header). The strip moves with the pull, so its local positions lag the
 * finger (a `draggable` followed it at about half speed): the move and the release speed are read in the window's
 * coordinates.
 */
internal fun Modifier.pullToCloseHandle(pull: PullToClose): Modifier = composed {
    val placed = remember { arrayOfNulls<LayoutCoordinates>(1) }
    val touchSlop = LocalViewConfiguration.current.touchSlop
    onGloballyPositioned { placed[0] = it }.pointerInput(pull) {
        awaitEachGesture {
            val down = awaitFirstDown(requireUnconsumed = false)
            fun inWindow(position: Offset): Offset = placed[0]?.takeIf { it.isAttached }?.localToWindow(position) ?: position
            val start = inWindow(down.position)
            var last = start
            var pulling = false
            val velocity = VelocityTracker()
            velocity.addPosition(down.uptimeMillis, start)
            while (true) {
                val event = awaitPointerEvent()
                val change = event.changes.firstOrNull { it.id == down.id } ?: break
                if (!change.pressed) break
                if (!pulling && change.isConsumed) return@awaitEachGesture
                val now = inWindow(change.position)
                velocity.addPosition(change.uptimeMillis, now)
                if (!pulling) {
                    val moved = now - start
                    if (moved.getDistance() <= touchSlop) continue
                    if (abs(moved.y) <= abs(moved.x)) return@awaitEachGesture // sideways: not a pull
                    pulling = true
                    last = now
                }
                pull.drag(now.y - last.y)
                last = now
                change.consume()
            }
            if (pulling) pull.release(velocity.calculateVelocity().y)
        }
    }
}
