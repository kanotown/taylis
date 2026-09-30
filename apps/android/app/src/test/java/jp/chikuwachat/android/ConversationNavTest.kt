package jp.chikuwachat.android

import jp.chikuwachat.android.ui.ConversationNav
import jp.chikuwachat.android.ui.ConversationTab
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
        // M52: 「予定」 after it, as the desktop's 「メッセージ | キャンバス | 予定」.
        assertEquals(listOf("メッセージ", "キャンバス", "予定", "ピン留め", "ファイル"), ConversationTab.entries.map { it.label })
    }

    @Test
    fun theEventsTabIsOnlyWhereThereIsASharedCalendarWithItsCount() {
        // CALENDAR.md §9 5.: public and private channels have one, DMs and group DMs do not.
        fun state(type: String) = jp.chikuwachat.android.sync.ChannelState(
            jp.chikuwachat.android.api.ChannelOut(id = "c", type = type, name = "lab", archived = false, lastSeq = 0, createdAt = "2026-10-01T00:00:00Z", updatedAt = "2026-10-01T00:00:00Z"),
            isMember = true,
        )
        assertTrue(ConversationTab.EVENTS in ConversationNav.tabs(state("public")))
        assertTrue(ConversationTab.EVENTS in ConversationNav.tabs(state("private")))
        assertEquals(listOf(ConversationTab.MESSAGES, ConversationTab.CANVAS, ConversationTab.PINS, ConversationTab.FILES), ConversationNav.tabs(state("dm")))
        assertFalse(ConversationTab.EVENTS in ConversationNav.tabs(state("group_dm")))
        assertEquals("予定 2", ConversationNav.label(ConversationTab.EVENTS, 2))
        assertEquals("予定", ConversationNav.label(ConversationTab.EVENTS, 0))
        assertEquals("ピン留め", ConversationNav.label(ConversationTab.PINS, 3))
        assertFalse(ConversationNav.conversationOnScreen(ConversationTab.EVENTS, detailsOpen = false))
    }
}
