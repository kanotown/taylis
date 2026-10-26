package jp.chikuwachat.android.ui

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Movie
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Spacer
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithCache
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.IntSize
import androidx.core.graphics.createBitmap
import kotlinx.coroutines.delay
import kotlin.math.roundToInt

/**
 * An animated custom emoji (a GIF; testers 2026-09-29: they did not move): its frames, one every [frameMs]. Frames are
 * sampled from the platform's GIF decoder, which composes each frame the way a browser shows it.
 */
class EmojiAnimation(val frames: List<ImageBitmap>, val frameMs: Long) {
    /** The frame showing at [nowMs]; every copy of an emoji moves together. */
    fun frameAt(nowMs: Long): ImageBitmap = frames[((nowMs / frameMs) % frames.size).toInt()]

    companion object {
        private const val FRAME_MS = 60L
        private const val MAX_FRAMES = 80

        /**
         * The frames of a GIF, or null for anything that does not move. Frames higher than [maxHeightPx] are drawn at
         * full size and area-averaged down (docs/EMOJI.md §10: no emoji is drawn higher than that; scaling the canvas
         * skipped pixels of thin outlines), with mipmaps so that drawing them smaller stays smooth.
         */
        @Suppress("DEPRECATION") // Movie is the platform's GIF decoder that needs no API 28 (ImageDecoder)
        fun decode(bytes: ByteArray, maxHeightPx: Int = Int.MAX_VALUE): EmojiAnimation? {
            if (bytes.size < 6 || String(bytes, 0, 4, Charsets.US_ASCII) != "GIF8") return null
            val movie = Movie.decodeByteArray(bytes, 0, bytes.size) ?: return null
            val duration = movie.duration()
            if (duration <= 0 || movie.width() <= 0 || movie.height() <= 0) return null
            val (width, height) = EmojiScale.storedPixels(movie.width(), movie.height(), maxHeightPx)
            val step = maxOf(FRAME_MS, (duration + MAX_FRAMES - 1).toLong() / MAX_FRAMES)
            val full = createBitmap(movie.width(), movie.height())
            val canvas = Canvas(full)
            val frames = (0 until duration step step.toInt()).map { time ->
                full.eraseColor(0)
                movie.setTime(time)
                movie.draw(canvas, 0f, 0f)
                val frame = if (width == full.width && height == full.height) full.copy(Bitmap.Config.ARGB_8888, false) else shrunk(full, width, height)
                frame.setHasMipMap(true)
                frame.asImageBitmap()
            }
            full.recycle()
            return if (frames.size > 1) EmojiAnimation(frames, step) else null
        }
    }
}

/** [bitmap] area-averaged down to [width] × [height] pixels (EmojiScale.shrink). */
internal fun shrunk(bitmap: Bitmap, width: Int, height: Int): Bitmap {
    val pixels = IntArray(bitmap.width * bitmap.height)
    bitmap.getPixels(pixels, 0, bitmap.width, 0, 0, bitmap.width, bitmap.height)
    val w = minOf(width, bitmap.width)
    val h = minOf(height, bitmap.height)
    return Bitmap.createBitmap(EmojiScale.shrink(pixels, bitmap.width, bitmap.height, w, h), w, h, Bitmap.Config.ARGB_8888)
}

/** A custom emoji's picture as decoded once (docs/EMOJI.md, image cache): the still image, and the frames when it moves. */
class DecodedEmoji(val still: ImageBitmap, val animation: EmojiAnimation?) {
    /** Bytes held in memory (4 per pixel), for the memory cache's limit. */
    val byteCount: Long get() = still.width.toLong() * still.height * 4 + (animation?.frames?.sumOf { it.width.toLong() * it.height * 4 } ?: 0L)

    companion object {
        /**
         * Decodes (off the main thread) at no more than [maxHeightPx] high: read at full size (uploads are at most
         * 512 px; `inSampleSize` would skip pixels) and area-averaged down, so a thin outline survives (docs/EMOJI.md §10).
         */
        fun decode(bytes: ByteArray, maxHeightPx: Int): DecodedEmoji? {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
            // Only a picture far beyond the server's limit is sampled while read (memory).
            var sample = 1
            while (maxOf(bounds.outWidth, bounds.outHeight) / sample > 2048) sample *= 2
            val options = BitmapFactory.Options().apply { inSampleSize = sample; inPreferredConfig = Bitmap.Config.ARGB_8888 }
            val full = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options) ?: return null
            val (width, height) = EmojiScale.storedPixels(full.width, full.height, maxHeightPx)
            val still = if (width == full.width && height == full.height) full else shrunk(full, width, height).also { full.recycle() }
            return DecodedEmoji(still.asImageBitmap(), EmojiAnimation.decode(bytes, maxHeightPx))
        }
    }
}

/** docs/EMOJI.md §10: the stills' copies at the pixels they are shown at. */
internal val emojiDisplayCopies = EmojiScale.DisplayCopies<Bitmap, ImageBitmap>()

/**
 * A custom emoji's image fitted (centred) into the box [modifier] gives it, moving when [animation] is set. A still is
 * drawn from a copy made once at exactly the pixels it takes there (area-averaged, kept with the still), pixel for pixel
 * at a whole-pixel offset: drawing the 72 dp still into a 28 dp cell with plain filtering made thin outlines shimmer on
 * a dark background (2026-10-27). Shown larger than it is kept, it is scaled up with high-quality filtering. An animated
 * one's frames are drawn with high-quality filtering and their mipmaps (copies of each frame would cost far more memory).
 */
@Composable
fun EmojiImage(still: ImageBitmap, animation: EmojiAnimation?, contentDescription: String?, modifier: Modifier = Modifier) {
    val described = if (contentDescription == null) modifier else modifier.semantics { this.contentDescription = contentDescription; role = Role.Image }
    if (animation == null) {
        Spacer(described.drawWithCache {
            val (width, height) = EmojiScale.fitPixels(still.width, still.height, size.width, size.height)
            val left = ((size.width - width) / 2f).roundToInt()
            val top = ((size.height - height) / 2f).roundToInt()
            if (width >= still.width || height >= still.height) {
                onDrawBehind {
                    drawImage(still, dstOffset = IntOffset(left, top), dstSize = IntSize(width, height), filterQuality = FilterQuality.High)
                }
            } else {
                val copy = emojiDisplayCopies.copy(still.asAndroidBitmap(), width, height) { shrunk(still.asAndroidBitmap(), width, height).asImageBitmap() }
                onDrawBehind { drawImage(copy, Offset(left.toFloat(), top.toFloat())) }
            }
        })
        return
    }
    val frame by produceState(animation.frameAt(System.currentTimeMillis()), animation) {
        while (true) {
            val now = System.currentTimeMillis()
            value = animation.frameAt(now)
            delay(animation.frameMs - now % animation.frameMs)
        }
    }
    Image(frame, contentDescription = null, contentScale = ContentScale.Fit, filterQuality = FilterQuality.High, modifier = described)
}
