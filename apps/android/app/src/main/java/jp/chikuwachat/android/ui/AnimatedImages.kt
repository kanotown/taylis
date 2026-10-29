package jp.chikuwachat.android.ui

import android.content.Context
import android.graphics.ImageDecoder
import android.graphics.drawable.AnimatedImageDrawable
import android.graphics.drawable.Drawable
import android.net.ConnectivityManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import androidx.annotation.RequiresApi
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.background
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.painter.Painter
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.IntSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.nio.ByteBuffer
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sqrt

/**
 * Animated GIFs (and animated WebP in the viewer) move on the phone (docs/MOBILE_UI.md §22.10, user report 2026-10-29:
 * GIFs did not play). The server keeps a still JPEG thumbnail of the first frame and no display image for an animated
 * one, so the frames come from the original file, decoded by the platform's [ImageDecoder] into an
 * [AnimatedImageDrawable] (API 28+; it decodes frame by frame and holds only a couple of frames). Below API 28 the first
 * frame shows, as before.
 */
object AnimatedImageRules {
    /** A GIF tile in a conversation reads the original only up to this size; a larger one keeps its still and the badge. */
    const val TILE_MAX_BYTES = 8L shl 20
    /** How many tiles move at once; the others show their still and the badge until one stops. */
    const val MAX_PLAYING_TILES = 3
    /** One decoded frame at most (4 bytes a pixel): 16 MB, 2048 × 2048. A larger animation plays decoded smaller. */
    const val MAX_FRAME_BYTES = 16L shl 20

    /** Whether a conversation tile is a GIF (WebP is told apart only by its file: its tile stays still, the viewer plays it). */
    fun isGif(contentType: String, filename: String): Boolean =
        contentType.equals("image/gif", ignoreCase = true) || filename.endsWith(".gif", ignoreCase = true)

    /** What keeps the tiles still: 「アニメーションを削除」 (animator scale 0), Battery Saver and Data Saver. */
    data class Conditions(val reduceMotion: Boolean = false, val powerSave: Boolean = false, val dataSaver: Boolean = false) {
        val allowsMotion: Boolean get() = !reduceMotion && !powerSave && !dataSaver
    }

    /** Whether a tile in a conversation moves (while on the screen and given a slot). */
    fun tileAnimates(contentType: String, filename: String, sizeBytes: Long, conditions: Conditions, sdk: Int = Build.VERSION.SDK_INT): Boolean =
        sdk >= 28 && isGif(contentType, filename) && sizeBytes in 1..TILE_MAX_BYTES && conditions.allowsMotion

    /** Whether the bytes may hold an animation the platform plays (GIF, or WebP with its animation flag); null-safe sniff. */
    fun mayAnimate(bytes: ByteArray): Boolean {
        if (bytes.size >= 6 && String(bytes, 0, 4, Charsets.US_ASCII) == "GIF8") return true
        // RIFF....WEBPVP8X with the animation bit (0x02) in the flags byte.
        return bytes.size >= 21 && String(bytes, 0, 4, Charsets.US_ASCII) == "RIFF" && String(bytes, 8, 4, Charsets.US_ASCII) == "WEBP" &&
            String(bytes, 12, 4, Charsets.US_ASCII) == "VP8X" && (bytes[20].toInt() and 0x02) != 0
    }

    /**
     * The size to decode frames at: the image's own, smaller when a frame would pass [maxBytes], and for a tile ([fill],
     * its box in pixels) no more than the tile shows when the image fills it. Never larger than the image.
     */
    fun decodeSize(width: Int, height: Int, maxBytes: Long = MAX_FRAME_BYTES, fill: IntSize? = null): IntSize {
        if (width <= 0 || height <= 0) return IntSize(1, 1)
        var scale = 1.0
        val pixels = width.toDouble() * height
        val allowed = maxBytes / 4.0
        if (pixels > allowed) scale = sqrt(allowed / pixels)
        if (fill != null && fill.width > 0 && fill.height > 0) scale = min(scale, max(fill.width.toDouble() / width, fill.height.toDouble() / height))
        scale = min(scale, 1.0)
        return IntSize(max(1, floor(width * scale).toInt()), max(1, floor(height * scale).toInt()))
    }
}

/** The tiles moving at once ([AnimatedImageRules.MAX_PLAYING_TILES]); snapshot state, so a waiting tile sees a slot free up. */
class AnimatedTileSlots(val limit: Int) {
    private val held = mutableStateListOf<Any>()
    val count: Int get() = held.size

    /** true when [key] has a slot (already, or now). */
    fun claim(key: Any): Boolean {
        if (key in held) return true
        if (held.size >= limit) return false
        held.add(key)
        return true
    }

