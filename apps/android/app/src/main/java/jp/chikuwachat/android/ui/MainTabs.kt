package jp.chikuwachat.android.ui

import androidx.compose.runtime.saveable.Saver
import jp.chikuwachat.android.api.ActivitySummaryOut
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.ThreadSummary
import jp.chikuwachat.android.sync.ChannelState
import jp.chikuwachat.android.sync.DmCloses
import java.time.DayOfWeek
import java.time.Instant
import java.time.ZonedDateTime
import java.time.temporal.ChronoUnit
import kotlinx.serialization.Serializable
import jp.chikuwachat.android.R
import jp.chikuwachat.android.L10n

/** M34 (MOBILE_UI.md §5): the phone's bottom tabs, in the bar's order (2026-10-27: 「検索」 before 自分). */
enum class MainTab(private val labelRes: Int) {
    HOME(R.string.main_tabs_home),
    DM(R.string.main_tabs_dm),
    ACTIVITY(R.string.common_activity),
    SEARCH(R.string.common_search),
    YOU(R.string.common_you);

    val label: String get() = L10n.str(labelRes)
}

/**
 * M34: every bottom tab's back stack ([MainNav]) and the tab on screen. A tab never opened has no entry (its root).
 * Serializable: saved as one string, like M33's single stack (a rotation, and each workspace's state in AppRoot).
 */
@Serializable
data class TabStacks(val selected: MainTab = MainTab.HOME, val stacks: Map<MainTab, List<Route>> = emptyMap())

/**
 * M34 (MOBILE_UI.md §5, §6.3, §6.4 stage A, §8; IMPLEMENTATION_PLAN.md M34): the bottom tabs as pure functions, tested
 * in MainTabsTest. The rules the web and iOS share: the tab badges (on top of [Channels]' unread rules, unchanged), the
 * DM list's order and time labels, where a notification / permalink / search result lands, and the per-tab stacks.
 *
 * Only the selected tab's top screen is composed (MainScreen), so a conversation left on another tab reads nothing, and
 * the engine's open conversation is the selected tab's ([openConversation]).
 */
object MainTabs {
    val initial = TabStacks()

    fun root(tab: MainTab): Route.Root = when (tab) {
        MainTab.HOME -> Route.ChannelList
        MainTab.DM -> Route.DmList
        MainTab.ACTIVITY -> Route.Activity()
        MainTab.SEARCH -> Route.SearchHome
        MainTab.YOU -> Route.You
    }

    /** The 「検索」 tab's own screen: the jump screen (MOBILE_UI.md §6.2), empty. */
    val SEARCH_SCREEN: Route.Search = Route.Search(jump = true)

    /** A tab's stack at its root: its root screen; the 「検索」 tab's root with its own search over it. */
    private fun rootStack(tab: MainTab): List<Route> = if (tab == MainTab.SEARCH) listOf(Route.SearchHome, SEARCH_SCREEN) else listOf(root(tab))

    /** The tab a root screen belongs to (a stack saved for one tab never shows on another). */
    private fun tabOf(root: Route.Root): MainTab = when (root) {
        Route.ChannelList -> MainTab.HOME
        Route.DmList -> MainTab.DM
        is Route.Activity -> MainTab.ACTIVITY
        Route.You -> MainTab.YOU
        Route.SearchHome -> MainTab.SEARCH
    }

    // --- what is on screen ---

    /** `tab`'s stack as it was left (its root when never opened). */
    fun stack(state: TabStacks, tab: MainTab = state.selected): List<Route> {
        val saved = state.stacks[tab]?.takeIf { MainNav.valid(it) && tabOf(MainNav.rootOf(it)) == tab } ?: return rootStack(tab)
        // The 「検索」 tab's search is never closed (back from its results, a conversation gone): an empty one comes back.
        return if (tab == MainTab.SEARCH && !MainNav.tabSearch(saved, 1)) rootStack(tab) + saved.drop(1) else saved
    }

