package jp.chikuwachat.android

import jp.chikuwachat.android.api.ChannelOut
import jp.chikuwachat.android.sync.ChannelState
import jp.chikuwachat.android.sync.EngineStatus
import jp.chikuwachat.android.sync.MessageState
import jp.chikuwachat.android.sync.ReadAnchor
import jp.chikuwachat.android.sync.ReadGate
import jp.chikuwachat.android.ui.OpenPosition
import jp.chikuwachat.android.ui.ThreadRows
import jp.chikuwachat.android.ui.Timeline
import jp.chikuwachat.android.ui.TimelineItem
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneId
import java.time.ZonedDateTime
import java.util.Locale

/** SYNC_PROTOCOL.md §10.1–§10.4 (M17): the pure helpers and the view rules built on them (vectors V1–V53). */
class ReadGateTest {
    private val zone = ZoneId.of("Asia/Tokyo")
    /** 2026-09-28 (Mon) 15:00 local, the vectors' "now". */
    private val now = ZonedDateTime.of(2026, 9, 28, 15, 0, 0, 0, zone)
    private val bob = "bob"

    private fun iso(year: Int, month: Int, day: Int, hour: Int, minute: Int) =
        ZonedDateTime.of(year, month, day, hour, minute, 0, 0, zone).toInstant().toString()

    /** Real-shaped rows: the server's id differs from the client_msg_id the lists key by (§10.3). */
    private fun row(seq: Int, sender: String = "alice", parentId: String? = null) = MessageState(
        id = "id-$seq", channelId = "c", senderId = sender, seq = seq, updatedSeq = seq, clientMsgId = "cmid-$seq", body = "m$seq",
        createdAt = iso(2026, 9, 28, 10, 23), parentId = parentId,
    )

    /** Caught up (synced = last) unless the vector says otherwise. */
    private fun channel(lastRead: Int, unread: Int, oldest: Int?, last: Int = 3000, synced: Int? = last) = ChannelState(
        ChannelOut(id = "c", type = "public", name = "general", createdBy = "alice", createdAt = "", updatedAt = "", lastSeq = last, archived = false),
        isMember = true, syncedSeq = synced, lastSeq = last, lastReadSeq = lastRead, unreadCount = unread, oldestLoadedSeq = oldest,
    )

    private fun ids(rows: List<MessageState>) = rows.mapTo(HashSet()) { it.id }

    @Test fun v18_v19_bannerCountIsGroupedWithAsciiCommasInAnyLocale() {
        val saved = Locale.getDefault()
        try {
            Locale.setDefault(Locale.GERMANY) // '.' groups there; the banner must not follow it
            assertEquals("未読 300 件", Timeline.bannerText(300, null, now))
            assertEquals("未読 12 件", Timeline.bannerText(12, null, now))
            assertEquals("未読 999 件", Timeline.bannerText(999, null, now))
            assertEquals("未読 1,234 件", Timeline.bannerText(1234, null, now))
            assertEquals("未読 1,000,000 件", Timeline.bannerText(1_000_000, null, now))
        } finally {
            Locale.setDefault(saved)
        }
    }

    @Test fun v20_sinceLabelIsRelativeToTodayAndAlwaysTwentyFourHour() {
        val saved = Locale.getDefault()
        try {
            Locale.setDefault(Locale.US) // no "AM/PM", never locale-formatted
            assertEquals("10:23", Timeline.sinceLabel(iso(2026, 9, 28, 10, 23), now))
            assertEquals("昨日 23:05", Timeline.sinceLabel(iso(2026, 9, 27, 23, 5), now))
            assertEquals("9月26日 (土) 09:07", Timeline.sinceLabel(iso(2026, 9, 26, 9, 7), now))
            assertEquals("2025年12月31日 (水) 10:23", Timeline.sinceLabel(iso(2025, 12, 31, 10, 23), now))
            assertEquals("未読 2,000 件 · 10:23 以降", Timeline.bannerText(2000, iso(2026, 9, 28, 10, 23), now))
            assertEquals("未読 5 件", Timeline.bannerText(5, "not a time", now))
        } finally {
            Locale.setDefault(saved)
        }
    }

