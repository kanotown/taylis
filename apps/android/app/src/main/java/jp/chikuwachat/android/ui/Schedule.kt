package jp.chikuwachat.android.ui

import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.ZonedDateTime
import java.time.temporal.ChronoUnit
import jp.chikuwachat.android.R
import jp.chikuwachat.android.L10n

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

    /** A choice's text: its name, and its time when that says more (「1 時間後  今日 21:20」); 「明日 9:00」 once, not twice. */
    fun choice(preset: Preset, now: ZonedDateTime = ZonedDateTime.now()): String {
        val whenLabel = label(preset.at, now)
        return if (whenLabel == preset.label) preset.label else preset.label + "  " + whenLabel
    }

    /** Slack-like choices that are always in the future relative to `now`. */
    fun presets(now: ZonedDateTime = ZonedDateTime.now()): List<Preset> {
        val list = ArrayList<Preset>()
        list += Preset("1h", L10n.str(R.string.common_in_1_hour), now.plusHours(1).withSecond(0).withNano(0))
        val today18 = now.withHour(18).withMinute(0).withSecond(0).withNano(0)
        if (today18.isAfter(now.plusMinutes(5))) list += Preset("today18", L10n.str(R.string.schedule_today_18_00), today18)
        list += Preset("tomorrow9", L10n.str(R.string.schedule_tomorrow_9_00), now.plusDays(1).withHour(9).withMinute(0).withSecond(0).withNano(0))
        var toMonday = ((DayOfWeek.MONDAY.value - now.dayOfWeek.value) + 7) % 7
        if (toMonday == 0) toMonday = 7 // next Monday, never today
        list += Preset("monday9", L10n.str(R.string.schedule_next_monday_9_00), now.plusDays(toMonday.toLong()).withHour(9).withMinute(0).withSecond(0).withNano(0))
        return list
    }

    /** 「リマインド」 choices (M12e): a little later, or a fresh morning. */
    fun reminderPresets(now: ZonedDateTime = ZonedDateTime.now()): List<Preset> {
        fun soon(minutes: Long) = now.plusMinutes(minutes).withSecond(0).withNano(0)
        val list = arrayListOf(
            Preset("20m", L10n.str(R.string.schedule_in_20_minutes), soon(20)),
            Preset("1h", L10n.str(R.string.common_in_1_hour), soon(60)),
            Preset("3h", L10n.str(R.string.schedule_in_3_hours), soon(180)),
            Preset("tomorrow9", L10n.str(R.string.schedule_tomorrow_9_00), now.plusDays(1).withHour(9).withMinute(0).withSecond(0).withNano(0)),
        )
        var toMonday = ((DayOfWeek.MONDAY.value - now.dayOfWeek.value) + 7) % 7
        if (toMonday == 0) toMonday = 7
        list += Preset("monday9", L10n.str(R.string.schedule_next_monday_9_00), now.plusDays(toMonday.toLong()).withHour(9).withMinute(0).withSecond(0).withNano(0))
        return list
    }

    /** The key of a time picked with 「日時を指定…」 in the reminder dialog. */
    const val CUSTOM = "custom"

    /** 「リマインド」's 「日時を指定…」 (as on iOS and the desktop): the picked time, labelled with when it is. */
    fun customReminder(at: ZonedDateTime, now: ZonedDateTime = ZonedDateTime.now()): Preset = Preset(CUSTOM, label(at, now), at)

    private val DAYS: List<String> get() = L10n.weekdaysMondayFirst

    /** "今日 18:00" / "明日 9:00" / "10月3日(土) 9:00" / "2027年1月4日(月) 9:00". */
    fun label(at: ZonedDateTime, now: ZonedDateTime = ZonedDateTime.now()): String {
        val time = "${at.hour}:" + "%02d".format(at.minute)
        val days = ChronoUnit.DAYS.between(now.toLocalDate(), at.withZoneSameInstant(now.zone).toLocalDate())
        if (days == 0L) return L10n.str(R.string.schedule_today, time)
        if (days == 1L) return L10n.str(R.string.schedule_tomorrow, time)
        val weekday = DAYS[at.dayOfWeek.value - 1]
        return if (at.year != now.year) L10n.str(R.string.schedule_label_date_year, at.year, at.monthValue, at.dayOfMonth, weekday, time)
        else L10n.str(R.string.schedule_label_date, at.monthValue, at.dayOfMonth, weekday, time)
    }

    fun label(iso: String, zone: ZoneId = ZoneId.systemDefault(), now: ZonedDateTime = ZonedDateTime.now(zone)): String =
        runCatching { label(Instant.parse(iso).atZone(zone), now) }.getOrDefault(iso)
}