    /** At the tab's root: its root screen alone; on 「検索」 its search (with or without results), nothing over it. */
    fun atRoot(state: TabStacks, tab: MainTab = state.selected): Boolean = stack(state, tab).size == rootStack(tab).size

    /** The 「検索」 tab's empty search, nothing over it: its bar has no ← (the tab bar is the way out). */
    fun searchTabRoot(stack: List<Route>): Boolean =
        stack.size == 2 && MainNav.tabSearch(stack, 1) && (stack[1] as Route.Search).params == null

    /** The conversation the engine keeps open: the selected tab's (kept while a search or a thread shows over it). */
    fun openConversation(state: TabStacks): Route.Channel? = MainNav.conversation(stack(state))

    /**
     * Whether `tab`'s conversation timeline is being looked at (SYNC_PROTOCOL.md §10.1 2., MOBILE_UI.md §10 1.): only on
     * the selected tab, as its top screen, on 「メッセージ」 without the details page over it.
     */
    fun conversationOnScreen(state: TabStacks, tab: MainTab): Boolean {
        if (tab != state.selected) return false
        val top = MainNav.top(stack(state, tab)) as? Route.Channel ?: return false
        return ConversationNav.conversationOnScreen(top.tab, top.detailsOpen)
    }

    /**
     * The bar shows on the roots and the lists pushed on them (and a search's results), and hides inside a
     * conversation, a thread, the details page and while typing a search (Slack).
     */
    fun barShown(stack: List<Route>): Boolean = when (val top = MainNav.top(stack)) {
        is Route.Root, is Route.Pane -> true
        // 2026-10-27: the 「検索」 tab's own search is a tab root: the bar stays (the keyboard covers it while typing).
        is Route.Search -> !top.expanded || (stack.size == 2 && MainNav.tabSearch(stack, 1))
        // M40: a settings screen is a page of its own (its fields take the keyboard); the wide list shows the bar itself.
        is Route.Channel, is Route.Thread, is Route.Settings -> false
    }

    // --- transitions ---

    /** `change` applied to the selected tab's stack. */
    fun update(state: TabStacks, change: (List<Route>) -> List<Route>): TabStacks = withStack(state, state.selected, change(stack(state)))

    fun withStack(state: TabStacks, tab: MainTab, stack: List<Route>): TabStacks = state.copy(stacks = state.stacks + (tab to stack))

    /**
     * What a tap on the bar does: the new state, whether the tab's list scrolls to its top, and (「検索」) whether its
     * search field takes the cursor.
     */
    data class Tap(val state: TabStacks, val scrollToTop: Boolean, val focusSearch: Boolean = false)

    /**
     * A tap on the bar (MOBILE_UI.md §5): another tab comes back as it was left; the selected one pops to its root, or,
     * at its root already, scrolls its list to the top. 「検索」 (2026-10-27) pops to its search (its results kept), and
     * there puts the cursor in the field (the suggestions open over any results).
     */
    fun tap(state: TabStacks, tab: MainTab): Tap = when {
        tab != state.selected -> Tap(state.copy(selected = tab), scrollToTop = false)
        tab == MainTab.SEARCH && atRoot(state) -> Tap(update(state, MainNav::expandSearch), scrollToTop = false, focusSearch = true)
        atRoot(state) -> Tap(state, scrollToTop = true)
        else -> Tap(withStack(state, tab, stack(state).take(rootStack(tab).size)), scrollToTop = false)
    }

    /**
     * 2026-10-27: the home's 「移動・検索」 and Ctrl+K: the 「検索」 tab, emptied to its root (what was open on it closes);
     * the caller puts the cursor in its field.
     */
    fun openSearchTab(state: TabStacks): TabStacks = withStack(state, MainTab.SEARCH, rootStack(MainTab.SEARCH)).copy(selected = MainTab.SEARCH)

    /** The selected tab's stack after back, when it changes ([MainNav.back]; the 「検索」 tab's search never closes). */
    private fun popped(state: TabStacks): TabStacks? {
        val stack = stack(state)
        if (!MainNav.canGoBack(stack)) return null
        val next = update(state, MainNav::back)
        return next.takeIf { stack(it) != stack }
    }

