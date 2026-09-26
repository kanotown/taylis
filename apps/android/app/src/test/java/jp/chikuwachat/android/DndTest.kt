package jp.chikuwachat.android

import jp.chikuwachat.android.api.QuietHours
import jp.chikuwachat.android.api.UserPublic
import jp.chikuwachat.android.ui.Dnd
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.ZoneId
import java.time.ZonedDateTime

class DndTest {
    private fun at(iso: String): Instant = Instant.parse(iso)

    @Test fun quietHoursUseTheUsersZoneWithAnExclusiveEnd() {
        val lunch = QuietHours("12:00", "13:00", tz = "Asia/Tokyo")
        assertTrue(Dnd.inQuietHours(lunch, at("2026-09-28T03:30:00Z"))) // 12:30 in Tokyo
        assertFalse(Dnd.inQuietHours(lunch, at("2026-09-28T04:00:00Z")))
        assertFalse(Dnd.inQuietHours(lunch, at("2026-09-28T12:30:00Z")))
        assertFalse(Dnd.inQuietHours(QuietHours("12:00", "13:00", tz = "Mars/Olympus"), at("2026-09-28T03:30:00Z")))
    }

    @Test fun overnightWindowBelongsToTheDayItStartsOn() {
        val fridayNight = QuietHours("22:00", "07:00", listOf(4), "Asia/Tokyo")
        assertTrue(Dnd.inQuietHours(fridayNight, at("2026-10-02T14:00:00Z"))) // Fri 23:00 JST
        assertTrue(Dnd.inQuietHours(fridayNight, at("2026-10-02T21:30:00Z"))) // Sat 06:30 JST
        assertFalse(Dnd.inQuietHours(fridayNight, at("2026-10-03T14:00:00Z"))) // Sat 23:00 JST
        assertTrue(Dnd.inQuietHours(QuietHours("22:00", "07:00", tz = "Asia/Tokyo"), at("2026-09-27T17:00:00Z"))) // Mon 02:00 JST
    }

    @Test fun manualPauseAndLabels() {
        val base = UserPublic(id = "u", username = "u", displayName = "U", role = "member", createdAt = "", updatedAt = "")
        assertFalse(Dnd.isActive(base, at("2026-09-28T03:00:00Z")))
        val paused = base.copy(dndUntil = "2026-09-28T03:30:00Z")
        assertTrue(Dnd.isActive(paused, at("2026-09-28T03:00:00Z")))
        assertFalse(Dnd.isActive(paused, at("2026-09-28T03:31:00Z")))
        assertEquals("22:00〜07:00 (月火水木金)", Dnd.label(QuietHours("22:00", "07:00", listOf(0, 1, 2, 3, 4), "Asia/Tokyo")))
        assertEquals("22:00〜07:00", Dnd.label(QuietHours("22:00", "07:00", tz = "Asia/Tokyo")))
        val tomorrow = Instant.parse(Dnd.pauseUntil("tomorrow", ZonedDateTime.of(2026, 9, 28, 15, 0, 0, 0, ZoneId.of("Asia/Tokyo"))))
        assertEquals("2026-09-29T08:00", ZonedDateTime.ofInstant(tomorrow, ZoneId.of("Asia/Tokyo")).toLocalDateTime().toString())
    }
}
