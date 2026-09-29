package jp.chikuwachat.android.ui

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

        /** The frames of a GIF, or null for anything that does not move. */
        @Suppress("DEPRECATION") // Movie is the platform's GIF decoder that needs no API 28 (ImageDecoder)
        fun decode(bytes: ByteArray): EmojiAnimation? {
            if (bytes.size < 6 || String(bytes, 0, 4, Charsets.US_ASCII) != "GIF8") return null
            val movie = Movie.decodeByteArray(bytes, 0, bytes.size) ?: return null
            val duration = movie.duration()
            if (duration <= 0 || movie.width() <= 0 || movie.height() <= 0) return null
            val step = maxOf(FRAME_MS, (duration + MAX_FRAMES - 1).toLong() / MAX_FRAMES)
            val frames = (0 until duration step step.toInt()).map { time ->
                val bitmap = createBitmap(movie.width(), movie.height())
                movie.setTime(time)
                movie.draw(Canvas(bitmap), 0f, 0f)
                bitmap.asImageBitmap()
            }
            return if (frames.size > 1) EmojiAnimation(frames, step) else null
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
