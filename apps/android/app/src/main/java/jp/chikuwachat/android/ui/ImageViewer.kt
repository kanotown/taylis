package jp.chikuwachat.android.ui

import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.os.Build
import androidx.compose.foundation.Image
import android.view.WindowManager
import android.view.accessibility.AccessibilityManager
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.platform.LocalContext
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculateCentroid
import androidx.compose.foundation.gestures.calculateCentroidSize
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.OpenInNew
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.HighQuality
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.sync.AlbumRules
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChanged
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.platform.LocalViewConfiguration
import androidx.compose.ui.semantics.dismiss
import androidx.compose.ui.window.DialogWindowProvider
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.LayoutCoordinates
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import jp.chikuwachat.android.api.AttachmentOut
import jp.chikuwachat.android.app.AppController
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlin.math.abs
import kotlin.math.min
import java.nio.ByteBuffer
import jp.chikuwachat.android.R
import androidx.compose.ui.res.stringResource
import jp.chikuwachat.android.L10n

/** Keep decoded images bounded even when the attachment is a very large panorama. */
internal fun imageSampleSize(width: Int, height: Int): Int {
    var sample = 1
    while (width / sample > 4096 || height / sample > 4096 || width.toLong() * height / sample / sample > 8_000_000) sample *= 2
    return sample
}

/** The fit image may be smaller than the viewport in one axis; never pan that axis into empty space. */
internal fun imagePanLimit(imageWidth: Int, imageHeight: Int, viewWidth: Int, viewHeight: Int, scale: Float): Offset {
    if (imageWidth <= 0 || imageHeight <= 0 || viewWidth <= 0 || viewHeight <= 0) return Offset.Zero
    val fit = min(viewWidth.toFloat() / imageWidth, viewHeight.toFloat() / imageHeight)
    return Offset(((imageWidth * fit * scale - viewWidth) / 2).coerceAtLeast(0f), ((imageHeight * fit * scale - viewHeight) / 2).coerceAtLeast(0f))
}

/**
 * A photo pulled down closes, as a document does (docs/MOBILE_UI.md §22, [DocumentDismiss] for the release): what a
 * drag on the photo becomes is decided once it passes the touch slop, by its first direction. Apart from Compose so it
 * can be unit tested.
 */
internal object ImageDismiss {
    enum class Gesture { PULL, TRANSFORM, PAGE }

    /**
     * A one-finger drag mostly downwards on a photo that is not zoomed pulls it; anything else (sideways, upwards, a
     * pinch, or any drag while zoomed, which pans) stays with the zoom and pan, for the whole gesture. AL4: among
     * several photos ([paging]) a one-finger sideways drag at the fit size turns the page instead.
     */
    fun decide(dx: Float, dy: Float, scale: Float, pointers: Int, paging: Boolean = false): Gesture = when {
        pointers == 1 && scale <= 1.001f && dy > 0f && dy > abs(dx) -> Gesture.PULL
        paging && pointers == 1 && scale <= 1.001f && abs(dx) >= abs(dy) -> Gesture.PAGE
        else -> Gesture.TRANSFORM
    }
}

/**
 * 2026-10-27 (docs/MOBILE_UI.md §22.5): a single tap on the photo hides the viewer's bar and the system's bars (the photo
 * alone on black), another brings them back. Never hidden while TalkBack explores by touch (its controls stay
 * reachable) nor before the photo is there (loading, an error and its 「再試行」). Apart from Compose so it can be tested.
 */
internal object ImageChrome {
    fun shown(wanted: Boolean, touchExploration: Boolean, loaded: Boolean): Boolean = wanted || touchExploration || !loaded

    /** What a tap on the photo asks for; with TalkBack on it changes nothing. */
    fun toggled(wanted: Boolean, touchExploration: Boolean): Boolean = if (touchExploration) wanted else !wanted

    /** The fade of the bar and the background (ms). */
    const val FADE_MS = 180
}

