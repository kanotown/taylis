package jp.chikuwachat.android

import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.CanvasMeta
import jp.chikuwachat.android.api.CanvasOut
import jp.chikuwachat.android.api.CanvasPage
import jp.chikuwachat.android.api.ChannelOut
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.MembershipOut
import jp.chikuwachat.android.api.UserPublic
import jp.chikuwachat.android.sync.CachedCanvas
import jp.chikuwachat.android.sync.MyCanvasList
import jp.chikuwachat.android.sync.MyCanvasesApi
import jp.chikuwachat.android.sync.Store
import jp.chikuwachat.android.ui.ConversationTab
import jp.chikuwachat.android.ui.HomeTile
import jp.chikuwachat.android.ui.HomeTiles
import jp.chikuwachat.android.ui.MainNav
import jp.chikuwachat.android.ui.MyCanvasOpen
import jp.chikuwachat.android.ui.MyCanvases
import jp.chikuwachat.android.ui.Route
import jp.chikuwachat.android.api.ThreadSummary
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.time.ZoneId
import java.time.ZonedDateTime

/**
 * M78 (CANVAS.md §21.2): the home's 「キャンバス」 — GET /canvases a page of 50 at a time, the title filter, the device's
 * copies while offline, the rows' text, and where a tapped row goes on the home stack.
 */
class MyCanvasesTest {
    private val now: ZonedDateTime = ZonedDateTime.of(2026, 10, 2, 15, 0, 0, 0, ZoneId.of("Asia/Tokyo"))

    private fun meta(id: String, channelId: String = "c1", title: String = "t-$id", version: Long = 1, updatedAt: String = "2026-10-02T05:00:00Z", updatedBy: String = "u1") =
        CanvasMeta(id = id, channelId = channelId, title = title, version = version, headRevId = "r$version", createdBy = "u1", updatedBy = updatedBy, createdAt = "", updatedAt = updatedAt)

    private fun channelOut(id: String, name: String = "lab") =
        ChannelOut(id = id, type = "public", name = name, archived = false, lastSeq = 0, createdAt = "", updatedAt = "", membership = MembershipOut("member", ""))

    private fun store(): Store = Store().apply {
        upsertChannel(channelOut("c1", "lab"), isMember = true)
        upsertChannel(channelOut("c2", "random"), isMember = true)
        upsertUser(UserPublic(id = "u1", username = "yamada", displayName = "山田", role = "member", createdAt = "", updatedAt = ""))
    }

    /** GET /canvases as the server pages it: [pages] in order, by cursor; `fail` makes the next call throw. */
    private class FakeApi(val pages: Map<String?, CanvasPage>) : MyCanvasesApi {
        val calls = mutableListOf<Pair<String?, Int>>()
        var fail: Exception? = null
        var gate: CompletableDeferred<Unit>? = null
        override suspend fun myCanvases(cursor: String?, limit: Int): CanvasPage {
            calls += cursor to limit
            gate?.await()
            fail?.let { throw it }
            return pages[cursor] ?: CanvasPage(emptyList(), null)
        }
    }

    private val offline get() = ApiException.Network(IOException("down"))
    private val forbidden get() = ApiException.Api(403, "forbidden", "no", JsonNull)

    private fun page(range: IntRange, next: String?) = CanvasPage(range.map { meta("cv$it", updatedAt = "2026-10-01T%02d:00:00Z".format(23 - it % 24)) }, next)

    // --- the API ------------------------------------------------------------------------------

    @Test
    fun thePageDecodesFromTheServersShape() {
        val page = Codec.snake.decodeFromString(
            CanvasPage.serializer(),
            """{"items":[{"id":"cv1","channel_id":"c1","title":"議事録","version":3,"head_rev_id":"r3","is_channel_tab":true,"edit_policy":"members",
            "task_total":5,"task_done":3,"created_by":"u1","updated_by":"u2","created_at":"2026-10-01T00:00:00Z","updated_at":"2026-10-02T05:00:00Z"}],"next_cursor":"abc"}""",
        )
        assertEquals("abc", page.nextCursor)
        assertEquals("議事録", page.items.single().title)
        assertEquals("u2", page.items.single().updatedBy)
        assertTrue(page.items.single().isChannelTab)
    }

