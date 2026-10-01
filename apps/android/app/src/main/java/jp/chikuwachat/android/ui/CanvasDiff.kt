package jp.chikuwachat.android.ui

import kotlin.math.max
import kotlin.math.min

/**
 * M58: the history's comparison of two versions of a canvas (CANVAS.md §4.9 「現在の版との行単位の差分」), a port of the
 * desktop's src/ui/canvasDiff.ts (M44, §14): lines added and removed (Myers' diff, common head and tail trimmed first),
 * and inside a line that was only touched up the words that changed. The words are cut as the server's merge cuts them
 * (server/app/modules/canvases/merge.py): spaces, one punctuation mark, or a run of one script — kanji, hiragana,
 * katakana, letters and digits — so a Japanese sentence splits into its phrases without spaces. Display only; merging
 * stays on the server.
 */
object CanvasDiff {
    enum class Kind { SAME, ADD, DEL }

    data class WordPiece(val text: String, val changed: Boolean)

    /** `oldNo` / `newNo`: 1-based line numbers in the older / newer text. `words`: a touched-up line's changed words. */
    data class Line(val kind: Kind, val text: String, val oldNo: Int?, val newNo: Int?, val words: List<WordPiece>? = null)

    /** A shown line, or a folded stretch of kept lines (「… n 行 …」). */
    sealed class Row {
        data class Text(val line: Line) : Row()
        data class Skip(val count: Int) : Row()
    }

    private data class Op(val kind: Kind, val a: Int, val b: Int)

    /** Beyond this many edits the middle is taken as replaced as a whole (a pasted-over document): still correct, less fine. */
    private const val MAX_EDITS = 3_000

    private fun <T> editScript(a: List<T>, b: List<T>, maxEdits: Int = MAX_EDITS): List<Op> {
        var head = 0
        while (head < a.size && head < b.size && a[head] == b[head]) head++
        var tail = 0
        while (tail < a.size - head && tail < b.size - head && a[a.size - 1 - tail] == b[b.size - 1 - tail]) tail++
        val ops = ArrayList<Op>()
        for (i in 0 until head) ops.add(Op(Kind.SAME, i, i))
        val n = a.size - head - tail
        val m = b.size - head - tail
        ops.addAll(middleScript(a, b, head, n, m, maxEdits))
        for (i in 0 until tail) ops.add(Op(Kind.SAME, head + n + i, head + m + i))
        return ops
    }

    /** Myers' O((N+M)·D) shortest edit script of the middle; the frontiers kept are only what the walk back reads (O(D²)). */
    private fun <T> middleScript(a: List<T>, b: List<T>, off: Int, n: Int, m: Int, maxEdits: Int): List<Op> {
        fun removeAll(): List<Op> = (0 until n).map { Op(Kind.DEL, off + it, -1) } + (0 until m).map { Op(Kind.ADD, -1, off + it) }
        if (n == 0 || m == 0) return removeAll()
        val limit = min(n + m, maxEdits)
        val size = 2 * limit + 1
        val v = IntArray(size)
        val trace = ArrayList<Pair<Int, IntArray>>()
        var found = -1
        for (d in 0..limit) {
            val lo = max(0, limit - d - 1)
            trace.add(lo to v.copyOfRange(lo, min(size, limit + d + 2)))
            var k = -d
            while (k <= d) {
                val down = k == -d || (k != d && v[limit + k - 1] < v[limit + k + 1])
                var x = if (down) v[limit + k + 1] else v[limit + k - 1] + 1
                var y = x - k
                while (x < n && y < m && a[off + x] == b[off + y]) {
                    x++
                    y++
                }
                v[limit + k] = x
                if (x >= n && y >= m) {
                    found = d
                    break
                }
                k += 2
            }
            if (found >= 0) break
        }
        if (found < 0) return removeAll()
        val ops = ArrayList<Op>()
        var x = n
        var y = m
        for (d in found downTo 1) {
            val (lo, frame) = trace[d]
            fun at(k: Int) = frame[limit + k - lo]
            val k = x - y
            val down = k == -d || (k != d && at(k - 1) < at(k + 1))
            val prevK = if (down) k + 1 else k - 1
            val prevX = at(prevK)
            val prevY = prevX - prevK
            while (x > prevX && y > prevY) {
                x--
                y--
                ops.add(Op(Kind.SAME, off + x, off + y))
            }
            if (down) {
                y--
                ops.add(Op(Kind.ADD, -1, off + y))
            } else {
                x--
                ops.add(Op(Kind.DEL, off + x, -1))
            }
        }
        while (x > 0 && y > 0) {
            x--
            y--
            ops.add(Op(Kind.SAME, off + x, off + y))
        }
        ops.reverse()
        return ops
    }

