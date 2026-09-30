package jp.chikuwachat.android

import jp.chikuwachat.android.api.ChannelOut
import jp.chikuwachat.android.api.NotificationPreferenceOut
import jp.chikuwachat.android.api.ThreadSummary
import jp.chikuwachat.android.api.UserMe
import jp.chikuwachat.android.api.UserPublic
import jp.chikuwachat.android.sync.ChannelState
import jp.chikuwachat.android.sync.Store
import jp.chikuwachat.android.ui.ActivitySegment
import jp.chikuwachat.android.ui.Channels
import jp.chikuwachat.android.ui.channelTitle
import jp.chikuwachat.android.ui.introSummary
import jp.chikuwachat.android.ui.myDisplayName
import jp.chikuwachat.android.ui.ConversationTab
import jp.chikuwachat.android.ui.MainNav
import jp.chikuwachat.android.ui.MainTab
import jp.chikuwachat.android.ui.MainTabs
import jp.chikuwachat.android.ui.Route
import jp.chikuwachat.android.ui.SearchParams
import jp.chikuwachat.android.ui.TabStacks
import jp.chikuwachat.android.ui.ThreadFrom
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.ZoneId
import java.time.ZonedDateTime

/** M34: the bottom tabs (MainTabs): badges, the DM list, the per-tab stacks, landing, and what reads. */
class MainTabsTest {
    private val me = "me"
    private val now = Instant.parse("2026-09-29T03:00:00Z")

    private fun channel(
        id: String, type: String = "public", unread: Int = 0, mentions: Int = 0, member: Boolean = true, level: String? = null,
        users: List<String>? = null, lastMessageAt: String? = null, createdAt: String = "2026-01-01T00:00:00Z", timesOwner: String? = null,
    ) = ChannelState(
        channel = ChannelOut(
            id = id, type = type, name = if (type == "dm" || type == "group_dm") null else id, archived = false, lastSeq = 0,
            createdAt = createdAt, updatedAt = createdAt, lastMessageAt = lastMessageAt, dmUserIds = users,
            notification = level?.let { NotificationPreferenceOut(id, it, null, followsDefault = false) }, timesOwnerId = timesOwner,
        ),
        isMember = member, unreadCount = unread, mentionCount = mentions,
    )

    private fun dm(id: String, other: String = "u-$id", unread: Int = 0, mentions: Int = 0, level: String? = null, last: String? = null, member: Boolean = true) =
        channel(id, "dm", unread, mentions, member, level, listOf(me, other), last)

    // --- badges ---

    @Test
    fun theDmBadgeCountsUnreadDmsByTheListsRule() {
        val channels = listOf(
            dm("a", unread = 3),
            channel("g", "group_dm", unread = 1, users = listOf(me, "x", "y")),
            dm("muted", unread = 5, level = "none"), // muted: unread only with a mention
            dm("mutedMention", unread = 5, mentions = 1, level = "none"),
            dm("read"),
            dm("left", unread = 2, member = false),
            channel("general", unread = 4, mentions = 1), // not a DM
        )
        assertEquals(3, MainTabs.dmBadge(channels, me, now))
        assertEquals(0, MainTabs.dmBadge(listOf(dm("read"), channel("general", unread = 9)), me, now))
    }

    @Test
    fun theActivityBadgeAddsThreadsAndChannelsWithAMentionRedWithAMention() {
        val channels = listOf(
            channel("general", unread = 9, mentions = 2),
            channel("random", unread = 3, mentions = 1),
            channel("quiet", unread = 3), // unread, no mention: not activity
            dm("a", unread = 2, mentions = 2), // DMs are the DM tab's
            channel("gone", mentions = 1, member = false),
        )
        assertEquals(MainTabs.ActivityBadge(count = 4 + 2, mention = true), MainTabs.activityBadge(channels, ThreadSummary(unreadCount = 4)))
        // Threads alone: neutral, unless one of them mentions me.
        assertEquals(MainTabs.ActivityBadge(count = 3, mention = false), MainTabs.activityBadge(listOf(channel("quiet", unread = 3)), ThreadSummary(unreadCount = 3)))
        assertEquals(MainTabs.ActivityBadge(count = 3, mention = true), MainTabs.activityBadge(emptyList(), ThreadSummary(unreadCount = 3, mentionCount = 1)))
        assertEquals(MainTabs.ActivityBadge(count = 0, mention = false), MainTabs.activityBadge(emptyList(), ThreadSummary()))
    }

