package jp.chikuwachat.android.ui

import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.animate
import androidx.compose.animation.core.spring
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.input.pointer.util.VelocityTracker
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.unit.Velocity
import androidx.compose.ui.unit.dp
import kotlin.math.abs
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/**
 * Issue #1: the swipe in progress — the page it goes to ([target]), which way, and where the upper page's left edge is
 * ([shift], a fraction of the width: back slides the conversation from 0 to 1, forward slides the next one in from 1
 * to 0). Driven by the finger (SwipeNavHost), the system's back gesture (MainScreen's PredictiveBackHandler) or the
 * fling at the end of an inner scroller.
 */
@Stable
class SwipeNavState(private val scope: CoroutineScope) {
    var target by mutableStateOf<TabStacks?>(null)
        private set
    var forward by mutableStateOf(false)
        private set
    var shift by mutableFloatStateOf(0f)
    var settling by mutableStateOf(false)
        private set

    val active: Boolean get() = target != null

    fun begin(target: TabStacks, forward: Boolean) {
        this.target = target
        this.forward = forward
        shift = if (forward) 1f else 0f
    }

    /**
     * The finger is off: the page slides to the end (then `onCommit` shows the target, as the top page, in the same
     * frame the swipe ends) or back. `velocity`: the fling toward the end, in widths per second.
     */
    fun settle(complete: Boolean, velocity: Float, onCommit: (TabStacks) -> Unit) {
        val goal = target ?: return
        if (settling) return
        settling = true
        val end = if (complete != forward) 1f else 0f
        scope.launch {
            try {
                val toward = if (end > shift) abs(velocity) else -abs(velocity)
                animate(shift, end, initialVelocity = if (complete) toward else 0f, animationSpec = spring(dampingRatio = 1f, stiffness = Spring.StiffnessMediumLow)) { value, _ ->
                    shift = value
                }
            } finally {
                if (complete) onCommit(goal)
                target = null
                shift = 0f
                settling = false
            }
        }
    }
}

/**
 * Issue #1 (MOBILE_UI.md §5.1): the phone's pages under the horizontal swipe. Without a swipe, only `current`'s page
 * is composed, as before. During one, the page it goes to is composed as well: under the conversation sliding away
 * (back), or over the list coming in from the right (forward), with a parallax and a dim on the lower one. Each page is
 * keyed by [SwipeNav.pageKey], so the one under the swipe keeps its state when it becomes the page on screen.
 *
 * The finger's drag is taken only once it is clearly horizontal and nothing inside took it first: the timeline's
 * vertical scroll, a code block or table scrolling sideways, a text selection, the composer's field (they handle the
 * pointer before this parent and consume it). An inner scroller already at its left edge hands what it cannot scroll
 * on through nested scrolling, and that continues as the back swipe.
 */
