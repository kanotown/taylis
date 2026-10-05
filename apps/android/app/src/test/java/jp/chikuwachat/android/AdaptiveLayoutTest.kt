package jp.chikuwachat.android

import jp.chikuwachat.android.ui.AdaptiveLayout
import jp.chikuwachat.android.ui.ConversationTab
import jp.chikuwachat.android.ui.HardwareKeys
import jp.chikuwachat.android.ui.MainNav
import jp.chikuwachat.android.ui.MainTab
import jp.chikuwachat.android.ui.MainTabs
import jp.chikuwachat.android.ui.PaneLayout
import jp.chikuwachat.android.ui.Route
import jp.chikuwachat.android.ui.SearchParams
import jp.chikuwachat.android.ui.TabStacks
import jp.chikuwachat.android.ui.ThreadFrom
import android.view.KeyEvent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** T1 (MOBILE_UI.md §12): the tablet layout over the phone's back stacks (AdaptiveLayout) and the hardware keys. */
class AdaptiveLayoutTest {
    private val home = MainNav.root
    private val conversation = home + Route.Channel("c1")
    private val thread = conversation + Route.Thread("c1", "p1")

    // --- which layout ---

    @Test
    fun phonesStayPhonesInEitherOrientation() {
        assertEquals(PaneLayout.PHONE, AdaptiveLayout.of(412f, 915f)) // Pixel 9 portrait
        assertEquals(PaneLayout.PHONE, AdaptiveLayout.of(915f, 412f)) // and sideways: too short for panes
        assertEquals(PaneLayout.PHONE, AdaptiveLayout.of(360f, 640f))
    }

    @Test
    fun mediumWidthIsPanesOnlyInLandscape() {
        assertEquals(PaneLayout.PHONE, AdaptiveLayout.of(600f, 960f)) // 7" portrait
        assertEquals(PaneLayout.PHONE, AdaptiveLayout.of(800f, 1280f)) // 10" portrait
        assertEquals(PaneLayout.TWO_PANE, AdaptiveLayout.of(800f, 600f)) // a medium window held sideways
    }

    @Test
    fun expandedWidthIsTwoPanesThenThreeWithRoomForTheThread() {
        assertEquals(PaneLayout.TWO_PANE, AdaptiveLayout.of(960f, 600f)) // 7" landscape
        assertEquals(PaneLayout.TWO_PANE, AdaptiveLayout.of(1139f, 700f))
        assertEquals(PaneLayout.THREE_PANE, AdaptiveLayout.of(1280f, 800f)) // 10" landscape
        assertEquals(PaneLayout.THREE_PANE, AdaptiveLayout.of(1140f, 1000f))
        // An unfolded foldable is about square: two panes, the thread over the conversation.
        assertEquals(PaneLayout.TWO_PANE, AdaptiveLayout.of(884f, 1000f))
    }

    // --- where the stack's routes are drawn ---

    @Test
    fun threePanesPutTheThreadBesideItsConversation() {
        assertEquals(Route.Thread("c1", "p1"), AdaptiveLayout.threadPane(thread, PaneLayout.THREE_PANE))
        assertEquals(conversation, AdaptiveLayout.mainView(thread, PaneLayout.THREE_PANE))
    }

    @Test
    fun twoPanesAndThePhoneDrawTheThreadOverTheConversation() {
        for (layout in listOf(PaneLayout.PHONE, PaneLayout.TWO_PANE)) {
            assertNull(AdaptiveLayout.threadPane(thread, layout))
            assertEquals(thread, AdaptiveLayout.mainView(thread, layout))
        }
    }

    @Test
    fun aSearchOverAThreadKeepsTheMainPaneAndHidesTheThreadsPane() {
        val searching = MainNav.openSearch(thread)
        assertNull(AdaptiveLayout.threadPane(searching, PaneLayout.THREE_PANE))
        assertEquals(searching, AdaptiveLayout.mainView(searching, PaneLayout.THREE_PANE))
    }

