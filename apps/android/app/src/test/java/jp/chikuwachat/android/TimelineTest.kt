package jp.chikuwachat.android

import jp.chikuwachat.android.sync.MessageState
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
            firstUnreadAfterSeq = 3, meId = "me", today = today, zone = zone,
        )
        val shape = items.map {
            when (it) {
                is TimelineItem.DateSeparator -> "date"
                is TimelineItem.UnreadSeparator -> "unread"
                is TimelineItem.Message -> it.message.id + if (it.compact) "*" else ""
            }
        }
        assertEquals(listOf("date", "a", "b*", "c", "date", "unread", "d", "e*"), shape)
    }

    @Test
    fun initialsAndHueAreStable() {
        assertEquals("TK", Timeline.initials("Toru Kano"))
        assertEquals("か", Timeline.initials("かのう"))
        assertEquals("?", Timeline.initials("  "))
        assertEquals(Timeline.hue("user-1"), Timeline.hue("user-1"))
    }
}
