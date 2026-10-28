package jp.chikuwachat.android.ui

import androidx.compose.runtime.saveable.Saver
import jp.chikuwachat.android.api.Codec
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import jp.chikuwachat.android.R
import jp.chikuwachat.android.L10n

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

    /**
     * 2026-10-27 (MOBILE_UI.md §5): the 「検索」 tab. Never drawn itself: its stack always has the tab's own [Search] (the
     * jump screen, §6.2) right over it ([MainTabs.stack]), what is opened from the search going on top.
     */
    @Serializable @SerialName("search_tab")
    data object SearchHome : Root

    /** M40: a screen of the 自分 tab (a settings page), over its list or over another one ([SettingsPage.PASSWORD]). */
    @Serializable @SerialName("settings")
    data class Settings(val page: SettingsPage) : Route

    /**
     * A conversation, on one of its tabs (M29), with or without its details page over it. M46: [canvasId] is the canvas
     * its 「キャンバス」 tab shows (null: the conversation's tab canvas, else the newest).
     */
    @Serializable @SerialName("channel")
    data class Channel(val id: String, val tab: ConversationTab = ConversationTab.MESSAGES, val detailsOpen: Boolean = false, val canvasId: String? = null) : Route

    /**
     * A thread, on top of its conversation's [Channel]; [from] says where back returns to. A search result's thread
     * (2026-10-27) sits on the results alone (no [Channel] under it): [MainNav.conversation] is then its conversation.
     */
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

    /** M52 (CALENDAR.md §7): the calendar, from the home's tile or a tapped alarm of my own calendar. */
    @Serializable @SerialName("calendar")
    data object Calendar : Pane { override val keptUnderConversation get() = true }

    /** M56 (TASKS.md §6): 「タスク」, from the home's tile or a tapped notification of a personal task. */
    @Serializable @SerialName("tasks")
    data object Tasks : Pane { override val keptUnderConversation get() = true }

    /** M86 (DEADLINES.md §8 3.): 「締切」, from the home's tile; a row's deadline opens its form over it. */
    @Serializable @SerialName("deadlines")
    data object Deadlines : Pane { override val keptUnderConversation get() = true }

    /** M112 (RESERVATIONS.md §6): 「予約」, from the home's tile, an activity row or a tapped reservation notice. */
    @Serializable @SerialName("reservations")
    data object Reservations : Pane { override val keptUnderConversation get() = true }

    /**
     * M172 (docs/LENDING.md §12.3): 「備品」. No ids: the list (the home's tile), on its [overdue] segment for a keeper's
     * morning summary; [itemId]: one item; [loanId]: one loan. Each page opened is a route of its own (back returns).
     */
    @Serializable @SerialName("lending")
    data class Lending(val itemId: String? = null, val loanId: String? = null, val overdue: Boolean = false) : Pane {
        override val keptUnderConversation get() = true
    }

    /** M140 (docs/PRESENCE.md §9): 「在室状況」, from the home's tile (while the board is on); a person opens the profile card. */
    @Serializable @SerialName("attendance")
    data object Attendance : Pane { override val keptUnderConversation get() = true }

    /** M143 (docs/ACTIONS.md §9): 「操作」, from the home's tile (while I may press a button). */
    @Serializable @SerialName("actions")
    data object Actions : Pane { override val keptUnderConversation get() = true }

    /** A draft row closes the list itself before opening its conversation ([MainNav.openDraft]). */
    @Serializable @SerialName("drafts")
    data object Drafts : Pane { override val keptUnderConversation get() = true }

    @Serializable @SerialName("saved")
    data object Saved : Pane { override val keptUnderConversation get() = false }

    /** L8 (TIMES_FEED.md §7): the Times feed, from the home's tile or the Times section's 「フィード」; back returns to it. */
    @Serializable @SerialName("times_feed")
    data object TimesFeed : Pane { override val keptUnderConversation get() = true }

    @Serializable @SerialName("mentions")
    data object Mentions : Pane { override val keptUnderConversation get() = false }

    /**
     * M78 (CANVAS.md §21.2): 「キャンバス」 — the canvases of all my conversations, from the home's tile. A row's canvas opens
     * over it ([MainNav.openCanvas]) and back returns to it.
     */
    @Serializable @SerialName("canvases")
    data object Canvases : Pane { override val keptUnderConversation get() = true }

    /**
     * M122 (docs/WIKI.md §9.2): 「ドキュメント」 — the tree of pages (共有 / プライベート), from the home's tile. A page opens
     * over it ([DocPage]); back returns to it.
     */
    @Serializable @SerialName("docs")
    data object Docs : Pane { override val keptUnderConversation get() = true }

    /**
     * M122: one page of 「ドキュメント」, over the tree, another page (a `page:` link), a conversation (a `/p/` link) or the
     * search's results. Pages stack: back returns to where the link was.
     */
    @Serializable @SerialName("doc_page")
    data class DocPage(val id: String) : Pane { override val keptUnderConversation get() = true }

    /**
     * M166 (docs/DRIVE.md §26): 「ドライブ」, read only. No [locationId]: the list of locations (the home's tile); else one
     * folder of that location. Each folder opened is a route of its own, so back (the system's and the bar's ←) goes up
     * the folders it came through; [itemId] is a file whose details open over its folder on arrival (a /d/ link).
     */
    @Serializable @SerialName("drive")
    data class Drive(val locationId: String? = null, val folderId: String? = null, val itemId: String? = null) : Pane {
        override val keptUnderConversation get() = true
    }

    /** 「ファイル」 of every channel, or of the one picked in its scope menu. */
    @Serializable @SerialName("files")
    data class Files(val channelId: String? = null) : Pane { override val keptUnderConversation get() = false }
}