    @Test
    fun theListPaneShowsEveryTabsRootButYou() {
        assertTrue(AdaptiveLayout.listPane(PaneLayout.TWO_PANE, MainTab.HOME))
        assertTrue(AdaptiveLayout.listPane(PaneLayout.THREE_PANE, MainTab.DM))
        assertTrue(AdaptiveLayout.listPane(PaneLayout.THREE_PANE, MainTab.ACTIVITY))
        assertFalse(AdaptiveLayout.listPane(PaneLayout.THREE_PANE, MainTab.YOU))
        assertFalse(AdaptiveLayout.listPane(PaneLayout.PHONE, MainTab.HOME))
    }

    @Test
    fun theMainPaneIsEmptyAtTheRootAndHasABackOnlyOverMoreThanTheRoot() {
        assertTrue(AdaptiveLayout.placeholder(home))
        assertFalse(AdaptiveLayout.placeholder(conversation))
        assertFalse(AdaptiveLayout.backShown(conversation)) // the list beside it is the way back
        assertTrue(AdaptiveLayout.backShown(MainNav.openFromThreadList(home + Route.Threads, "c1", "p1").dropLast(1)))
    }

    // --- a resize keeps what is open ---

    @Test
    fun aResizeKeepsTheOpenConversationAndThread() {
        // The state is the phone's stack in every layout: going wide and back draws the same routes.
        val state = MainTabs.land(MainTabs.initial, MainTab.HOME, "c1", "p1")
        val stack = MainTabs.stack(state)
        val wide = AdaptiveLayout.mainView(stack, PaneLayout.THREE_PANE) + listOfNotNull(AdaptiveLayout.threadPane(stack, PaneLayout.THREE_PANE))
        assertEquals(stack, wide)
        assertEquals(stack, AdaptiveLayout.mainView(stack, PaneLayout.PHONE))
        assertEquals("c1", MainTabs.openConversation(state)?.id)
    }

    @Test
    fun aNotificationLandsInThePanes() {
        val state = MainTabs.land(TabStacks(selected = MainTab.ACTIVITY), MainTab.HOME, "c1", "p1")
        assertEquals(MainTab.HOME, state.selected)
        val stack = MainTabs.stack(state)
        assertEquals(listOf(Route.ChannelList, Route.Channel("c1")), AdaptiveLayout.mainView(stack, PaneLayout.THREE_PANE))
        assertEquals("p1", AdaptiveLayout.threadPane(stack, PaneLayout.THREE_PANE)?.parentId)
    }

    // --- the wide transitions ---

    @Test
    fun anotherThreadFromTheTimelineReplacesTheOneOpen() {
        assertEquals(conversation + Route.Thread("c1", "p2"), AdaptiveLayout.openThread(thread, "p2"))
        assertEquals(thread, AdaptiveLayout.openThread(thread, "p1"))
        assertEquals(thread, AdaptiveLayout.openThread(conversation, "p1"))
        // From the 「スレッド」 list: the list stays under the conversation, the new thread is the timeline's.
        val fromList = MainNav.openFromThreadList(home + Route.Threads, "c1", "p1")
        assertEquals(home + Route.Threads + Route.Channel("c1") + Route.Thread("c1", "p2", ThreadFrom.CHANNEL), AdaptiveLayout.openThread(fromList, "p2"))
        // Nothing to open it from.
        assertEquals(home, AdaptiveLayout.openThread(home, "p1"))
    }

    @Test
    fun closingTheThreadsPaneKeepsTheConversation() {
        assertEquals(conversation, AdaptiveLayout.closeThread(thread))
        val fromList = MainNav.openFromThreadList(home + Route.Threads, "c1", "p1")
        assertEquals(home + Route.Threads + Route.Channel("c1"), AdaptiveLayout.closeThread(fromList))
        assertEquals(conversation, AdaptiveLayout.closeThread(conversation))
    }

    @Test
    fun theConversationsControlsApplyBesideAnOpenThread() {
        val details = MainNav.openDetails(AdaptiveLayout.surfaceConversation(thread))
        assertEquals(home + Route.Channel("c1", detailsOpen = true), details)
        val tab = MainNav.selectTab(AdaptiveLayout.surfaceConversation(thread), ConversationTab.PINS)
        assertEquals(home + Route.Channel("c1", tab = ConversationTab.PINS), tab)
        // A search over the thread is not the conversation's: nothing changes.
        val searching = MainNav.openSearch(thread)
        assertEquals(searching, AdaptiveLayout.surfaceConversation(searching))
    }

