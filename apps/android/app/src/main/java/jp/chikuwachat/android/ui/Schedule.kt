package jp.chikuwachat.android.ui

import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.ZonedDateTime
import java.time.temporal.ChronoUnit

/** 「後で送信」 presets and labels (M12d). Times are local; the server stores UTC. */
object Schedule {
    data class Preset(val key: String, val label: String, val at: ZonedDateTime)

    // Material's calendar encodes a calendar day as midnight UTC, not a local instant.
    fun pickerMillis(date: LocalDate): Long = date.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli()
    fun pickerDate(millis: Long): LocalDate = Instant.ofEpochMilli(millis).atZone(ZoneOffset.UTC).toLocalDate()

    /** Reject a nonexistent local time at a daylight-saving transition rather than silently shifting it. */
    fun atDateTime(date: LocalDate, time: LocalTime, zone: ZoneId = ZoneId.systemDefault()): ZonedDateTime? {
        val local = date.atTime(time.withSecond(0).withNano(0))
        if (zone.rules.getValidOffsets(local).isEmpty()) return null
        return local.atZone(zone)
    }

    /** Slack-like choices that are always in the future relative to `now`. */
    fun presets(now: ZonedDateTime = ZonedDateTime.now()): List<Preset> {
        val list = ArrayList<Preset>()
        list += Preset("1h", "1 時間後", now.plusHours(1).withSecond(0).withNano(0))
        val today18 = now.withHour(18).withMinute(0).withSecond(0).withNano(0)
        if (today18.isAfter(now.plusMinutes(5))) list += Preset("today18", "今日 18:00", today18)
        list += Preset("tomorrow9", "明日 9:00", now.plusDays(1).withHour(9).withMinute(0).withSecond(0).withNano(0))
        var toMonday = ((DayOfWeek.MONDAY.value - now.dayOfWeek.value) + 7) % 7
        if (toMonday == 0) toMonday = 7 // next Monday, never today
        list += Preset("monday9", "来週月曜 9:00", now.plusDays(toMonday.toLong()).withHour(9).withMinute(0).withSecond(0).withNano(0))
        return list
    }

    /** 「リマインド」 choices (M12e): a little later, or a fresh morning. */
    fun reminderPresets(now: ZonedDateTime = ZonedDateTime.now()): List<Preset> {
        fun soon(minutes: Long) = now.plusMinutes(minutes).withSecond(0).withNano(0)
        val list = arrayListOf(
            Preset("20m", "20 分後", soon(20)),
            Preset("1h", "1 時間後", soon(60)),
            Preset("3h", "3 時間後", soon(180)),
            Preset("tomorrow9", "明日 9:00", now.plusDays(1).withHour(9).withMinute(0).withSecond(0).withNano(0)),
        )
        var toMonday = ((DayOfWeek.MONDAY.value - now.dayOfWeek.value) + 7) % 7
        if (toMonday == 0) toMonday = 7
        list += Preset("monday9", "来週月曜 9:00", now.plusDays(toMonday.toLong()).withHour(9).withMinute(0).withSecond(0).withNano(0))
        return list
    }

    private val DAYS = listOf("月", "火", "水", "木", "金", "土", "日")

    /** "今日 18:00" / "明日 9:00" / "10月3日(土) 9:00" / "2027年1月4日(月) 9:00". */
    fun label(at: ZonedDateTime, now: ZonedDateTime = ZonedDateTime.now()): String {
        val time = "${at.hour}:" + "%02d".format(at.minute)
        val days = ChronoUnit.DAYS.between(now.toLocalDate(), at.withZoneSameInstant(now.zone).toLocalDate())
        if (days == 0L) return "今日 $time"
        if (days == 1L) return "明日 $time"
        val year = if (at.year != now.year) "${at.year}年" else ""
        return "$year${at.monthValue}月${at.dayOfMonth}日(${DAYS[at.dayOfWeek.value - 1]}) $time"
    }

    fun label(iso: String, zone: ZoneId = ZoneId.systemDefault(), now: ZonedDateTime = ZonedDateTime.now(zone)): String =
        runCatching { label(Instant.parse(iso).atZone(zone), now) }.getOrDefault(iso)
}
