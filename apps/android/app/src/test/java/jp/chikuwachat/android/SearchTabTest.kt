package jp.chikuwachat.android

import jp.chikuwachat.android.api.UserPublic
import jp.chikuwachat.android.ui.AdaptiveLayout
import jp.chikuwachat.android.ui.Jump
import jp.chikuwachat.android.ui.MainNav
import jp.chikuwachat.android.ui.MainTab
import jp.chikuwachat.android.ui.MainTabs
import jp.chikuwachat.android.ui.PaneLayout
import jp.chikuwachat.android.ui.Route
import jp.chikuwachat.android.ui.SearchParams
import jp.chikuwachat.android.ui.SwipeNav
import jp.chikuwachat.android.ui.TabStacks
import jp.chikuwachat.android.ui.ThreadFrom
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 2026-10-27 (MOBILE_UI.md §5): the 「検索」 tab (its stack, its re-tap, back, results and picks over it), the tab bar in
 * conversations and threads from every entry, and the people pickers' filter (Jump.pickPeople).
 */
class SearchTabTest {
    private val start = MainTabs.initial
    private val root = listOf(Route.SearchHome, Route.Search(jump = true))
    private val onSearch = MainTabs.tap(start, MainTab.SEARCH).state

    private fun results(q: String = "x") = MainTabs.update(onSearch) { MainNav.runSearch(it, SearchParams(q = q)) }

    @Test
    fun theTabsAreInTheBarsOrder() {
        assertEquals(listOf(MainTab.HOME, MainTab.DM, MainTab.ACTIVITY, MainTab.SEARCH, MainTab.YOU), MainTab.entries)
    }

    @Test
    fun theSearchTabStartsOnItsEmptySearch() {
        assertEquals(MainTab.SEARCH, onSearch.selected)
        assertEquals(root, MainTabs.stack(onSearch))
        assertTrue(MainTabs.atRoot(onSearch))
        assertTrue(MainTabs.searchTabRoot(MainTabs.stack(onSearch)))
        // A tab root: the bar shows over its (expanded) jump screen.
        assertTrue(MainTabs.barShown(MainTabs.stack(onSearch)))
        // Its search never closes: a stack saved without it gets an empty one back.
        val bare = TabStacks(MainTab.SEARCH, mapOf(MainTab.SEARCH to listOf(Route.SearchHome, Route.Channel("c1"))))
        assertEquals(root + Route.Channel("c1"), MainTabs.stack(bare))
        assertEquals(root, MainTabs.stack(TabStacks(MainTab.SEARCH, mapOf(MainTab.SEARCH to listOf(Route.SearchHome)))))
    }

    @Test
    fun aReTapAtTheRootFocusesTheFieldDeeperItPopsToTheSearch() {
        val again = MainTabs.tap(onSearch, MainTab.SEARCH)
        assertTrue(again.focusSearch)
        assertFalse(again.scrollToTop)
        assertEquals(root, MainTabs.stack(again.state))
        // Over results: the suggestions open over them (the words kept), the cursor in the field.
        val withResults = results()
        val overResults = MainTabs.tap(withResults, MainTab.SEARCH)
        assertTrue(overResults.focusSearch)
        assertEquals(listOf(Route.SearchHome, Route.Search(SearchParams(q = "x"), expanded = true, jump = true)), MainTabs.stack(overResults.state))
        // A result's thread over the results: the tab pops to its search, the results kept.
        val thread = MainTabs.landFromSearch(withResults, MainTab.HOME, "c1", "p1")
        val popped = MainTabs.tap(thread, MainTab.SEARCH)
        assertFalse(popped.focusSearch)
        assertEquals(MainTabs.stack(withResults), MainTabs.stack(popped.state))
        // Another tab first: the search tab comes back as it was left (nothing focused).
        val away = MainTabs.tap(thread, MainTab.HOME).state
        val back = MainTabs.tap(away, MainTab.SEARCH)
        assertFalse(back.focusSearch)
        assertEquals(MainTabs.stack(thread), MainTabs.stack(back.state))
    }

