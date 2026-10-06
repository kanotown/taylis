package jp.chikuwachat.android.ui

import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.PointerEventPass
import androidx.compose.ui.input.pointer.PointerEventType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.text.TextLayoutResult
import kotlinx.coroutines.flow.collectLatest
import kotlin.math.floor
import kotlin.math.roundToInt

/**
 * The canvas's scroll sync (840 dp and wider, the editor and the preview side by side; the desktop's line-based design).
 * Each preview item (the title, one per block, the end) knows its source lines ([BlockSpan]); the editor's top edge is a
 * source line, fractional within it (its wrapped rows count), and the preview puts the matching block, interpolated within
 * it, at its top — and the other way round. Only the side the user last touched (or typed into) drives; the other one
 * follows and its own scroll changes are ignored, so nothing loops. Both are at the top at 0 and at the end when the one
 * that drives reaches its end.
 */
object CanvasScrollSync {
    /** What the sync needs of the editor's text layout (rows = visual lines; a [TextLayoutResult] in the app). */
    interface Rows {
        val count: Int
        fun top(row: Int): Float
        fun bottom(row: Int): Float
        /** The row at `y` (clamped to the first / last row). */
        fun rowAt(y: Float): Int
        /** The row that holds the character at `offset` (a `\n` is in the row it ends). */
        fun rowOf(offset: Int): Int
        /** The first character of `row`. */
        fun start(row: Int): Int
    }

    fun rows(layout: TextLayoutResult): Rows = object : Rows {
        override val count get() = layout.lineCount
        override fun top(row: Int) = layout.getLineTop(row)
        override fun bottom(row: Int) = layout.getLineBottom(row)
        override fun rowAt(y: Float) = layout.getLineForVerticalPosition(y)
        override fun rowOf(offset: Int) = layout.getLineForOffset(offset)
        override fun start(row: Int) = layout.getLineStart(row)
    }

    /** Where each source line starts in `text`. */
    fun lineStarts(text: String): IntArray {
        val starts = ArrayList<Int>().apply { add(0) }
        text.forEachIndexed { index, c -> if (c == '\n') starts.add(index + 1) }
        return starts.toIntArray()
    }

    /** The source line (0-based, fractional) at `y` in the editor's text (0 at or above its top, the line count below it). */
    fun editorLine(text: String, rows: Rows, y: Float): Double {
        if (y <= 0f || rows.count == 0) return 0.0
        val starts = lineStarts(text)
        val row = rows.rowAt(y)
        val line = lineAtOffset(starts, rows.start(row))
        val (top, bottom) = extent(text, starts, rows, line)
        if (y >= bottom && line == starts.size - 1) return starts.size.toDouble()
        val height = bottom - top
        val within = if (height > 0f) ((y - top) / height).coerceIn(0f, 1f) else 0f
        return line + within.toDouble()
    }

    /** The inverse: the editor's `y` of a source line (fractional within it); the text's bottom past its last line. */
    fun editorY(text: String, rows: Rows, line: Double): Float {
        if (rows.count == 0 || line <= 0.0) return 0f
        val starts = lineStarts(text)
        if (line >= starts.size) return rows.bottom(rows.count - 1)
        val whole = floor(line).toInt().coerceIn(0, starts.size - 1)
        val (top, bottom) = extent(text, starts, rows, whole)
        return top + ((line - whole).toFloat().coerceIn(0f, 1f)) * (bottom - top)
    }

    /** The preview item and the fraction within it of a source line: the title is item 0, block k is item k + 1. */
    fun previewTarget(spans: List<BlockSpan>, line: Double): Pair<Int, Double> {
        if (spans.isEmpty() || line <= 0.0) return 0 to 0.0
        if (line >= spans.last().end) return spans.size + 1 to 0.0
        var lo = 0
        var hi = spans.size - 1
        while (lo < hi) { // the last span starting at or before the line
            val mid = (lo + hi + 1) / 2
            if (spans[mid].start <= line) lo = mid else hi = mid - 1
        }
        val span = spans[lo]
        val length = (span.end - span.start).coerceAtLeast(1)
        return lo + 1 to ((line - span.start) / length).coerceIn(0.0, 1.0)
    }

    /** The source line at the preview's top: item `index`, `offset` px into it, `size` px tall; `lines` past the end. */
    fun previewLine(spans: List<BlockSpan>, lines: Int, index: Int, offset: Int, size: Int): Double {
        if (index <= 0) return 0.0
        if (index > spans.size) return lines.toDouble()
        val span = spans[index - 1]
        val within = if (size > 0) (offset.toDouble() / size).coerceIn(0.0, 1.0) else 0.0
        return span.start + within * (span.end - span.start)
    }