/**
 * One page of the photo viewer. [display]: read the display-size image first (AL1, docs/ALBUMS.md §6: 2048 px; the
 * server answers the original raster image when it has none) and the original only on 「元の画像を開く」 or a zoom past
 * it; false: the original at once. [subtitle]: the line under the name (撮影日時 · 位置情報あり). A [video] page shows
 * its poster and a play button ([onPlayVideo]).
 */
data class ViewerPhoto(
    val attachment: AttachmentOut,
    val display: Boolean = false,
    val subtitle: String? = null,
    val video: Boolean = false,
    val key: String = attachment.id,
)

/** The bytes of display images read ahead of the viewer and the slideshow (the next two, §6.1), about 24 MB at most. */
internal object DisplayBytes {
    private const val MAX = 24L * 1024 * 1024
    private var total = 0L
    private val held = object : LinkedHashMap<String, ByteArray>(16, 0.75f, true) {}

    fun peek(path: String): ByteArray? = synchronized(held) { held[path] }

    private fun keep(path: String, bytes: ByteArray) = synchronized(held) {
        held.put(path, bytes)?.let { total -= it.size }
        total += bytes.size
        val each = held.entries.iterator()
        while (total > MAX && each.hasNext()) {
            val eldest = each.next()
            if (eldest.key == path) continue
            total -= eldest.value.size
            each.remove()
        }
    }

    /** The bytes (from memory when read lately); a display image is kept, an original never (it can be tens of MB). */
    suspend fun load(controller: AppController, path: String, keepIt: Boolean = true): ByteArray {
        peek(path)?.let { return it }
        return controller.fetchBytes(path).also { if (keepIt && it.size < 8 * 1024 * 1024) keep(path, it) }
    }

    /** Reads ahead, quietly (a failure is read again when the page is shown). */
    suspend fun prefetch(controller: AppController, path: String) {
        if (peek(path) != null) return
        try {
            load(controller, path)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // shown later from the page itself
        }
    }
}

/**
 * The squares behind a transparent photo (docs/PREVIEWS.md §15): on the viewer's black a transparent PNG / WebP / GIF
 * looked the same as a black one. The same two greys and 8 dp squares as Desktop / Web and iOS.
 */
internal object Checkerboard {
    val LIGHT = Color(0xFFE6E6E6)
    val DARK = Color(0xFFC4C4C4)
    const val CELL_DP = 8f

    /** Whether the decoded photo has an alpha channel (a JPEG, a HEIC photo and an opaque display image do not). */
    fun shows(image: ImageBitmap): Boolean = image.hasAlpha

    /** Where a [ContentScale.Fit] image of `imageWidth` × `imageHeight` is drawn in a `width` × `height` box. */
    fun fitted(imageWidth: Int, imageHeight: Int, width: Float, height: Float): Rect {
        if (imageWidth <= 0 || imageHeight <= 0 || width <= 0f || height <= 0f) return Rect.Zero
        val scale = min(width / imageWidth, height / imageHeight)
        val w = imageWidth * scale
        val h = imageHeight * scale
        return Rect(Offset((width - w) / 2f, (height - h) / 2f), Size(w, h))
    }

    /**
     * The dark squares of the board over `rect` (the light ones are its fill), `cell` px each from its top left, as
     * (left, top, right, bottom); only those meeting `visible` (a zoomed photo's on-screen part).
     */
    inline fun forEachDarkCell(rect: Rect, cell: Float, visible: Rect = rect, action: (Float, Float, Float, Float) -> Unit) {
        if (rect.isEmpty || cell <= 0f) return
        val area = rect.intersect(visible)
        if (area.width <= 0f || area.height <= 0f) return
        val firstRow = ((area.top - rect.top) / cell).toInt()
        val firstColumn = ((area.left - rect.left) / cell).toInt()
        var row = firstRow
        var y = rect.top + row * cell
        while (y < area.bottom) {
            var column = firstColumn
            var x = rect.left + column * cell
            while (x < area.right) {
                if ((row + column) % 2 == 1) action(x, y, min(x + cell, rect.right), min(y + cell, rect.bottom))
                x += cell
                column++
            }
            y += cell
            row++
        }
    }