    @Test fun v21_jumpButtonOnlyUpToFiveHundredUnlessTheRangeIsReady() {
        assertTrue(ReadGate.jumpButtonShown(false, 500))
        assertFalse(ReadGate.jumpButtonShown(false, 501))
        assertTrue(ReadGate.jumpButtonShown(true, 501))
    }

    @Test fun v22_coversMeansEveryRowAfterTheMarkIsHeld() {
        assertTrue(ReadGate.covers(0, 5))
        assertFalse(ReadGate.covers(null, 5))
        assertTrue(ReadGate.covers(6, 5))
        assertFalse(ReadGate.covers(7, 5))
    }

    @Test fun v23_dividerOnlyWhereTheLoadedRangeReaches() {
        assertNull(ReadGate.dividerMark(null, 1000, 2951))
        assertEquals(1000, ReadGate.dividerMark(null, 1000, 851))
        assertEquals(109, ReadGate.dividerMark(109, null, 81))
        assertNull(ReadGate.dividerMark(null, null, 0))
    }

    @Test fun readRangeReadyAndAnchoring() {
        assertTrue(ReadGate.readRangeReady(channel(lastRead = 100, unread = 0, oldest = null))) // nothing unread
        assertTrue(ReadGate.readRangeReady(channel(lastRead = 100, unread = 30, oldest = 81)))
        assertFalse(ReadGate.readRangeReady(channel(lastRead = 1000, unread = 2000, oldest = 2951)))
        val first = row(101)
        assertTrue(ReadGate.nextAnchored(false, 0, false, first, emptyList()))
        assertFalse(ReadGate.nextAnchored(true, 5, false, first, listOf(first))) // the range stopped being ready
        assertTrue(ReadGate.nextAnchored(true, 5, true, first, emptyList()))
        assertTrue(ReadGate.nextAnchored(true, 5, true, first, listOf(row(95)))) // still below the reader: reading on
        assertFalse(ReadGate.nextAnchored(false, 5, true, first, listOf(row(120))))
        assertTrue(ReadGate.nextAnchored(false, 5, true, first, listOf(first)))
        assertTrue(ReadGate.nextAnchored(false, 5, true, null, emptyList()))
        assertEquals(row(103), ReadGate.firstUnreadRow(listOf(row(101, bob), row(102, bob), row(103)), 100, bob)) // own rows are skipped
    }

    @Test fun v1_openAtTheFirstUnreadWithTheDividerAtTheTop() {
        val rows = (81..130).map { row(it) }
        val mark = ReadGate.dividerMark(null, 100, 81)
        val items = Timeline.build(rows, mark, bob, now.toLocalDate(), zone).asReversed()
        val at = Timeline.openPosition(items, rows, null, mark, bob) as OpenPosition.Top
        assertTrue(items[at.index] is TimelineItem.UnreadSeparator)
        assertEquals(101, (items[at.index - 1] as TimelineItem.Message).message.seq)
        val state = channel(lastRead = 100, unread = 30, oldest = 81)
        assertEquals(ReadGate.ReadStep(true, 115), ReadGate.visibleRead(true, state, rows, bob, rows.filter { it.seq!! in 101..115 }))
        assertFalse(ReadGate.bannerShown(false, positioned = true, unreadCount = 30, anchored = true, held = false))
    }

