package jp.chikuwachat.android

import jp.chikuwachat.android.api.AlbumAddOut
import jp.chikuwachat.android.api.AlbumAddResult
import jp.chikuwachat.android.api.AlbumCoverOut
import jp.chikuwachat.android.api.AlbumCreatedOut
import jp.chikuwachat.android.api.AlbumDetailOut
import jp.chikuwachat.android.api.AlbumListEntryOut
import jp.chikuwachat.android.api.AlbumListOut
import jp.chikuwachat.android.api.AlbumOut
import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.AttachmentDriveOut
import jp.chikuwachat.android.api.AttachmentOut
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.DriveFileOut
import jp.chikuwachat.android.api.DriveItemOut
import jp.chikuwachat.android.sync.AlbumApi
import jp.chikuwachat.android.sync.AlbumCell
import jp.chikuwachat.android.sync.AlbumListLoader
import jp.chikuwachat.android.sync.AlbumLoader
import jp.chikuwachat.android.sync.AlbumRules
import jp.chikuwachat.android.sync.DriveApi
import jp.chikuwachat.android.sync.DriveHub
import jp.chikuwachat.android.sync.DriveNames
import jp.chikuwachat.android.sync.SlideshowSettings
import jp.chikuwachat.android.sync.describeDriveError
import jp.chikuwachat.android.ui.ImageDismiss
import jp.chikuwachat.android.ui.albumViewerPages
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate
import java.time.ZoneId

/** AL4 (docs/ALBUMS.md §12, §18.4): the phone's albums — the grid's days, the lines, the orders, the pages, the API's shapes. */
class AlbumsTest {
    private val tokyo = ZoneId.of("Asia/Tokyo")
    private val today = LocalDate.of(2026, 10, 29)

    private fun photo(id: String, taken: String? = null, modified: String? = null, type: String = "image/jpeg", duration: Long? = null, location: Boolean = false) = DriveItemOut(
        id = id, locationId = "loc", parentId = "album", name = "$id.jpg", contentType = type, createdAt = "2026-10-01T00:00:00Z", contentModifiedAt = modified,
        file = DriveFileOut(attachmentId = "a-$id", hasThumbnail = !type.startsWith("video"), hasPoster = type.startsWith("video"), durationMs = duration, takenAt = taken, hasLocation = location, hasDisplay = true, width = 4032),
    )

    private fun album(
        photos: Int = 0, videos: Int = 0, starts: String? = null, ends: String? = null, from: String? = null, to: String? = null,
        cover: String? = null, previews: List<String> = emptyList(),
    ) = AlbumOut(
        folderId = "album", photoCount = photos, videoCount = videos, startsOn = starts, endsOn = ends, takenFrom = from, takenTo = to,
        cover = cover?.let { AlbumCoverOut("i-$it", it) }, previewAttachmentIds = previews,
    )

    @Test
    fun offsetsAndZuluBothRead() {
        assertEquals(AlbumRules.instant("2026-09-16T00:12:00Z"), AlbumRules.instant("2026-09-16T09:12:00+09:00"))
        assertNull(AlbumRules.instant("not a time"))
        assertNull(AlbumRules.instant(null))
    }

    @Test
    fun theGridHeadsEachCaptureDayOnce() {
        val items = listOf(
            photo("1", taken = "2026-09-16T09:12:00+09:00"),
            photo("2", taken = "2026-09-16T23:30:00+09:00"),
            photo("3", taken = "2026-09-16T15:30:00Z"), // 00:30 on the 17th in Tokyo
            photo("4", modified = "2025-12-31T03:00:00Z"), // no capture time: the file's own
        )
        val cells = AlbumRules.cells(items, "taken", tokyo, today)
        val days = cells.filterIsInstance<AlbumCell.Day>()
        assertEquals(listOf(LocalDate.of(2026, 9, 16), LocalDate.of(2026, 9, 17), LocalDate.of(2025, 12, 31)), days.map { it.day })
        assertEquals("9 月 16 日（水）", days[0].label)
        assertEquals("2025 年 12 月 31 日（水）", days[2].label)
        assertEquals(listOf("day:2026-09-16", "1", "2", "day:2026-09-17", "3", "day:2025-12-31", "4"), cells.map { it.key })
        assertEquals(2, (cells[4] as AlbumCell.Photo).index)
        // Keys stay unique when a day comes back after another (a photo without a time between, a name order).
        val back = AlbumRules.cells(listOf(items[0], items[2], items[1]), "taken", tokyo, today)
        assertEquals(back.map { it.key }.distinct(), back.map { it.key })
        // By name or by when added: no headings.
        assertTrue(AlbumRules.cells(items, "name", tokyo, today).all { it is AlbumCell.Photo })
    }

