package jp.chikuwachat.android

import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.PageRef
import jp.chikuwachat.android.api.WikiBootstrap
import jp.chikuwachat.android.api.WikiChangesOut
import jp.chikuwachat.android.api.WikiTreeOut
import jp.chikuwachat.android.sync.CanvasSaveStatus
import jp.chikuwachat.android.sync.CanvasSaverOptions
import jp.chikuwachat.android.sync.PageLabel
import jp.chikuwachat.android.sync.Store
import jp.chikuwachat.android.sync.WIKI_PENDING_PREFIX
import jp.chikuwachat.android.sync.WIKI_TREE_KEY
import jp.chikuwachat.android.sync.WikiHub
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * M122 (SYNC_PROTOCOL.md §17, docs/WIKI.md §10): the tree from bootstrap's `wiki.change_seq`, GET /wiki/tree (ETag) and
 * GET /wiki/changes on wiki.changed (removed, reset), kept in Room for offline reading; the titles of linked pages; and a
 * page's save loop on the /wiki endpoints (the canvas's: autosave, the conflict choices, If-None-Match, kept edits).
 */
class WikiSyncTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
    private var ids = 0

    private fun hub(api: FakeWikiApi, store: Store, timers: ManualTimers = ManualTimers()) =
        WikiHub(api, store, scope, CanvasSaverOptions(newId = { "k${++ids}" }, timers = timers, now = { 1_000L }), changesDelayMs = 0)

    private fun serverWith(vararg pages: jp.chikuwachat.android.api.PageItem, cursor: Long = 5) =
        FakeWikiApi().apply { tree = WikiTreeOut(pages.toList(), cursor) }

    @Test
    fun noWikiInBootstrapMeansTheServerHasNone() {
        val api = serverWith(page("a"))
        val hub = hub(api, Store(MemoryPersistence()))
        hub.applyBootstrap(null)
        assertFalse(hub.available)
        assertTrue(api.calls.isEmpty())
    }

    @Test
    fun theTreeIsReadOnceThenTheFeedCatchesUpAndBothAreKept() {
        val disk = MemoryPersistence()
        val api = serverWith(page("a"), page("b", parent = "a"), cursor = 5)
        val hub = hub(api, Store(disk))
        hub.applyBootstrap(WikiBootstrap(5))
        assertEquals(listOf("tree -"), api.calls)
        assertEquals(setOf("a", "b"), hub.pages.keys)
        assertEquals(5L, hub.cursor)
        assertNotNull(disk.meta[WIKI_TREE_KEY])

        // wiki.changed: only what changed after the cursor is read; seqs already known are ignored.
        hub.changed(5)
        assertEquals(1, api.calls.size)
        api.changes[5] = WikiChangesOut(pages = listOf(page("c", parent = "a")), removed = listOf("b"), cursor = 8)
        hub.changed(8)
        assertEquals("changes 5", api.calls.last())
        assertEquals(setOf("a", "c"), hub.pages.keys)
        assertEquals(8L, hub.cursor)

        // A new bootstrap with nothing new reads nothing; one further on reads the feed.
        hub.applyBootstrap(WikiBootstrap(8))
        assertEquals("changes 5", api.calls.last())
        hub.applyBootstrap(WikiBootstrap(9))
        assertEquals("changes 8", api.calls.last())

        // Restarted (offline): the kept tree shows before the server answers, and the next read sends its ETag.
        val again = Store(disk).also { it.load() }
        val restarted = hub(api, again)
        restarted.restore()
        assertEquals(setOf("a", "c"), restarted.pages.keys)
        assertTrue(restarted.hasTree)
        restarted.reloadTree()
        assertEquals("tree \"t1\"", api.calls.last()) // 304: the kept tree stays
        assertEquals(setOf("a", "c"), restarted.pages.keys)
    }

    @Test
    fun aResetReadsTheWholeTreeAgain() {
        val api = serverWith(page("a"), cursor = 5)
        val hub = hub(api, Store(MemoryPersistence()))
        hub.applyBootstrap(WikiBootstrap(5))
        api.changes[5] = WikiChangesOut(reset = true, cursor = 50)
        api.tree = WikiTreeOut(listOf(page("z")), 50)
        api.treeEtag = "\"t2\""
        hub.changed(50)
        assertEquals(listOf("tree -", "changes 5", "tree \"t1\""), api.calls)
        assertEquals(setOf("z"), hub.pages.keys)
        assertEquals(50L, hub.cursor)
        // A feed position before mine (another database): the tree again.
        hub.applyBootstrap(WikiBootstrap(3))
        assertEquals("tree \"t2\"", api.calls.last())
    }

    @Test
    fun aFailedReadKeepsTheTreeAndSaysSo() {
        val api = serverWith(page("a"), cursor = 5)
        val hub = hub(api, Store(MemoryPersistence()))
        hub.applyBootstrap(WikiBootstrap(5))
        api.failures.add(ApiException.Network(java.io.IOException("offline")))
        hub.changed(6)
        assertNotNull(hub.loadError)
        assertEquals(setOf("a"), hub.pages.keys)
        // The next bootstrap tries again.
        hub.applyBootstrap(WikiBootstrap(5))
        assertNull(hub.loadError)
    }

    @Test
    fun linkedPagesOutsideTheTreeAreAskedAboutOnce() {
        val api = serverWith(page("a", title = "マニュアル"), cursor = 1)
        api.refs["x"] = PageRef("x", "外の題名", "📘")
        val hub = hub(api, Store(MemoryPersistence()))
        hub.applyBootstrap(WikiBootstrap(1))
        assertEquals(PageLabel.Known("マニュアル", null), hub.label("a"))
        assertEquals(PageLabel.Unknown, hub.label("x"))
        hub.resolve(listOf("a", "x", "hidden"))
        assertEquals("resolve x,hidden", api.calls.last())
        assertEquals(PageLabel.Known("外の題名", "📘"), hub.label("x"))
        assertEquals(PageLabel.Hidden, hub.label("hidden"))
        hub.resolve(listOf("x", "hidden"))
        assertEquals("resolve x,hidden", api.calls.last()) // not again
    }

    // --- a page's save loop -----------------------------------------------------------------------------

    @Test
    fun aPageSavesTwoSecondsAfterTypingOnTheWikiEndpointsAndReadsAgainWithItsEtag() {
        val api = serverWith(page("p1", level = "edit"), cursor = 1).apply { body = "# 手順\n" }
        val timers = ManualTimers()
        val hub = hub(api, Store(MemoryPersistence()), timers)
        hub.applyBootstrap(WikiBootstrap(1))
        val (saver, source, release) = hub.hold("p1")
        saver!!
        assertEquals("page p1 -", api.calls.last())
        assertEquals(CanvasSaveStatus.SAVED, saver.status)
        assertEquals("# 手順\n", saver.text)
        assertEquals("edit", source!!.page.value!!.myLevel)

        saver.edit("# 手順\n1. 予約する")
        timers.advance(2_000)
        assertEquals(listOf(listOf("r1", "# 手順\n1. 予約する", "k1", "fail")), api.saves)
        assertEquals(CanvasSaveStatus.SAVED, saver.status)
        // The save's answer has no breadcrumbs: the ones read before stay.
        assertEquals(api.crumbs, source.page.value!!.breadcrumbs)

        // wiki.page.updated from another device: read again, If-None-Match "v<version>-<level>".
        hub.pageUpdated(page("p1", version = 5))
        timers.advance(500)
        assertEquals("page p1 \"v2-edit\"", api.calls.last())
        release()
    }

    @Test
    fun aConflictOnAPageOffersTheCanvasChoices() {
        val api = serverWith(page("p1"), cursor = 1).apply { body = "a" }
        val timers = ManualTimers()
        val hub = hub(api, Store(MemoryPersistence()), timers)
        hub.applyBootstrap(WikiBootstrap(1))
        val saver = hub.hold("p1").first!!
        api.conflictNext = true
        saver.edit("b")
        saver.flush()
        assertEquals(CanvasSaveStatus.CONFLICT, saver.status)
        assertEquals("b", saver.conflict!!.details.conflicts.single().ours)
        saver.resolveConflict("ours")
        assertEquals(listOf("r1", "b", "k2", "ours"), api.saves.last())
        assertEquals(CanvasSaveStatus.SAVED, saver.status)
    }

    @Test
    fun aViewOnlySaveIsRefused() {
        val api = serverWith(page("p1", level = "view"), cursor = 1).apply { body = "a"; level = "view" }
        val hub = hub(api, Store(MemoryPersistence()))
        hub.applyBootstrap(WikiBootstrap(1))
        val saver = hub.hold("p1").first!!
        saver.edit("b")
        saver.flush()
        assertEquals(CanvasSaveStatus.BLOCKED, saver.status)
        assertEquals("page_edit_restricted", (saver.error as ApiException.Api).code)
    }

    @Test
    fun aPageThatLeavesTheTreeStopsSaving() {
        val api = serverWith(page("p1"), cursor = 1).apply { body = "a" }
        val timers = ManualTimers()
        val hub = hub(api, Store(MemoryPersistence()), timers)
        hub.applyBootstrap(WikiBootstrap(1))
        val saver = hub.hold("p1").first!!
        // In the trash (the feed says removed): the open page reads again, 404, and stops.
        api.pageId = "other"
        api.changes[1] = WikiChangesOut(removed = listOf("p1"), cursor = 2)
        hub.changed(2)
        timers.advance(500)
        assertEquals(CanvasSaveStatus.GONE, saver.status)
        assertFalse(hub.pages.containsKey("p1"))
    }

    @Test
    fun editsKeptOverARestartGoOutWithTheSameKey() {
        val disk = MemoryPersistence()
        val api = serverWith(page("p1"), cursor = 1).apply { body = "a" }
        val store = Store(disk)
        val hub = hub(api, store)
        hub.applyBootstrap(WikiBootstrap(1))
        val saver = hub.hold("p1").first!!
        api.failures.add(ApiException.Network(java.io.IOException("offline")))
        saver.edit("a\nb")
        saver.flush()
        assertEquals(CanvasSaveStatus.OFFLINE, saver.status)
        assertTrue(disk.meta.keys.any { it == WIKI_PENDING_PREFIX + "p1" })

        // The process ends; the next start sends the kept save with the same key once connected.
        val restartedStore = Store(disk).also { it.load() }
        val restarted = hub(api, restartedStore)
        restarted.restore()
        restarted.applyBootstrap(WikiBootstrap(1))
        restarted.online()
        val sent = api.saves.filter { it[1] == "a\nb" }
        assertEquals(2, sent.size)
        assertEquals(sent[0][2], sent[1][2]) // the same client_save_id: never a second version
        assertNull(restartedStore.pendingPage("p1"))
    }

    @Test
    fun aPageReadHereOpensOfflineFromItsCopy() {
        val disk = MemoryPersistence()
        val api = serverWith(page("p1"), cursor = 1).apply { body = "オフラインでも読める" }
        val hub = hub(api, Store(disk))
        hub.applyBootstrap(WikiBootstrap(1))
        val (_, _, release) = hub.hold("p1")
        release()
        assertTrue(disk.wikiPages.containsKey("p1"))
        // Later, offline: the copy shows (marked so), its breadcrumbs too.
        val offline = hub(api, Store(disk))
        api.failures.add(ApiException.Network(java.io.IOException("offline")))
        val (saver, source, _) = offline.hold("p1")
        assertEquals("オフラインでも読める", saver!!.text)
        assertNotNull(saver.cachedAt)
        assertTrue(saver.unreachable)
        assertEquals(api.crumbs, source!!.page.value!!.breadcrumbs)
        // Only 20 pages are kept.
        assertTrue(jp.chikuwachat.android.sync.WIKI_PAGE_CACHE_LIMIT == 20)
    }

    @Test
    fun aNewPageJoinsTheTreeAtOnce() {
        val api = serverWith(page("a"), cursor = 1)
        val hub = hub(api, Store(MemoryPersistence()))
        hub.applyBootstrap(WikiBootstrap(1))
        hub.noteItem(page("new", parent = "a", level = "full"))
        assertEquals(listOf("new"), jp.chikuwachat.android.sync.WikiTree.children(hub.pages, "a").map { it.id })
    }
}
