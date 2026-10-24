package jp.chikuwachat.android

import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.ChannelOut
import jp.chikuwachat.android.api.DriveChildrenOut
import jp.chikuwachat.android.api.DriveCrumb
import jp.chikuwachat.android.api.DriveDownloadTicketOut
import jp.chikuwachat.android.api.DriveFileOut
import jp.chikuwachat.android.api.DriveItemDetailOut
import jp.chikuwachat.android.api.DriveItemOut
import jp.chikuwachat.android.api.DriveLocationListOut
import jp.chikuwachat.android.api.DriveLocationOut
import jp.chikuwachat.android.api.DriveSearchOut
import jp.chikuwachat.android.api.DriveZipOut
import jp.chikuwachat.android.api.AttachmentPreviewOut
import jp.chikuwachat.android.api.ThreadSummary
import jp.chikuwachat.android.sync.ChannelState
import jp.chikuwachat.android.sync.DriveApi
import jp.chikuwachat.android.sync.DriveFolderLoader
import jp.chikuwachat.android.sync.DriveHub
import jp.chikuwachat.android.sync.DriveLinkState
import jp.chikuwachat.android.sync.DriveLinks
import jp.chikuwachat.android.sync.DriveListing
import jp.chikuwachat.android.sync.DriveNames
import jp.chikuwachat.android.sync.DriveSort
import jp.chikuwachat.android.sync.describeDriveError
import jp.chikuwachat.android.ui.ConversationNav
import jp.chikuwachat.android.ui.ConversationTab
import jp.chikuwachat.android.ui.HomeTile
import jp.chikuwachat.android.ui.HomeTiles
import jp.chikuwachat.android.ui.MainNav
import jp.chikuwachat.android.ui.NavItems
import jp.chikuwachat.android.ui.Permalink
import jp.chikuwachat.android.ui.Route
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** M166 (docs/DRIVE.md §26): the phone's drive — links, names, pages, the cards' states, the hub's signals, the tile. */
class DriveTest {
    private val base = "http://10.0.2.2:18766"
    private val id = "01a16063-9d83-753d-a072-1f33464eecfe"

    private fun item(id: String, name: String = id, kind: String = "file", size: Long? = 10, type: String? = "application/pdf", file: DriveFileOut? = null) =
        DriveItemOut(id = id, locationId = "loc", parentId = "root", kind = kind, name = name, sizeBytes = size, contentType = type, updatedAt = "2026-10-01T00:00:00Z", file = file)

    private fun location(id: String, kind: String, name: String) = DriveLocationOut(id = id, kind = kind, rootId = "$id-root", name = name)

    @Test
    fun driveLinksAreThisServersOnly() {
        assertEquals(id, Permalink.driveId(base, "$base/d/$id"))
        assertEquals(id, Permalink.driveId(base, "$base/D/${id.uppercase()}?x=1#y"))
        assertNull(Permalink.driveId(base, "https://other.example/d/$id"))
        assertNull(Permalink.driveId(base, "$base/d/not-an-id"))
        assertEquals("$base/d/$id", Permalink.driveUrl("$base/", id))
    }

    @Test
    fun aBodysLinksAreCardsOnceEachAtMostThree() {
        val ids = (1..5).map { "01a16063-9d83-753d-a072-1f33464eecf$it" }
        val body = "修論: $base/d/${ids[0]}\n同じ: [名前]($base/d/${ids[0]})\n" + ids.drop(1).joinToString("\n") { "$base/d/$it" } + "\nほか: https://x.example/d/${ids[4]}"
        assertEquals(ids, DriveLinks.idsIn(base, body))
        assertEquals(ids.take(3), DriveLinks.cards(base, body))
        assertTrue(DriveLinks.idsIn(null, body).isEmpty())
        assertTrue(DriveLinks.idsIn("https://x.example", "nothing here").isEmpty())
    }

    @Test
    fun theInlineLabelNeverShowsTheMarkdownName() {
        val detail = DriveItemDetailOut(item(id, "修論_最終版.pdf"), listOf(DriveCrumb("r", "研究室ドライブ")), "workspace")
        assertEquals("📎 修論_最終版.pdf", DriveLinks.label(DriveLinkState.Ok(detail)))
        assertEquals("📁 ゼミ", DriveLinks.label(DriveLinkState.Ok(detail.copy(item = item("f", "ゼミ", kind = "folder")))))
        assertEquals("表示できないファイル", DriveLinks.label(DriveLinkState.Unreadable))
        assertEquals("ドライブのファイル", DriveLinks.label(null))
        assertEquals("ドライブのファイル", DriveLinks.label(DriveLinkState.Failed))
    }

