package jp.chikuwachat.android

import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.sync.ChannelState
import jp.chikuwachat.android.sync.EngineOptions
import jp.chikuwachat.android.sync.EngineStatus
import jp.chikuwachat.android.sync.MessageState
import jp.chikuwachat.android.sync.ReadAnchor
import jp.chikuwachat.android.sync.ReadGate
import jp.chikuwachat.android.sync.SendOptions
import jp.chikuwachat.android.sync.Store
import jp.chikuwachat.android.sync.SyncApi
import jp.chikuwachat.android.sync.SyncEngine
import jp.chikuwachat.android.ui.OpenPosition
import jp.chikuwachat.android.ui.ThreadRows
import jp.chikuwachat.android.ui.Timeline
import jp.chikuwachat.android.ui.TimelineItem
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.IOException

/**
 * SYNC_PROTOCOL.md §10.1 / §10.2 (M17) against the fake server: visible-range reads never skip unread rows this
 * device has not loaded, 「最初の未読へ」 pages back to the read position, 「既読にする」 still reads to the end.
 * The vector numbers are SYNC_PROTOCOL.md §10.4's.
 */
class UnreadRangeTest {
    private class World(pageSize: Int = 50, gapLimit: Int = 5000, type: String = "public") {
        val server = FakeServer()
        val alice = server.addUser("alice").id
        val bob = server.addUser("bob").id
        val channelId = server.createChannel("general", alice, type).id.also { server.join(it, bob) }
        val store = Store()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val time = ManualTime()
        // Held as the interface (see SyncEngineTest.World).
        private val syncApi: SyncApi = server.api(bob)
        val api: FakeServer.Api get() = syncApi as FakeServer.Api
        val engine = SyncEngine(syncApi, server.connector(bob), "ws://fake", store, { "t" }, scope,
            EngineOptions(pageSize = pageSize, gapLimit = gapLimit, sleep = {}, random = { 0.5 }, clock = time.clock, timer = time.timer))

        init { engine.isActive = { true } }

        val channel: ChannelState get() = store.channel(channelId)!!
        val rows: List<MessageState> get() = store.messages(channelId)
        fun rows(range: IntRange) = rows.filter { it.seq!! in range }
        fun post(count: Int, type: String = "user") = repeat(count) { server.post(channelId, alice, "m", type = type) }
        fun serverRow(seq: Int) = server.channels.getValue(channelId).messages.first { it.seq == seq }
        suspend fun settle() = repeat(20) { engine.idle(); yield() }
        suspend fun open() { engine.openChannel(channelId); engine.start(); settle() }
        suspend fun read(seq: Int, force: Boolean = false) { engine.markRead(channelId, seq, force); engine.flushReads(); settle() }
        fun close() { engine.stop(); scope.cancel() }
    }

    /** V2's state: 3,000 posts, read to 1,000, first open with a page of 50. */
    private suspend fun twoThousandUnread(): World {
        val w = World()
        w.post(3000)
        w.server.markRead(w.bob, w.channelId, 1000)
        w.open()
        return w
    }

    /**
     * One look of the channel view at `visible` (rows `partly` on screen too), marking what the anchor says through
     * the engine like ChannelPane's collector does.
     */
    private suspend fun World.look(anchor: ReadAnchor, visible: IntRange, partly: Set<Int> = emptySet()): ReadAnchor {
        val shown = rows(visible)
        val step = anchor.observe(channel, engine.heldUnread(channelId), rows, bob, shown, shown.mapTo(HashSet()) { it.id } + partly.map { serverRow(it).id })
        step.markSeq?.let { read(it) }
        return step.anchor
    }

    @Test fun v1_theRangeIsLoadedSoTheVisibleRowsRead() = runBlocking {
        val w = World()
        w.post(130); w.server.markRead(w.bob, w.channelId, 100)
        w.open()
        assertEquals(listOf(100, 30, 81), w.channel.let { listOf(it.lastReadSeq, it.unreadCount, it.oldestLoadedSeq) })
        assertTrue(w.engine.readRangeReady(w.channelId))
        val mark = ReadGate.dividerMark(w.engine.heldUnread(w.channelId), 100, w.channel.oldestLoadedSeq)
        val items = Timeline.build(w.rows, mark, w.bob).asReversed()
        val top = Timeline.openPosition(items, w.rows, null, mark, w.bob) as OpenPosition.Top
        assertEquals(101, (items[top.index - 1] as TimelineItem.Message).message.seq)
        val step = ReadGate.visibleRead(true, w.channel, w.rows, w.bob, w.rows(101..115))
        w.read(step.markSeq!!)
        assertEquals(listOf(115), w.api.readCalls)
        assertEquals(115, w.server.readState(w.bob, w.channelId).lastReadSeq)
        // 「新着 30 件」 when scrolled up: every row it counts is loaded, so it is the true count.
        assertEquals(30, w.rows.count { it.seq!! > 100 && it.senderId != w.bob })
        w.close()
    }

    @Test fun v2_openingTwoThousandUnreadNeverSendsAReadPastTheLoadedStart() = runBlocking { // M17 acceptance
        val w = twoThousandUnread()
        assertEquals(listOf(1000, 2000, 2951), w.channel.let { listOf(it.lastReadSeq, it.unreadCount, it.oldestLoadedSeq) })
        assertEquals(w.serverRow(1001).createdAt, w.channel.firstUnreadAt)
        assertFalse(w.engine.readRangeReady(w.channelId))
        assertEquals(ReadGate.ReadStep(false, null), ReadGate.visibleRead(false, w.channel, w.rows, w.bob, w.rows(2980..3000)))
        w.read(3000) // even straight from the engine
        assertEquals(1000, w.channel.lastReadSeq)
        assertEquals(emptyList<Int>(), w.api.readCalls)
        assertEquals(1000, w.server.readState(w.bob, w.channelId).lastReadSeq)
        assertNull(ReadGate.dividerMark(null, 1000, w.channel.oldestLoadedSeq))
        assertFalse(ReadGate.jumpButtonShown(w.engine.readRangeReady(w.channelId), w.channel.unreadCount))
        w.close()
    }

    @Test fun v3_markReadForcedReadsToTheEnd() = runBlocking {
        val w = twoThousandUnread()
        w.read(3000, force = true) // 「既読にする」
        assertEquals(listOf(3000), w.api.readCalls)
        assertEquals(Triple(3000, 0, null), w.channel.let { Triple(it.lastReadSeq, it.unreadCount, it.firstUnreadAt) })
        val server = w.server.readState(w.bob, w.channelId)
        assertEquals(0 to null, server.unreadCount to server.firstUnreadAt)
        assertTrue(ReadGate.nextAnchored(false, w.channel.unreadCount, w.engine.readRangeReady(w.channelId), null, emptyList()))
        assertFalse(ReadGate.bannerShown(false, true, w.channel.unreadCount, anchored = true, held = false))
        w.close()
    }

