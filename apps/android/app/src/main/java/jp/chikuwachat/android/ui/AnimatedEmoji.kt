package jp.chikuwachat.android.ui

import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Movie
import androidx.compose.foundation.Image
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.core.graphics.createBitmap
import kotlinx.coroutines.delay

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
         * The frames of a GIF, or null for anything that does not move. Frames higher than [maxHeightPx] are drawn
         * smaller (docs/EMOJI.md, image cache: no emoji is drawn higher than that).
         */
        @Suppress("DEPRECATION") // Movie is the platform's GIF decoder that needs no API 28 (ImageDecoder)
        fun decode(bytes: ByteArray, maxHeightPx: Int = Int.MAX_VALUE): EmojiAnimation? {
            if (bytes.size < 6 || String(bytes, 0, 4, Charsets.US_ASCII) != "GIF8") return null
            val movie = Movie.decodeByteArray(bytes, 0, bytes.size) ?: return null
            val duration = movie.duration()
            if (duration <= 0 || movie.width() <= 0 || movie.height() <= 0) return null
            val scale = minOf(1f, maxHeightPx.toFloat() / movie.height())
            val width = maxOf(1, (movie.width() * scale).toInt())
            val height = maxOf(1, (movie.height() * scale).toInt())
            val step = maxOf(FRAME_MS, (duration + MAX_FRAMES - 1).toLong() / MAX_FRAMES)
            val frames = (0 until duration step step.toInt()).map { time ->
                val bitmap = createBitmap(width, height)
                movie.setTime(time)
                val canvas = Canvas(bitmap)
                canvas.scale(scale, scale)
                movie.draw(canvas, 0f, 0f)
                bitmap.asImageBitmap()
            }
            return if (frames.size > 1) EmojiAnimation(frames, step) else null
        }
    }
}

/** A custom emoji's picture as decoded once (docs/EMOJI.md, image cache): the still image, and the frames when it moves. */
class DecodedEmoji(val still: ImageBitmap, val animation: EmojiAnimation?) {
    /** Bytes held in memory (4 per pixel), for the memory cache's limit. */
    val byteCount: Long get() = still.width.toLong() * still.height * 4 + (animation?.frames?.sumOf { it.width.toLong() * it.height * 4 } ?: 0L)

    companion object {
        /**
         * Decodes (off the main thread) at no more than about [maxHeightPx] high, in power-of-two steps that keep it
         * sharp: a 512px upload is not held at full size for a 28dp picker cell.
         */
        fun decode(bytes: ByteArray, maxHeightPx: Int): DecodedEmoji? {
            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
            var sample = 1
            while (bounds.outHeight / (sample * 2) >= maxHeightPx) sample *= 2
            val still = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, BitmapFactory.Options().apply { inSampleSize = sample }) ?: return null
            return DecodedEmoji(still.asImageBitmap(), EmojiAnimation.decode(bytes, maxHeightPx))
        }
    }
}

/** A custom emoji's image, moving when [animation] is set. */
@Composable
fun EmojiImage(still: ImageBitmap, animation: EmojiAnimation?, contentDescription: String?, modifier: Modifier = Modifier) {
    if (animation == null) {
        Image(still, contentDescription = contentDescription, contentScale = ContentScale.Fit, modifier = modifier)
        return
    }
    val frame by produceState(animation.frameAt(System.currentTimeMillis()), animation) {
        while (true) {
            val now = System.currentTimeMillis()
            value = animation.frameAt(now)
            delay(animation.frameMs - now % animation.frameMs)
        }
    }
    Image(frame, contentDescription = contentDescription, contentScale = ContentScale.Fit, modifier = modifier)
}