    /** Whether back has something to pop on the selected tab (the bar's ←). */
    fun canPop(state: TabStacks): Boolean = popped(state) != null

    /** Whether the system's back stays in the app: something to pop, or a tab other than home to leave. */
    fun canGoBack(state: TabStacks): Boolean = canPop(state) || state.selected != MainTab.HOME

    /** Back: the selected tab's stack pops ([MainNav.back]); at another tab's root, to the home tab. */
    fun back(state: TabStacks): TabStacks = popped(state) ?: if (state.selected != MainTab.HOME) state.copy(selected = MainTab.HOME) else state

    /** A notification, permalink or search result: a DM on the DM tab, a channel (and its thread) on the home tab. */
    fun landingTab(channel: ChannelState?): MainTab = if (channel?.channel?.isDm == true) MainTab.DM else MainTab.HOME

    /** Lands a conversation (and its thread) on `tab`: that tab's stack becomes [root, conversation, (thread)] and shows. */
    fun land(state: TabStacks, tab: MainTab, channelId: String, parentId: String? = null): TabStacks =
        withStack(state, tab, MainNav.openConversation(rootStack(tab), channelId, parentId)).copy(selected = tab)

    /** M46: a `/c/<id>` link lands like a permalink, on the canvas's conversation's 「キャンバス」 tab. */
    fun landCanvas(state: TabStacks, tab: MainTab, channelId: String, canvasId: String): TabStacks =
        withStack(state, tab, MainNav.openCanvas(rootStack(tab), channelId, canvasId)).copy(selected = tab)

    /** A home-screen widget's body: the home tab at its root (its list). */
    fun landHome(state: TabStacks): TabStacks = withStack(state, MainTab.HOME, rootStack(MainTab.HOME)).copy(selected = MainTab.HOME)

    /**
     * M52: a calendar alarm (2026-10-28: a channel's too, the calendar filtered to it) or a conversation's
     * 「このチャンネルの予定」: the home tab shows the calendar over its list.
     */
    fun landCalendar(state: TabStacks): TabStacks =
        withStack(state, MainTab.HOME, MainNav.openCalendar(rootStack(MainTab.HOME))).copy(selected = MainTab.HOME)

    /** M56: a shared task's notification lands on its channel's 「タスク」 tab (home tab: never a DM). */
    fun landTasks(state: TabStacks, channelId: String): TabStacks =
        withStack(state, MainTab.HOME, MainNav.openTasks(rootStack(MainTab.HOME), channelId)).copy(selected = MainTab.HOME)

    /** M112: a reservation notice: the home tab shows 「予約」 over its list. */
    fun landReservations(state: TabStacks): TabStacks =
        withStack(state, MainTab.HOME, MainNav.openReservations(rootStack(MainTab.HOME))).copy(selected = MainTab.HOME)

    /** M172: a lending notice (`kind = lending`): the home tab shows its loan / item over 「備品」, or the overdue list. */
    fun landLending(state: TabStacks, itemId: String?, loanId: String?): TabStacks =
        withStack(state, MainTab.HOME, MainNav.landLending(rootStack(MainTab.HOME), itemId, loanId)).copy(selected = MainTab.HOME)

    /** M122: a page's notification (`kind = page`, WIKI.md §9.3): the home tab shows the page over 「ドキュメント」. */
    fun landPage(state: TabStacks, pageId: String): TabStacks =
        withStack(state, MainTab.HOME, MainNav.landPage(rootStack(MainTab.HOME), pageId)).copy(selected = MainTab.HOME)

    /**
     * M166 (docs/DRIVE.md §26): a /d/ link opened from outside the screen it was on (an incoming link): the home tab shows
     * the folder over 「ドライブ」's list — back goes to the list, then the home.
     */
    fun landDrive(state: TabStacks, locationId: String, folderId: String, itemId: String?): TabStacks =
        withStack(state, MainTab.HOME, rootStack(MainTab.HOME) + Route.Drive() + Route.Drive(locationId, folderId, itemId)).copy(selected = MainTab.HOME)