    @Test
    fun backGoesThroughTheResultsThenToHome() {
        val thread = MainTabs.landFromSearch(results(), MainTab.HOME, "c1", "p1")
        assertEquals(MainTab.SEARCH, thread.selected)
        assertEquals(listOf(Route.SearchHome, Route.Search(SearchParams(q = "x"), expanded = false, jump = true), Route.Thread("c1", "p1", ThreadFrom.SEARCH)), MainTabs.stack(thread))
        val toResults = MainTabs.back(thread)
        assertEquals(MainTabs.stack(results()), MainTabs.stack(toResults))
        assertTrue(MainTabs.canPop(toResults))
        // Back from the results: the empty search (the tab's root), then the home tab.
        val toEmpty = MainTabs.back(toResults)
        assertEquals(root, MainTabs.stack(toEmpty))
        assertFalse(MainTabs.canPop(toEmpty))
        assertTrue(MainTabs.canGoBack(toEmpty))
        assertEquals(MainTab.HOME, MainTabs.back(toEmpty).selected)
        assertEquals(root, MainTabs.stack(MainTabs.back(toEmpty), MainTab.SEARCH))
    }

    @Test
    fun resultsAndPicksOpenOverTheSearchTab() {
        // A channel's or a DM's message: on the search tab, not on its own tab.
        val dm = MainTabs.landFromSearch(results(), MainTab.DM, "d1", null)
        assertEquals(MainTab.SEARCH, dm.selected)
        assertEquals(Route.Channel("d1"), MainNav.top(MainTabs.stack(dm)))
        assertEquals(listOf(Route.DmList), MainTabs.stack(dm, MainTab.DM))
        assertEquals(MainTabs.stack(results()), MainTabs.stack(MainTabs.back(dm)))
        val canvas = MainTabs.landCanvasFromSearch(results(), MainTab.HOME, "c1", "cv1")
        assertEquals(MainTab.SEARCH, canvas.selected)
        // A conversation or person picked on the jump screen: over the search, back returns to it.
        val picked = MainTabs.landFromJump(onSearch, MainTab.DM, "d1")
        assertEquals(root + Route.Channel("d1"), MainTabs.stack(picked))
        assertEquals(root, MainTabs.stack(MainTabs.back(picked)))
        // Another conversation opened from there (a link): the search stays under it.
        assertEquals(root + Route.Channel("c2"), MainTabs.stack(MainTabs.update(picked) { MainNav.openConversation(it, "c2") }))
        // Gone: the search shows again.
        assertEquals(root, MainTabs.stack(MainTabs.channelGone(picked, "d1")))
        val goneFromResults = MainTabs.channelGone(MainTabs.landFromSearch(results(), MainTab.HOME, "c1", null), "c1")
        assertEquals(MainTabs.stack(results()), MainTabs.stack(goneFromResults))
    }

    @Test
    fun theHomesJumpEntryOpensTheSearchTabEmpty() {
        val thread = MainTabs.landFromSearch(results(), MainTab.HOME, "c1", "p1")
        val home = MainTabs.tap(thread, MainTab.HOME).state
        val opened = MainTabs.openSearchTab(home)
        assertEquals(MainTab.SEARCH, opened.selected)
        assertEquals(root, MainTabs.stack(opened))
        assertEquals(listOf(Route.ChannelList), MainTabs.stack(opened, MainTab.HOME))
    }

