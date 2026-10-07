package jp.chikuwachat.android

import jp.chikuwachat.android.api.ChannelOut
import jp.chikuwachat.android.sync.ChannelState
import jp.chikuwachat.android.sync.MessageState
import jp.chikuwachat.android.sync.ReadAnchor
import jp.chikuwachat.android.sync.ReadGate
import jp.chikuwachat.android.ui.ThreadRows
import jp.chikuwachat.android.ui.Timeline
import jp.chikuwachat.android.ui.TimelineItem
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate
import java.time.ZoneId

/**
 * A message from someone else arriving in an open conversation (tester, 2026-09-30: on iOS the list jolted and
 * 「新着メッセージ」 flashed). At the newest edge the list follows the row, which is read like any row on screen: no
 * divider, no banner, no 「新着 N 件」. Scrolled up, the reader stays put and gets 「新着 N 件」.
 */
class ArrivalTest {
    private val zone = ZoneId.of("Asia/Tokyo")
    private val today = LocalDate.of(2026, 9, 30)
    private val me = "me"

    private fun row(seq: Int, sender: String = "alice", at: String = "2026-09-30T01:00:00Z", parentId: String? = null) = MessageState(
        id = "id-$seq", channelId = "c", senderId = sender, seq = seq, updatedSeq = seq, clientMsgId = "cmid-$seq", body = "m$seq",
        createdAt = at, parentId = parentId,
    )

    private fun channel(lastRead: Int, unread: Int, last: Int) = ChannelState(
        ChannelOut(id = "c", type = "public", name = "general", createdBy = "alice", createdAt = "", updatedAt = "", lastSeq = last, archived = false),
        isMember = true, syncedSeq = last, lastSeq = last, lastReadSeq = lastRead, unreadCount = unread, oldestLoadedSeq = 1,
    )

    /** The channel's LazyColumn items: newest first. */
    private fun items(rows: List<MessageState>, mark: Int?) = Timeline.build(rows, mark, me, today = today, zone = zone).asReversed()

    private fun keys(items: List<TimelineItem>) = items.map { it.key }

    @Test fun theNewestEdgeIsTheFirstItemScrolledNoFurtherThanTheSlop() {
        assertTrue(Timeline.atNewestEdge(0, 0, 21))
        assertTrue(Timeline.atNewestEdge(0, 21, 21))
        assertFalse(Timeline.atNewestEdge(0, 22, 21))
        assertFalse(Timeline.atNewestEdge(1, 0, 21))
    }

    @Test fun onlyRowsAddedAtTheNewestEndCountAsArrivals() {
        val rows = (1..5).map { row(it) }
        val before = keys(items(rows, null))
        assertTrue(Timeline.arrivedAtNewest(before, keys(items(rows + row(6), null))))
        assertTrue(Timeline.arrivedAtNewest(before, keys(items(rows + row(6) + row(7), null))))
        // The first row of a new day brings its day separator too: the old newest row is two items further.
        assertTrue(Timeline.arrivedAtNewest(before, keys(items(rows + row(6, at = "2026-09-30T16:00:00Z"), null))))
        // An older page (the far end), an edit, the newest row deleted, another conversation or a reload: no arrival.
        assertFalse(Timeline.arrivedAtNewest(before, keys(items(listOf(row(0)) + rows, null))))
        assertFalse(Timeline.arrivedAtNewest(before, keys(items(rows, null))))
        assertFalse(Timeline.arrivedAtNewest(before, keys(items(rows.dropLast(1), null))))
        assertFalse(Timeline.arrivedAtNewest(before, keys(items((10..12).map { row(it) }, null))))
        assertFalse(Timeline.arrivedAtNewest(emptyList(), keys(items(rows, null))))
        assertFalse(Timeline.arrivedAtNewest(before, emptyList()))
    }

    @Test fun theListFollowsOnlyAtTheEdgeOnceSettled() {
        assertTrue(Timeline.followsArrival(atNewestEdge = true, arrived = true, positioned = true))
        assertFalse(Timeline.followsArrival(atNewestEdge = false, arrived = true, positioned = true)) // scrolled up
        assertFalse(Timeline.followsArrival(atNewestEdge = true, arrived = false, positioned = true))
        assertFalse(Timeline.followsArrival(atNewestEdge = true, arrived = true, positioned = false)) // the open positioning decides
        assertFalse(Timeline.followsArrival(atNewestEdge = true, arrived = true, positioned = true, landing = true))
        assertFalse(Timeline.followsArrival(atNewestEdge = true, arrived = true, positioned = true, focused = true))
    }