@Composable
fun SwipeNavHost(
    current: TabStacks,
    swipe: SwipeNavState,
    backTarget: TabStacks?,
    forwardTarget: TabStacks?,
    onCommit: (TabStacks) -> Unit,
    page: @Composable (state: TabStacks, isCurrent: Boolean) -> Unit,
) {
    var width by remember { mutableIntStateOf(0) }
    val back = rememberUpdatedState(backTarget)
    val forward = rememberUpdatedState(forwardTarget)
    val commit = rememberUpdatedState(onCommit)
    val nested = remember(swipe) { SwipeNestedScroll(swipe, back, { width.toFloat() }, { commit.value(it) }) }
    val target = swipe.target
    // Lowest first: back draws the page it goes to under the conversation; forward the conversation over the list.
    val layers: List<Pair<TabStacks, Boolean>> = when {
        target == null -> listOf(current to false)
        swipe.forward -> listOf(current to true, target to false)
        else -> listOf(target to true, current to false)
    }
    Box(
        Modifier.fillMaxSize()
            .onSizeChanged { width = it.width }
            .nestedScroll(nested)
            .pointerInput(swipe) {
                val slop = viewConfiguration.touchSlop
                val fling = SwipeNav.FLING_DP_PER_SECOND.dp.toPx()
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    if (swipe.active) return@awaitEachGesture
                    val backTo = back.value
                    val forwardTo = forward.value
                    if (backTo == null && forwardTo == null) return@awaitEachGesture
                    var dx = 0f
                    var dy = 0f
                    var start = 0f
                    var dragging = false
                    val tracker = VelocityTracker()
                    while (true) {
                        val event = awaitPointerEvent()
                        val change = event.changes.firstOrNull { it.id == down.id } ?: break
                        if (!change.pressed) {
                            if (dragging) {
                                tracker.addPosition(change.uptimeMillis, change.position)
                                release(swipe, tracker.calculateVelocity().x, width.toFloat(), fling, commit.value)
                                dragging = false
                            }
                            break
                        }
                        val delta = change.positionChange()
                        if (!dragging) {
                            // A second finger (a pinch), or something inside took the drag: not a swipe.
                            if (change.isConsumed || event.changes.count { it.pressed } > 1) break
                            dx += delta.x
                            dy += delta.y
                            val decision = SwipeNav.decide(dx, dy, slop, backTo != null, forwardTo != null)
                            if (decision == SwipeNav.Decision.UNDECIDED) continue
                            if (decision == SwipeNav.Decision.REJECT) break
                            val goingForward = decision == SwipeNav.Decision.FORWARD
                            swipe.begin(if (goingForward) forwardTo!! else backTo!!, goingForward)
                            // The page follows from here, without jumping by the slop.
                            start = dx
                            dragging = true
                        } else {
                            dx += delta.x
                        }
                        change.consume()
                        tracker.addPosition(change.uptimeMillis, change.position)
                        swipe.shift = SwipeNav.upperShift(dx - start, width.toFloat(), swipe.forward)
                    }
                    // Cut off (the pointer cancelled): settle where it is.
                    if (dragging) release(swipe, 0f, width.toFloat(), fling, commit.value)
                }
            },
    ) {
        for ((state, lower) in layers) {
            key(SwipeNav.pageKey(MainTabs.stack(state))) {
                val isCurrent = state === current
                Box(
                    Modifier.fillMaxSize()
                        .graphicsLayer {
                            translationX = if (lower) SwipeNav.lowerTranslation(swipe.shift, size.width) else swipe.shift * size.width
                        }
                        .drawWithContent {
                            drawContent()
                            if (!swipe.active) return@drawWithContent
                            if (lower) {
                                drawRect(Color.Black.copy(alpha = SwipeNav.scrimAlpha(swipe.shift)))
                            } else {
                                // The upper page's edge casts a soft shadow on the one underneath.
                                val edge = 10.dp.toPx()
                                drawRect(
                                    Brush.horizontalGradient(listOf(Color.Transparent, Color.Black.copy(alpha = 0.16f)), startX = -edge, endX = 0f),
                                    topLeft = Offset(-edge, 0f), size = Size(edge, size.height),
                                )
                            }
                        }
                        .then(if (isCurrent) Modifier else Modifier.clearAndSetSemantics {}),
                ) {
                    page(state, isCurrent)
                }
            }
        }
    }
}

private fun release(swipe: SwipeNavState, velocityX: Float, width: Float, fling: Float, onCommit: (TabStacks) -> Unit) {
    // Toward the end: right for back, left for forward.
    val toward = if (swipe.forward) -velocityX else velocityX
    val complete = SwipeNav.shouldComplete(SwipeNav.progress(swipe.shift, swipe.forward), toward, fling)
    swipe.settle(complete, if (width > 0f) velocityX / width else 0f, onCommit)
}

/**
 * An inner horizontal scroller (a code block, a table, a row of reactions) at its left edge passes on the drag it
 * cannot scroll: that continues as the back swipe. Only the finger's own drag, never a fling's momentum.
 */
private class SwipeNestedScroll(
    private val swipe: SwipeNavState,
    private val back: State<TabStacks?>,
    private val width: () -> Float,
    private val commit: (TabStacks) -> Unit,
) : NestedScrollConnection {
    private var driving = false
    private var dx = 0f

    override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
        if (!driving || swipe.settling) return Offset.Zero
        // While the page slides, every sideways move is the swipe's (back left covers the list again before the content scrolls).
        dx += available.x
        swipe.shift = SwipeNav.upperShift(dx, width(), forward = false)
        return Offset(available.x, 0f)
    }

    override fun onPostScroll(consumed: Offset, available: Offset, source: NestedScrollSource): Offset {
        if (driving || swipe.active || source != NestedScrollSource.UserInput) return Offset.Zero
        if (available.x <= 0f || abs(available.x) < abs(available.y)) return Offset.Zero
        val target = back.value ?: return Offset.Zero
        swipe.begin(target, forward = false)
        driving = true
        dx = available.x
        swipe.shift = SwipeNav.upperShift(dx, width(), forward = false)
        return Offset(available.x, 0f)
    }

    override suspend fun onPreFling(available: Velocity): Velocity {
        if (!driving) return Velocity.Zero
        driving = false
        val w = width()
        val complete = SwipeNav.shouldComplete(swipe.shift, available.x, w * FLING_WIDTHS)
        swipe.settle(complete, if (w > 0f) available.x / w else 0f, commit)
        return Velocity(available.x, 0f)
    }

    private companion object {
        /** A fling of 1.5 widths per second completes, as the finger's ~700 dp/s on a phone. */
        const val FLING_WIDTHS = 1.5f
    }
}