    @Test fun v4_jumpPagesBackTwoHundredAtATimeUntilTheReadPosition() = runBlocking {
        val w = World()
        w.post(1300); w.server.markRead(w.bob, w.channelId, 1000)
        w.open()
        assertEquals(1251, w.channel.oldestLoadedSeq)
        assertFalse(w.engine.readRangeReady(w.channelId))
        assertTrue(ReadGate.jumpButtonShown(false, w.channel.unreadCount))
        assertTrue(Timeline.bannerText(w.channel.unreadCount, w.channel.firstUnreadAt, java.time.ZonedDateTime.now()).startsWith("未読 300 件 · "))
        val before = w.api.historyCalls.size
        assertTrue(w.engine.loadFirstUnread(w.channelId))
        assertEquals(listOf(1251 to 200, 1051 to 200), w.api.historyCalls.drop(before))
        assertEquals(851, w.channel.oldestLoadedSeq)
        assertEquals(450, w.rows.size)
        // The view: capturedMark = 1000, the divider before 1001 at the top, anchored; then reading marks as usual.
        val mark = ReadGate.dividerMark(null, w.channel.lastReadSeq, w.channel.oldestLoadedSeq)
        assertEquals(1000, mark)
        val items = Timeline.build(w.rows, mark, w.bob).asReversed()
        val top = Timeline.openPosition(items, w.rows, null, mark, w.bob) as OpenPosition.Top
        assertTrue(items[top.index] is TimelineItem.UnreadSeparator)
        assertEquals(1001, (items[top.index - 1] as TimelineItem.Message).message.seq)
        val step = ReadGate.visibleRead(true, w.channel, w.rows, w.bob, w.rows(1001..1012))
        w.read(step.markSeq!!)
        assertEquals(listOf(1012), w.api.readCalls)
        assertEquals(1012, w.server.readState(w.bob, w.channelId).lastReadSeq)
        w.close()
    }

    @Test fun v5_repliesBetweenMakeCoversConservativeAndTheJumpLoadsOnePage() = runBlocking {
        val w = World()
        w.post(100)
        val parent = w.serverRow(1)
        repeat(3) { w.server.post(w.channelId, w.alice, "reply", parentId = parent.id) } // 101..103
        w.post(50) // 104..153
        w.server.markRead(w.bob, w.channelId, 100)
        w.open()
        assertEquals(50 to 104, w.channel.unreadCount to w.channel.oldestLoadedSeq)
        assertFalse(w.engine.readRangeReady(w.channelId)) // 104 > 101 although row 104 is the first unread
        w.read(153)
        assertEquals(emptyList<Int>(), w.api.readCalls)
        val before = w.api.historyCalls.size
        assertTrue(w.engine.loadFirstUnread(w.channelId))
        assertEquals(listOf(104 to 200), w.api.historyCalls.drop(before))
        assertEquals(0, w.channel.oldestLoadedSeq)
        assertEquals(104, ReadGate.firstUnreadRow(w.rows, ReadGate.dividerMark(null, 100, w.channel.oldestLoadedSeq)!!, w.bob)?.seq)
        w.close()
    }

    @Test fun v6_scrollingBackByHandReadsOnlyOnceTheFirstUnreadShows() = runBlocking {
        val w = World()
        w.post(1300); w.server.markRead(w.bob, w.channelId, 1000)
        w.open()
        repeat(5) { w.engine.loadOlder(w.channelId) }
        assertEquals(1001, w.channel.oldestLoadedSeq)
        assertTrue(w.engine.readRangeReady(w.channelId))
        assertEquals(1000, ReadGate.dividerMark(null, 1000, w.channel.oldestLoadedSeq)) // the divider appears now
        // Row 1001 is above the viewport: nothing is read yet.
        assertEquals(ReadGate.ReadStep(false, null), ReadGate.visibleRead(false, w.channel, w.rows, w.bob, w.rows(1045..1060)))
        assertTrue(ReadGate.bannerShown(false, true, w.channel.unreadCount, anchored = false, held = false))
        // 「最初の未読へ」 only scrolls now.
        val before = w.api.historyCalls.size
        assertTrue(w.engine.loadFirstUnread(w.channelId))
        assertEquals(before, w.api.historyCalls.size)
        val step = ReadGate.visibleRead(false, w.channel, w.rows, w.bob, w.rows(1001..1015))
        assertEquals(ReadGate.ReadStep(true, 1015), step)
        w.read(1015)
        assertEquals(listOf(1015), w.api.readCalls)
        w.close()
    }

    @Test fun v6_theGateJudgesTheShownRowsWithTheStateOfTheSameStoreVersion() = runBlocking {
        val w = World()
        w.post(1300); w.server.markRead(w.bob, w.channelId, 1000)
        w.open()
        repeat(4) { w.engine.loadOlder(w.channelId) }
        assertEquals(1051, w.channel.oldestLoadedSeq)
        val drawnRows = w.rows
        val drawnState = w.channel // what the list shows until it recomposes
        w.engine.loadOlder(w.channelId) // the 5th page lands: 1001..1050 are held but not drawn yet
        assertTrue(w.engine.readRangeReady(w.channelId))
        val onScreen = drawnRows.filter { it.seq!! in 1051..1063 } // a drag lays out the old rows again
        assertEquals(ReadGate.ReadStep(false, null), ReadGate.visibleRead(false, drawnState, drawnRows, w.bob, onScreen))
        // Mixed with the live state, the old top row passes for the first unread row and 1001..1050 would be read.
        assertEquals(ReadGate.ReadStep(true, 1063), ReadGate.visibleRead(false, w.channel, drawnRows, w.bob, onScreen))
        w.close()
    }

    @Test fun v7_anotherDeviceReadsIntoTheLoadedRange() = runBlocking {
        val w = twoThousandUnread()
        w.server.markRead(w.bob, w.channelId, 2990); w.settle() // read.updated (advance)
        assertEquals(2990 to 10, w.channel.lastReadSeq to w.channel.unreadCount)
        assertTrue(w.engine.readRangeReady(w.channelId))
        assertTrue(ReadGate.jumpButtonShown(true, 10))
        assertEquals(ReadGate.ReadStep(false, null), ReadGate.visibleRead(false, w.channel, w.rows, w.bob, w.rows(2995..3000)))
        val before = w.api.historyCalls.size
        assertTrue(w.engine.loadFirstUnread(w.channelId)) // no request: it scrolls 2991 to the top
        assertEquals(before, w.api.historyCalls.size)
        assertEquals(2991, ReadGate.firstUnreadRow(w.rows, w.channel.lastReadSeq, w.bob)?.seq)
        val step = ReadGate.visibleRead(false, w.channel, w.rows, w.bob, w.rows(2985..3000))
        assertEquals(ReadGate.ReadStep(true, 3000), step)
        w.read(3000)
        assertEquals(listOf(3000), w.api.readCalls)
        w.close()
    }

    @Test fun v8_aLiveMessageAddsToTheCountAndKeepsTheSinceTime() = runBlocking {
        val w = twoThousandUnread()
        val since = w.channel.firstUnreadAt
        w.server.post(w.channelId, w.alice, "new"); w.settle()
        assertEquals(2001 to since, w.channel.unreadCount to w.channel.firstUnreadAt)
        w.read(3001)
        assertEquals(emptyList<Int>(), w.api.readCalls)
        assertTrue(Timeline.bannerText(w.channel.unreadCount, since, java.time.ZonedDateTime.now()).startsWith("未読 2,001 件 · "))
        w.close()
    }

    @Test fun v9_myOwnPostReadsTheChannel() = runBlocking {
        val w = twoThousandUnread()
        w.engine.send(w.channelId, "mine"); w.settle()
        assertEquals(Triple(3001, 0, null), w.channel.let { Triple(it.lastReadSeq, it.unreadCount, it.firstUnreadAt) })
        assertEquals(3001, w.server.readState(w.bob, w.channelId).lastReadSeq)
        w.close()
    }

