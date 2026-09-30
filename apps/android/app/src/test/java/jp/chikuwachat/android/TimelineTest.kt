package jp.chikuwachat.android

import jp.chikuwachat.android.sync.MessageState
import jp.chikuwachat.android.ui.ThreadRows
import jp.chikuwachat.android.ui.Timeline
import jp.chikuwachat.android.ui.TimelineItem
import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.LocalDate
import java.time.ZoneId

class TimelineTest {
    private val zone = ZoneId.of("Asia/Tokyo")
    private val today = LocalDate.of(2026, 9, 26)

    private fun message(id: String, sender: String, at: String, seq: Int) =
        MessageState(id = id, channelId = "c", senderId = sender, seq = seq, updatedSeq = seq, clientMsgId = null, body = id, createdAt = at)

    @Test
    fun dateLabelsAreRelativeToToday() {
        assertEquals("今日", Timeline.dateLabel(today, today))
        assertEquals("昨日", Timeline.dateLabel(today.minusDays(1), today))
        assertEquals("9月1日 (火)", Timeline.dateLabel(LocalDate.of(2026, 9, 1), today))
        assertEquals("2025年12月31日 (水)", Timeline.dateLabel(LocalDate.of(2025, 12, 31), today))
    }

    @Test
    fun groupsConsecutiveMessagesAndPlacesUnreadDividerOnce() {
        val items = Timeline.build(
            listOf(
                message("a", "u1", "2026-09-25T01:00:00Z", 1),
                message("b", "u1", "2026-09-25T01:02:00Z", 2),
                message("c", "u1", "2026-09-25T01:20:00Z", 3),
                message("d", "u2", "2026-09-26T00:00:00Z", 4),
                message("e", "u2", "2026-09-26T00:01:00Z", 5),
            ),
            firstUnreadAfterSeq = 3, meId = "me", today = today, zone = zone, grouping = true,
        )
        assertEquals(listOf("date", "a", "b*", "c", "date", "unread", "d", "e*"), shape(items))
    }

    private fun shape(items: List<TimelineItem>) = items.map {
        when (it) {
            is TimelineItem.DateSeparator -> "date"
            is TimelineItem.UnreadSeparator -> "unread"
            is TimelineItem.Message -> it.message.id + if (it.compact) "*" else ""
        }
    }

    // --- M47 「連続した投稿をまとめる」 ---

    private val burst = listOf(
        message("a", "u1", "2026-09-26T01:00:00Z", 1),
        message("b", "u1", "2026-09-26T01:01:00Z", 2),
        message("c", "u1", "2026-09-26T01:02:00Z", 3),
        message("d", "u2", "2026-09-26T01:03:00Z", 4),
        message("e", "u2", "2026-09-26T01:04:00Z", 5),
    )

    @Test
    fun offEveryMessageHasItsOwnHeader() {
        val items = Timeline.build(burst, firstUnreadAfterSeq = null, meId = "me", today = today, zone = zone)
        assertEquals(listOf("date", "a", "b", "c", "d", "e"), shape(items)) // off is the default
        val divided = Timeline.build(burst, firstUnreadAfterSeq = 1, meId = "me", today = today, zone = zone, grouping = false)
        assertEquals(listOf("date", "a", "unread", "b", "c", "d", "e"), shape(divided)) // the divider and days stay
    }

    @Test
    fun onTheDividerRepliesAndSystemRowsBreakAGroup() {
        val rows = listOf(
            message("a", "u1", "2026-09-26T01:00:00Z", 1),
            message("b", "u1", "2026-09-26T01:01:00Z", 2),
            message("c", "u1", "2026-09-26T01:02:00Z", 3).copy(parentId = "a", alsoInChannel = true),
            message("d", "u1", "2026-09-26T01:03:00Z", 4),
            message("e", "u1", "2026-09-26T01:04:00Z", 5).copy(type = "system"),
            message("f", "u1", "2026-09-26T01:05:00Z", 6),
            message("g", "u1", "2026-09-26T01:06:00Z", 7),
        )
        val items = Timeline.build(rows, firstUnreadAfterSeq = 1, meId = "me", today = today, zone = zone, grouping = true)
        assertEquals(listOf("date", "a", "unread", "b", "c", "d", "e", "f", "g*"), shape(items))
    }

    @Test
    fun threadRepliesGroupOnlyWhenOn() {
        val replies = burst.map { it.copy(parentId = "p") }
        val on = ThreadRows.compactKeys(replies, firstUnreadId = null, grouping = true, zone = zone)
        assertEquals(setOf("b", "c", "e"), on)
        assertEquals(emptySet<String>(), ThreadRows.compactKeys(replies, firstUnreadId = null, grouping = false, zone = zone))
        // 「新しい返信」 above c starts a new group, as the 「新着メッセージ」 divider does in the channel.
        assertEquals(setOf("b", "e"), ThreadRows.compactKeys(replies, firstUnreadId = "c", grouping = true, zone = zone))
    }

    @Test
    fun theWindowAndTheDayBreakAThreadGroup() {
        val replies = listOf(
            message("a", "u1", "2026-09-25T14:57:00Z", 1),
            message("b", "u1", "2026-09-25T14:58:00Z", 2), // 23:58 in Tokyo
            message("c", "u1", "2026-09-25T15:01:00Z", 3), // 00:01 the next day, three minutes later
            message("d", "u1", "2026-09-25T15:07:00Z", 4), // six minutes later
        ).map { it.copy(parentId = "p") }
        assertEquals(setOf("b"), ThreadRows.compactKeys(replies, firstUnreadId = null, grouping = true, zone = zone))
    }

    @Test
    fun initialsAndHueAreStable() {
        assertEquals("TK", Timeline.initials("Toru Kano"))
        assertEquals("か", Timeline.initials("かのう"))
        assertEquals("?", Timeline.initials("  "))
        assertEquals(Timeline.hue("user-1"), Timeline.hue("user-1"))
    }
}
