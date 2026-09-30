package jp.chikuwachat.android

import jp.chikuwachat.android.ui.ConversationTab
import jp.chikuwachat.android.ui.MainNav
import jp.chikuwachat.android.ui.Route
import jp.chikuwachat.android.ui.SearchDate
import jp.chikuwachat.android.ui.SearchParams
import jp.chikuwachat.android.ui.ThreadFrom
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** M33: the main screen's back stack (MainNav), the paths M16b, M28c and M29 made, kept as they were. */
class MainNavTest {
    private val root = MainNav.root
    private val words = SearchParams(q = "議事録")

    private fun channel(id: String = "c1", tab: ConversationTab = ConversationTab.MESSAGES, details: Boolean = false) = Route.Channel(id, tab, details)

    /** The search bar opened over [stack] and a search run from it: its results on screen. */
    private fun searched(stack: List<Route> = root, params: SearchParams = words) = MainNav.runSearch(MainNav.openSearch(stack), params)

    @Test
    fun theStackStartsAtTheChannelListAndBackThereDoesNothing() {
        assertEquals(listOf(Route.ChannelList), root)
        assertFalse(MainNav.canGoBack(root))
        assertEquals(root, MainNav.back(root))
    }

    @Test
    fun aListReplacesTheChannelListAndBackClosesIt() {
        for (list in listOf(Route.Threads, Route.Saved, Route.Mentions, Route.Drafts, Route.Reminders, Route.Files())) {
            val stack = MainNav.open(root, list)
            assertEquals(list, MainNav.pane(stack))
            assertTrue(MainNav.canGoBack(stack))
            assertEquals(root, MainNav.back(stack))
        }
    }

    @Test
    fun theFilesListsScopeChangesInPlace() {
        val stack = MainNav.scopeFiles(MainNav.open(root, Route.Files()), "c1")
        assertEquals(root + Route.Files("c1"), stack)
        assertEquals(root, MainNav.back(stack))
        // Only the files list has a scope.
        assertEquals(root, MainNav.scopeFiles(root, "c1"))
    }

    @Test
    fun aConversationOpensOnMessagesAndBackClosesIt() {
        val stack = MainNav.openConversation(root, "c1")
        assertEquals(root + channel(), stack)
        assertEquals("c1", MainNav.conversation(stack)?.id)
        assertNull(MainNav.thread(stack))
        assertEquals(root, MainNav.back(stack))
    }

    @Test
    fun backFromThePinsTabReturnsToMessagesBeforeClosingTheConversation() {
        val pins = MainNav.selectTab(MainNav.openConversation(root, "c1"), ConversationTab.PINS)
        assertEquals(root + channel(tab = ConversationTab.PINS), pins)
        val messages = MainNav.back(pins)
        assertEquals(root + channel(), messages)
        assertEquals(root, MainNav.back(messages))
        assertEquals(root + channel(), MainNav.back(MainNav.selectTab(messages, ConversationTab.FILES)))
    }

    @Test
    fun backClosesTheDetailsPageThenTheTabItWasOpenedOver() {
        val details = MainNav.openDetails(MainNav.selectTab(MainNav.openConversation(root, "c1"), ConversationTab.PINS))
        assertEquals(root + channel(tab = ConversationTab.PINS, details = true), details)
        val pins = MainNav.back(details)
        assertEquals(root + channel(tab = ConversationTab.PINS), pins)
        assertEquals(root + channel(), MainNav.back(pins))
        // The details page's own close is the same step.
        assertEquals(pins, MainNav.closeDetails(details))
    }

    @Test
    fun aThreadFromAMessageGoesBackToItsConversation() {
        val stack = MainNav.openThread(MainNav.openConversation(root, "c1"), "p1")
        assertEquals(root + channel() + Route.Thread("c1", "p1", ThreadFrom.CHANNEL), stack)
        assertEquals("p1", MainNav.thread(stack)?.parentId)
        assertEquals("c1", MainNav.conversation(stack)?.id)
        val back = MainNav.back(stack)
        assertEquals(root + channel(), back)
        assertEquals(root, MainNav.back(back))
    }

    @Test
    fun aThreadOpensOnlyFromTheConversationOnScreen() {
        assertEquals(root, MainNav.openThread(root, "p1"))
        val search = MainNav.openSearch(MainNav.openConversation(root, "c1"))
        assertEquals(search, MainNav.openThread(search, "p1"))
    }

