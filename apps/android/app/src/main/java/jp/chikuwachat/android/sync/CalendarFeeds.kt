package jp.chikuwachat.android.sync

import jp.chikuwachat.android.api.CalendarFeedOut
import jp.chikuwachat.android.ui.CalendarDates
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/** The 「カレンダーを購読 (iCal)」 screen's state. */
data class CalendarFeedsState(
    /** My feeds, oldest first (null: not read yet). */
    val feeds: List<CalendarFeedOut>? = null,
    /** The URL just made: shown this once (the server keeps only a hash of its token). */
    val made: String? = null,
    val busy: Boolean = false,
    /** The last failure (the screen words it with the shared error table), cleared by the next action. */
    val error: Throwable? = null,
)

/**
 * M69 (CALENDAR.md §10.6, §10.9): my private iCal feed URLs, as the desktop's CalendarFeedsDialog. Make one (everything I
 * see, or my own calendar only), show its URL once, list them (scope, when made, when last read) and delete them (the URL
 * stops at once). Nothing is kept on the device: the screen reads the list each time it opens.
 */
class CalendarFeeds(private val api: CalendarFeedApi?) {
    private val _state = MutableStateFlow(CalendarFeedsState())
    val state: StateFlow<CalendarFeedsState> = _state

    val available: Boolean get() = api != null

    private fun update(change: (CalendarFeedsState) -> CalendarFeedsState) {
        _state.value = change(_state.value)
    }

    private suspend fun run(block: suspend (CalendarFeedApi) -> Unit) {
        val api = api ?: return
        if (_state.value.busy) return
        update { it.copy(busy = true, error = null) }
        try {
            block(api)
            update { it.copy(busy = false) }
        } catch (e: CancellationException) {
            update { it.copy(busy = false) }
            throw e
        } catch (e: Exception) {
            update { it.copy(busy = false, error = e) }
        }
    }

    suspend fun load() = run { api ->
        val feeds = api.calendarFeeds()
        update { it.copy(feeds = feeds) }
    }

    /** `scope`: [SCOPE_ALL] or [SCOPE_PERSONAL]. The new URL replaces the one shown before (that one is in the list). */
    suspend fun create(scope: String) = run { api ->
        val created = api.createCalendarFeed(scope)
        update { it.copy(made = created.url, feeds = (it.feeds ?: emptyList()).filter { f -> f.id != created.feed.id } + created.feed) }
    }

    suspend fun delete(feedId: String) = run { api ->
        api.deleteCalendarFeed(feedId)
        update { it.copy(feeds = it.feeds?.filter { f -> f.id != feedId }) }
    }

    /** The URL shown once is put away (the screen closed). */
    fun forgetMade() = update { it.copy(made = null) }

    companion object {
        const val SCOPE_ALL = "all"
        const val SCOPE_PERSONAL = "personal"
        const val MAX_FEEDS = 5

        fun scopeLabel(scope: String): String = if (scope == SCOPE_PERSONAL) "自分のカレンダーだけ" else "すべて"

        private fun shortDate(iso: String): String =
            runCatching { CalendarDates.localDay(iso).let { "${it.year}/${it.monthValue}/${it.dayOfMonth}" } }.getOrDefault("")

        /** A row's second line: 「2026/10/2 に作成 ・ 2026/10/3 に読まれました」 (or 「まだ読まれていません」). */
        fun feedLine(feed: CalendarFeedOut): String =
            "${shortDate(feed.createdAt)} に作成 ・ " + (feed.lastUsedAt?.let { "${shortDate(it)} に読まれました" } ?: "まだ読まれていません")

        /** The choices when making one. */
        val SCOPE_CHOICES = listOf(
            SCOPE_ALL to "すべて (自分のカレンダーと参加しているチャンネル)",
            SCOPE_PERSONAL to "自分のカレンダーだけ",
        )
    }
}