    @Test fun v10_aGapReloadMakesTheRangeUnreadyAgain() = runBlocking {
        val w = World()
        w.post(130); w.server.markRead(w.bob, w.channelId, 100)
        w.open()
        w.read(130)
        assertEquals(0, w.channel.unreadCount)
        w.engine.stop()
        w.post(6000) // while offline
        w.engine.start(); w.settle()
        assertEquals(1, w.engine.reloads)
        assertEquals(1, w.engine.reloadCount(w.channelId)) // the open view re-opens: position and anchor from scratch
        assertEquals(0, w.engine.reloadCount("other"))
        assertEquals(listOf(6000, 6081), w.channel.let { listOf(it.unreadCount, it.oldestLoadedSeq) })
        assertFalse(w.engine.readRangeReady(w.channelId))
        assertEquals(ReadGate.ReadStep(false, null), ReadGate.visibleRead(true, w.channel, w.rows, w.bob, w.rows(6120..6130)))
        w.read(6130)
        assertEquals(listOf(130), w.api.readCalls)
        assertTrue(ReadGate.bannerShown(false, true, w.channel.unreadCount, anchored = false, held = false))
        assertFalse(ReadGate.jumpButtonShown(false, w.channel.unreadCount))
        w.close()
    }

    @Test fun v11_aSetFromAnotherDeviceDropsTheAnchorWithoutAReadAndTheNextLookDecides() = runBlocking { // V11 (corrected)
        val w = World()
        w.post(1130); w.server.markRead(w.bob, w.channelId, 1130)
        w.open()
        repeat(20) { w.engine.loadOlder(w.channelId) }
        assertEquals(81, w.channel.oldestLoadedSeq)
        var anchor = w.look(ReadAnchor.opened(w.channel, null), 1116..1130)
        assertTrue(anchor.anchored)
        w.server.markRead(w.bob, w.channelId, 500, mode = "set"); w.settle()
        assertEquals(500 to 630, w.channel.lastReadSeq to w.channel.unreadCount)
        assertTrue(w.engine.readRangeReady(w.channelId)) // covered, yet the position went down
        anchor = w.look(anchor, 1116..1130)
        assertFalse(anchor.anchored)
        anchor = w.look(anchor, 1116..1130) // 501 is above the screen: the banner with both buttons
        assertFalse(anchor.anchored)
        assertTrue(ReadGate.bannerShown(false, true, w.channel.unreadCount, anchor.anchored, held = false))
        assertTrue(ReadGate.jumpButtonShown(w.engine.readRangeReady(w.channelId), w.channel.unreadCount))
        assertEquals(emptyList<Int>(), w.api.readCalls)
        anchor = w.look(anchor, 495..510) // scrolled to 501
        assertTrue(anchor.anchored)
        assertEquals(listOf(510), w.api.readCalls)
        w.close()
    }

    @Test fun v36_aSetIsNotUndoneByTheLayoutChangeItCausesOnlyByAScroll() = runBlocking {
        val w = World()
        w.post(1130); w.server.markRead(w.bob, w.channelId, 1100)
        w.open()
        repeat(20) { w.engine.loadOlder(w.channelId) }
        assertEquals(81, w.channel.oldestLoadedSeq)
        // Read to 1100, then scrolled back up to 495..510 (494 and 511 cut at the edges).
        var anchor = ReadAnchor(anchored = true, readSeq = 1100)
        w.server.markRead(w.bob, w.channelId, 500, mode = "set"); w.settle() // 「ここから未読にする」 on another device
        assertEquals(500 to 630, w.channel.lastReadSeq to w.channel.unreadCount)
        anchor = w.look(anchor, 495..510, partly = setOf(494, 511))
        assertFalse(anchor.anchored)
        // The banner that follows cuts the list's top rows; the remeasure is a look of its own. Rows on screen before
        // the set read nothing, however often they are looked at.
        anchor = w.look(anchor, 497..510, partly = setOf(496, 511))
        anchor = w.look(anchor, 495..510, partly = setOf(494, 511))
        assertFalse(anchor.anchored)
        assertEquals(emptyList<Int>(), w.api.readCalls)
        assertEquals(500, w.server.readState(w.bob, w.channelId).lastReadSeq)
        anchor = w.look(anchor, 490..505) // the reader scrolls up: rows that were not on screen
        assertTrue(anchor.anchored)
        assertEquals(listOf(505), w.api.readCalls)
        w.close()
    }

    @Test fun v12_aSetBelowTheLoadedRangeStopsVisibleReads() = runBlocking {
        val w = World()
        w.post(1300); w.server.markRead(w.bob, w.channelId, 1000)
        w.open()
        w.server.markRead(w.bob, w.channelId, 900, mode = "set"); w.settle()
        assertEquals(900 to 400, w.channel.lastReadSeq to w.channel.unreadCount)
        assertFalse(w.engine.readRangeReady(w.channelId))
        assertEquals(ReadGate.ReadStep(false, null), ReadGate.visibleRead(true, w.channel, w.rows, w.bob, w.rows(1290..1300)))
        w.read(1300)
        assertEquals(emptyList<Int>(), w.api.readCalls)
        assertTrue(ReadGate.jumpButtonShown(false, w.channel.unreadCount))
        w.close()
    }

    @Test fun v13_markUnreadHoldsVisibleReadsAndMovesTheDivider() = runBlocking {
        val w = World()
        w.post(130); w.server.markRead(w.bob, w.channelId, 100)
        w.open()
        w.read(115)
        w.engine.markUnread(w.channelId, 110); w.engine.flushReads(); w.settle()
        assertEquals(109, w.server.readState(w.bob, w.channelId).lastReadSeq)
        assertEquals(109, w.engine.heldUnread(w.channelId))
        assertEquals(w.serverRow(110).createdAt, w.channel.firstUnreadAt)
        w.read(130) // on hold
        assertEquals(listOf(115), w.api.readCalls)
        assertEquals(109, w.channel.lastReadSeq)
        assertEquals(109, ReadGate.dividerMark(w.engine.heldUnread(w.channelId), 100, w.channel.oldestLoadedSeq))
        assertFalse(ReadGate.bannerShown(false, true, w.channel.unreadCount, anchored = false, held = true))
        w.close()
    }

    @Test fun markUnreadNeverReadsRowsThisDeviceNeverLoaded() = runBlocking {
        val w = twoThousandUnread()
        val since = w.channel.firstUnreadAt
        // 「ここから未読にする」 on row 2990 (V2: 2951..3000 held) would set 2989 and read 1001..2989.
        assertEquals(1000, w.engine.markUnread(w.channelId, 2990))
        w.engine.flushReads(); w.settle()
        assertEquals(Triple(1000, 2000, since), w.channel.let { Triple(it.lastReadSeq, it.unreadCount, it.firstUnreadAt) })
        val server = w.server.readState(w.bob, w.channelId)
        assertEquals(1000 to 2000, server.lastReadSeq to server.unreadCount)
        assertEquals(1000, w.engine.heldUnread(w.channelId)) // reading pauses, as after any 「ここから未読にする」
        assertNull(ReadGate.dividerMark(w.engine.heldUnread(w.channelId), 1000, w.channel.oldestLoadedSeq))
        w.close()
    }

    @Test fun markUnreadMovesForwardOnceEveryRowBeforeItIsHeld() = runBlocking {
        val w = World()
        w.post(1300); w.server.markRead(w.bob, w.channelId, 1000)
        w.open()
        assertEquals(1000, w.engine.markUnread(w.channelId, 1290)) // not ready: stays
        assertTrue(w.engine.loadFirstUnread(w.channelId))
        assertEquals(1289, w.engine.markUnread(w.channelId, 1290)) // 1001..1289 are held now
        w.engine.flushReads(); w.settle()
        assertEquals(1289 to 11, w.server.readState(w.bob, w.channelId).let { it.lastReadSeq to it.unreadCount })
        w.close()
    }

