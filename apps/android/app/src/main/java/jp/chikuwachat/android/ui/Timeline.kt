package jp.chikuwachat.android.ui

import jp.chikuwachat.android.sync.EngineStatus
import jp.chikuwachat.android.sync.MessageState
import jp.chikuwachat.android.sync.ReadGate
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeoutOrNull
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.util.Locale

/** Rows of a channel timeline: date separators, one 「新着メッセージ」 divider and grouped messages. */
sealed class TimelineItem {
    abstract val key: String

    data class DateSeparator(val label: String, override val key: String) : TimelineItem()
    data class UnreadSeparator(override val key: String = "unread") : TimelineItem()
    data class Message(val message: MessageState, val compact: Boolean) : TimelineItem() {
        // The client_msg_id, which my pending message keeps when the server confirms it (its id changes from
        // "local:…" to the server's): keyed by id, the row was dropped and re-inserted on every send.
        override val key: String get() = message.rowKey
    }
}

/** Where a conversation view opens (SYNC_PROTOCOL.md §10.1 rule 4, §10.2). Indexes are LazyColumn item indexes. */
sealed class OpenPosition {
    /** A search hit or permalink, centred. */
    data class Center(val index: Int) : OpenPosition()
    /** The first unread row, with its divider, at the top edge; the view is anchored from there. */
    data class Top(val index: Int) : OpenPosition()
    /** The newest row. */
    data object Bottom : OpenPosition()
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

    /**
     * 仕上げ A (MOBILE_POLISH.md S1): a search result's time as iOS writes it, the day separator's word and the time:
     * 「今日 22:16」, 「昨日 09:05」, 「9月26日 (金) 10:00」, 「2025年12月31日 (水) 10:00」 (was always 「2026年9月30日 19:50」).
     */
    fun stampLabel(iso: String, now: ZonedDateTime = ZonedDateTime.now()): String {
        val at = parse(iso, now.zone) ?: return ""
        return dateLabel(at.toLocalDate(), now.toLocalDate()) + " " + at.format(TIME)
    }

    /**
     * C3 (MOBILE_POLISH.md): the thread line's 「最終返信 今日 14:05」 (「最終返信 昨日 09:05」, 「最終返信 9月26日 (金) 14:05」),
     * as the web's lastReplyLabel; empty for a time it cannot read.
     */
    fun lastReplyLabel(iso: String, now: ZonedDateTime = ZonedDateTime.now()): String =
        stampLabel(iso, now).takeIf { it.isNotEmpty() }?.let { "最終返信 $it" } ?: ""

    /** C3: the first three repliers shown as avatars (the list is most recent first, without repeats). */
    fun replierAvatars(ids: List<String>): List<String> = ids.distinct().take(3)

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

    /**
     * M47 「連続した投稿をまとめる」: whether `message` goes under `previous` without its picture and name. The same
     * sender, people's posts (a system row keeps its own header), the same day and less than GROUP_WINDOW_SECONDS apart.
     * In the channel a reply also sent to it (M15c) keeps its own header; in a thread every row is a reply. Callers
     * pass a null `previous` after a separator (a day, 「新着メッセージ」, 「新しい返信」).
     * Pending messages group like sent ones: my second message must not show the header until the server confirms it
     * and then drop it (the jolt when sending several in a row).
     */
    fun continues(previous: MessageState?, message: MessageState, zone: ZoneId = ZoneId.systemDefault(), inThread: Boolean = false): Boolean {
        if (previous == null || previous.senderId != message.senderId) return false
        if (previous.type != "user" || message.type != "user") return false
        if (!inThread && (previous.isReply || message.isReply)) return false
        val at = parse(message.createdAt, zone) ?: return false
        val before = parse(previous.createdAt, zone) ?: return false
        return at.toLocalDate() == before.toLocalDate() && kotlin.math.abs(at.toEpochSecond() - before.toEpochSecond()) < GROUP_WINDOW_SECONDS
    }