    @Test
    fun theDatesLineIsTheEventsElseThePhotos() {
        assertEquals("2026/9/16〜9/19", AlbumRules.dateLine(album(starts = "2026-09-16", ends = "2026-09-19"), tokyo))
        assertEquals("2026/12/30〜2027/1/2", AlbumRules.dateLine(album(starts = "2026-12-30", ends = "2027-01-02"), tokyo))
        assertEquals("2026/9/16", AlbumRules.dateLine(album(starts = "2026-09-16"), tokyo)) // one day set: not the photos' end
        assertEquals("2026/9/16〜9/17", AlbumRules.dateLine(album(from = "2026-09-16T00:12:00Z", to = "2026-09-16T15:30:00Z"), tokyo))
        assertEquals("2026/9/16", AlbumRules.dateLine(album(from = "2026-09-16T00:12:00Z", to = "2026-09-16T01:00:00Z"), tokyo))
        assertEquals("", AlbumRules.dateLine(album(), tokyo))
    }

    @Test
    fun countsAndTheCardsLine() {
        assertEquals("312 枚", AlbumRules.countLine(album(photos = 312)))
        assertEquals("312 枚 · 動画 8 本", AlbumRules.countLine(album(photos = 312, videos = 8)))
        assertEquals("312 枚 · 2026/9/16〜9/19", AlbumRules.cardLine(album(photos = 312, starts = "2026-09-16", ends = "2026-09-19"), tokyo))
        assertEquals("0 枚", AlbumRules.cardLine(album(), tokyo))
    }

    @Test
    fun theCardShowsFourPicturesTheCoverFirst() {
        assertEquals(listOf("a", "b", "c", "d"), AlbumRules.previews(album(cover = "a", previews = listOf("a", "b", "c", "d"))))
        assertEquals(listOf("z", "a", "b", "c"), AlbumRules.previews(album(cover = "z", previews = listOf("a", "b", "c", "d"))))
        assertEquals(emptyList<String>(), AlbumRules.previews(album()))
    }

    @Test
    fun aNewAlbumGoesIntoTheLocationsAlbumsFolderAtItsTop() {
        assertEquals(null to "loc", AlbumRules.createTarget("root", "root", "loc"))
        assertEquals("sub" to null, AlbumRules.createTarget("sub", "root", "loc"))
        assertEquals(null to "loc", AlbumRules.createTarget("sub", null, "loc")) // the location not read yet
    }

    @Test
    fun thePickerListsTheChannelsAlbumsFirst() {
        fun entry(id: String, location: String) = AlbumListEntryOut(DriveItemOut(id = id, locationId = location, kind = "folder", name = id), album())
        val entries = listOf(entry("lab", "ws"), entry("ch1", "ch"), entry("mine", "me"), entry("ch2", "ch"))
        assertEquals(listOf("ch1", "ch2", "lab", "mine"), AlbumRules.pickerOrder(entries, "ch").map { it.folder.id })
        assertEquals(entries, AlbumRules.pickerOrder(entries, null))
    }

    @Test
    fun aPostsPhotosAndVideosOnly() {
        fun file(id: String, type: String, status: String = "attached", drive: String? = null) =
            AttachmentOut(id = id, filename = id, contentType = type, sizeBytes = 1, status = status, drive = drive?.let { AttachmentDriveOut(itemId = "i", state = it) })
        val all = listOf(file("p", "image/jpeg"), file("v", "video/mp4"), file("pdf", "application/pdf"), file("gone", "image/png", drive = "trashed"), file("moved", "image/png", drive = "moved"))
        assertEquals(listOf("p", "v", "moved"), AlbumRules.postMedia(all).map { it.id })
        assertEquals("#学会 2026-09-16", AlbumRules.postAlbumName("学会", "2026-09-16T01:00:00Z", tokyo))
        assertEquals("2026-09-17", AlbumRules.postAlbumName(null, "2026-09-16T15:30:00Z", tokyo)) // a DM, the day in Tokyo
    }