    fun release(key: Any) { held.remove(key) }

    companion object {
        val shared = AnimatedTileSlots(AnimatedImageRules.MAX_PLAYING_TILES)
    }
}

/** The device's settings that keep tiles still, read as the tile comes on the screen. */
internal fun motionConditions(context: Context): AnimatedImageRules.Conditions {
    val scale = runCatching { Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) }.getOrDefault(1f)
    val power = context.getSystemService(PowerManager::class.java)?.isPowerSaveMode == true
    val data = context.getSystemService(ConnectivityManager::class.java)?.restrictBackgroundStatus == ConnectivityManager.RESTRICT_BACKGROUND_STATUS_ENABLED
    return AnimatedImageRules.Conditions(reduceMotion = scale == 0f, powerSave = power, dataSaver = data)
}

/**
 * The animation in [bytes] decoded at [size] (given the image's own width and height), looping forever whatever the
 * file says; null for a still image, one the platform cannot read, or below API 28.
 */
internal fun decodeAnimation(bytes: ByteArray, size: (Int, Int) -> IntSize): Drawable? {
    if (Build.VERSION.SDK_INT < 28 || !AnimatedImageRules.mayAnimate(bytes)) return null
    return decodeAnimated28(bytes, size)
}

@RequiresApi(28)
private fun decodeAnimated28(bytes: ByteArray, size: (Int, Int) -> IntSize): Drawable? = runCatching {
    val drawable = ImageDecoder.decodeDrawable(ImageDecoder.createSource(ByteBuffer.wrap(bytes))) { decoder, info, _ ->
        val target = size(info.size.width, info.size.height)
        if (target.width < info.size.width || target.height < info.size.height) decoder.setTargetSize(target.width, target.height)
    }
    (drawable as? AnimatedImageDrawable)?.apply { repeatCount = AnimatedImageDrawable.REPEAT_INFINITE }
}.getOrNull()

/**
 * Draws an [AnimatedImageDrawable] in Compose: its frame callbacks redraw the painter. [playing] starts and stops it
 * (a page beside the shown one, a tile that leaves the screen).
 */
@Composable
internal fun rememberAnimationPainter(drawable: Drawable?, playing: Boolean): Painter? {
    if (drawable == null || Build.VERSION.SDK_INT < 28) return null
    val painter = remember(drawable) { AnimationPainter(drawable) }
    DisposableEffect(painter, playing) {
        painter.play(playing)
        onDispose { painter.play(false) }
    }
    return painter
}

internal class AnimationPainter(private val drawable: Drawable) : Painter() {
    private var tick by mutableIntStateOf(0)
    private val handler = Handler(Looper.getMainLooper())
    // Drawable keeps its callback weakly: held here.
    private val callback = object : Drawable.Callback {
        override fun invalidateDrawable(who: Drawable) { tick++ }
        override fun scheduleDrawable(who: Drawable, what: Runnable, `when`: Long) { handler.postAtTime(what, `when`) }
        override fun unscheduleDrawable(who: Drawable, what: Runnable) { handler.removeCallbacks(what) }
    }

    init { drawable.callback = callback }

    fun play(on: Boolean) {
        if (Build.VERSION.SDK_INT < 28) return
        val animated = drawable as? AnimatedImageDrawable ?: return
        if (on && !animated.isRunning) animated.start() else if (!on && animated.isRunning) animated.stop()
    }

    override val intrinsicSize: Size get() = Size(drawable.intrinsicWidth.toFloat(), drawable.intrinsicHeight.toFloat())

    override fun DrawScope.onDraw() {
        @Suppress("UNUSED_VARIABLE") val frame = tick // read: a new frame redraws
        drawIntoCanvas { canvas ->
            drawable.setBounds(0, 0, size.width.roundToInt(), size.height.roundToInt())
            drawable.draw(canvas.nativeCanvas)
        }
    }
}

/** The small 「GIF」 mark on a tile that is not moving (a setting keeps it still, it waits for a slot, it is too large). */
@Composable
internal fun GifBadge(modifier: Modifier = Modifier, compact: Boolean = false) {
    Text(
        "GIF", color = Color.White, fontSize = if (compact) 8.sp else 11.sp, fontWeight = FontWeight.Bold, maxLines = 1,
        modifier = modifier.padding(if (compact) 2.dp else 6.dp).clip(RoundedCornerShape(4.dp)).background(Color.Black.copy(alpha = 0.55f))
            .padding(horizontal = if (compact) 3.dp else 5.dp, vertical = if (compact) 0.dp else 1.dp),
    )
}