    /** 「新着 N 件」 goes to the first of the N rows (its divider above it), then, once it is on screen, to the newest row. */
    @Test fun newRowsTargetIsTheFirstNewRowThenTheNewest() {
        val rows = (81..130).map { row(it) } + row(131, bob)
        val items = Timeline.build(rows, 100, bob, now.toLocalDate(), zone).asReversed()
        // Below the viewport (the reader is on 85..95): the first new row, 101, at the top with its divider.
        val target = Timeline.newRowsTarget(items, rows, 100, bob, ids(rows.filter { it.seq!! in 85..95 }))
        assertTrue(items[target] is TimelineItem.UnreadSeparator)
        assertEquals(101, (items[target - 1] as TimelineItem.Message).message.seq)
        assertEquals(0, Timeline.newRowsTarget(items, rows, 100, bob, setOf("id-101"))) // on screen: on to the newest
        assertEquals(0, Timeline.newRowsTarget(items, rows, 100, bob, ids(rows.filter { it.seq!! in 95..105 }))) // partly on screen too
        val plain = Timeline.build(rows + row(132), null, bob, now.toLocalDate(), zone).asReversed()
        assertEquals(132, (plain[Timeline.newRowsTarget(plain, rows + row(132), 130, bob, emptySet())] as TimelineItem.Message).message.seq)
        assertEquals(0, Timeline.newRowsTarget(plain, rows + row(132), 132, bob, emptySet())) // nothing new (my 131 is not)
    }

    /**
     * seenSeq advances only at the bottom: a reader who scrolled up to the divider and read on past the first new row
     * still has it counted. Pressing then must not go back up to it (it was 「新着 30 件」 scrolling backwards): the
     * target is the first new row below the rows on screen, or the newest row when they are the newest.
     */
    @Test fun newRowsTargetNeverGoesBackToNewRowsAlreadyPassed() {
        val rows = (81..130).map { row(it) } + row(131, bob)
        val items = Timeline.build(rows, 100, bob, now.toLocalDate(), zone).asReversed()
        // The reader passed 101..109 and is on 110..120 (none of them is the first new row, which is above): 121 at the top.
        val onScreen = ids(rows.filter { it.seq!! in 110..120 })
        val target = Timeline.newRowsTarget(items, rows, 100, bob, onScreen)
        assertEquals(121, (items[target] as TimelineItem.Message).message.seq)
        assertTrue(items[target + 1] !is TimelineItem.UnreadSeparator) // the divider stays with 101
        // My own row below the viewport is not a target: the newest row.
        assertEquals(0, Timeline.newRowsTarget(items, rows, 100, bob, ids(rows.filter { it.seq!! in 125..130 })))
        // Without rows on screen (nothing laid out yet) the first new row is the target, as before.
        assertTrue(items[Timeline.newRowsTarget(items, rows, 100, bob, emptySet())] is TimelineItem.UnreadSeparator)
    }

    @Test fun v2_notCoveredOpensAtTheBottomWithoutDividerAndOnlyTheReadButton() {
        val rows = (2951..3000).map { row(it) }
        val state = channel(lastRead = 1000, unread = 2000, oldest = 2951)
        val mark = ReadGate.dividerMark(null, 1000, state.oldestLoadedSeq)
        assertNull(mark)
        val items = Timeline.build(rows, mark, bob, now.toLocalDate(), zone).asReversed()
        assertTrue(items.none { it is TimelineItem.UnreadSeparator })
        assertEquals(OpenPosition.Bottom, Timeline.openPosition(items, rows, null, mark, bob))
        assertEquals(ReadGate.ReadStep(false, null), ReadGate.visibleRead(false, state, rows, bob, rows.filter { it.seq!! >= 2980 }))
        assertTrue(ReadGate.bannerShown(false, positioned = true, unreadCount = 2000, anchored = false, held = false))
        assertFalse(ReadGate.jumpButtonShown(ReadGate.readRangeReady(state), 2000))
        assertEquals("未読 2,000 件 · 10:23 以降", Timeline.bannerText(state.unreadCount, iso(2026, 9, 28, 10, 23), now))
    }

