package jp.chikuwachat.android.sync

import jp.chikuwachat.android.L10n
import jp.chikuwachat.android.R
import jp.chikuwachat.android.api.AlbumAddOut
import jp.chikuwachat.android.api.AlbumAddResult
import jp.chikuwachat.android.api.AlbumCreatedOut
import jp.chikuwachat.android.api.AlbumDetailOut
import jp.chikuwachat.android.api.AlbumListEntryOut
import jp.chikuwachat.android.api.AlbumListOut
import jp.chikuwachat.android.api.AlbumOut
import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.AttachmentOut
import jp.chikuwachat.android.api.DriveItemOut
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import java.time.Instant
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneId
import kotlin.random.Random

/*
 * AL4 (docs/ALBUMS.md §12, §18.4): photo albums on Android. An album is a drive folder with a little metadata (AL1), so
 * everything here reads the drive's endpoints and rules; what is the album's own — its pages in the capture order, the
 * grid's day headings, the viewer's and the slideshow's order, the cards' lines — is plain Kotlin here, unit tested.
 */

/** The album endpoints (AL1 §5), apart from DriveApi so the drive's test fakes need not know them. */
interface AlbumApi {
    /** GET /drive/albums: the albums of the locations I can read (or of [locationId]), newest first. */
    suspend fun albums(locationId: String?, cursor: String?, limit: Int): AlbumListOut

    /** GET /drive/albums/{folder_id}: the album and a page of its photos and videos; `sort` / `order` null: the album's. */
    suspend fun album(folderId: String, sort: String?, order: String?, cursor: String?, limit: Int): AlbumDetailOut

    /** POST /drive/albums: `parentId` (the folder open) or `locationId` (that location's 「アルバム」 folder). */
    suspend fun createAlbum(parentId: String?, locationId: String?, name: String, description: String?, clientOpId: String): AlbumCreatedOut

    /** PUT /drive/folders/{id}/album: only the fields in [fields] are sent (a null value clears it: the cover, a day). */
    suspend fun putAlbum(folderId: String, fields: Map<String, String?>): AlbumOut

    /** DELETE /drive/folders/{id}/album: a plain folder again (its files stay). */
    suspend fun deleteAlbum(folderId: String)

    /** POST /drive/albums/{folder_id}/add: a conversation's attachments or drive items, mode auto / move / copy. */
    suspend fun addToAlbum(folderId: String, attachmentIds: List<String>, itemIds: List<String>, mode: String, clientOpId: String): AlbumAddOut
}

/** One cell of the album's grid: a day's heading (the capture order only) or a photo / video at [index] of the items. */
sealed interface AlbumCell {
    val key: String

    data class Day(val day: LocalDate, val label: String) : AlbumCell {
        override val key: String get() = "day:$day"
    }

    data class Photo(val index: Int, val item: DriveItemOut) : AlbumCell {
        override val key: String get() = item.id
    }
}

object AlbumRules {
    const val PAGE = 100

    /** Slideshow's intervals (seconds) and a video's longest turn (§8: muted, at most 60 s). */
    val INTERVALS = listOf(3, 5, 10)
    const val DEFAULT_INTERVAL = 5
    const val VIDEO_MAX_MS = 60_000L

    /** An ISO time with an offset or a Z (Android 8's Instant.parse reads only the Z), as an instant. */
    fun instant(iso: String?): Instant? {
        if (iso.isNullOrEmpty()) return null
        return runCatching { OffsetDateTime.parse(iso).toInstant() }.getOrNull() ?: runCatching { Instant.parse(iso) }.getOrNull()
    }

    /** The time the server sorts a photo by (§18.4): taken, else the file's own time, else when it was added. */
    fun sortTime(item: DriveItemOut): Instant? = instant(item.file?.takenAt) ?: instant(item.contentModifiedAt) ?: instant(item.createdAt)

    fun isVideo(item: DriveItemOut): Boolean = item.contentType.orEmpty().startsWith("video/", ignoreCase = true)

    fun isPhoto(item: DriveItemOut): Boolean = item.contentType.orEmpty().startsWith("image/", ignoreCase = true)

    /** The grid's picture (a photo's thumbnail, a video's poster), null: the kind's icon (a HEIC, one not read yet). */
    fun thumbnailPath(attachmentId: String): String = "/api/v1/attachments/$attachmentId/thumbnail"

    /** The viewer's and the slideshow's image (§6: 2048 px; the server answers the original raster image without one). */
    fun displayPath(attachmentId: String): String = "/api/v1/attachments/$attachmentId/display"

