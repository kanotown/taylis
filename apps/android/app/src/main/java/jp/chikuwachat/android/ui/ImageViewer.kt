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
    enum class Gesture { PULL, TRANSFORM }

    /**
     * A one-finger drag mostly downwards on a photo that is not zoomed pulls it; anything else (sideways, upwards, a
     * pinch, or any drag while zoomed, which pans) stays with the zoom and pan, for the whole gesture.
     */
    fun decide(dx: Float, dy: Float, scale: Float, pointers: Int): Gesture =
        if (pointers == 1 && scale <= 1.001f && dy > 0f && dy > abs(dx)) Gesture.PULL else Gesture.TRANSFORM
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
 * Authenticated, in-app still-image preview; another app remains available from the toolbar. Pulled down (the photo
 * when not zoomed, or the header) it follows the finger and closes past a distance or on a flick, else springs back
 * ([PullToClose]); ✕, back and TalkBack's dismiss close it too.
 */
@Composable
fun ImageViewer(
    attachment: AttachmentOut, controller: AppController, onDismiss: () -> Unit,
    /** M166 (docs/DRIVE.md §26): a drive file goes to another app the drive's way (streamed to disk); null: the attachment's. */
    onOpenElsewhere: (() -> Unit)? = null,
) {
    var image by remember(attachment.id) { mutableStateOf<ImageBitmap?>(null) }
    var error by remember(attachment.id) { mutableStateOf<String?>(null) }
    var attempt by remember(attachment.id) { mutableIntStateOf(0) }
    LaunchedEffect(attachment.id, attempt) {
        image = null
        error = null
        try {
            val bytes = controller.fetchBytes("/api/v1/attachments/${attachment.id}/content")
            image = withContext(Dispatchers.Default) {
                if (Build.VERSION.SDK_INT >= 28) {
                    // ImageDecoder also applies EXIF orientation to phone photos.
                    ImageDecoder.decodeBitmap(ImageDecoder.createSource(ByteBuffer.wrap(bytes))) { decoder, info, _ ->
                        decoder.setTargetSampleSize(imageSampleSize(info.size.width, info.size.height))
                        decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
                    }.asImageBitmap()
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
            }
            if (image == null) error = L10n.str(R.string.image_viewer_couldnt_show_this_image)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            error = controller.describe(e)
        }
    }
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
        var chromeWanted by rememberSaveable(attachment.id) { mutableStateOf(true) }
        val chrome = ImageChrome.shown(chromeWanted, touchExploration, loaded = image != null)
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
        Box(
            Modifier.fillMaxSize().onSizeChanged { pull.extent = it.height.toFloat() }
                .graphicsLayer { translationY = pull.offset }
                .background(background)
                .semantics { dismiss(closeLabel) { onDismiss(); true } },
        ) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                val bitmap = image
                if (bitmap != null) ZoomableImage(bitmap, attachment.filename, pull, onTap = { chromeWanted = ImageChrome.toggled(chromeWanted, touchExploration) })
                else if (error != null) Column(Modifier.safeDrawingPadding().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(stringResource(R.string.image_viewer_couldnt_load_the_image), style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurface)
                    Text(error!!, Modifier.padding(vertical = 12.dp), color = MaterialTheme.colorScheme.onSurface)
                    Button(onClick = { attempt += 1 }) { Text(stringResource(R.string.common_retry)) }
                } else CircularProgressIndicator()
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
                        FileNameText(attachment.filename, Modifier.weight(1f))
                        IconButton(onClick = { onOpenElsewhere?.invoke() ?: controller.openAttachment(attachment) }) { Icon(Icons.Outlined.OpenInNew, stringResource(R.string.common_open_in_another_app)) }
                    }
                }
            }
        }
    }
}

@Composable
private fun ZoomableImage(image: ImageBitmap, filename: String, pull: PullToClose, onTap: () -> Unit) {
    val touchSlop = LocalViewConfiguration.current.touchSlop
    var scale by remember(image) { mutableFloatStateOf(1f) }
    var offset by remember(image) { mutableStateOf(Offset.Zero) }
    var viewport by remember { mutableStateOf(IntSize.Zero) }
    val placed = remember { arrayOfNulls<LayoutCoordinates>(1) }
    fun transform(nextScale: Float, nextOffset: Offset) {
        scale = nextScale.coerceIn(1f, 5f)
        val limit = imagePanLimit(image.width, image.height, viewport.width, viewport.height, scale)
        offset = Offset(nextOffset.x.coerceIn(-limit.x, limit.x), nextOffset.y.coerceIn(-limit.y, limit.y))
    }
    Box(
        Modifier.fillMaxSize().clipToBounds().onSizeChanged { viewport = it; transform(scale, offset) }
            .onGloballyPositioned { placed[0] = it }
            .pointerInput(image) {
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
                                    gesture = ImageDismiss.decide(moved.x, moved.y, scale, pointers)
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
                        }
                    }
                    if (gesture == ImageDismiss.Gesture.PULL) pull.release(velocity.calculateVelocity().y)
                }
            }
            .pointerInput(image) {
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
        Image(image, contentDescription = filename, contentScale = ContentScale.Fit,
            modifier = Modifier.fillMaxSize().graphicsLayer {
                scaleX = scale; scaleY = scale; translationX = offset.x; translationY = offset.y
            })
    }
}
