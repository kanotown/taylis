package jp.chikuwachat.android.ui

import kotlin.math.max
import kotlin.math.min

/**
 * Square crop of a profile picture (M16g), the same rules as the desktop's avatarCrop.ts and iOS AvatarCrop.swift:
 * at zoom 1 the picture just covers the frame (its shorter side fits); the reader pans and zooms, and the frame's
 * square is what gets uploaded, as a 512 px JPEG whatever the photo was. [x] and [y] are the offset of the
 * picture's centre from the frame's centre, in screen pixels; sizes are in picture pixels.
 */
data class AvatarCrop(val zoom: Float = 1f, val x: Float = 0f, val y: Float = 0f) {
    /** Keeps the frame covered: no pan or zoom may show anything outside the picture. */
    fun clamped(width: Float, height: Float, frame: Float): AvatarCrop {
        val zoom = zoom.coerceIn(1f, MAX_ZOOM)
        val scale = scale(width, height, frame, zoom)
        val maxX = max(0f, (width * scale - frame) / 2)
        val maxY = max(0f, (height * scale - frame) / 2)
        return AvatarCrop(zoom, x.coerceIn(-maxX, maxX), y.coerceIn(-maxY, maxY))
    }

    fun moved(dx: Float, dy: Float, width: Float, height: Float, frame: Float): AvatarCrop =
        copy(x = x + dx, y = y + dy).clamped(width, height, frame)

    /** Zooms around a point of the frame (relative to its centre): the picture under that point stays under it. */
    fun zoomed(to: Float, px: Float, py: Float, width: Float, height: Float, frame: Float): AvatarCrop {
        val next = to.coerceIn(1f, MAX_ZOOM)
        val ratio = next / zoom
        return AvatarCrop(next, px - (px - x) * ratio, py - (py - y) * ratio).clamped(width, height, frame)
    }

    /**
     * One step of a drag or pinch, applied in a single clamp: scale by [zoomChange] about the previous centroid
     * ([cx], [cy], relative to the frame's centre) and move by the centroid's motion ([dx], [dy]). The picture point
     * that was under the fingers ends up under them again, so the picture follows the fingers from the first event.
     * Clamping once (not after the zoom and again after the pan) keeps a pinch near an edge from snapping.
     */
    fun transformed(
        zoomChange: Float, dx: Float, dy: Float, cx: Float, cy: Float,
        width: Float, height: Float, frame: Float,
    ): AvatarCrop {
        val next = (zoom * zoomChange).coerceIn(1f, MAX_ZOOM)
        val ratio = next / zoom
        return AvatarCrop(next, cx + dx - (cx - x) * ratio, cy + dy - (cy - y) * ratio).clamped(width, height, frame)
    }

    /** The square of the picture, in picture pixels, that the frame shows. */
    fun sourceRect(width: Float, height: Float, frame: Float): Square {
        val scale = scale(width, height, frame, zoom)
        val side = frame / scale
        return Square(width / 2 - x / scale - side / 2, height / 2 - y / scale - side / 2, side)
    }

    data class Square(val x: Float, val y: Float, val side: Float)

    companion object {
        /** Side of the uploaded picture; the server shrinks it to 256 px. */
        const val OUTPUT = 512
        const val MAX_ZOOM = 4f

        /** Screen pixels per picture pixel. */
        fun scale(width: Float, height: Float, frame: Float, zoom: Float): Float = frame / min(width, height) * zoom
    }
}
