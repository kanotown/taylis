package jp.chikuwachat.android.ui

import androidx.compose.runtime.saveable.Saver
import jp.chikuwachat.android.api.Codec
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer

/**
 * M33 (MOBILE_UI.md §9 Android): a page of the phone's main screen. The screen is a back stack of these, the channel
 * list at the bottom; what shows is the top one (with the conversation's timeline kept composed under its tabs and
 * details page, M29). M34's bottom tabs give each tab a stack of its own.
 *
 * Serializable: the stack is saved as one string (a rotation, and each workspace's state in AppRoot, M16c).
 */
@Serializable
sealed interface Route {
    /** M34: the bottom of a bottom tab's stack, its root screen; nothing is under it. */
    @Serializable
    sealed interface Root : Route

    /** The sidebar's channel list: the bottom of the home tab's stack. */
    @Serializable @SerialName("home")
    data object ChannelList : Root

    /** M34: the DM tab's list (MOBILE_UI.md §6.3). */
    @Serializable @SerialName("dms")
    data object DmList : Root

    /** M34: the activity tab (§6.4), on one of its filters (M39: 「すべて」 first). */
    @Serializable @SerialName("activity")
    data class Activity(val segment: ActivitySegment = ActivitySegment.ALL) : Root

    /** M34: the 自分 tab; M40: its list, the settings' screens pushed over it ([Settings], §6.5). */
    @Serializable @SerialName("you")
    data object You : Root

    /** M40: a screen of the 自分 tab (a settings page), over its list or over another one ([SettingsPage.PASSWORD]). */
    @Serializable @SerialName("settings")
    data class Settings(val page: SettingsPage) : Route

    /** A conversation, on one of its tabs (M29), with or without its details page over it. */
    @Serializable @SerialName("channel")
    data class Channel(val id: String, val tab: ConversationTab = ConversationTab.MESSAGES, val detailsOpen: Boolean = false) : Route

    /** A thread, always on top of its conversation's [Channel]; [from] says where back returns to. */
    @Serializable @SerialName("thread")
    data class Thread(val channelId: String, val parentId: String, val from: ThreadFrom = ThreadFrom.CHANNEL) : Route

    /**
     * The search screen (M16b): [expanded] is the bar with its suggestions; [params] the search whose results show. It
     * stays under a result's conversation, so back (and 「検索結果に戻る」) shows the results as they were.
     * M37: [jump] is the home's 「移動・検索」 (MOBILE_UI.md §6.2): its suggestions are conversations and people to go to,
     * and 「"語" をメッセージ検索」 shows the same results.
     */
    @Serializable @SerialName("search")
    data class Search(val params: SearchParams? = null, val expanded: Boolean = true, val jump: Boolean = false) : Route

    /** The sidebar's lists that replace the channel list (THREADS.md §5, M11c, M11h, M11i). */
    @Serializable
    sealed interface Pane : Route {
        /** Whether it stays behind a conversation opened on top of it (back returns to it) or closes. */
        val keptUnderConversation: Boolean
    }

    @Serializable @SerialName("threads")
    data object Threads : Pane { override val keptUnderConversation get() = true }

    @Serializable @SerialName("reminders")
    data object Reminders : Pane { override val keptUnderConversation get() = true }

    /** A draft row closes the list itself before opening its conversation ([MainNav.openDraft]). */
    @Serializable @SerialName("drafts")
    data object Drafts : Pane { override val keptUnderConversation get() = true }

    @Serializable @SerialName("saved")
    data object Saved : Pane { override val keptUnderConversation get() = false }

    @Serializable @SerialName("mentions")
    data object Mentions : Pane { override val keptUnderConversation get() = false }

    /** 「ファイル」 of every channel, or of the one picked in its scope menu. */
    @Serializable @SerialName("files")
    data class Files(val channelId: String? = null) : Pane { override val keptUnderConversation get() = false }
}

/**
 * The activity tab's filter. M39 (stage B, MOBILE_UI.md §6.4): the chips [すべて][メンション][スレッド][リアクション],
 * `filter` being GET /activity's. M34's stage A (a server before M39) shows only [メンション | スレッド] ([stageA]).
 */