    private fun lineAtOffset(starts: IntArray, offset: Int): Int {
        val found = starts.binarySearch(offset)
        return if (found >= 0) found else (-found - 2).coerceAtLeast(0)
    }

    /** The top of a source line's first row and the bottom of its last (a wrapped line spans several rows). */
    private fun extent(text: String, starts: IntArray, rows: Rows, line: Int): Pair<Float, Float> {
        val first = rows.rowOf(starts[line])
        val endOffset = if (line + 1 < starts.size) starts[line + 1] - 1 else text.length
        val last = rows.rowOf(endOffset).coerceAtLeast(first)
        return rows.top(first) to rows.bottom(last)
    }
}

enum class ScrollDriver { EDITOR, PREVIEW }

/** The two-column editor's shared scroll state: the editor's scroll, its last text layout and who drives. */
@Stable
class CanvasScrollLink {
    val editor = ScrollState(0)
    var driver by mutableStateOf(ScrollDriver.EDITOR)
    var layout by mutableStateOf<TextLayoutResult?>(null)
    /** The editor's padding above its text, in px (the layout's 0 is that far below the scroll's 0). */
    var editorTop = 0f
}

/** A press or a wheel turn on this side makes it the one that drives (the event is only looked at, never taken). */
fun Modifier.drivesScroll(link: CanvasScrollLink, side: ScrollDriver): Modifier = pointerInput(link, side) {
    awaitPointerEventScope {
        while (true) {
            val event = awaitPointerEvent(PointerEventPass.Initial)
            if (event.type == PointerEventType.Press || event.type == PointerEventType.Scroll) link.driver = side
        }
    }
}

/** Keeps the side that does not drive where the driving side is. `spans`: the preview's blocks and their source lines. */
@Composable
fun CanvasScrollSyncEffect(link: CanvasScrollLink, preview: LazyListState, spans: List<BlockSpan>) {
    LaunchedEffect(link, preview, spans) {
        snapshotFlow { link.driver }.collectLatest { driver ->
            if (driver == ScrollDriver.EDITOR) {
                snapshotFlow { Triple(link.editor.value, link.editor.maxValue, link.layout) }.collect { (value, max, layout) ->
                    if (layout == null || max == Int.MAX_VALUE) return@collect
                    val end = spans.size + 1
                    when {
                        value <= 0 -> preview.scrollToItem(0)
                        max > 0 && value >= max -> preview.scrollToItem(end)
                        else -> {
                            val line = CanvasScrollSync.editorLine(layout.layoutInput.text.text, CanvasScrollSync.rows(layout), value - link.editorTop)
                            val (index, within) = CanvasScrollSync.previewTarget(spans, line)
                            var size = preview.layoutInfo.visibleItemsInfo.firstOrNull { it.index == index }?.size
                            if (size == null) { // not laid out yet: go there first (a forced remeasure), then measure it
                                preview.scrollToItem(index)
                                size = preview.layoutInfo.visibleItemsInfo.firstOrNull { it.index == index }?.size ?: 0
                            }
                            preview.scrollToItem(index, (within * size).roundToInt())
                        }
                    }
                }
            } else {
                snapshotFlow {
                    val first = preview.firstVisibleItemIndex
                    val size = preview.layoutInfo.visibleItemsInfo.firstOrNull { it.index == first }?.size ?: 0
                    PreviewTop(first, preview.firstVisibleItemScrollOffset, size, preview.canScrollForward, link.layout)
                }.collect { top ->
                    val layout = top.layout ?: return@collect
                    val editor = link.editor
                    if (editor.maxValue == Int.MAX_VALUE) return@collect
                    when {
                        top.index == 0 && top.offset == 0 -> editor.scrollTo(0)
                        !top.canScrollForward -> editor.scrollTo(editor.maxValue)
                        else -> {
                            val text = layout.layoutInput.text.text
                            val line = CanvasScrollSync.previewLine(spans, CanvasScrollSync.lineStarts(text).size, top.index, top.offset, top.size)
                            val y = CanvasScrollSync.editorY(text, CanvasScrollSync.rows(layout), line) + link.editorTop
                            editor.scrollTo(y.roundToInt().coerceIn(0, editor.maxValue))
                        }
                    }
                }
            }
        }
    }
}

private data class PreviewTop(val index: Int, val offset: Int, val size: Int, val canScrollForward: Boolean, val layout: TextLayoutResult?)
