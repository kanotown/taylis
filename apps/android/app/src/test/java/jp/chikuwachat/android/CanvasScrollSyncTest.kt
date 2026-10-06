package jp.chikuwachat.android

import jp.chikuwachat.android.ui.BodyBlock
import jp.chikuwachat.android.ui.CanvasScrollSync
import jp.chikuwachat.android.ui.parseBlockSpans
import jp.chikuwachat.android.ui.parseBlocks
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The canvas's scroll sync between the editor and the preview (840 dp and wider): the pure line mapping. */
class CanvasScrollSyncTest {
    /** Rows of a monospace layout: `width` characters to a row, 10 px each (an empty line is one row). */
    private class FakeRows(text: String, width: Int) : CanvasScrollSync.Rows {
        val starts = ArrayList<Int>()
        val ends = ArrayList<Int>() // the offset of the row's last character (its `\n`, or the text's end)
        init {
            var offset = 0
            for (line in text.split("\n")) {
                var at = 0
                do {
                    starts.add(offset + at)
                    at = minOf(line.length, at + width)
                    ends.add(offset + at)
                } while (at < line.length)
                offset += line.length + 1
            }
        }
        override val count get() = starts.size
        override fun top(row: Int) = row * 10f
        override fun bottom(row: Int) = row * 10f + 10f
        override fun rowAt(y: Float) = (y / 10f).toInt().coerceIn(0, count - 1)
        override fun rowOf(offset: Int) = (0 until count).first { offset <= ends[it] }
        override fun start(row: Int) = starts[row]
    }

    private val body = listOf(
        "# Title", // 0
        "", // 1
        "First paragraph", // 2
        "goes on here.", // 3
        "", // 4
        "- one", // 5
        "- two", // 6
        "1. three", // 7
        "", // 8
        "```", // 9
        "code", // 10
        "```", // 11
        "- [ ] task", // 12
        "---", // 13 (not a rule: no blank line before it)
    ).joinToString("\n")

    @Test
    fun spansCoverEveryLineInOrder() {
        val spans = parseBlockSpans(body, canvas = true)
        assertEquals(parseBlocks(body, canvas = true), spans.map { it.block })
        assertEquals(0, spans.first().start)
        assertEquals(body.split("\n").size, spans.last().end)
        spans.zipWithNext().forEach { (a, b) -> assertEquals(a.end, b.start) }
        spans.forEach { assertTrue(it.end > it.start) }
        val heading = spans.first { it.block is BodyBlock.Heading }
        assertEquals(0 to 1, heading.start to heading.end)
        // A list split by kind: one span per run, one line per item.
        val lists = spans.filter { it.block is BodyBlock.ListBlock }
        assertEquals(listOf(5 to 7, 7 to 8), lists.map { it.start to it.end })
        val code = spans.first { it.block is BodyBlock.CodeBlock }
        assertEquals(9 to 12, code.start to code.end)
    }

    @Test
    fun lastBlockEndsAtTheLastLine() {
        val spans = parseBlockSpans("a\nb", canvas = true)
        assertEquals(1, spans.size)
        assertEquals(0 to 2, spans[0].start to spans[0].end)
        assertEquals(listOf(0 to 1), parseBlockSpans("", canvas = true).map { it.start to it.end })
    }

    @Test
    fun editorLineCountsWrappedRows() {
        val text = "short\n" + "x".repeat(25) + "\nend" // line 1 wraps into 3 rows of 10
        val rows = FakeRows(text, 10)
        assertEquals(5, rows.count)
        assertEquals(0.0, CanvasScrollSync.editorLine(text, rows, 0f), 1e-9)
        assertEquals(0.0, CanvasScrollSync.editorLine(text, rows, -5f), 1e-9)
        assertEquals(0.5, CanvasScrollSync.editorLine(text, rows, 5f), 1e-9)
        assertEquals(1.0, CanvasScrollSync.editorLine(text, rows, 10f), 1e-9)
        // Halfway through the 3 rows (30 px) of line 1.
        assertEquals(1.5, CanvasScrollSync.editorLine(text, rows, 25f), 1e-9)
        assertEquals(2.0, CanvasScrollSync.editorLine(text, rows, 40f), 1e-9)
        // Below the text: the line count.
        assertEquals(3.0, CanvasScrollSync.editorLine(text, rows, 500f), 1e-9)
    }