enum class ActivitySegment(val label: String, val filter: String) {
    ALL("すべて", "all"),
    MENTIONS("メンション", "mentions"),
    THREADS("スレッド", "threads"),
    REACTIONS("リアクション", "reactions"),
    ;

    companion object {
        val stageA: List<ActivitySegment> = listOf(MENTIONS, THREADS)
    }
}

/** Where a thread was opened from: its conversation, the 「スレッド」 list, or the search's results. */
enum class ThreadFrom { CHANNEL, LIST, SEARCH }

/**
 * M33: the main screen's navigation as pure functions of the back stack (tested in MainNavTest). Every way a
 * conversation opens (a list row, a notification, a permalink, a pin, the dialogs, /dm, /join) goes through
 * [openConversation]; a search result through [openFromSearch]. The system's back and the app bar's ← are [back].
 *
 * The stack never is empty and starts with a [Route.Root] (the channel list, or another bottom tab's screen, M34); it
 * holds at most one conversation (opening one replaces the one open) and one search. The bottom tabs are [MainTabs].
 * A workspace switch needs nothing here: AppRoot keeps each workspace's saved stack apart (M16c), and one that was
 * never shown starts at [root].
 */
object MainNav {
    val root: List<Route> = listOf(Route.ChannelList)

    // --- what is on screen ---

    fun top(stack: List<Route>): Route = stack.lastOrNull() ?: Route.ChannelList

    /** The stack's root screen (M34: each bottom tab has its own). */
    fun rootOf(stack: List<Route>): Route.Root = stack.firstOrNull() as? Route.Root ?: Route.ChannelList

    /** The open conversation (the controller's open channel): kept while a search shows over it. */
    fun conversation(stack: List<Route>): Route.Channel? = stack.lastOrNull { it is Route.Channel } as Route.Channel?

    /** The thread open on top of the conversation (a search over it keeps it). */
    fun thread(stack: List<Route>): Route.Thread? = stack.lastOrNull { it is Route.Channel || it is Route.Thread } as? Route.Thread

    /** The search on screen, or the one a result's conversation was opened from. */
    fun search(stack: List<Route>): Route.Search? = stack.lastOrNull { it is Route.Search } as Route.Search?

    fun searching(stack: List<Route>): Boolean = top(stack) is Route.Search

    /** The list replacing the channel list, on screen or behind a conversation. */
    fun pane(stack: List<Route>): Route.Pane? = stack.lastOrNull { it is Route.Pane } as Route.Pane?

    /** The conversation on screen was opened from the search's results: 「検索結果に戻る」 shows, back returns to them. */
    fun backToSearch(stack: List<Route>): Boolean {
        if (searching(stack)) return false
        val channel = stack.indexOfLast { it is Route.Channel }
        return channel > 0 && stack.subList(0, channel).any { it is Route.Search }
    }

    fun canGoBack(stack: List<Route>): Boolean = stack.size > 1

    // --- transitions ---

    /** Opens a list from the channel list. */
    fun open(stack: List<Route>, route: Route): List<Route> = stack + route

    fun replaceTop(stack: List<Route>, route: Route): List<Route> = stack.dropLast(1) + route

    /**
     * Opens a conversation (and optionally one of its threads) from anywhere. Whatever belonged to the one open closes
     * (its tabs, details, thread, or its thread would take replies for the wrong conversation), and so do the search
     * and the lists that do not stay behind a conversation.
     */
    fun openConversation(stack: List<Route>, channelId: String, parentId: String? = null, from: ThreadFrom = ThreadFrom.CHANNEL): List<Route> =
        base(stack) + conversationRoutes(channelId, parentId, from)

    /** A row of the 「スレッド」 list: its thread, and back returns to the list. */
    fun openFromThreadList(stack: List<Route>, channelId: String, parentId: String): List<Route> =
        openConversation(stack, channelId, parentId, ThreadFrom.LIST)

    /** A draft row: the drafts list closes, its conversation (or thread) opens with the composer's text restored. */
    fun openDraft(stack: List<Route>, channelId: String, parentId: String?): List<Route> =
        openConversation(stack.filterNot { it is Route.Drafts }, channelId, parentId)

