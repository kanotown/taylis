package jp.chikuwachat.android.ui

import jp.chikuwachat.android.api.SearchRequest
import jp.chikuwachat.android.api.UserPublic
import jp.chikuwachat.android.platform.KeyValueStore
import jp.chikuwachat.android.sync.ChannelState
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import java.text.Collator
import java.text.Normalizer
import java.time.LocalDate
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * M16b: what a search looks for: the words (typed modifiers such as from:@ in:# stay in them, the server reads
 * them) and the filters picked from menus, sent as structured parameters (DATA_MODEL.md 検索).
 */
@Serializable
data class SearchParams(
    val q: String = "",
    val fromUserId: String? = null,
    val channelId: String? = null,
    /** A preset is resolved when the search runs, so a remembered 「今日」 stays today. */
    val date: SearchDate? = null,
    /** file / link / pin / reaction / poll, all required (AND). */
    val has: List<String> = emptyList(),
    val isThread: Boolean = false,
    /** "relevance" or "newest"; searches without words are always newest first. */
    val sort: String = Search.RELEVANCE,
)

/** 期間: a preset (today / yesterday / week / month / year), or days "YYYY-MM-DD" (both ends included). */
@Serializable
data class SearchDate(val preset: String? = null, val from: String? = null, val to: String? = null)

/** A row under the search box (same kinds and order as the desktop). */
sealed class Suggestion {
    data class Words(val q: String) : Suggestion()
    data class Recent(val params: SearchParams) : Suggestion()
    data class Person(val user: UserPublic) : Suggestion()
    data class Conversation(val channel: ChannelState) : Suggestion()
    data class Kind(val flag: String) : Suggestion()
    data object Thread : Suggestion()

    /** What choosing the row searches for; people, conversations and kinds list the newest first. */
    fun toParams(): SearchParams = when (this) {
        is Words -> SearchParams(q = q)
        is Recent -> params
        is Person -> SearchParams(fromUserId = user.id, sort = Search.NEWEST)
        is Conversation -> SearchParams(channelId = channel.id, sort = Search.NEWEST)
        is Kind -> SearchParams(has = listOf(flag), sort = Search.NEWEST)
        Thread -> SearchParams(isThread = true, sort = Search.NEWEST)
    }
}

/** M16b: conditions, date presets, labels and suggestions of the search screen (mirrors the desktop's search.ts). */
object Search {
    const val RELEVANCE = "relevance"
    const val NEWEST = "newest"

    val HAS_FLAGS = listOf("file", "link", "pin", "reaction", "poll")
    val HAS_LABELS = mapOf("file" to "ファイルあり", "link" to "リンクあり", "pin" to "ピン留め", "reaction" to "リアクションあり", "poll" to "投票")

    /** 期間 presets: how many days before today the range starts. */
    val DATE_PRESETS = listOf("today" to "今日", "yesterday" to "昨日", "week" to "過去 7 日間", "month" to "過去 30 日間", "year" to "過去 1 年間")
    private val DAYS_BACK = mapOf("today" to 0L, "yesterday" to 1L, "week" to 6L, "month" to 29L, "year" to 364L)

    private val ISO: DateTimeFormatter = DateTimeFormatter.ISO_OFFSET_DATE_TIME

    fun hasFilters(params: SearchParams): Boolean =
        params.fromUserId != null || params.channelId != null || params.date != null || params.has.isNotEmpty() || params.isThread

    /** Nothing to look for: no words and no filters (the server refuses it as empty_query). */
    fun isEmpty(params: SearchParams): Boolean = params.q.isBlank() && !hasFilters(params)

    /** 「条件をクリア」: the same words and order without any filter. */
    fun cleared(params: SearchParams): SearchParams = SearchParams(q = params.q, sort = params.sort)

    /**
     * The instants the API filters on, in the viewer's days: `after` inclusive (that day's local midnight),
     * `before` exclusive (the local midnight after the last day). Null where the range is open.
     */
    fun dateRange(date: SearchDate?, now: ZonedDateTime = ZonedDateTime.now()): Pair<String?, String?> {
        if (date == null) return null to null
        val zone = now.zone
        val today = now.toLocalDate()
        if (date.preset != null) {
            val back = DAYS_BACK[date.preset] ?: return null to null
            val after = today.minusDays(back).atStartOfDay(zone)
            val before = if (date.preset == "yesterday") today.atStartOfDay(zone) else null
            return after.format(ISO) to before?.format(ISO)
        }
        val from = day(date.from)
        val to = day(date.to)
        return from?.atStartOfDay(zone)?.format(ISO) to to?.plusDays(1)?.atStartOfDay(zone)?.format(ISO)
    }

    private fun day(value: String?): LocalDate? = value?.let { runCatching { LocalDate.parse(it) }.getOrNull() }

    /** The chip text for the date filter: 「過去 7 日間」, 「2026/09/01 〜 2026/09/15」, 「2026/09/01 以降」. */
    fun dateLabel(date: SearchDate?): String? {
        if (date == null) return null
        if (date.preset != null) return DATE_PRESETS.firstOrNull { it.first == date.preset }?.second
        val from = date.from?.replace("-", "/")
        val to = date.to?.replace("-", "/")
        return when {
            from != null && to != null -> if (from == to) from else "$from 〜 $to"
            from != null -> "$from 以降"
            to != null -> "$to まで"
            else -> null
        }
    }