    @Test fun markUnreadRecountsOnlyTheRowsTheServerCounts() = runBlocking { // rule 8 / rule 12
        val w = World()
        w.post(100); w.post(1, type = "system"); w.post(29) // 101 is a system row
        w.server.markRead(w.bob, w.channelId, 130)
        w.open()
        w.api.pendingFailure = IOException("offline") // the PUT fails: the local recount stays
        assertEquals(100, w.engine.markUnread(w.channelId, 101))
        w.settle()
        assertEquals(Triple(100, 29, w.serverRow(102).createdAt), w.channel.let { Triple(it.lastReadSeq, it.unreadCount, it.firstUnreadAt) })
        w.server.markRead(w.bob, w.channelId, 100, mode = "set")
        assertEquals(29 to w.serverRow(102).createdAt, w.server.readState(w.bob, w.channelId).let { it.unreadCount to it.firstUnreadAt })
        w.close()
    }

    @Test fun v14_systemRowsAreNotUnreadSoTheRangeIsReady() = runBlocking {
        val w = World()
        w.post(100); w.server.markRead(w.bob, w.channelId, 100)
        w.post(60, type = "system") // 101..160
        w.open()
        assertEquals(0 to 111, w.channel.unreadCount to w.channel.oldestLoadedSeq)
        assertTrue(w.engine.readRangeReady(w.channelId))
        val step = ReadGate.visibleRead(false, w.channel, w.rows, w.bob, w.rows(150..160))
        assertEquals(ReadGate.ReadStep(true, 160), step)
        w.read(160)
        assertEquals(listOf(160), w.api.readCalls)
        w.close()
    }

    @Test fun v15_theJumpStopsAfterFourPagesAndGoesOnFromThereWhenPressedAgain() = runBlocking {
        val w = World()
        w.post(1000); w.server.markRead(w.bob, w.channelId, 1000)
        repeat(300) { w.post(1); w.post(3, type = "system") } // 1001..2200
        w.open()
        assertEquals(300 to 2151, w.channel.unreadCount to w.channel.oldestLoadedSeq)
        assertTrue(ReadGate.jumpButtonShown(w.engine.readRangeReady(w.channelId), w.channel.unreadCount))
        var before = w.api.historyCalls.size
        assertFalse(w.engine.loadFirstUnread(w.channelId))
        assertEquals(listOf(2151, 1951, 1751, 1551).map { it to 200 }, w.api.historyCalls.drop(before))
        assertEquals(1351, w.channel.oldestLoadedSeq)
        assertTrue(ReadGate.bannerShown(false, true, w.channel.unreadCount, anchored = false, held = false))
        before = w.api.historyCalls.size
        assertTrue(w.engine.loadFirstUnread(w.channelId))
        assertEquals(listOf(1351 to 200, 1151 to 200), w.api.historyCalls.drop(before))
        assertEquals(951, w.channel.oldestLoadedSeq)
        val mark = ReadGate.dividerMark(null, w.channel.lastReadSeq, w.channel.oldestLoadedSeq)!!
        assertEquals(1001, ReadGate.firstUnreadRow(w.rows, mark, w.bob)?.seq)
        w.close()
    }

    @Test fun v16_offlineTheJumpMakesNoRequest() = runBlocking {
        val w = World()
        w.post(1300); w.server.markRead(w.bob, w.channelId, 1000)
        w.open()
        w.engine.stop()
        val before = w.api.historyCalls.size
        assertFalse(w.engine.loadFirstUnread(w.channelId))
        assertEquals(before, w.api.historyCalls.size)
        assertNotEquals(EngineStatus.ONLINE, w.engine.status.value) // the banner's buttons are disabled
        assertTrue(ReadGate.bannerShown(false, true, w.channel.unreadCount, anchored = false, held = false))
        w.close()
    }

    @Test fun jumpErrorsReachTheCallerAndTheNextPressGoesOn() = runBlocking {
        val w = World()
        w.post(1300); w.server.markRead(w.bob, w.channelId, 1000)
        w.open()
        w.api.pendingFailure = ApiException.Network(IOException("offline"))
        try {
            w.engine.loadFirstUnread(w.channelId)
            fail("the failure is the caller's to show")
        } catch (e: ApiException.Network) {
            // shown by the pane (controller.report)
        }
        assertEquals(1251, w.channel.oldestLoadedSeq)
        assertTrue(w.engine.loadFirstUnread(w.channelId))
        w.close()
    }

    @Test fun v28_aForcedReadIgnoresTheGate() = runBlocking {
        val w = World()
        w.post(60)
        w.open()
        assertEquals(listOf(0, 60, 11), w.channel.let { listOf(it.lastReadSeq, it.unreadCount, it.oldestLoadedSeq) })
        assertTrue(w.channel.hasOlder)
        w.read(60)
        assertEquals(0 to emptyList<Int>(), w.channel.lastReadSeq to w.api.readCalls)
        w.read(60, force = true)
        assertEquals(listOf(60), w.api.readCalls)
        assertEquals(Triple(60, 0, null), w.channel.let { Triple(it.lastReadSeq, it.unreadCount, it.firstUnreadAt) })
        w.close()
    }

    @Test fun v29_firstUnreadAtFollowsEveryChangeOfTheCount() = runBlocking {
        val w = World()
        w.post(3); w.server.markRead(w.bob, w.channelId, 3)
        w.open()
        assertEquals(0 to null, w.channel.unreadCount to w.channel.firstUnreadAt)
        val (m4, _) = w.server.post(w.channelId, w.alice, "m4"); w.settle()
        assertEquals(1 to m4.createdAt, w.channel.unreadCount to w.channel.firstUnreadAt) // 0 → 1
        w.server.post(w.channelId, w.alice, "m5"); w.settle()
        assertEquals(2 to m4.createdAt, w.channel.unreadCount to w.channel.firstUnreadAt) // later ones keep it
        w.engine.markRead(w.channelId, 5)
        assertNull(w.channel.firstUnreadAt) // reached last_seq
        w.engine.flushReads(); w.settle()
        assertNull(w.channel.firstUnreadAt)

        w.engine.markUnread(w.channelId, 4)
        assertEquals(2 to m4.createdAt, w.channel.unreadCount to w.channel.firstUnreadAt) // the first row counted
        w.engine.flushReads(); w.settle()
        assertEquals(m4.createdAt, w.channel.firstUnreadAt) // the server's value

        w.server.markRead(w.bob, w.channelId, 5); w.settle() // another device (read.updated advance)
        assertNull(w.channel.firstUnreadAt)
        w.server.markRead(w.bob, w.channelId, 3, mode = "set"); w.settle()
        assertEquals(m4.createdAt, w.channel.firstUnreadAt)
        w.engine.stop(); w.engine.start(); w.settle() // bootstrap read_state
        assertEquals(m4.createdAt, w.channel.firstUnreadAt)
        w.engine.markAllRead()
        assertEquals(0 to null, w.channel.unreadCount to w.channel.firstUnreadAt)
        // System rows are not unread (the server does not count them either).
        w.post(1, type = "system"); w.settle()
        assertEquals(0 to null, w.channel.unreadCount to w.channel.firstUnreadAt)
        w.close()
    }