    @Test
    fun theAddsSummary() {
        assertEquals("3 件をアルバムに追加しました。", AlbumRules.addSummary(List(3) { AlbumAddResult("s$it", ok = true) }))
        assertEquals(
            "2 件をアルバムに追加しました。 1 件は追加できませんでした。",
            AlbumRules.addSummary(listOf(AlbumAddResult("a", true), AlbumAddResult("b", true), AlbumAddResult("c", false, error = "attachment_not_found"))),
        )
    }

    @Test
    fun theSlideshowsOrder() {
        val items = listOf(photo("0"), photo("1", type = "video/mp4"), photo("2"), photo("3"))
        assertEquals(listOf(2, 3, 0, 1), AlbumRules.slideshowOrder(items, 2, random = false, skipVideos = false, seed = 1))
        assertEquals(listOf(2, 3, 0), AlbumRules.slideshowOrder(items, 2, random = false, skipVideos = true, seed = 1))
        assertEquals(listOf(2, 3, 0), AlbumRules.slideshowOrder(items, 1, random = false, skipVideos = true, seed = 1)) // a skipped start: the next
        val shuffled = AlbumRules.slideshowOrder(items, 3, random = true, skipVideos = false, seed = 7)
        assertEquals(3, shuffled.first())
        assertEquals(setOf(0, 1, 2, 3), shuffled.toSet())
        assertEquals(shuffled, AlbumRules.slideshowOrder(items, 3, random = true, skipVideos = false, seed = 7)) // the same seed, the same order
        assertEquals(emptyList<Int>(), AlbumRules.slideshowOrder(listOf(items[1]), 0, random = false, skipVideos = true, seed = 1))
    }

    @Test
    fun aSlidesTime() {
        assertEquals(5_000L, AlbumRules.slideMillis(photo("p"), 5))
        assertEquals(12_000L, AlbumRules.slideMillis(photo("v", type = "video/mp4", duration = 10_000), 5)) // to its end (a guard past it)
        assertEquals(60_000L, AlbumRules.slideMillis(photo("v", type = "video/mp4", duration = 300_000), 5)) // at most 60 s
        assertEquals(60_000L, AlbumRules.slideMillis(photo("v", type = "video/mp4"), 5))
    }

    @Test
    fun theSlideshowsSettingsRoundTrip() {
        assertEquals(SlideshowSettings(), SlideshowSettings.decode(null))
        val chosen = SlideshowSettings(interval = 10, random = true, skipVideos = true)
        assertEquals(chosen, SlideshowSettings.decode(chosen.encode()))
        assertEquals(5, SlideshowSettings.decode("7|1|0").interval) // an interval no longer offered
        assertEquals(SlideshowSettings(), SlideshowSettings.decode("garbage"))
    }

    @Test
    fun theViewerReadsTheOriginalOnlyPastTheDisplayImage() {
        assertFalse(AlbumRules.wantsOriginal(1.2f, 2048, 4032))
        assertTrue(AlbumRules.wantsOriginal(2f, 2048, 4032))
        assertFalse(AlbumRules.wantsOriginal(3f, 2048, 2048)) // the display image is the original's size
        assertFalse(AlbumRules.wantsOriginal(3f, 2048, null))
        assertTrue(AlbumRules.displayMissing(ApiException.Api(404, "http_404", "no display")))
        assertFalse(AlbumRules.displayMissing(ApiException.Api(500, "http_500", "boom")))
        assertEquals("Pictures/Taylis", AlbumRules.galleryFolder("image/jpeg"))
        assertEquals("Movies/Taylis", AlbumRules.galleryFolder("video/mp4"))
    }

    @Test
    fun theViewersPagesAndLine() {
        val items = listOf(photo("p", taken = "2026-09-16T00:12:00Z", location = true), photo("v", type = "video/mp4"))
        val pages = albumViewerPages(items)
        assertEquals(listOf("p", "v"), pages.map { it.key })
        assertTrue(pages[0].display)
        assertFalse(pages[0].video)
        assertTrue(pages[1].video)
        assertTrue(pages[0].subtitle!!.endsWith("位置情報あり"))
        assertEquals("", AlbumRules.viewerLine(items[1], null))
    }