    // --- paging -------------------------------------------------------------------------------

    @Test
    fun pagesOfFiftyAreReadOneAfterAnotherWithoutDuplicates() = runBlocking {
        val api = FakeApi(mapOf(null to page(0 until 50, "p2"), "p2" to CanvasPage(page(49 until 60, null).items, null)))
        val list = MyCanvasList({ api }, cached = { emptyList() })
        assertNull(list.state.value.items) // loading
        list.refresh()
        assertEquals(listOf<Pair<String?, Int>>(null to 50), api.calls)
        assertEquals(50, list.state.value.items!!.size)
        assertTrue(list.state.value.canLoadMore)
        list.loadMore()
        assertEquals("p2" to 50, api.calls.last())
        assertEquals(60, list.state.value.items!!.size) // cv49 came twice, shown once
        assertNull(list.state.value.nextCursor)
        assertFalse(list.state.value.canLoadMore)
        list.loadMore() // nothing more to ask for
        assertEquals(2, api.calls.size)
    }

    @Test
    fun aRefreshStartsAgainAndAPageFromBeforeItIsDropped() = runBlocking {
        val api = FakeApi(mapOf(null to page(0 until 50, "p2"), "p2" to page(50 until 60, null)))
        val list = MyCanvasList({ api }, cached = { emptyList() })
        list.refresh()
        val gate = CompletableDeferred<Unit>()
        api.gate = gate
        val more = async(start = CoroutineStart.UNDISPATCHED) { list.loadMore() }
        assertTrue(list.state.value.loadingMore)
        assertFalse(list.state.value.canLoadMore) // one page at a time
        api.gate = null
        list.refresh() // pull to refresh while the second page is on its way
        gate.complete(Unit)
        more.await()
        assertEquals(50, list.state.value.items!!.size) // the old second page is not added to the new first one
        assertEquals("p2", list.state.value.nextCursor)
    }

    @Test
    fun aFailedPageKeepsTheRowsAndCanBeRetried() = runBlocking {
        val api = FakeApi(mapOf(null to page(0 until 50, "p2"), "p2" to page(50 until 55, null)))
        val list = MyCanvasList({ api }, cached = { emptyList() })
        list.refresh()
        api.fail = offline
        list.loadMore()
        assertEquals(50, list.state.value.items!!.size)
        assertTrue(list.state.value.failure is ApiException.Network)
        assertEquals("p2", list.state.value.nextCursor)
        assertFalse(list.state.value.offline) // only a first page that cannot be read shows the device's copies
        api.fail = null
        list.loadMore()
        assertEquals(55, list.state.value.items!!.size)
        assertNull(list.state.value.failure)
    }

    @Test
    fun signedOutNothingIsAsked() = runBlocking {
        val list = MyCanvasList({ null }, cached = { error("not read") })
        list.refresh()
        assertNull(list.state.value.items)
    }

    @Test
    fun theTileStartsTheListOver() = runBlocking {
        val api = FakeApi(mapOf(null to page(0 until 3, null)))
        val list = MyCanvasList({ api }, cached = { emptyList() })
        list.refresh()
        list.clear()
        assertNull(list.state.value.items)
    }

    // --- offline ------------------------------------------------------------------------------

    @Test
    fun offlineTheDevicesCopiesStandInNewestFirst() = runBlocking {
        val api = FakeApi(emptyMap()).apply { fail = offline }
        val copies = listOf(meta("old", updatedAt = "2026-09-01T00:00:00Z"), meta("new", updatedAt = "2026-10-01T00:00:00Z"))
        val list = MyCanvasList({ api }, cached = { copies })
        list.refresh()
        val state = list.state.value
        assertTrue(state.offline)
        assertEquals(listOf("new", "old"), state.items!!.map { it.id })
        assertFalse(state.canLoadMore)
        // Back online: the server's list replaces them and the mark goes.
        api.fail = null
        list.refresh()
        assertFalse(list.state.value.offline)
        assertEquals(emptyList<CanvasMeta>(), list.state.value.items) // the server has none: the copies go
    }