    @Test fun v33_v34_afterAReconnectNothingIsReadUntilTheCatchUpAndTheFirstUnreadRowWasSeen() = runBlocking {
        val w = World()
        w.post(130); w.server.markRead(w.bob, w.channelId, 100)
        w.open()
        var anchor = w.look(ReadAnchor.opened(w.channel, null), 101..115)
        anchor = w.look(anchor, 116..130)
        assertEquals(listOf(115, 130), w.api.readCalls)
        w.engine.stop()
        w.post(300) // 131..430 while the app was away
        val gate = CompletableDeferred<Unit>()
        w.api.deltaGate = gate
        val started = async { w.engine.start() }
        repeat(10) { yield() }
        // V33: bootstrap raised last_seq, the delta is still on its way.
        assertEquals(listOf(430, 300, 130), w.channel.let { listOf(it.lastSeq, it.unreadCount, it.syncedSeq) })
        assertEquals(EngineStatus.CONNECTING, w.engine.status.value)
        assertFalse(w.engine.readRangeReady(w.channelId))
        val waiting = anchor.observe(w.channel, null, w.rows, w.bob, w.rows(116..130), w.rows(116..130).mapTo(HashSet()) { it.id })
        assertEquals(false to null, waiting.anchor.anchored to waiting.markSeq)
        anchor = waiting.anchor
        assertTrue(ReadGate.awaitingFirstUnread(w.engine.status.value, w.channel, w.rows, w.bob))
        assertFalse(ReadGate.bannerShown(false, true, w.channel.unreadCount, anchor.anchored, held = false,
            awaitingFirstUnread = ReadGate.awaitingFirstUnread(w.engine.status.value, w.channel, w.rows, w.bob)))
        gate.complete(Unit)
        started.await(); w.settle()
        assertEquals(EngineStatus.ONLINE, w.engine.status.value)
        assertTrue(w.engine.readRangeReady(w.channelId))
        assertFalse(ReadGate.awaitingFirstUnread(w.engine.status.value, w.channel, w.rows, w.bob))
        // V34: the list followed the rows to the bottom; 131 was never on screen.
        anchor = w.look(anchor, 416..430)
        assertFalse(anchor.anchored)
        assertEquals(listOf(115, 130), w.api.readCalls)
        assertTrue(ReadGate.bannerShown(false, true, w.channel.unreadCount, anchor.anchored, held = false))
        assertTrue(ReadGate.jumpButtonShown(w.engine.readRangeReady(w.channelId), w.channel.unreadCount))
        val before = w.api.historyCalls.size
        assertTrue(w.engine.loadFirstUnread(w.channelId)) // no request: it only lands on the divider
        assertEquals(before, w.api.historyCalls.size)
        anchor = w.look(anchor.startLanding().landed(), 131..145)
        assertEquals(listOf(115, 130, 145), w.api.readCalls)
        w.close()
    }

    @Test fun v33_aLiveGapStopsVisibleReadsUntilItsCatchUpArrives() = runBlocking {
        val w = World()
        w.post(130); w.server.markRead(w.bob, w.channelId, 125)
        w.open()
        assertTrue(w.engine.readRangeReady(w.channelId))
        w.server.socketsOf(w.bob).forEach { it.dropNext = 1 }
        w.post(1) // 131, lost
        val gate = CompletableDeferred<Unit>()
        w.api.deltaGate = gate
        w.post(1) // 132: a gap, and its catch-up waits
        assertEquals(EngineStatus.ONLINE, w.engine.status.value)
        assertEquals(132 to 130, w.channel.lastSeq to w.channel.syncedSeq)
        assertFalse(w.engine.readRangeReady(w.channelId))
        w.engine.markRead(w.channelId, 130) // what a look at the screen would send
        assertEquals(125, w.channel.lastReadSeq)
        gate.complete(Unit); w.settle()
        assertTrue(w.engine.readRangeReady(w.channelId))
        w.read(130)
        assertEquals(listOf(130), w.api.readCalls)
        w.close()
    }

    @Test fun aLiveGapCountsEveryRowItsCatchUpBringsOnce() = runBlocking { // §7.4
        val w = World()
        w.post(130); w.server.markRead(w.bob, w.channelId, 130)
        w.open()
        w.server.socketsOf(w.bob).forEach { it.dropNext = 1 }
        w.post(1) // 131, lost
        w.server.react(w.channelId, w.alice, w.serverRow(100).id, "👍", true); w.settle() // 132: a gap, and no new row
        assertEquals(132, w.channel.syncedSeq)
        assertEquals(1 to w.serverRow(131).createdAt, w.channel.unreadCount to w.channel.firstUnreadAt)
        assertEquals(1, w.server.readState(w.bob, w.channelId).unreadCount)
        w.server.socketsOf(w.bob).forEach { it.dropNext = 1 }
        w.post(1, type = "system") // 133, lost: brought by the catch-up, never unread
        w.post(2); w.settle() // 134 opens the gap, 135 follows
        assertEquals(135 to 3, w.channel.syncedSeq to w.channel.unreadCount)
        assertEquals(3, w.server.readState(w.bob, w.channelId).unreadCount)
        w.close()
    }

    @Test fun aRowPastTheCatchUpsCursorIsCountedByItsEventOnly() = runBlocking { // §4.3
        val w = World()
        w.post(130); w.server.markRead(w.bob, w.channelId, 130)
        w.open()
        w.server.socketsOf(w.bob).forEach { it.dropNext = 1 }
        w.post(1) // 131, lost
        w.server.beforeDeltaRows = { w.post(1) } // 133 is stored after the cursor (132) was read: the delta has it too
        w.post(1); w.settle() // 132 opens the gap; then 133's event applies in order
        assertEquals(133 to 3, w.channel.syncedSeq to w.channel.unreadCount)
        assertEquals(3, w.server.readState(w.bob, w.channelId).unreadCount)
        w.close()
    }

    @Test fun aCatchUpNeverCountsRowsTheBootstrapAlreadyCounted() = runBlocking {
        val w = World()
        val other = w.server.createChannel("random", w.alice).id.also { w.server.join(it, w.bob) }
        w.post(130); w.server.markRead(w.bob, w.channelId, 130)
        w.open()
        w.engine.openChannel(other); w.settle() // C is not shown: it does not catch up when reconnecting
        w.engine.stop()
        w.post(300) // 131..430
        w.engine.start(); w.settle()
        assertEquals(listOf(430, 300, 130), w.channel.let { listOf(it.lastSeq, it.unreadCount, it.syncedSeq) })
        w.post(1); w.settle() // 431: a gap from 130, whose catch-up brings 131..431
        assertEquals(431 to 301, w.channel.syncedSeq to w.channel.unreadCount)
        assertEquals(301, w.server.readState(w.bob, w.channelId).unreadCount)
        w.close()
    }

    @Test fun aPostDuringTheReconnectsBootstrapIsCounted() = runBlocking {
        val w = World()
        w.post(130); w.server.markRead(w.bob, w.channelId, 130)
        w.open()
        w.engine.stop()
        w.post(10) // 131..140
        val gate = CompletableDeferred<Unit>()
        w.api.deltaGate = gate
        val started = async { w.engine.start() }
        repeat(10) { yield() }
        assertEquals(140 to 10, w.channel.lastSeq to w.channel.unreadCount) // bootstrap; the catch-up waits
        w.post(1) // 141: its event waits behind the catch-up, which brings the row, so the event is then stale
        gate.complete(Unit)
        started.await(); w.settle()
        assertEquals(141 to 11, w.channel.syncedSeq to w.channel.unreadCount)
        assertEquals(11, w.server.readState(w.bob, w.channelId).unreadCount)
        w.close()
    }