    @Test
    fun locationsAreNamedByKindAndOrdered() {
        val list = listOf(location("c2", "channel", "論文紹介"), location("me", "user", "マイドライブ"), location("c1", "channel", "学会準備"), location("ws", "workspace", "研究室ドライブ"))
        assertEquals(listOf("ws", "me", "c1", "c2"), DriveNames.order(list).map { it.id })
        assertEquals("研究室ドライブ", DriveNames.locationName("workspace", "Lab"))
        assertEquals("マイドライブ", DriveNames.locationName("user", "x"))
        assertEquals("#学会準備", DriveNames.locationName("channel", "学会準備"))
    }

    @Test
    fun pathsNameTheirRootByTheLocationsKind() {
        val path = listOf(DriveCrumb("r", "Lab drive"), DriveCrumb("a", "論文"), DriveCrumb("b", "2026年度"))
        assertEquals("研究室ドライブ › 論文 › 2026年度", DriveNames.pathLine(path, "workspace"))
        assertEquals("マイドライブ › 論文 › 2026年度", DriveNames.pathLine(path, "user"))
        assertEquals("#Lab drive › 論文 › 2026年度", DriveNames.pathLine(path, "channel"))
        assertEquals(listOf("研究室ドライブ", "論文", "2026年度"), DriveNames.crumbs(path, "workspace").map { it.name })
        assertEquals("", DriveNames.pathLine(emptyList(), "workspace"))
    }

    @Test
    fun theCardsSecondLine() {
        val path = listOf(DriveCrumb("r", "研究室ドライブ"), DriveCrumb("a", "論文"))
        assertEquals("研究室ドライブ › 論文 · 4.6 MB", DriveNames.cardDetails(DriveItemDetailOut(item(id, size = 4_823_112), path, "workspace")))
        assertEquals("研究室ドライブ › 論文 · フォルダ", DriveNames.cardDetails(DriveItemDetailOut(item("f", kind = "folder", size = null), path, "workspace")))
    }

    @Test
    fun sizesGoPastMegabytes() {
        assertEquals("", DriveNames.bytes(null))
        assertEquals("512 B", DriveNames.bytes(512))
        assertEquals("2 KB", DriveNames.bytes(2048))
        assertEquals("4.6 MB", DriveNames.bytes(4_823_112))
        assertEquals("300 MB", DriveNames.bytes(300L * 1024 * 1024))
        assertEquals("1.5 GB", DriveNames.bytes(1536L * 1024 * 1024))
        assertEquals("20 GB", DriveNames.bytes(20L * 1024 * 1024 * 1024))
    }

    @Test
    fun whichViewerOpensAFile() {
        val ready = AttachmentPreviewOut("ready", pages = 6)
        assertEquals(DriveNames.Viewer.DOCUMENT, DriveNames.viewer(item("a", file = DriveFileOut("att", preview = ready))))
        assertEquals(DriveNames.Viewer.DOCUMENT, DriveNames.viewer(item("a", "発表資料.docx", type = "application/vnd.openxmlformats-officedocument.wordprocessingml.document", file = DriveFileOut("att", preview = ready))))
        // §27.3 (2026-10-24): a PDF opens the viewer whatever its preview (its own bytes while none is ready).
        assertEquals(DriveNames.Viewer.DOCUMENT, DriveNames.viewer(item("a", file = DriveFileOut("att", preview = AttachmentPreviewOut("pending")))))
        assertEquals(DriveNames.Viewer.IMAGE, DriveNames.viewer(item("a", type = "image/jpeg", file = DriveFileOut("att", hasThumbnail = true))))
        assertNull(DriveNames.viewer(item("a", type = "image/jpeg", file = DriveFileOut("att", hasThumbnail = false))))
        assertEquals(DriveNames.Viewer.VIDEO, DriveNames.viewer(item("a", type = "video/mp4", file = DriveFileOut("att", hasPoster = true))))
        assertNull(DriveNames.viewer(item("a", type = "application/octet-stream", file = DriveFileOut("att"))))
        assertNull(DriveNames.viewer(item("f", kind = "folder", file = null)))
        assertEquals("/api/v1/attachments/att/thumbnail", DriveNames.thumbnailPath(item("a", type = "video/mp4", file = DriveFileOut("att", hasPoster = true))))
        assertEquals("/api/v1/attachments/att/preview/thumbnail", DriveNames.thumbnailPath(item("a", file = DriveFileOut("att", preview = ready))))
        val attachment = DriveNames.asAttachment(item("a", "修論.pdf", file = DriveFileOut("att", preview = ready)))!!
        assertEquals("att", attachment.id)
        assertEquals("修論.pdf", attachment.filename)
        assertEquals(DriveNames.Icon.SHEET, DriveNames.icon(item("x", "data.xlsx", type = null)))
    }