    // (?s): `.` takes any character. The spaces are spelled out (JavaScript's `\s` but the line break: the full-width
    // space too): the JVM's `\s` is ASCII only and Android's ICU refuses the (?U) flag that would widen it (it crashed
    // the history on the emulator). `script=` is the script syntax both the JVM and ICU read.
    private val WORD = Regex("""(?s)\n|[\p{Z}\t\x{0B}\f\r\x{FEFF}]+|[\p{script=Han}々〆ヶ]+|\p{script=Hiragana}+|[\p{script=Katakana}ー]+|[\p{L}\p{N}_]+|.""")

    /** A line cut into words as the server's merge cuts it. */
    fun words(text: String): List<String> = WORD.findAll(text).map { it.value }.toList()

    /**
     * The words that changed between a removed line and the line that took its place, or null when the two share too
     * little to be read as one line touched up (then they show as a plain removal and addition).
     */
    fun wordDiff(before: String, after: String): Pair<List<WordPiece>, List<WordPiece>>? {
        val a = words(before)
        val b = words(after)
        if (a.size + b.size > 2_000) return null
        val ops = editScript(a, b, 400)
        val same = ops.filter { it.kind == Kind.SAME }.sumOf { a[it.a].length }
        val longer = max(before.length, after.length)
        if (longer == 0 || same.toDouble() / longer < 0.4) return null
        fun pieces(kind: Kind): List<WordPiece> {
            val out = ArrayList<WordPiece>()
            fun push(text: String, changed: Boolean) {
                val last = out.lastOrNull()
                if (last != null && last.changed == changed) out[out.size - 1] = last.copy(text = last.text + text) else out.add(WordPiece(text, changed))
            }
            for (op in ops) {
                if (op.kind == Kind.SAME) push(if (kind == Kind.DEL) a[op.a] else b[op.b], false)
                else if (op.kind == kind) push(if (kind == Kind.DEL) a[op.a] else b[op.b], true)
            }
            return out
        }
        return pieces(Kind.DEL) to pieces(Kind.ADD)
    }

    /** Every line of `after` against `before`: kept, removed or added, with the changed words of lines touched up. */
    fun lines(before: String, after: String): List<Line> {
        val a = if (before.isEmpty()) emptyList() else before.split("\n")
        val b = if (after.isEmpty()) emptyList() else after.split("\n")
        val ops = editScript(a, b)
        val out = ArrayList<Line>()
        var i = 0
        while (i < ops.size) {
            val op = ops[i]
            if (op.kind == Kind.SAME) {
                out.add(Line(Kind.SAME, a[op.a], op.a + 1, op.b + 1))
                i++
                continue
            }
            // A run of removals and additions: paired in order for the word view.
            val dels = ArrayList<Op>()
            val adds = ArrayList<Op>()
            while (i < ops.size && ops[i].kind != Kind.SAME) {
                if (ops[i].kind == Kind.DEL) dels.add(ops[i]) else adds.add(ops[i])
                i++
            }
            val delLines = dels.map { Line(Kind.DEL, a[it.a], it.a + 1, null) }.toMutableList()
            val addLines = adds.map { Line(Kind.ADD, b[it.b], null, it.b + 1) }.toMutableList()
            for (p in 0 until min(delLines.size, addLines.size)) {
                val pair = wordDiff(delLines[p].text, addLines[p].text) ?: continue
                delLines[p] = delLines[p].copy(words = pair.first)
                addLines[p] = addLines[p].copy(words = pair.second)
            }
            out.addAll(delLines)
            out.addAll(addLines)
        }
        return out
    }

    /** The changed lines with `context` lines around them; longer stretches of kept lines fold into a 「… n 行 …」 row. */
    fun rows(lines: List<Line>, context: Int = 3): List<Row> {
        val keep = BooleanArray(lines.size)
        lines.forEachIndexed { index, line ->
            if (line.kind == Kind.SAME) return@forEachIndexed
            for (k in max(0, index - context)..min(lines.size - 1, index + context)) keep[k] = true
        }
        val rows = ArrayList<Row>()
        var skipped = 0
        lines.forEachIndexed { index, line ->
            if (keep[index]) {
                if (skipped > 0) rows.add(Row.Skip(skipped))
                skipped = 0
                rows.add(Row.Text(line))
            } else skipped++
        }
        if (skipped > 0) rows.add(Row.Skip(skipped))
        return rows
    }

    /** 「+3 −1」: lines added and removed. */
    fun counts(lines: List<Line>): Pair<Int, Int> = lines.count { it.kind == Kind.ADD } to lines.count { it.kind == Kind.DEL }

    /**
     * 「前の版」 of the version at `index` in the list (newest first): the next older one listed, else (the oldest one
     * loaded) the version it was written on; none for the first version.
     */
    fun previousId(list: List<jp.chikuwachat.android.api.CanvasRevisionMeta>, index: Int): String? {
        val selected = list.getOrNull(index) ?: return null
        return list.getOrNull(index + 1)?.id ?: if (selected.kind == "create") null else selected.parentRevId
    }
}