    @Test
    fun swipingSidewaysTurnsThePageOnlyAmongSeveralAtTheFitSize() {
        assertEquals(ImageDismiss.Gesture.PAGE, ImageDismiss.decide(dx = 20f, dy = 5f, scale = 1f, pointers = 1, paging = true))
        assertEquals(ImageDismiss.Gesture.TRANSFORM, ImageDismiss.decide(dx = 20f, dy = 5f, scale = 1f, pointers = 1)) // one photo
        assertEquals(ImageDismiss.Gesture.TRANSFORM, ImageDismiss.decide(dx = 20f, dy = 5f, scale = 2f, pointers = 1, paging = true)) // zoomed: pans
        assertEquals(ImageDismiss.Gesture.TRANSFORM, ImageDismiss.decide(dx = 20f, dy = 5f, scale = 1f, pointers = 2, paging = true)) // a pinch
        assertEquals(ImageDismiss.Gesture.PULL, ImageDismiss.decide(dx = 2f, dy = 20f, scale = 1f, pointers = 1, paging = true))
    }

    @Test
    fun anAlbumFolderShowsItsCoverAndIcon() {
        val folder = DriveItemOut(id = "f", kind = "folder", name = "学会", album = album(cover = "c1"))
        assertEquals("/api/v1/attachments/c1/thumbnail", DriveNames.thumbnailPath(folder))
        assertEquals(DriveNames.Icon.ALBUM, DriveNames.icon(folder))
        assertEquals(DriveNames.Icon.FOLDER, DriveNames.icon(folder.copy(album = null)))
        assertNull(DriveNames.thumbnailPath(folder.copy(album = null)))
    }

    @Test
    fun theApisShapesDecode() {
        val text = """
            {"folder": {"id": "f", "location_id": "loc", "parent_id": "p", "kind": "folder", "name": "学会", "size_bytes": null, "content_type": null,
              "content_modified_at": null, "created_by": null, "created_at": "2026-10-01T00:00:00Z", "updated_by": null, "updated_at": "2026-10-01T00:00:00Z",
              "version_count": 0, "file": null, "link_count": 0,
              "album": {"folder_id": "f", "description": "", "cover": {"item_id": "i1", "attachment_id": "a1"}, "cover_item_id": null, "sort": "taken",
                "sort_order": "asc", "starts_on": "2026-09-16", "ends_on": null, "taken_from": null, "taken_to": null, "photo_count": 2, "video_count": 0,
                "size_bytes": 10, "preview_attachment_ids": ["a1"], "created_by": null, "created_at": "x", "updated_at": "x"}},
             "album": {"folder_id": "f", "description": "秋", "cover": null, "cover_item_id": null, "sort": "taken", "sort_order": "asc", "starts_on": null,
               "ends_on": null, "taken_from": null, "taken_to": null, "photo_count": 2, "video_count": 0, "size_bytes": 10, "preview_attachment_ids": [],
               "created_by": null, "created_at": "x", "updated_at": "x"},
             "path": [{"id": "root", "name": "研究室ドライブ"}], "location_kind": "workspace", "can_write": true,
             "items": [{"id": "i1", "location_id": "loc", "parent_id": "f", "kind": "file", "name": "a.jpg", "size_bytes": 5, "content_type": "image/jpeg",
               "content_modified_at": null, "created_by": null, "created_at": "x", "updated_by": null, "updated_at": "x", "version_count": 1, "link_count": 0,
               "file": {"attachment_id": "a1", "version_id": "v1", "width": 4032, "height": 3024, "has_thumbnail": true, "has_poster": false,
                 "duration_ms": null, "preview": null, "taken_at": "2026-09-16T09:12:00+09:00", "has_location": true, "has_display": true,
                 "display_width": 2048, "display_height": 1536}}],
             "next_cursor": "c", "folder_count": 1, "other_count": 2, "shared_above": 0}
        """.trimIndent()
        val detail = Codec.snake.decodeFromString(AlbumDetailOut.serializer(), text)
        assertEquals("a1", detail.folder.album?.cover?.attachmentId)
        assertEquals("秋", detail.album.description)
        assertTrue(detail.canWrite)
        assertEquals(2048, detail.items[0].file?.displayWidth)
        assertTrue(detail.items[0].file!!.hasLocation)
        assertEquals(2, detail.otherCount)
        val attachment = Codec.snake.decodeFromString(AttachmentOut.serializer(), """{"id": "a", "filename": "a.jpg", "content_type": "image/jpeg", "size_bytes": 1, "has_display": true}""")
        assertTrue(attachment.hasDisplay)
    }