    @Test fun v11_aSetFromAnotherDeviceDropsTheAnchorAndThatLookSendsNothing() { // V11 (corrected)
        val rows = (81..1130).map { row(it) }
        val read = channel(lastRead = 1130, unread = 0, oldest = 81, last = 1130)
        val bottom = rows.filter { it.seq!! in 1116..1130 }
        var anchor = ReadAnchor.opened(read, null).observe(read, null, rows, bob, bottom, ids(bottom)).anchor
        assertTrue(anchor.anchored)
        val set = channel(lastRead = 500, unread = 630, oldest = 81, last = 1130) // read.updated (set) from another device
        assertTrue(ReadGate.readRangeReady(set)) // covered: the range is still ready, but the position went down
        val lowered = anchor.observe(set, null, rows, bob, bottom, ids(bottom))
        assertEquals(ReadAnchor.Step(ReadAnchor(anchored = false, readSeq = 500, quiet = ids(bottom)), null), lowered)
        anchor = lowered.anchor
        // 501 above the screen: the next look keeps it dropped, and the banner shows both buttons.
        val next = anchor.observe(set, null, rows, bob, bottom, ids(bottom))
        assertEquals(false to null, next.anchor.anchored to next.markSeq)
        assertTrue(ReadGate.bannerShown(false, positioned = true, unreadCount = 630, anchored = false, held = false))
        assertTrue(ReadGate.jumpButtonShown(ReadGate.readRangeReady(set), 630))
        // 501 on screen: the next look (a scroll) anchors and reads the visible rows.
        val around = rows.filter { it.seq!! in 495..510 }
        assertEquals(true to 510, next.anchor.observe(set, null, rows, bob, around, ids(around)).let { it.anchor.anchored to it.markSeq })
    }

    @Test fun v32_theRangeIsReadyOnlyOnceItIsCaughtUpToo() {
        assertFalse(ReadGate.readRangeReady(channel(lastRead = 130, unread = 300, oldest = 81, last = 430, synced = 130)))
        assertTrue(ReadGate.readRangeReady(channel(lastRead = 130, unread = 300, oldest = 81, last = 430, synced = 430)))
        assertTrue(ReadGate.readRangeReady(channel(lastRead = 430, unread = 0, oldest = 81, last = 430, synced = 130)))
        assertFalse(ReadGate.readRangeReady(channel(lastRead = 130, unread = 300, oldest = 81, last = 430, synced = null)))
        assertFalse(ReadGate.caughtUp(channel(lastRead = 130, unread = 300, oldest = 81, last = 430, synced = 130)))
    }

    @Test fun v33_catchingUpNeitherAnchorsNorShowsTheBanner() {
        val rows = (81..130).map { row(it) }
        val behind = channel(lastRead = 130, unread = 300, oldest = 81, last = 430, synced = 130) // bootstrap, no delta yet
        val bottom = rows.filter { it.seq!! in 116..130 }
        val anchor = ReadAnchor(anchored = true, readSeq = 130)
        assertEquals(ReadAnchor.Step(anchor.copy(anchored = false), null), anchor.observe(behind, null, rows, bob, bottom, ids(bottom)))
        assertFalse(ReadGate.markUnreadOffered(behind, 425)) // forward would read rows the catch-up has not brought
        for (status in listOf(EngineStatus.CONNECTING, EngineStatus.ONLINE)) {
            assertTrue(ReadGate.awaitingFirstUnread(status, behind, rows, bob))
            assertFalse(ReadGate.bannerShown(false, true, 300, anchored = false, held = false, awaitingFirstUnread = ReadGate.awaitingFirstUnread(status, behind, rows, bob)))
        }
        // Offline no catch-up is coming: the banner shows. Once the first unread row is held it shows too.
        assertFalse(ReadGate.awaitingFirstUnread(EngineStatus.OFFLINE, behind, rows, bob))
        assertFalse(ReadGate.awaitingFirstUnread(EngineStatus.ONLINE, behind, rows + row(131), bob))
        assertFalse(ReadGate.awaitingFirstUnread(EngineStatus.ONLINE, channel(lastRead = 130, unread = 300, oldest = 81, last = 430), rows, bob))
    }

