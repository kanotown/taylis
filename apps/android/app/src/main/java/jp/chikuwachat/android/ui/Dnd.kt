package jp.chikuwachat.android.ui

import jp.chikuwachat.android.api.QuietHours
import jp.chikuwachat.android.api.UserPublic
import java.time.Instant
import java.time.ZoneId
import java.time.ZonedDateTime

/**
 * Do not disturb (M12c): a manual pause or the daily quiet hours, evaluated in the user's own zone.
 * Same rule as the server: an overnight window belongs to the day it starts on.
 */
object Dnd {
    val DAY_LABELS = listOf("月", "火", "水", "木", "金", "土", "日")
    val PAUSE_OPTIONS = listOf("30m" to "30 分", "1h" to "1 時間", "2h" to "2 時間", "tomorrow" to "明日 8:00 まで")

    fun minutes(hhmm: String): Int {
        val parts = hhmm.split(":").mapNotNull { it.toIntOrNull() }
        return if (parts.size == 2) parts[0] * 60 + parts[1] else 0
    }

    fun hhmm(minutes: Int): String = "%02d:%02d".format(minutes / 60, minutes % 60)

    fun inQuietHours(hours: QuietHours, now: Instant = Instant.now()): Boolean {
        val start = minutes(hours.start)
        val end = minutes(hours.end)
        if (start == end) return false
        val zone = runCatching { ZoneId.of(hours.tz) }.getOrNull() ?: return false
        val local = ZonedDateTime.ofInstant(now, zone)
        val weekday = local.dayOfWeek.value - 1 // 0 = Monday
        val minutes = local.hour * 60 + local.minute
        val days = (hours.days.ifEmpty { (0..6).toList() }).toSet()
        if (start < end) return minutes in start until end && weekday in days
        if (minutes >= start) return weekday in days
        return minutes < end && ((weekday + 6) % 7) in days
    }

    fun isActive(user: UserPublic?, now: Instant = Instant.now()): Boolean {
        if (user == null) return false
        val until = user.dndUntil?.let { runCatching { Instant.parse(it) }.getOrNull() }
        if (until != null && until.isAfter(now)) return true
        return user.quietHours?.let { inQuietHours(it, now) } ?: false
    }

    /** ISO time a pause chosen from PAUSE_OPTIONS ends. */
    fun pauseUntil(choice: String, now: ZonedDateTime = ZonedDateTime.now()): String = when (choice) {
        "30m" -> now.plusMinutes(30)
        "1h" -> now.plusHours(1)
        "2h" -> now.plusHours(2)
        else -> now.plusDays(1).withHour(8).withMinute(0).withSecond(0).withNano(0)
    }.toInstant().toString()

    /** "22:00〜07:00 (月〜金)" for the profile card. */
    fun label(hours: QuietHours): String {
        val days = if (hours.days.isEmpty() || hours.days.size == 7) "" else " (" + hours.days.sorted().joinToString("") { DAY_LABELS[it] } + ")"
        return "${hours.start}〜${hours.end}$days"
    }
}