    /** M56: a personal task's notification: the home tab shows 「タスク」 over its list. */
    fun landMyTasks(state: TabStacks): TabStacks =
        withStack(state, MainTab.HOME, MainNav.openMyTasks(rootStack(MainTab.HOME))).copy(selected = MainTab.HOME)

    /**
     * A search result lands on its tab. On the tab the search is on, the results stay behind the conversation (M16b:
     * back and 「検索結果に戻る」 return to them); on another tab, the search's tab keeps its results for when it comes back.
     * A reply's thread (2026-10-27) always opens over the results on the search's tab, so back returns to them
     * ([MainNav.openFromSearch]; `besideChannel`: three panes).
     */
    fun landFromSearch(state: TabStacks, tab: MainTab, channelId: String, parentId: String?, besideChannel: Boolean = false): TabStacks =
        if (tab == state.selected || state.selected == MainTab.SEARCH || (parentId != null && MainNav.search(stack(state)) != null)) update(state) { MainNav.openFromSearch(it, channelId, parentId, besideChannel) }
        else land(update(state, MainNav::returnToSearch), tab, channelId, parentId)

    /** M58: a canvas from the search's results, landing as a message result does ([landFromSearch]). */
    fun landCanvasFromSearch(state: TabStacks, tab: MainTab, channelId: String, canvasId: String): TabStacks =
        if (tab == state.selected || state.selected == MainTab.SEARCH) update(state) { MainNav.openCanvasFromSearch(it, channelId, canvasId) }
        else landCanvas(update(state, MainNav::returnToSearch), tab, channelId, canvasId)

    /**
     * M37 (MOBILE_UI.md §6.1, §6.2): a conversation picked on the jump screen or the ✏️ picker, both over the home tab:
     * the home tab goes back to its list (the jump screen and any results behind it close), then the conversation lands
     * on its tab like a notification's (a DM on the DM tab, a channel on home).
     */
    fun landFromHome(state: TabStacks, tab: MainTab, channelId: String): TabStacks =
        land(withStack(state, MainTab.HOME, rootStack(MainTab.HOME)), tab, channelId)

    /**
     * 2026-10-27: a conversation or person picked on the jump screen. On the 「検索」 tab it opens over the search (back
     * returns to it, as typed); a jump screen left over another tab (an older build's) lands as [landFromHome].
     */
    fun landFromJump(state: TabStacks, tab: MainTab, channelId: String): TabStacks =
        if (state.selected == MainTab.SEARCH) update(state) { MainNav.openConversation(it, channelId) } else landFromHome(state, tab, channelId)

    /**
     * M40: a 自分 screen opened from elsewhere (my profile card's 「ステータスを設定」): the 自分 tab shows it over its
     * list; what that tab had open goes.
     */
    fun openSettings(state: TabStacks, page: SettingsPage): TabStacks =
        withStack(state, MainTab.YOU, listOf(Route.You, Route.Settings(page))).copy(selected = MainTab.YOU)

    /** The activity tab's switch. */
    fun selectSegment(state: TabStacks, segment: ActivitySegment): TabStacks {
        val stack = stack(state, MainTab.ACTIVITY)
        return withStack(state, MainTab.ACTIVITY, listOf(Route.Activity(segment)) + stack.drop(1))
    }

    /** A conversation vanished: it closes on every tab ([MainNav.channelGone]). */
    fun channelGone(state: TabStacks, channelId: String): TabStacks = mapStacks(state) { MainNav.channelGone(it, channelId) }

    /** A conversation I am not (or no longer) in: its tabs and details close on every tab ([MainNav.notMember]). */
    fun notMember(state: TabStacks, channelId: String): TabStacks = mapStacks(state) { MainNav.notMember(it, channelId) }

    /** Every conversation open on some tab. */
    fun conversations(state: TabStacks): Set<String> =
        MainTab.entries.mapNotNull { MainNav.conversation(stack(state, it))?.id }.toSet()

