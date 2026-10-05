package jp.chikuwachat.android.ui

import jp.chikuwachat.android.api.TemplateOut
import java.time.DayOfWeek
import java.time.LocalDate
import java.time.temporal.ChronoUnit
import java.time.temporal.IsoFields
import java.util.Locale
import jp.chikuwachat.android.R
import jp.chikuwachat.android.L10n

/**
 * Post templates and /日程 (M30, DATA_MODEL.md message_templates): the rules the three clients share, tested against
 * apps/shared/templates.json. Dates are the device's local date; nothing here talks to the server.
 */
object Templates {
    val SCHEDULE_QUESTION: String get() = L10n.str(R.string.common_scheduling_poll)
    val SCHEDULE_USAGE: String get() = L10n.str(R.string.templates_title_dates_e_g_seminar_10)
    private const val MAX_RANGE_DAYS = 14L
    private const val MIN_OPTIONS = 2
    private const val MAX_OPTIONS = 10

    private val WEEKDAYS: List<String> get() = L10n.weekdaysMondayFirst
    private val PLACEHOLDER = Regex("""\{(date|weekday|week)\}""")
    // i18n: keep (whitespace pattern)
    private val WHITESPACE = Regex("""[\s　]+""")
    private const val DATE = """(?:(\d{4})/)?(\d{1,2})/(\d{1,2})"""
    // i18n: keep (range pattern)
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
    fun kindLabel(template: TemplateOut): String = if (template.scope == "user") L10n.str(R.string.templates_personal_template) else L10n.str(R.string.common_templates)

    /** Templates whose name starts with what follows the `/` (case-insensitive), in [ordered] order. */
    fun candidates(templates: List<TemplateOut>, prefix: String): List<TemplateOut> =
        templates.filter { it.name.lowercase().startsWith(prefix.lowercase()) }

    // --- /日程 ---------------------------------------------------------------------------------

    data class SchedulePoll(val question: String, val options: List<String>)

    /** `M/D (曜)`, or `YYYY/M/D (曜)` outside this year. */
    fun dateLabel(date: LocalDate, today: LocalDate): String =
        (if (date.year == today.year) "${date.monthValue}/${date.dayOfMonth}" else "${date.year}/${date.monthValue}/${date.dayOfMonth}") +
            " (${weekday(date)})"

    /** One date read from `/日程` arguments, with the time of day that followed it (minutes since midnight). */
    data class ScheduleEntry(val day: LocalDate, val from: Int? = null, val to: Int? = null)

    data class ScheduleRead(val question: String, val entries: List<ScheduleEntry>)

    /**
     * The grammar of `/日程 [質問] 日付 …` (apps/shared/templates.json; the desktop's readSchedule): the question and every
     * date (a range gives each of its days) with the time after it; null when the arguments cannot be read. No limit on
     * how many (M54: the scheduling poll's form takes them as its candidates, [SchedulePolls.slotsFromEntries]).
     */
    fun readSchedule(args: String, today: LocalDate): ScheduleRead? {
        val words = args.trim().split(WHITESPACE).filter { it.isNotEmpty() }
        val first = words.indexOfFirst { DATE_TOKEN.matches(it) }
        if (first < 0) return null
        val question = words.take(first).joinToString(" ").ifEmpty { SCHEDULE_QUESTION }
        val entries = ArrayList<ScheduleEntry>()
        var index = first
        while (index < words.size) {
            val dates = dates(words[index], today) ?: return null
            index += 1
            var from: Int? = null
            var to: Int? = null
            if (index < words.size && !DATE_TOKEN.matches(words[index])) {
                // A word that is neither a date nor a time (or a second time in a row) cannot be read.
                val g = TIME_TOKEN.matchEntire(words[index])?.groupValues ?: return null
                from = minutes(g[1], g[2]) ?: return null
                if (g[3].isNotEmpty()) {
                    to = minutes(g[3], g[4]) ?: return null
                    if (to <= from) return null
                }
                index += 1
            }
            dates.forEach { entries += ScheduleEntry(it, from, to) }
        }
        return ScheduleRead(question, entries)
    }

    /**
     * What `/日程 args` made before M54: the question and 2-10 options (labels); null when the args are refused. Kept for
     * the shared vectors; the phones' `/日程` opens the scheduling poll's form from [readSchedule] since M54.
     */
    fun parseSchedule(args: String, today: LocalDate): SchedulePoll? {
        val read = readSchedule(args, today) ?: return null
        val labels = LinkedHashSet<String>()
        read.entries.forEach { entry ->
            var text = dateLabel(entry.day, today)
            entry.from?.let { text += " " + label(it) }
            entry.to?.let { text += L10n.str(R.string.templates_range_dash) + label(it) }
            labels += text
        }
        if (labels.size < MIN_OPTIONS || labels.size > MAX_OPTIONS) return null
        return SchedulePoll(read.question, labels.toList())
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

    /** Minutes since midnight, or null when not a time of day. */
    private fun minutes(hour: String, minute: String): Int? {
        val h = hour.toInt()
        val m = minute.toInt()
        return if (h in 0..23 && m in 0..59) h * 60 + m else null
    }

    private fun label(minutes: Int): String = "%d:%02d".format(Locale.ROOT, minutes / 60, minutes % 60)
}
