package jp.chikuwachat.android.ui

import jp.chikuwachat.android.api.AttachmentOut
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import jp.chikuwachat.android.R
import jp.chikuwachat.android.L10n

/**
 * M82 (the phone side of M79, IMPLEMENTATION_PLAN.md M79 row): how a video attachment shows in a message, kept apart
 * from the Compose tree so it can be tested on the JVM.
 *
 * Since M79 the server records a video's upright `width` / `height`, its `duration_ms` and a poster frame (`has_poster`,
 * the JPEG at `/attachments/{id}/thumbnail`). With them the tile has its final shape at once and shows the poster; the
 * clip is downloaded only when it is opened. Android never read frames on the device, and still does not: a video
 * without a poster shows a plain tile (or, with nothing known, the file row it always was).
 */
object VideoTiles {
    /** The bounds of a video tile, as a single photo's (Attachments.kt). */
    const val MAX_WIDTH = 280
    const val MAX_HEIGHT = 240
    /** A tile whose shape is not known (the poster failed on a video without a size): a neutral square. */
    const val PLACEHOLDER = 180

    data class Box(val width: Int, val height: Int)

    enum class Look {
        /** The server's poster, in the clip's shape. */
        POSTER,
        /** A tile with a film icon (no poster, or the poster did not load). */
        PLAIN,
        /** Nothing known (a server before M79, a video not probed yet): the file row of before M82. */
        ROW,
    }

    /** The largest box of the clip's own shape inside the tile bounds (never scaled up); null when the shape is not known. */
    fun fit(width: Int?, height: Int?, maxWidth: Int = MAX_WIDTH, maxHeight: Int = MAX_HEIGHT): Box? {
        if (width == null || height == null || width <= 0 || height <= 0) return null
        val scale = min(1.0, min(maxWidth.toDouble() / width, maxHeight.toDouble() / height))
        return Box(max(1, (width * scale).roundToInt()), max(1, (height * scale).roundToInt()))
    }

    /** The tile's box: from the server's size, else the placeholder square. */
    fun box(attachment: AttachmentOut): Box = fit(attachment.width, attachment.height) ?: Box(PLACEHOLDER, PLACEHOLDER)

    /** `posterFailed`: the poster was asked for and did not come (network, a broken JPEG); the tile then stays a tile. */
    fun look(attachment: AttachmentOut, posterFailed: Boolean = false): Look = when {
        attachment.hasPoster && !posterFailed -> Look.POSTER
        attachment.hasPoster || fit(attachment.width, attachment.height) != null -> Look.PLAIN
        else -> Look.ROW
    }

    /** The tile's bottom-left label, 「0:42 · 1.9 MB」, or only the size when the length is not known. */
    fun label(attachment: AttachmentOut): String =
        listOfNotNull(formatDuration(attachment.durationMs), formatSize(attachment.sizeBytes)).joinToString(" · ")

    /** What a screen reader says for the tile: 「動画 clip.mp4、0:42」. */
    fun description(attachment: AttachmentOut): String =
        L10n.str(R.string.video_tiles_video, attachment.filename) + (formatDuration(attachment.durationMs)?.let { L10n.str(R.string.common_comma_then, it) } ?: "")

    /** The player's frame before the clip reports its own size: the server's shape, else 16:9. */
    fun aspectRatio(attachment: AttachmentOut): Float {
        val w = attachment.width
        val h = attachment.height
        return if (w != null && h != null && w > 0 && h > 0) w.toFloat() / h else 16f / 9f
    }
}

/**
 * A video's length as its tile shows it (「0:07」「12:34」「1:02:03」), as Desktop's formatDuration: rounded to the second,
 * a clip above 0 but under a second is 「0:01」. Null when the server does not know it.
 */
fun formatDuration(ms: Long?): String? {
    if (ms == null || ms < 0) return null
    val total = if (ms > 0) max(1L, (ms + 500) / 1000) else 0L
    val hours = total / 3600
    val minutes = (total % 3600) / 60
    val seconds = (total % 60).toString().padStart(2, '0')
    return if (hours > 0) "$hours:${minutes.toString().padStart(2, '0')}:$seconds" else "$minutes:$seconds"
}