    @Test
    fun theHomeDotShowsForAnUnreadChannelNotADm() {
        assertTrue(MainTabs.homeDot(listOf(channel("general", unread = 1)), me, now))
        assertFalse(MainTabs.homeDot(listOf(dm("a", unread = 3), channel("general")), me, now))
        // The list's rules: a muted channel without a mention, someone else's quiet times, a channel I left.
        assertFalse(MainTabs.homeDot(listOf(channel("m", unread = 2, level = "none")), me, now))
        assertFalse(MainTabs.homeDot(listOf(channel("times-x", unread = 2, timesOwner = "x")), me, now))
        assertTrue(MainTabs.homeDot(listOf(channel("times-x", unread = 2, mentions = 1, timesOwner = "x")), me, now))
        assertFalse(MainTabs.homeDot(listOf(channel("left", unread = 2, member = false)), me, now))
        // An archived channel is not on the home list, so it lights nothing (M37).
        val archived = channel("old", unread = 2)
        assertFalse(MainTabs.homeDot(listOf(archived.copy(channel = archived.channel.copy(archived = true))), me, now))
    }

    // --- the DM list ---

    @Test
    fun theDmListPutsMyNotesFirstThenTheNewest() {
        val notes = channel("notes", "dm", users = listOf(me), lastMessageAt = "2026-01-01T00:00:00Z")
        val old = dm("old", last = "2026-09-01T00:00:00Z")
        val new = dm("new", last = "2026-09-28T10:00:00Z")
        val group = channel("group", "group_dm", users = listOf(me, "x", "y"), lastMessageAt = "2026-09-20T00:00:00Z")
        // No message yet: its creation decides.
        val fresh = dm("fresh", createdAt = "2026-09-25T00:00:00Z")
        val rows = MainTabs.dmList(listOf(old, channel("general"), group, new, fresh, notes, dm("left", member = false)), { it.id }, me)
        assertEquals(listOf("notes", "new", "fresh", "group", "old"), rows.map { it.id })
        assertTrue(MainTabs.isSelfNotes(notes, me))
        assertFalse(MainTabs.isSelfNotes(old, me))
    }

    private fun dm(id: String, createdAt: String) = channel(id, "dm", users = listOf(me, "u-$id"), createdAt = createdAt)

    @Test
    fun theDmListFiltersByName() {
        val names = mapOf("a" to "山田 太郎", "b" to "Sato Hanako", "c" to "佐藤, 山田")
        val channels = names.keys.map { dm(it) }
        val title = { c: ChannelState -> names.getValue(c.id) }
        assertEquals(setOf("a", "c"), MainTabs.dmList(channels, title, me, "山田").map { it.id }.toSet())
        assertEquals(listOf("b"), MainTabs.dmList(channels, title, me, "  sato ").map { it.id })
        assertEquals(3, MainTabs.dmList(channels, title, me, "").size)
    }

    @Test
    fun theSelfNotesPlaceholderShowsUntilMyOwnDmExistsAndMatchesTheFilterAgainstMyName() {
        val others = listOf(dm("a"), channel("group", "group_dm", users = listOf(me, "x", "y")), channel("general"))
        val notes = channel("notes", "dm", users = listOf(me))
        val name = "Hanako Yamada"
        assertFalse(MainTabs.showsSelfNotesPlaceholder(others + notes, me, name))
        assertTrue(MainTabs.showsSelfNotesPlaceholder(others, me, name))
        assertTrue(MainTabs.showsSelfNotesPlaceholder(others, me, name, "  "))
        assertTrue(MainTabs.showsSelfNotesPlaceholder(others, me, name, " hANAko "))
        assertTrue(MainTabs.showsSelfNotesPlaceholder(others, me, name, "hanako yamada"))
        assertFalse(MainTabs.showsSelfNotesPlaceholder(others, me, name, "メモ")) // the old title matches nothing now
        assertFalse(MainTabs.showsSelfNotesPlaceholder(others, me, name, "山田"))
        // Not mine (left): still the placeholder; nobody signed in yet: none.
        assertTrue(MainTabs.showsSelfNotesPlaceholder(others + channel("left", "dm", users = listOf(me), member = false), me, name))
        assertFalse(MainTabs.showsSelfNotesPlaceholder(others, null, name))
        // Nobody signed in: no DM is mine.
        assertFalse(MainTabs.isSelfNotes(channel("empty", "dm", users = emptyList()), null))
    }