    fun originalPath(attachmentId: String): String = "/api/v1/attachments/$attachmentId/content"

    /** A failure of the display image that the original may still answer (404 display_not_found: a HEIC, an icon). */
    fun displayMissing(e: Throwable): Boolean = e is ApiException.Api && e.status == 404

    /**
     * The grid's cells: in the capture order a heading before each day's first photo (`9 月 16 日（火）`, the year when
     * not this one); by name or by when they were added, no headings.
     */
    fun cells(items: List<DriveItemOut>, sort: String, zone: ZoneId = ZoneId.systemDefault(), today: LocalDate = LocalDate.now(zone)): List<AlbumCell> {
        if (sort != "taken") return items.mapIndexed { index, item -> AlbumCell.Photo(index, item) }
        val out = ArrayList<AlbumCell>(items.size + 8)
        var last: LocalDate? = null
        val seen = HashSet<LocalDate>()
        items.forEachIndexed { index, item ->
            val day = sortTime(item)?.atZone(zone)?.toLocalDate()
            // A day already headed (photos without a time between) is not headed twice: the keys stay unique.
            if (day != null && day != last && seen.add(day)) out.add(AlbumCell.Day(day, dayLabel(day, today)))
            if (day != null) last = day
            out.add(AlbumCell.Photo(index, item))
        }
        return out
    }

    /** 「9 月 16 日（火）」, 「2025 年 12 月 31 日（水）」. */
    fun dayLabel(day: LocalDate, today: LocalDate): String {
        val weekday = L10n.weekdayShort(day.dayOfWeek)
        return if (day.year == today.year) L10n.str(R.string.album_day, day.monthValue, day.dayOfMonth, weekday)
        else L10n.str(R.string.album_day_with_year, day.year, day.monthValue, day.dayOfMonth, weekday)
    }

    private fun localDate(text: String?): LocalDate? = text?.let { runCatching { LocalDate.parse(it.take(10)) }.getOrNull() }

    /** 「2026/9/16〜9/19」 (the event's days, else the photos' range; one day: 「2026/9/16」); empty without either. */
    fun dateLine(album: AlbumOut, zone: ZoneId = ZoneId.systemDefault()): String {
        val start = localDate(album.startsOn) ?: instant(album.takenFrom)?.atZone(zone)?.toLocalDate()
        val end = localDate(album.endsOn) ?: if (album.startsOn != null) null else instant(album.takenTo)?.atZone(zone)?.toLocalDate()
        start ?: return end?.let(::ymd) ?: ""
        if (end == null || end == start) return ymd(start)
        val tail = if (end.year == start.year) "${end.monthValue}/${end.dayOfMonth}" else ymd(end)
        return L10n.str(R.string.album_date_range, ymd(start), tail)
    }

    private fun ymd(day: LocalDate) = "${day.year}/${day.monthValue}/${day.dayOfMonth}"

    /** 「312 枚 · 動画 8 本」 (no videos: the photos only). */
    fun countLine(album: AlbumOut): String {
        val photos = L10n.plural(R.plurals.album_photos, album.photoCount, album.photoCount)
        return if (album.videoCount > 0) photos + " · " + L10n.plural(R.plurals.album_videos, album.videoCount, album.videoCount) else photos
    }

    /** The /d/ card's and the list's line: 「312 枚 · 2026/9/16〜9/19」. */
    fun cardLine(album: AlbumOut, zone: ZoneId = ZoneId.systemDefault()): String =
        listOf(countLine(album), dateLine(album, zone)).filter { it.isNotEmpty() }.joinToString(" · ")

    /** The four pictures of a card (the cover first when it is not among them). */
    fun previews(album: AlbumOut): List<String> {
        val cover = album.cover?.attachmentId
        val ids = album.previewAttachmentIds
        return (if (cover != null && cover !in ids) listOf(cover) + ids else ids).take(4)
    }

    /** The ＋'s 「新しいアルバム」 (§17 Q2): at the location's top, its 「アルバム」 folder (`location_id`); else the folder open. */
    fun createTarget(folderId: String, rootId: String?, locationId: String): Pair<String?, String?> =
        if (rootId == null || folderId == rootId) null to locationId else folderId to null

    /** The album picker (「アルバムに追加」): the albums of the conversation's channel drive first, then the rest as listed. */
    fun pickerOrder(entries: List<AlbumListEntryOut>, preferredLocationId: String?): List<AlbumListEntryOut> =
        if (preferredLocationId == null) entries else entries.sortedBy { if (it.folder.locationId == preferredLocationId) 0 else 1 }

