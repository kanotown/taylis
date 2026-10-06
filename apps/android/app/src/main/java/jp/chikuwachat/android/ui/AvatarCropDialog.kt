package jp.chikuwachat.android.ui

import android.graphics.Bitmap
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculateCentroid
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.isSpecified
import androidx.compose.ui.geometry.RoundRect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChanged
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import jp.chikuwachat.android.platform.AvatarPhoto
import kotlin.math.min
import kotlin.math.roundToInt
import jp.chikuwachat.android.R
import androidx.compose.ui.res.stringResource

/** Choose the square of a picked photo for the profile picture (M16g): drag to move; pinch or the slider to zoom. */
@Composable
fun AvatarCropDialog(bitmap: Bitmap, onCancel: () -> Unit, onDone: (ByteArray) -> Unit) {
    val image = remember(bitmap) { bitmap.asImageBitmap() }
    val width = bitmap.width.toFloat()
    val height = bitmap.height.toFloat()
    val margin = with(LocalDensity.current) { 16.dp.toPx() }
    var crop by remember { mutableStateOf(AvatarCrop()) }
    var frame by remember { mutableFloatStateOf(0f) }
    var stage by remember { mutableStateOf(IntSize.Zero) }

    Dialog(onDismissRequest = onCancel, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.surface) {
            Column(Modifier.fillMaxSize()) {
                Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    TextButton(onClick = onCancel) { Text(stringResource(R.string.common_cancel)) }
                    Text(stringResource(R.string.avatar_crop_dialog_choose_the_photo_area), Modifier.weight(1f), textAlign = TextAlign.Center, style = MaterialTheme.typography.titleMedium)
                    TextButton(onClick = { onDone(AvatarPhoto.render(bitmap, crop, frame)) }, enabled = frame > 1f) { Text(stringResource(R.string.avatar_crop_dialog_set)) }
                }
                Box(
                    Modifier
                        .weight(1f)
                        .fillMaxWidth()
                        .background(Color.Black)
                        .clipToBounds()
                        .onSizeChanged { size ->
                            stage = size
                            frame = min(size.width, size.height) - 2 * margin
                            crop = crop.clamped(width, height, frame)
                        }
                        .pointerInput(bitmap) {
                            // Not detectTransformGestures: it ignores the fingers until they pass the touch slop, so
                            // the picture stuck and then lurched ("first move jumps"). Nothing else in this dialog
                            // competes for the touches, so every move is applied from the first event, pinch and pan
                            // together, about the fingers' centroid. Pointers joining or leaving are left out of that
                            // event's change by calculateZoom/calculatePan, so a second finger does not jump either.
                            awaitEachGesture {
                                awaitFirstDown(requireUnconsumed = false)
                                do {
                                    val event = awaitPointerEvent()
                                    val zoomChange = event.calculateZoom()
                                    val pan = event.calculatePan()
                                    val centroid = event.calculateCentroid(useCurrent = false)
                                    if (centroid.isSpecified && (zoomChange != 1f || pan != Offset.Zero)) {
                                        crop = crop.transformed(
                                            zoomChange, pan.x, pan.y,
                                            centroid.x - stage.width / 2f, centroid.y - stage.height / 2f,
                                            width, height, frame,
                                        )
                                    }
                                    event.changes.forEach { if (it.positionChanged()) it.consume() }
                                } while (event.changes.any { it.pressed })
                            }
                        },
                ) {
                    Canvas(Modifier.fillMaxSize()) {
                        if (frame <= 1f) return@Canvas
                        val scale = AvatarCrop.scale(width, height, frame, crop.zoom)
                        val shownWidth = width * scale
                        val shownHeight = height * scale
                        drawImage(
                            image,
                            dstOffset = IntOffset((center.x + crop.x - shownWidth / 2).roundToInt(), (center.y + crop.y - shownHeight / 2).roundToInt()),
                            dstSize = IntSize(shownWidth.roundToInt(), shownHeight.roundToInt()),
                            filterQuality = FilterQuality.Medium,
                        )
                        // The avatar's rounded square; everything outside it is dimmed.
                        val square = Rect(center, frame / 2)
                        val corner = CornerRadius(frame * 0.22f)
                        val outside = Path().apply {
                            fillType = PathFillType.EvenOdd
                            addRect(Rect(Offset.Zero, size))
                            addRoundRect(RoundRect(square, corner))
                        }
                        drawPath(outside, Color.Black.copy(alpha = 0.55f))
                        drawRoundRect(Color.White.copy(alpha = 0.9f), topLeft = square.topLeft, size = square.size, cornerRadius = corner, style = Stroke(width = 2.dp.toPx()))
                    }
                }
                Row(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text("−", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Slider(
                        value = crop.zoom,
                        onValueChange = { crop = crop.zoomed(it, 0f, 0f, width, height, frame) },
                        valueRange = 1f..AvatarCrop.MAX_ZOOM,
                        modifier = Modifier.weight(1f),
                    )
                    // i18n: keep (a glyph)
                    Text("＋", color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Text(
                    stringResource(R.string.avatar_crop_dialog_drag_to_move_pinch_or_use),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.fillMaxWidth().padding(bottom = 16.dp),
                )
            }
        }
    }
}
