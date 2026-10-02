package jp.chikuwachat.android

import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.CalendarFeedOut
import jp.chikuwachat.android.api.ErrorMessages
import jp.chikuwachat.android.sync.CalendarFeeds
import jp.chikuwachat.android.ui.BarMenu
import jp.chikuwachat.android.ui.BarMenuItem
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** M69 (CALENDAR.md §10.6, §10.9): 「カレンダーを購読 (iCal)」's state against the fake server, and its words. */
class CalendarFeedsTest {
    @get:Rule val tokyo = TokyoZone()

    private fun feeds(): Pair<FakeServer, CalendarFeeds> {
        val server = FakeServer()
        val bob = server.addUser("bob")
        return server to CalendarFeeds(server.api(bob.id))
    }

    @Test
    fun makesShowsTheUrlOnceListsAndDeletes() = runBlocking {
        val (server, feeds) = feeds()
        assertNull(feeds.state.value.feeds)
        feeds.load()
        assertEquals(emptyList<CalendarFeedOut>(), feeds.state.value.feeds)

        feeds.create(CalendarFeeds.SCOPE_ALL)
        val first = feeds.state.value
        assertEquals("https://chat.example/api/v1/calendar/ical/token1.ics", first.made)
        assertEquals(listOf("all"), first.feeds!!.map { it.scope })
        assertFalse(first.busy)

        // A second one: its URL replaces the one shown (the first is in the list, its URL never again).
        feeds.create(CalendarFeeds.SCOPE_PERSONAL)
        assertEquals("https://chat.example/api/v1/calendar/ical/token2.ics", feeds.state.value.made)
        assertEquals(listOf("all", "personal"), feeds.state.value.feeds!!.map { it.scope })

        // Read again (the screen opened again): the server's list, without URLs.
        feeds.forgetMade()
        feeds.load()
        assertNull(feeds.state.value.made)
        assertEquals(2, feeds.state.value.feeds!!.size)

        val id = feeds.state.value.feeds!!.first().id
        feeds.delete(id)
        assertEquals(listOf("personal"), feeds.state.value.feeds!!.map { it.scope })
        assertEquals(1, server.calendarFeedsOf.values.single().size)
    }

    @Test
    fun theLimitAndAFeedGoneAreSaidWithTheSharedTable() = runBlocking {
        val (_, feeds) = feeds()
        feeds.load()
        repeat(CalendarFeeds.MAX_FEEDS) { feeds.create(CalendarFeeds.SCOPE_ALL) }
        assertNull(feeds.state.value.error)
        feeds.create(CalendarFeeds.SCOPE_ALL)
        val error = feeds.state.value.error as ApiException.Api
        assertEquals("calendar_feed_limit", error.code)
        assertEquals("購読 URL は 5 個までです。使っていないものを削除してください", ErrorMessages.byCode[error.code])
        assertEquals(5, feeds.state.value.feeds!!.size)
        // The next action clears it; deleting one that is gone (another device) says so.
        feeds.delete("nope")
        assertEquals("calendar_feed_not_found", (feeds.state.value.error as ApiException.Api).code)
        assertEquals("購読 URL が見つかりません", ErrorMessages.byCode["calendar_feed_not_found"])
        feeds.load()
        assertNull(feeds.state.value.error)
    }

    @Test
    fun withoutTheApiNothingHappens() = runBlocking {
        val feeds = CalendarFeeds(null)
        assertFalse(feeds.available)
        feeds.load()
        feeds.create(CalendarFeeds.SCOPE_ALL)
        assertNull(feeds.state.value.feeds)
        assertNull(feeds.state.value.made)
    }

    @Test
    fun theRowsWordsAndTheMenu() {
        assertEquals("すべて", CalendarFeeds.scopeLabel("all"))
        assertEquals("自分のカレンダーだけ", CalendarFeeds.scopeLabel("personal"))
        // Days in the device's zone (03:00Z is noon in Tokyo; 20:00Z is the next day there).
        assertEquals("2026/10/2 に作成 ・ まだ読まれていません", CalendarFeeds.feedLine(CalendarFeedOut("f", "all", "2026-10-02T03:00:00Z", null)))
        assertEquals("2026/10/2 に作成 ・ 2026/10/4 に読まれました", CalendarFeeds.feedLine(CalendarFeedOut("f", "all", "2026-10-02T03:00:00Z", "2026-10-03T20:00:00Z")))
        // 「カレンダーを購読 (iCal)」 is the calendar page's ⋮ (and only there).
        assertEquals(listOf(BarMenuItem.CALENDAR_FEEDS), BarMenu.items(conversation = false, channel = false, archived = false, activityFeed = false, calendar = true))
        assertTrue(BarMenuItem.CALENDAR_FEEDS !in BarMenu.items(conversation = true, channel = true, archived = false, activityFeed = false))
    }
}
