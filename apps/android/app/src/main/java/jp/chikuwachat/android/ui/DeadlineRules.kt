package jp.chikuwachat.android.ui

import jp.chikuwachat.android.api.TaskKind
import jp.chikuwachat.android.api.TaskOut
import jp.chikuwachat.android.api.TaskStatus
import jp.chikuwachat.android.sync.ChannelState
import java.time.Instant
import java.time.LocalDate
import java.time.temporal.ChronoUnit
import jp.chikuwachat.android.R
import jp.chikuwachat.android.L10n

/** M86: how the header's chip looks — the day itself or the next (red), within a week (amber), later (grey). */
enum class DeadlineTone { SOON, WEEK, LATER }

/** 「締切」's sections, in order. */
enum class DeadlineGroupKey(val label: String) { WEEK(L10n.str(R.string.deadline_rules_this_week)), MONTH(L10n.str(R.string.deadline_rules_this_month)), LATER(L10n.str(R.string.deadline_rules_later)), PAST(L10n.str(R.string.deadline_rules_past)) }

data class DeadlineGroup(val key: DeadlineGroupKey, val tasks: List<TaskOut>) {
    val label: String get() = key.label
}

/**
 * M86 (DEADLINES.md §8): deadlines — channel tasks of kind `deadline` whose advance notices the server's 「締切」 bot posts
 * in the channel. The pure rules, a port of the desktop's ui/deadlines.ts: the notice days, when a deadline is over, the
 * conversation header's chip (the next open one: 「全国大会 原稿 あと 3 日」 / 「今日」 / 「明日」) and 「締切」's sections
 * (今週 / 今月 / それ以降 / 過ぎたもの). Days are "YYYY-MM-DD" strings in this device's zone (they sort).
 */
object DeadlineRules {
    /** The server's default (LAB.md §E): a week, three days, the day before and the day itself. */
    val DEFAULT_NOTICE_DAYS: List<Int> = listOf(7, 3, 1, 0)

    /** What the form offers (the server takes any of 0 to 60, at most 6). */
    val NOTICE_CHOICES: List<Int> = listOf(14, 7, 3, 1, 0)

    /** GET /tasks/deadlines brings the deadlines due from this many days ago on (the server's rule). */
    const val PAST_DAYS = 30L

    fun isDeadline(task: TaskOut): Boolean = task.kind == TaskKind.DEADLINE

    /** 「当日」 / 「前日」 / 「3 日前」. */
    fun noticeLabel(days: Int): String = when (days) {
        0 -> L10n.str(R.string.deadline_rules_on_the_day)
        1 -> L10n.str(R.string.deadline_rules_day_before)
        else -> L10n.str(R.string.deadline_rules_days_before, days)
    }

    /** The days as the server keeps them (distinct, largest first). */
    fun normalize(days: List<Int>): List<Int> = days.distinct().sortedDescending()

    /** 「7 日前・3 日前・前日・当日」, largest first; 「通知しない」 for none. */
    fun noticeSummary(days: List<Int>?): String {
        val sorted = normalize(days ?: emptyList())
        return if (sorted.isEmpty()) L10n.str(R.string.common_dont_notify) else sorted.joinToString(L10n.str(R.string.common_fmt_5)) { noticeLabel(it) }
    }

    fun sameNoticeDays(a: List<Int>?, b: List<Int>?): Boolean = normalize(a ?: emptyList()) == normalize(b ?: emptyList())

    /** The form's checks: the usual choices and any other day the deadline already has (set elsewhere), largest first. */
    fun noticeChoices(days: List<Int>): List<Int> = normalize(NOTICE_CHOICES + days)

    /** A check of 「事前の通知」 turned on or off. */
    fun toggleNotice(days: List<Int>, day: Int, on: Boolean): List<Int> = normalize(if (on) days + day else days - day)

    private fun day(task: TaskOut): String? = TaskRules.dueDay(task.dueOn, task.dueAt)

    private fun daysBetween(from: String, to: String): Long? = runCatching { ChronoUnit.DAYS.between(LocalDate.parse(from), LocalDate.parse(to)) }.getOrNull()

    /** Over: a due time once it has come, a date once its day is over (in this device's zone). */
    fun passed(task: TaskOut, today: String, now: Instant = Instant.now()): Boolean {
        task.dueAt?.let { at -> return runCatching { !CalendarDates.instant(at).isAfter(now) }.getOrDefault(false) }
        val day = day(task) ?: return false
        return day < today
    }

    private fun time(task: TaskOut): Long = task.dueAt?.let { runCatching { CalendarDates.instant(it).toEpochMilli() }.getOrNull() } ?: Long.MAX_VALUE

    /** By date, then a due time (a date alone is the whole day: after the timed ones that day), then id. */
    val order: Comparator<TaskOut> = compareBy<TaskOut> { day(it) ?: "" }.thenBy { time(it) }.thenBy { it.id }

