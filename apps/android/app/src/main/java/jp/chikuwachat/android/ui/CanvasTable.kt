package jp.chikuwachat.android.ui

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import jp.chikuwachat.android.R
import jp.chikuwachat.android.L10n

/**
 * M57 (CANVAS.md §17): the canvas table editor's text rules — reading a Markdown table into a header, rows and column
 * alignment, writing it back, finding the table at the caret, inserting a new one and the edits (rows, columns,
 * alignment). A port of apps/shared/gen_canvas_table.py (the reference); apps/shared/canvas_table.json holds the cases
 * the three clients share (CanvasTableTest). Below the port: putting an edited table back into a body that may have
 * changed meanwhile (Android's own, not in the shared cases).
 */
object CanvasTable {
    @Serializable
    enum class Align(val wire: String) {
        @SerialName("left") LEFT("left"),
        @SerialName("center") CENTER("center"),
        @SerialName("right") RIGHT("right"),
    }

    /** A table: `align` and every row have the header's count. */
    @Serializable
    data class Table(val align: List<Align?>, val header: List<String>, val rows: List<List<String>>) {
        val columns: Int get() = header.size
    }

    /** A first and last line (0-based, inclusive). */
    @Serializable
    data class Range(val first: Int, val last: Int) {
        val size: Int get() = last - first + 1
    }

    // --- the port of gen_canvas_table.py -------------------------------------------------------------------------

    /** Python's `str.isspace()` characters (what `strip()` and `\s` take), so trimming matches the reference exactly. */
    private fun isPySpace(c: Char): Boolean = c in '\t'..'\r' || c in '\u001c'..'\u001f' || c == ' ' || c == '\u0085' ||
        c == ' ' || c == ' ' || c in ' '..' ' || c == ' ' || c == ' ' || c == ' ' ||
        c == ' ' || c == '　'

    private fun strip(s: String): String = s.trim(::isPySpace)
    private fun lstrip(s: String): String = s.trimStart(::isPySpace)

    /** Cells of one row: outer pipes dropped, split on unescaped pipes, `\|` read as `|`, each trimmed. */
    fun splitRow(line: String): List<String> {
        var s = strip(line)
        if (s.startsWith("|")) s = s.substring(1)
        if (s.endsWith("|") && !s.endsWith("\\|")) s = s.substring(0, s.length - 1)
        val cells = mutableListOf<String>()
        val cur = StringBuilder()
        var i = 0
        while (i < s.length) {
            if (s[i] == '\\' && i + 1 < s.length && s[i + 1] == '|') {
                cur.append('|')
                i += 2
                continue
            }
            if (s[i] == '|') {
                cells += strip(cur.toString())
                cur.setLength(0)
            } else {
                cur.append(s[i])
            }
            i += 1
        }
        cells += strip(cur.toString())
        return cells
    }

    fun alignOf(cell: String): Align? {
        val c = strip(cell)
        val left = c.startsWith(":")
        val right = c.endsWith(":")
        return when {
            left && right -> Align.CENTER
            left -> Align.LEFT
            right -> Align.RIGHT
            else -> null
        }
    }

    /** A table block (header, separator, body rows); body rows padded or cut to the header. */
    fun parse(lines: List<String>): Table {
        val header = splitRow(lines[0])
        val n = header.size
        val seps = splitRow(lines[1])
        val align = (0 until n).map { i -> if (i < seps.size) alignOf(seps[i]) else null }
        val rows = lines.drop(2).map { line ->
            val cells = splitRow(line)
            (cells + List(n) { "" }).take(n)
        }
        return Table(align, header, rows)
    }

    private val BREAK = Regex("[\\t-\\r\\u001c-\\u001f \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]*\\r?\\n[\\t-\\r\\u001c-\\u001f \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]*")

    /** A cell as written: one line (line breaks become spaces), `|` escaped, trimmed. */
    fun cellText(text: String): String = strip(text.replace(BREAK, " ")).replace("|", "\\|")

    private fun mark(align: Align?): String = when (align) {
        null -> "---"
        Align.LEFT -> ":---"
        Align.CENTER -> ":---:"
        Align.RIGHT -> "---:"
    }

    fun serialize(table: Table): List<String> {
        fun row(cells: List<String>) = "| " + cells.joinToString(" | ") { cellText(it) } + " |"
        val sep = "| " + table.align.joinToString(" | ") { mark(it) } + " |"
        return listOf(row(table.header), sep) + table.rows.map { row(it) }
    }

    /** `^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$` of the reference, without a regex (Java's `\s` is ASCII only). */
    fun isSeparator(line: String): Boolean {
        var s = strip(line)
        if (s.startsWith("|")) s = s.substring(1)
        if (s.endsWith("|")) s = s.substring(0, s.length - 1)
        return s.split("|").all { DASHES.matches(strip(it)) }
    }

