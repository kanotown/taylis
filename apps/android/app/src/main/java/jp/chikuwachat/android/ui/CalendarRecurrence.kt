package jp.chikuwachat.android.ui

import java.net.URLEncoder
import java.time.LocalDate
import jp.chikuwachat.android.R
import jp.chikuwachat.android.L10n

/** M69 (CALENDAR.md §10.9): 「繰り返し」's choice. The presets repeat every day / week / month / year; カスタム has an interval. */
enum class RepeatKind(val label: String) {
    NONE(L10n.str(R.string.calendar_recurrence_never)),
    DAILY(L10n.str(R.string.calendar_recurrence_daily)),
    WEEKLY(L10n.str(R.string.common_weekly)),
    MONTHLY(L10n.str(R.string.common_monthly)),
    YEARLY(L10n.str(R.string.calendar_recurrence_yearly)),
    CUSTOM(L10n.str(R.string.common_custom)),
}

/** What a rule repeats every (`label`: カスタム's unit, 「N 日 / 週 / か月 / 年ごと」). */
enum class RepeatFreq(val label: String) {
    DAILY(L10n.str(R.string.calendar_recurrence_days)),
    WEEKLY(L10n.str(R.string.calendar_recurrence_weeks)),
    MONTHLY(L10n.str(R.string.calendar_recurrence_months)),
    YEARLY(L10n.str(R.string.calendar_recurrence_years)),
}

/** 毎月: the same date (「10 日」), the month's last day (「月末」), the nth weekday (「第 2 火曜日」) or the last such weekday (「最終 金曜日」). */
enum class MonthlyMode { DAY, MONTH_END, NTH, LAST }

/** 終了: なし / 日付 (the day included) / 回数. */
enum class RepeatEnd(val label: String) {
    NEVER(L10n.str(R.string.common_none)),
    UNTIL(L10n.str(R.string.calendar_recurrence_on_date)),
    COUNT(L10n.str(R.string.common_times)),
}

/** The picker's state. Weekdays are 0 = Sunday … 6 = Saturday (as CalendarDates.weekdayIndex). */
data class RepeatDraft(
    val kind: RepeatKind = RepeatKind.NONE,
    /** カスタム: what repeats every `interval`. The presets use their own. */
    val freq: RepeatFreq = RepeatFreq.WEEKLY,
    val interval: Int = 1,
    /** 毎週: the weekdays. */
    val weekdays: List<Int> = emptyList(),
    val monthly: MonthlyMode = MonthlyMode.DAY,
    val end: RepeatEnd = RepeatEnd.NEVER,
    /** The last day (included) when `end` is UNTIL. */
    val until: LocalDate? = null,
    val count: Int = 10,
)

/** A rule as the server sends it (CALENDAR.md §10.1), read for the picker and the words. */
data class ParsedRule(
    val freq: RepeatFreq,
    val interval: Int,
    /** BYDAY: (n or null, weekday 0 = Sunday). */
    val byday: List<Pair<Int?, Int>>,
    val bymonthday: Int?,
    val until: LocalDate?,
    val count: Int?,
)

/** 「この予定」「これ以降すべて」「すべての予定」 (the API's `scope`). */
enum class OccurrenceScope(val wire: String, val label: String) {
    THIS("this", L10n.str(R.string.calendar_recurrence_this_event)),
    FOLLOWING("following", L10n.str(R.string.calendar_recurrence_this_and_following)),
    ALL("all", L10n.str(R.string.calendar_recurrence_all_events)),
}

/**
 * M69 (CALENDAR.md §10): the 「繰り返し」 picker and the words for a rule, as the desktop's ui/calendarRecurrence.ts (its
 * tests are ported). The server stores a subset of RFC 5545's RRULE (FREQ DAILY / WEEKLY / MONTHLY / YEARLY, INTERVAL,
 * BYDAY, BYMONTHDAY, UNTIL as a date or COUNT) and alone expands it (§10.8): this only turns the picker into such a rule,
 * normalized as the server stores it, and a rule back into the picker and into Japanese (「毎週 火・木曜日、2026年12月20日まで」).
 */
object CalendarRecurrence {
    const val MAX_INTERVAL = 99
    const val MAX_COUNT = 999

