package jp.chikuwachat.android.ui

import androidx.compose.runtime.saveable.Saver
import jp.chikuwachat.android.platform.KeyValueStore
import kotlin.math.abs

/**
 * Issue #1 (MOBILE_UI.md §5.1): the phone's horizontal swipe between a conversation and the list under it, as Slack
 * does. A right swipe started anywhere on a conversation (or a thread) slides it away to what back shows; a left swipe
 * on a tab's root brings back the conversation last open on that tab. The page follows the finger, the one underneath
 * showing with a parallax and a dim; it completes past [COMPLETE_FRACTION] of the width or with a fling, else it
 * slides back. The system's edge back gesture (predictive back) plays the same slide.
 *
 * The pure parts (tested in SwipeNavTest): which way a drag goes, whether it completes, where it lands, and the
 * conversation each tab remembers. MainScreen draws the pages (phone layout only; the tablet panes are unchanged).
 */
object SwipeNav {
    /** The steepest drag still taken as horizontal: tan 30°, |dy| ≤ 0.577 |dx|. */
    const val MAX_SLOPE = 0.577f

    /** How far (a fraction of the width) a slow drag has to go to complete. */
    const val COMPLETE_FRACTION = 0.4f

    /** A fling at least this fast (dp/s) toward the end completes (away from it: cancels) wherever it is. */
    const val FLING_DP_PER_SECOND = 700f

    /** The page underneath starts this far (a fraction of the width) to the left, as on iOS. */
    const val PARALLAX = 0.3f

    /** The dim over the page underneath when it is fully covered. */
    const val MAX_SCRIM = 0.18f

    enum class Decision { UNDECIDED, BACK, FORWARD, REJECT }

    /**
     * A drag `dx`, `dy` (px) from where the finger went down: undecided within the touch slop; vertical (the list's
     * scroll) or a direction with nowhere to go: rejected; clearly horizontal (≤ 30°): back to the right, forward to
     * the left.
     */
    fun decide(dx: Float, dy: Float, slop: Float, canBack: Boolean, canForward: Boolean): Decision {
        val ax = abs(dx)
        val ay = abs(dy)
        if (ax >= slop && ay <= ax * MAX_SLOPE) {
            return when {
                dx > 0 && canBack -> Decision.BACK
                dx < 0 && canForward -> Decision.FORWARD
                else -> Decision.REJECT
            }
        }
        return if (ay >= slop) Decision.REJECT else Decision.UNDECIDED
    }

    /**
     * Whether a released swipe completes: `progress` 0…1 toward the other page, `velocity` (px/s) toward it (negative:
     * back toward where it started), `fling` the speed (px/s) that decides alone.
     */
    fun shouldComplete(progress: Float, velocity: Float, fling: Float): Boolean = when {
        velocity >= fling -> true
        velocity <= -fling -> false
        else -> progress >= COMPLETE_FRACTION
    }

    /** Where the upper page's left edge sits for a drag: back follows `dx` from 0, forward comes in from the right edge. */
    fun upperShift(dx: Float, width: Float, forward: Boolean): Float {
        if (width <= 0f) return 0f
        val shift = if (forward) 1f + dx / width else dx / width
        return shift.coerceIn(0f, 1f)
    }

    /** How far along the swipe is (0: where it started, 1: the other page shown) for the upper page's shift. */
    fun progress(shift: Float, forward: Boolean): Float = if (forward) 1f - shift else shift

    /** The page underneath: a parallax to the left while covered, in place once uncovered. */
    fun lowerTranslation(shift: Float, width: Float): Float = -PARALLAX * width * (1f - shift)

    fun scrimAlpha(shift: Float): Float = MAX_SCRIM * (1f - shift)

    /**
     * What a right swipe goes back to: only from a conversation's messages (not its details page nor another of its
     * tabs, which have their own horizontal content) or a thread; then what back shows (MainTabs.back: the list, the
     * search results, or the conversation under a thread).
     */
    fun backTarget(state: TabStacks): TabStacks? {
        val stack = MainTabs.stack(state)
        val swipeable = when (val top = MainNav.top(stack)) {
            is Route.Thread -> true
            is Route.Channel -> top.tab == ConversationTab.MESSAGES && !top.detailsOpen
            else -> false
        }
        if (!swipeable) return null
        val target = MainTabs.back(state)
        return target.takeIf { pageKey(MainTabs.stack(it)) != pageKey(stack) }
    }

    /**
     * What a left swipe brings back: on a tab's root (not 自分, which opens no conversation), the conversation last open
     * on that tab, if the store still has it (`known`).
     */
    fun forwardTarget(state: TabStacks, last: Map<MainTab, String>, known: (String) -> Boolean): TabStacks? {
        val stack = MainTabs.stack(state)
        if (stack.size != 1 || stack[0] == Route.You) return null
        val id = last[state.selected]?.takeIf(known) ?: return null
        return MainTabs.withStack(state, state.selected, MainNav.openConversation(stack, id))
    }

    /** The conversations left on each tab (closed, back to a list): a tab's that closed is its newest. */
    fun noteLeft(last: Map<MainTab, String>, previous: TabStacks, next: TabStacks): Map<MainTab, String> {
        var result = last
        for (tab in MainTab.entries) {
            val was = MainNav.conversation(MainTabs.stack(previous, tab)) ?: continue
            if (MainNav.conversation(MainTabs.stack(next, tab)) == null) result = result + (tab to was.id)
        }
        return result
    }

    /**
     * The identity of the page a stack shows: the same page keeps its state (a timeline's place, a list's scroll) as it
     * moves from under the swipe to the top. A conversation stays itself on its tabs and details page.
     */
    fun pageKey(stack: List<Route>): String = when (val top = MainNav.top(stack)) {
        Route.ChannelList -> "home"
        Route.DmList -> "dms"
        is Route.Activity -> "activity"
        Route.You, is Route.Settings -> "you"
        is Route.Channel -> "channel:${top.id}"
        is Route.Thread -> "thread:${top.channelId}:${top.parentId}"
        is Route.Search -> "search"
        is Route.Pane -> "pane:${top::class.simpleName}"
    }

    // --- saving the remembered conversations (a rotation, each workspace's state) ---

    fun encode(last: Map<MainTab, String>): String = last.entries.joinToString("\n") { "${it.key.name}=${it.value}" }

    fun decode(raw: String): Map<MainTab, String> = raw.lineSequence().mapNotNull { line ->
        val tab = MainTab.entries.firstOrNull { line.startsWith(it.name + "=") } ?: return@mapNotNull null
        val id = line.substringAfter('=').takeIf { it.isNotEmpty() } ?: return@mapNotNull null
        tab to id
    }.toMap()
}

val LastConversationsSaver: Saver<Map<MainTab, String>, String> = Saver(save = { SwipeNav.encode(it) }, restore = { SwipeNav.decode(it) })

/** 「スワイプで戻る・進む」 (自分 → 表示), kept on this device; on by default, off is the only value stored. */
object SwipeNavigation {
    private const val KEY = "swipe_navigation"

    fun read(store: KeyValueStore): Boolean = store.getString(KEY) != "off"

    fun write(store: KeyValueStore, on: Boolean) = store.putString(KEY, if (on) null else "off")
}