    @Test
    fun theHomeDmSectionsPlaceholderIsNotShownFolded() {
        val others = listOf(dm("a"), channel("general"))
        val notes = channel("notes", "dm", users = listOf(me))
        assertTrue(MainTabs.showsSelfNotesInDmSection(others, me, "Hanako"))
        assertFalse(MainTabs.showsSelfNotesInDmSection(others + notes, me, "Hanako")) // it exists (starred or in a section too)
        assertFalse(MainTabs.showsSelfNotesInDmSection(others, me, "Hanako", collapsed = true))
        assertTrue(MainTabs.showsSelfNotesInDmSection(others, me, "Hanako", query = " hana "))
        assertFalse(MainTabs.showsSelfNotesInDmSection(others, me, "Hanako", query = "alice"))
        assertFalse(MainTabs.showsSelfNotesInDmSection(others, null, "…"))
    }

    @Test
    fun myOwnDmIsTitledWithMyName() {
        assertEquals("山田 花子", MainTabs.myName(" 山田 花子 ", "hanako"))
        assertEquals("hanako", MainTabs.myName("  ", "hanako"))
        assertEquals("…", MainTabs.myName(null, null))
        val store = Store()
        val notes = channel("notes", "dm", users = listOf(me))
        store.setMe(UserMe(id = me, username = "hanako", displayName = "Hanako", role = "member", createdAt = "", updatedAt = "", mustChangePassword = false))
        assertEquals("Hanako", channelTitle(notes, store)) // from me, before the users arrive
        store.upsertUser(UserPublic(id = me, username = "hanako", displayName = "山田 花子", role = "member", createdAt = "", updatedAt = ""))
        assertEquals("山田 花子", channelTitle(notes, store))
        assertEquals("山田 花子", myDisplayName(store))
        // Where its conversation starts, it says what it is for; a DM with someone else keeps its words.
        assertEquals(MainTabs.SELF_NOTES_INTRO, introSummary(notes, store))
        store.upsertUser(UserPublic(id = "alice", username = "alice", displayName = "Alice", role = "member", createdAt = "", updatedAt = ""))
        assertEquals("Alice との会話の始まりです。", introSummary(dm("a", other = "alice"), store))
    }

    @Test
    fun myOwnDmComesFirstInTheHomeListsDmSection() {
        val notes = channel("notes", "dm", users = listOf(me), lastMessageAt = "2026-09-01T00:00:00Z")
        val all = listOf(
            dm("alice", last = "2026-09-28T10:00:00Z"),
            notes,
            channel("group", "group_dm", users = listOf(me, "x", "y"), lastMessageAt = "2026-09-28T11:00:00Z", unread = 1),
            dm("bob"),
        )
        assertEquals(listOf("notes", "group", "alice", "bob"), Channels.sections(all, now = now, meId = me).dms.map { it.id })
        // Nobody signed in: recency only.
        assertEquals(listOf("group", "alice", "notes", "bob"), Channels.sections(all, now = now).dms.map { it.id })
        // M37 未読をまとめる: an unread DM moves to 未読; my own DM stays first among the rest.
        val grouped = Channels.sections(all, groupUnread = true, now = now, meId = me)
        assertEquals(listOf("group"), grouped.unread.map { it.id })
        assertEquals(listOf("notes", "alice", "bob"), grouped.dms.map { it.id })
        // Starred: only among the favorites.
        val starred = Channels.sections(all, now = now, favorites = setOf("notes"), meId = me)
        assertEquals(listOf("notes"), starred.favorites.map { it.id })
        assertEquals(listOf("group", "alice", "bob"), starred.dms.map { it.id })
    }