    @Test
    fun aThreadFromTheThreadsListGoesBackToTheList() {
        val list = MainNav.open(root, Route.Threads)
        val stack = MainNav.openFromThreadList(list, "c1", "p1")
        assertEquals("p1", MainNav.thread(stack)?.parentId)
        assertEquals("c1", MainNav.conversation(stack)?.id)
        assertEquals(list, MainNav.back(stack))
        assertEquals(root, MainNav.back(MainNav.back(stack)))
    }

    @Test
    fun aNotificationOfAReplyOpensItsThreadOverItsConversation() {
        // M28c: back from the thread shows the conversation, then the channel list.
        val stack = MainNav.openConversation(root, "c1", "p1")
        assertEquals(root + channel() + Route.Thread("c1", "p1"), stack)
        assertEquals(root + channel(), MainNav.back(stack))
    }

    @Test
    fun openingAConversationReplacesTheOneOpenWithWhatBelongedToIt() {
        val busy = MainNav.openThread(MainNav.openConversation(root, "c1"), "p1")
        assertEquals(root + channel("c2"), MainNav.openConversation(busy, "c2"))
        val tabbed = MainNav.openDetails(MainNav.selectTab(MainNav.openConversation(root, "c1"), ConversationTab.FILES))
        // A pin or a file shows its message under 「メッセージ」 of the same conversation.
        assertEquals(root + channel() + Route.Thread("c1", "p9"), MainNav.openConversation(tabbed, "c1", "p9"))
    }

    @Test
    fun theThreadsRemindersAndDraftsListsStayBehindAConversationTheOthersClose() {
        for (kept in listOf(Route.Threads, Route.Reminders, Route.Drafts)) {
            val stack = MainNav.openConversation(MainNav.open(root, kept), "c1")
            assertEquals(root + kept + channel(), stack)
            assertEquals(root + kept, MainNav.back(stack))
        }
        for (closed in listOf(Route.Saved, Route.Mentions, Route.Files(), Route.Files("c3"))) {
            assertEquals(root + channel(), MainNav.openConversation(MainNav.open(root, closed), "c1"))
        }
    }

    @Test
    fun theCalendarStaysBehindAConversationAndAnAlarmLandsOnItsChannelsEventsTab() { // M52
        val calendar = MainNav.open(root, Route.Calendar)
        assertEquals(root + Route.Calendar + channel(), MainNav.openConversation(calendar, "c1"))
        assertEquals(root, MainNav.back(calendar))
        // A channel's alarm: its 「予定」 tab, back to 「メッセージ」 then out (as the other tabs).
        val events = MainNav.openEvents(root, "c1")
        assertEquals(root + channel(tab = ConversationTab.EVENTS), events)
        assertEquals(root + channel(), MainNav.back(events))
        // My own calendar's alarm: the calendar over the list, whatever was open; one already on screen stays.
        assertEquals(root + Route.Calendar, MainNav.openCalendar(root + Route.Saved + channel()))
        assertEquals(calendar, MainNav.openCalendar(calendar))
        // Saved with the rest of the stack (rotation, workspaces).
        assertEquals(root + Route.Calendar + channel(tab = ConversationTab.EVENTS), MainNav.decode(MainNav.encode(root + Route.Calendar + channel(tab = ConversationTab.EVENTS))))
    }

    @Test
    fun aDraftRowClosesTheDraftsList() {
        assertEquals(root + channel() + Route.Thread("c1", "p1"), MainNav.openDraft(MainNav.open(root, Route.Drafts), "c1", "p1"))
        assertEquals(root + channel(), MainNav.openDraft(MainNav.open(root, Route.Drafts), "c1", null))
    }

    @Test
    fun theSearchBarOpensOverWhateverIsOnScreenAndClosesBackToIt() {
        val under = MainNav.openThread(MainNav.selectTab(MainNav.openConversation(root, "c1"), ConversationTab.MESSAGES), "p1")
        val stack = MainNav.openSearch(under)
        assertTrue(MainNav.searching(stack))
        assertEquals(Route.Search(params = null, expanded = true), MainNav.top(stack))
        // The conversation stays the controller's open one while the search shows over it.
        assertEquals("c1", MainNav.conversation(stack)?.id)
        assertEquals("p1", MainNav.thread(stack)?.parentId)
        // Suggestions without results: back leaves the search.
        assertEquals(under, MainNav.back(stack))
        assertEquals(under, MainNav.collapseSearch(stack))
    }

