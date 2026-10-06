package jp.chikuwachat.android

import jp.chikuwachat.android.platform.KeyValueStore
import jp.chikuwachat.android.ui.ConversationTab
import jp.chikuwachat.android.ui.MainNav
import jp.chikuwachat.android.ui.MainTab
import jp.chikuwachat.android.ui.MainTabs
import jp.chikuwachat.android.ui.Route
import jp.chikuwachat.android.ui.SearchParams
import jp.chikuwachat.android.ui.SwipeNav
import jp.chikuwachat.android.ui.SwipeNav.Decision
import jp.chikuwachat.android.ui.SwipeNavigation
import jp.chikuwachat.android.ui.TabStacks
import jp.chikuwachat.android.ui.ThreadFrom
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Issue #1: the horizontal swipe between a conversation and the list (SwipeNav). */
class SwipeNavTest {
    private val slop = 10f

    private fun tabs(vararg stack: Route, tab: MainTab = MainTab.HOME) = MainTabs.withStack(TabStacks(selected = tab), tab, stack.toList())

    // --- direction ---

    @Test
    fun `within the touch slop nothing is decided`() {
        assertEquals(Decision.UNDECIDED, SwipeNav.decide(6f, 3f, slop, canBack = true, canForward = true))
    }

    @Test
    fun `a clearly horizontal drag goes back to the right and forward to the left`() {
        assertEquals(Decision.BACK, SwipeNav.decide(20f, 5f, slop, canBack = true, canForward = true))
        assertEquals(Decision.FORWARD, SwipeNav.decide(-20f, -5f, slop, canBack = true, canForward = true))
    }

    @Test
    fun `a vertical or steep drag is the list's scroll`() {
        assertEquals(Decision.REJECT, SwipeNav.decide(2f, 12f, slop, canBack = true, canForward = true))
        // 45°: past the slop on both axes but steeper than 30°.
        assertEquals(Decision.REJECT, SwipeNav.decide(15f, 15f, slop, canBack = true, canForward = true))
        // Steep, the vertical slop not reached yet: wait.
        assertEquals(Decision.UNDECIDED, SwipeNav.decide(12f, 9f, slop, canBack = true, canForward = true))
    }

    @Test
    fun `30 degrees is still horizontal`() {
        assertEquals(Decision.BACK, SwipeNav.decide(20f, 11.5f, slop, canBack = true, canForward = false))
        assertEquals(Decision.REJECT, SwipeNav.decide(20f, 12f, slop, canBack = true, canForward = false))
    }

    @Test
    fun `a direction with nowhere to go is not taken`() {
        assertEquals(Decision.REJECT, SwipeNav.decide(-20f, 0f, slop, canBack = true, canForward = false))
        assertEquals(Decision.REJECT, SwipeNav.decide(20f, 0f, slop, canBack = false, canForward = true))
    }

    // --- release ---

    @Test
    fun `a slow release completes past 40 percent`() {
        assertFalse(SwipeNav.shouldComplete(0.39f, 0f, 1000f))
        assertTrue(SwipeNav.shouldComplete(0.4f, 0f, 1000f))
    }

    @Test
    fun `a fling decides wherever it is`() {
        assertTrue(SwipeNav.shouldComplete(0.1f, 1200f, 1000f))
        assertFalse(SwipeNav.shouldComplete(0.9f, -1200f, 1000f))
        assertTrue(SwipeNav.shouldComplete(0.5f, -300f, 1000f))
    }

    @Test
    fun `the upper page follows the finger`() {
        assertEquals(0.25f, SwipeNav.upperShift(100f, 400f, forward = false), 0.001f)
        assertEquals(0f, SwipeNav.upperShift(-50f, 400f, forward = false), 0.001f)
        assertEquals(0.75f, SwipeNav.upperShift(-100f, 400f, forward = true), 0.001f)
        assertEquals(1f, SwipeNav.upperShift(30f, 400f, forward = true), 0.001f)
        assertEquals(0.25f, SwipeNav.progress(0.75f, forward = true), 0.001f)
        assertEquals(-120f, SwipeNav.lowerTranslation(0f, 400f), 0.001f)
        assertEquals(0f, SwipeNav.lowerTranslation(1f, 400f), 0.001f)
    }

    // --- where it goes ---

    @Test
    fun `back from a conversation is the list under it`() {
        val state = tabs(Route.ChannelList, Route.Channel("a"))
        assertEquals(listOf(Route.ChannelList), MainTabs.stack(SwipeNav.backTarget(state)!!))
    }

    @Test
    fun `back from a thread is its conversation, or the threads list it was opened from`() {
        val fromChannel = tabs(Route.ChannelList, Route.Channel("a"), Route.Thread("a", "p"))
        assertEquals(listOf(Route.ChannelList, Route.Channel("a")), MainTabs.stack(SwipeNav.backTarget(fromChannel)!!))
        val fromList = tabs(Route.ChannelList, Route.Threads, Route.Channel("a"), Route.Thread("a", "p", ThreadFrom.LIST))
        assertEquals(listOf(Route.ChannelList, Route.Threads), MainTabs.stack(SwipeNav.backTarget(fromList)!!))
    }

    @Test
    fun `back from a search result is the results`() {
        val search = Route.Search(SearchParams(q = "x"), expanded = false)
        val state = tabs(Route.ChannelList, search, Route.Channel("a"))
        assertEquals(listOf(Route.ChannelList, search), MainTabs.stack(SwipeNav.backTarget(state)!!))
    }