    /** The header's chip: the channel's nearest deadline still open and not over. */
    fun next(tasks: List<TaskOut>, channelId: String, today: String, now: Instant = Instant.now()): TaskOut? =
        tasks.filter { isDeadline(it) && it.channelId == channelId && it.status != TaskStatus.DONE && it.dueOn != null && !passed(it, today, now) }
            .minWithOrNull(order)

    /** When, as the chip says it: 「今日」 (「今日 17:00」), 「明日」 (「明日 17:00」), else 「あと N 日」. */
    fun remainingText(task: TaskOut, today: String): String {
        val day = day(task) ?: return ""
        val days = daysBetween(today, day) ?: return ""
        val time = task.dueAt?.let { runCatching { " " + CalendarDates.clock(it) }.getOrNull() } ?: ""
        return when {
            days <= 0 -> L10n.str(R.string.deadline_rules_today, time)
            days == 1L -> L10n.str(R.string.deadline_rules_tomorrow, time)
            else -> L10n.str(R.string.deadline_rules_days_left, days)
        }
    }

    /** 「全国大会 原稿 あと 3 日」. */
    fun chipText(task: TaskOut, today: String): String = "${task.title} ${remainingText(task, today)}"

    fun tone(task: TaskOut, today: String): DeadlineTone {
        val days = day(task)?.let { daysBetween(today, it) } ?: return DeadlineTone.LATER
        return when {
            days <= 1 -> DeadlineTone.SOON
            days <= 7 -> DeadlineTone.WEEK
            else -> DeadlineTone.LATER
        }
    }

    /** A row's date: 「10/9 (金)」, 「10/9 (金) 17:00」, 「今日」 for today. */
    fun whenText(task: TaskOut, today: String): String {
        val day = day(task) ?: return ""
        val date = runCatching { LocalDate.parse(day) }.getOrNull() ?: return day
        val label = if (day == today) L10n.str(R.string.common_today) else "${TaskRules.dueLabel(day, today)} (${"日月火水木金土"[CalendarDates.weekdayIndex(date)]})"
        return task.dueAt?.let { at -> runCatching { "$label ${CalendarDates.clock(at)}" }.getOrNull() } ?: label
    }

    /**
     * 「締切」: 今週 (through this week's Saturday, the calendar's Sunday weeks), 今月 (the rest of this month), それ以降, and
     * 過ぎたもの (over, done or not; the most recent first). Done ones still ahead stay in their section (struck through).
     * Empty sections are left out.
     */
    fun groups(tasks: List<TaskOut>, today: String, now: Instant = Instant.now()): List<DeadlineGroup> {
        val first = runCatching { LocalDate.parse(today) }.getOrNull() ?: return emptyList()
        val weekEnd = CalendarDates.weekStart(first).plusDays(6).toString()
        val monthEnd = first.withDayOfMonth(first.lengthOfMonth()).toString()
        val buckets = DeadlineGroupKey.entries.associateWith { ArrayList<TaskOut>() }
        for (task in tasks) {
            if (!isDeadline(task) || task.dueOn == null) continue
            val day = day(task) ?: continue
            val key = when {
                passed(task, today, now) -> DeadlineGroupKey.PAST
                day <= weekEnd -> DeadlineGroupKey.WEEK
                day <= monthEnd -> DeadlineGroupKey.MONTH
                else -> DeadlineGroupKey.LATER
            }
            buckets.getValue(key) += task
        }
        return DeadlineGroupKey.entries.mapNotNull { key ->
            val list = buckets.getValue(key)
            if (list.isEmpty()) null else DeadlineGroup(key, if (key == DeadlineGroupKey.PAST) list.sortedWith(order.reversed()) else list.sortedWith(order))
        }
    }

    /** Whether a task belongs in the hub's deadlines window: a channel deadline due from 30 days ago (this device's day) on. */
    fun inWindow(task: TaskOut, today: String): Boolean {
        if (!isDeadline(task) || task.channelId == null || task.dueOn == null) return false
        val since = runCatching { LocalDate.parse(today).minusDays(PAST_DAYS).toString() }.getOrNull() ?: return false
        return task.dueOn >= since
    }

    /**
     * Who may add a deadline to a channel: whoever may change its board (a member who may post there), never a guest
     * (DEADLINES.md §2 2.). The server checks it again.
     */
    fun canAdd(channel: ChannelState?, isAdmin: Boolean, isGuest: Boolean): Boolean = !isGuest && TaskRules.canEditBoard(channel, isAdmin)

    /** 「締切を追加」 from a board or 「締切」: the form as a deadline on `channelId`, the other boards offered beside it. */
    fun createInit(channelId: String, boards: List<String>): TaskCreateInit =
        TaskCreateInit(channelId = channelId, kind = TaskKind.DEADLINE, boardChoices = (listOf(channelId) + boards).distinct())
}
