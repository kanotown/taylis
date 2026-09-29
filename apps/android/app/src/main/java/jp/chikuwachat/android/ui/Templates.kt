package jp.chikuwachat.android.ui

import jp.chikuwachat.android.api.TemplateOut
import java.time.DayOfWeek
import java.time.LocalDate
import java.time.LocalTime
import java.time.temporal.ChronoUnit
import java.time.temporal.IsoFields
import java.util.Locale

/**
 * Post templates and /日程 (M30, DATA_MODEL.md message_templates): the rules the three clients share, tested against
 * apps/shared/templates.json. Dates are the device's local date; nothing here talks to the server.
 */
object Templates {
    const val SCHEDULE_QUESTION = "日程調整"
    const val SCHEDULE_USAGE = "/日程 [質問] 日付 日付 … (例: /日程 ゼミ 10/3 10/4 10/6-10/8 13:00-14:30)"
    private const val MAX_RANGE_DAYS = 14L
    private const val MIN_OPTIONS = 2
    private const val MAX_OPTIONS = 10

    private val WEEKDAYS = listOf("月", "火", "水", "木", "金", "土", "日")
    private val PLACEHOLDER = Regex("""\{(date|weekday|week)\}""")
    private val WHITESPACE = Regex("""[\s　]+""")
    private const val DATE = """(?:(\d{4})/)?(\d{1,2})/(\d{1,2})"""
    private const val DASH = """[-〜~]"""
    /** `M/D`, `YYYY/M/D`, and a range to a date or to a day of the same month. */
    private val DATE_TOKEN = Regex("""^$DATE(?:$DASH(?:$DATE|(\d{1,2})))?$""")
    private val TIME_TOKEN = Regex("""^(\d{1,2}):(\d{2})(?:$DASH(\d{1,2}):(\d{2}))?$""")

    fun weekday(date: LocalDate): String = WEEKDAYS[date.dayOfWeek.value - 1]

    /** `{date}` `{weekday}` `{week}` replaced once (the result is not replaced again); any other `{…}` stays. */
    fun expand(body: String, today: LocalDate): String = PLACEHOLDER.replace(body) { match ->
        when (match.groupValues[1]) {
            "date" -> "%04d/%02d/%02d (%s)".format(Locale.ROOT, today.year, today.monthValue, today.dayOfMonth, weekday(today))
            "weekday" -> weekday(today)
            else -> "%d-W%02d".format(Locale.ROOT, today.get(IsoFields.WEEK_BASED_YEAR), today.get(IsoFields.WEEK_OF_WEEK_BASED_YEAR))
        }
    }

    /** `/name` alone → the body; `/name 文` → the body, a line break, then 文. */
    fun insertCommand(body: String, args: String, today: LocalDate): String {
        val expanded = expand(body, today)
        return if (args.isBlank()) expanded else expanded + "\n" + args.trim()
    }

    /** From the template button: an empty input becomes the body; otherwise it follows what is there after a blank line. */
    fun insertButton(current: String, body: String, today: LocalDate): String {
        val expanded = expand(body, today)
        // Only the trailing line breaks go (a line's own trailing space, like a template's `- `, stays).
        return if (current.isBlank()) expanded else current.trimEnd('\n', '\r') + "\n\n" + expanded
    }

    /** The workspace's, then mine, each by position then name; in a times channel the `suggest_in = times` ones first. */
    fun ordered(templates: Collection<TemplateOut>, inTimes: Boolean): List<TemplateOut> {
        val sorted = templates.sortedWith(
            compareBy<TemplateOut>({ if (it.scope == "workspace") 0 else 1 }, { it.position }, { it.name.lowercase() }, { it.name }),
        )
        return if (inTimes) sorted.sortedBy { if (it.suggestIn == "times") 0 else 1 } else sorted
    }

    /** `/name` (case-insensitive): my own template wins over the workspace's of the same name. */
    fun find(templates: Collection<TemplateOut>, name: String): TemplateOut? {
        val hits = templates.filter { it.name.equals(name, ignoreCase = true) }
        return hits.firstOrNull { it.scope == "user" } ?: hits.firstOrNull()
    }

    /** What the lists say beside the name (the workspace's and mine may share a name). */
    fun kindLabel(template: TemplateOut): String = if (template.scope == "user") "個人のテンプレート" else "テンプレート"

    /** Templates whose name starts with what follows the `/` (case-insensitive), in [ordered] order. */
    fun candidates(templates: List<TemplateOut>, prefix: String): List<TemplateOut> =
        templates.filter { it.name.lowercase().startsWith(prefix.lowercase()) }