    @Test fun v34_theFirstUnreadRowPassedUnseenDropsTheAnchor() {
        val rows = (81..430).map { row(it) }
        val state = channel(lastRead = 130, unread = 300, oldest = 81, last = 430)
        val bottom = rows.filter { it.seq!! in 416..430 } // the list followed the delta to the bottom
        val anchor = ReadAnchor(anchored = true, readSeq = 130)
        assertEquals(ReadAnchor.Step(anchor.copy(anchored = false), null), anchor.observe(state, null, rows, bob, bottom, ids(bottom)))
        assertTrue(ReadGate.bannerShown(false, true, 300, anchored = false, held = false))
        assertTrue(ReadGate.jumpButtonShown(ReadGate.readRangeReady(state), 300))
        // Partly on screen, 131 was seen: reading down keeps the anchor.
        val reading = rows.filter { it.seq!! in 132..146 }
        assertEquals(ReadAnchor.Step(anchor, 146), anchor.observe(state, null, rows, bob, reading, ids(reading) + "id-131"))
        // No visible row (nothing on screen yet): not judged.
        assertEquals(ReadAnchor.Step(anchor, null), anchor.observe(state, null, rows, bob, emptyList(), emptySet()))
        assertTrue(ReadGate.passedUnseen(row(131), bottom, ids(bottom)))
        assertFalse(ReadGate.passedUnseen(row(131), emptyList(), emptySet()))
        assertFalse(ReadGate.passedUnseen(row(450), bottom, ids(bottom))) // below the screen: not passed yet
    }

    @Test fun v36_aSetWhileTheFirstUnreadIsOnScreenSendsNothingUntilTheViewChanges() {
        val rows = (81..1130).map { row(it) }
        val around = rows.filter { it.seq!! in 495..510 } // scrolled back up after reading to 1100
        val onScreen = ids(around) + "id-494" + "id-511" // and the rows cut at both edges
        val anchor = ReadAnchor(anchored = true, readSeq = 1100)
        val set = channel(lastRead = 500, unread = 630, oldest = 81, last = 1130)
        val lowered = anchor.observe(set, null, rows, bob, around, onScreen)
        assertEquals(false to null, lowered.anchor.anchored to lowered.markSeq) // 501 is on screen, still nothing
        assertTrue(ReadGate.bannerShown(false, true, 630, lowered.anchor.anchored, held = false))
        // The banner the drop brings shrinks the list (its top rows are cut), and the remeasure is a new look: the rows
        // were all on screen before the set, so they neither anchor nor read. The same rows again: nothing either.
        val clipped = rows.filter { it.seq!! in 497..510 }
        var next = lowered.anchor.observe(set, null, rows, bob, clipped, ids(clipped) + "id-496" + "id-511")
        assertEquals(false to null, next.anchor.anchored to next.markSeq)
        next = next.anchor.observe(set, null, rows, bob, around, onScreen)
        assertEquals(false to null, next.anchor.anchored to next.markSeq)
        // A scroll that brings a row that was not on screen then: anchored (501 is shown), the visible rows read.
        val scrolled = rows.filter { it.seq!! in 490..505 }
        next = next.anchor.observe(set, null, rows, bob, scrolled, ids(scrolled))
        assertEquals(true to 505, next.anchor.anchored to next.markSeq)
        assertNull(next.anchor.quiet)
        // Back from the background or the connection lost (the view resumes), or 「最初の未読へ」 landing: marking as usual.
        assertEquals(true to 510, lowered.anchor.resumed().observe(set, null, rows, bob, around, onScreen).let { it.anchor.anchored to it.markSeq })
        assertEquals(true to 510, lowered.anchor.startLanding().landed().observe(set, null, rows, bob, around, onScreen).let { it.anchor.anchored to it.markSeq })
        // A lowering with nothing unread left protects nothing: that look still sends nothing, the next one reads.
        val none = channel(lastRead = 500, unread = 0, oldest = 81, last = 1130)
        val empty = anchor.observe(none, null, rows, bob, around, onScreen)
        assertEquals(ReadAnchor.Step(ReadAnchor(anchored = false, readSeq = 500), null), empty)
        assertEquals(true to 510, empty.anchor.observe(none, null, rows, bob, around, onScreen).let { it.anchor.anchored to it.markSeq })
    }