    @Test
    fun pagesAndSorting() {
        val held = listOf(item("a"), item("b"))
        assertEquals(listOf("a", "b", "c"), DriveListing.appendPage(held, listOf(item("b"), item("c"))).map { it.id })
        assertEquals(100, DriveListing.reloadLimit(3))
        assertEquals(150, DriveListing.reloadLimit(150))
        assertEquals(200, DriveListing.reloadLimit(900))
        val state = jp.chikuwachat.android.sync.DriveFolderState()
        assertEquals(DriveSort.NAME to "desc", DriveListing.choose(state, DriveSort.NAME))
        assertEquals(DriveSort.MODIFIED to "desc", DriveListing.choose(state, DriveSort.MODIFIED))
        assertEquals(DriveSort.SIZE to "asc", DriveListing.choose(state.copy(sort = DriveSort.SIZE, order = "desc"), DriveSort.SIZE))
    }

    private class FakeDrive : DriveApi {
        var children: (String, String, String, String?, Int) -> DriveChildrenOut = { _, _, _, _, _ -> throw ApiException.Api(404, "drive_item_not_found", "gone") }
        var items = HashMap<String, () -> DriveItemDetailOut>()
        var itemReads = 0
        var locations: () -> DriveLocationListOut = { DriveLocationListOut() }
        var resolved = 0
        override suspend fun driveLocations() = locations()
        override suspend fun resolveDriveLocation(channelId: String?): DriveLocationOut {
            resolved += 1
            return DriveLocationOut(id = channelId ?: "me", kind = if (channelId == null) "user" else "channel", channelId = channelId, rootId = "r", name = "x")
        }
        override suspend fun driveChildren(folderId: String, sort: String, order: String, cursor: String?, limit: Int) = children(folderId, sort, order, cursor, limit)
        override suspend fun driveItem(itemId: String): DriveItemDetailOut {
            itemReads += 1
            return (items[itemId] ?: throw ApiException.Api(404, "drive_item_not_found", "gone"))()
        }
        override suspend fun searchDrive(q: String, locationId: String?, cursor: String?, limit: Int) = DriveSearchOut()
        override suspend fun driveDownloadTicket(itemId: String) = DriveDownloadTicketOut("/api/v1/drive/download/t", 300)
        override suspend fun driveZip(itemIds: List<String>) = DriveZipOut("/api/v1/drive/zip/t")
    }

    @Test
    fun aFolderPagesByItsCursorAndKnowsWhenItIsGone() = runBlocking {
        val api = FakeDrive()
        val all = (1..150).map { item("f%03d".format(it)) }
        val asked = mutableListOf<String>()
        api.children = { _, sort, order, cursor, limit ->
            asked += "$sort $order ${cursor ?: "-"} $limit"
            val from = cursor?.toInt() ?: 0
            val page = all.drop(from).take(limit)
            DriveChildrenOut(item("folder", kind = "folder"), emptyList(), page, if (from + page.size < all.size) (from + page.size).toString() else null)
        }
        val loader = DriveFolderLoader(api, "folder", ::describeDriveError)
        loader.reload()
        assertEquals(100, loader.state.value.items.size)
        assertTrue(loader.state.value.canLoadMore)
        loader.loadMore()
        assertEquals(150, loader.state.value.items.size)
        assertNull(loader.state.value.nextCursor)
        // A refresh keeps the place: as many rows as are held.
        loader.reload()
        assertEquals("name asc - 150", asked.last())
        // Another sort starts over at one page.
        loader.reload(DriveSort.SIZE, "desc")
        assertEquals("size desc - 100", asked.last())
        api.children = { _, _, _, _, _ -> throw ApiException.Api(404, "drive_item_not_found", "gone") }
        loader.reload()
        assertTrue(loader.state.value.gone)
    }

    @Test
    fun cardsReadTheirItemOnceAMinute() = runBlocking {
        val api = FakeDrive()
        var now = 0L
        api.items[id] = { DriveItemDetailOut(item(id, "修論.pdf"), emptyList(), "workspace") }
        val hub = DriveHub(api, CoroutineScope(Dispatchers.Unconfined), clock = { now }, debounceMs = 0)
        assertTrue(hub.link(id) is DriveLinkState.Ok)
        hub.link(id)
        assertEquals(1, api.itemReads)
        now = DriveHub.LINK_TTL_MS + 1
        assertNull(hub.peekLink(id))
        hub.link(id)
        assertEquals(2, api.itemReads)
        // 404 (another location, the trash, deleted) is 「表示できないファイル」; a 5xx can be tried again.
        assertEquals(DriveLinkState.Unreadable, hub.link("01a16063-b7ff-7e44-81b4-16aa189f9f30"))
        api.items["x"] = { throw ApiException.Api(503, "http_503", "down") }
        assertEquals(DriveLinkState.Failed, hub.link("x"))
        api.items["x"] = { DriveItemDetailOut(item("x"), emptyList(), "user") }
        assertTrue(hub.link("x") is DriveLinkState.Ok)
    }

