package jp.chikuwachat.android.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.Layout
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.constrainHeight
import androidx.compose.ui.unit.dp

/**
 * A person's name with a status pill (the 在室状況 chip) beside it, and the line under it (`@username`), as in a channel's
 * member list (docs/PRESENCE.md §9.2; user report 2026-11-09: a long pill squeezed the name to 「オネ…」). The name keeps
 * its natural width and is cut only when it cannot fit by itself; the pill gives way: cut with … on the name's line while
 * at least [MIN_CHARACTERS] of its label still show, else moved to the line under it, after the `@username`. There it
 * gives way again: the username keeps its width unless the pill would lose even its icon.
 */
object NamePill {
    /** As the quick switch's pill (PRESENCE.md §7.1): a label cut shorter than 4 characters says nothing. */
    const val MIN_CHARACTERS = 4

    /**
     * Where the pill goes. [pillWidth]: the most it may take (its own width when that fits). [subtitleWidth]: the most the
     * line under the name may take; the whole width unless the pill sits beside it.
     */
    data class Placement(val secondLine: Boolean, val pillWidth: Int, val subtitleWidth: Int)

    /**
     * All in pixels. [width]: the column's; [title]: the name line's own width (the name with its small marks, never
     * wider than [width]); [subtitle] and [pill]: their natural widths; [pillMin]: the pill with [MIN_CHARACTERS] of its
     * label and the ellipsis; [pillLeast]: the pill with only its icon and the ellipsis; [gap]: between the pill and what
     * it follows.
     */
    fun place(width: Int, title: Int, subtitle: Int, pill: Int, pillMin: Int, pillLeast: Int, gap: Int): Placement {
        // A pill shorter than a minimum needs only its own width.
        val besideName = width - title - gap
        if (besideName >= minOf(pill, pillMin)) return Placement(secondLine = false, pillWidth = minOf(pill, besideName), subtitleWidth = width)
        // Under the name, after the @username, which is cut only when the pill would lose its icon too.
        val subtitleWidth = minOf(subtitle, maxOf(0, width - gap - minOf(pill, pillLeast)))
        return Placement(secondLine = true, pillWidth = minOf(pill, maxOf(0, width - subtitleWidth - gap)), subtitleWidth = subtitleWidth)
    }

    /** A small pill (AttendancePane's StatePill) with [characters] of its `labelSmall` label, the ellipsis, its icon and padding. */
    @Composable
    fun smallPillWidth(characters: Int): Dp = with(LocalDensity.current) { MaterialTheme.typography.labelSmall.fontSize.toDp() } * (characters + 1) + 25.dp
}

/**
 * The two lines of [NamePill]: [title] (the name, then its small marks; it cuts the name itself, as a Row with the name
 * `weight(1f, fill = false)` does), [pill] (may draw nothing: then the lines are only stacked) and [subtitle] (one line).
 */
@Composable
fun NameWithPill(
    title: @Composable () -> Unit,
    pill: @Composable () -> Unit,
    subtitle: @Composable () -> Unit,
    modifier: Modifier = Modifier,
    pillMin: Dp = NamePill.smallPillWidth(NamePill.MIN_CHARACTERS),
    pillLeast: Dp = NamePill.smallPillWidth(0),
    gap: Dp = 6.dp,
) {
    Layout(contents = listOf(title, pill, subtitle), modifier = modifier) { (titles, pills, subtitles), constraints ->
        val gapPx = gap.roundToPx()
        val loose = constraints.copy(minWidth = 0, minHeight = 0)
        val titlePlaceable = titles.firstOrNull()?.measure(loose)
        val titleWidth = titlePlaceable?.width ?: 0
        val pillMeasurable = pills.firstOrNull()
        val subtitleMeasurable = subtitles.firstOrNull()
        val pillNatural = pillMeasurable?.maxIntrinsicWidth(Constraints.Infinity) ?: 0
        val subtitleNatural = subtitleMeasurable?.maxIntrinsicWidth(Constraints.Infinity) ?: 0
        val width = if (constraints.hasBoundedWidth) constraints.maxWidth
        else maxOf(titleWidth + gapPx + pillNatural, subtitleNatural)
        val placement = if (pillMeasurable != null) NamePill.place(width, titleWidth, subtitleNatural, pillNatural, pillMin.roundToPx(), pillLeast.roundToPx(), gapPx) else null
        val pillPlaceable = if (pillMeasurable != null && placement != null && placement.pillWidth > 0) pillMeasurable.measure(Constraints(maxWidth = placement.pillWidth)) else null
        val subtitlePlaceable = subtitleMeasurable?.measure(Constraints(maxWidth = placement?.subtitleWidth ?: width))
        val onFirst = pillPlaceable?.takeIf { placement?.secondLine == false }
        val onSecond = pillPlaceable?.takeIf { placement?.secondLine == true }
        val firstHeight = maxOf(titlePlaceable?.height ?: 0, onFirst?.height ?: 0)
        val secondHeight = maxOf(subtitlePlaceable?.height ?: 0, onSecond?.height ?: 0)
        val layoutWidth = if (constraints.hasBoundedWidth) maxOf(constraints.minWidth, width) else width
        layout(layoutWidth, constraints.constrainHeight(firstHeight + secondHeight)) {
            titlePlaceable?.placeRelative(0, (firstHeight - titlePlaceable.height) / 2)
            onFirst?.placeRelative(titleWidth + gapPx, (firstHeight - onFirst.height) / 2)
            val subtitleWidth = subtitlePlaceable?.width ?: 0
            subtitlePlaceable?.placeRelative(0, firstHeight + (secondHeight - subtitlePlaceable.height) / 2)
            onSecond?.placeRelative(if (subtitleWidth > 0) subtitleWidth + gapPx else 0, firstHeight + (secondHeight - onSecond.height) / 2)
        }
    }
}