    @Test fun v37_aHoldThatEndsWithoutAReadDropsTheAnchor() {
        val rows = (81..130).map { row(it) }
        val held = channel(lastRead = 109, unread = 21, oldest = 81, last = 130)
        val bottom = rows.filter { it.seq!! in 116..130 }
        val anchor = ReadAnchor(anchored = true, readSeq = 109, held = 109) // 「ここから未読にする」 on 110 (V13)
        val released = anchor.observe(held, null, rows, bob, bottom, ids(bottom)) // another conversation was opened
        assertEquals(false to null, released.anchor.anchored to released.markSeq)
        assertEquals(false to null, released.anchor.observe(held, null, rows, bob, bottom, ids(bottom)).let { it.anchor.anchored to it.markSeq })
        val shown = rows.filter { it.seq!! in 105..118 }
        assertEquals(true to 118, released.anchor.observe(held, null, rows, bob, shown, ids(shown)).let { it.anchor.anchored to it.markSeq })
        // A hold that ends with a read (「既読にする」, my own post) is not a lowering.
        val read = channel(lastRead = 130, unread = 0, oldest = 81, last = 130)
        assertEquals(true to 130, anchor.observe(read, null, rows, bob, bottom, ids(bottom)).let { it.anchor.anchored to it.markSeq })
    }

    @Test fun v38_markUnreadForwardOnlyWhenTheRangeIsReady() {
        assertFalse(ReadGate.markUnreadOffered(channel(lastRead = 1000, unread = 2000, oldest = 2951), 2990))
        assertTrue(ReadGate.markUnreadOffered(channel(lastRead = 115, unread = 15, oldest = 81, last = 130), 125))
        assertFalse(ReadGate.markUnreadOffered(channel(lastRead = 115, unread = 15, oldest = 81, last = 130, synced = 120), 125)) // catching up
        assertTrue(ReadGate.markUnreadOffered(channel(lastRead = 115, unread = 15, oldest = 81, last = 130, synced = 120), 110)) // backwards
    }

    @Test fun v39_nothingIsJudgedWhileTheJumpLands() {
        val rows = (851..1300).map { row(it) }
        val state = channel(lastRead = 1000, unread = 300, oldest = 851, last = 1300)
        val bottom = rows.filter { it.seq!! in 1286..1300 } // the viewport before the landing scroll
        val landing = ReadAnchor(readSeq = 1000).startLanding()
        assertEquals(ReadAnchor.Step(landing, null), landing.observe(state, null, rows, bob, bottom, ids(bottom)))
        assertFalse(ReadGate.bannerShown(false, true, 300, anchored = false, held = false, landing = true))
        val landed = landing.landed()
        val top = rows.filter { it.seq!! in 1001..1012 }
        assertEquals(ReadAnchor.Step(landed, 1012), landed.observe(state, null, rows, bob, top, ids(top)))
        assertEquals(300, ReadGate.newBelow(rows, seenSeq = 1000, meId = bob)) // 「新着 300 件」
        // A landing that ended elsewhere (the row above the screen) is caught by the next look.
        assertEquals(false to null, landed.observe(state, null, rows, bob, bottom, ids(bottom)).let { it.anchor.anchored to it.markSeq })
    }

    @Test fun v40_seenSeqWaitsForThePositioning() {
        val rows = (81..130).map { row(it) }
        assertEquals(100, ReadGate.nextSeenSeq(100, settled = false, atBottom = true, newestSeq = 130)) // the list starts at the bottom
        assertEquals(30, ReadGate.newBelow(rows, 100, bob))
        assertEquals(100, ReadGate.nextSeenSeq(100, settled = true, atBottom = false, newestSeq = 130)) // landed at the divider
        assertEquals(130, ReadGate.nextSeenSeq(100, settled = true, atBottom = true, newestSeq = 130)) // read down to the bottom
        assertEquals(0, ReadGate.newBelow(rows + row(131, bob), 130, bob)) // my own rows are never 「新着」
    }