    @Test
    fun drivesChangedNamesTheFoldersAndDropsOlderEvents() = runBlocking {
        val hub = DriveHub(FakeDrive(), CoroutineScope(Dispatchers.Unconfined), debounceMs = 0)
        val before = hub.folderEpoch("a")
        hub.applyChanged(listOf("a"), 5)
        assertEquals(before + 1, hub.folderEpoch("a"))
        assertEquals(0, hub.folderEpoch("b"))
        hub.applyChanged(listOf("a"), 5) // the same event again
        hub.applyChanged(listOf("a"), 3) // an older one after it
        assertEquals(before + 1, hub.folderEpoch("a"))
        hub.online() // reconnected: every folder reads again
        assertEquals(1, hub.folderEpoch("b"))
    }

    @Test
    fun theServerHasTheDriveOnlyWhenItsLocationsAnswer() = runBlocking {
        val api = FakeDrive()
        val hub = DriveHub(api, CoroutineScope(Dispatchers.Unconfined), debounceMs = 0)
        assertNull(hub.available)
        api.locations = { throw ApiException.Api(404, "http_404", "no drive") }
        hub.loadLocations()
        assertEquals(false, hub.available)
        api.locations = { DriveLocationListOut(listOf(location("ws", "workspace", "研究室ドライブ"))) }
        hub.loadLocations(withMine = true)
        assertEquals(true, hub.available)
        assertEquals(listOf("ws", "me"), hub.locations!!.map { it.id }) // マイドライブ made on opening
        assertEquals(1, api.resolved)
        val guest = DriveHub(api, CoroutineScope(Dispatchers.Unconfined), isGuest = { true }, debounceMs = 0)
        guest.loadLocations(withMine = true)
        assertEquals(listOf("ws"), guest.locations!!.map { it.id })
    }

    @Test
    fun theTileAndTheTabFollowTheServer() {
        assertFalse("drive" in NavItems.implemented(attendance = false))
        assertTrue("drive" in NavItems.implemented(attendance = false, drive = true))
        val threads = ThreadSummary()
        val off = HomeTiles.tiles(threads, 0, 0, 0, navItems = null).map { it.tile }
        assertFalse(HomeTile.DRIVE in off)
        val on = HomeTiles.tiles(threads, 0, 0, 0, navItems = null, drive = true).map { it.tile }
        assertEquals(on.indexOf(HomeTile.FILES) + 1, on.indexOf(HomeTile.DRIVE))
        assertEquals("ドライブ", NavItems.label("drive"))
        fun state(type: String) = ChannelState(ChannelOut(id = "c", type = type, name = "lab", archived = false, lastSeq = 0, createdAt = "", updatedAt = ""), isMember = true)
        assertTrue(ConversationTab.DRIVE in ConversationNav.tabs(state("private"), drive = true))
        assertFalse(ConversationTab.DRIVE in ConversationNav.tabs(state("public")))
        assertFalse(ConversationTab.DRIVE in ConversationNav.tabs(state("dm"), drive = true))
        assertFalse(ConversationTab.DRIVE in ConversationNav.tabs(state("group_dm"), drive = true))
    }

    @Test
    fun foldersStackAndBackGoesUpThem() {
        val home = listOf<Route>(Route.ChannelList, Route.Drive())
        val a = MainNav.openDriveFolder(home, "loc", "root")
        val b = MainNav.openDriveFolder(a, "loc", "sub")
        val c = MainNav.openDriveFolder(b, "loc", "deep")
        assertEquals(b, MainNav.back(c))
        assertEquals(a, MainNav.openDriveCrumb(c, "loc", "root"))
        assertEquals(c + Route.Drive("loc", "other"), MainNav.openDriveCrumb(c, "loc", "other"))
        assertEquals(c.dropLast(1) + Route.Drive("loc", "deep", "file"), MainNav.openDriveFolder(c, "loc", "deep", "file"))
        assertEquals(b.dropLast(1) + Route.Drive("loc", "root"), MainNav.driveFolderGone(b, "loc", "root"))
        assertEquals(a.dropLast(1) + Route.Drive(), MainNav.driveFolderGone(a, "loc", "root"))
        assertEquals(c, MainNav.decode(MainNav.encode(c)))
    }
}