    private val CODES = listOf("SU", "MO", "TU", "WE", "TH", "FR", "SA")
    private val NAMES = listOf("日", "月", "火", "水", "木", "金", "土")
    /** The server's order (RFC 5545's default week start): Monday first. */
    private val MONDAY_FIRST = listOf(1, 2, 3, 4, 5, 6, 0)
    private val BYDAY_ITEM = Regex("^([+-]?\\d)?(SU|MO|TU|WE|TH|FR|SA)$")
    private val DATE_8 = Regex("^\\d{8}$")

    val WEEKDAY_NAMES: List<String> get() = NAMES

    private fun weekday(day: LocalDate): Int = day.dayOfWeek.value % 7

    fun noRepeat(start: LocalDate): RepeatDraft = RepeatDraft(weekdays = listOf(weekday(start)))

    /** Which week of its month a day is in (1-5), and whether it is that weekday's last in the month. */
    fun nthOfMonth(day: LocalDate): Pair<Int, Boolean> = ((day.dayOfMonth + 6) / 7) to (day.dayOfMonth + 7 > day.lengthOfMonth())

    private fun freqOf(draft: RepeatDraft): RepeatFreq? = when (draft.kind) {
        RepeatKind.NONE -> null
        RepeatKind.DAILY -> RepeatFreq.DAILY
        RepeatKind.WEEKLY -> RepeatFreq.WEEKLY
        RepeatKind.MONTHLY -> RepeatFreq.MONTHLY
        RepeatKind.YEARLY -> RepeatFreq.YEARLY
        RepeatKind.CUSTOM -> draft.freq
    }

    /** What the picker repeats every (null: しない). */
    fun freq(draft: RepeatDraft): RepeatFreq? = freqOf(draft)

    private fun compact(day: LocalDate): String = day.toString().replace("-", "")

    /** The rule for the picker (null: しない), normalized the way the server stores it. */
    fun repeatToRrule(draft: RepeatDraft, start: LocalDate): String? {
        val freq = freqOf(draft) ?: return null
        val parts = mutableListOf("FREQ=${freq.name}")
        val interval = if (draft.kind == RepeatKind.CUSTOM) draft.interval.coerceIn(1, MAX_INTERVAL) else 1
        if (interval != 1) parts += "INTERVAL=$interval"
        when (freq) {
            RepeatFreq.WEEKLY -> {
                val days = draft.weekdays.ifEmpty { listOf(weekday(start)) }
                parts += "BYDAY=" + MONDAY_FIRST.filter { it in days }.joinToString(",") { CODES[it] }
            }
            RepeatFreq.MONTHLY -> parts += when (draft.monthly) {
                MonthlyMode.NTH -> "BYDAY=${nthOfMonth(start).first}${CODES[weekday(start)]}"
                MonthlyMode.LAST -> "BYDAY=-1${CODES[weekday(start)]}"
                MonthlyMode.MONTH_END -> "BYMONTHDAY=-1"
                MonthlyMode.DAY -> "BYMONTHDAY=${start.dayOfMonth}"
            }
            else -> Unit
        }
        val until = draft.until
        if (draft.end == RepeatEnd.UNTIL && until != null) parts += "UNTIL=${compact(until)}"
        else if (draft.end == RepeatEnd.COUNT) parts += "COUNT=${draft.count.coerceIn(1, MAX_COUNT)}"
        return parts.joinToString(";")
    }

    /** A rule as the server sends it (null when it is not one this client understands). */
    fun parseRrule(rrule: String): ParsedRule? {
        val fields = HashMap<String, String>()
        for (part in rrule.replace(Regex("^RRULE:", RegexOption.IGNORE_CASE), "").split(";")) {
            val pieces = part.split("=")
            if (pieces.size < 2 || pieces[0].isEmpty()) return null
            fields[pieces[0].uppercase()] = pieces[1].uppercase()
        }
        val freq = RepeatFreq.entries.firstOrNull { it.name == fields["FREQ"] } ?: return null
        val byday = ArrayList<Pair<Int?, Int>>()
        for (item in (fields["BYDAY"] ?: "").split(",").filter { it.isNotEmpty() }) {
            val match = BYDAY_ITEM.matchEntire(item) ?: return null
            val n = match.groupValues[1].takeIf { it.isNotEmpty() }?.toInt()
            byday += n to CODES.indexOf(match.groupValues[2])
        }
        val until = fields["UNTIL"]?.takeIf { DATE_8.matches(it) }?.let {
            runCatching { LocalDate.of(it.substring(0, 4).toInt(), it.substring(4, 6).toInt(), it.substring(6, 8).toInt()) }.getOrNull()
        }
        return ParsedRule(
            freq = freq,
            interval = fields["INTERVAL"]?.toIntOrNull()?.takeIf { it != 0 } ?: 1,
            byday = byday,
            bymonthday = fields["BYMONTHDAY"]?.toIntOrNull(),
            until = until,
            count = fields["COUNT"]?.toIntOrNull(),
        )
    }

