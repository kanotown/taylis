package jp.chikuwachat.android

import jp.chikuwachat.android.ui.BarMenu
import jp.chikuwachat.android.ui.BarMenuItem
import jp.chikuwachat.android.ui.DownloadCache
import jp.chikuwachat.android.ui.Timeline
import jp.chikuwachat.android.ui.messageLine
import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.ZoneId
import java.time.ZonedDateTime

/** 仕上げ A (MOBILE_POLISH.md C6, V1, X1, S1): the Android fixes' pure parts. */
class PolishATest {
    // --- C6: the app bar's ⋮ ---

    @Test
    fun aChannelsMenuHoldsOnlyItsOwnActions() {
        assertEquals(
            listOf(BarMenuItem.FAVORITE, BarMenuItem.NOTIFICATIONS, BarMenuItem.DETAILS, BarMenuItem.ADD_MEMBER),
            BarMenu.items(conversation = true, channel = true, archived = false, activityFeed = false),
        )
        // Nobody is added to an archived channel or a DM.
        assertEquals(
            listOf(BarMenuItem.FAVORITE, BarMenuItem.NOTIFICATIONS, BarMenuItem.DETAILS),
            BarMenu.items(conversation = true, channel = true, archived = true, activityFeed = false),
        )
        assertEquals(
            listOf(BarMenuItem.FAVORITE, BarMenuItem.NOTIFICATIONS, BarMenuItem.DETAILS),
            BarMenu.items(conversation = true, channel = false, archived = false, activityFeed = false),
        )
    }

    @Test
    fun theActivityTabAndOtherScreensHaveNoMenu() {
        // 2026-10-07 (MOBILE_UI.md §6.4): the activity's 「すべて既読にする」 is its header's button, not the ⋮.
        assertEquals(emptyList<BarMenuItem>(), BarMenu.items(conversation = false, channel = false, archived = false, activityFeed = true))
        // A thread, the details page, the DM tab, the home's lists: the app-wide actions are the home's ⋮ and the 自分 tab's.
        assertEquals(emptyList<BarMenuItem>(), BarMenu.items(conversation = false, channel = true, archived = false, activityFeed = false))
    }

    // --- V1: the downloaded file's name ---

    @Test
    fun aDownloadKeepsItsOwnNameInAFolderPerAttachment() {
        assertEquals("01a0f275-aaaa/ゼミ資料_2026-10.pdf", DownloadCache.path("01a0f275-aaaa", "ゼミ資料_2026-10.pdf"))
        assertEquals("id/a_b_c.txt", DownloadCache.path("id", "a/b\\c.txt"))
        // Never outside its folder.
        assertEquals("id/file", DownloadCache.path("id", ".."))
        assertEquals("id/file", DownloadCache.path("id", "  "))
        assertEquals("attachment/x.pdf", DownloadCache.path("..", "x.pdf"))
        assertEquals("id/..._x", DownloadCache.path("id", ".../x"))
    }

    // --- S1: a search result's time ---

    @Test
    fun searchStampsReadTodayYesterdayOrTheDay() {
        val tokyo = ZoneId.of("Asia/Tokyo")
        val now = ZonedDateTime.of(2026, 9, 30, 23, 0, 0, 0, tokyo)
        assertEquals("今日 22:16", Timeline.stampLabel("2026-09-30T13:16:00Z", now))
        assertEquals("昨日 09:05", Timeline.stampLabel("2026-09-29T00:05:00Z", now))
        assertEquals("9月26日 (土) 10:00", Timeline.stampLabel("2026-09-26T01:00:00Z", now))
        assertEquals("2025年12月31日 (水) 10:00", Timeline.stampLabel("2025-12-31T01:00:00Z", now))
        // The device's day, not UTC's: 00:30 in Tokyo is 「今日」 though it is still the 29th in UTC.
        assertEquals("今日 00:30", Timeline.stampLabel("2026-09-29T15:30:00Z", now))
        assertEquals("", Timeline.stampLabel("not a date", now))
    }

    // --- X1: the search excerpt is the shared one-line rule ---

    @Test
    fun searchExcerptsDropTheMarkup() {
        val body = "今日の議事メモ:\n- 発表順は案 2\n- 次回までに `analysis.py` を整理\n\n```python\nprint(1)\n```"
        assertEquals("今日の議事メモ: 発表順は案 2 次回までに analysis.py を整理 print(1)", messageLine(body, emptyList(), emptyMap(), emptyMap(), 400))
    }
}