/**
 * The activity tab's filter. M39 (stage B, MOBILE_UI.md §6.4): the chips [すべて][メンション][スレッド][リアクション],
 * `filter` being GET /activity's. M34's stage A (a server before M39) shows only [メンション | スレッド] ([stageA]).
 */
enum class ActivitySegment(private val labelRes: Int, val filter: String) {
    ALL(R.string.common_all, "all"),
    MENTIONS(R.string.common_mention, "mentions"),
    THREADS(R.string.common_thread, "threads"),
    REACTIONS(R.string.main_nav_reactions, "reactions"),
    ;

    val label: String get() = L10n.str(labelRes)

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

    /**
     * The open conversation (the controller's open channel): kept while a search shows over it. A thread with no
     * conversation under it (a search result's, [openFromSearch]) is in its conversation all the same: the controller
     * opens it (its notifications and read state as for a thread over its timeline).
     */
    fun conversation(stack: List<Route>): Route.Channel? = when (val last = stack.lastOrNull { it is Route.Channel || it is Route.Thread }) {
        is Route.Channel -> last
        is Route.Thread -> (stack.lastOrNull { it is Route.Channel } as Route.Channel?)?.takeIf { it.id == last.channelId } ?: Route.Channel(last.channelId)
        else -> null
    }

    /** A thread on top with no conversation of its own under it (a search result's): its header link pushes the conversation. */
    fun threadAlone(stack: List<Route>): Boolean {
        val thread = top(stack) as? Route.Thread ?: return false
        return (top(stack.dropLast(1)) as? Route.Channel)?.id != thread.channelId
    }

    /** The thread open on top of the conversation (a search over it keeps it). */
    fun thread(stack: List<Route>): Route.Thread? = stack.lastOrNull { it is Route.Channel || it is Route.Thread } as? Route.Thread

    /** The search on screen, or the one a result's conversation was opened from. */
    fun search(stack: List<Route>): Route.Search? = stack.lastOrNull { it is Route.Search } as Route.Search?

    fun searching(stack: List<Route>): Boolean = top(stack) is Route.Search

    /** The list replacing the channel list, on screen or behind a conversation. */
    fun pane(stack: List<Route>): Route.Pane? = stack.lastOrNull { it is Route.Pane } as Route.Pane?