    /** GET /search/messages parameters; searches without words are always newest first. */
    fun toQuery(params: SearchParams, now: ZonedDateTime = ZonedDateTime.now()): SearchRequest {
        val q = params.q.trim()
        val (after, before) = dateRange(params.date, now)
        return SearchRequest(
            q = q,
            channelId = params.channelId,
            fromUserId = params.fromUserId,
            after = after,
            before = before,
            has = params.has.filter { it in HAS_FLAGS },
            isThread = params.isThread,
            sort = if (q.isEmpty()) NEWEST else params.sort,
        )
    }

    /** 「123 件」, or 「1,000 件以上」 when the server stopped counting. */
    fun totalLabel(total: Int, capped: Boolean): String = String.format(Locale.JAPAN, "%,d 件", total) + if (capped) "以上" else ""

    /** One line for a search: the words, then the filters (「設計」 · 送信者: 田中 · #general · 過去 7 日間). */
    fun describe(params: SearchParams, userName: (String) -> String?, channelName: (String) -> String?): String {
        val parts = ArrayList<String>()
        params.q.trim().takeIf { it.isNotEmpty() }?.let(parts::add)
        params.fromUserId?.let { parts.add("送信者: " + (userName(it) ?: "?")) }
        params.channelId?.let { parts.add(channelName(it) ?: "?") }
        dateLabel(params.date)?.let(parts::add)
        params.has.forEach { flag -> HAS_LABELS[flag]?.let(parts::add) }
        if (params.isThread) parts.add("スレッド内")
        return parts.joinToString(" · ")
    }

    /** Width-insensitive, case-insensitive text for matching names (ｔａｎａｋａ = tanaka). */
    fun fold(value: String): String = Normalizer.normalize(value, Normalizer.Form.NFKC).lowercase(Locale.ROOT)

    /**
     * Empty box: recent searches, then quick filters. While typing: search for the words, then people (→ 送信者)
     * and conversations I am in (→ チャンネル) whose names match, then matching recent searches.
     */
    fun suggestions(
        input: String,
        users: Collection<UserPublic>,
        channels: Collection<ChannelState>,
        recent: List<SearchParams>,
        channelTitle: (ChannelState) -> String,
    ): List<Suggestion> {
        val text = input.trim()
        if (text.isEmpty()) {
            // All the remembered ones (IMPLEMENTATION_PLAN.md M16b: 10); the full-screen list has room for them.
            return recent.take(RecentSearches.MAX).map { Suggestion.Recent(it) } +
                HAS_FLAGS.take(3).map { Suggestion.Kind(it) } +
                Suggestion.Thread
        }
        val collator = Collator.getInstance(Locale.JAPANESE)
        val needle = fold(text.removePrefix("@").removePrefix("#"))
        val people = users
            .filter { it.deactivatedAt == null && (fold(it.displayName).contains(needle) || fold(it.username).contains(needle)) }
            .sortedWith(compareBy<UserPublic> { !fold(it.username).startsWith(needle) }.thenComparator { a, b -> collator.compare(a.displayName, b.displayName) })
            .take(4)
            .map { Suggestion.Person(it) }
        val conversations = channels
            .filter { it.isMember && fold(channelTitle(it)).contains(needle) }
            .sortedWith { a, b -> collator.compare(channelTitle(a), channelTitle(b)) }
            .take(4)
            .map { Suggestion.Conversation(it) }
        val folded = fold(text)
        val earlier = recent
            .filter { it.q.isNotEmpty() && fold(it.q).contains(folded) && it.q != text }
            .take(3)
            .map { Suggestion.Recent(it) }
        return listOf(Suggestion.Words(text)) + people + conversations + earlier
    }
}

/** M16b: the last searches of one account on this device (`chikuwa.search.recent:<server>|<username>`), newest first. */
object RecentSearches {
    const val MAX = 10

    private val json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
        encodeDefaults = false
    }
    private val serializer = ListSerializer(SearchParams.serializer())

    fun key(account: String): String = "chikuwa.search.recent:$account"

    fun read(store: KeyValueStore, key: String): List<SearchParams> {
        val raw = store.getString(key) ?: return emptyList()
        val list = runCatching { json.decodeFromString(serializer, raw) }.getOrNull() ?: return emptyList()
        return list.map { it.copy(has = it.has.filter { flag -> flag in Search.HAS_FLAGS }) }.take(MAX)
    }

    /** Puts the search first (once; the order does not make it a different search) and returns the new list. */
    fun push(store: KeyValueStore, key: String, params: SearchParams): List<SearchParams> {
        if (Search.isEmpty(params)) return read(store, key)
        val entry = params.copy(q = params.q.trim())
        val next = (listOf(entry) + read(store, key).filterNot { same(it, entry) }).take(MAX)
        write(store, key, next)
        return next
    }

    fun remove(store: KeyValueStore, key: String, params: SearchParams): List<SearchParams> {
        val next = read(store, key).filterNot { same(it, params) }
        write(store, key, next)
        return next
    }

    fun clear(store: KeyValueStore, key: String) = store.putString(key, null)

    private fun same(a: SearchParams, b: SearchParams): Boolean = a.copy(sort = "") == b.copy(sort = "")

    private fun write(store: KeyValueStore, key: String, list: List<SearchParams>) =
        store.putString(key, if (list.isEmpty()) null else json.encodeToString(serializer, list))
}