    @Test
    fun theTabBarHidesInEveryConversationAndThread() {
        val home = MainTabs.update(start) { MainNav.open(it, Route.Threads) }
        // The home's 「スレッド」 list: a list (the bar shows); its thread hides it, as channel → thread does.
        assertTrue(MainTabs.barShown(MainTabs.stack(home)))
        assertFalse(MainTabs.barShown(MainTabs.stack(MainTabs.update(home) { MainNav.openFromThreadList(it, "c1", "p1") })))
        assertFalse(MainTabs.barShown(MainTabs.stack(MainTabs.update(start) { MainNav.openThread(MainNav.openConversation(it, "c1"), "p1") })))
        // Activity, a notification (land), the search tab, the home's search.
        val activity = MainTabs.tap(start, MainTab.ACTIVITY).state
        assertFalse(MainTabs.barShown(MainTabs.stack(MainTabs.update(activity) { MainNav.openFromThreadList(it, "c1", "p1") })))
        assertFalse(MainTabs.barShown(MainTabs.stack(MainTabs.land(start, MainTab.HOME, "c1", "p1"))))
        assertFalse(MainTabs.barShown(MainTabs.stack(MainTabs.land(start, MainTab.DM, "d1"))))
        assertFalse(MainTabs.barShown(MainTabs.stack(MainTabs.landFromSearch(results(), MainTab.HOME, "c1", "p1"))))
        assertFalse(MainTabs.barShown(MainTabs.stack(MainTabs.landFromSearch(results(), MainTab.HOME, "c1", null))))
        assertFalse(MainTabs.barShown(MainTabs.stack(MainTabs.landFromJump(onSearch, MainTab.HOME, "c1"))))
        // The search tab's results and root show it; a search over a conversation while typing does not.
        assertTrue(MainTabs.barShown(MainTabs.stack(results())))
        assertFalse(MainTabs.barShown(MainTabs.stack(MainTabs.update(MainTabs.landFromJump(onSearch, MainTab.HOME, "c1")) { MainNav.openSearch(it) })))
    }

    @Test
    fun theSearchTabHasNoListPaneAndNoForwardSwipe() {
        assertFalse(AdaptiveLayout.listPane(PaneLayout.TWO_PANE, MainTab.SEARCH))
        assertFalse(AdaptiveLayout.listPane(PaneLayout.THREE_PANE, MainTab.SEARCH))
        assertTrue(AdaptiveLayout.listPane(PaneLayout.THREE_PANE, MainTab.DM))
        assertNull(SwipeNav.forwardTarget(onSearch, mapOf(MainTab.SEARCH to "c1")) { true })
        assertEquals(onSearch, MainTabs.decode(MainTabs.encode(onSearch)))
    }

    // --- people pickers ---

    private fun user(id: String, name: String, username: String = id) =
        UserPublic(id = id, username = username, displayName = name, role = "member", createdAt = "", updatedAt = "", deactivatedAt = null)

    private val people = listOf(user("a", "青木 太郎", "aoki"), user("k", "カトウ", "kato"), user("y", "山田", "yamada"), user("s", "Sato", "sato"))

    @Test
    fun peoplePickersFilterByTheJumpRuleKeepingTheTicked() {
        assertEquals(people, Jump.pickPeople("", people, setOf("y")))
        assertEquals(people, Jump.pickPeople("  ", people, emptySet()))
        // Display name or username; kana and width folded (かとう finds カトウ, ＳＡＴＯ finds Sato).
        assertEquals(listOf("k"), Jump.pickPeople("かとう", people, emptySet()).map { it.id })
        assertEquals(listOf("s"), Jump.pickPeople("ＳＡＴＯ", people, emptySet()).map { it.id })
        assertEquals(listOf("y"), Jump.pickPeople("yama", people, emptySet()).map { it.id })
        // A word in the name (太郎), and prefix before contains.
        assertEquals(listOf("a"), Jump.pickPeople("太郎", people, emptySet()).map { it.id })
        assertEquals("a", Jump.pickPeople("a", people, emptySet()).first().id)
        // Ticked people stay, first, whatever the words.
        assertEquals(listOf("y", "k"), Jump.pickPeople("かとう", people, setOf("y")).map { it.id })
        assertEquals(listOf("y"), Jump.pickPeople("zzz", people, setOf("y")).map { it.id })
    }
}