    @Test fun v48_leavingTheSearchViewOpensLikeAFreshOpen() {
        val rows = (81..130).map { row(it) }
        val state = channel(lastRead = 100, unread = 30, oldest = 81, last = 130)
        val mark = ReadGate.openMark(state)
        assertEquals(100, mark)
        val items = Timeline.build(rows, ReadGate.dividerMark(null, mark, state.oldestLoadedSeq), bob, now.toLocalDate(), zone).asReversed()
        val at = Timeline.openPosition(items, rows, null, mark, bob) as OpenPosition.Top // not a forced bottom
        assertTrue(items[at.index] is TimelineItem.UnreadSeparator)
        assertEquals(101, (items[at.index - 1] as TimelineItem.Message).message.seq)
        assertNull(ReadGate.openMark(channel(lastRead = 130, unread = 0, oldest = 81, last = 130)))
        assertEquals(ReadAnchor(readSeq = 100), ReadAnchor.opened(state, null)) // the anchor starts over too
    }

    @Test fun v51_aThreadDropsItsAnchorWhenNewRepliesArePassedUnseen() {
        val replies = (501..540).map { row(it, parentId = "id-500") }
        val first = ReadGate.firstUnreadRow(replies, 530, bob) // read to the bottom before reconnecting
        assertEquals(531, first?.seq)
        val bottom = replies.filter { it.seq!! in 533..540 } // the list followed ten new replies to the bottom
        assertFalse(ReadGate.nextThreadAnchored(true, true, first, bottom, ids(bottom)))
        assertTrue(ReadGate.nextThreadAnchored(true, true, first, bottom, ids(bottom) + "id-532" + "id-531")) // partly on screen
        assertTrue(ReadGate.nextThreadAnchored(true, true, first, emptyList(), emptySet())) // nothing shown: not judged
    }

    @Test fun v52_aThreadFloorKeepsTheAnchor() {
        val replies = (501..530).map { row(it, parentId = "id-500") }
        val shown = replies.filter { it.seq!! in 511..518 }
        // With the floor (518) the next unread reply is below the screen; lowered to 510 it would be 511, passed unseen
        // once the reader scrolls on.
        assertTrue(ReadGate.nextThreadAnchored(true, true, ReadGate.firstUnreadRow(replies, 518, bob), shown))
        val scrolled = replies.filter { it.seq!! in 515..522 }
        assertFalse(ReadGate.nextThreadAnchored(true, true, ReadGate.firstUnreadRow(replies, 510, bob), scrolled))
        assertTrue(ReadGate.nextThreadAnchored(true, true, ReadGate.firstUnreadRow(replies, 518, bob), scrolled))
    }

    @Test fun v13_v17_noBannerWhileHeldOrOverASearchPosition() {
        assertFalse(ReadGate.bannerShown(false, positioned = true, unreadCount = 21, anchored = false, held = true))
        assertFalse(ReadGate.bannerShown(true, positioned = true, unreadCount = 300, anchored = false, held = false))
        assertFalse(ReadGate.bannerShown(false, positioned = false, unreadCount = 300, anchored = false, held = false))
    }

