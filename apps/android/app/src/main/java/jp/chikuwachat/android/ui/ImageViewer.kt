package jp.chikuwachat.android.ui

import android.graphics.BitmapFactory
import android.graphics.ImageDecoder
import android.os.Build
import androidx.compose.foundation.Image
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.OpenInNew
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import jp.chikuwachat.android.api.AttachmentOut
import jp.chikuwachat.android.app.AppController
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
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

/** Authenticated, in-app still-image preview; another app remains available from the toolbar. */
@Composable
fun ImageViewer(attachment: AttachmentOut, controller: AppController, onDismiss: () -> Unit) {
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
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize()) {
            Column(Modifier.fillMaxSize().safeDrawingPadding()) {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    IconButton(onClick = onDismiss) { Icon(Icons.Outlined.Close, stringResource(R.string.image_viewer_close_image)) }
                    Text(attachment.filename, Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    IconButton(onClick = { controller.openAttachment(attachment) }) { Icon(Icons.Outlined.OpenInNew, stringResource(R.string.common_open_in_another_app)) }
                }
                Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                    val bitmap = image
                    if (bitmap != null) ZoomableImage(bitmap, attachment.filename)
                    else if (error != null) Column(Modifier.padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(stringResource(R.string.image_viewer_couldnt_load_the_image), style = MaterialTheme.typography.titleMedium)
                        Text(error!!, Modifier.padding(vertical = 12.dp))
                        Button(onClick = { attempt += 1 }) { Text(stringResource(R.string.common_retry)) }
                    } else CircularProgressIndicator()
                }
            }
        }
    }
}

@Composable
private fun ZoomableImage(image: ImageBitmap, filename: String) {
    var scale by remember(image) { mutableFloatStateOf(1f) }
    var offset by remember(image) { mutableStateOf(Offset.Zero) }
    var viewport by remember { mutableStateOf(IntSize.Zero) }
    fun transform(nextScale: Float, nextOffset: Offset) {
        scale = nextScale.coerceIn(1f, 5f)
        val limit = imagePanLimit(image.width, image.height, viewport.width, viewport.height, scale)
        offset = Offset(nextOffset.x.coerceIn(-limit.x, limit.x), nextOffset.y.coerceIn(-limit.y, limit.y))
    }
    Box(
        Modifier.fillMaxSize().clipToBounds().onSizeChanged { viewport = it; transform(scale, offset) }
            .pointerInput(image) {
                detectTransformGestures { centroid, pan, zoom, _ ->
                    val nextScale = (scale * zoom).coerceIn(1f, 5f)
                    val anchor = centroid - Offset(size.width / 2f, size.height / 2f)
                    transform(nextScale, (offset - anchor) * (nextScale / scale) + anchor + pan)
                }
            }
            .pointerInput(image) {
                detectTapGestures(onDoubleTap = { tap ->
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