    private class FakeAlbums : AlbumApi {
        var pages = HashMap<String?, AlbumDetailOut>()
        var fail: Exception? = null
        val asked = ArrayList<Pair<String?, Int>>()
        var list: (String?) -> AlbumListOut = { AlbumListOut() }

        override suspend fun albums(locationId: String?, cursor: String?, limit: Int): AlbumListOut = list(cursor)
        override suspend fun album(folderId: String, sort: String?, order: String?, cursor: String?, limit: Int): AlbumDetailOut {
            asked += cursor to limit
            fail?.let { throw it }
            return pages[cursor] ?: error("no page $cursor")
        }
        override suspend fun createAlbum(parentId: String?, locationId: String?, name: String, description: String?, clientOpId: String): AlbumCreatedOut = error("unused")
        override suspend fun putAlbum(folderId: String, fields: Map<String, String?>): AlbumOut = error("unused")
        override suspend fun deleteAlbum(folderId: String) = Unit
        override suspend fun addToAlbum(folderId: String, attachmentIds: List<String>, itemIds: List<String>, mode: String, clientOpId: String) = AlbumAddOut()
    }

    private fun detail(items: List<DriveItemOut>, next: String?) =
        AlbumDetailOut(folder = DriveItemOut(id = "album", kind = "folder", name = "学会"), album = album(photos = 150), items = items, nextCursor = next)

    @Test
    fun theAlbumReadsPagesAndKeepsItsPlaceOnAReread() = runBlocking {
        val api = FakeAlbums()
        val first = (0 until 100).map { photo("p$it") }
        val second = (100 until 150).map { photo("p$it") }
        api.pages[null] = detail(first, "c2")
        api.pages["c2"] = detail(listOf(first.last()) + second, null) // one moved between pages counts once
        val loader = AlbumLoader(api, "album", ::describeDriveError)
        loader.reload()
        assertEquals(100, loader.state.value.items.size)
        assertTrue(loader.state.value.canLoadMore)
        loader.loadMore()
        assertEquals(150, loader.state.value.items.size)
        assertFalse(loader.state.value.canLoadMore)
        api.pages[null] = detail(first + second, null)
        loader.reload() // drive.changed: as many as are held
        assertEquals(null to 150, api.asked.last())
        assertEquals(150, loader.state.value.items.size)
    }

    @Test
    fun anAlbumNoLongerOneOrGoneIsTold() = runBlocking {
        val api = FakeAlbums()
        api.fail = ApiException.Api(404, "drive_album_not_found", "not an album")
        val loader = AlbumLoader(api, "album", ::describeDriveError)
        loader.reload()
        assertTrue(loader.state.value.notAlbum)
        assertFalse(loader.state.value.gone)
        api.fail = ApiException.Api(404, "drive_item_not_found", "gone")
        loader.reload()
        assertTrue(loader.state.value.gone)
    }

    @Test
    fun theAlbumsListPagesWithoutRepeats() = runBlocking {
        fun entry(id: String) = AlbumListEntryOut(DriveItemOut(id = id, kind = "folder", name = id), album())
        val api = FakeAlbums()
        api.list = { cursor -> if (cursor == null) AlbumListOut(listOf(entry("a"), entry("b")), "n") else AlbumListOut(listOf(entry("b"), entry("c")), null) }
        val loader = AlbumListLoader(api, null, ::describeDriveError)
        loader.reload()
        loader.loadMore()
        assertEquals(listOf("a", "b", "c"), loader.state.value.entries.map { it.folder.id })
        assertTrue(loader.state.value.loaded)
    }

    @Test
    fun anyDriveChangeReadsTheAlbumsListAgain() {
        val hub = DriveHub(null as DriveApi?, CoroutineScope(Dispatchers.Unconfined), debounceMs = 0)
        val before = hub.anyEpoch()
        hub.applyChanged(listOf("x"), 1)
        assertEquals(before + 1, hub.anyEpoch())
        hub.online()
        assertEquals(before + 2, hub.anyEpoch())
    }
}