    @Test fun v35_aChannelOpenedBehindPositionsAfterItsCatchUp() = runBlocking {
        val w = World()
        val other = w.server.createChannel("random", w.alice).id.also { w.server.join(it, w.bob) }
        w.post(130); w.server.markRead(w.bob, w.channelId, 130)
        w.open()
        w.engine.openChannel(other); w.settle() // the reader moved on
        w.engine.stop()
        w.post(300) // 131..430
        w.engine.start(); w.settle() // only the open conversation catches up
        assertEquals(listOf(430, 300, 130), w.channel.let { listOf(it.lastSeq, it.unreadCount, it.syncedSeq) })
        val mark = ReadGate.openMark(w.channel)
        assertEquals(130, mark)
        val gate = CompletableDeferred<Unit>()
        w.api.deltaGate = gate
        val opening = async { w.engine.openChannel(w.channelId) }
        repeat(10) { yield() }
        // The view waits (unpositioned, so no banner and no reads) while the catch-up is on its way.
        assertTrue(ReadGate.waitsForCatchUp(w.engine.status.value, w.channel))
        assertNull(ReadGate.firstUnreadRow(w.rows, 130, w.bob))
        gate.complete(Unit)
        opening.await(); w.settle()
        assertFalse(ReadGate.waitsForCatchUp(w.engine.status.value, w.channel))
        val items = Timeline.build(w.rows, ReadGate.dividerMark(null, mark, w.channel.oldestLoadedSeq), w.bob).asReversed()
        val top = Timeline.openPosition(items, w.rows, null, mark, w.bob) as OpenPosition.Top
        assertTrue(items[top.index] is TimelineItem.UnreadSeparator)
        assertEquals(131, (items[top.index - 1] as TimelineItem.Message).message.seq)
        w.look(ReadAnchor.opened(w.channel, null).landed(), 131..145)
        assertEquals(listOf(145), w.api.readCalls)
        w.close()
    }

    @Test fun v35_positioningWaitsAtMostThreeSecondsAndNeverPastADrag() = runBlocking {
        val waiting = MutableStateFlow(true)
        val scrolled = MutableStateFlow(false)
        val caughtUp = async { Timeline.awaitCatchUp(waiting, scrolled, timeoutMs = 10_000) }
        yield()
        assertFalse(caughtUp.isCompleted)
        waiting.value = false // the catch-up arrived
        assertTrue(caughtUp.await())
        waiting.value = true
        val dragged = async { Timeline.awaitCatchUp(waiting, scrolled, timeoutMs = 10_000) }
        yield()
        scrolled.value = true // the reader scrolled first: the list stays where they put it
        assertFalse(dragged.await())
        assertTrue(Timeline.awaitCatchUp(MutableStateFlow(true), MutableStateFlow(false), timeoutMs = 50)) // positioned anyway
        assertTrue(Timeline.awaitCatchUp(MutableStateFlow(false), MutableStateFlow(false), timeoutMs = 10_000)) // no wait
        assertEquals(3_000L, Timeline.CATCH_UP_WAIT_MS)
        val behind = ChannelState(
            jp.chikuwachat.android.api.ChannelOut(id = "c", type = "public", name = "c", createdBy = "a", createdAt = "", updatedAt = "", lastSeq = 430, archived = false),
            isMember = true, syncedSeq = 130, lastSeq = 430, lastReadSeq = 130, unreadCount = 300, oldestLoadedSeq = 81,
        )
        assertTrue(ReadGate.waitsForCatchUp(EngineStatus.CONNECTING, behind))
        assertFalse(ReadGate.waitsForCatchUp(EngineStatus.OFFLINE, behind)) // offline nothing is coming
    }

    @Test fun v38_markUnreadMovesForwardOnlyWhenTheRangeIsReady() = runBlocking {
        val w = twoThousandUnread()
        assertFalse(ReadGate.markUnreadOffered(w.channel, 2990))
        assertEquals(1000, w.engine.markUnread(w.channelId, 2990))
        w.engine.flushReads(); w.settle()
        assertEquals(emptyList<Int>(), w.api.setCalls + w.api.readCalls)
        assertEquals(1000 to 1000, w.channel.lastReadSeq to w.engine.heldUnread(w.channelId))
        w.close()

        val v1 = World()
        v1.post(130); v1.server.markRead(v1.bob, v1.channelId, 115)
        v1.open()
        assertTrue(ReadGate.markUnreadOffered(v1.channel, 125))
        assertEquals(124, v1.engine.markUnread(v1.channelId, 125))
        v1.engine.flushReads(); v1.settle()
        assertEquals(listOf(124), v1.api.setCalls)
        assertEquals(124, v1.server.readState(v1.bob, v1.channelId).lastReadSeq)
        v1.close()
    }

    @Test fun v41_myOwnMessageEventNeverMovesTheReadPositionOnlyThisDevicesPostDoes() = runBlocking {
        val w = World()
        w.post(130); w.server.markRead(w.bob, w.channelId, 130)
        w.open()
        w.server.holdEvents = true
        w.post(1) // alice 131
        w.server.post(w.channelId, w.bob, "from my phone") // 132: message.created, then read.updated
        w.server.releaseNext(); w.settle()
        assertEquals(130 to 1, w.channel.lastReadSeq to w.channel.unreadCount)
        w.server.releaseNext(); w.settle() // my own message.created
        assertEquals(130 to 1, w.channel.lastReadSeq to w.channel.unreadCount)
        w.server.releaseNext(); w.settle() // read.updated
        assertEquals(132 to 0, w.channel.lastReadSeq to w.channel.unreadCount)

        w.post(1) // 133
        w.server.releaseNext(); w.settle()
        assertEquals(1, w.channel.unreadCount)
        assertEquals(132, w.engine.markUnread(w.channelId, 133)) // held at 132
        w.engine.flushReads(); w.settle()
        assertEquals(132, w.engine.heldUnread(w.channelId))
        w.engine.send(w.channelId, "mine") // 134; its events stay held
        assertEquals(Triple(134, 0, null), w.channel.let { Triple(it.lastReadSeq, it.unreadCount, it.firstUnreadAt) })
        assertNull(w.engine.heldUnread(w.channelId))
        w.server.holdEvents = false
        w.server.release(); w.settle()
        assertEquals(134 to 0, w.channel.lastReadSeq to w.channel.unreadCount)
        w.close()
    }

    @Test fun v41_anAnswerThatComesAfterLaterRowsKeepsTheirCount() = runBlocking {
        val w = World()
        w.post(130); w.server.markRead(w.bob, w.channelId, 130)
        w.open()
        val gate = CompletableDeferred<Unit>()
        w.api.postResponseGate = gate
        val sending = async { w.engine.send(w.channelId, "mine") } // 131: stored, its events arrive, the answer waits
        repeat(10) { yield() }
        w.post(3); w.settle() // alice 132..134
        assertEquals(131 to 3, w.channel.lastReadSeq to w.channel.unreadCount)
        gate.complete(Unit); sending.await(); w.settle()
        assertEquals(Triple(131, 3, w.serverRow(132).createdAt), w.channel.let { Triple(it.lastReadSeq, it.unreadCount, it.firstUnreadAt) })
        assertEquals(131 to 3, w.server.readState(w.bob, w.channelId).let { it.lastReadSeq to it.unreadCount })
        w.close()
    }

    @Test fun v41_aReplayedPostReadsNothingAgain() = runBlocking {
        val w = World()
        w.post(130); w.server.markRead(w.bob, w.channelId, 130)
        w.open()
        w.engine.stop()
        w.engine.send(w.channelId, "mine", clientMsgId = "k1") // queued offline
        w.server.post(w.channelId, w.bob, "mine", clientMsgId = "k1") // an earlier try reached the server (131), its answer was lost
        w.post(300) // alice 132..431
        w.engine.start(); w.settle() // bootstrap: 131 / 300; then the outbox sends k1 again and gets 200 with 131
        assertTrue(w.store.outbox.isEmpty())
        assertEquals(1, w.server.channels.getValue(w.channelId).messages.count { it.body == "mine" })
        assertEquals(Triple(131, 300, w.serverRow(132).createdAt), w.channel.let { Triple(it.lastReadSeq, it.unreadCount, it.firstUnreadAt) })
        assertEquals(131 to 300, w.server.readState(w.bob, w.channelId).let { it.lastReadSeq to it.unreadCount })
        assertEquals(131, ReadGate.openMark(w.channel)) // opened, the view lands on the divider, not anchored at the bottom
        w.close()
    }