    @Test
    fun offlineAfterAPageTheServersPagesStay() = runBlocking {
        val api = FakeApi(mapOf(null to page(0 until 50, "p2")))
        var read = false
        val list = MyCanvasList({ api }, cached = { read = true; listOf(meta("copy")) })
        list.refresh()
        api.fail = offline
        list.refresh()
        assertTrue(list.state.value.offline)
        assertEquals(50, list.state.value.items!!.size)
        assertFalse(read)
        assertFalse(list.state.value.canLoadMore)
    }

    @Test
    fun anErrorThatIsNotTheNetworkShowsNoCopies() = runBlocking {
        val api = FakeApi(emptyMap()).apply { fail = forbidden }
        val list = MyCanvasList({ api }, cached = { listOf(meta("copy")) })
        list.refresh()
        assertFalse(list.state.value.offline)
        assertEquals(emptyList<CanvasMeta>(), list.state.value.items)
        assertTrue(list.state.value.failure is ApiException.Api)
    }

    @Test
    fun theStoreKeepsEveryCopyForTheOfflineList() {
        val persistence = MemoryPersistence()
        val store = Store(persistence)
        fun out(id: String, channelId: String) = CanvasOut(id = id, channelId = channelId, title = id, version = 1, headRevId = "r1", createdBy = "u", updatedBy = "u", createdAt = "", updatedAt = "")
        persistence.saveCanvas(CachedCanvas(out("a", "c1"), 1), 200)
        persistence.saveCanvas(CachedCanvas(out("b", "c2"), 2), 200)
        assertEquals(setOf("a", "b"), store.allCachedCanvases().map { it.canvas.id }.toSet())
        assertEquals(emptyList<CachedCanvas>(), Store().allCachedCanvases()) // no database: none
    }

    // --- the rows -----------------------------------------------------------------------------

    @Test
    fun theTitleFilterFoldsWidthAndCase() {
        val store = store()
        val items = listOf(meta("a", title = "Weekly ミーティング"), meta("b", title = "研究計画"), meta("c", title = "ＷＥＥＫＬＹ report"))
        assertEquals(listOf("c", "b", "a"), MyCanvases.rows(items, store, "", now).map { it.canvas.id }) // same time: by id, as the server
        assertEquals(setOf("a", "c"), MyCanvases.rows(items, store, " weekly ", now).map { it.canvas.id }.toSet())
        assertEquals(listOf("b"), MyCanvases.rows(items, store, "計画", now).map { it.canvas.id })
        assertEquals(emptyList<String>(), MyCanvases.rows(items, store, "無い", now).map { it.canvas.id })
    }

    @Test
    fun whatTheDeviceKnowsNewerWinsAndTrashedOrLeftOnesGo() {
        val store = store()
        store.upsertChannel(channelOut("c3", "left"), isMember = false)
        // c1's list is loaded (its conversation was opened): cv1 is newer there, cv2 went to the trash.
        store.setCanvases("c1", listOf(meta("cv1", title = "新しい題名", version = 4, updatedAt = "2026-10-02T06:00:00Z")))
        val items = listOf(meta("cv1", version = 2), meta("cv2"), meta("cv3", channelId = "c2", updatedAt = "2026-10-02T05:30:00Z"), meta("cv4", channelId = "c3"), meta("cv5", channelId = "unknown", updatedAt = "2026-09-01T00:00:00Z"))
        val rows = MyCanvases.rows(items, store, "", now)
        assertEquals(listOf("cv1", "cv3", "cv5"), rows.map { it.canvas.id })
        assertEquals("新しい題名", rows[0].canvas.title)
        assertEquals("会話", rows[2].where) // not on this device yet
    }