    /** A message's files that can go into an album: its photos and videos (§9), those not deleted. */
    fun postMedia(attachments: List<AttachmentOut>): List<AttachmentOut> = attachments.filter {
        (it.contentType.startsWith("image/", true) || it.contentType.startsWith("video/", true)) && it.status != "deleted" && it.drive?.state != "trashed" && it.drive?.state != "deleted"
    }

    /** 「この投稿の写真でアルバムを作る」's name (§9): 「#学会 2026-09-16」 (a DM: the day only). */
    fun postAlbumName(channelName: String?, postedAt: String, zone: ZoneId = ZoneId.systemDefault()): String {
        val day = instant(postedAt)?.atZone(zone)?.toLocalDate()?.toString() ?: ""
        return listOfNotNull(channelName?.takeIf { it.isNotBlank() }?.let { "#$it" }, day.takeIf { it.isNotEmpty() }).joinToString(" ")
    }

    /** What 「アルバムに追加」 did, in words: 「3 枚をアルバムに追加しました」, with how many could not go. */
    fun addSummary(results: List<AlbumAddResult>): String {
        val ok = results.count { it.ok }
        val failed = results.size - ok
        val added = L10n.plural(R.plurals.album_added, ok, ok)
        return if (failed == 0) added else added + " " + L10n.plural(R.plurals.album_add_failed, failed, failed)
    }

    /**
     * The slideshow's order (§10.3, §8): the items' indices from [start] on and round again, or shuffled ([random]; the
     * one started from first) with a fixed [seed] so more pages keep what was shown; videos left out with [skipVideos].
     */
    fun slideshowOrder(items: List<DriveItemOut>, start: Int, random: Boolean, skipVideos: Boolean, seed: Long): List<Int> {
        val wanted = items.indices.filter { !skipVideos || !isVideo(items[it]) }
        if (wanted.isEmpty()) return emptyList()
        if (!random) {
            val from = wanted.indexOfFirst { it >= start }.takeIf { it >= 0 } ?: 0
            return wanted.drop(from) + wanted.take(from)
        }
        val first = start.takeIf { it in wanted }
        val rest = wanted.filter { it != first }.shuffled(Random(seed))
        return listOfNotNull(first) + rest
    }

    /**
     * How long a slide stays at most: the interval for a photo; a video ends by itself (its completion moves on), so
     * its time is a guard — its length and two seconds, never past 60 s (§8).
     */
    fun slideMillis(item: DriveItemOut, intervalSeconds: Int): Long =
        if (isVideo(item)) minOf((item.file?.durationMs?.takeIf { it > 0 } ?: VIDEO_MAX_MS) + 2_000L, VIDEO_MAX_MS) else intervalSeconds * 1000L

    /** The viewer's line under the name: 「2026/9/16 9:12 · 位置情報あり」. */
    fun viewerLine(item: DriveItemOut, taken: String?): String =
        listOfNotNull(taken?.takeIf { it.isNotEmpty() }, if (item.file?.hasLocation == true) L10n.str(R.string.album_has_location) else null).joinToString(" · ")

    /** Whether a zoom past the display image should read the original (§12: ピンチで拡大、表示サイズを超えたら元の画像). */
    fun wantsOriginal(scale: Float, shownWidth: Int, originalWidth: Int?): Boolean =
        scale > 1.5f && originalWidth != null && originalWidth > shownWidth * 1.2f

    /** Where saved photos go (§12): Pictures/Taylis, videos Movies/Taylis. */
    fun galleryFolder(contentType: String?): String = if (contentType.orEmpty().startsWith("video/")) "Movies/Taylis" else "Pictures/Taylis"
}

/** The slideshow's choices (§10.3, §8), kept on the device: the interval, shuffled, videos left out. */
data class SlideshowSettings(val interval: Int = AlbumRules.DEFAULT_INTERVAL, val random: Boolean = false, val skipVideos: Boolean = false) {
    fun encode(): String = "$interval|${if (random) 1 else 0}|${if (skipVideos) 1 else 0}"

    companion object {
        /** What [encode] wrote; anything else (nothing yet, an interval no longer offered) falls back to the defaults. */
        fun decode(text: String?): SlideshowSettings {
            val parts = text?.split('|') ?: return SlideshowSettings()
            val interval = parts.getOrNull(0)?.toIntOrNull()?.takeIf { it in AlbumRules.INTERVALS } ?: AlbumRules.DEFAULT_INTERVAL
            return SlideshowSettings(interval, parts.getOrNull(1) == "1", parts.getOrNull(2) == "1")
        }
    }
}