    /** The picker for an event's rule (null rule: しない). `start` is the day the picker shows (the opened occurrence's). */
    fun rruleToRepeat(rrule: String?, start: LocalDate): RepeatDraft {
        val draft = noRepeat(start)
        val rule = rrule?.let { parseRrule(it) } ?: return draft
        val kind = if (rule.interval != 1) RepeatKind.CUSTOM else when (rule.freq) {
            RepeatFreq.DAILY -> RepeatKind.DAILY
            RepeatFreq.WEEKLY -> RepeatKind.WEEKLY
            RepeatFreq.MONTHLY -> RepeatKind.MONTHLY
            RepeatFreq.YEARLY -> RepeatKind.YEARLY
        }
        var out = draft.copy(kind = kind, freq = rule.freq, interval = rule.interval)
        if (rule.freq == RepeatFreq.WEEKLY && rule.byday.isNotEmpty()) out = out.copy(weekdays = rule.byday.map { it.second })
        if (rule.freq == RepeatFreq.MONTHLY) {
            val nth = rule.byday.firstOrNull()?.first
            out = out.copy(
                monthly = when {
                    nth == null -> if (rule.bymonthday == -1) MonthlyMode.MONTH_END else MonthlyMode.DAY
                    nth < 0 -> MonthlyMode.LAST
                    else -> MonthlyMode.NTH
                },
            )
        }
        if (rule.until != null) out = out.copy(end = RepeatEnd.UNTIL, until = rule.until)
        else if (rule.count != null && rule.count != 0) out = out.copy(end = RepeatEnd.COUNT, count = rule.count)
        return out
    }

    /**
     * Whether the picker says something other than the event's rule (a change for 「これ以降」 / 「すべて」 only). The event's
     * rule is read through the picker first, so the defaults a rule may leave out (the start's weekday or date) compare alike.
     */
    fun ruleChanged(draft: RepeatDraft, start: LocalDate, rrule: String?): Boolean {
        val before = rrule?.let { repeatToRrule(rruleToRepeat(it, start), start) }
        return repeatToRrule(draft, start) != before
    }

    private fun weekdayList(days: List<Int>): String = MONDAY_FIRST.filter { it in days }.joinToString(L10n.str(R.string.common_fmt_5)) { NAMES[it] }

    private fun longDay(day: LocalDate): String = L10n.str(R.string.calendar_recurrence_fmt, day.year, day.monthValue, day.dayOfMonth)

    /**
     * A rule in words: 「毎日」「3 日ごと」「毎週 火・木曜日」「2 週間ごと 月曜日」「毎月 10 日」「毎月 月末」「毎月 第 2 火曜日」「毎月 最終 金曜日」
     * 「毎年 1月10日」, then 「、2026年12月20日まで」 or 「、10 回」. `start` is the occurrence's day (its date, its weekday).
     */
    fun describeRrule(rrule: String?, start: LocalDate): String {
        if (rrule == null) return L10n.str(R.string.calendar_recurrence_does_not_repeat)
        val rule = parseRrule(rrule) ?: return L10n.str(R.string.common_repeat)
        fun every(unit: String, one: String) = if (rule.interval == 1) one else L10n.str(R.string.calendar_recurrence_every, rule.interval, unit)
        var text = when (rule.freq) {
            RepeatFreq.DAILY -> every(L10n.str(R.string.calendar_recurrence_days), L10n.str(R.string.calendar_recurrence_daily))
            RepeatFreq.WEEKLY -> {
                val days = rule.byday.map { it.second }.ifEmpty { listOf(weekday(start)) }
                "${every("週間", "毎週")} ${weekdayList(days)}曜日"
            }
            RepeatFreq.MONTHLY -> {
                val nth = rule.byday.firstOrNull()
                val which = when {
                    nth != null && nth.first != null -> "${if (nth.first!! < 0) "最終" else "第 ${nth.first}"} ${NAMES[nth.second]}曜日"
                    rule.bymonthday == -1 -> L10n.str(R.string.calendar_recurrence_end_of_month)
                    else -> L10n.str(R.string.common_day, rule.bymonthday ?: start.dayOfMonth)
                }
                "${every("か月", "毎月")} $which"
            }
            RepeatFreq.YEARLY -> "${every("年", "毎年")} ${start.monthValue}月${start.dayOfMonth}日"
        }
        if (rule.until != null) text += L10n.str(R.string.calendar_recurrence_until, longDay(rule.until))
        else if (rule.count != null && rule.count != 0) text += L10n.str(R.string.calendar_recurrence_times, rule.count)
        return text
    }