    private val DASHES = Regex(":?-+:?")

    private fun isRow(line: String): Boolean = lstrip(line).startsWith("|")

    /**
     * The table whose lines include `caretLine`: consecutive lines starting with `|` whose second line is a separator.
     * Null when the caret is not in a table.
     */
    fun findTable(text: String, caretLine: Int): Range? {
        val lines = text.split("\n")
        if (caretLine !in lines.indices || !isRow(lines[caretLine])) return null
        var start = caretLine
        while (start > 0 && isRow(lines[start - 1])) start -= 1
        var end = caretLine
        while (end + 1 < lines.size && isRow(lines[end + 1])) end += 1
        if (end - start < 1 || !isSeparator(lines[start + 1])) return null
        return Range(start, end)
    }

    val NEW_TABLE = Table(listOf(null, null, null), listOf(L10n.str(R.string.canvas_table_column_1), L10n.str(R.string.canvas_table_column_2), L10n.str(R.string.canvas_table_column_3)), listOf(listOf("", "", ""), listOf("", "", "")))

    /** The text with a table in it and that table's lines. */
    data class Insertion(val text: String, val range: Range)

    /**
     * [NEW_TABLE] after the caret's line (at the start when the text is empty), with a blank line between it and any
     * text before or after.
     */
    fun insertTable(text: String, caretLine: Int): Insertion {
        val lines = if (text.isNotEmpty()) text.split("\n") else emptyList()
        val at = if (lines.isNotEmpty()) minOf(caretLine + 1, lines.size) else 0
        return insertBlock(lines, at, serialize(NEW_TABLE))
    }

    private fun insertBlock(lines: List<String>, at: Int, block: List<String>): Insertion {
        var before = lines.subList(0, at).toList()
        var after = lines.subList(at, lines.size).toList()
        if (before.isNotEmpty() && strip(before.last()).isNotEmpty()) before = before + ""
        if (after.isNotEmpty() && strip(after.first()).isNotEmpty()) after = listOf("") + after
        val out = before + block + after
        val first = before.size
        return Insertion(out.joinToString("\n"), Range(first, first + block.size - 1))
    }

    /** A blank body row inserted at `index` (0..rows). */
    fun addRow(t: Table, index: Int): Table = t.copy(rows = t.rows.toMutableList().apply { add(index, List(t.columns) { "" }) })

    /** A body row; the header stays. */
    fun deleteRow(t: Table, index: Int): Table = t.copy(rows = t.rows.toMutableList().apply { removeAt(index) })

    fun moveRow(t: Table, from: Int, to: Int): Table = t.copy(rows = t.rows.toMutableList().apply { add(to, removeAt(from)) })

    /** A blank column inserted at `index` (0..columns), its header 「列N」 with N the new count. */
    fun addColumn(t: Table, index: Int): Table = Table(
        align = t.align.toMutableList().apply { add(index, null) },
        header = t.header.toMutableList().apply { add(index, L10n.str(R.string.common_column, t.columns + 1)) },
        rows = t.rows.map { it.toMutableList().apply { add(index, "") } },
    )

    /** Refused (unchanged) when it is the last column. */
    fun deleteColumn(t: Table, index: Int): Table {
        if (t.columns <= 1) return t
        return Table(
            align = t.align.toMutableList().apply { removeAt(index) },
            header = t.header.toMutableList().apply { removeAt(index) },
            rows = t.rows.map { it.toMutableList().apply { removeAt(index) } },
        )
    }

    fun setAlign(t: Table, index: Int, align: Align?): Table = t.copy(align = t.align.toMutableList().apply { set(index, align) })

    fun setHeader(t: Table, column: Int, text: String): Table = t.copy(header = t.header.toMutableList().apply { set(column, text) })

    fun setCell(t: Table, row: Int, column: Int, text: String): Table =
        t.copy(rows = t.rows.mapIndexed { i, r -> if (i == row) r.toMutableList().apply { set(column, text) } else r })

    // --- the editor's session (Android) --------------------------------------------------------------------------

    /**
     * An open table editor. For a table in the text: its lines (`at`) and those lines as they were (`original`). For a
     * new table (`isNew`, nothing is in the text until 「完了」): `at` is the caret's line and `original` that line's text
     * (empty when the text was empty), to find the place again.
     */
    @Serializable
    data class Session(val at: Range, val original: List<String>, val table: Table, val isNew: Boolean = false)

    /** The editor for the table at the caret, or null when the caret is not in a table. */
    fun open(text: String, caretLine: Int): Session? {
        val range = findTable(text, caretLine) ?: return null
        val lines = text.split("\n").subList(range.first, range.last + 1)
        return Session(range, lines, parse(lines))
    }