    @Test
    fun editorYIsTheInverse() {
        val text = "short\n" + "x".repeat(25) + "\nend"
        val rows = FakeRows(text, 10)
        for (y in listOf(0f, 3f, 10f, 17f, 25f, 39f, 40f, 45f)) {
            val line = CanvasScrollSync.editorLine(text, rows, y)
            assertEquals("y=$y", y, CanvasScrollSync.editorY(text, rows, line), 1e-3f)
        }
        assertEquals(0f, CanvasScrollSync.editorY(text, rows, -1.0), 0f)
        assertEquals(50f, CanvasScrollSync.editorY(text, rows, 3.0), 0f)
        assertEquals(50f, CanvasScrollSync.editorY(text, rows, 99.0), 0f)
    }

    @Test
    fun previewTargetFindsTheBlockAndTheFractionInIt() {
        val spans = parseBlockSpans(body, canvas = true)
        assertEquals(0 to 0.0, CanvasScrollSync.previewTarget(spans, 0.0))
        // Line 2.5 is in the paragraph (lines 1–4, item index of that block + 1).
        val paragraph = spans.indexOfFirst { it.block is BodyBlock.Paragraph }
        val p = spans[paragraph]
        val (index, within) = CanvasScrollSync.previewTarget(spans, 2.5)
        assertEquals(paragraph + 1, index)
        assertEquals((2.5 - p.start) / (p.end - p.start), within, 1e-9)
        // The code block (lines 9–11), a third of the way in.
        val code = spans.indexOfFirst { it.block is BodyBlock.CodeBlock }
        val (codeIndex, codeWithin) = CanvasScrollSync.previewTarget(spans, 10.0)
        assertEquals(code + 1, codeIndex)
        assertEquals(1.0 / 3, codeWithin, 1e-9)
        // Past the last line: the end item.
        assertEquals(spans.size + 1 to 0.0, CanvasScrollSync.previewTarget(spans, 14.0))
        assertEquals(0 to 0.0, CanvasScrollSync.previewTarget(emptyList(), 3.0))
    }

    @Test
    fun previewLineIsTheInverse() {
        val spans = parseBlockSpans(body, canvas = true)
        val lines = body.split("\n").size
        assertEquals(0.0, CanvasScrollSync.previewLine(spans, lines, 0, 40, 100), 1e-9)
        assertEquals(lines.toDouble(), CanvasScrollSync.previewLine(spans, lines, spans.size + 1, 0, 48), 1e-9)
        for (line in listOf(0.5, 1.0, 2.25, 5.0, 6.5, 7.0, 9.9, 12.0, 13.5)) {
            val (index, within) = CanvasScrollSync.previewTarget(spans, line)
            val size = 200
            val back = CanvasScrollSync.previewLine(spans, lines, index, (within * size).toInt(), size)
            val span = spans[index - 1]
            assertEquals("line=$line", line, back, (span.end - span.start).toDouble() / size + 1e-9)
        }
        // An item not measured yet (size 0) maps to its first line.
        assertEquals(spans[2].start.toDouble(), CanvasScrollSync.previewLine(spans, lines, 3, 10, 0), 1e-9)
    }

    @Test
    fun editorToPreviewAndBack() {
        // A long canvas: the editor's top at line 40.5 puts the preview's block at that line, and the preview there gives 40.5 back.
        val text = (0 until 100).joinToString("\n") { if (it % 10 == 0) "## Heading $it" else "line $it" }
        val rows = FakeRows(text, 80)
        val spans = parseBlockSpans(text, canvas = true)
        val line = CanvasScrollSync.editorLine(text, rows, 405f)
        assertEquals(40.5, line, 1e-9)
        val (index, within) = CanvasScrollSync.previewTarget(spans, line)
        assertTrue(spans[index - 1].block is BodyBlock.Heading)
        assertEquals(0.5, within, 1e-9)
        val back = CanvasScrollSync.previewLine(spans, 100, index, (within * 60).toInt(), 60)
        assertEquals(405f, CanvasScrollSync.editorY(text, rows, back), 1e-3f)
    }
}