    @Test
    fun backFromSuggestionsOverResultsFoldsThemThenClosesTheSearch() {
        val results = searched()
        assertEquals(Route.Search(words, expanded = false), MainNav.top(results))
        val suggestions = MainNav.expandSearch(results)
        assertEquals(Route.Search(words, expanded = true), MainNav.top(suggestions))
        assertEquals(results, MainNav.back(suggestions))
        assertEquals(results, MainNav.collapseSearch(suggestions))
        assertEquals(root, MainNav.back(results))
    }

    @Test
    fun filtersChangeTheSearchOnScreen() {
        val narrowed = words.copy(fromUserId = "u2", date = SearchDate(preset = "week"))
        val stack = MainNav.changeSearch(searched(), narrowed)
        assertEquals(Route.Search(narrowed, expanded = false), MainNav.top(stack))
        assertEquals(root, MainNav.changeSearch(root, narrowed))
    }

    @Test
    fun aResultInAConversationGoesBackToTheResults() {
        // M16b: the results stay behind the conversation; 「検索結果に戻る」 and back both return to them, folded.
        val results = searched()
        val stack = MainNav.openFromSearch(MainNav.expandSearch(results), "c1", null)
        assertEquals(root + Route.Search(words, expanded = false) + channel(), stack)
        assertFalse(MainNav.searching(stack))
        assertTrue(MainNav.backToSearch(stack))
        assertEquals(words, MainNav.search(stack)?.params)
        assertEquals(results, MainNav.back(stack))
        assertEquals(results, MainNav.returnToSearch(stack))
        assertFalse(MainNav.backToSearch(results))
    }

    @Test
    fun aReplyResultOpensItsThreadAndGoesBackToTheResults() {
        val results = searched()
        val stack = MainNav.openFromSearch(results, "c1", "p1")
        assertEquals("p1", MainNav.thread(stack)?.parentId)
        assertTrue(MainNav.backToSearch(stack))
        assertEquals(results, MainNav.back(stack))
    }

    @Test
    fun aThreadOpenedInsideAResultsConversationGoesBackToTheConversationThenTheResults() {
        val results = searched()
        val inResult = MainNav.openFromSearch(results, "c1", null)
        val thread = MainNav.openThread(inResult, "p1")
        assertTrue(MainNav.backToSearch(thread))
        assertEquals(inResult, MainNav.back(thread))
        assertEquals(results, MainNav.back(inResult))
        // 「検索結果に戻る」 from the thread goes straight back.
        assertEquals(results, MainNav.returnToSearch(thread))
        // The results' own tabs and details go first, as anywhere.
        val pins = MainNav.selectTab(inResult, ConversationTab.PINS)
        assertEquals(inResult, MainNav.back(pins))
    }

    @Test
    fun aResultReplacesTheConversationTheSearchWasOpenedOver() {
        val overConversation = searched(MainNav.openConversation(root, "c1"))
        val stack = MainNav.openFromSearch(overConversation, "c2", null)
        assertEquals(root + Route.Search(words, expanded = false) + channel("c2"), stack)
        assertEquals(root, MainNav.back(MainNav.back(stack)))
    }

    @Test
    fun theSearchStaysOverTheListsKeptBehindAConversation() {
        val stack = MainNav.openFromSearch(searched(MainNav.open(root, Route.Reminders)), "c1", null)
        assertEquals(root + Route.Reminders + Route.Search(words, expanded = false) + channel(), stack)
        val results = MainNav.back(stack)
        assertEquals(root + Route.Reminders, MainNav.back(results))
        // …and closes a list that does not stay.
        assertEquals(root + Route.Search(words, expanded = false) + channel(), MainNav.openFromSearch(searched(MainNav.open(root, Route.Saved)), "c1", null))
    }

    @Test
    fun aNewSearchReplacesTheOneBehindAConversation() {
        val fromResult = MainNav.openFromSearch(searched(), "c1", "p1")
        val stack = MainNav.openSearch(fromResult)
        assertEquals(1, stack.count { it is Route.Search })
        assertEquals(Route.Search(), MainNav.top(stack))
        val closed = MainNav.back(stack)
        assertFalse(MainNav.backToSearch(closed))
        // The result's thread then goes back to its conversation (the old results are gone), then to the channel list.
        val conversation = MainNav.back(closed)
        assertEquals(root + channel(), conversation)
        assertEquals(root, MainNav.back(conversation))
    }