    @Test
    fun theDmWithAUserIsExactlyThemAndMeSoMyOwnIdFindsMyNotes() {
        val alice = dm("a", other = "alice")
        val group = channel("group", "group_dm", users = listOf(me, "bob", "carol"))
        val notes = channel("notes", "dm", users = listOf(me))
        val channels = listOf(alice, group, notes)
        assertEquals("a", MainTabs.findDmWith(channels, "alice", me)?.id)
        assertNull(MainTabs.findDmWith(channels, "bob", me)) // only in a group DM
        assertEquals("notes", MainTabs.findDmWith(channels, me, me)?.id)
        assertNull(MainTabs.findDmWith(listOf(alice, group), me, me)) // never a 1:1 DM
        assertEquals("a", MainTabs.findDmWith(listOf(notes, alice), "alice", me)?.id)
    }

    @Test
    fun theDmTimeLabelFollowsTheSharedRule() {
        val tokyo = ZoneId.of("Asia/Tokyo")
        val at = ZonedDateTime.of(2026, 9, 29, 12, 0, 0, 0, tokyo) // a Tuesday
        fun label(local: String) = MainTabs.dmTimeLabel(java.time.LocalDateTime.parse(local).atZone(tokyo).toInstant().toString(), at)
        assertEquals("9:05", label("2026-09-29T09:05:00"))
        assertEquals("0:00", label("2026-09-29T00:00:00"))
        assertEquals("昨日", label("2026-09-28T23:59:00"))
        assertEquals("日曜日", label("2026-09-27T10:00:00"))
        assertEquals("水曜日", label("2026-09-23T10:00:00")) // 6 days before
        assertEquals("9/22", label("2026-09-22T10:00:00")) // 7 days before
        assertEquals("1/5", label("2026-01-05T10:00:00"))
        assertEquals("2025/12/31", label("2025-12-31T10:00:00"))
        // Local time decides the day: 2026-09-28T16:00Z is the 29th in Tokyo.
        assertEquals("1:00", MainTabs.dmTimeLabel("2026-09-28T16:00:00Z", at))
        assertNull(MainTabs.dmTimeLabel(null, at))
        assertNull(MainTabs.dmTimeLabel("not a time", at))
    }

    // --- the stacks ---

    private val start = MainTabs.initial

    @Test
    fun everyTabStartsAtItsRootOnHome() {
        assertEquals(MainTab.HOME, start.selected)
        assertEquals(listOf(Route.ChannelList), MainTabs.stack(start, MainTab.HOME))
        assertEquals(listOf(Route.DmList), MainTabs.stack(start, MainTab.DM))
        assertEquals(listOf(Route.Activity()), MainTabs.stack(start, MainTab.ACTIVITY))
        assertEquals(listOf(Route.You), MainTabs.stack(start, MainTab.YOU))
        assertFalse(MainTabs.canGoBack(start))
        assertEquals(start, MainTabs.back(start))
    }

    @Test
    fun aTabSwitchKeepsEveryStack() {
        val home = MainTabs.update(start) { MainNav.openConversation(it, "general", "p1") }
        val dm = MainTabs.update(MainTabs.tap(home, MainTab.DM).state) { MainNav.openConversation(it, "d1") }
        assertEquals(MainTab.DM, dm.selected)
        assertEquals(listOf(Route.DmList, Route.Channel("d1")), MainTabs.stack(dm))
        val back = MainTabs.tap(dm, MainTab.HOME)
        assertFalse(back.scrollToTop)
        assertEquals(MainTab.HOME, back.state.selected)
        assertEquals(listOf(Route.ChannelList, Route.Channel("general"), Route.Thread("general", "p1")), MainTabs.stack(back.state))
        assertEquals(listOf(Route.DmList, Route.Channel("d1")), MainTabs.stack(back.state, MainTab.DM))
    }

