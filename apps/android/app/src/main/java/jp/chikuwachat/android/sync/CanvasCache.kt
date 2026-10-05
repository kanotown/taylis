package jp.chikuwachat.android.sync

import jp.chikuwachat.android.api.CanvasOut
import kotlinx.serialization.Serializable
import java.time.Instant
import java.time.ZoneId
import java.time.ZonedDateTime
import jp.chikuwachat.android.R
import jp.chikuwachat.android.L10n

/**
 * M74 (CANVAS.md §5 「ストア: SQLite に canvases (オフライン閲覧)」, §19.2): the last copy of a canvas the server gave this
 * device (GET, a save's answer, a conflict's head), kept in the Room store's `canvases` table so the canvas opens offline.
 * `fetchedAt` is when the server last vouched for it (a 304 counts): what the offline notice shows.
 */
@Serializable
data class CachedCanvas(val canvas: CanvasOut, val fetchedAt: Long)

/**
 * At most this many canvases are kept, the most recently read or saved ones (every server answer about a canvas rewrites
 * its row, so this is "the most recently opened" for a phone). Older ones go when a new one is written.
 */
const val CANVAS_CACHE_LIMIT = 200

object CanvasOffline {
    /**
     * The notice over a copy the server could not confirm: 「オフライン — 最後に読み込んだ時点 (10/2 14:05) の内容です」. The
     * year shows when it is not this year's.
     */
    fun notice(fetchedAt: Long, now: Long = System.currentTimeMillis(), zone: ZoneId = ZoneId.systemDefault()): String =
        L10n.str(R.string.canvas_cache_offline_showing_the_content_as_last, stamp(fetchedAt, now, zone))

    fun stamp(at: Long, now: Long, zone: ZoneId): String {
        val time = ZonedDateTime.ofInstant(Instant.ofEpochMilli(at), zone)
        val today = ZonedDateTime.ofInstant(Instant.ofEpochMilli(now), zone)
        val clock = "${time.hour}:${time.minute.toString().padStart(2, '0')}"
        val day = "${time.monthValue}/${time.dayOfMonth}"
        return if (time.year == today.year) "$day $clock" else "${time.year}/$day $clock"
    }
}