    @Test
    fun anythingElseOpeningAConversationLeavesTheSearch() {
        // A notification or a permalink while a result is open: back no longer returns to the results.
        val fromResult = MainNav.openFromSearch(searched(), "c1", null)
        val stack = MainNav.openConversation(fromResult, "c2", "p2")
        assertEquals(root + channel("c2") + Route.Thread("c2", "p2"), stack)
        assertNull(MainNav.search(stack))
        // A search result opened after its search was closed is a plain conversation.
        assertEquals(root + channel(), MainNav.openFromSearch(root, "c1", null))
    }

    @Test
    fun returnToSearchWithoutASearchChangesNothing() {
        val stack = MainNav.openConversation(root, "c1")
        assertEquals(stack, MainNav.returnToSearch(stack))
        assertFalse(MainNav.backToSearch(stack))
    }

    @Test
    fun aVanishedConversationClosesWithItsThread() {
        val stack = MainNav.openThread(MainNav.openConversation(MainNav.open(root, Route.Threads), "c1"), "p1")
        assertEquals(root + Route.Threads, MainNav.channelGone(stack, "c1"))
        assertEquals(stack, MainNav.channelGone(stack, "other"))
        assertEquals(root, MainNav.channelGone(MainNav.openFromThreadList(root, "c1", "p1"), "c1"))
    }

    @Test
    fun aVanishedResultTakesItsSearchAlongButASearchOverItStays() {
        val fromResult = MainNav.openFromSearch(searched(), "c1", null)
        assertEquals(root, MainNav.channelGone(fromResult, "c1"))
        val overIt = searched(MainNav.openThread(MainNav.openConversation(root, "c1"), "p1"))
        val stack = MainNav.channelGone(overIt, "c1")
        assertEquals(root + Route.Search(words, expanded = false), stack)
        assertNull(MainNav.conversation(stack))
    }

    @Test
    fun leavingAConversationClosesItsTabsAndDetails() {
        val stack = MainNav.openDetails(MainNav.selectTab(MainNav.openConversation(root, "c1"), ConversationTab.FILES))
        assertEquals(root + channel(), MainNav.notMember(stack, "c1"))
        val plain = MainNav.openConversation(root, "c1")
        // Nothing to close: the very same stack (no needless state write while composing).
        assertTrue(plain === MainNav.notMember(plain, "c1"))
    }

    @Test
    fun theStackSurvivesARotation() {
        val deep = MainNav.openThread(
            MainNav.openFromSearch(
                MainNav.changeSearch(searched(MainNav.open(root, Route.Reminders)), words.copy(channelId = "c9", has = listOf("file"), isThread = true, sort = "newest")),
                "c1", null,
            ),
            "p1",
        )
        val stacks = listOf(
            root,
            deep,
            MainNav.openDetails(MainNav.selectTab(MainNav.openConversation(root, "c1"), ConversationTab.PINS)),
            MainNav.openFromThreadList(MainNav.open(root, Route.Threads), "c1", "p1"),
            MainNav.expandSearch(searched()),
            MainNav.openSearch(root),
            MainNav.scopeFiles(MainNav.open(root, Route.Files()), "c2"),
            MainNav.open(root, Route.Saved),
            MainNav.open(root, Route.Mentions),
            MainNav.open(root, Route.Drafts),
        )
        for (stack in stacks) {
            val restored = MainNav.decode(MainNav.encode(stack))
            assertEquals(stack, restored)
            // …and still behaves the same.
            assertEquals(MainNav.back(stack), MainNav.back(restored))
        }
    }

    @Test
    fun anUnreadableSavedStackStartsOverAtTheChannelList() {
        assertEquals(root, MainNav.decode(""))
        assertEquals(root, MainNav.decode("not json"))
        assertEquals(root, MainNav.decode("[]"))
        assertEquals(root, MainNav.decode("""[{"type":"somethingNew"}]"""))
        // A stack must start at the channel list.
        assertEquals(root, MainNav.decode(MainNav.encode(listOf(channel()))))
    }
}