    @Test
    fun reTappingTheSelectedTabPopsToItsRootThenScrollsUp() {
        val deep = MainTabs.update(start) { MainNav.openFromThreadList(MainNav.open(it, Route.Threads), "c1", "p1") }
        val popped = MainTabs.tap(deep, MainTab.HOME)
        assertFalse(popped.scrollToTop)
        assertEquals(listOf(Route.ChannelList), MainTabs.stack(popped.state))
        val again = MainTabs.tap(popped.state, MainTab.HOME)
        assertTrue(again.scrollToTop)
        assertEquals(popped.state, again.state)
        // The activity tab pops to its root on the segment it was on.
        val activity = MainTabs.update(MainTabs.selectSegment(MainTabs.tap(start, MainTab.ACTIVITY).state, ActivitySegment.THREADS)) { MainNav.openConversation(it, "c1") }
        assertEquals(listOf(Route.Activity(ActivitySegment.THREADS)), MainTabs.stack(MainTabs.tap(activity, MainTab.ACTIVITY).state))
    }

    @Test
    fun backPopsTheTabThenGoesHomeFromAnotherTabsRoot() {
        val dm = MainTabs.update(MainTabs.tap(start, MainTab.DM).state) { MainNav.openConversation(it, "d1") }
        assertTrue(MainTabs.canGoBack(dm))
        val atRoot = MainTabs.back(dm)
        assertEquals(MainTab.DM, atRoot.selected)
        assertEquals(listOf(Route.DmList), MainTabs.stack(atRoot))
        assertTrue(MainTabs.canGoBack(atRoot))
        val home = MainTabs.back(atRoot)
        assertEquals(MainTab.HOME, home.selected)
        // At the home root the system's back closes the app (nothing handles it).
        assertFalse(MainTabs.canGoBack(home))
        for (tab in listOf(MainTab.ACTIVITY, MainTab.YOU)) assertEquals(MainTab.HOME, MainTabs.back(MainTabs.tap(start, tab).state).selected)
        // Home keeps its own stack meanwhile, and back there pops it first.
        val homeDeep = MainTabs.update(start) { MainNav.openConversation(it, "c1") }
        val fromYou = MainTabs.back(MainTabs.tap(homeDeep, MainTab.YOU).state)
        assertEquals(listOf(Route.ChannelList, Route.Channel("c1")), MainTabs.stack(fromYou))
        assertEquals(listOf(Route.ChannelList), MainTabs.stack(MainTabs.back(fromYou)))
    }

    @Test
    fun aDmLandsOnTheDmTabAndAChannelOnHome() {
        assertEquals(MainTab.DM, MainTabs.landingTab(dm("d1")))
        assertEquals(MainTab.DM, MainTabs.landingTab(channel("g", "group_dm", users = listOf(me, "x", "y"))))
        assertEquals(MainTab.HOME, MainTabs.landingTab(channel("general")))
        assertEquals(MainTab.HOME, MainTabs.landingTab(null))
        // From the activity tab with something open on every tab: the target's stack is replaced, the others kept.
        val busy = MainTabs.update(MainTabs.tap(
            MainTabs.update(MainTabs.tap(MainTabs.update(start) { MainNav.open(it, Route.Saved) }, MainTab.DM).state) { MainNav.openConversation(it, "d2") },
            MainTab.ACTIVITY,
        ).state) { MainNav.openConversation(it, "c9") }
        val toDm = MainTabs.land(busy, MainTab.DM, "d1")
        assertEquals(MainTab.DM, toDm.selected)
        assertEquals(listOf(Route.DmList, Route.Channel("d1")), MainTabs.stack(toDm))
        assertEquals(listOf(Route.Activity(), Route.Channel("c9")), MainTabs.stack(toDm, MainTab.ACTIVITY))
        assertEquals(listOf(Route.ChannelList, Route.Saved), MainTabs.stack(toDm, MainTab.HOME))
        val toHome = MainTabs.land(busy, MainTab.HOME, "c1", "p1")
        assertEquals(MainTab.HOME, toHome.selected)
        assertEquals(listOf(Route.ChannelList, Route.Channel("c1"), Route.Thread("c1", "p1")), MainTabs.stack(toHome))
        assertEquals(listOf(Route.DmList, Route.Channel("d2")), MainTabs.stack(toHome, MainTab.DM))
        // M52: a calendar alarm lands on the home tab: its channel's 「予定」 tab, or the calendar for my own event.
        val toEvents = MainTabs.landEvents(busy, "c1")
        assertEquals(MainTab.HOME, toEvents.selected)
        assertEquals(listOf(Route.ChannelList, Route.Channel("c1", tab = ConversationTab.EVENTS)), MainTabs.stack(toEvents))
        assertEquals(listOf(Route.Activity(), Route.Channel("c9")), MainTabs.stack(toEvents, MainTab.ACTIVITY))
        val toCalendar = MainTabs.landCalendar(busy)
        assertEquals(MainTab.HOME, toCalendar.selected)
        assertEquals(listOf(Route.ChannelList, Route.Calendar), MainTabs.stack(toCalendar))
    }