    @Test fun v17_v30_searchHitAndFirstUnreadAreFoundThroughTheMessageNotTheRowKey() { // §10.3 regression
        val rows = (81..130).map { row(it) }
        val items = Timeline.build(rows, 100, bob, now.toLocalDate(), zone).asReversed()
        // The bug: keys are rowKeys (client_msg_id), so comparing them with a message id never matched and the
        // view opened at index 0, the newest row.
        assertEquals(-1, items.indexOfFirst { it.key == "id-101" })
        val top = Timeline.openPosition(items, rows, null, 100, bob) as OpenPosition.Top
        assertTrue(top.index > 0)
        assertEquals("id-101", (items[top.index - 1] as TimelineItem.Message).message.id)

        // A search hit (focus view: no divider) is centred on its own row.
        val focusItems = Timeline.build(rows, null, bob, now.toLocalDate(), zone).asReversed()
        val hit = Timeline.openPosition(focusItems, rows, "id-120", null, bob) as OpenPosition.Center
        assertEquals("id-120", (focusItems[hit.index] as TimelineItem.Message).message.id)
        // Unknown: the bottom (index 0), never a silent -1.
        assertEquals(OpenPosition.Bottom, Timeline.openPosition(focusItems, rows, "missing", null, bob))
    }

    @Test fun v24_v26_v30_threadRowsResolveByIndexAndOpenAtTheFirstUnreadReply() { // §10.3 regression (thread)
        val replies = (501..530).map { row(it, parentId = "id-500") }
        val header = ThreadRows.header(hasParent = true)
        // Items are keyed by rowKey; the old lookup compared them with ids and found no reply at all.
        val keys = listOf("parent", "divider") + replies.map { it.rowKey }
        assertTrue(keys.none { key -> replies.any { it.id == key } })
        assertEquals((501..530).toList(), keys.indices.mapNotNull { ThreadRows.replyAt(replies, header, it)?.seq })
        assertNull(ThreadRows.replyAt(replies, header, 1))

        // V24: once complete, 「新しい返信」 and r11 at the top; before that only the held rows at the bottom.
        val top = ThreadRows.openPosition(replies, header, null, 510, bob) as OpenPosition.Top
        assertEquals(511, ThreadRows.replyAt(replies, header, top.index)?.seq)
        assertEquals(OpenPosition.Bottom, ThreadRows.openPosition(replies.takeLast(2), header, null, null, bob))
        val first = ReadGate.firstUnreadRow(replies, 510, bob)
        assertFalse(ReadGate.nextThreadAnchored(false, false, first, replies)) // not complete: never
        val shown = (top.index until top.index + 8).mapNotNull { ThreadRows.replyAt(replies, header, it) }
        assertTrue(ReadGate.nextThreadAnchored(false, true, first, shown))
        assertEquals(518, shown.maxOf { it.seq!! })
        assertFalse(ReadGate.nextThreadAnchored(false, true, first, replies.filter { it.seq!! >= 529 }))

        // A thread never read (no follow row: 0) opens at the first reply from someone else (§10.2).
        val mine = listOf(row(501, bob, parentId = "id-500")) + replies.drop(1)
        assertEquals(502, ThreadRows.replyAt(mine, header, (ThreadRows.openPosition(mine, header, null, 0, bob) as OpenPosition.Top).index)?.seq)

        // V26: nothing unread: the bottom, anchored at once. A focus reply is centred.
        assertEquals(OpenPosition.Bottom, ThreadRows.openPosition(replies, header, null, 530, bob))
        assertTrue(ReadGate.nextThreadAnchored(false, true, null, emptyList()))
        assertEquals(OpenPosition.Center(header + 4), ThreadRows.openPosition(replies, header, "id-505", 510, bob))
    }

    @Test fun markUnreadIsOfferedOnlyWhereItReadsNothingUnloaded() {
        val v2 = channel(lastRead = 1000, unread = 2000, oldest = 2951)
        assertFalse(ReadGate.markUnreadOffered(v2, 2990)) // would read 1001..2989, never loaded
        assertTrue(ReadGate.markUnreadOffered(v2, 1001)) // the position stays: nothing is read
        assertTrue(ReadGate.markUnreadOffered(v2, 500)) // backwards, e.g. from a search hit
        assertTrue(ReadGate.markUnreadOffered(channel(lastRead = 100, unread = 30, oldest = 81), 110)) // V13: every row held
        assertTrue(ReadGate.markUnreadOffered(channel(lastRead = 100, unread = 0, oldest = 111), 150)) // nothing unread
    }
}
