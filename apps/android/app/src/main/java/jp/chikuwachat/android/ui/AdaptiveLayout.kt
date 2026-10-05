package jp.chikuwachat.android.ui

/**
 * T1 (MOBILE_UI.md §12, tablets): how the main screen is laid out for the window it has.
 *
 * - [PHONE]: today's phone UI (bottom tabs, one page at a time). Compact widths, and any window less than
 *   [COMPACT_HEIGHT] tall (a phone held sideways is ~900 dp wide but only ~400 dp tall).
 * - [TWO_PANE]: a navigation rail with the four tabs, the tab's list (ホーム's sections, the DM list, アクティビティ)
 *   beside the page opened from it. A thread covers the conversation's pane, as on the phone.
 * - [THREE_PANE]: the same, with the thread in a pane of its own after the conversation (Slack's tablet / desktop look).
 */
enum class PaneLayout { PHONE, TWO_PANE, THREE_PANE }

/**
 * T1: the tablet layout as pure functions of the window and the selected tab's back stack ([MainNav]), tested in
 * AdaptiveLayoutTest.
 *
 * The back stacks are the same in every layout ([TabStacks]): a layout only decides where each route of the stack is
 * drawn (the root in the list pane, the thread in the trailing pane, the rest in the main pane). So a rotation, a
 * freeform window's resize or a foldable opening keeps the open conversation and thread as they are; nothing is
 * mapped or lost, and a notification or a permalink lands ([MainTabs.land]) the same way in each.
 */
object AdaptiveLayout {
    /** Material's medium and expanded window widths (dp). */
    const val MEDIUM_WIDTH = 600f
    const val EXPANDED_WIDTH = 840f
    /** Below this height (dp) the window is a phone held sideways: the phone UI stays. */
    const val COMPACT_HEIGHT = 480f
    /** From this width (dp) the thread gets its own pane: rail + list + a conversation of 400 dp + the thread. */
    const val THREE_PANE_WIDTH = 1140f

    const val RAIL_WIDTH = 80f
    const val THREAD_WIDTH = 380f

    fun of(widthDp: Float, heightDp: Float): PaneLayout = when {
        heightDp < COMPACT_HEIGHT || widthDp < MEDIUM_WIDTH -> PaneLayout.PHONE
        widthDp < EXPANDED_WIDTH && widthDp <= heightDp -> PaneLayout.PHONE // medium, portrait
        widthDp >= THREE_PANE_WIDTH -> PaneLayout.THREE_PANE
        else -> PaneLayout.TWO_PANE
    }

    /** The list pane's width (dp): narrower in a small two-pane window, so the conversation keeps its room. */
    fun listWidth(widthDp: Float): Float = if (widthDp < 1000f) 300f else 340f

    /** Whether the tab's root shows in a list pane: wide, on every tab but 自分 (its list and screens are one page). */
    fun listPane(layout: PaneLayout, tab: MainTab): Boolean = layout != PaneLayout.PHONE && tab != MainTab.YOU

    /** The thread in its own pane: three panes, the thread on top of its conversation. */
    fun threadPane(stack: List<Route>, layout: PaneLayout): Route.Thread? =
        if (layout == PaneLayout.THREE_PANE) MainNav.top(stack) as? Route.Thread else null

    /**
     * What the main pane draws, as the stack it is the top of: the whole stack, less a thread drawn in its own pane.
     * Only the root left (wide, with a list pane): nothing is open, [placeholder].
     */
    fun mainView(stack: List<Route>, layout: PaneLayout): List<Route> =
        if (threadPane(stack, layout) != null) stack.dropLast(1) else stack

    /** The main pane has nothing of its own: the list beside it shows the root. */
    fun placeholder(view: List<Route>): Boolean = view.size == 1

    /**
     * Wide, the main pane's ← shows only for a page with something under it besides the root (a conversation opened
     * from 「スレッド」 or the results): the list beside it is the way to everything else.
     */
    fun backShown(view: List<Route>): Boolean = view.size > 2

    /** The thread's pane closed: only the thread goes (from the 「スレッド」 list too, the conversation stays beside it). */
    fun closeThread(stack: List<Route>): List<Route> =
        if (MainNav.top(stack) is Route.Thread) stack.dropLast(1) else stack

    /**
     * A thread opened from the timeline beside an open thread (wide: the timeline stays usable): it replaces that one
     * ([MainNav.openThread] adds one only over the conversation).
     */
    fun openThread(stack: List<Route>, parentId: String): List<Route> {
        val base = closeThread(stack)
        val channel = MainNav.top(base) as? Route.Channel ?: return stack
        if ((MainNav.top(stack) as? Route.Thread)?.parentId == parentId) return stack
        return base + Route.Thread(channel.id, parentId, ThreadFrom.CHANNEL)
    }

    /**
     * The conversation's own controls (its tabs, its details, a canvas) while a thread shows beside it: the thread
     * closes first, so the change applies to the conversation ([MainNav] changes the conversation on top).
     */
    fun surfaceConversation(stack: List<Route>): List<Route> {
        val top = MainNav.top(stack) as? Route.Thread ?: return stack
        val below = stack.dropLast(1)
        return if ((MainNav.top(below) as? Route.Channel)?.id == top.channelId) below else stack
    }

    /**
     * A list pane's row or tile (wide): its page replaces what the main pane shows (a conversation, another list),
     * as a sidebar does; on the phone it is pushed over the list ([MainNav.open]).
     */
    fun openFromList(stack: List<Route>, route: Route, layout: PaneLayout): List<Route> =
        if (layout == PaneLayout.PHONE) MainNav.open(stack, route) else listOf(MainNav.rootOf(stack), route)

    /**
     * Whether the conversation's timeline is being looked at (SYNC_PROTOCOL.md §10.1 2.): on its 「メッセージ」 tab without
     * the details over it, and on screen: on the phone the top page, wide also with its thread in the pane beside it.
     */
    fun conversationOnScreen(state: TabStacks, layout: PaneLayout): Boolean {
        val top = MainNav.top(mainView(MainTabs.stack(state), layout)) as? Route.Channel ?: return false
        return ConversationNav.conversationOnScreen(top.tab, top.detailsOpen)
    }
}