    /** A search result: its conversation (or its thread, for a reply) around the message, the results kept behind it. */
    fun openFromSearch(stack: List<Route>, channelId: String, parentId: String?): List<Route> {
        val search = search(stack) ?: return openConversation(stack, channelId, parentId)
        return base(stack) + search.copy(expanded = false) + conversationRoutes(channelId, parentId, ThreadFrom.SEARCH)
    }

    /** A thread opened from the conversation on screen (its timeline or its preview). */
    fun openThread(stack: List<Route>, parentId: String): List<Route> {
        val channel = top(stack) as? Route.Channel ?: return stack
        return stack + Route.Thread(channel.id, parentId, ThreadFrom.CHANNEL)
    }

    /** M29: a tab of the conversation on screen. */
    fun selectTab(stack: List<Route>, tab: ConversationTab): List<Route> = updateChannel(stack) { it.copy(tab = tab) }

    /** M29: the conversation's details page, over whichever tab. */
    fun openDetails(stack: List<Route>): List<Route> = updateChannel(stack) { it.copy(detailsOpen = true) }

    fun closeDetails(stack: List<Route>): List<Route> = updateChannel(stack) { it.copy(detailsOpen = false) }

    /** 「ファイル」's scope menu. */
    fun scopeFiles(stack: List<Route>, channelId: String?): List<Route> =
        if (top(stack) is Route.Files) replaceTop(stack, Route.Files(channelId)) else stack

    /**
     * Back: the details page, then a pins / files tab (to 「メッセージ」), then the thread, then the conversation, then the
     * list (M29). On the search: the suggestions over results fold, else the search closes.
     */
    fun back(stack: List<Route>): List<Route> = when (val top = top(stack)) {
        is Route.Search -> if (top.expanded && top.params != null) replaceTop(stack, top.copy(expanded = false)) else pop(stack)
        is Route.Channel -> when {
            top.detailsOpen -> replaceTop(stack, top.copy(detailsOpen = false))
            top.tab != ConversationTab.MESSAGES -> replaceTop(stack, top.copy(tab = ConversationTab.MESSAGES))
            else -> pop(stack) // to the results it was opened from, the list behind it, or the channel list
        }
        is Route.Thread -> when (top.from) {
            ThreadFrom.CHANNEL -> pop(stack)
            // The list is back as it was: the conversation under the thread goes too.
            ThreadFrom.LIST -> pop(stack).let { rest -> if ((top(rest) as? Route.Channel)?.id == top.channelId) pop(rest) else rest }
            // The result itself: to the results (a newer search replaced them: to its conversation).
            ThreadFrom.SEARCH -> if (stack.any { it is Route.Search }) returnToSearch(stack) else pop(stack)
        }
        is Route.Pane, is Route.Settings -> pop(stack)
        is Route.Root -> stack
    }

    // --- the 自分 tab's screens (M40) ---

    /** The settings screen on screen, if any. */
    fun settingsPage(stack: List<Route>): SettingsPage? = (top(stack) as? Route.Settings)?.page

    /** The list's row the screens on the stack were opened from (highlighted beside them on a wide screen). */
    fun settingsRow(stack: List<Route>): SettingsPage? = stack.firstNotNullOfOrNull { (it as? Route.Settings)?.page }

    /** A row of the list (or a screen's own link, e.g. アカウント → パスワード): pushed over what shows. */
    fun openSettings(stack: List<Route>, page: SettingsPage): List<Route> =
        if (settingsPage(stack) == page) stack else stack + Route.Settings(page)

    /** A row of the list beside the screens (wide): its screen replaces the ones shown. */
    fun selectSettings(stack: List<Route>, page: SettingsPage): List<Route> =
        stack.filterNot { it is Route.Settings } + Route.Settings(page)

    /** The search bar (M16b), over whatever is on screen; a search kept behind a conversation is replaced by it. */
    fun openSearch(stack: List<Route>): List<Route> = stack.filterNot { it is Route.Search } + Route.Search()

    /** M37: the home's 「移動・検索」, full screen over the list (back closes it). */
    fun openJump(stack: List<Route>): List<Route> = stack.filterNot { it is Route.Search } + Route.Search(jump = true)

    /** Back from the suggestions: to the results on screen, or out of search when there are none. */
    fun collapseSearch(stack: List<Route>): List<Route> {
        val top = top(stack) as? Route.Search ?: return stack
        return if (top.params == null) pop(stack) else replaceTop(stack, top.copy(expanded = false))
    }