    @Test fun anArrivalAtTheEdgeIsReadWithoutDividerBannerOrNewPill() {
        // Opened with nothing unread: no divider captured, positioned at the bottom and anchored.
        val rows = (1..20).map { row(it, sender = if (it % 3 == 0) me else "alice") }
        val opened = channel(lastRead = 20, unread = 0, last = 20)
        val captured = ReadGate.openMark(opened)
        assertNull(captured)
        var anchor = ReadAnchor.opened(opened, null).observe(opened, null, rows, me, rows.takeLast(6), rows.takeLast(6).map { it.id }.toSet()).anchor
        assertTrue(anchor.anchored)
        var seenSeq = ReadGate.nextSeenSeq(opened.lastReadSeq, settled = true, atBottom = true, newestSeq = 20)

        // alice posts seq 21: the engine counts it before the view reads it.
        val after = rows + row(21)
        val arrived = channel(lastRead = 20, unread = 1, last = 21)
        val mark = ReadGate.dividerMark(null, captured, arrived.oldestLoadedSeq)
        assertNull(mark)
        assertTrue(items(after, mark).none { it is TimelineItem.UnreadSeparator })
        // The view followed, so the new row is among the visible ones.
        assertTrue(Timeline.followsArrival(Timeline.atNewestEdge(0, 0, 21), Timeline.arrivedAtNewest(keys(items(rows, null)), keys(items(after, mark))), positioned = true))
        assertFalse(ReadGate.bannerShown(false, true, arrived.unreadCount, anchor.anchored, held = false))
        val step = anchor.observe(arrived, null, after, me, after.takeLast(6), after.takeLast(6).map { it.id }.toSet())
        anchor = step.anchor
        assertTrue(anchor.anchored)
        assertEquals(21, step.markSeq)
        seenSeq = ReadGate.nextSeenSeq(seenSeq, settled = true, atBottom = true, newestSeq = 21)
        assertEquals(0, ReadGate.newBelow(after, seenSeq, me))
    }

    @Test fun anArrivalWhileScrolledUpIsCountedAsNew() {
        val rows = (1..20).map { row(it) }
        val after = rows + row(21) + row(22)
        assertFalse(Timeline.followsArrival(Timeline.atNewestEdge(8, 0, 21), Timeline.arrivedAtNewest(keys(items(rows, null)), keys(items(after, null))), positioned = true))
        // seenSeq stays where the reader left the bottom: 「新着 2 件」.
        val seenSeq = ReadGate.nextSeenSeq(20, settled = true, atBottom = false, newestSeq = 22)
        assertEquals(2, ReadGate.newBelow(after, seenSeq, me))
    }

    @Test fun theThreadDividerIsTakenWhenPositionedNotFromTheLiveReadPosition() {
        val replies = (11..14).map { row(it, sender = if (it == 12) me else "alice", parentId = "p") }
        // Everything read at the open: no divider for this open, whatever arrives later.
        assertNull(ThreadRows.dividerMark(replies, 14, me))
        // Unread from 13: the divider precedes 13 and stays there after it is read.
        assertEquals(12, ThreadRows.dividerMark(replies, 12, me))
        // Only my own reply after the position: nothing unread.
        assertNull(ThreadRows.dividerMark(replies.take(2), 11, me))
        assertNull(ThreadRows.dividerMark(replies, null, me))
    }

    // --- a thread (BACKLOG §5, 2026-10-02): laid out oldest first, the newest end is the bottom of the list ---

    @Test fun theThreadEndIsTheLastItemNoFurtherBelowThanTheSlop() {
        // 2 header items + 10 replies: the last index is 11; content ends at 1000 px.
        assertTrue(ThreadRows.atNewestEnd(11, 1000, 11, 1000, 21))
        assertTrue(ThreadRows.atNewestEnd(11, 1021, 11, 1000, 21))
        assertFalse(ThreadRows.atNewestEnd(11, 1022, 11, 1000, 21))
        assertFalse(ThreadRows.atNewestEnd(10, 980, 11, 1000, 21))
        assertFalse(ThreadRows.atNewestEnd(null, 0, 11, 1000, 21))
    }

