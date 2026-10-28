package jp.chikuwachat.android

import jp.chikuwachat.android.ui.BarMenu
import jp.chikuwachat.android.ui.BarMenuItem
import jp.chikuwachat.android.ui.ConversationNav
import jp.chikuwachat.android.ui.ConversationTab
import jp.chikuwachat.android.ui.MainTab
import jp.chikuwachat.android.ui.MainTabs
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** M29: the phone's conversation screen as pages: the details page and the tabs under the app bar (back: MainNavTest). */
class ConversationNavTest {
    @Test
    fun theTabRowShowsOnlyOverAJoinedConversationsTimeline() {
        assertTrue(ConversationNav.tabRowShown(channelOpen = true, member = true, threadOpen = false, searching = false, detailsOpen = false))
        // Not in a thread, not in the preview before joining, not over the search or on the details page.
        assertFalse(ConversationNav.tabRowShown(channelOpen = true, member = true, threadOpen = true, searching = false, detailsOpen = false))
        assertFalse(ConversationNav.tabRowShown(channelOpen = true, member = false, threadOpen = false, searching = false, detailsOpen = false))
        assertFalse(ConversationNav.tabRowShown(channelOpen = true, member = true, threadOpen = false, searching = true, detailsOpen = false))
        assertFalse(ConversationNav.tabRowShown(channelOpen = true, member = true, threadOpen = false, searching = false, detailsOpen = true))
        assertFalse(ConversationNav.tabRowShown(channelOpen = false, member = false, threadOpen = false, searching = false, detailsOpen = false))
    }

    @Test
    fun theTimelineIsOnScreenOnlyUnderMessages() {
        // SYNC_PROTOCOL.md §10.1 2.: while the pins, the files or the details show, nothing marks read.
        assertTrue(ConversationNav.conversationOnScreen(ConversationTab.MESSAGES, detailsOpen = false))
        assertFalse(ConversationNav.conversationOnScreen(ConversationTab.PINS, detailsOpen = false))
        assertFalse(ConversationNav.conversationOnScreen(ConversationTab.FILES, detailsOpen = false))
        assertFalse(ConversationNav.conversationOnScreen(ConversationTab.CANVAS, detailsOpen = false))
        assertFalse(ConversationNav.conversationOnScreen(ConversationTab.MESSAGES, detailsOpen = true))
    }

    @Test
    fun theTabsAreInTheSpecsOrder() {
        // M46: 「キャンバス」 second (CANVAS.md §4.1, as the desktop's phone width).
        // M56: 「タスク」 after it (TASKS.md §6). M166: 「ドライブ」 after it (DRIVE.md §13.3, as the desktop).
        // 2026-10-28: M52's 「予定」 tab is gone (one calendar per workspace; the ⋮ has 「このチャンネルの予定」).
        assertEquals(listOf("メッセージ", "キャンバス", "タスク", "ドライブ", "ピン留め", "ファイル"), ConversationTab.entries.map { it.label })
    }

    @Test
    fun theTasksTabIsOnlyWhereThereIsABoard() {
        // CALENDAR.md §9 5.: public and private channels have one, DMs and group DMs do not.
        fun state(type: String) = jp.chikuwachat.android.sync.ChannelState(
            jp.chikuwachat.android.api.ChannelOut(id = "c", type = type, name = "lab", archived = false, lastSeq = 0, createdAt = "2026-10-01T00:00:00Z", updatedAt = "2026-10-01T00:00:00Z"),
            isMember = true,
        )
        // M56 (TASKS.md §2): a board in public and private channels, none in a DM.
        assertTrue(ConversationTab.TASKS in ConversationNav.tabs(state("public")))
        assertTrue(ConversationTab.TASKS in ConversationNav.tabs(state("private")))
        assertFalse(ConversationTab.TASKS in ConversationNav.tabs(state("group_dm")))
        assertFalse(ConversationNav.conversationOnScreen(ConversationTab.TASKS, detailsOpen = false))
        assertEquals(listOf(ConversationTab.MESSAGES, ConversationTab.CANVAS, ConversationTab.TASKS, ConversationTab.PINS, ConversationTab.FILES), ConversationNav.tabs(state("public")))
        assertEquals(listOf(ConversationTab.MESSAGES, ConversationTab.CANVAS, ConversationTab.PINS, ConversationTab.FILES), ConversationNav.tabs(state("dm")))
    }

    @Test
    fun theChannelEventsItemSaysTodaysAndTomorrowsCount() {
        // 2026-10-28 (CALENDAR.md §7): the ⋮'s replacement for the 「予定 N」 tab, full-width brackets in Japanese.
        assertEquals("このチャンネルの予定", ConversationNav.channelEventsLabel(0))
        assertEquals("このチャンネルの予定（今日・明日 2 件）", ConversationNav.channelEventsLabel(2))
    }

    @Test
    fun theChannelEventsItemIsInAChannelsMenuOnlyWhereItHasACalendar() {
        fun items(channel: Boolean, events: Boolean) =
            BarMenu.items(conversation = true, channel = channel, archived = false, activityFeed = false, channelEvents = events)
        assertEquals(
            listOf(BarMenuItem.FAVORITE, BarMenuItem.NOTIFICATIONS, BarMenuItem.DETAILS, BarMenuItem.CHANNEL_EVENTS, BarMenuItem.ADD_MEMBER),
            items(channel = true, events = true),
        )
        assertFalse(BarMenuItem.CHANNEL_EVENTS in items(channel = true, events = false))
        assertFalse(BarMenuItem.CHANNEL_EVENTS in items(channel = false, events = true))
        // Not on a thread's or the calendar's own ⋮.
        assertFalse(BarMenuItem.CHANNEL_EVENTS in BarMenu.items(conversation = false, channel = true, archived = false, activityFeed = false, thread = true, summaries = true, channelEvents = true))
    }

    @Test
    fun aStackSavedWithTheOldEventsTabStartsOver() {
        // A state saved by a build that still had the 「予定」 tab is unreadable now: the tabs start over (no crash).
        val canvas = MainTabs.landCanvas(MainTabs.initial, MainTab.HOME, "c1", "cv1")
        val saved = MainTabs.encode(canvas)
        assertEquals(canvas, MainTabs.decode(saved))
        assertTrue("\"CANVAS\"" in saved)
        assertEquals(MainTabs.initial, MainTabs.decode(saved.replace("\"CANVAS\"", "\"EVENTS\"")))
    }
}