    /**
     * The conversation (or thread) on screen was opened from the search's results: 「検索結果に戻る」 shows, back returns
     * to them.
     */
    fun backToSearch(stack: List<Route>): Boolean {
        if (searching(stack)) return false
        val conversation = stack.indexOfLast { it is Route.Channel || it is Route.Thread }
        return conversation > 0 && stack.subList(0, conversation).any { it is Route.Search }
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

    /** A row of the 「スレッド」 list (or, on a phone, an activity row of a reply): its thread, and back returns to the list. */
    fun openFromThreadList(stack: List<Route>, channelId: String, parentId: String): List<Route> =
        openConversation(stack, channelId, parentId, ThreadFrom.LIST)

    /**
     * A 「スレッド」 card's conversation header (or its menu's 「チャンネルを開く」 / 「会話を開く」): the conversation itself,
     * its timeline around the thread's parent (the caller focuses it), no thread on top; back returns to the list.
     */
    fun openConversationFromThreadList(stack: List<Route>, channelId: String): List<Route> =
        openConversation(stack, channelId)

    /**
     * The thread header's conversation link (MOBILE_UI.md §6.7): the conversation in place of the thread on top, its
     * timeline around the thread's parent (the caller focuses it), on 「メッセージ」. A thread always sits on its
     * conversation, so the thread just leaves: back from the conversation then goes where the thread's back went (the
     * conversation's own way back; the 「スレッド」 list or the activity it was opened from; the results). Nothing else on
     * top: the stack stays.
     *
     * A search result's thread sits on the results alone (2026-10-27): the conversation is pushed over it instead, so
     * back returns to the thread, then the results.
     */
    fun openThreadConversation(stack: List<Route>): List<Route> {
        val thread = top(stack) as? Route.Thread ?: return stack
        val rest = stack.dropLast(1)
        val channel = top(rest) as? Route.Channel
        if (thread.from == ThreadFrom.SEARCH && channel?.id != thread.channelId && rest.any { it is Route.Search }) return stack + Route.Channel(thread.channelId)
        return if (channel?.id == thread.channelId) replaceTop(rest, channel.copy(tab = ConversationTab.MESSAGES, detailsOpen = false))
        else rest.ifEmpty { listOf(rootOf(stack)) } + Route.Channel(thread.channelId)
    }

    /** A draft row: the drafts list closes, its conversation (or thread) opens with the composer's text restored. */
    fun openDraft(stack: List<Route>, channelId: String, parentId: String?): List<Route> =
        openConversation(stack.filterNot { it is Route.Drafts }, channelId, parentId)

    /**
     * A search result: its conversation (or its thread, for a reply) around the message, the results kept behind it.
     * A reply's thread sits on the results alone (2026-10-27, MOBILE_UI.md §6.7): back (the system's too) returns to
     * them, and the thread's header link pushes its conversation over it. `besideChannel` (three panes, where the
     * thread has a pane of its own next to its conversation): the conversation goes under the thread, back still
     * returning to the results ([back]).
     */
    fun openFromSearch(stack: List<Route>, channelId: String, parentId: String?, besideChannel: Boolean = false): List<Route> {
        val search = search(stack) ?: return openConversation(stack, channelId, parentId)
        val routes = if (parentId != null && !besideChannel) listOf(Route.Thread(channelId, parentId, ThreadFrom.SEARCH))
        else conversationRoutes(channelId, parentId, ThreadFrom.SEARCH)
        return base(stack).filterNot { it is Route.Search } + search.copy(expanded = false) + routes
    }

    /** A thread opened from the conversation on screen (its timeline or its preview). */
    fun openThread(stack: List<Route>, parentId: String): List<Route> {
        val channel = top(stack) as? Route.Channel ?: return stack
        return stack + Route.Thread(channel.id, parentId, ThreadFrom.CHANNEL)
    }

    /** M29: a tab of the conversation on screen. */
    fun selectTab(stack: List<Route>, tab: ConversationTab): List<Route> = updateChannel(stack) { it.copy(tab = tab) }

    /** M46: a canvas of the conversation on screen, in its 「キャンバス」 tab (null: the default one). */
    fun selectCanvas(stack: List<Route>, canvasId: String?): List<Route> =
        updateChannel(stack) { it.copy(tab = ConversationTab.CANVAS, canvasId = canvasId, detailsOpen = false) }

    /** M46: a `/c/<id>` link: the canvas's conversation opens on its 「キャンバス」 tab, as [openConversation] does. */
    fun openCanvas(stack: List<Route>, channelId: String, canvasId: String): List<Route> =
        base(stack) + Route.Channel(channelId, tab = ConversationTab.CANVAS, canvasId = canvasId)

    /** M58: a canvas found by the search's 「キャンバス」 tab: its conversation's 「キャンバス」 tab, the results kept behind it. */
    fun openCanvasFromSearch(stack: List<Route>, channelId: String, canvasId: String): List<Route> {
        val search = search(stack) ?: return openCanvas(stack, channelId, canvasId)
        return base(stack) + search.copy(expanded = false) + Route.Channel(channelId, tab = ConversationTab.CANVAS, canvasId = canvasId)
    }

    /**
     * M52: the calendar over the home's list (the tile, an alarm, a conversation's 「このチャンネルの予定」); one already open
     * stays as it is.
     */
    fun openCalendar(stack: List<Route>): List<Route> =
        if (top(stack) == Route.Calendar) stack else stack.filter { it is Route.Root } + Route.Calendar

    /** M56: a channel's 「タスク」 tab (a shared task's notification, 「自分の担当」's channel), as [openConversation] does. */
    fun openTasks(stack: List<Route>, channelId: String): List<Route> =
        base(stack) + Route.Channel(channelId, tab = ConversationTab.TASKS)

    /** M112: 「予約」 over the home's list (a tapped notice); one already open stays as it is. */
    fun openReservations(stack: List<Route>): List<Route> =
        if (top(stack) == Route.Reservations) stack else stack.filter { it is Route.Root } + Route.Reservations

    /** M172: an item or a loan of 「備品」 over what is on screen (a row, an activity row); the same page on top stays. */
    fun openLending(stack: List<Route>, itemId: String? = null, loanId: String? = null): List<Route> {
        val route = Route.Lending(itemId = itemId, loanId = loanId)
        return if (top(stack) == route) stack else stack + route
    }

    /**
     * M172 (docs/LENDING.md §17.3): a lending notice from outside the page: the list over the tab's root, then the loan
     * (else the item); a notice with neither (the keepers' summary) opens the list on its overdue segment.
     */
    fun landLending(stack: List<Route>, itemId: String?, loanId: String?): List<Route> = when {
        loanId != null -> listOf(rootOf(stack), Route.Lending(), Route.Lending(loanId = loanId))
        itemId != null -> listOf(rootOf(stack), Route.Lending(), Route.Lending(itemId = itemId))
        else -> listOf(rootOf(stack), Route.Lending(overdue = true))
    }

    /** M56: 「タスク」 over the home's list (the tile, or a personal task's notification); one already open stays as it is. */
    fun openMyTasks(stack: List<Route>): List<Route> =
        if (top(stack) == Route.Tasks) stack else stack.filter { it is Route.Root } + Route.Tasks

    /**
     * M122: a page of 「ドキュメント」 over what is on screen (a link in a page, a message or a canvas; a row of the tree; a
     * search result, whose results stay behind it folded). The same page on top stays as it is.
     */
    fun openPage(stack: List<Route>, pageId: String): List<Route> {
        val top = top(stack)
        if (top is Route.DocPage && top.id == pageId) return stack
        val base = if (top is Route.Search) replaceTop(stack, top.copy(expanded = false)) else stack
        return base + Route.DocPage(pageId)
    }

    /**
     * M122: a page from outside the tab (a notification, an activity row whose tab is not this one): the tree over the
     * tab's root, then the page — back goes to the tree, then the list.
     */
    fun landPage(stack: List<Route>, pageId: String): List<Route> = listOf(rootOf(stack), Route.Docs, Route.DocPage(pageId))

    /**
     * M122: a breadcrumb (WIKI.md §9.2 「パンくず（タップで戻る）」): back to that page when it is under this one on the stack,
     * else it opens over it.
     */
    fun openCrumb(stack: List<Route>, pageId: String): List<Route> {
        val at = stack.indexOfLast { it is Route.DocPage && it.id == pageId }
        return if (at >= 0) stack.take(at + 1) else openPage(stack, pageId)
    }

    /**
     * M166 (DRIVE.md §26): a drive folder over what is on screen (a row of the list or the folder above, the channel's
     * 「ドライブ」 tab, a /d/ card; a search's results stay behind it folded). The same folder on top stays (its details
     * item replaced).
     */
    fun openDriveFolder(stack: List<Route>, locationId: String, folderId: String, itemId: String? = null): List<Route> {
        val top = top(stack)
        if (top is Route.Drive && top.folderId == folderId) return replaceTop(stack, top.copy(itemId = itemId))
        val base = if (top is Route.Search) replaceTop(stack, top.copy(expanded = false)) else stack
        return base + Route.Drive(locationId, folderId, itemId)
    }

    /** M166: a breadcrumb — back to that folder when it is under this one on the stack, else it opens over it. */
    fun openDriveCrumb(stack: List<Route>, locationId: String, folderId: String): List<Route> {
        val at = stack.indexOfLast { it is Route.Drive && it.folderId == folderId }
        return if (at >= 0) stack.take(at + 1).let { replaceTop(it, (it.last() as Route.Drive).copy(itemId = null)) }
        else openDriveFolder(stack, locationId, folderId)
    }

    /** M166: the folder on top is not there for me any more (404): the location's root, or the list when that is it. */
    fun driveFolderGone(stack: List<Route>, locationId: String, rootId: String?): List<Route> {
        val top = top(stack) as? Route.Drive ?: return stack
        if (rootId == null || top.folderId == rootId) return replaceTop(stack, Route.Drive())
        return replaceTop(stack, Route.Drive(locationId, rootId))
    }

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
            ThreadFrom.SEARCH -> when {
                stack.any { it is Route.Search } -> returnToSearch(stack)
                (top(pop(stack)) as? Route.Channel)?.id == top.channelId -> pop(stack)
                else -> replaceTop(stack, Route.Channel(top.channelId))
            }
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
    fun openSearch(stack: List<Route>): List<Route> = withoutSearches(stack) + Route.Search()

    /** M37: the home's 「移動・検索」, full screen over the list (back closes it). */
    fun openJump(stack: List<Route>): List<Route> = withoutSearches(stack) + Route.Search(jump = true)

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
        // The 「検索」 tab's own search stays (its results, as back would show them).
        val kept = if (index >= 2 && tabSearch(stack, 1)) 2 else 0
        val below = stack.take(kept) + stack.subList(kept, index).dropLastWhile { it is Route.Search }
        val above = stack.drop(index + 1).filter { it is Route.Search }
        return (below + above).ifEmpty { listOf(rootOf(stack)) }
    }