    @Test fun aReaderUpInALongThreadGetsTheButtonToTheNewestReply() {
        // 2 header items + 60 replies: the last index is 61.
        assertFalse(ThreadRows.jumpShown(61, 61, atNewestEnd = true, unseenBelow = 0)) // at the end
        assertFalse(ThreadRows.jumpShown(59, 61, atNewestEnd = false, unseenBelow = 0)) // just above it
        assertTrue(ThreadRows.jumpShown(58, 61, atNewestEnd = false, unseenBelow = 0)) // reading older replies: 「最新の返信へ」
        assertTrue(ThreadRows.jumpShown(30, 61, atNewestEnd = false, unseenBelow = 0))
        assertTrue(ThreadRows.jumpShown(60, 61, atNewestEnd = false, unseenBelow = 1)) // a reply from someone else came below
        assertFalse(ThreadRows.jumpShown(61, 61, atNewestEnd = true, unseenBelow = 1))
        assertFalse(ThreadRows.jumpShown(null, 61, atNewestEnd = false, unseenBelow = 0)) // nothing laid out yet
    }

    @Test fun onlyRepliesAddedAtTheEndCountAsThreadArrivals() {
        val replies = (1..5).map { row(it, parentId = "p").rowKey }
        assertTrue(ThreadRows.arrivedAtEnd(replies, replies + "cmid-6"))
        assertTrue(ThreadRows.arrivedAtEnd(replies, replies + "cmid-6" + "cmid-7"))
        // The first reply of a thread that had none.
        assertTrue(ThreadRows.arrivedAtEnd(emptyList(), listOf("cmid-1")))
        // Older replies fetched above, an edit, the last reply deleted, another thread: no arrival.
        assertFalse(ThreadRows.arrivedAtEnd(replies, listOf("cmid-0") + replies))
        assertFalse(ThreadRows.arrivedAtEnd(replies, replies))
        assertFalse(ThreadRows.arrivedAtEnd(replies, replies.dropLast(1)))
        assertFalse(ThreadRows.arrivedAtEnd(replies, listOf("x-1", "x-2")))
        assertFalse(ThreadRows.arrivedAtEnd(emptyList(), emptyList()))
    }

    @Test fun theThreadFollowsAnArrivalOnlyAtTheEndOrForMyOwnSend() {
        // At the end: someone else's reply is followed.
        assertTrue(ThreadRows.followsArrival(atNewestEnd = true, arrived = true, settled = true, sentHere = false))
        // Scrolled up: the reader stays put (and gets 「新着 N 件」).
        assertFalse(ThreadRows.followsArrival(atNewestEnd = false, arrived = true, settled = true, sentHere = false))
        // My own reply sent from here always goes to the end, wherever the reader was.
        assertTrue(ThreadRows.followsArrival(atNewestEnd = false, arrived = true, settled = true, sentHere = true))
        // Nothing arrived, or the thread was not placed yet (the open positioning decides): no move.
        assertFalse(ThreadRows.followsArrival(atNewestEnd = true, arrived = false, settled = true, sentHere = false))
        assertFalse(ThreadRows.followsArrival(atNewestEnd = true, arrived = true, settled = false, sentHere = true))
    }

    @Test fun onlyMyPendingReplyOrMyPostFromHereCountsAsSentHere() {
        val pending = row(1, sender = me, parentId = "p").copy(seq = null, id = "local:cmid-x", pending = true)
        assertTrue(ThreadRows.sentHere(pending, me, null))
        // My poll posted through its own endpoint.
        assertTrue(ThreadRows.sentHere(row(7, sender = me, parentId = "p"), me, "id-7"))
        // My reply from another device arriving live, someone else's reply, nothing.
        assertFalse(ThreadRows.sentHere(row(7, sender = me, parentId = "p"), me, null))
        assertFalse(ThreadRows.sentHere(row(8, parentId = "p"), me, "id-8"))
        assertFalse(ThreadRows.sentHere(null, me, null))
    }

    @Test fun aThreadArrivalWhileScrolledUpIsCountedAsNew() {
        val replies = (1..10).map { row(it, parentId = "p") }
        val after = replies + row(11, parentId = "p") + row(12, sender = me, parentId = "p")
        val seenSeq = ReadGate.nextSeenSeq(10, settled = true, atBottom = false, newestSeq = 12)
        // My own reply is never 「新着」.
        assertEquals(1, ReadGate.newBelow(after, seenSeq, me))
        assertEquals(0, ReadGate.newBelow(after, ReadGate.nextSeenSeq(10, settled = true, atBottom = true, newestSeq = 12), me))
    }
}
