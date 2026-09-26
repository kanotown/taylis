package jp.chikuwachat.android.ui

import jp.chikuwachat.android.sync.MessageState
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter

/** Rows of a channel timeline: date separators, one 「新着メッセージ」 divider and grouped messages. */
sealed class TimelineItem {
    abstract val key: String

    data class DateSeparator(val label: String, override val key: String) : TimelineItem()
    data class UnreadSeparator(override val key: String = "unread") : TimelineItem()
    data class Message(val message: MessageState, val compact: Boolean) : TimelineItem() {
        override val key: String get() = message.id
    }
}

object Timeline {
    private const val GROUP_WINDOW_SECONDS = 5 * 60
    private val WEEKDAYS = listOf("月", "火", "水", "木", "金", "土", "日")
    private val TIME: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm")
    private val FULL: DateTimeFormatter = DateTimeFormatter.ofPattern("yyyy年M月d日 HH:mm")

    fun parse(iso: String, zone: ZoneId = ZoneId.systemDefault()): ZonedDateTime? =
        runCatching { Instant.parse(iso).atZone(zone) }.getOrNull()

    fun timeLabel(iso: String, zone: ZoneId = ZoneId.systemDefault()): String = parse(iso, zone)?.format(TIME) ?: ""

    fun fullLabel(iso: String, zone: ZoneId = ZoneId.systemDefault()): String = parse(iso, zone)?.format(FULL) ?: ""

    /** 今日 / 昨日 / 9月26日 (金) / 2025年12月31日 (水). */
    fun dateLabel(day: LocalDate, today: LocalDate): String {
        if (day == today) return "今日"
        if (day == today.minusDays(1)) return "昨日"
        val weekday = WEEKDAYS[day.dayOfWeek.value - 1]
        val md = "${day.monthValue}月${day.dayOfMonth}日 ($weekday)"
        return if (day.year == today.year) md else "${day.year}年$md"
    }

    /** 「Toru Kano」→ TK, 「かのう」→ か. */
    fun initials(name: String): String {
        val trimmed = name.trim()
        if (trimmed.isEmpty()) return "?"
        val words = trimmed.split(Regex("\\s+"))
        if (words.size >= 2 && words[0].first().isLetter() && words[0].first().code < 128 && words[1].first().code < 128) {
            return (words[0].take(1) + words[1].take(1)).uppercase()
        }
        return trimmed.codePointAt(0).let { String(Character.toChars(it)) }.uppercase()
    }

    /** Stable hue (0-359) per user id. */
    fun hue(id: String): Int {
        var hash = 0L
        for (ch in id) hash = (hash * 31 + ch.code) and 0xffffffffL
        return (hash % 360).toInt()
    }

    fun build(
        messages: List<MessageState>,
        firstUnreadAfterSeq: Int?,
        meId: String?,
        today: LocalDate = LocalDate.now(),
        zone: ZoneId = ZoneId.systemDefault(),
    ): List<TimelineItem> {
        val items = ArrayList<TimelineItem>(messages.size + 8)
        var previous: MessageState? = null
        var previousDay: LocalDate? = null
        var unreadPlaced = false
        for (message in messages) {
            val at = parse(message.createdAt, zone) ?: ZonedDateTime.now(zone)
            val day = at.toLocalDate()
            if (day != previousDay) {
                items.add(TimelineItem.DateSeparator(dateLabel(day, today), "date:$day"))
                previousDay = day
                previous = null
            }
            val seq = message.seq
            if (!unreadPlaced && firstUnreadAfterSeq != null && seq != null && seq > firstUnreadAfterSeq && message.senderId != meId) {
                items.add(TimelineItem.UnreadSeparator())
                unreadPlaced = true
                previous = null
            }
            val prev = previous
            val compact = prev != null && prev.senderId == message.senderId && !prev.pending && !message.pending &&
                (parse(prev.createdAt, zone)?.let { kotlin.math.abs(at.toEpochSecond() - it.toEpochSecond()) < GROUP_WINDOW_SECONDS } ?: false)
            items.add(TimelineItem.Message(message, compact))
            previous = message
        }
        return items
    }

    /** "HH:mm までミュート" while a mute is active, otherwise null. */
    fun muteLabel(mutedUntil: String?, zone: ZoneId = ZoneId.systemDefault()): String? {
        val until = mutedUntil?.let { parse(it, zone) } ?: return null
        if (!until.isAfter(ZonedDateTime.now(zone))) return null
        return until.format(TIME) + " までミュート"
    }
}
