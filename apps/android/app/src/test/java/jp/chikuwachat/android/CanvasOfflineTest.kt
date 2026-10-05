package jp.chikuwachat.android

import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.CanvasMeta
import jp.chikuwachat.android.api.CanvasOut
import jp.chikuwachat.android.api.ChannelOut
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.MembershipOut
import jp.chikuwachat.android.sync.CANVAS_CACHE_LIMIT
import jp.chikuwachat.android.sync.CANVAS_PENDING_PREFIX
import jp.chikuwachat.android.sync.CachedCanvas
import jp.chikuwachat.android.sync.CanvasHub
import jp.chikuwachat.android.sync.CanvasOffline
import jp.chikuwachat.android.sync.CanvasSaveStatus
import jp.chikuwachat.android.sync.CanvasSaver
import jp.chikuwachat.android.sync.CanvasSaverOptions
import jp.chikuwachat.android.sync.Store
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.time.ZoneId

/**
 * M74 (CANVAS.md §19.2): the canvas copies kept for offline viewing — what is written and when, the cap, what removes
 * them (the trash, the conversation leaving, sign-out), and the saver's choice between the copy and the server.
 */
class CanvasOfflineTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
    private var ids = 0
    private var clock = 1_000L
    private val offline get() = ApiException.Network(IOException("down"))

    private fun options(timers: ManualTimers) = CanvasSaverOptions(newId = { "k${++ids}" }, timers = timers, io = null, now = { clock })

    private fun channelOut(id: String = "ch1") = ChannelOut(id = id, type = "public", name = "lab", archived = false, lastSeq = 0, createdAt = "", updatedAt = "", membership = MembershipOut("member", ""))

    private fun hub(server: FakeCanvasServer, store: Store, timers: ManualTimers = ManualTimers()): CanvasHub {
        store.upsertChannel(channelOut(server.channelId), isMember = true)
        return CanvasHub(server.api, store, scope, options(timers))
    }

    private fun copy(id: String, channelId: String = "ch1", version: Long = 1, body: String = "b", at: Long = 0) = CachedCanvas(
        CanvasOut(id = id, channelId = channelId, title = "t-$id", version = version, headRevId = "r$version", createdBy = "u", updatedBy = "u", createdAt = "", updatedAt = "2026-10-0${(version % 9) + 1}T00:00:00Z", body = body),
        at,
    )

    // --- the store -----------------------------------------------------------------------------

    @Test
    fun aCopyIsKeptAndReadBackAndTheOldestGoBeyondTheCap() {
        val disk = MemoryPersistence()
        val store = Store(disk)
        assertNull(store.cachedCanvas("c1"))
        store.cacheCanvas(copy("c1", body = "本文").canvas, at = 10)
        assertEquals(CachedCanvas(copy("c1", body = "本文").canvas, 10), store.cachedCanvas("c1"))
        // The newest write wins; the copies are bounded by the most recently read or saved.
        store.cacheCanvas(copy("c1", version = 2, body = "本文2").canvas, at = 20)
        assertEquals("本文2", store.cachedCanvas("c1")!!.canvas.body)
        repeat(CANVAS_CACHE_LIMIT) { store.cacheCanvas(copy("x$it").canvas, at = 100L + it) }
        assertEquals(CANVAS_CACHE_LIMIT, disk.canvases.size)
        assertNull(store.cachedCanvas("c1")) // the least recent one went
        store.cacheCanvas(copy("x0").canvas, at = 999) // read again: now the most recent
        store.cacheCanvas(copy("new").canvas, at = 1_000)
        assertNotNull(store.cachedCanvas("x0"))
        assertNull(store.cachedCanvas("x1"))
        store.uncacheCanvas("x0")
        assertNull(store.cachedCanvas("x0"))
    }

    @Test
    fun theConversationLeavingTakesItsCopiesOnly() {
        val disk = MemoryPersistence()
        val store = Store(disk)
        store.upsertChannel(channelOut("ch1"), isMember = true)
        store.cacheCanvas(copy("a", "ch1").canvas)
        store.cacheCanvas(copy("b", "ch2").canvas)
        store.removeChannel("ch1")
        assertNull(store.cachedCanvas("a"))
        assertNotNull(store.cachedCanvas("b"))
        assertEquals(listOf("b"), store.cachedCanvases("ch2").map { it.canvas.id })
    }

    @Test
    fun theCopiesLiveOnlyInTheProfilesDatabaseSoSignOutTakesThem() {
        // Sign-out (SYNC_PROTOCOL.md §11) deletes the profile's database file (RoomPersistence.delete) with the
        // `canvases` table in it; nothing of a copy stays in memory: a store without that database knows none.
        val disk = MemoryPersistence()
        Store(disk).cacheCanvas(copy("c1").canvas)
        assertNotNull(Store(disk).cachedCanvas("c1"))
        assertNull(Store(MemoryPersistence()).cachedCanvas("c1")) // the signed-in-again profile starts empty
        assertNull(Store().cachedCanvas("c1"))
        assertTrue(Store().cachedCanvases("ch1").isEmpty())
    }

    @Test
    fun theNoticeSaysWhenTheCopyWasRead() {
        val zone = ZoneId.of("Asia/Tokyo")
        val at = java.time.ZonedDateTime.of(2026, 10, 2, 14, 5, 0, 0, zone).toInstant().toEpochMilli()
        assertEquals("オフライン — 最後に読み込んだ時点（10/2 14:05）の内容です", CanvasOffline.notice(at, at + 3_600_000, zone))
        assertEquals("2025/10/2 9:07", CanvasOffline.stamp(at - 365L * 86_400_000 - 5 * 3_600_000 + 2 * 60_000, at, zone))
    }

    // --- the saver ----------------------------------------------------------------------------

    @Test
    fun onlineTheCopyShowsFirstAndTheServerIsAskedWithIfNoneMatch() = runBlocking {
        val disk = MemoryPersistence()
        val store = Store(disk)
        val server = FakeCanvasServer("a")
        val hub = hub(server, store)
        val (first, release) = hub.hold("c1", "ch1")
        assertEquals("a", first!!.text)
        assertEquals(listOf<Long?>(null), server.reads) // no copy yet: the plain first read
        assertEquals(CachedCanvas(server.canvas(), 1_000), disk.canvases["c1"]) // …which became the copy
        release()
        hub.stop()

        // The next opening: the copy is on screen before the server answers, then a 304 confirms it.
        clock = 5_000
        val again = hub(server, Store(disk))
        server.gate = CompletableDeferred()
        val (saver, _) = again.hold("c1", "ch1")
        assertEquals(CanvasSaveStatus.SAVED, saver!!.status)
        assertEquals("a", saver.text)
        assertEquals(1_000L, saver.cachedAt)
        assertFalse(saver.unreachable) // still asking: no notice
        server.gate!!.complete(Unit)
        assertEquals(listOf(null, 1L), server.reads)
        assertNull(saver.cachedAt)
        assertEquals(5_000L, disk.canvases["c1"]!!.fetchedAt) // vouched for again
    }

    @Test
    fun aNewerVersionOnTheServerReplacesTheCopy() = runBlocking {
        val disk = MemoryPersistence()
        val server = FakeCanvasServer("a")
        Store(disk).cacheCanvas(server.canvas(), at = 1)
        server.otherSaves("b")
        val (saver, _) = hub(server, Store(disk)).hold("c1", "ch1")
        assertEquals("b", saver!!.text)
        assertEquals(CanvasSaveStatus.SAVED, saver.status)
        assertEquals("b", disk.canvases["c1"]!!.canvas.body)
        assertEquals(2L, disk.canvases["c1"]!!.canvas.version)
    }

    @Test
    fun offlineTheCopyIsShownWithTheNoticeAndEditsGoOutOnItsHeadWhenBackOnline() = runBlocking {
        val disk = MemoryPersistence()
        val server = FakeCanvasServer("a\nb")
        Store(disk).cacheCanvas(server.canvas(), at = 42)
        server.otherSaves("a\nB") // changed elsewhere while this phone was away
        val timers = ManualTimers()
        val store = Store(disk)
        server.failures.add(offline)
        val (saver, _) = hub(server, store, timers).hold("c1", "ch1")
        assertEquals("a\nb", saver!!.text)
        assertEquals(CanvasSaveStatus.OFFLINE, saver.status)
        assertNull(saver.loadError) // the copy, not 再読み込み
        assertEquals(42L, saver.cachedAt)
        assertTrue(saver.unreachable)

        // Typing offline works as before: the save is kept (same key) with the copy's head as its base.
        server.failures.add(offline)
        saver.edit("A\nb")
        timers.advance(2_000)
        assertEquals(CanvasSaveStatus.OFFLINE, saver.status)
        val kept = store.pendingCanvas("c1")!!
        assertEquals("r1", kept.baseRevId)
        assertEquals("k1", kept.inFlight!!.clientSaveId)
        assertTrue(disk.meta.containsKey(CANVAS_PENDING_PREFIX + "c1"))

        // Back online: the same key goes out, the server merges with the newer version, the copy follows.
        saver.online()
        assertEquals(listOf("k1", "k1"), server.saves.map { it.clientSaveId })
        assertEquals("A\nB", server.body)
        assertEquals("A\nB", saver.text)
        assertEquals(CanvasSaveStatus.SAVED, saver.status)
        assertNull(saver.cachedAt)
        assertFalse(saver.unreachable)
        assertEquals("A\nB", disk.canvases["c1"]!!.canvas.body)
        assertNull(store.pendingCanvas("c1"))
    }

    @Test
    fun offlineWithoutACopyStillOffersReadingAgain() = runBlocking {
        val server = FakeCanvasServer("a")
        server.failures.add(offline)
        val (saver, _) = hub(server, Store(MemoryPersistence())).hold("c1", "ch1")
        assertTrue(saver!!.loadError is ApiException.Network)
        assertNull(saver.cachedAt)
        saver.online()
        assertEquals("a", saver.text)
        assertEquals(CanvasSaveStatus.SAVED, saver.status)
    }

    @Test
    fun anUnsavedEditKeptFromBeforeARestartWinsOverTheCopyOffline() = runBlocking {
        val disk = MemoryPersistence()
        val server = FakeCanvasServer("a")
        val timers = ManualTimers()
        val store = Store(disk)
        val (saver, _) = hub(server, store, timers).hold("c1", "ch1")
        server.failures.add(offline)
        saver!!.edit("mine")
        timers.advance(2_000) // on the wire, failed: kept with its key

        // A restart, still offline: the kept edit is on screen and editable, the copy gives the title.
        val second = Store(disk).also { it.load() }
        server.failures.add(offline)
        val (again, _) = hub(server, second, ManualTimers()).hold("c1", "ch1")
        assertEquals("mine", again!!.text)
        assertEquals("議事録", again.canvas!!.title)
        assertNotNull(again.cachedAt)
        assertTrue(again.unsaved)
        again.online()
        assertEquals("mine", server.body)
        assertEquals(setOf("k1"), server.saves.map { it.clientSaveId }.toSet())
        assertEquals(CanvasSaveStatus.SAVED, again.status)
    }

    @Test
    fun aCanvasInTheTrashOrOutOfReachLosesItsCopy() = runBlocking {
        val disk = MemoryPersistence()
        val server = FakeCanvasServer("a")
        Store(disk).cacheCanvas(server.canvas())
        server.failures.add(ApiException.Api(404, "canvas_not_found", "Not found"))
        val (gone, _) = hub(server, Store(disk)).hold("c1", "ch1")
        assertEquals(CanvasSaveStatus.GONE, gone!!.status)
        assertNull(disk.canvases["c1"])

        Store(disk).cacheCanvas(server.canvas())
        server.failures.add(ApiException.Api(403, "forbidden", "Forbidden"))
        val (refused, _) = hub(server, Store(disk)).hold("c1", "ch1")
        assertEquals(403, (refused!!.loadError as ApiException.Api).status) // the copy is not shown any more
        assertNull(refused.cachedAt)
        assertNull(disk.canvases["c1"])
        refused.load() // 再読み込み starts over
        assertEquals("a", refused.text)
        assertEquals(CanvasSaveStatus.SAVED, refused.status)
    }

    @Test
    fun theTrashEventTakesTheCopy() = runBlocking {
        val disk = MemoryPersistence()
        val server = FakeCanvasServer("a")
        val hub = hub(server, Store(disk))
        hub.hold("c1", "ch1")
        assertNotNull(disk.canvases["c1"])
        hub.applyEvent("canvas.deleted", buildJsonObject { put("canvas_id", "c1"); put("channel_id", "ch1") })
        assertNull(disk.canvases["c1"])
    }

    @Test
    fun newerMetadataNeverRewritesTheCopyOverItsOlderBody() = runBlocking {
        val disk = MemoryPersistence()
        val server = FakeCanvasServer("a")
        val timers = ManualTimers()
        val hub = hub(server, Store(disk), timers)
        val (saver, _) = hub.hold("c1", "ch1")
        server.otherSaves("b")
        // canvas.updated arrives, its read fails: the screen has the new metadata, the copy keeps "a" with r1.
        server.failures.add(offline)
        hub.applyEvent("canvas.updated", buildJsonObject { put("canvas", Codec.snake.encodeToJsonElement(CanvasMeta.serializer(), server.canvas().meta)) })
        timers.advance(500)
        assertEquals(2L, saver!!.canvas!!.version)
        val kept = disk.canvases["c1"]!!.canvas
        assertEquals("a" to "r1", kept.body to kept.headRevId)
    }

    @Test
    fun offlineTheCopiesStandInForTheListUntilItLoads() = runBlocking {
        val disk = MemoryPersistence()
        val server = FakeCanvasServer("a")
        val store = Store(disk)
        store.cacheCanvas(copy("c1", version = 1).canvas)
        store.cacheCanvas(copy("c9", channelId = "other").canvas)
        val hub = hub(server, store)
        server.failures.add(offline)
        hub.loadList("ch1")
        assertEquals(listOf("c1"), store.canvasesOf("ch1")!!.map { it.id })
        assertNotNull(store.canvasListError("ch1"))
        // Back online: the server's list replaces it.
        hub.loadList("ch1")
        assertNull(store.canvasListError("ch1"))
        assertEquals(listOf(server.canvas().meta), store.canvasesOf("ch1"))
        // A refusal (not offline) shows no copies.
        val fresh = Store(disk)
        val other = hub(server, fresh)
        server.failures.add(ApiException.Api(404, "not_found", "Not Found"))
        other.loadList("ch1")
        assertNull(fresh.canvasesOf("ch1"))
    }

    @Test
    fun withoutACacheSourceTheSaverBehavesAsBefore() {
        val server = FakeCanvasServer("a")
        val saver = CanvasSaver(server.canvasId, server.channelId, server.api, scope, options(ManualTimers())).also { it.load() }
        assertEquals(CanvasSaveStatus.SAVED, saver.status)
        assertNull(saver.cachedAt)
    }
}