    @Test
    fun aRowSaysWhereWhoAndWhen() {
        val store = store()
        val canvas = meta("cv1", title = "議事録", updatedAt = "2026-10-02T05:05:00Z").copy(isChannelTab = true, taskTotal = 5, taskDone = 3)
        val row = MyCanvases.rows(listOf(canvas), store, "", now).single()
        assertEquals("#lab", row.where)
        assertEquals("山田", row.editor)
        assertEquals("14:05", row.updated)
        assertEquals("3/5", row.progress)
        assertEquals("#lab · 山田 · 14:05", MyCanvases.subtitle(row))
        assertEquals("キャンバス「議事録」、#lab、タブ、最後に編集 山田、14:05、タスク 3/5", MyCanvases.spoken(row))
        val unknown = MyCanvases.rows(listOf(meta("cv2", title = "", updatedBy = "someone", updatedAt = "2026-10-01T05:05:00Z")), store, "", now).single()
        assertEquals("メンバー", unknown.editor)
        assertEquals("昨日 14:05", unknown.updated)
        assertEquals("無題のキャンバス", MyCanvases.title(unknown.canvas))
        assertEquals("キャンバス「無題のキャンバス」、#lab、最後に編集 メンバー、昨日 14:05", MyCanvases.spoken(unknown))
    }

    @Test
    fun theEmptyListSaysWhy() {
        assertEquals("まだキャンバスはありません", MyCanvases.empty("", offline = false).first)
        assertEquals("題名に一致するキャンバスはありません", MyCanvases.empty("x", offline = false).first)
        assertEquals("題名に一致するキャンバスはありません", MyCanvases.empty("x", offline = true).first)
        assertEquals("この端末にあるキャンバスはありません", MyCanvases.empty("", offline = true).first)
    }

    // --- the tile and where a row goes ----------------------------------------------------------

    @Test
    fun theTileComesAfterFiles() {
        val tiles = HomeTiles.tiles(ThreadSummary(), drafts = 0, saved = 0, firedReminders = 0)
        // M122: 「ドキュメント」 follows キャンバス (WIKI.md §9.2).
        assertEquals(HomeTile.FILES, tiles[tiles.size - 3].tile)
        val canvases = tiles[tiles.size - 2]
        assertEquals(HomeTile.CANVASES, canvases.tile)
        assertNull(canvases.count)
        assertEquals("キャンバス", HomeTiles.description(canvases))
        assertEquals(HomeTile.DOCS, tiles.last().tile)
        assertEquals("ドキュメント", HomeTiles.description(tiles.last()))
    }

    @Test
    fun aRowOpensItsCanvasOverTheListAndBackReturnsToIt() {
        val store = store()
        val list = MainNav.open(MainNav.root, Route.Canvases)
        assertEquals(listOf(Route.ChannelList, Route.Canvases), list)
        val target = MyCanvases.open(list, store, meta("cv1", channelId = "c2"))
        val opened = (target as MyCanvasOpen.Push).stack
        assertEquals(list + Route.Channel("c2", tab = ConversationTab.CANVAS, canvasId = "cv1"), opened)
        // Back: the conversation's 「メッセージ」 tab (as every canvas tab), then the list as it was.
        val messages = MainNav.back(opened)
        assertEquals(list + Route.Channel("c2", canvasId = "cv1"), messages)
        assertEquals(list, MainNav.back(messages))
        // Another canvas from the list replaces the conversation, the list stays under it.
        assertEquals(list + Route.Channel("c1", tab = ConversationTab.CANVAS, canvasId = "cv9"), (MyCanvases.open(MainNav.back(messages), store, meta("cv9")) as MyCanvasOpen.Push).stack)
        // Saved and restored (a rotation, the workspace's state).
        assertEquals(opened, MainNav.decode(MainNav.encode(opened)))
    }

    @Test
    fun aConversationNotOnTheDeviceGoesTheLinksWay() {
        val store = store()
        store.upsertChannel(channelOut("c3", "left"), isMember = false)
        val list = MainNav.open(MainNav.root, Route.Canvases)
        assertEquals(MyCanvasOpen.Link("cv1"), MyCanvases.open(list, store, meta("cv1", channelId = "elsewhere")))
        assertEquals(MyCanvasOpen.Link("cv2"), MyCanvases.open(list, store, meta("cv2", channelId = "c3")))
    }

    @Test
    fun theSearchForBodiesGoesOverTheListAndBackReturnsToIt() {
        val list = MainNav.open(MainNav.root, Route.Canvases)
        val searching = MainNav.openSearch(list)
        assertEquals(list, MainNav.back(searching))
    }
}
