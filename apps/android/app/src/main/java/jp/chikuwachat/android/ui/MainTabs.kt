package jp.chikuwachat.android.ui

import androidx.compose.runtime.saveable.Saver
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.ThreadSummary
import jp.chikuwachat.android.sync.ChannelState
import java.time.DayOfWeek
import java.time.Instant
import java.time.ZonedDateTime
import java.time.temporal.ChronoUnit
import kotlinx.serialization.Serializable

/** M34 (MOBILE_UI.md §5): the phone's bottom tabs, in the bar's order. */
enum class MainTab(val label: String) {
    HOME("ホーム"),
    DM("DM"),
    ACTIVITY("アクティビティ"),
    YOU("自分"),
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
        MainTab.YOU -> Route.You
    }

    private fun rootStack(tab: MainTab): List<Route> = listOf(root(tab))

    /** The tab a root screen belongs to (a stack saved for one tab never shows on another). */
    private fun tabOf(root: Route.Root): MainTab = when (root) {
        Route.ChannelList -> MainTab.HOME
        Route.DmList -> MainTab.DM
        is Route.Activity -> MainTab.ACTIVITY
        Route.You -> MainTab.YOU
    }

    // --- what is on screen ---

    /** `tab`'s stack as it was left (its root when never opened). */
    fun stack(state: TabStacks, tab: MainTab = state.selected): List<Route> =
        state.stacks[tab]?.takeIf { MainNav.valid(it) && tabOf(MainNav.rootOf(it)) == tab } ?: rootStack(tab)

    fun atRoot(state: TabStacks, tab: MainTab = state.selected): Boolean = stack(state, tab).size == 1

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
        is Route.Search -> !top.expanded
        is Route.Channel, is Route.Thread -> false
    }

    // --- transitions ---

    /** `change` applied to the selected tab's stack. */
    fun update(state: TabStacks, change: (List<Route>) -> List<Route>): TabStacks = withStack(state, state.selected, change(stack(state)))

    fun withStack(state: TabStacks, tab: MainTab, stack: List<Route>): TabStacks = state.copy(stacks = state.stacks + (tab to stack))

    /** What a tap on the bar does: the new state, and whether the tab's list scrolls to its top. */
    data class Tap(val state: TabStacks, val scrollToTop: Boolean)

    /**
     * A tap on the bar (MOBILE_UI.md §5): another tab comes back as it was left; the selected one pops to its root, or,
     * at its root already, scrolls its list to the top.
     */
    fun tap(state: TabStacks, tab: MainTab): Tap = when {
        tab != state.selected -> Tap(state.copy(selected = tab), scrollToTop = false)
        atRoot(state) -> Tap(state, scrollToTop = true)
        else -> Tap(withStack(state, tab, listOf(MainNav.rootOf(stack(state)))), scrollToTop = false)
    }

    /** Whether the system's back stays in the app: something to pop, or a tab other than home to leave. */
    fun canGoBack(state: TabStacks): Boolean = MainNav.canGoBack(stack(state)) || state.selected != MainTab.HOME

    /** Back: the selected tab's stack pops ([MainNav.back]); at another tab's root, to the home tab. */
    fun back(state: TabStacks): TabStacks = when {
        MainNav.canGoBack(stack(state)) -> update(state, MainNav::back)
        state.selected != MainTab.HOME -> state.copy(selected = MainTab.HOME)
        else -> state
    }

    /** A notification, permalink or search result: a DM on the DM tab, a channel (and its thread) on the home tab. */
    fun landingTab(channel: ChannelState?): MainTab = if (channel?.channel?.isDm == true) MainTab.DM else MainTab.HOME

    /** Lands a conversation (and its thread) on `tab`: that tab's stack becomes [root, conversation, (thread)] and shows. */
    fun land(state: TabStacks, tab: MainTab, channelId: String, parentId: String? = null): TabStacks =
        withStack(state, tab, MainNav.openConversation(rootStack(tab), channelId, parentId)).copy(selected = tab)

    /**
     * A search result lands on its tab. On the tab the search is on, the results stay behind the conversation (M16b:
     * back and 「検索結果に戻る」 return to them); on another tab, the search's tab keeps its results for when it comes back.
     */
    fun landFromSearch(state: TabStacks, tab: MainTab, channelId: String, parentId: String?): TabStacks =
        if (tab == state.selected) update(state) { MainNav.openFromSearch(it, channelId, parentId) }
        else land(update(state, MainNav::returnToSearch), tab, channelId, parentId)

    /**
     * M37 (MOBILE_UI.md §6.1, §6.2): a conversation picked on the jump screen or the ✏️ picker, both over the home tab:
     * the home tab goes back to its list (the jump screen and any results behind it close), then the conversation lands
     * on its tab like a notification's (a DM on the DM tab, a channel on home).
     */
    fun landFromHome(state: TabStacks, tab: MainTab, channelId: String): TabStacks =
        land(withStack(state, MainTab.HOME, rootStack(MainTab.HOME)), tab, channelId)

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
     * Activity tab (stage A): the followed threads' unread count plus my channels (not DMs) with a mention; red when any
     * of those channels or threads mentions me.
     */
    fun activityBadge(channels: Collection<ChannelState>, threads: ThreadSummary): ActivityBadge {
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
    const val SELF_NOTES_INTRO = "ここはあなただけのスペースです。メモや下書き、あとで見返したいリンクやファイルを置いておけます。ほかの人には見えません。"

    /** The new-DM picker's words after my name. */
    const val SELF_NOTES_HINT = "メモや下書きに使える、自分だけの DM"

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
     * My DMs and group DMs: my own DM first, then the newest last message first (the conversation's creation when it
     * has none); `query` keeps the ones whose name has it.
     */
    fun dmList(channels: Collection<ChannelState>, title: (ChannelState) -> String, meId: String?, query: String = ""): List<ChannelState> {
        val needle = query.trim().lowercase()
        return channels
            .filter { it.isMember && it.channel.isDm && (needle.isEmpty() || title(it).lowercase().contains(needle)) }
            .sortedWith(compareByDescending<ChannelState> { isSelfNotes(it, meId) }.thenByDescending { recency(it) })
    }

    private fun recency(channel: ChannelState): Instant =
        parse(channel.channel.lastMessageAt) ?: parse(channel.channel.createdAt) ?: Instant.EPOCH

    private fun parse(iso: String?): Instant? = iso?.let { runCatching { Instant.parse(it) }.getOrNull() }

    private val weekdays = mapOf(
        DayOfWeek.MONDAY to "月曜日", DayOfWeek.TUESDAY to "火曜日", DayOfWeek.WEDNESDAY to "水曜日", DayOfWeek.THURSDAY to "木曜日",
        DayOfWeek.FRIDAY to "金曜日", DayOfWeek.SATURDAY to "土曜日", DayOfWeek.SUNDAY to "日曜日",
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
            days == 1L -> "昨日"
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