    // --- /日程 ---------------------------------------------------------------------------------

    data class SchedulePoll(val question: String, val options: List<String>)

    /** `M/D (曜)`, or `YYYY/M/D (曜)` outside this year. */
    fun dateLabel(date: LocalDate, today: LocalDate): String =
        (if (date.year == today.year) "${date.monthValue}/${date.dayOfMonth}" else "${date.year}/${date.monthValue}/${date.dayOfMonth}") +
            " (${weekday(date)})"

    /** What `/日程 args` makes: the question and 2-10 options; null when the args are refused (show [SCHEDULE_USAGE]). */
    fun parseSchedule(args: String, today: LocalDate): SchedulePoll? {
        val words = args.trim().split(WHITESPACE).filter { it.isNotEmpty() }
        val first = words.indexOfFirst { DATE_TOKEN.matches(it) }
        if (first < 0) return null
        val question = words.take(first).joinToString(" ").ifEmpty { SCHEDULE_QUESTION }
        val labels = LinkedHashSet<String>()
        var index = first
        while (index < words.size) {
            val dates = dates(words[index], today) ?: return null
            index += 1
            var time = ""
            if (index < words.size && !DATE_TOKEN.matches(words[index])) {
                time = time(words[index]) ?: return null  // a word that is neither a date nor a time
                index += 1
            }
            dates.forEach { labels += dateLabel(it, today) + time }
            if (labels.size > MAX_OPTIONS) return null
        }
        if (labels.size < MIN_OPTIONS) return null
        return SchedulePoll(question, labels.toList())
    }

    /** The next [count] weekdays after today (what /日程 alone offers). */
    fun nextWeekdays(today: LocalDate, count: Int = 5): List<String> =
        generateSequence(today.plusDays(1)) { it.plusDays(1) }
            .filter { it.dayOfWeek != DayOfWeek.SATURDAY && it.dayOfWeek != DayOfWeek.SUNDAY }
            .take(count).map { dateLabel(it, today) }.toList()

    /** One date word: a date, or every day of a range; null when it is not a real date or the range is backwards or long. */
    private fun dates(word: String, today: LocalDate): List<LocalDate>? {
        val g = DATE_TOKEN.matchEntire(word)?.groupValues ?: return null
        val start = date(g[1], g[2], g[3], today) ?: return null
        val end = when {
            g[6].isNotEmpty() -> {
                // A range to M/D: that date in the start's year, the next year if its month and day come first.
                val month = g[5].toInt()
                val day = g[6].toInt()
                if (g[4].isNotEmpty()) of(g[4].toInt(), month, day)
                else of(start.year, month, day)?.let { if (it.isBefore(start)) of(start.year + 1, month, day) else it }
            }
            g[7].isNotEmpty() -> of(start.year, start.monthValue, g[7].toInt())  // a day of the same month
            else -> start
        } ?: return null
        if (end.isBefore(start)) return null
        val days = ChronoUnit.DAYS.between(start, end) + 1
        if (days > MAX_RANGE_DAYS) return null
        return (0 until days).map { start.plusDays(it) }
    }

    /** A date without a year is this year's, or next year's when that is more than 30 days ago. */
    private fun date(year: String, month: String, day: String, today: LocalDate): LocalDate? {
        if (year.isNotEmpty()) return of(year.toInt(), month.toInt(), day.toInt())
        val thisYear = of(today.year, month.toInt(), day.toInt()) ?: return null
        return if (thisYear.isBefore(today.minusDays(30))) of(today.year + 1, month.toInt(), day.toInt()) else thisYear
    }

    private fun of(year: Int, month: Int, day: Int): LocalDate? =
        runCatching { LocalDate.of(year, month, day) }.getOrNull()

    /** ` 13:00` or ` 13:00〜14:30`; null for a time that cannot be read or a range that ends first. */
    private fun time(word: String): String? {
        val g = TIME_TOKEN.matchEntire(word)?.groupValues ?: return null
        val start = clock(g[1], g[2]) ?: return null
        if (g[3].isEmpty()) return " " + label(start)
        val end = clock(g[3], g[4]) ?: return null
        if (!end.isAfter(start)) return null
        return " " + label(start) + "〜" + label(end)
    }

    private fun clock(hour: String, minute: String): LocalTime? {
        val h = hour.toInt()
        val m = minute.toInt()
        return if (h in 0..23 && m in 0..59) LocalTime.of(h, m) else null
    }

    private fun label(time: LocalTime): String = "%d:%02d".format(Locale.ROOT, time.hour, time.minute)
}