    @Test
    fun anActivityRowPushesOnTheActivityStack() {
        val activity = MainTabs.tap(start, MainTab.ACTIVITY).state
        val mention = MainTabs.update(activity) { MainNav.openConversation(it, "c1", "p1") }
        assertEquals(MainTab.ACTIVITY, mention.selected)
        assertEquals(listOf(Route.Activity(), Route.Channel("c1"), Route.Thread("c1", "p1")), MainTabs.stack(mention))
        assertEquals(listOf(Route.Activity()), MainTabs.stack(MainTabs.back(MainTabs.back(mention))))
        // A thread row: back returns to the list at once, on the segment it was on.
        val threads = MainTabs.selectSegment(activity, ActivitySegment.THREADS)
        val thread = MainTabs.update(threads) { MainNav.openFromThreadList(it, "c1", "p1") }
        assertEquals(Route.Thread("c1", "p1", ThreadFrom.LIST), MainNav.top(MainTabs.stack(thread)))
        assertEquals(listOf(Route.Activity(ActivitySegment.THREADS)), MainTabs.stack(MainTabs.back(thread)))
        // The home tab is untouched.
        assertEquals(listOf(Route.ChannelList), MainTabs.stack(thread, MainTab.HOME))
    }

    @Test
    fun aSearchResultLandsOnItsTabWithTheResultsKept() {
        val words = SearchParams(q = "議事録")
        val searched = MainTabs.update(start) { MainNav.runSearch(MainNav.openSearch(it), words) }
        // A channel, on home where the search is: the results stay behind it (M16b).
        val channel = MainTabs.landFromSearch(searched, MainTab.HOME, "c1", null)
        assertEquals(listOf(Route.ChannelList, Route.Search(words, expanded = false), Route.Channel("c1")), MainTabs.stack(channel))
        assertTrue(MainNav.backToSearch(MainTabs.stack(channel)))
        // A DM: on the DM tab; home keeps the results for when it comes back.
        val dm = MainTabs.landFromSearch(searched, MainTab.DM, "d1", "p1")
        assertEquals(MainTab.DM, dm.selected)
        assertEquals(listOf(Route.DmList, Route.Channel("d1"), Route.Thread("d1", "p1")), MainTabs.stack(dm))
        assertEquals(listOf(Route.ChannelList, Route.Search(words, expanded = false)), MainTabs.stack(dm, MainTab.HOME))
    }