    /** The part of a box of `size` on the screen when its layer is scaled by `scale` about its centre and moved by `offset`. */
    fun visible(size: Size, scale: Float, offset: Offset): Rect {
        if (scale <= 0f) return Rect(Offset.Zero, size)
        val centre = Offset(size.width / 2f, size.height / 2f)
        fun back(screen: Offset) = centre + (screen - offset - centre) / scale
        return Rect(back(Offset.Zero), back(Offset(size.width, size.height)))
    }
}

private fun DrawScope.drawCheckerboard(rect: Rect, cell: Float, visible: Rect) {
    if (rect.isEmpty) return
    drawRect(Checkerboard.LIGHT, rect.topLeft, rect.size)
    Checkerboard.forEachDarkCell(rect, cell, visible) { left, top, right, bottom ->
        drawRect(Checkerboard.DARK, Offset(left, top), Size(right - left, bottom - top))
    }
}

/** A photo's bytes as a bitmap bounded in size ([imageSampleSize]), its EXIF orientation applied; null: not an image. */
internal fun decodePhoto(bytes: ByteArray): ImageBitmap? =
    if (Build.VERSION.SDK_INT >= 28) {
        // ImageDecoder also applies EXIF orientation to phone photos (and reads HEIF).
        runCatching {
            ImageDecoder.decodeBitmap(ImageDecoder.createSource(ByteBuffer.wrap(bytes))) { decoder, info, _ ->
                decoder.setTargetSampleSize(imageSampleSize(info.size.width, info.size.height))
                decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
            }.asImageBitmap()
        }.getOrNull()
    } else {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
        val options = BitmapFactory.Options().apply { inSampleSize = imageSampleSize(bounds.outWidth, bounds.outHeight) }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)?.let { bitmap ->
            val orientation = runCatching {
                android.media.ExifInterface(bytes.inputStream()).getAttributeInt(android.media.ExifInterface.TAG_ORIENTATION, 1)
            }.getOrDefault(1)
            val matrix = android.graphics.Matrix().apply {
                when (orientation) {
                    2 -> setScale(-1f, 1f)
                    3 -> setRotate(180f)
                    4 -> setScale(1f, -1f)
                    5 -> { setRotate(90f); postScale(-1f, 1f) }
                    6 -> setRotate(90f)
                    7 -> { setRotate(-90f); postScale(-1f, 1f) }
                    8 -> setRotate(-90f)
                }
            }
            android.graphics.Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true).asImageBitmap()
        }
    }

/**
 * Authenticated, in-app still-image preview; another app remains available from the toolbar. Pulled down (the photo
 * when not zoomed, or the header) it follows the finger and closes past a distance or on a flick, else springs back
 * ([PullToClose]); ✕, back and TalkBack's dismiss close it too. A photo with a display image (AL1) shows that first.
 */
@Composable
fun ImageViewer(
    attachment: AttachmentOut, controller: AppController, onDismiss: () -> Unit,
    /** M166 (docs/DRIVE.md §26): a drive file goes to another app the drive's way (streamed to disk); null: the attachment's. */
    onOpenElsewhere: (() -> Unit)? = null,
) {
    val photos = remember(attachment) { listOf(ViewerPhoto(attachment, display = attachment.hasDisplay)) }
    PhotoViewer(photos, 0, controller, onDismiss, onOpenElsewhere = onOpenElsewhere?.let { open -> { _: Int -> open() } })
}

/**
 * AL4 (docs/ALBUMS.md §12, MOBILE_UI.md §22.8): the photo viewer over several photos — swiped left and right (a pager),
 * each page zoomed, pulled down to close and tapped to hide the bars as one photo was (§22.4, §22.5). The display images
 * of the two photos either side are read ahead. [onPage] tells the page shown (an album reads its next page near the
 * end); [menu] adds the ⋯'s items for the photo at an index (「写真に保存」, 「表紙にする」).
 */