    private fun mapStacks(state: TabStacks, change: (List<Route>) -> List<Route>): TabStacks {
        val changed = MainTab.entries.mapNotNull { tab -> change(stack(state, tab)).takeIf { it != stack(state, tab) }?.let { tab to it } }
        return if (changed.isEmpty()) state else state.copy(stacks = state.stacks + changed)
    }

    // --- badges (§8) ---

    /** DM tab: my DMs and group DMs unread by the list's rule (a muted one only with a mention). */
    fun dmBadge(channels: Collection<ChannelState>, meId: String?, now: Instant = Instant.now()): Int =
        channels.count { it.isMember && it.channel.isDm && Channels.hasUnread(it, meId, now) }

    /** The activity tab's badge: a number, red when it holds a mention. */
    data class ActivityBadge(val count: Int, val mention: Boolean)

    /**
     * Activity tab. M39 (stage B, MOBILE_UI.md §6.4): the server's `activity` summary, the items after my read position,
     * red when a mention is among them. Without one (a server before M39, or no bootstrap yet), stage A: the followed
     * threads' unread count plus my channels (not DMs) with a mention; red when any of those mentions me.
     */
    fun activityBadge(channels: Collection<ChannelState>, threads: ThreadSummary, activity: ActivitySummaryOut? = null): ActivityBadge {
        if (activity != null) return ActivityBadge(activity.unreadCount, mention = activity.unreadCount > 0 && activity.mentionUnread)
        val mentioned = channels.count { it.isMember && !it.channel.isDm && it.mentionCount > 0 }
        return ActivityBadge(threads.unreadCount + mentioned, mention = mentioned > 0 || threads.mentionCount > 0)
    }

    /** Home tab: a dot while any channel (not a DM) of mine is unread by the list's rule. */
    fun homeDot(channels: Collection<ChannelState>, meId: String?, now: Instant = Instant.now()): Boolean =
        // Not an archived channel: the home list does not show it, so its dot would point at nothing.
        channels.any { it.isMember && !it.channel.archived && !it.channel.isDm && Channels.hasUnread(it, meId, now) }

    // --- the DM list (§6.3) ---

    /** My own DM (Slack / Mattermost): a DM with nobody but me, titled with my name (channelTitle). */
    fun isSelfNotes(channel: ChannelState, meId: String?): Boolean =
        meId != null && channel.channel.type == "dm" && (channel.channel.dmUserIds ?: emptyList()).all { it == meId }

    /** What my own DM says where its conversation starts (empty, or at the start of its history). */
    val SELF_NOTES_INTRO: String get() = L10n.str(R.string.main_tabs_this_is_your_own_space_keep)

    /** The new-DM picker's words after my name. */
    val SELF_NOTES_HINT: String get() = L10n.str(R.string.main_tabs_your_own_dm_for_notes_and)

    /** My name as the lists show it: my display name, else my username, else 「…」 (not loaded yet). */
    fun myName(displayName: String?, username: String?): String =
        displayName?.trim()?.takeIf { it.isNotEmpty() } ?: username?.trim()?.takeIf { it.isNotEmpty() } ?: "…"

    /**
     * Whether a DM list shows my own DM's placeholder row first: no DM with only me is mine yet (a tap on the row makes
     * it), and the filter is empty or matches my name (`name`, as myName gives it), ignoring case.
     */
    fun showsSelfNotesPlaceholder(channels: Collection<ChannelState>, meId: String?, name: String, query: String = ""): Boolean {
        if (meId == null || channels.any { it.isMember && isSelfNotes(it, meId) }) return false
        val needle = query.trim().lowercase()
        return needle.isEmpty() || name.trim().lowercase().contains(needle)
    }

    /**
     * The home list's 「ダイレクトメッセージ」 section: the placeholder as above, but never while the section is folded.
     * (My own DM starred or in one of my sections exists, so no placeholder either.)
     */
    fun showsSelfNotesInDmSection(
        channels: Collection<ChannelState>, meId: String?, name: String, collapsed: Boolean = false, query: String = "",
    ): Boolean = !collapsed && showsSelfNotesPlaceholder(channels, meId, name, query)