    @Test
    fun `no swipe back on the details page, another tab of the conversation, a list or a root`() {
        assertNull(SwipeNav.backTarget(tabs(Route.ChannelList, Route.Channel("a", detailsOpen = true))))
        assertNull(SwipeNav.backTarget(tabs(Route.ChannelList, Route.Channel("a", tab = ConversationTab.CANVAS))))
        assertNull(SwipeNav.backTarget(tabs(Route.ChannelList, Route.Threads)))
        assertNull(SwipeNav.backTarget(tabs(Route.ChannelList)))
        assertNull(SwipeNav.backTarget(tabs(Route.ChannelList, Route.Search())))
    }

    @Test
    fun `forward from a tab's root is the conversation it left last`() {
        val state = tabs(Route.ChannelList)
        val target = SwipeNav.forwardTarget(state, mapOf(MainTab.HOME to "a")) { true }!!
        assertEquals(listOf(Route.ChannelList, Route.Channel("a")), MainTabs.stack(target))
        assertEquals(MainTab.HOME, target.selected)
        val dms = tabs(Route.DmList, tab = MainTab.DM)
        assertEquals(listOf(Route.DmList, Route.Channel("d")), MainTabs.stack(SwipeNav.forwardTarget(dms, mapOf(MainTab.DM to "d")) { true }!!))
    }

    @Test
    fun `no swipe forward without a remembered conversation, one gone, off the root or on the you tab`() {
        assertNull(SwipeNav.forwardTarget(tabs(Route.ChannelList), emptyMap()) { true })
        assertNull(SwipeNav.forwardTarget(tabs(Route.ChannelList), mapOf(MainTab.DM to "d")) { true })
        assertNull(SwipeNav.forwardTarget(tabs(Route.ChannelList), mapOf(MainTab.HOME to "a")) { false })
        assertNull(SwipeNav.forwardTarget(tabs(Route.ChannelList, Route.Search(jump = true)), mapOf(MainTab.HOME to "a")) { true })
        assertNull(SwipeNav.forwardTarget(tabs(Route.You, tab = MainTab.YOU), mapOf(MainTab.YOU to "a")) { true })
    }

    // --- the last conversation ---

    @Test
    fun `leaving a conversation remembers it for its tab`() {
        val open = tabs(Route.ChannelList, Route.Channel("a"))
        val left = SwipeNav.noteLeft(emptyMap(), open, MainTabs.back(open))
        assertEquals(mapOf(MainTab.HOME to "a"), left)
        // Through its thread: the conversation is what is left last.
        val thread = tabs(Route.ChannelList, Route.Channel("b"), Route.Thread("b", "p"))
        val stillOpen = SwipeNav.noteLeft(left, thread, MainTabs.back(thread))
        assertEquals(left, stillOpen)
        val backHome = MainTabs.back(MainTabs.back(thread))
        assertEquals(mapOf(MainTab.HOME to "b"), SwipeNav.noteLeft(stillOpen, MainTabs.back(thread), backHome))
    }

    @Test
    fun `a tab re-tap and a switch of tabs`() {
        val open = tabs(Route.ChannelList, Route.Channel("a"))
        val popped = MainTabs.tap(open, MainTab.HOME).state
        assertEquals(mapOf(MainTab.HOME to "a"), SwipeNav.noteLeft(emptyMap(), open, popped))
        // Another tab shows: the home tab's conversation is still open there, nothing is left.
        val switched = MainTabs.tap(open, MainTab.DM).state
        assertEquals(emptyMap<MainTab, String>(), SwipeNav.noteLeft(emptyMap(), open, switched))
    }

    @Test
    fun `replacing the conversation does not remember the one replaced`() {
        val open = tabs(Route.ChannelList, Route.Channel("a"))
        val other = MainTabs.update(open) { MainNav.openConversation(it, "b") }
        assertEquals(emptyMap<MainTab, String>(), SwipeNav.noteLeft(emptyMap(), open, other))
    }

    @Test
    fun `the remembered conversations survive saving`() {
        val last = mapOf(MainTab.HOME to "a", MainTab.DM to "d-1")
        assertEquals(last, SwipeNav.decode(SwipeNav.encode(last)))
        assertEquals(emptyMap<MainTab, String>(), SwipeNav.decode(""))
        assertEquals(mapOf(MainTab.HOME to "a"), SwipeNav.decode("HOME=a\nNOPE=x\nDM="))
    }

    @Test
    fun `a page keeps its key on its tabs and details, not across conversations`() {
        val messages = listOf(Route.ChannelList, Route.Channel("a"))
        assertEquals(SwipeNav.pageKey(messages), SwipeNav.pageKey(listOf(Route.ChannelList, Route.Channel("a", detailsOpen = true))))
        assertNotEquals(SwipeNav.pageKey(messages), SwipeNav.pageKey(listOf(Route.ChannelList, Route.Channel("b"))))
        assertNotEquals(SwipeNav.pageKey(messages), SwipeNav.pageKey(listOf(Route.ChannelList)))
    }

    // --- the setting ---

    private class MemoryStore : KeyValueStore {
        val values = mutableMapOf<String, String>()
        override fun getString(key: String): String? = values[key]
        override fun putString(key: String, value: String?) {
            if (value == null) values.remove(key) else values[key] = value
        }
    }

    @Test
    fun `the setting is on by default and only off is stored`() {
        val store = MemoryStore()
        assertTrue(SwipeNavigation.read(store))
        SwipeNavigation.write(store, false)
        assertFalse(SwipeNavigation.read(store))
        SwipeNavigation.write(store, true)
        assertTrue(SwipeNavigation.read(store))
        assertTrue(store.values.isEmpty())
    }
}