    @Test fun v42_aScheduledSendOfMineLeavesTheLocalPositionWhereTheServerHasIt() = runBlocking {
        val w = twoThousandUnread()
        w.server.post(w.channelId, w.bob, "scheduled", scheduled = true); w.settle() // 3001: the server does not read
        assertEquals(1000 to 2000, w.channel.lastReadSeq to w.channel.unreadCount)
        w.post(1); w.settle() // alice 3002, on screen
        assertEquals(1000 to 2001, w.channel.lastReadSeq to w.channel.unreadCount)
        w.read(3002)
        assertEquals(emptyList<Int>(), w.api.readCalls)
        assertEquals(1000 to 2001, w.server.readState(w.bob, w.channelId).let { it.lastReadSeq to it.unreadCount })
        w.close()
    }

    @Test fun v43_aReplyAlsoSentToTheChannelLeavesItsReadPositionAlone() = runBlocking {
        val w = World()
        w.post(400); w.server.markRead(w.bob, w.channelId, 130)
        w.open()
        w.engine.send(w.channelId, "shared", parentId = w.serverRow(120).id, sendOptions = SendOptions(alsoInChannel = true)); w.settle()
        assertTrue(w.rows.any { it.body == "shared" && it.alsoInChannel && !it.pending })
        assertEquals(130 to 270, w.channel.lastReadSeq to w.channel.unreadCount)
        assertEquals(130, w.server.readState(w.bob, w.channelId).lastReadSeq)
        w.close()
    }

    @Test fun v44_aSystemRowIsNotUnreadTheNextPostIs() = runBlocking {
        val w = World()
        w.post(3); w.server.markRead(w.bob, w.channelId, 3)
        w.open()
        w.post(1, type = "system"); w.settle()
        assertEquals(0 to null, w.channel.unreadCount to w.channel.firstUnreadAt)
        // Rule 15: the first unread row itself has no type filter (the divider goes before a system row too).
        assertEquals(4, ReadGate.firstUnreadRow(w.rows, w.channel.lastReadSeq, w.bob)?.seq)
        val (m5, _) = w.server.post(w.channelId, w.alice, "m5"); w.settle()
        assertEquals(1 to m5.createdAt, w.channel.unreadCount to w.channel.firstUnreadAt)
        assertEquals(1 to m5.createdAt, w.server.readState(w.bob, w.channelId).let { it.unreadCount to it.firstUnreadAt })
        w.close()
    }

    @Test fun v45_aReloadInTheBackgroundOpensTheViewAgain() = runBlocking {
        val w = World(gapLimit = 5)
        w.post(130); w.server.markRead(w.bob, w.channelId, 100)
        w.open()
        w.look(ReadAnchor.opened(w.channel, null), 101..115)
        assertEquals(listOf(115), w.api.readCalls)
        w.engine.isActive = { false } // in the background
        w.engine.stop()
        w.post(20) // 131..150
        w.server.markRead(w.bob, w.channelId, 140) // another device read most of it
        w.engine.start(); w.settle() // §7.3 reload; the new page reaches the read position
        assertEquals(1, w.engine.reloadCount(w.channelId)) // ChannelPane keys its view state on it
        assertEquals(listOf(140, 10, 101), w.channel.let { listOf(it.lastReadSeq, it.unreadCount, it.oldestLoadedSeq) })
        assertTrue(w.engine.readRangeReady(w.channelId))
        w.engine.isActive = { true } // back in the foreground: the first look sends nothing
        var anchor = w.look(ReadAnchor.opened(w.channel, null), 146..150)
        assertFalse(anchor.anchored)
        assertEquals(listOf(115), w.api.readCalls)
        anchor = w.look(anchor, 136..150)
        assertTrue(anchor.anchored)
        assertEquals(listOf(115, 150), w.api.readCalls)
        w.close()
    }

    // --- threads (§10.2) ---------------------------------------------------------------------------

    /** V24's thread: parent at seq 500, r1..r28 before bob comes online, r29 and r30 live; bob has read to 510. */
    private suspend fun thread(w: World): MessageState {
        w.post(499)
        val (parent, _) = w.server.post(w.channelId, w.alice, "topic")
        (1..28).forEach { w.server.post(w.channelId, w.alice, "r$it", parentId = parent.id) }
        w.server.markThreadRead(w.bob, parent.id, 510)
        w.open() // the timeline holds the parent; history leaves the replies out
        (29..30).forEach { w.server.post(w.channelId, w.alice, "r$it", parentId = parent.id) }
        w.settle()
        return MessageState.from(parent)
    }

    @Test fun v24_aThreadReadsOnlyOnceItsWholeReplyListIsLoaded() = runBlocking {
        val w = World(gapLimit = 5)
        val parent = thread(w)
        val held = w.store.replies(w.channelId, parent.id)
        assertEquals(listOf("r29", "r30"), held.map { it.body })
        w.engine.loadThreadState(parent.id)
        assertEquals(510, w.store.threads[parent.id]?.state?.lastReadSeq)
        assertFalse(w.engine.threadComplete(parent.id))
        assertEquals(OpenPosition.Bottom, ThreadRows.openPosition(held, 2, null, null, w.bob)) // local rows at the bottom
        w.engine.markThreadRead(parent.id, 530); w.engine.flushReads(); w.settle()
        assertEquals(emptyList<Int>(), w.api.threadReadCalls)
        assertEquals(510, w.store.threads[parent.id]?.state?.lastReadSeq)

        assertTrue(w.engine.loadReplies(w.channelId, parent.id))
        assertTrue(w.engine.threadComplete(parent.id))
        val replies = w.store.replies(w.channelId, parent.id)
        assertEquals(30, replies.size)
        val top = ThreadRows.openPosition(replies, 2, null, 510, w.bob) as OpenPosition.Top
        assertEquals("r11", ThreadRows.replyAt(replies, 2, top.index)?.body)
        val shown = (top.index until top.index + 8).mapNotNull { ThreadRows.replyAt(replies, 2, it) }
        assertTrue(ReadGate.nextThreadAnchored(false, true, ReadGate.firstUnreadRow(replies, 510, w.bob), shown))
        w.engine.markThreadRead(parent.id, shown.maxOf { it.seq!! }); w.engine.flushReads(); w.settle()
        assertEquals(listOf(518), w.api.threadReadCalls)
        assertEquals(518, w.server.threadState(w.bob, parent.id).lastReadSeq)
        w.close()
    }

    @Test fun v25_aGapReloadOfTheChannelForgetsTheLoadedThread() = runBlocking {
        val w = World(gapLimit = 5)
        val parent = thread(w)
        w.engine.loadThreadState(parent.id)
        assertTrue(w.engine.loadReplies(w.channelId, parent.id))
        w.engine.stop()
        w.post(6) // more than gapLimit while away
        w.engine.start(); w.settle()
        assertEquals(1, w.engine.reloads)
        assertFalse(w.engine.threadComplete(parent.id))
        w.engine.markThreadRead(parent.id, 525); w.engine.flushReads(); w.settle()
        assertEquals(emptyList<Int>(), w.api.threadReadCalls)
        assertTrue(w.engine.loadReplies(w.channelId, parent.id))
        w.engine.markThreadRead(parent.id, 525); w.engine.flushReads(); w.settle()
        assertEquals(listOf(525), w.api.threadReadCalls)
        w.close()
    }