    /** The editor for a new table ([NEW_TABLE]) to go after the caret's line; the text is not changed now. */
    fun openNew(text: String, caretLine: Int): Session {
        val lines = if (text.isNotEmpty()) text.split("\n") else emptyList()
        val line = caretLine.coerceIn(0, maxOf(lines.size - 1, 0))
        return Session(Range(line, line), listOfNotNull(lines.getOrNull(line)), NEW_TABLE, isNew = true)
    }

    /**
     * Where the session's table is in `text` now: its first line when the very lines it had are still a whole table
     * there — at the same place, or else (lines added or removed above it meanwhile) the nearest copy. Null when it was
     * changed (or removed).
     */
    fun locate(text: String, session: Session): Int? {
        val lines = text.split("\n")
        val n = session.original.size
        fun whole(at: Int) = at >= 0 && at + n <= lines.size && lines.subList(at, at + n) == session.original &&
            findTable(text, at) == Range(at, at + n - 1)
        if (whole(session.at.first)) return session.at.first
        return (0..lines.size - n).filter { it != session.at.first && whole(it) }.minByOrNull { kotlin.math.abs(it - session.at.first) }
    }

    sealed interface WriteBack {
        /** Nothing to write (an existing table, unchanged: its lines are not reformatted). */
        data object Unchanged : WriteBack

        /** The table's lines replaced, or a new table put in; `range` is where it now is. */
        data class Replaced(val text: String, val range: Range) : WriteBack

        /** The table had been changed by someone else meanwhile: the edited one is put in as a separate table. */
        data class Added(val text: String, val range: Range) : WriteBack
    }

    /**
     * 「完了」: the edited table into `text` (the editor's text now).
     *
     * A new table goes after its line (found again by its text: the same line, else the nearest line with that text,
     * else the same line number), as [insertTable] puts one in — after the table there if that line is now in one.
     *
     * A table in the text is found again by its original lines ([locate]) and replaced; when it was changed meanwhile
     * (or is gone) it is not overwritten — the edited table goes in as a new block right after the table now at that
     * place (or at that place), so both stay.
     */
    fun writeBack(text: String, session: Session, edited: Table): WriteBack {
        val block = serialize(edited)
        val lines = if (text.isNotEmpty()) text.split("\n") else emptyList()
        if (session.isNew) {
            if (lines.isEmpty()) return insertBlock(lines, 0, block).let { WriteBack.Replaced(it.text, it.range) }
            val anchor = session.original.firstOrNull()
            val line = session.at.first
            val found = when {
                anchor == null -> null
                lines.getOrNull(line) == anchor -> line
                else -> lines.indices.filter { lines[it] == anchor }.minByOrNull { kotlin.math.abs(it - line) }
            } ?: line.coerceAtMost(lines.size - 1)
            val inserted = insertBlock(lines, afterTable(text, minOf(found + 1, lines.size), lines.size), block)
            return WriteBack.Replaced(inserted.text, inserted.range)
        }
        if (edited == session.table) return WriteBack.Unchanged
        val at = locate(text, session)
        if (at != null) {
            val all = text.split("\n")
            val out = all.subList(0, at) + block + all.subList(at + session.original.size, all.size)
            return WriteBack.Replaced(out.joinToString("\n"), Range(at, at + block.size - 1))
        }
        if (lines.isEmpty()) return insertBlock(lines, 0, block).let { WriteBack.Added(it.text, it.range) }
        val place = minOf(session.at.first, lines.size)
        val there = if (place < lines.size) findTable(text, place) else null
        val inserted = insertBlock(lines, there?.let { it.last + 1 } ?: place, block)
        return WriteBack.Added(inserted.text, inserted.range)
    }

    /** `at` (an insertion point between lines), moved past the end of a table it would otherwise split. */
    private fun afterTable(text: String, at: Int, size: Int): Int {
        if (at <= 0 || at >= size) return at
        val table = findTable(text, at - 1) ?: return at
        return if (table.last >= at) table.last + 1 else at
    }

    /** The 0-based line of a UTF-16 offset. */
    fun lineOf(text: String, offset: Int): Int {
        var line = 0
        for (i in 0 until offset.coerceIn(0, text.length)) if (text[i] == '\n') line += 1
        return line
    }

    /** The offset of the end of `line`. */
    fun endOfLine(text: String, line: Int): Int {
        var at = 0
        var l = 0
        while (l < line) {
            val next = text.indexOf('\n', at)
            if (next < 0) return text.length
            at = next + 1
            l += 1
        }
        return text.indexOf('\n', at).let { if (it < 0) text.length else it }
    }
}
