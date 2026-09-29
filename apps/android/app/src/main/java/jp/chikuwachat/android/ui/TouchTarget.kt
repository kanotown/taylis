package jp.chikuwachat.android.ui

import androidx.compose.foundation.LocalIndication
import androidx.compose.foundation.indication
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.LayoutModifier
import androidx.compose.ui.layout.Measurable
import androidx.compose.ui.layout.MeasureResult
import androidx.compose.ui.layout.MeasureScope
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/** The sizes [TouchTarget] works out: the visible node's, set while measuring and read by the node outside it. */
object TouchTarget {
    /** Material's minimum for anything tappable. */
    val MIN = 48.dp

    /** The grown side for a visible side `visible` px and a minimum `min` px, within `max` px (the constraints). */
    fun grown(visible: Int, min: Int, max: Int): Int = maxOf(visible, min).coerceAtMost(max)

    /** Where the visible part goes inside a grown node (or the grown node inside the visible one): centred, so negative outside. */
    fun offset(outer: Int, inner: Int): Int = (outer - inner) / 2
}

/**
 * M28c: a touch target of at least [min] for a small control (a reaction chip, a text link, the × on a pending attachment,
 * a 36 dp avatar), without moving what is around it: the node keeps its drawn size in the layout and takes touches from
 * the margin around it. Material's minimumInteractiveComponentSize grows the node itself, which would push the rows of a
 * message apart.
 *
 * `interactive` builds the clickable from an interaction source: it goes on the grown node (so its pointer input and its
 * semantics bounds are the large ones) with no indication of its own, and the ripple is drawn on the visible node from
 * the same source, so it still fills the control and not the margin. Compose hit-tests children outside their parent's
 * bounds when the parent does not clip; where two margins overlap, the one composed later (drawn on top) wins, and a
 * parent's own clickable (a message row) still gets the taps its children do not take.
 */
@Composable
fun Modifier.touchTarget(min: Dp = TouchTarget.MIN, interactive: (MutableInteractionSource) -> Modifier): Modifier {
    val source = remember { MutableInteractionSource() }
    val shared = remember { VisibleSize() }
    return this
        .then(ShrinkToVisible(shared))
        .then(interactive(source))
        .then(GrowToMinimum(shared, min))
        .indication(source, LocalIndication.current)
}

private class VisibleSize {
    var width = 0
    var height = 0
}

/** Inside the clickable: measures the control, notes its size, and grows to [min] with the control centred. */
private data class GrowToMinimum(val shared: VisibleSize, val min: Dp) : LayoutModifier {
    override fun MeasureScope.measure(measurable: Measurable, constraints: Constraints): MeasureResult {
        val placeable = measurable.measure(constraints)
        shared.width = placeable.width
        shared.height = placeable.height
        val px = min.roundToPx()
        val width = TouchTarget.grown(placeable.width, px, constraints.maxWidth)
        val height = TouchTarget.grown(placeable.height, px, constraints.maxHeight)
        return layout(width, height) { placeable.place(TouchTarget.offset(width, placeable.width), TouchTarget.offset(height, placeable.height)) }
    }
}

/** Outside the clickable: reports the control's own size to the parent and lets the grown node overflow around it. */
private data class ShrinkToVisible(val shared: VisibleSize) : LayoutModifier {
    override fun MeasureScope.measure(measurable: Measurable, constraints: Constraints): MeasureResult {
        val placeable = measurable.measure(constraints)
        val width = shared.width.coerceIn(constraints.minWidth, constraints.maxWidth)
        val height = shared.height.coerceIn(constraints.minHeight, constraints.maxHeight)
        return layout(width, height) { placeable.place(TouchTarget.offset(width, placeable.width), TouchTarget.offset(height, placeable.height)) }
    }
}
