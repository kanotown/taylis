package jp.chikuwachat.android

import jp.chikuwachat.android.api.ApiClient
import jp.chikuwachat.android.api.ChannelOut
import jp.chikuwachat.android.api.SearchRequest
import jp.chikuwachat.android.api.UserPublic
import jp.chikuwachat.android.sync.ChannelState
import jp.chikuwachat.android.ui.RecentSearches
import jp.chikuwachat.android.ui.Search
import jp.chikuwachat.android.ui.SearchDate
import jp.chikuwachat.android.ui.SearchParams
import jp.chikuwachat.android.ui.Suggestion
import kotlinx.coroutines.runBlocking
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneId
import java.time.ZonedDateTime

/** M16b: the search screen's conditions, dates, labels, recent searches and suggestions. */
class SearchTest {
    private val tokyo = ZoneId.of("Asia/Tokyo")
    private val now = ZonedDateTime.of(2026, 9, 27, 15, 30, 0, 0, tokyo)

    @Test fun presetsStartAtLocalMidnightAndYesterdayEndsToday() {
        assertEquals("2026-09-27T00:00:00+09:00" to null, Search.dateRange(SearchDate(preset = "today"), now))
        assertEquals("2026-09-26T00:00:00+09:00" to "2026-09-27T00:00:00+09:00", Search.dateRange(SearchDate(preset = "yesterday"), now))
        assertEquals("2026-09-21T00:00:00+09:00" to null, Search.dateRange(SearchDate(preset = "week"), now)) // today and the 6 days before
        assertEquals("2026-08-29T00:00:00+09:00" to null, Search.dateRange(SearchDate(preset = "month"), now))
        assertEquals("2025-09-28T00:00:00+09:00" to null, Search.dateRange(SearchDate(preset = "year"), now))
        assertEquals(null to null, Search.dateRange(SearchDate(preset = "decade"), now))
        assertEquals(null to null, Search.dateRange(null, now))
    }

    @Test fun customRangesIncludeBothDaysInTheDeviceZone() {
        // `before` is the local midnight after the last day (exclusive), `after` the first day's (inclusive).
        assertEquals("2026-09-01T00:00:00+09:00" to "2026-09-16T00:00:00+09:00", Search.dateRange(SearchDate(from = "2026-09-01", to = "2026-09-15"), now))
        assertEquals("2026-09-01T00:00:00+09:00" to null, Search.dateRange(SearchDate(from = "2026-09-01"), now))
        assertEquals(null to "2026-09-02T00:00:00+09:00", Search.dateRange(SearchDate(to = "2026-09-01"), now))
        assertEquals(null to null, Search.dateRange(SearchDate(from = "9/1"), now))
        // A day that starts in summer time and ends in winter time keeps each midnight's own offset.
        val newYork = ZonedDateTime.of(2026, 11, 2, 12, 0, 0, 0, ZoneId.of("America/New_York"))
        assertEquals("2026-10-31T00:00:00-04:00" to "2026-11-02T00:00:00-05:00", Search.dateRange(SearchDate(from = "2026-10-31", to = "2026-11-01"), newYork))
        assertEquals("2026-11-01T00:00:00-04:00" to "2026-11-02T00:00:00-05:00", Search.dateRange(SearchDate(preset = "yesterday"), newYork))
    }

    @Test fun dateLabels() {
        assertEquals("過去 7 日間", Search.dateLabel(SearchDate(preset = "week")))
        assertEquals("2026/09/01 〜 2026/09/15", Search.dateLabel(SearchDate(from = "2026-09-01", to = "2026-09-15")))
        assertEquals("2026/09/01", Search.dateLabel(SearchDate(from = "2026-09-01", to = "2026-09-01")))
        assertEquals("2026/09/01 以降", Search.dateLabel(SearchDate(from = "2026-09-01")))
        assertEquals("2026/09/15 まで", Search.dateLabel(SearchDate(to = "2026-09-15")))
        assertNull(Search.dateLabel(null))
    }

    @Test fun queriesWithoutWordsAreNewestFirst() {
        val words = Search.toQuery(SearchParams(q = "  設計 レビュー ", sort = Search.RELEVANCE), now)
        assertEquals(SearchRequest(q = "設計 レビュー", sort = Search.RELEVANCE), words)
        val filtersOnly = Search.toQuery(
            SearchParams(fromUserId = "u1", channelId = "c1", date = SearchDate(preset = "today"), has = listOf("file", "video", "link"), isThread = true, sort = Search.RELEVANCE),
            now,
        )
        assertEquals(
            SearchRequest(q = "", channelId = "c1", fromUserId = "u1", after = "2026-09-27T00:00:00+09:00", has = listOf("file", "link"), isThread = true, sort = Search.NEWEST),
            filtersOnly,
        )
        assertEquals(Search.NEWEST, Search.toQuery(SearchParams(q = "x", sort = Search.NEWEST), now).sort)
    }

