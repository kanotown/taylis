package jp.chikuwachat.android

import jp.chikuwachat.android.ui.Schedule
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.ZoneId
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZonedDateTime

class ScheduleTest {
    private val zone = ZoneId.of("Asia/Tokyo")
    private fun local(y: Int, m: Int, d: Int, h: Int, min: Int = 0) = ZonedDateTime.of(y, m, d, h, min, 0, 0, zone)

    @Test fun pickerKeepsTheCalendarDayAndUsesTheDeviceZoneForTime() {
        val date = LocalDate.of(2026, 9, 30)
        assertEquals(date, Schedule.pickerDate(Schedule.pickerMillis(date)))
        assertEquals(Instant.parse("2026-09-30T00:15:00Z"), Schedule.atDateTime(date, LocalTime.of(9, 15), zone)?.toInstant())
        assertEquals(Instant.parse("2026-09-30T16:15:00Z"), Schedule.atDateTime(date, LocalTime.of(9, 15), ZoneId.of("America/Los_Angeles"))?.toInstant())
    }

    @Test fun nonexistentDstTimeIsRejectedAndRepeatedTimeUsesEarlierOffset() {
        val ny = ZoneId.of("America/New_York")
        assertNull(Schedule.atDateTime(LocalDate.of(2026, 3, 8), LocalTime.of(2, 30), ny))
        assertEquals(Instant.parse("2026-11-01T05:30:00Z"), Schedule.atDateTime(LocalDate.of(2026, 11, 1), LocalTime.of(1, 30), ny)?.toInstant())
    }

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

    @Test fun reminderPresetsAreALittleLaterOrNextMorning() {
        val now = local(2026, 10, 2, 19, 30)
        val presets = Schedule.reminderPresets(now)
        assertEquals(listOf("20m", "1h", "3h", "tomorrow9", "monday9"), presets.map { it.key })
        assertEquals(local(2026, 10, 2, 19, 50), presets[0].at)
        assertEquals(local(2026, 10, 3, 9), presets[3].at)
    }

    @Test fun aCustomReminderIsLabelledWithItsTime() {
        val now = local(2026, 10, 2, 19, 30)
        val custom = Schedule.customReminder(local(2026, 10, 7, 14, 15), now)
        assertEquals(Schedule.CUSTOM, custom.key)
        assertEquals("10月7日(水) 14:15", custom.label)
        assertEquals(local(2026, 10, 7, 14, 15), custom.at)
        assertEquals("明日 8:00", Schedule.customReminder(local(2026, 10, 3, 8), now).label)
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