    @Test fun v27_repliesThatFailToLoadLeaveTheThreadIncomplete() = runBlocking {
        val w = World()
        val parent = thread(w)
        w.engine.loadThreadState(parent.id)
        w.api.pendingFailure = ApiException.Network(IOException("offline"))
        try {
            w.engine.loadReplies(w.channelId, parent.id)
            fail("the failure is the caller's to show")
        } catch (e: ApiException.Network) {
            // the pane reports it
        }
        assertFalse(w.engine.threadComplete(parent.id))
        w.engine.stop()
        assertFalse(w.engine.loadReplies(w.channelId, parent.id)) // offline: no request, not loaded
        assertFalse(w.engine.threadComplete(parent.id))
        w.engine.start(); w.settle()
        assertTrue(w.engine.loadReplies(w.channelId, parent.id))
        assertTrue(w.engine.threadComplete(parent.id))
        w.close()
    }

    @Test fun v53_leavingTheChannelForgetsItsLoadedThreads() = runBlocking { // AppController.leaveChannel
        val w = World()
        val parent = thread(w)
        w.engine.loadThreadState(parent.id)
        assertTrue(w.engine.loadReplies(w.channelId, parent.id))
        w.engine.dropChannel(w.channelId)
        assertNull(w.store.channel(w.channelId))
        assertFalse(w.engine.threadComplete(parent.id))
        // Back in the channel (its member_removed was missed, bootstrap lists it again): no thread read until refetched.
        w.engine.stop(); w.engine.start(); w.settle()
        assertTrue(w.store.channel(w.channelId) != null)
        w.engine.markThreadRead(parent.id, 525); w.engine.flushReads(); w.settle()
        assertEquals(emptyList<Int>(), w.api.threadReadCalls)
        assertTrue(w.engine.loadReplies(w.channelId, parent.id))
        w.engine.markThreadRead(parent.id, 525); w.engine.flushReads(); w.settle()
        assertEquals(listOf(525), w.api.threadReadCalls)
        w.close()
    }

    @Test fun v49_aReloadWhileOnlineDropsTheOpenThreadUntilItIsFetchedAgain() = runBlocking {
        val w = World(gapLimit = 5)
        val parent = thread(w)
        w.engine.loadThreadState(parent.id)
        assertTrue(w.engine.loadReplies(w.channelId, parent.id))
        w.server.socketsOf(w.bob).forEach { it.dropNext = 6 }
        w.post(6) // lost
        w.post(1); w.settle() // a gap wider than gapLimit: a §7.3 reload while online
        assertEquals(EngineStatus.ONLINE, w.engine.status.value)
        assertEquals(1, w.engine.reloadCount(w.channelId))
        // ThreadPane fetches again when this drops while online (LaunchedEffect on `complete`), not on a status change.
        assertFalse(w.engine.threadComplete(parent.id))
        w.engine.markThreadRead(parent.id, 525); w.engine.flushReads(); w.settle()
        assertEquals(emptyList<Int>(), w.api.threadReadCalls)
        assertTrue(w.engine.loadReplies(w.channelId, parent.id))
        w.engine.markThreadRead(parent.id, 525); w.engine.flushReads(); w.settle()
        assertEquals(listOf(525), w.api.threadReadCalls)
        w.close()
    }

    @Test fun v52_aThreadReadPositionNeverGoesBelowWhatThisDeviceRead() = runBlocking {
        val w = World()
        val parent = thread(w)
        w.server.setThreadFollow(w.bob, parent.id, true) // thread.updated reaches bob
        w.engine.loadThreadState(parent.id)
        assertTrue(w.engine.loadReplies(w.channelId, parent.id))
        fun local() = w.store.threads[parent.id]?.state?.lastReadSeq
        assertEquals(510, local())
        val gate = CompletableDeferred<Unit>()
        w.api.threadReadGate = gate
        w.engine.markThreadRead(parent.id, 518) // shown; its PUT is still on the way
        assertEquals(518, local())
        w.server.post(w.channelId, w.alice, "r31", parentId = parent.id); w.settle() // thread.updated (reply) says 510
        assertEquals(510, w.server.threadState(w.bob, parent.id).lastReadSeq)
        assertEquals(518, local())
        w.engine.loadThreadState(parent.id) // GET thread state: 510
        assertEquals(518, local())
        w.engine.setThreadFollow(parent.id, true) // the follow response: 510
        assertEquals(518, local())
        gate.complete(Unit); w.engine.flushReads(); w.settle()
        assertEquals(518, w.server.threadState(w.bob, parent.id).lastReadSeq)
        assertEquals(518, local())
        w.close()
    }

    @Test fun v52_theThreadsListRefreshKeepsTheFloorAndTheShownThread() = runBlocking {
        val w = World()
        val parent = thread(w)
        w.server.setThreadFollow(w.bob, parent.id, true)
        w.engine.loadThreadState(parent.id)
        assertTrue(w.engine.loadReplies(w.channelId, parent.id))
        w.engine.loadThreads("all") // the threads view was opened: every thread.updated refreshes it now
        w.engine.threadShown(parent.id, true)
        fun local() = w.store.threads[parent.id]?.state?.lastReadSeq
        val gate = CompletableDeferred<Unit>()
        w.api.threadReadGate = gate
        w.engine.markThreadRead(parent.id, 518) // its PUT is still on the way
        w.server.post(w.channelId, w.alice, "r31", parentId = parent.id); w.settle() // thread.updated, then the list refresh
        w.engine.loadThreads("all") // GET /threads: 510
        assertEquals(510, w.server.threadState(w.bob, parent.id).lastReadSeq)
        assertEquals(518, local())
        // Unfollowed elsewhere and the event missed: the list no longer has it, yet the thread on screen keeps its state.
        w.server.threadFollows.getValue("${parent.id}:${w.bob}").following = false
        w.engine.loadThreads("all")
        assertEquals(518, local())
        w.engine.threadShown(parent.id, false)
        w.engine.loadThreads("all")
        assertNull(w.store.threads[parent.id])
        gate.complete(Unit); w.engine.flushReads(); w.settle()
        assertEquals(518, w.server.threadState(w.bob, parent.id).lastReadSeq)
        w.close()
    }

    @Test fun aChannelNoLongerBrowsableForgetsItsLoadedThreads() = runBlocking {
        val w = World()
        val parent = thread(w)
        assertTrue(w.engine.loadReplies(w.channelId, parent.id))
        // Left without the member_removed event, and then made private: only the browse list notices.
        val record = w.server.channels.getValue(w.channelId)
        record.members.remove(w.bob)
        record.channel = record.channel.copy(type = "private")
        w.store.updateChannel(w.channelId) { it.copy(isMember = false) }
        w.engine.loadBrowsableChannels()
        assertNull(w.store.channel(w.channelId))
        assertFalse(w.engine.threadComplete(parent.id))
        w.close()
    }

    @Test fun removedFromTheChannelForgetsItsLoadedThreads() = runBlocking {
        val w = World(type = "private") // a public one would come back as browsable
        val parent = thread(w)
        assertTrue(w.engine.loadReplies(w.channelId, parent.id))
        w.engine.stop()
        w.server.channels.getValue(w.channelId).members.remove(w.bob)
        w.engine.start(); w.settle() // bootstrap no longer lists it
        assertNull(w.store.channel(w.channelId))
        assertFalse(w.engine.threadComplete(parent.id))
        w.close()
    }
}