    @Test fun emptinessFiltersAndClearing() {
        assertTrue(Search.isEmpty(SearchParams(q = "   ")))
        assertFalse(Search.isEmpty(SearchParams(isThread = true)))
        assertFalse(Search.hasFilters(SearchParams(q = "x")))
        assertTrue(Search.hasFilters(SearchParams(date = SearchDate(preset = "today"))))
        assertEquals(SearchParams(q = "x", sort = Search.NEWEST), Search.cleared(SearchParams(q = "x", fromUserId = "u", has = listOf("pin"), sort = Search.NEWEST)))
    }

    @Test fun totalsAndDescriptions() {
        assertEquals("0 件", Search.totalLabel(0, false))
        assertEquals("123 件", Search.totalLabel(123, false))
        assertEquals("12,345 件", Search.totalLabel(12345, false))
        assertEquals("1,000 件以上", Search.totalLabel(1000, true))
        val params = SearchParams(q = " 設計 ", fromUserId = "u1", channelId = "c1", date = SearchDate(preset = "week"), has = listOf("file", "pin"), isThread = true)
        assertEquals(
            "設計 · 送信者: 田中 · #general · 過去 7 日間 · ファイルあり · ピン留め · スレッド内",
            Search.describe(params, userName = { if (it == "u1") "田中" else null }, channelName = { if (it == "c1") "#general" else null }),
        )
        assertEquals("送信者: ?", Search.describe(SearchParams(fromUserId = "gone"), { null }, { null }))
    }

    @Test fun recentSearchesAreNewestFirstWithoutDuplicatesAndPerAccount() {
        val store = MemoryStore()
        val key = RecentSearches.key("https://chat.example.com|alice")
        assertEquals("chikuwa.search.recent:https://chat.example.com|alice", key)
        RecentSearches.push(store, key, SearchParams(q = "設計"))
        RecentSearches.push(store, key, SearchParams(fromUserId = "u1", sort = Search.NEWEST))
        // The same search in another order is not a second entry; it moves to the top with its new words trimmed.
        val list = RecentSearches.push(store, key, SearchParams(q = " 設計 ", sort = Search.NEWEST))
        assertEquals(listOf(SearchParams(q = "設計", sort = Search.NEWEST), SearchParams(fromUserId = "u1", sort = Search.NEWEST)), list)
        assertEquals(list, RecentSearches.read(store, key))
        // Nothing to look for is not remembered.
        assertEquals(list, RecentSearches.push(store, key, SearchParams(q = "  ")))
        // At most 10.
        repeat(12) { RecentSearches.push(store, key, SearchParams(q = "q$it")) }
        val full = RecentSearches.read(store, key)
        assertEquals(RecentSearches.MAX, full.size)
        assertEquals("q11", full.first().q)
        // Removing one and clearing all.
        assertEquals(9, RecentSearches.remove(store, key, SearchParams(q = "q11", sort = Search.NEWEST)).size)
        assertTrue(RecentSearches.read(store, RecentSearches.key("https://chat.example.com|bob")).isEmpty())
        RecentSearches.clear(store, key)
        assertTrue(RecentSearches.read(store, key).isEmpty())
        assertNull(store.getString(key))
    }

    @Test fun recentSearchesSurviveOddStoredValues() {
        val key = RecentSearches.key("s|u")
        assertTrue(RecentSearches.read(MemoryStore(mapOf(key to "not json")), key).isEmpty())
        val stored = """[{"q":"x","has":["file","video"],"date":{"preset":"week"},"extra":1},{"is_thread":true}]"""
        val read = RecentSearches.read(MemoryStore(mapOf(key to stored)), key)
        assertEquals(listOf(SearchParams(q = "x", has = listOf("file"), date = SearchDate(preset = "week")), SearchParams()), read)
    }

    private fun user(id: String, username: String, name: String, deactivated: Boolean = false) =
        UserPublic(id = id, username = username, displayName = name, role = "member", deactivatedAt = if (deactivated) "2026-01-01T00:00:00Z" else null, createdAt = "", updatedAt = "")

    private fun channel(id: String, name: String, member: Boolean = true) =
        ChannelState(ChannelOut(id = id, type = "public", name = name, createdBy = "u", createdAt = "", updatedAt = "", lastSeq = 0, archived = false), isMember = member)

    @Test fun emptyBoxSuggestsRecentSearchesThenQuickFilters() {
        val recent = (1..12).map { SearchParams(q = "r$it") }
        val rows = Search.suggestions("  ", emptyList(), emptyList(), recent) { "" }
        assertEquals(recent.take(10).map { Suggestion.Recent(it) } + listOf(Suggestion.Kind("file"), Suggestion.Kind("link"), Suggestion.Kind("pin"), Suggestion.Thread, Suggestion.Times), rows)
    }