    /**
     * The DM (not group DM) whose members are exactly `userId` and me — with `userId` = me, my own DM, never one of my
     * 1:1 DMs.
     */
    fun findDmWith(channels: Collection<ChannelState>, userId: String, meId: String?): ChannelState? {
        val wanted = setOfNotNull(userId, meId)
        return channels.firstOrNull { it.channel.type == "dm" && (it.channel.dmUserIds ?: emptyList()).toSet() == wanted }
    }

    /**
     * My DMs and group DMs: the pinned ones (M118), my own DM, then the newest last message first (the conversation's
     * creation when it has none); `query` keeps the ones whose name has it.
     */
    fun dmList(
        channels: Collection<ChannelState>, title: (ChannelState) -> String, meId: String?, query: String = "",
        /** M118: my pinned DMs, oldest pin first: before everything, my own DM included (DmPins). */
        dmPins: List<String> = emptyList(),
        /** M141: the DMs I closed are not listed (§7.9). */
        closedDms: Set<String> = emptySet(),
    ): List<ChannelState> {
        val needle = query.trim().lowercase()
        val rows = DmCloses.visible(channels, closedDms).filter { it.isMember && it.channel.isDm && (needle.isEmpty() || title(it).lowercase().contains(needle)) }
        return DmPins.first(rows, dmPins) { rest -> rest.sortedWith(compareByDescending<ChannelState> { isSelfNotes(it, meId) }.thenByDescending { recency(it) }) }
    }

    private fun recency(channel: ChannelState): Instant =
        parse(channel.channel.lastMessageAt) ?: parse(channel.channel.createdAt) ?: Instant.EPOCH

    private fun parse(iso: String?): Instant? = iso?.let { runCatching { Instant.parse(it) }.getOrNull() }

    private val weekdays get() = mapOf(
        DayOfWeek.MONDAY to L10n.str(R.string.main_tabs_monday), DayOfWeek.TUESDAY to L10n.str(R.string.main_tabs_tuesday), DayOfWeek.WEDNESDAY to L10n.str(R.string.main_tabs_wednesday), DayOfWeek.THURSDAY to L10n.str(R.string.main_tabs_thursday),
        DayOfWeek.FRIDAY to L10n.str(R.string.main_tabs_friday), DayOfWeek.SATURDAY to L10n.str(R.string.main_tabs_saturday), DayOfWeek.SUNDAY to L10n.str(R.string.main_tabs_sunday),
    )

    /**
     * The time on a DM row, in `now`'s zone: the same day "H:mm", the day before 「昨日」, 2–6 days before the weekday,
     * older this year "M/d", another year "yyyy/M/d"; null without a message.
     */
    fun dmTimeLabel(iso: String?, now: ZonedDateTime = ZonedDateTime.now()): String? {
        val at = parse(iso)?.atZone(now.zone) ?: return null
        val days = ChronoUnit.DAYS.between(at.toLocalDate(), now.toLocalDate())
        return when {
            days == 0L -> "${at.hour}:${at.minute.toString().padStart(2, '0')}"
            days == 1L -> L10n.str(R.string.common_yesterday)
            days in 2..6 -> weekdays.getValue(at.dayOfWeek)
            at.year != now.year -> "${at.year}/${at.monthValue}/${at.dayOfMonth}"
            else -> "${at.monthValue}/${at.dayOfMonth}"
        }
    }

    // --- saving ---

    fun encode(state: TabStacks): String = Codec.plain.encodeToString(TabStacks.serializer(), state)

    /** Tabs saved by [encode]; anything unreadable starts over on the home tab (a bad stack at its tab's root). */
    fun decode(raw: String): TabStacks = runCatching { Codec.plain.decodeFromString(TabStacks.serializer(), raw) }.getOrNull() ?: initial
}

/** The tabs as `rememberSaveable` keeps them (one string in the saved state). */
val TabStacksSaver: Saver<TabStacks, String> = Saver(save = { MainTabs.encode(it) }, restore = { MainTabs.decode(it) })