@Composable
fun PhotoViewer(
    photos: List<ViewerPhoto>, initial: Int, controller: AppController, onDismiss: () -> Unit,
    onOpenElsewhere: ((Int) -> Unit)? = null,
    onPage: (Int) -> Unit = {},
    onPlayVideo: (Int) -> Unit = {},
    menu: (@Composable ColumnScope.(index: Int, close: () -> Unit) -> Unit)? = null,
) {
    if (photos.isEmpty()) { LaunchedEffect(Unit) { onDismiss() }; return }
    val pager = rememberPagerState(initialPage = initial.coerceIn(0, photos.lastIndex)) { photos.size }
    val current = pager.currentPage.coerceIn(0, photos.lastIndex)
    val photo = photos[current]
    LaunchedEffect(current) { onPage(current) }
    // §6.1: the display images of the next two and the one before read ahead (in that order).
    LaunchedEffect(current, photos.size) {
        listOf(current + 1, current + 2, current - 1, current - 2).filter { it in photos.indices }.map { photos[it] }
            .filter { it.display && !it.video }
            .forEach { DisplayBytes.prefetch(controller, AlbumRules.displayPath(it.attachment.id)) }
    }
    // 「元の画像を開く」, or a zoom past the display image: that page reads its original.
    val originals = remember { mutableStateMapOf<String, Boolean>() }
    val loaded = remember { mutableStateMapOf<String, Boolean>() }
    // Edge to edge (the system's bars drawn over the photo, hidden with the viewer's bar): the photo keeps its size
    // and place when the bars go or come back.
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        val scope = rememberCoroutineScope()
        val density = LocalDensity.current.density
        val pull = remember { PullToClose(scope, density, onDismiss) }
        val view = LocalView.current
        val window = (view.parent as? DialogWindowProvider)?.window
        // The conversation shows through as the photo is pulled away: the dialog's dim fades with the distance.
        LaunchedEffect(window) {
            window ?: return@LaunchedEffect
            window.addFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND)
            snapshotFlow { pull.progress }.collect { window.setDimAmount(0.6f * (1f - it)) }
        }
        // §22.5: a tap on the photo hides the bars (not while TalkBack explores by touch, nor before the photo is there).
        val accessibility = LocalContext.current.getSystemService(AccessibilityManager::class.java)
        var touchExploration by remember { mutableStateOf(accessibility?.isTouchExplorationEnabled == true) }
        DisposableEffect(accessibility) {
            val listener = AccessibilityManager.TouchExplorationStateChangeListener { touchExploration = it }
            accessibility?.addTouchExplorationStateChangeListener(listener)
            onDispose { accessibility?.removeTouchExplorationStateChangeListener(listener) }
        }
        var chromeWanted by rememberSaveable { mutableStateOf(true) }
        val chrome = ImageChrome.shown(chromeWanted, touchExploration, loaded = photo.video || loaded[photo.key] == true)
        val surface = MaterialTheme.colorScheme.surface
        val lightBars = surface.luminance() > 0.5f
        val bars = remember(window, view) { window?.let { WindowCompat.getInsetsController(it, view) } }
        DisposableEffect(window) {
            // The photo runs under the camera's cutout too: the window keeps its size when the bars hide.
            if (Build.VERSION.SDK_INT >= 28) window?.attributes = window?.attributes?.apply {
                layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            }
            bars?.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            // Leaving the viewer brings the system's bars back whatever it left them at.
            onDispose { bars?.show(WindowInsetsCompat.Type.systemBars()) }
        }
        SideEffect {
            bars ?: return@SideEffect
            // Light icons over the black (a swipe shows the bars there for a moment), the theme's otherwise.
            bars.isAppearanceLightStatusBars = chrome && lightBars
            bars.isAppearanceLightNavigationBars = chrome && lightBars
            if (chrome) bars.show(WindowInsetsCompat.Type.systemBars()) else bars.hide(WindowInsetsCompat.Type.systemBars())
        }
        val fade = tween<Float>(ImageChrome.FADE_MS)
        val background by animateColorAsState(if (chrome) surface else Color.Black, tween(ImageChrome.FADE_MS), label = "viewer background")
        val closeLabel = stringResource(R.string.image_viewer_close_image)
        val toggle = { chromeWanted = ImageChrome.toggled(chromeWanted, touchExploration) }
        Box(
            Modifier.fillMaxSize().onSizeChanged { pull.extent = it.height.toFloat() }
                .graphicsLayer { translationY = pull.offset }
                .background(background)
                .semantics { dismiss(closeLabel) { onDismiss(); true } },
        ) {
            HorizontalPager(
                state = pager, modifier = Modifier.fillMaxSize(), key = { photos.getOrNull(it)?.key ?: it },
                userScrollEnabled = photos.size > 1, beyondViewportPageCount = 0,
            ) { index ->
                val page = photos.getOrNull(index) ?: return@HorizontalPager
                if (page.video) VideoPosterPage(page, controller, onPlay = { onPlayVideo(index) })
                else PhotoPage(
                    page, controller, pull, paging = photos.size > 1, original = originals[page.key] == true,
                    onLoaded = { loaded[page.key] = it }, onTap = toggle,
                    onWantOriginal = { if (page.display) originals[page.key] = true },
                )
            }
            // The bar over the photo (its top edge under the status bar), fading out with a tap.
            AnimatedVisibility(chrome, Modifier.align(Alignment.TopCenter), enter = fadeIn(fade), exit = fadeOut(fade)) {
                Surface(color = surface.copy(alpha = 0.92f)) {
                    Row(
                        Modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Horizontal))
                            .pullToCloseHandle(pull),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        IconButton(onClick = onDismiss) { Icon(Icons.Outlined.Close, stringResource(R.string.image_viewer_close_image)) }
                        Column(Modifier.weight(1f)) {
                            FileNameText(photo.attachment.filename)
                            val line = listOfNotNull(
                                if (photos.size > 1) "${current + 1} / ${photos.size}" else null,
                                photo.subtitle?.takeIf { it.isNotEmpty() },
                            ).joinToString(" · ")
                            if (line.isNotEmpty()) Text(line, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
                        }
                        IconButton(onClick = { onOpenElsewhere?.invoke(current) ?: controller.openAttachment(photo.attachment) }) {
                            Icon(Icons.Outlined.OpenInNew, stringResource(R.string.common_open_in_another_app))
                        }
                        val canOriginal = photo.display && !photo.video && originals[photo.key] != true
                        if (menu != null || canOriginal) {
                            var open by remember { mutableStateOf(false) }
                            Box {
                                IconButton(onClick = { open = true }) { Icon(Icons.Outlined.MoreVert, stringResource(R.string.album_viewer_more)) }
                                DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                                    if (canOriginal) DropdownMenuItem(
                                        text = { Text(stringResource(R.string.album_open_original)) },
                                        leadingIcon = { Icon(Icons.Outlined.HighQuality, null) },
                                        onClick = { open = false; originals[photo.key] = true },
                                    )
                                    menu?.invoke(this, current) { open = false }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

/** A video among the photos: its poster and a play button (the player opens over the viewer). */
@Composable
private fun VideoPosterPage(page: ViewerPhoto, controller: AppController, onPlay: () -> Unit) {
    var poster by remember(page.key) { mutableStateOf<ImageBitmap?>(null) }
    if (page.attachment.hasPoster) LaunchedEffect(page.key) { poster = fetchThumbnail(controller, page.attachment.id) }
    Box(Modifier.fillMaxSize().pointerInput(page.key) { detectTapGestures(onTap = { onPlay() }) }, contentAlignment = Alignment.Center) {
        poster?.let { Image(it, contentDescription = page.attachment.filename, contentScale = ContentScale.Fit, modifier = Modifier.fillMaxSize()) }
        FilledTonalIconButton(onClick = onPlay, modifier = Modifier.size(72.dp)) {
            Icon(Icons.Outlined.PlayArrow, stringResource(R.string.album_play_video), modifier = Modifier.size(40.dp))
        }
    }
}

/** A photo page: its display image (or original), then the original when asked for, without blanking in between. */
@Composable
private fun PhotoPage(
    page: ViewerPhoto, controller: AppController, pull: PullToClose, paging: Boolean, original: Boolean,
    onLoaded: (Boolean) -> Unit, onTap: () -> Unit, onWantOriginal: () -> Unit,
) {
    var image by remember(page.key) { mutableStateOf<ImageBitmap?>(null) }
    var error by remember(page.key) { mutableStateOf<String?>(null) }
    var attempt by remember(page.key) { mutableIntStateOf(0) }
    LaunchedEffect(page.key, original, attempt) {
        error = null
        val id = page.attachment.id
        try {
            val bytes = if (page.display && !original) {
                try {
                    DisplayBytes.load(controller, AlbumRules.displayPath(id))
                } catch (e: ApiException) {
                    if (!AlbumRules.displayMissing(e)) throw e
                    controller.fetchBytes(AlbumRules.originalPath(id)) // 404 display_not_found: a HEIC, say
                }
            } else controller.fetchBytes(AlbumRules.originalPath(id))
            val decoded = withContext(Dispatchers.Default) { decodePhoto(bytes) }
            if (decoded != null) image = decoded
            else if (image == null) error = L10n.str(R.string.image_viewer_couldnt_show_this_image)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (image == null) error = controller.describe(e) // the display image stays when the original fails
        }
    }
    val bitmap = image
    LaunchedEffect(bitmap != null) { onLoaded(bitmap != null) }
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        if (bitmap != null) ZoomableImage(
            bitmap, page.key, page.attachment.filename, pull, paging, onTap = onTap,
            onScale = { scale -> if (!original && AlbumRules.wantsOriginal(scale, bitmap.width, page.attachment.width)) onWantOriginal() },
        )
        else if (error != null) Column(Modifier.safeDrawingPadding().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            Text(stringResource(R.string.image_viewer_couldnt_load_the_image), style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurface)
            Text(error!!, Modifier.padding(vertical = 12.dp), color = MaterialTheme.colorScheme.onSurface)
            Button(onClick = { attempt += 1 }) { Text(stringResource(R.string.common_retry)) }
        } else CircularProgressIndicator()
    }
}

@Composable
private fun ZoomableImage(
    image: ImageBitmap, pageKey: String, filename: String, pull: PullToClose, paging: Boolean, onTap: () -> Unit, onScale: (Float) -> Unit = {},
) {
    val touchSlop = LocalViewConfiguration.current.touchSlop
    // Kept by the page, not the bitmap: the original replacing the display image keeps the zoom and the place.
    var scale by remember(pageKey) { mutableFloatStateOf(1f) }
    var offset by remember(pageKey) { mutableStateOf(Offset.Zero) }
    var viewport by remember { mutableStateOf(IntSize.Zero) }
    val placed = remember { arrayOfNulls<LayoutCoordinates>(1) }
    val latestImage by rememberUpdatedState(image)
    val latestScale by rememberUpdatedState(onScale)
    fun transform(nextScale: Float, nextOffset: Offset) {
        scale = nextScale.coerceIn(1f, 5f)
        val limit = imagePanLimit(latestImage.width, latestImage.height, viewport.width, viewport.height, scale)
        offset = Offset(nextOffset.x.coerceIn(-limit.x, limit.x), nextOffset.y.coerceIn(-limit.y, limit.y))
        latestScale(scale)
    }
    Box(
        Modifier.fillMaxSize().clipToBounds().onSizeChanged { viewport = it; transform(scale, offset) }
            .onGloballyPositioned { placed[0] = it }
            .pointerInput(pageKey, paging) {
                // detectTransformGestures, plus the pull: past the slop the drag's first direction decides which.
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    var gesture: ImageDismiss.Gesture? = null
                    var moved = Offset.Zero
                    var zoomed = 1f
                    var pointers = 1
                    // The photo moves with the pull, so its local positions lag the finger: the pull and its speed
                    // follow the first finger in the window's coordinates.
                    fun inWindow(position: Offset): Offset = placed[0]?.takeIf { it.isAttached }?.localToWindow(position) ?: position
                    val velocity = VelocityTracker()
                    var last = inWindow(down.position)
                    var fingerMove = 0f
                    velocity.addPosition(down.uptimeMillis, last)
                    while (true) {
                        val event = awaitPointerEvent()
                        if (event.changes.any { it.isConsumed }) break
                        val pressed = event.changes.count { it.pressed }
                        if (pressed == 0) break
                        pointers = maxOf(pointers, pressed)
                        fingerMove = 0f
                        event.changes.firstOrNull { it.id == down.id && it.pressed }?.let {
                            val now = inWindow(it.position)
                            fingerMove = now.y - last.y
                            last = now
                            velocity.addPosition(it.uptimeMillis, now)
                        }
                        val zoom = event.calculateZoom()
                        val pan = event.calculatePan()
                        when (gesture) {
                            null -> {
                                moved += pan
                                zoomed *= zoom
                                val centroidSize = event.calculateCentroidSize(useCurrent = false)
                                if (moved.getDistance() > touchSlop || abs(1 - zoomed) * centroidSize > touchSlop) {
                                    gesture = ImageDismiss.decide(moved.x, moved.y, scale, pointers, paging)
                                }
                            }
                            ImageDismiss.Gesture.PULL -> {
                                pull.drag(fingerMove)
                                event.changes.forEach { if (it.positionChanged()) it.consume() }
                            }
                            ImageDismiss.Gesture.TRANSFORM -> {
                                val centroid = event.calculateCentroid(useCurrent = false)
                                if (zoom != 1f || pan != Offset.Zero) {
                                    val nextScale = (scale * zoom).coerceIn(1f, 5f)
                                    val anchor = centroid - Offset(size.width / 2f, size.height / 2f)
                                    transform(nextScale, (offset - anchor) * (nextScale / scale) + anchor + pan)
                                }
                                event.changes.forEach { if (it.positionChanged()) it.consume() }
                            }
                            // AL4: sideways at the fit size — the pager's (left unconsumed, it takes the drag).
                            ImageDismiss.Gesture.PAGE -> Unit
                        }
                    }
                    if (gesture == ImageDismiss.Gesture.PULL) pull.release(velocity.calculateVelocity().y)
                }
            }
            .pointerInput(pageKey) {
                // A single tap (the bars, §22.5) waits out the double tap's timeout, so a double tap only zooms.
                detectTapGestures(onTap = { onTap() }, onDoubleTap = { tap ->
                    if (scale > 1f) transform(1f, Offset.Zero)
                    else transform(2.5f, (Offset(size.width / 2f, size.height / 2f) - tap) * 1.5f)
                })
            }
            .semantics {
                customActions = listOf(
                    CustomAccessibilityAction(L10n.str(R.string.image_viewer_zoom_in)) { transform(scale * 1.5f, offset); true },
                    CustomAccessibilityAction(L10n.str(R.string.image_viewer_fit_to_screen)) { transform(1f, Offset.Zero); true },
                )
            },
    ) {
        val transparent = remember(image) { Checkerboard.shows(image) }
        val cellPx = with(LocalDensity.current) { Checkerboard.CELL_DP.dp.toPx() }
        Image(image, contentDescription = filename, contentScale = ContentScale.Fit,
            modifier = Modifier.fillMaxSize().graphicsLayer {
                scaleX = scale; scaleY = scale; translationX = offset.x; translationY = offset.y
            }.drawBehind {
                // §15 (PREVIEWS.md): drawn in the photo's layer, so it is the photo's rectangle at any zoom and place;
                // the squares are divided by the zoom to keep their size on the screen.
                if (transparent) {
                    drawCheckerboard(
                        Checkerboard.fitted(image.width, image.height, size.width, size.height), cellPx / scale,
                        Checkerboard.visible(size, scale, offset),
                    )
                }
            })
    }
}