    @Test fun typingSuggestsTheWordsPeopleConversationsAndMatchingRecentSearches() {
        val users = listOf(
            user("u1", "kotaro", "Kotaro Tanaka"),
            user("u2", "tanaka", "田中 太郎"),
            user("u3", "tanabe", "田辺", deactivated = true),
            user("u4", "suzuki", "鈴木"),
        )
        val channels = listOf(channel("c1", "tanaka-lab"), channel("c2", "general"), channel("c3", "tanaka-open", member = false))
        val recent = listOf(SearchParams(q = "tana"), SearchParams(q = "tanaka 設計"), SearchParams(q = "other"))
        val rows = Search.suggestions("ｔａｎａ", users, channels, recent) { "#" + (it.channel.name ?: "") }
        assertEquals(Suggestion.Words("ｔａｎａ"), rows.first())
        // Deactivated people and conversations I am not in are left out; a username starting with the text comes first.
        assertEquals(listOf("u2", "u1"), rows.filterIsInstance<Suggestion.Person>().map { it.user.id })
        assertEquals(listOf("c1"), rows.filterIsInstance<Suggestion.Conversation>().map { it.channel.id })
        assertEquals(listOf("tana", "tanaka 設計"), rows.filterIsInstance<Suggestion.Recent>().map { it.params.q })
        // "#" and "@" in front of the text are ignored for names; the exact words are not suggested again.
        val hashRows = Search.suggestions("#gen", users, channels, listOf(SearchParams(q = "#gen"))) { "#" + (it.channel.name ?: "") }
        assertEquals(listOf("c2"), hashRows.filterIsInstance<Suggestion.Conversation>().map { it.channel.id })
        assertTrue(hashRows.none { it is Suggestion.Recent })
    }

    @Test fun choosingASuggestionSearches() {
        assertEquals(SearchParams(q = "x"), Suggestion.Words("x").toParams())
        assertEquals(SearchParams(fromUserId = "u1", sort = Search.NEWEST), Suggestion.Person(user("u1", "a", "A")).toParams())
        assertEquals(SearchParams(channelId = "c1", sort = Search.NEWEST), Suggestion.Conversation(channel("c1", "g")).toParams())
        assertEquals(SearchParams(has = listOf("link"), sort = Search.NEWEST), Suggestion.Kind("link").toParams())
        assertEquals(SearchParams(isThread = true, sort = Search.NEWEST), Suggestion.Thread.toParams())
        val saved = SearchParams(q = "y", isThread = true)
        assertEquals(saved, Suggestion.Recent(saved).toParams())
    }

    private fun stubbed(handler: (Request) -> Pair<Int, String>): OkHttpClient =
        OkHttpClient.Builder().addInterceptor(Interceptor { chain ->
            val (status, body) = handler(chain.request())
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(status).message("stub")
                .body(body.toResponseBody("application/json".toMediaType())).build()
        }).build()

    @Test fun searchSendsStructuredFiltersAndReadsTheTotal() = runBlocking {
        var seen: okhttp3.HttpUrl? = null
        val client = ApiClient("http://server", stubbed { request ->
            seen = request.url
            200 to """{"hits":[],"keywords":["設計"],"filters":{"text":"設計","has":["file","link"],"is_thread":true,"unresolved":["from:@nobody"]},
                "limit":30,"offset":30,"has_more":true,"total":1000,"total_capped":true}"""
        })
        client.accessToken = "a"
        val out = client.searchMessages(
            SearchRequest(q = "設計 from:@nobody", channelId = "c1", fromUserId = "u1", after = "2026-09-21T00:00:00+09:00", before = "2026-09-28T00:00:00+09:00", has = listOf("file", "link"), isThread = true, sort = "newest"),
            limit = 30, offset = 30,
        )
        val url = seen!!
        assertEquals("/api/v1/search/messages", url.encodedPath)
        assertEquals("設計 from:@nobody", url.queryParameter("q"))
        assertEquals(listOf("file", "link"), url.queryParameterValues("has"))
        assertEquals("true", url.queryParameter("is_thread"))
        assertEquals("newest", url.queryParameter("sort"))
        assertEquals("c1", url.queryParameter("channel_id"))
        assertEquals("u1", url.queryParameter("from_user_id"))
        assertEquals("2026-09-21T00:00:00+09:00", url.queryParameter("after")) // "+" survives the query string
        assertEquals("2026-09-28T00:00:00+09:00", url.queryParameter("before"))
        assertEquals("30", url.queryParameter("limit"))
        assertEquals("30", url.queryParameter("offset"))
        assertTrue(url.queryParameter("tz_offset_minutes") != null)
        assertEquals(1000, out.total)
        assertTrue(out.totalCapped)
        assertEquals(listOf("from:@nobody"), out.filters?.unresolved)

        client.searchMessages(SearchRequest(q = "", isThread = false, sort = "newest"))
        assertNull(seen!!.queryParameter("is_thread"))
        assertEquals(emptyList<String>(), seen!!.queryParameterValues("has"))
        assertEquals("", seen!!.queryParameter("q"))
    }
}