    data class MonthlyChoice(val value: MonthlyMode, val label: String)

    /** The picker's choices for 毎月 on a day: 「毎月 10 日」, 「毎月 第 2 火曜日」 and, in a month's last week, 「毎月 最終 火曜日」. */
    fun monthlyChoices(start: LocalDate): List<MonthlyChoice> {
        val (n, last) = nthOfMonth(start)
        val name = NAMES[weekday(start)]
        val choices = mutableListOf(MonthlyChoice(MonthlyMode.DAY, L10n.str(R.string.calendar_recurrence_monthly_on_day, start.dayOfMonth)))
        if (start.dayOfMonth == start.lengthOfMonth()) choices += MonthlyChoice(MonthlyMode.MONTH_END, L10n.str(R.string.calendar_recurrence_monthly_on_the_last_day))
        if (n <= 4) choices += MonthlyChoice(MonthlyMode.NTH, L10n.str(R.string.calendar_recurrence_monthly_on_of_week, n, name))
        if (last) choices += MonthlyChoice(MonthlyMode.LAST, L10n.str(R.string.calendar_recurrence_monthly_on_the_last, name))
        return choices
    }

    /** What stops the picker from being saved, or null. */
    fun repeatProblem(draft: RepeatDraft, start: LocalDate): String? {
        if (draft.kind == RepeatKind.NONE) return null
        if (draft.kind == RepeatKind.CUSTOM && draft.interval !in 1..MAX_INTERVAL) return L10n.str(R.string.calendar_recurrence_the_interval_must_be_1, MAX_INTERVAL)
        if (freqOf(draft) == RepeatFreq.WEEKLY && draft.weekdays.isEmpty()) return L10n.str(R.string.calendar_recurrence_choose_the_days_of_the_week)
        if (draft.end == RepeatEnd.UNTIL) {
            val until = draft.until ?: return L10n.str(R.string.calendar_recurrence_enter_the_end_date)
            if (until.isBefore(start)) return L10n.str(R.string.common_the_end_date_must_be_after)
        }
        if (draft.end == RepeatEnd.COUNT && draft.count !in 1..MAX_COUNT) return L10n.str(R.string.calendar_recurrence_the_count_must_be_1, MAX_COUNT)
        return null
    }

    // --- the occurrence endpoints (CALENDAR.md §10.3) -------------------------------------------------

    private fun enc(text: String): String = URLEncoder.encode(text, "UTF-8").replace("+", "%20")

    /** PATCH / DELETE /calendar/events/{series_id}/occurrences/{occurrence_start} (`scope` in the query for DELETE). */
    fun occurrencePath(seriesId: String, occurrenceStart: String, scope: OccurrenceScope? = null): String =
        "/api/v1/calendar/events/${enc(seriesId)}/occurrences/${enc(occurrenceStart)}" + (scope?.let { "?scope=${it.wire}" } ?: "")

    // --- the picker across a rotation ----------------------------------------------------------------

    fun save(draft: RepeatDraft): String = listOf(
        draft.kind.name, draft.freq.name, draft.interval.toString(), draft.weekdays.joinToString(","), draft.monthly.name, draft.end.name,
        draft.until?.toString() ?: "", draft.count.toString(),
    ).joinToString("|")

    fun restore(text: String, start: LocalDate): RepeatDraft {
        val f = text.split("|")
        if (f.size != 8) return noRepeat(start)
        return runCatching {
            RepeatDraft(
                kind = RepeatKind.valueOf(f[0]), freq = RepeatFreq.valueOf(f[1]), interval = f[2].toInt(),
                weekdays = f[3].split(",").filter { it.isNotEmpty() }.map { it.toInt() }, monthly = MonthlyMode.valueOf(f[4]),
                end = RepeatEnd.valueOf(f[5]), until = f[6].takeIf { it.isNotEmpty() }?.let { LocalDate.parse(it) }, count = f[7].toInt(),
            )
        }.getOrElse { noRepeat(start) }
    }
}