    /**
     * The thread's root was deleted while it was shown (ThreadRootWatch): the thread closes as back would (to the
     * conversation, the 「スレッド」 list or the results it was opened from). With no conversation under it there is
     * nothing to return to: its conversation opens instead. A thread not on top (a search over it) just leaves the stack.
     */
    fun threadGone(stack: List<Route>, parentId: String): List<Route> {
        val index = stack.indexOfLast { it is Route.Thread && it.parentId == parentId }
        if (index < 0) return stack
        val thread = stack[index] as Route.Thread
        val under = stack.take(index)
        val toResults = thread.from == ThreadFrom.SEARCH && under.any { it is Route.Search }
        if (under.none { it is Route.Channel } && !toResults && index == stack.lastIndex) return under.ifEmpty { listOf(rootOf(stack)) } + Route.Channel(thread.channelId)
        return if (index == stack.lastIndex) back(stack) else stack.filterIndexed { i, _ -> i != index }
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

    /**
     * What stays under a conversation opened on top: the root (the channel list, a tab's screen), the lists kept behind
     * one, and the 「検索」 tab's own search ([tabSearch]: back from the conversation returns to it).
     */
    private fun base(stack: List<Route>): List<Route> =
        stack.filterIndexed { i, it -> it is Route.Root || (it is Route.Pane && it.keptUnderConversation) || tabSearch(stack, i) }
            .ifEmpty { listOf(rootOf(stack)) }

    /** Whether `stack[index]` is the 「検索」 tab's own search, right over its root (the tab's screen, never closed). */
    fun tabSearch(stack: List<Route>, index: Int): Boolean =
        index == 1 && stack.firstOrNull() == Route.SearchHome && stack.getOrNull(1) is Route.Search

    /** The stack less its searches, the 「検索」 tab's own one kept. */
    private fun withoutSearches(stack: List<Route>): List<Route> = stack.filterIndexed { i, it -> it !is Route.Search || tabSearch(stack, i) }

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