    /** `grouping` is this device's 「連続した投稿をまとめる」 (M47, off by default): off, every message has its own header. */
    fun build(
        messages: List<MessageState>,
        firstUnreadAfterSeq: Int?,
        meId: String?,
        today: LocalDate = LocalDate.now(),
        zone: ZoneId = ZoneId.systemDefault(),
        grouping: Boolean = false,
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
            items.add(TimelineItem.Message(message, grouping && continues(previous, message, zone)))
            previous = message
        }
        return items
    }

    /**
     * The item showing a message. Rows are keyed by rowKey (client_msg_id), so a message id never equals a key:
     * lookups go through the message (§10.3). -1 when the message has no row.
     */
    fun indexOf(items: List<TimelineItem>, messageId: String): Int = items.indexOfFirst { (it as? TimelineItem.Message)?.message?.id == messageId }

    /** The item to put at the top edge for a message: its 「新着メッセージ」 divider when it has one (items are reversed). */
    fun topOf(items: List<TimelineItem>, messageId: String): Int {
        val index = indexOf(items, messageId)
        return if (index >= 0 && items.getOrNull(index + 1) is TimelineItem.UnreadSeparator) index + 1 else index
    }

    /**
     * SYNC_PROTOCOL.md §10.1 rule 4: a focus (search hit, permalink) is centred; else the row the divider precedes
     * goes to the top; else the newest row. `items` are the reversed build of `rows` with divider `mark` (null when
     * not drawn).
     */
    fun openPosition(items: List<TimelineItem>, rows: List<MessageState>, focusId: String?, mark: Int?, meId: String?): OpenPosition {
        if (focusId != null) return indexOf(items, focusId).let { if (it >= 0) OpenPosition.Center(it) else OpenPosition.Bottom }
        val first = mark?.let { ReadGate.firstUnreadRow(rows, it, meId) } ?: return OpenPosition.Bottom
        val index = topOf(items, first.id)
        return if (index >= 0) OpenPosition.Top(index) else OpenPosition.Bottom
    }

    /**
     * How far (dp) from the newest edge still counts as at it: a reader a hair off the edge (a fling that stopped a few
     * pixels short) still sees the arriving row.
     */
    const val NEWEST_EDGE_SLOP_DP = 8

    /** At the newest edge of a list laid out from the bottom (the channel): its newest item first and not scrolled off. */
    fun atNewestEdge(firstVisibleIndex: Int, firstVisibleOffset: Int, slopPx: Int): Boolean = firstVisibleIndex == 0 && firstVisibleOffset <= slopPx

    /**
     * Rows came in at the newest end: the newest key changed and the row that was newest is still there, now further
     * from that end (not a reload, a switch of conversation or a deletion of the newest row). Keys newest first.
     */
    fun arrivedAtNewest(beforeNewestFirst: List<String>, afterNewestFirst: List<String>): Boolean {
        val old = beforeNewestFirst.firstOrNull() ?: return false
        val new = afterNewestFirst.firstOrNull() ?: return false
        return old != new && afterNewestFirst.indexOf(old) > 0
    }

    /**
     * §10.1 2-4: a row that arrives while the reader is at the newest edge is shown there (the list follows it), so it
     * is read like any row on screen and never becomes 「新着 N 件」 below a reader who did not move. Not before the open
     * positioning, while a positioning scroll lands, or over a search position. A reader scrolled up stays where they
     * are (and gets 「新着 N 件」).
     */
    fun followsArrival(atNewestEdge: Boolean, arrived: Boolean, positioned: Boolean, landing: Boolean = false, focused: Boolean = false): Boolean =
        atNewestEdge && arrived && positioned && !landing && !focused

    /** §10.1 rule 4: the longest an opened conversation waits for its catch-up before positioning anyway. */
    const val CATCH_UP_WAIT_MS = 3_000L

    /**
     * §10.1 rule 4: waits while `waiting` (a catch-up that may bring the first unread row is on its way), at most
     * `timeoutMs`. False when the reader scrolled first: the view is then not positioned (the list stays where they put it).
     */
    suspend fun awaitCatchUp(waiting: Flow<Boolean>, scrolled: Flow<Boolean>, timeoutMs: Long = CATCH_UP_WAIT_MS): Boolean {
        val ended = withTimeoutOrNull(timeoutMs) { combine(waiting, scrolled) { w, s -> w to s }.first { (w, s) -> !w || s } }
        return ended?.second != true
    }

    /** "1,234": ASCII commas whatever the locale (the banner's count). */
    fun group3(n: Int): String {
        val grouped = kotlin.math.abs(n.toLong()).toString().reversed().chunked(3).joinToString(",").reversed()
        return if (n < 0) "-$grouped" else grouped
    }

    /**
     * The banner's 「… 以降」 in the device's zone: "10:23" today, "昨日 23:05", else the day separator's text and the
     * time ("9月26日 (土) 09:07"). Always 24 h and zero-padded, never locale-formatted. null when unparsable.
     */
    fun sinceLabel(iso: String, now: ZonedDateTime): String? {
        val at = parse(iso, now.zone) ?: return null
        val time = String.format(Locale.ROOT, "%02d:%02d", at.hour, at.minute)
        val day = at.toLocalDate()
        val today = now.toLocalDate()
        return when (day) {
            today -> time
            today.minusDays(1) -> "昨日 $time"
            else -> dateLabel(day, today) + " " + time
        }
    }

    /** 「未読 2,000 件 · 10:23 以降」; the count alone when the server did not say when (§10.1 rule 5). */
    fun bannerText(count: Int, firstUnreadAt: String?, now: ZonedDateTime): String {
        val since = firstUnreadAt?.let { sinceLabel(it, now) }
        return "未読 ${group3(count)} 件" + if (since != null) " · $since 以降" else ""
    }

    /** "HH:mm までミュート" while a mute is active, otherwise null. */
    fun muteLabel(mutedUntil: String?, zone: ZoneId = ZoneId.systemDefault()): String? {
        val until = mutedUntil?.let { parse(it, zone) } ?: return null
        if (!until.isAfter(ZonedDateTime.now(zone))) return null
        return until.format(TIME) + " までミュート"
    }

    /** What a conversation without rows shows (M28c): the first page on its way, offline before any page, or truly empty. */
    enum class FirstPage { LOADING, OFFLINE, EMPTY }

    /** `syncedSeq` null = no page has ever arrived on this device: 「まだメッセージはありません」 would be a guess. */
    fun firstPage(syncedSeq: Int?, status: EngineStatus): FirstPage = when {
        syncedSeq != null -> FirstPage.EMPTY
        status == EngineStatus.OFFLINE -> FirstPage.OFFLINE
        else -> FirstPage.LOADING
    }
}