    @Test
    fun onlyTheSelectedTabsTopConversationIsOnScreen() {
        val home = MainTabs.update(start) { MainNav.openConversation(it, "c1") }
        assertTrue(MainTabs.conversationOnScreen(home, MainTab.HOME))
        assertEquals("c1", MainTabs.openConversation(home)?.id)
        // Left on home while the DM tab shows: not looked at, and not the engine's open conversation.
        val dmTab = MainTabs.tap(home, MainTab.DM).state
        assertFalse(MainTabs.conversationOnScreen(dmTab, MainTab.HOME))
        assertNull(MainTabs.openConversation(dmTab))
        val dm = MainTabs.update(dmTab) { MainNav.openConversation(it, "d1") }
        assertTrue(MainTabs.conversationOnScreen(dm, MainTab.DM))
        assertFalse(MainTabs.conversationOnScreen(dm, MainTab.HOME))
        assertEquals("d1", MainTabs.openConversation(dm)?.id)
        // Under another screen, or covered by a tab or the details (M29): not on screen either.
        val thread = MainTabs.update(dm) { MainNav.openThread(it, "p1") }
        assertFalse(MainTabs.conversationOnScreen(thread, MainTab.DM))
        assertEquals("d1", MainTabs.openConversation(thread)?.id) // the thread's conversation stays open in the engine
        assertFalse(MainTabs.conversationOnScreen(MainTabs.update(dm) { MainNav.selectTab(it, ConversationTab.PINS) }, MainTab.DM))
        assertFalse(MainTabs.conversationOnScreen(MainTabs.update(dm) { MainNav.openDetails(it) }, MainTab.DM))
        assertFalse(MainTabs.conversationOnScreen(MainTabs.update(dm) { MainNav.openSearch(it) }, MainTab.DM))
        assertFalse(MainTabs.conversationOnScreen(start, MainTab.HOME))
    }

    @Test
    fun theBarShowsOnRootsAndListsNotInAConversation() {
        assertTrue(MainTabs.barShown(listOf(Route.ChannelList)))
        assertTrue(MainTabs.barShown(listOf(Route.DmList)))
        assertTrue(MainTabs.barShown(listOf(Route.ChannelList, Route.Threads)))
        assertFalse(MainTabs.barShown(listOf(Route.ChannelList, Route.Channel("c1"))))
        assertFalse(MainTabs.barShown(listOf(Route.ChannelList, Route.Channel("c1", detailsOpen = true))))
        assertFalse(MainTabs.barShown(listOf(Route.Activity(), Route.Channel("c1"), Route.Thread("c1", "p1"))))
        assertFalse(MainTabs.barShown(listOf(Route.ChannelList, Route.Search())))
        assertTrue(MainTabs.barShown(listOf(Route.ChannelList, Route.Search(SearchParams(q = "x"), expanded = false))))
    }

    @Test
    fun aVanishedConversationClosesOnEveryTab() {
        val state = MainTabs.update(MainTabs.tap(MainTabs.update(start) { MainNav.openConversation(it, "c1", "p1") }, MainTab.ACTIVITY).state) {
            MainNav.openConversation(it, "c1")
        }
        assertEquals(setOf("c1"), MainTabs.conversations(state))
        val gone = MainTabs.channelGone(state, "c1")
        assertEquals(listOf(Route.ChannelList), MainTabs.stack(gone, MainTab.HOME))
        assertEquals(listOf(Route.Activity()), MainTabs.stack(gone, MainTab.ACTIVITY))
        assertEquals(state, MainTabs.channelGone(state, "other"))
        val pinned = MainTabs.update(state) { MainNav.selectTab(it, ConversationTab.PINS) }
        assertEquals(state, MainTabs.notMember(pinned, "c1"))
    }

    @Test
    fun theTabsAreSavedAsOneString() {
        val state = MainTabs.update(
            MainTabs.selectSegment(MainTabs.tap(MainTabs.update(start) { MainNav.runSearch(MainNav.openSearch(it), SearchParams(q = "x")) }, MainTab.ACTIVITY).state, ActivitySegment.THREADS),
        ) { MainNav.openFromThreadList(it, "c1", "p1") }
        assertEquals(state, MainTabs.decode(MainTabs.encode(state)))
        assertEquals(MainTabs.initial, MainTabs.decode("not json"))
        // A stack saved under the wrong tab (or rootless) shows that tab's root instead.
        val odd = TabStacks(MainTab.DM, mapOf(MainTab.DM to listOf(Route.ChannelList, Route.Channel("c1")), MainTab.HOME to listOf(Route.Channel("c2"))))
        assertEquals(listOf(Route.DmList), MainTabs.stack(odd))
        assertEquals(listOf(Route.ChannelList), MainTabs.stack(odd, MainTab.HOME))
    }
}
