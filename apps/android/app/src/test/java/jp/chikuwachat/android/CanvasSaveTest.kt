package jp.chikuwachat.android

import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.CanvasMeta
import jp.chikuwachat.android.api.ChannelOut
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.MembershipOut
import jp.chikuwachat.android.sync.CANVAS_PENDING_PREFIX
import jp.chikuwachat.android.sync.CanvasHub
import jp.chikuwachat.android.sync.CanvasSaveStatus
import jp.chikuwachat.android.sync.CanvasSaver
import jp.chikuwachat.android.sync.CanvasSaverOptions
import jp.chikuwachat.android.sync.ChannelState
import jp.chikuwachat.android.sync.Store
import jp.chikuwachat.android.ui.CanvasRights
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * M46: the canvas save loop (CANVAS.md §4.4 「クライアント側の規則」), the scenarios of the desktop's canvasSave.test.ts:
 * the 2 s pause, a retry with the same key, taking the merged body (and not while typing or composing), conflicts and
 * their choices, an expired base, offline and back, and a restart that sends the kept save with the same key.
 */
class CanvasSaveTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
    private var ids = 0

    private fun saver(server: FakeCanvasServer, timers: ManualTimers, store: Store? = null): CanvasSaver {
        val options = CanvasSaverOptions(newId = { "k${++ids}" }, timers = timers)
        return CanvasSaver(server.canvasId, server.channelId, server.api, scope, options, store?.pendingCanvas(server.canvasId)) { state ->
            store?.setPendingCanvas(server.canvasId, state)
        }.also { it.load() }
    }

    @Test
    fun aSaveGoesOutTwoSecondsAfterTypingStopsWithTheWholeBodyAndItsBase() {
        val server = FakeCanvasServer("# 議事録\n")
        val timers = ManualTimers()
        val saver = saver(server, timers)
        assertEquals(CanvasSaveStatus.SAVED, saver.status)
        assertEquals("# 議事録\n", saver.text)

        saver.edit("# 議事録\nA")
        assertEquals(CanvasSaveStatus.EDITING, saver.status)
        timers.advance(1_500)
        saver.edit("# 議事録\nAB") // typing on: the pause starts again
        timers.advance(1_999)
        assertTrue(server.saves.isEmpty())
        timers.advance(1)
        assertEquals(listOf(FakeCanvasServer.Save("r1", "# 議事録\nAB", "k1", "fail")), server.saves)
        assertEquals(CanvasSaveStatus.SAVED, saver.status)
        assertFalse(saver.unsaved)

        // The next save is written on the version that one made.
        saver.edit("# 議事録\nABC")
        saver.flush()
        assertEquals("r2", server.saves[1].baseRevId)
        assertEquals(3L, server.version)
    }

    @Test
    fun aMergeBringsTheOtherEditsWhenNothingWasTypedMeanwhileAndKeepsTheBase() {
        val server = FakeCanvasServer("a\nb\nc")
        val timers = ManualTimers()
        val saver = saver(server, timers)
        server.otherSaves("a\nb\nC") // android2 edits another line
        val before = saver.textRevision
        saver.edit("A\nb\nc")
        saver.flush()
        assertEquals("A\nb\nC", saver.text) // both edits
        assertEquals("A\nb\nC", server.body)
        assertTrue(saver.textRevision > before) // the editor takes it
        assertEquals(CanvasSaveStatus.SAVED, saver.status)
        // Written on the head now: the next direct save is no merge.
        val head = server.head
        saver.edit("A\nB\nC")
        saver.flush()
        assertEquals(head, server.saves.last().baseRevId)
        assertEquals("A\nB\nC", server.body)
    }

    @Test
    fun typingWhileASaveIsOnTheWireKeepsTheTextAndBasesTheNextSaveOnTheSentVersion() {
        val server = FakeCanvasServer("a\nb\nc")
        val timers = ManualTimers()
        val saver = saver(server, timers)
        server.otherSaves("a\nb\nC")
        val gate = CompletableDeferred<Unit>()
        server.gate = gate
        saver.edit("A\nb\nc")
        saver.flush()
        assertEquals(CanvasSaveStatus.SAVING, saver.status)
        saver.edit("A\nbb\nc") // typed while it is on the wire
        server.gate = null
        gate.complete(Unit)
        // Not replaced (typed on); the merge waits for the next save.
        assertEquals("A\nbb\nc", saver.text)
        assertEquals(CanvasSaveStatus.EDITING, saver.status)
        val side = server.saves.size
        timers.advance(2_000)
        // The next save is written on the side version (what was sent), and the server merges again.
        val second = server.saves[side]
        assertEquals("A\nbb\nc", second.body)
        assertNotEquals("r1", second.baseRevId)
        assertEquals("A\nbb\nC", server.body)
        assertEquals("A\nbb\nC", saver.text)
    }

    @Test
    fun anImeCompositionIsNeverReplacedTheMergeComesAfterIt() {
        val server = FakeCanvasServer("a\nb")
        val timers = ManualTimers()
        val saver = saver(server, timers)
        var composing = true
        saver.canReplace = { !composing }
        server.otherSaves("a\nB")
        saver.edit("あ\nb")
        saver.flush()
        assertEquals("あ\nb", saver.text) // composing: kept
        assertEquals("あ\nB", server.body)
        composing = false
        saver.flush() // nothing typed: reads the canvas again, now that the composition is over
        assertEquals("あ\nB", saver.text)
        assertEquals(CanvasSaveStatus.SAVED, saver.status)
    }

    @Test
    fun anEventDuringACompositionIsShownWhenTheCompositionEndsEvenWithoutAKeystroke() {
        val server = FakeCanvasServer("a\nb")
        val timers = ManualTimers()
        val saver = saver(server, timers)
        var composing = true
        saver.canReplace = { !composing }
        saver.edit("a\nb\nけんきゅう")
        timers.advance(2_000) // saved while still composing
        assertEquals("a\nb\nけんきゅう", server.body)
        server.otherSaves("A\nb\nけんきゅう")
        saver.remoteVersion(server.version)
        timers.advance(500)
        assertEquals("a\nb\nけんきゅう", saver.text) // the composition is left alone
        saver.replaceable() // still composing: nothing
        assertEquals("a\nb\nけんきゅう", saver.text)
        composing = false // committed as it was (kana): no new text
        saver.replaceable()
        assertEquals("A\nb\nけんきゅう", saver.text)
        assertEquals(CanvasSaveStatus.SAVED, saver.status)
    }

    @Test
    fun aNetworkFailureIsRetriedWithTheSameKeyAndNeverMakesASecondVersion() {
        val server = FakeCanvasServer("x")
        val timers = ManualTimers()
        val saver = saver(server, timers)
        server.loseNextAnswer = true // applied on the server, the answer lost on the way back
        saver.edit("y")
        saver.flush()
        assertEquals(CanvasSaveStatus.OFFLINE, saver.status)
        assertEquals(2L, server.version)
        saver.edit("yz") // typed while offline: stays for the next save
        timers.advance(1_000)
        assertEquals(listOf("k1", "k1"), server.saves.take(2).map { it.clientSaveId })
        assertEquals(listOf("y", "y"), server.saves.take(2).map { it.body })
        assertEquals(server.saves[0].baseRevId, server.saves[1].baseRevId)
        // Then the rest goes, once typing has paused, on the version holding exactly "y".
        assertEquals(2, server.saves.size)
        timers.advance(1_000)
        assertEquals("yz", server.saves[2].body)
        assertEquals("yz", server.body)
        assertEquals(3L, server.version) // "y" once, then "yz"
    }

    @Test
    fun rateLimitsAndServerErrorsWaitAndRetryTheSameSave() {
        val server = FakeCanvasServer("x")
        val timers = ManualTimers()
        val saver = saver(server, timers)
        server.failures.add(ApiException.Api(429, "rate_limited", "Slow down", buildJsonObject { put("retry_after_seconds", 7) }))
        server.failures.add(ApiException.Api(503, "server_error", "Down"))
        saver.edit("y")
        saver.flush()
        assertEquals(CanvasSaveStatus.RETRYING, saver.status)
        timers.advance(6_999)
        assertEquals(1, server.saves.size)
        timers.advance(1) // retry_after_seconds
        assertEquals(2, server.saves.size)
        assertEquals(CanvasSaveStatus.RETRYING, saver.status)
        timers.advance(2_000) // the backoff's second step
        assertEquals(3, server.saves.size)
        assertEquals(setOf("k1"), server.saves.map { it.clientSaveId }.toSet())
        assertEquals(CanvasSaveStatus.SAVED, saver.status)
        assertEquals("y", server.body)
    }

    @Test
    fun reconnectingSendsAFailedSaveAtOnce() {
        val server = FakeCanvasServer("x")
        val timers = ManualTimers()
        val saver = saver(server, timers)
        server.failures.add(ApiException.Network(java.io.IOException("down")))
        saver.edit("y")
        saver.flush()
        assertEquals(CanvasSaveStatus.OFFLINE, saver.status)
        saver.online()
        assertEquals(2, server.saves.size)
        assertEquals("k1", server.saves[1].clientSaveId)
        assertEquals(CanvasSaveStatus.SAVED, saver.status)
    }

    @Test
    fun aConflictWaitsForAChoiceAndSendsItOnTheSameBase() {
        for ((choice, expected) in listOf("ours" to "mine\nb", "theirs" to "theirs\nb", "both" to "theirs\n> mine\nb")) {
            val server = FakeCanvasServer("a\nb")
            val timers = ManualTimers()
            val saver = saver(server, timers)
            server.otherSaves("theirs\nb")
            saver.edit("mine\nb")
            saver.flush()
            assertEquals(CanvasSaveStatus.CONFLICT, saver.status)
            val conflict = saver.conflict!!
            assertEquals("r1", conflict.baseRevId)
            assertEquals("mine", conflict.details.conflicts.single().ours)
            assertEquals("theirs", conflict.details.conflicts.single().theirs)
            // Automatic saves stop until the choice.
            saver.edit("mine\nb!")
            timers.advance(5_000)
            assertEquals(1, server.saves.size)
            saver.edit("mine\nb")
            saver.resolveConflict(choice)
            val sent = server.saves.last()
            assertEquals("r1", sent.baseRevId)
            assertEquals(choice, sent.onConflict)
            assertNotEquals(server.saves.first().clientSaveId, sent.clientSaveId) // a new key for the new request
            assertEquals(choice, expected, server.body)
            assertEquals(expected, saver.text)
            assertEquals(CanvasSaveStatus.SAVED, saver.status)
        }
    }

    @Test
    fun anExpiredBaseOffersMyTextOverTheCurrentOneOrTheCurrentOne() {
        for (mine in listOf(true, false)) {
            val server = FakeCanvasServer("a")
            val timers = ManualTimers()
            val saver = saver(server, timers)
            server.otherSaves("b")
            server.forget("r1") // thinned while this device was offline for days
            saver.edit("mine")
            saver.flush()
            assertEquals(CanvasSaveStatus.EXPIRED, saver.status)
            assertEquals("b", saver.expired!!.body)
            saver.resolveExpired(mine)
            if (mine) {
                assertEquals("mine", server.body)
                assertEquals(server.saves.last().baseRevId, "r2")
            } else {
                assertEquals("b", saver.text)
                assertEquals(1, server.saves.size)
            }
            assertEquals(CanvasSaveStatus.SAVED, saver.status)
        }
    }

    @Test
    fun aRefusalStopsSavingKeepsTheTextAndTheNextEditTriesAgain() {
        val server = FakeCanvasServer("a")
        val timers = ManualTimers()
        val saver = saver(server, timers)
        server.failures.add(ApiException.Api(422, "canvas_too_large", "Too large"))
        saver.edit("toolong")
        saver.flush()
        assertEquals(CanvasSaveStatus.BLOCKED, saver.status)
        assertEquals("canvas_too_large", (saver.error as ApiException.Api).code)
        assertEquals("toolong", saver.text)
        timers.advance(60_000)
        assertEquals(1, server.saves.size) // no retry of a refusal
        saver.edit("short")
        timers.advance(2_000)
        assertEquals("short", server.body)
        assertEquals(CanvasSaveStatus.SAVED, saver.status)
    }

    @Test
    fun theTrashStopsEverything() {
        val server = FakeCanvasServer("a")
        val timers = ManualTimers()
        val saver = saver(server, timers)
        saver.edit("b")
        saver.gone()
        timers.advance(5_000)
        assertTrue(server.saves.isEmpty())
        assertEquals(CanvasSaveStatus.GONE, saver.status)
        assertEquals("b", saver.text) // still here to copy
    }

    @Test
    fun offlineAtTheFirstReadLoadsWhenBackOnline() {
        val server = FakeCanvasServer("a")
        server.failures.add(ApiException.Network(java.io.IOException("down")))
        val timers = ManualTimers()
        val saver = saver(server, timers)
        assertEquals(CanvasSaveStatus.OFFLINE, saver.status)
        assertTrue(saver.loadError is ApiException.Network) // the screen offers 再読み込み, not an empty canvas
        saver.online()
        assertEquals(CanvasSaveStatus.SAVED, saver.status)
        assertNull(saver.loadError)
        assertEquals("a", saver.text)
    }

    @Test
    fun aFailedFirstReadIsKeptAndReadingAgainLoadsTheCanvas() {
        val server = FakeCanvasServer("a")
        server.failures.add(ApiException.Api(403, "forbidden", "Forbidden"))
        val timers = ManualTimers()
        val saver = saver(server, timers)
        assertEquals(CanvasSaveStatus.BLOCKED, saver.status)
        assertEquals(403, (saver.loadError as ApiException.Api).status)
        // 再読み込み: the spinner while it asks (the fake holds the answer), then the canvas.
        server.gate = CompletableDeferred()
        saver.load()
        assertEquals(CanvasSaveStatus.LOADING, saver.status)
        assertNull(saver.loadError)
        assertNull(saver.error)
        server.gate!!.complete(Unit)
        assertEquals(CanvasSaveStatus.SAVED, saver.status)
        assertEquals("a", saver.text)
        // Loaded: asking again reads nothing more.
        saver.load()
        assertEquals(listOf<Long?>(null), server.reads)
    }

    @Test
    fun aNewVersionIsReadAgainWhenIdleWithIfNoneMatchAndNotWhileTyping() {
        val server = FakeCanvasServer("a")
        val timers = ManualTimers()
        val saver = saver(server, timers)
        server.otherSaves("b")
        saver.remoteVersion(server.version)
        timers.advance(500)
        assertEquals(listOf(null, 1L), server.reads) // the first read, then with the version it knew
        assertEquals("b", saver.text)
        // A stale event (a version it has) reads nothing.
        saver.remoteVersion(server.version)
        timers.advance(500)
        assertEquals(2, server.reads.size)
        // Typing: the event is left to the next save's merge.
        saver.edit("b!")
        server.otherSaves("c")
        saver.remoteVersion(server.version)
        timers.advance(500)
        assertEquals(2, server.reads.size)
    }

    @Test
    fun aSaveKeptThroughARestartIsSentWithTheSameKey() = runBlocking {
        val disk = MemoryPersistence()
        val server = FakeCanvasServer("a")
        val timers = ManualTimers()
        val first = Store(disk)
        val saver = saver(server, timers, first)
        server.loseNextAnswer = true // applied, the answer lost: then the process dies
        saver.edit("b")
        saver.flush()
        assertEquals(CanvasSaveStatus.OFFLINE, saver.status)
        saver.dispose()
        assertTrue(disk.meta.containsKey(CANVAS_PENDING_PREFIX + server.canvasId))

        // A new process: the store loads the kept state, the saver sends it again with the same key.
        val second = Store(disk).also { it.load() }
        val kept = second.pendingCanvas(server.canvasId)
        assertNotNull(kept)
        assertEquals("k1", kept!!.inFlight!!.clientSaveId)
        val again = saver(server, ManualTimers(), second)
        assertEquals(listOf("k1", "k1"), server.saves.map { it.clientSaveId })
        assertEquals(2L, server.version) // one version for "b"
        assertEquals("b", again.text)
        assertEquals(CanvasSaveStatus.SAVED, again.status)
        assertNull(second.pendingCanvas(server.canvasId)) // nothing left to keep
        assertFalse(disk.meta.containsKey(CANVAS_PENDING_PREFIX + server.canvasId))
    }

    @Test
    fun typedButNotSentIsKeptAndSentAfterARestart() = runBlocking {
        val disk = MemoryPersistence()
        val server = FakeCanvasServer("a\nb")
        val first = Store(disk)
        val saver = saver(server, ManualTimers(), first)
        saver.edit("A\nb") // killed within the 2 s pause
        saver.dispose()
        server.otherSaves("a\nB")
        val second = Store(disk).also { it.load() }
        val again = saver(server, ManualTimers(), second)
        assertEquals("r1", server.saves.single().baseRevId) // written on the version it was typed on: merged
        assertEquals("A\nB", server.body)
        assertEquals("A\nB", again.text)
    }

    // --- the hub, the list, the rights ------------------------------------------------------

    private fun channel(type: String = "public", role: String? = "member", archived: Boolean = false, postingPolicy: String? = null, member: Boolean = true) = ChannelState(
        ChannelOut(
            id = "ch1", type = type, name = "lab", archived = archived, lastSeq = 0, createdAt = "", updatedAt = "",
            membership = role?.let { MembershipOut(it, "") }, postingPolicy = postingPolicy,
        ),
        isMember = member,
    )

    private fun meta(createdBy: String = "creator", editPolicy: String = "members", version: Long = 1, id: String = "c1", updatedAt: String = "2026-09-30T00:00:00Z", tab: Boolean = false) =
        CanvasMeta(id, "ch1", "t", version, "r1", isChannelTab = tab, editPolicy = editPolicy, createdBy = createdBy, updatedBy = createdBy, createdAt = "", updatedAt = updatedAt)

    @Test
    fun rightsFollowTheServer() {
        val members = meta()
        val owners = meta(editPolicy = "owners")
        // A member edits a members canvas; an owners canvas only ticks (the conflict choice is then 相手の版 only).
        assertEquals(CanvasRights(create = true, edit = true, tick = true, manage = false, trash = false), CanvasRights.of(channel(), "me", "member", members))
        val ticker = CanvasRights.of(channel(), "me", "member", owners)
        assertTrue(ticker.tickOnly)
        assertFalse(ticker.edit)
        // The creator, a channel owner and an administrator edit and manage it.
        assertTrue(CanvasRights.of(channel(), "creator", "member", owners).let { it.edit && it.manage && it.trash })
        assertTrue(CanvasRights.of(channel(role = "owner"), "me", "member", owners).let { it.edit && it.manage })
        assertTrue(CanvasRights.of(channel(), "me", "admin", owners).edit)
        // A guest reads only.
        assertEquals(CanvasRights.NONE, CanvasRights.of(channel(), "me", "guest", members).copy(create = false))
        assertFalse(CanvasRights.of(channel(), "me", "guest", members).tick)
        // An announcement channel: members tick, owners write.
        assertEquals(CanvasRights(tick = true), CanvasRights.of(channel(postingPolicy = "owners"), "me", "member", members))
        // Archived, or not a member: nothing.
        assertEquals(CanvasRights.NONE, CanvasRights.of(channel(archived = true), "creator", "admin", members))
        assertEquals(CanvasRights.NONE, CanvasRights.of(channel(member = false), "me", "member", members))
        // A DM: its members do everything; only the creator trashes.
        assertEquals(CanvasRights(true, true, true, true, false), CanvasRights.of(channel(type = "dm"), "me", "member", members))
        assertTrue(CanvasRights.of(channel(type = "group_dm"), "creator", "member", members).trash)
    }

    @Test
    fun theHubKeepsTheListCurrentByVersionAndDropsATrashedCanvas() = runBlocking {
        val server = FakeCanvasServer("a")
        val store = Store()
        store.upsertChannel(channel().channel, isMember = true)
        val hub = CanvasHub(server.api, store, scope, CanvasSaverOptions(timers = ManualTimers()))
        assertNull(store.canvasesOf("ch1"))
        // Events before the list is loaded are ignored (the list comes when the conversation opens).
        hub.applyEvent("canvas.created", buildJsonObject { put("canvas", Codec.snake.encodeToJsonElement(CanvasMeta.serializer(), meta(id = "c0"))) })
        assertNull(store.canvasesOf("ch1"))
        hub.loadList("ch1")
        assertEquals(listOf("c1"), store.canvasesOf("ch1")!!.map { it.id })
        // Newer first; the larger version wins.
        hub.applyEvent("canvas.created", buildJsonObject { put("canvas", Codec.snake.encodeToJsonElement(CanvasMeta.serializer(), meta(id = "c2", updatedAt = "2026-09-30T01:00:00Z"))) })
        assertEquals(listOf("c2", "c1"), store.canvasesOf("ch1")!!.map { it.id })
        hub.applyEvent("canvas.updated", buildJsonObject { put("canvas", Codec.snake.encodeToJsonElement(CanvasMeta.serializer(), meta(id = "c2", version = 3, tab = true))) })
        hub.applyEvent("canvas.updated", buildJsonObject { put("canvas", Codec.snake.encodeToJsonElement(CanvasMeta.serializer(), meta(id = "c2", version = 2))) })
        assertTrue(store.canvasesOf("ch1")!!.first { it.id == "c2" }.isChannelTab)
        // An open canvas that goes to the trash stops saving and forgets what it kept.
        val (saver, release) = hub.hold("c1", "ch1")
        saver!!.edit("b")
        assertNotNull(store.pendingCanvas("c1"))
        hub.applyEvent("canvas.deleted", buildJsonObject { put("canvas_id", "c1"); put("channel_id", "ch1") })
        assertEquals(CanvasSaveStatus.GONE, saver.status)
        assertNull(store.pendingCanvas("c1"))
        assertEquals(listOf("c2"), store.canvasesOf("ch1")!!.map { it.id })
        release()
        assertTrue(server.saves.isEmpty())
    }

    @Test
    fun leavingTheConversationDropsItsCanvasesAndTheirKeptEdits() = runBlocking {
        val server = FakeCanvasServer("a")
        val disk = MemoryPersistence()
        val store = Store(disk)
        store.upsertChannel(channel().channel, isMember = true)
        val hub = CanvasHub(server.api, store, scope, CanvasSaverOptions(timers = ManualTimers()))
        hub.loadList("ch1")
        val (saver, _) = hub.hold("c1", "ch1")
        saver!!.edit("b")
        assertTrue(disk.meta.containsKey(CANVAS_PENDING_PREFIX + "c1"))
        hub.removeChannel("ch1")
        store.removeChannel("ch1")
        assertNull(store.canvasesOf("ch1"))
        assertNull(store.pendingCanvas("c1"))
        assertFalse(disk.meta.containsKey(CANVAS_PENDING_PREFIX + "c1"))
    }

    @Test
    fun onlineResumesEditsKeptFromBeforeARestartForCanvasesNotOnScreen() = runBlocking {
        val disk = MemoryPersistence()
        val server = FakeCanvasServer("a")
        val first = Store(disk)
        first.upsertChannel(channel().channel, isMember = true)
        val timers = ManualTimers()
        val hub = CanvasHub(server.api, first, scope, CanvasSaverOptions(timers = timers, newId = { "k${++ids}" }))
        val (saver, _) = hub.hold("c1", "ch1")
        server.failures.add(ApiException.Network(java.io.IOException("down")))
        saver!!.edit("b")
        saver.flush()
        hub.stop()
        val second = Store(disk).also { it.load() }
        val restarted = CanvasHub(server.api, second, scope, CanvasSaverOptions(timers = ManualTimers()))
        restarted.online()
        assertEquals("b", server.body)
        assertEquals(listOf("k1", "k1"), server.saves.map { it.clientSaveId })
        assertNull(second.pendingCanvas("c1"))
        assertNull(restarted.current("c1")) // nobody shows it: dropped once saved
    }

    @Test
    fun aListThatCannotBeLoadedIsKeptForThePaneUntilItLoads() = runBlocking {
        val server = FakeCanvasServer("a")
        val store = Store()
        store.upsertChannel(channel().channel, isMember = true)
        val hub = CanvasHub(server.api, store, scope, CanvasSaverOptions(timers = ManualTimers()))
        // A server older than canvases: no such endpoint (tester report 2026-09-30: 「読み込み中…」 forever).
        server.failures.add(ApiException.Api(404, "not_found", "Not Found"))
        val before = store.version.value
        hub.loadList("ch1")
        assertNull(store.canvasesOf("ch1"))
        val missing = store.canvasListError("ch1")
        assertNotNull(missing)
        assertTrue(CanvasHub.serverLacksCanvases(missing!!))
        assertTrue(store.version.value > before) // the pane redraws
        // Anything else can be tried again (再読み込み); a later load (a reconnect, the server updated) clears it.
        server.failures.add(ApiException.Api(503, "http_503", "Unavailable"))
        hub.loadList("ch1")
        assertFalse(CanvasHub.serverLacksCanvases(store.canvasListError("ch1")!!))
        hub.loadList("ch1")
        assertNull(store.canvasListError("ch1"))
        assertEquals(listOf("c1"), store.canvasesOf("ch1")!!.map { it.id })
        // A 404 about the conversation is not an old server; leaving it forgets the failure.
        assertFalse(CanvasHub.serverLacksCanvases(ApiException.Api(404, "channel_not_found", "Channel not found")))
        assertFalse(CanvasHub.serverLacksCanvases(ApiException.Network(java.io.IOException("down"))))
        server.failures.add(ApiException.Network(java.io.IOException("down")))
        hub.loadList("ch1")
        assertNotNull(store.canvasListError("ch1"))
        assertEquals(listOf("c1"), store.canvasesOf("ch1")!!.map { it.id }) // the list it had stays
        store.removeChannel("ch1")
        assertNull(store.canvasListError("ch1"))
    }
}