    @Test
    fun aTileReplacesTheMainPaneWideAndIsPushedOnThePhone() {
        assertEquals(home + Route.Threads, AdaptiveLayout.openFromList(thread, Route.Threads, PaneLayout.THREE_PANE))
        assertEquals(home + Route.Saved, AdaptiveLayout.openFromList(home + Route.Threads, Route.Saved, PaneLayout.TWO_PANE))
        assertEquals(home + Route.Threads, AdaptiveLayout.openFromList(home, Route.Threads, PaneLayout.PHONE))
    }

    @Test
    fun theTimelineIsOnScreenBesideItsThreadOnlyWithThreePanes() {
        val state = MainTabs.land(MainTabs.initial, MainTab.HOME, "c1", "p1")
        assertTrue(AdaptiveLayout.conversationOnScreen(state, PaneLayout.THREE_PANE))
        assertFalse(AdaptiveLayout.conversationOnScreen(state, PaneLayout.TWO_PANE))
        assertFalse(AdaptiveLayout.conversationOnScreen(state, PaneLayout.PHONE))
        val open = MainTabs.land(MainTabs.initial, MainTab.HOME, "c1")
        assertEquals(MainTabs.conversationOnScreen(open, MainTab.HOME), AdaptiveLayout.conversationOnScreen(open, PaneLayout.PHONE))
        assertTrue(AdaptiveLayout.conversationOnScreen(open, PaneLayout.TWO_PANE))
        val details = MainTabs.update(open, MainNav::openDetails)
        assertFalse(AdaptiveLayout.conversationOnScreen(details, PaneLayout.THREE_PANE))
        val searched = MainTabs.update(open) { MainNav.runSearch(MainNav.openSearch(it), SearchParams(q = "a")) }
        assertFalse(AdaptiveLayout.conversationOnScreen(searched, PaneLayout.THREE_PANE))
    }

    // --- hardware keys ---

    @Test
    fun enterSendsOnlyWithAHardwareKeyboardAndNotWhileConverting() {
        assertEquals(HardwareKeys.EnterAction.SEND, HardwareKeys.enter(hardwareKeyboard = true, shift = false, alt = false, composing = false))
        assertEquals(HardwareKeys.EnterAction.NEWLINE, HardwareKeys.enter(hardwareKeyboard = true, shift = true, alt = false, composing = false))
        assertEquals(HardwareKeys.EnterAction.NONE, HardwareKeys.enter(hardwareKeyboard = true, shift = false, alt = false, composing = true))
        assertEquals(HardwareKeys.EnterAction.NONE, HardwareKeys.enter(hardwareKeyboard = false, shift = false, alt = false, composing = false))
        assertEquals(HardwareKeys.EnterAction.NONE, HardwareKeys.enter(hardwareKeyboard = true, shift = false, alt = true, composing = false))
        assertTrue(HardwareKeys.isEnter(KeyEvent.KEYCODE_ENTER))
        assertTrue(HardwareKeys.isEnter(KeyEvent.KEYCODE_NUMPAD_ENTER))
        assertFalse(HardwareKeys.isEnter(KeyEvent.KEYCODE_SPACE))
    }

    @Test
    fun ctrlOrMetaKJumps() {
        assertTrue(HardwareKeys.isJump(KeyEvent.KEYCODE_K, ctrl = true, meta = false, alt = false, shift = false))
        assertTrue(HardwareKeys.isJump(KeyEvent.KEYCODE_K, ctrl = false, meta = true, alt = false, shift = false))
        assertFalse(HardwareKeys.isJump(KeyEvent.KEYCODE_K, ctrl = false, meta = false, alt = false, shift = false))
        assertFalse(HardwareKeys.isJump(KeyEvent.KEYCODE_K, ctrl = true, meta = false, alt = false, shift = true))
        assertFalse(HardwareKeys.isJump(KeyEvent.KEYCODE_J, ctrl = true, meta = false, alt = false, shift = false))
    }
}