/** An album as the screen shows it: what was read (pages of 100), the next page, how it went. */
data class AlbumState(
    val detail: AlbumDetailOut? = null,
    val items: List<DriveItemOut> = emptyList(),
    val nextCursor: String? = null,
    val loading: Boolean = false,
    val loadingMore: Boolean = false,
    val error: String? = null,
    /** Not there for me (404 drive_item_not_found: the trash, my membership ended). */
    val gone: Boolean = false,
    /** No longer an album (404 drive_album_not_found): the folder's plain listing shows. */
    val notAlbum: Boolean = false,
) {
    val canLoadMore: Boolean get() = nextCursor != null && !loading && !loadingMore
    val album: AlbumOut? get() = detail?.album
}

/**
 * One album's pages (§18.4): the first page, 100 more as the grid nears its end, and a re-read (drive.changed naming
 * the folder, a reconnect, pull to refresh) of as many as are held. An answer older than the latest read is dropped.
 */
class AlbumLoader(private val api: AlbumApi, val folderId: String, private val describe: (Throwable) -> String) {
    private val _state = MutableStateFlow(AlbumState())
    val state: StateFlow<AlbumState> = _state
    private var generation = 0

    suspend fun reload() {
        val ticket = ++generation
        val held = _state.value.items.size
        _state.value = _state.value.copy(loading = true, error = null)
        try {
            val page = api.album(folderId, null, null, null, DriveListing.reloadLimit(held))
            if (ticket != generation) return
            _state.value = AlbumState(detail = page, items = page.items, nextCursor = page.nextCursor)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (ticket != generation) return
            val code = (e as? ApiException.Api)?.code
            _state.value = _state.value.copy(
                loading = false, error = describe(e),
                notAlbum = code == "drive_album_not_found", gone = e.isDriveNotFound() && code != "drive_album_not_found",
            )
        }
    }

    suspend fun loadMore() {
        val now = _state.value
        val cursor = now.nextCursor ?: return
        if (!now.canLoadMore) return
        val ticket = generation
        _state.value = now.copy(loadingMore = true, error = null)
        try {
            val page = api.album(folderId, null, null, cursor, AlbumRules.PAGE)
            if (ticket != generation) return
            _state.value = _state.value.copy(items = DriveListing.appendPage(_state.value.items, page.items), nextCursor = page.nextCursor, loadingMore = false)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (ticket != generation) return
            _state.value = _state.value.copy(loadingMore = false, error = describe(e))
        }
    }

    /** A change made here (the settings, a cover) shown at once; the re-read after drive.changed confirms it. */
    fun showAlbum(album: AlbumOut) {
        val detail = _state.value.detail ?: return
        _state.value = _state.value.copy(detail = detail.copy(album = album))
    }
}

/** The albums list (the drive's top row, the picker): pages of 50, newest first. */
data class AlbumListState(
    val entries: List<AlbumListEntryOut> = emptyList(),
    val nextCursor: String? = null,
    val loading: Boolean = false,
    val loaded: Boolean = false,
    val error: String? = null,
)

class AlbumListLoader(private val api: AlbumApi, private val locationId: String? = null, private val describe: (Throwable) -> String) {
    private val _state = MutableStateFlow(AlbumListState())
    val state: StateFlow<AlbumListState> = _state
    private var generation = 0

    suspend fun reload() {
        val ticket = ++generation
        _state.value = _state.value.copy(loading = true, error = null)
        try {
            val out = api.albums(locationId, null, LIST_PAGE)
            if (ticket == generation) _state.value = AlbumListState(out.items, out.nextCursor, loaded = true)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (ticket == generation) _state.value = _state.value.copy(loading = false, loaded = true, error = describe(e))
        }
    }

    suspend fun loadMore() {
        val now = _state.value
        val cursor = now.nextCursor ?: return
        if (now.loading) return
        val ticket = generation
        _state.value = now.copy(loading = true)
        try {
            val out = api.albums(locationId, cursor, LIST_PAGE)
            if (ticket != generation) return
            val seen = now.entries.mapTo(HashSet()) { it.folder.id }
            _state.value = now.copy(entries = now.entries + out.items.filter { seen.add(it.folder.id) }, nextCursor = out.nextCursor, loading = false)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (ticket == generation) _state.value = now.copy(loading = false, error = describe(e))
        }
    }

    companion object {
        const val LIST_PAGE = 50
    }
}
