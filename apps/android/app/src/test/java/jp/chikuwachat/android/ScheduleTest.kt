package jp.chikuwachat.android

import jp.chikuwachat.android.ui.Schedule
import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.ZoneId
import java.time.ZonedDateTime

class ScheduleTest {
    private val zone = ZoneId.of("Asia/Tokyo")
    private fun local(y: Int, m: Int, d: Int, h: Int, min: Int = 0) = ZonedDateTime.of(y, m, d, h, min, 0, 0, zone)

    @Test fun presetsAreInTheFutureAndNextMondayIsNeverToday() {
        val friday = local(2026, 10, 2, 19, 30)
        val presets = Schedule.presets(friday)
        assertEquals(listOf("1h", "tomorrow9", "monday9"), presets.map { it.key }) // 18:00 already passed
        assertEquals(local(2026, 10, 2, 20, 30), presets[0].at)
        assertEquals(local(2026, 10, 5, 9), presets[2].at)
        val monday = Schedule.presets(local(2026, 10, 5, 8))
        assertEquals(listOf("1h", "today18", "tomorrow9", "monday9"), monday.map { it.key })
        assertEquals(local(2026, 10, 12, 9), monday[3].at)
    }

    @Test fun labelsAreRelativeToToday() {
        val now = local(2026, 10, 2, 10)
        assertEquals("今日 18:00", Schedule.label(local(2026, 10, 2, 18), now))
        assertEquals("明日 9:05", Schedule.label(local(2026, 10, 3, 9, 5), now))
        assertEquals("10月5日(月) 9:00", Schedule.label(local(2026, 10, 5, 9), now))
        assertEquals("2027年1月4日(月) 9:00", Schedule.label(local(2027, 1, 4, 9), now))
        assertEquals("明日 9:00", Schedule.label("2026-10-03T00:00:00Z", zone, now))
    }
}
