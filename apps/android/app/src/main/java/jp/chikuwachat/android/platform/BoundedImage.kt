package jp.chikuwachat.android.platform

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap

/**
 * 2026-11-16 (a hostile-server review): every picture a server sends is decoded through here. Decoding a whole PNG of
 * 5,100 × 5,100 pixels takes about 100 MB as a bitmap, and the workspace icon is drawn in the title and the switcher, so
 * such an icon threw OutOfMemoryError (not an Exception) at every start. The bounds are read first; a picture of more
 * than [maxPixels] pixels is not decoded at all; the rest is sampled down while read to at most [maxSide] pixels on its
 * longer side (the size it is shown at); any Throwable while decoding (OutOfMemoryError) is no picture.
 */
object BoundedImage {
    /** A photo, a thumbnail, a document's first page: 100 megapixels (a phone's largest photos are 50–108). */
    const val MAX_PIXELS = 100_000_000L

    /** A workspace icon, an avatar, a custom emoji, a link preview's picture, a QR code: 16 megapixels. */
    const val SMALL_MAX_PIXELS = 16_000_000L

    /** An animated GIF's canvas (a frame of it is drawn in full for every frame kept): 2048 × 2048. */
    const val MAX_GIF_PIXELS = 2048L * 2048

    /** Whether a picture of [width] × [height] may be decoded at all. */
    fun allowed(width: Int, height: Int, maxPixels: Long): Boolean = width > 0 && height > 0 && width.toLong() * height <= maxPixels

    /** The power of two to sample by so that the longer side is at most [maxSide] pixels. */
    fun sampleSize(width: Int, height: Int, maxSide: Int): Int {
        val longer = maxOf(width, height)
        var sample = 1
        while (longer / sample > maxSide.coerceAtLeast(1) && sample < (1 shl 16)) sample *= 2
        return sample
    }

    /**
     * The decision for a picture of the given size, without Android: the sample size, or null when it is not decoded.
     * [read] decodes at a sample size; anything it throws (OutOfMemoryError among them) is no picture.
     */
    fun <T> decodeWith(size: Pair<Int, Int>?, maxSide: Int, maxPixels: Long, read: (sample: Int) -> T?): T? {
        val (width, height) = size ?: return null
        if (!allowed(width, height, maxPixels)) return null
        return try {
            read(sampleSize(width, height, maxSide))
        } catch (_: Throwable) {
            null
        }
    }

    /** The picture in [bytes] (see the class), or null. [config] as BitmapFactory takes it (null: its default). */
    fun decode(bytes: ByteArray, maxSide: Int, maxPixels: Long = MAX_PIXELS, config: Bitmap.Config? = null): Bitmap? =
        decodeWith(bounds(bytes), maxSide, maxPixels) { sample ->
            val options = BitmapFactory.Options().apply {
                inSampleSize = sample
                if (config != null) inPreferredConfig = config
            }
            BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
        }

    /** [decode] as Compose draws it. */
    fun image(bytes: ByteArray, maxSide: Int, maxPixels: Long = MAX_PIXELS, config: Bitmap.Config? = null): ImageBitmap? =
        decode(bytes, maxSide, maxPixels, config)?.asImageBitmap()

    /** The width and height the header of [bytes] declares; null when it is not a picture BitmapFactory reads. */
    fun bounds(bytes: ByteArray): Pair<Int, Int>? = try {
        val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
        if (options.outWidth > 0 && options.outHeight > 0) options.outWidth to options.outHeight else null
    } catch (_: Throwable) {
        null
    }

    /** All of [input] when it holds at most [limit] bytes; null (reading no further) when it holds more. */
    fun readAtMost(input: java.io.InputStream, limit: Long): ByteArray? {
        val out = java.io.ByteArrayOutputStream()
        val buffer = ByteArray(16 * 1024)
        var total = 0L
        while (true) {
            val read = input.read(buffer)
            if (read < 0) return out.toByteArray()
            total += read
            if (total > limit) return null
            out.write(buffer, 0, read)
        }
    }

    /** A GIF's canvas (its logical screen: bytes 6–9, little-endian), or null when [bytes] is not a GIF. */
    fun gifCanvas(bytes: ByteArray): Pair<Int, Int>? {
        if (bytes.size < 10 || String(bytes, 0, 4, Charsets.US_ASCII) != "GIF8") return null
        fun u16(at: Int) = (bytes[at].toInt() and 0xff) or ((bytes[at + 1].toInt() and 0xff) shl 8)
        return u16(6) to u16(8)
    }
}
