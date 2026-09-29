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
        assertFalse(ConversationNav.conversationOnScreen(ConversationTab.MESSAGES, detailsOpen = true))
    }

    @Test
    fun theTabsAreInTheSpecsOrder() {
        assertEquals(listOf("メッセージ", "ピン留め", "ファイル"), ConversationTab.entries.map { it.label })
    }
}
