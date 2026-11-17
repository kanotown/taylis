package jp.chikuwachat.android.ui

import java.time.LocalDateTime
import java.time.format.DateTimeFormatter

/**
 * Names for files that reach an upload without a real one (docs/CHANNEL_FILES.md §4.4, apps/shared/upload-names.json):
 * a file whose provider tells no name went up as 「file」, and the same name piled up in a channel's drive. It is named
 * by the time it was added instead (「image_20261117_090503.png」), with _2, _3 … for the 2nd, 3rd … unnamed file in the
 * same second. The camera's 「photo_20260930_221605.jpg」 is the same rule.
 */
object UploadNames {
    private val STAMP: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyyMMdd_HHmmss")
    private val IMAGE_EXTS = setOf("png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "tif", "tiff", "bmp", "avif")
    private val VIDEO_EXTS = setOf("mov", "mp4", "m4v", "webm")

    /** This process's counter of unnamed files. */
    val shared = UploadNamer()

    /** Empty, a client's placeholder (「file」, 「photo.jpg」, 「video.mov」) or a clipboard's 「image.png」. */
    fun isUnnamed(name: String): Boolean {
        val lower = name.trim().lowercase()
        if (lower.isEmpty() || lower == "file") return true
        val dot = lower.lastIndexOf('.')
        if (dot < 0) return false
        val stem = lower.substring(0, dot)
        val ext = lower.substring(dot + 1)
        return when (stem) {
            "image", "photo" -> ext in IMAGE_EXTS
            "video" -> ext in VIDEO_EXTS
            else -> false
        }
    }

    /** An image type → image, a video type → video, anything else (or none) → file. */
    fun kind(mime: String?): String {
        val lower = mime.orEmpty().lowercase()
        return when {
            lower.startsWith("image/") -> "image"
            lower.startsWith("video/") -> "video"
            else -> "file"
        }
    }

    fun stamp(at: LocalDateTime): String = STAMP.format(at)

    /** 「photo_20261117_090503_2.jpg」: [index] 1 has no suffix; no dot without an extension. */
    fun name(kind: String, ext: String, at: LocalDateTime, index: Int): String {
        val suffix = if (index > 1) "_$index" else ""
        val lower = ext.lowercase()
        return kind + "_" + stamp(at) + suffix + if (lower.isEmpty()) "" else ".$lower"
    }

    fun next(kind: String, ext: String, at: LocalDateTime = LocalDateTime.now()): String = shared.next(kind, ext, at)
}

/** Counts the unnamed files of one second (any kind), so two added in the same second get different names. */
class UploadNamer {
    private var stamp = ""
    private var count = 0

    @Synchronized
    fun next(kind: String, ext: String, at: LocalDateTime = LocalDateTime.now()): String {
        val stamp = UploadNames.stamp(at)
        count = if (stamp == this.stamp) count + 1 else 1
        this.stamp = stamp
        return UploadNames.name(kind, ext, at, count)
    }
}