    fun expandSearch(stack: List<Route>): List<Route> = updateSearch(stack) { it.copy(expanded = true) }

    /** Filters, sort and chips change the search on screen. */
    fun changeSearch(stack: List<Route>, params: SearchParams): List<Route> = updateSearch(stack) { it.copy(params = params) }

    /** A search run from the bar: its results, the suggestions folded. */
    fun runSearch(stack: List<Route>, params: SearchParams): List<Route> = updateSearch(stack) { it.copy(params = params, expanded = false) }

    /** 「検索結果に戻る」 (and back from a result): the results as they were; the result's conversation closes. */
    fun returnToSearch(stack: List<Route>): List<Route> {
        val index = stack.indexOfLast { it is Route.Search }
        if (index < 0) return stack
        return stack.take(index) + (stack[index] as Route.Search).copy(expanded = false)
    }

    /**
     * The conversation vanished (removed from it, deleted, or not in the store yet): it closes with its thread, and so
     * does the search it was opened from; a search open over it stays.
     */
    fun channelGone(stack: List<Route>, channelId: String): List<Route> {
        val index = stack.indexOfFirst { refersTo(it, channelId) }
        if (index < 0) return stack
        val below = stack.take(index).dropLastWhile { it is Route.Search }
        val above = stack.drop(index + 1).filter { it is Route.Search }
        return (below + above).ifEmpty { listOf(rootOf(stack)) }
    }

    /** The tabs and the details belong to a joined conversation: left (or previewed), they go back to the timeline. */
    fun notMember(stack: List<Route>, channelId: String): List<Route> =
        if (stack.none { it is Route.Channel && it.id == channelId && (it.tab != ConversationTab.MESSAGES || it.detailsOpen) }) stack
        else stack.map { if (it is Route.Channel && it.id == channelId) it.copy(tab = ConversationTab.MESSAGES, detailsOpen = false) else it }

    // --- saving (rotation, and each workspace's state) ---

    private val serializer = ListSerializer(Route.serializer())

    fun encode(stack: List<Route>): String = Codec.plain.encodeToString(serializer, stack)

    /** A stack saved by [encode]; anything unreadable (an older build's) starts over at the channel list. */
    fun decode(raw: String): List<Route> =
        runCatching { Codec.plain.decodeFromString(serializer, raw) }.getOrNull()?.takeIf { valid(it) } ?: root

    /** A stack starts with its root and has no other root in it. */
    fun valid(stack: List<Route>): Boolean = stack.firstOrNull() is Route.Root && stack.drop(1).none { it is Route.Root }

    // --- helpers ---

    private fun pop(stack: List<Route>): List<Route> = stack.dropLast(1).ifEmpty { listOf(rootOf(stack)) }

    /** What stays under a conversation opened on top: the root (the channel list, a tab's screen) and the lists kept behind one. */
    private fun base(stack: List<Route>): List<Route> =
        stack.filter { it is Route.Root || (it is Route.Pane && it.keptUnderConversation) }.ifEmpty { listOf(rootOf(stack)) }

    private fun conversationRoutes(channelId: String, parentId: String?, from: ThreadFrom): List<Route> =
        listOfNotNull(Route.Channel(channelId), parentId?.let { Route.Thread(channelId, it, from) })

    private fun refersTo(route: Route, channelId: String): Boolean =
        (route is Route.Channel && route.id == channelId) || (route is Route.Thread && route.channelId == channelId)

    private fun updateChannel(stack: List<Route>, change: (Route.Channel) -> Route.Channel): List<Route> {
        val top = top(stack) as? Route.Channel ?: return stack
        return replaceTop(stack, change(top))
    }

    private fun updateSearch(stack: List<Route>, change: (Route.Search) -> Route.Search): List<Route> {
        val top = top(stack) as? Route.Search ?: return stack
        return replaceTop(stack, change(top))
    }
}

/** The back stack as `rememberSaveable` keeps it (one string in the saved state). */
val RouteStackSaver: Saver<List<Route>, String> = Saver(save = { MainNav.encode(it) }, restore = { MainNav.decode(it) })
