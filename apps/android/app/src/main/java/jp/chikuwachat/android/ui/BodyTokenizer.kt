package jp.chikuwachat.android.ui

import jp.chikuwachat.android.api.AttachmentOut
import jp.chikuwachat.android.api.GroupOut
import jp.chikuwachat.android.api.UserPublic
import jp.chikuwachat.android.sync.Store
import jp.chikuwachat.android.R
import jp.chikuwachat.android.L10n

/**
 * Message body format (DATA_MODEL.md "本文の形式"): plain text plus a light markdown subset shared with the other clients.
 *
 * The canvas dialect (CANVAS.md §4.2, `parseBlocks(body, canvas = true)`, M46) adds tasks ("- [ ] item" / "- [x] item",
 * "*" too, two leading spaces nest), images of the canvas ("![alt](attachment:<uuid>)" on a line of its own; other image
 * URLs stay text) and rules ("---" between blank lines). Messages keep showing all of these as text.
 * apps/shared/canvas_markdown.json holds the cases the three clients share (CanvasMarkdownTest). M83: the hidden task
 * markers (` <!--task:<id>-->`, CanvasMarkers.kt) are left out in the canvas dialect.
 */
sealed class BodyToken {
    data class Text(val text: String) : BodyToken()
    data class Bold(val text: String) : BodyToken()
    data class Italic(val text: String) : BodyToken()
    data class Strike(val text: String) : BodyToken()
    data class Code(val text: String) : BodyToken()
    data class CodeBlock(val text: String, val lang: String? = null) : BodyToken()
    data class Link(val url: String, val label: String? = null) : BodyToken()
    data class Mention(val userId: String) : BodyToken()
    data class MentionGroup(val groupId: String) : BodyToken()
    data class MentionAll(val target: String) : BodyToken()
    /** TeX math (apps/shared/math.json): the formula as written; [display] for `$$…$$` within a line. */
    data class Math(val tex: String, val display: Boolean = false) : BodyToken()
    data object Newline : BodyToken()
}

/** One list item (apps/shared/lists.json): its level (0–2), its kind, its number (0 for a bullet) and the marker drawn. */
data class BodyListItem(
    val level: Int,
    val tokens: List<BodyToken>,
    val ordered: Boolean = false,
    val number: Int = 0,
    val marker: String = "•",
)

/** A task of the canvas dialect: `line` is its line in the body (0-based), which a tick changes. */
data class BodyTaskItem(val level: Int, val done: Boolean, val tokens: List<BodyToken>, val line: Int)

sealed class BodyBlock {
    /** `line`: the heading's line in the body (canvas only; the outline and the section editor use it). */
    data class Heading(val level: Int, val tokens: List<BodyToken>, val line: Int? = null) : BodyBlock()
    data class Paragraph(val lines: List<List<BodyToken>>) : BodyBlock()
    data class Quote(val lines: List<List<BodyToken>>) : BodyBlock()
    data class ListBlock(val ordered: Boolean, val start: Int, val items: List<BodyListItem>) : BodyBlock()
    data class CodeBlock(val text: String, val lang: String?) : BodyBlock()
    /** Display math: `$$…$$` on a line (or lines) of its own (apps/shared/math.json). */
    data class Math(val tex: String) : BodyBlock()
    /** M15g: a GFM table; rows have exactly as many cells as the header. */
    data class Table(val align: List<TableAlign>, val header: List<List<BodyToken>>, val rows: List<List<List<BodyToken>>>) : BodyBlock()
    // The canvas dialect (CANVAS.md §4.2).
    data class Tasks(val items: List<BodyTaskItem>) : BodyBlock()
    data class Image(val alt: String, val attachmentId: String, val line: Int) : BodyBlock()
    data object Rule : BodyBlock()
}

/** A task line, as the server counts it (server/app/modules/canvases/service.py TASK_LINE). */
val TASK_LINE = Regex("""^([ \t]*)[-*] \[([ xX])\](?: (.*))?$""")
private val IMAGE_LINE = Regex("""^!\[([^\]\n]*)\]\(attachment:([0-9a-f-]{36})\)\s*$""")
private val RULE_LINE = Regex("""^-{3,}\s*$""")

// M107 (apps/shared/inline-format.json): `_` emphasis follows CommonMark's word rule: the opening `_` is not preceded and the
// closing one not followed by a letter, digit or `_`, so snake_case and e-mail addresses stay as they are. `\_` `\*` `\~`
// `\`` are the literal character (also inside emphasis). E-mail addresses (and the shrug, which keeps its backslash) are
// text tokens of their own, so emphasis and escapes are never read inside them.
// The math alternatives are written as unrolled loops (`[^$\n\\]*(?:\\.[^$\n\\]*)*`): java.util.regex recurses once per
// repetition of a group with alternatives, so `(?:\\.|[^$\n\\])*?` overflowed the stack on a formula of MATH_MAX_LENGTH+ chars.
private const val INLINE =
    // i18n: keep (inline-format pattern)
    """(\*\*((?:\\.|[^*\n\\])+?)\*\*)|(``(?!`)(?:[^`\n]|`(?!`))+?``(?!`)|`([^`\n]+)`)|(\*((?:\\.|[^*\n\\])+)\*)|((?<![\p{L}\p{N}_])_(?![\s\u3000_])((?:\\.|[^\n\\])*?(?:\\.|[^\s\u3000_\\]))_(?![\p{L}\p{N}_]))|(~~((?:\\.|[^~\n\\])+)~~)|(\[([^\]\n]+)\]\((https?://[^\s)]+)\))|(<@group:([0-9a-f-]{36})>)|(<@([0-9a-f-]{36})>)|(<!(channel|here)>)|(https?://[^\s<>]+)|(\\([_*~`$]))|([A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,8}|¯\\_\(ツ\)_/¯)|(\$\$((?=[^$\n])[^$\n\\]*(?:\\.[^$\n\\]*)*)\$\$)|(\$(?![\s$])([^$\n\\]*(?:\\.[^$\n\\]*)*(?:(?<!\s)|(?<=\\\s)))\$(?![0-9A-Za-z]))"""
private val INLINE_PATTERN = Regex(INLINE)
private val FULL_PATTERN = Regex("""(```([\s\S]*?)```)|$INLINE|(\n)""")
private val FENCE_OPEN = Regex("""^```([A-Za-z0-9_+#.-]{0,20})\s*$""")
private val FENCE_CLOSE = Regex("""^```\s*$""")
private val BULLET = Regex("""^(\s*)[-*•]\s+(.*)$""")
private val NUMBERED = Regex("""^(\s*)(\d{1,3})\.\s+(.*)$""")
private val QUOTE = Regex("""^>\s?(.*)$""")
private val HEADING = Regex("""^(#{1,3})\s+(\S.*)$""")
private val TABLE_SEPARATOR = Regex("""^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$""")

/** M15g: a column's alignment from its separator cell (":--" left, ":-:" center, "--:" right). */
enum class TableAlign { NONE, LEFT, CENTER, RIGHT }

/** M15g: the cells of a table row; "\|" is a literal pipe, outer pipes are optional. */
fun splitTableRow(line: String): List<String> {
    var text = line.trim()
    if (text.startsWith("|")) text = text.drop(1)
    if (text.endsWith("|") && !text.endsWith("\\|")) text = text.dropLast(1)
    val cells = ArrayList<String>()
    val current = StringBuilder()
    var i = 0
    while (i < text.length) {
        val ch = text[i]
        if (ch == '\\' && i + 1 < text.length && text[i + 1] == '|') {
            current.append('|')
            i += 2
            continue
        }
        if (ch == '|') {
            cells.add(current.toString().trim())
            current.clear()
        } else {
            current.append(ch)
        }
        i++
    }
    cells.add(current.toString().trim())
    return cells
}

private fun tableAlign(cell: String): TableAlign {
    val left = cell.startsWith(":")
    val right = cell.endsWith(":")
    return when {
        left && right -> TableAlign.CENTER
        right -> TableAlign.RIGHT
        left -> TableAlign.LEFT
        else -> TableAlign.NONE
    }
}

/** Whole-body tokens (inline markup, fenced code and newlines); kept for older callers and tests. */
fun tokenizeBody(body: String): List<BodyToken> = scan(body, FULL_PATTERN, withBlocks = true)

/** Inline tokens of a single line. */
fun tokenizeInline(line: String): List<BodyToken> = scan(line, INLINE_PATTERN, withBlocks = false)

private val ESCAPED = Regex("""\\([_*~`$])""")

/**
 * TeX math (apps/shared/math.json, markdown.ts MATH_MAX_LENGTH): inline `$…$` as Pandoc reads it (the opening `$` before a
 * non-space, the closing one after a non-space and not before a digit or an ASCII letter), `$$…$$` within a line, and
 * display blocks ([mathBlock]). A formula longer than this stays text.
 */
const val MATH_MAX_LENGTH = 2000

/**
 * Display math starting at `lines[index]` (markdown.ts mathBlockAt): its formula and its last line. `$$` starts the line
 * (spaces around are ignored) and a later line ends with `$$`, no blank line and no other `$$` between; one line
 * `$$tex$$` is a block too.
 */
fun mathBlock(lines: List<String>, index: Int): Pair<String, Int>? {
    val first = lines[index].trim()
    if (!first.startsWith("$$")) return null
    fun done(tex: String, end: Int): Pair<String, Int>? {
        val trimmed = tex.trim()
        return if (trimmed.isEmpty() || trimmed.length > MATH_MAX_LENGTH) null else trimmed to end
    }
    if (first.length >= 4 && first.endsWith("$$")) {
        val tex = first.substring(2, first.length - 2)
        return if ("$$" in tex) null else done(tex, index)
    }
    val head = first.substring(2)
    if ("$$" in head) return null
    for (k in index + 1 until lines.size) {
        val trimmed = lines[k].trim()
        if (trimmed.isEmpty()) return null // a blank line ends the search: the $$ was not math
        if ("$$" !in trimmed) continue
        val tail = trimmed.dropLast(2)
        if (!trimmed.endsWith("$$") || "$$" in tail) return null
        return done((listOf(head) + lines.subList(index + 1, k) + listOf(tail)).joinToString("\n"), k)
    }
    return null
}

private fun scan(body: String, pattern: Regex, withBlocks: Boolean): List<BodyToken> {
    val tokens = ArrayList<BodyToken>()
    fun text(value: String) {
        if (value.isEmpty()) return
        val previous = tokens.lastOrNull()
        if (previous is BodyToken.Text) tokens[tokens.size - 1] = BodyToken.Text(previous.text + value) else tokens.add(BodyToken.Text(value))
    }
    fun unescape(value: String) = ESCAPED.replace(value, "$1")
    var last = 0
    for (match in pattern.findAll(body)) {
        text(body.substring(last, match.range.first))
        val g = match.groups
        fun group(index: Int): String? = g[if (withBlocks) index + 2 else index]?.value
        when {
            withBlocks && g[1] != null -> tokens.add(splitFence(g[2]?.value ?: ""))
            group(1) != null -> tokens.add(BodyToken.Bold(unescape(group(2) ?: "")))
            group(3) != null -> tokens.add(BodyToken.Code(codeSpan(group(3)!!, group(4))))
            group(5) != null -> tokens.add(BodyToken.Bold(unescape(group(6) ?: "")))
            group(7) != null -> tokens.add(BodyToken.Italic(unescape(group(8) ?: "")))
            group(9) != null -> tokens.add(BodyToken.Strike(unescape(group(10) ?: "")))
            group(11) != null -> tokens.add(BodyToken.Link(group(13) ?: "", label = group(12)))
            group(14) != null -> tokens.add(BodyToken.MentionGroup(group(15) ?: ""))
            group(16) != null -> tokens.add(BodyToken.Mention(group(17) ?: ""))
            group(18) != null -> tokens.add(BodyToken.MentionAll(group(19) ?: ""))
            group(20) != null -> tokens.add(BodyToken.Link(group(20) ?: ""))
            group(21) != null -> text(group(22) ?: "")
            group(23) != null -> text(group(23) ?: "")
            group(24) != null || group(26) != null -> {
                // TeX math: too long or blank, it stays the text it was.
                val display = group(24) != null
                val tex = (if (display) group(25) else group(27)) ?: ""
                if (tex.length > MATH_MAX_LENGTH || tex.isBlank()) text(match.value) else tokens.add(BodyToken.Math(tex, display))
            }
            else -> tokens.add(BodyToken.Newline)
        }
        last = match.range.last + 1
    }
    text(body.substring(last))
    return tokens
}

private fun splitFence(raw: String): BodyToken.CodeBlock {
    val lines = raw.split("\n")
    val first = lines.first()
    if (lines.size > 1 && first.isNotEmpty() && Regex("""^[A-Za-z0-9_+#.-]{1,20}$""").matches(first)) {
        return BodyToken.CodeBlock(straightQuotes(lines.drop(1).joinToString("\n").removeSuffix("\n")), first.lowercase())
    }
    return BodyToken.CodeBlock(straightQuotes(raw.trim('\n')))
}

/**
 * The text of an inline code span (apps/shared/inline-format.json, markdown.ts codeSpan): [single] is the text between
 * single backticks; otherwise [whole] is a ``double`` span, which may hold a backtick and loses one space at each end
 * when it has one at both ("`` ` ``" is a backtick).
 */
fun codeSpan(whole: String, single: String?): String {
    if (single != null) return straightQuotes(single)
    var inner = whole.substring(2, whole.length - 2)
    if (inner.length >= 2 && inner.startsWith(" ") && inner.endsWith(" ") && inner.isNotBlank()) inner = inner.substring(1, inner.length - 1)
    return straightQuotes(inner)
}

/**
 * Code shows the quotes a keyboard curled back straight (2026-10-06): iOS's smart punctuation and the Japanese keyboards
 * turn ' and " into ‘ ’ “ ”, so `it's` arrived as `it’s`.
 */
fun straightQuotes(text: String): String =
    if (text.none { it == '‘' || it == '’' || it == '“' || it == '”' }) text
    else text.replace('‘', '\'').replace('’', '\'').replace('“', '"').replace('”', '"')

/**
 * The composer's text before it is sent or saved (2026-10-06, apps/shared/composer-code-punctuation.json): Japanese
 * keyboards type ’ ” for ' " (and iOS's smart punctuation also — for --, – for -). Inside code — inline spans and
 * fenced blocks, found as [parseBlocks] and the inline pattern find them — those go back to what was typed; the rest of
 * the text stays as it is. An unclosed backtick or fence is not code. (ー, which a Japanese keyboard types for -, is a
 * letter and stays.)
 */
fun straightenCode(body: String): String {
    if (body.none { it in "‘’“”—–" }) return body
    val lines = body.split("\n")
    val out = mutableListOf<String>()
    var i = 0
    while (i < lines.size) {
        if (FENCE_OPEN.matches(lines[i])) {
            val close = (i + 1 until lines.size).firstOrNull { FENCE_CLOSE.matches(lines[it]) }
            if (close != null) {
                out.add(lines[i])
                lines.subList(i + 1, close).mapTo(out, ::straightPunctuation)
                out.add(lines[close])
                i = close + 1
                continue
            }
        }
        val line = lines[i]
        val sb = StringBuilder(line)
        for (match in INLINE_PATTERN.findAll(line).toList().asReversed()) {
            val code = match.groups[3] ?: continue
            sb.replace(code.range.first, code.range.last + 1, straightPunctuation(code.value))
        }
        out.add(sb.toString())
        i++
    }
    return out.joinToString("\n")
}

/** ‘ ’ “ ” — – as typed before a keyboard changed them: ' " -- -. */
fun straightPunctuation(text: String): String = buildString {
    for (ch in text) when (ch) {
        '‘', '’' -> append('\'')
        '“', '”' -> append('"')
        '—' -> append("--")
        '–' -> append('-')
        else -> append(ch)
    }
}

/** A list line: its indent (a tab is 4 columns), its kind, the number written ("3." → 3) and its text. */
class ListLine(val indent: Int, val ordered: Boolean, val written: Int, val text: String)

fun listLine(line: String): ListLine? {
    fun width(indent: String) = indent.replace("\t", "    ").length
    NUMBERED.matchEntire(line)?.let { m -> return ListLine(width(m.groupValues[1]), true, m.groupValues[2].toIntOrNull() ?: 1, m.groupValues[3]) }
    BULLET.matchEntire(line)?.let { m -> return ListLine(width(m.groupValues[1]), false, 0, m.groupValues[2]) }
    return null
}

private const val LIST_LEVELS = 3

/**
 * Levels, numbers and markers of consecutive list lines (apps/shared/lists.json, as markdown.ts listItems): an item
 * indented 2 or more columns past the one before nests one level deeper (2–4 spaces or a tab, three levels at most); a
 * smaller indent goes back to the level it matches. Each run of items of one kind at one level under one parent is a
 * list of its own: it starts at the number its first item is written with and counts on by one; a nested list starts
 * again under every parent item. Numbers are 1. / a. / i. by level, bullets • / ◦ / ▪.
 */
fun listItems(rows: List<ListLine>): List<BodyListItem> {
    val indents = ArrayList<Int>()
    val counters = ArrayList<Pair<Boolean, Int>?>() // (ordered, next number) by level
    return rows.map { row ->
        if (indents.isEmpty()) indents.add(row.indent)
        else {
            while (indents.size > 1 && row.indent < indents.last()) indents.removeAt(indents.size - 1)
            if (row.indent >= indents.last() + 2 && indents.size < LIST_LEVELS) indents.add(row.indent)
        }
        val level = indents.size - 1
        while (counters.size > level + 1) counters.removeAt(counters.size - 1) // the lists deeper than this item end here
        while (counters.size < level + 1) counters.add(null)
        val counter = counters[level]
        val number = if (!row.ordered) 0 else if (counter != null && counter.first) counter.second else row.written
        counters[level] = row.ordered to number + 1
        BodyListItem(level, tokenizeInline(row.text), row.ordered, number, listMarker(row.ordered, level, number))
    }
}

/** "1." / "a." / "i." by level (a number below 1 stays decimal), "•" / "◦" / "▪" for bullets. */
fun listMarker(ordered: Boolean, level: Int, number: Int): String {
    if (!ordered) return listOf("•", "◦", "▪")[minOf(level, 2)]
    if (level == 1 && number >= 1) {
        val out = StringBuilder()
        var k = number
        while (k > 0) {
            out.insert(0, ('a' + (k - 1) % 26))
            k = (k - 1) / 26
        }
        return "$out."
    }
    if (level >= 2 && number in 1..3999) {
        val table = listOf(1000 to "m", 900 to "cm", 500 to "d", 400 to "cd", 100 to "c", 90 to "xc", 50 to "l", 40 to "xl", 10 to "x", 9 to "ix", 5 to "v", 4 to "iv", 1 to "i")
        val out = StringBuilder()
        var k = number
        for ((value, letters) in table) while (k >= value) { out.append(letters); k -= value }
        return "$out."
    }
    return "$number."
}

/** Block structure for rendering: paragraphs, quotes, lists and fenced code, in order; `canvas`: the canvas dialect too. */
fun parseBlocks(body: String, canvas: Boolean = false): List<BodyBlock> {
    // M83 (CANVAS.md §22): a canvas's hidden task markers are never shown (each line keeps its place).
    val lines = body.replace("\r\n", "\n").replace('\r', '\n').split("\n").let { all -> if (canvas) all.map(CanvasMarkers::strip) else all }
    fun blank(index: Int) = index < 0 || index >= lines.size || lines[index].isBlank()
    fun isTask(index: Int) = canvas && TASK_LINE.matches(lines[index])
    fun isImage(index: Int) = canvas && IMAGE_LINE.matches(lines[index])
    fun isRule(index: Int) = canvas && RULE_LINE.matches(lines[index]) && blank(index - 1) && blank(index + 1)
    fun fenceCloseAfter(index: Int): Int = (index + 1 until lines.size).firstOrNull { FENCE_CLOSE.matches(lines[it]) } ?: -1
    fun opensFence(index: Int) = FENCE_OPEN.matches(lines[index]) && fenceCloseAfter(index) != -1
    // M15g: a header row with a pipe, directly followed by a separator with as many cells.
    fun opensTable(index: Int) = index + 1 < lines.size && '|' in lines[index] && TABLE_SEPARATOR.matches(lines[index + 1]) &&
        splitTableRow(lines[index]).size == splitTableRow(lines[index + 1]).size
    val blocks = ArrayList<BodyBlock>()
    var i = 0
    while (i < lines.size) {
        val line = lines[i]
        if (opensFence(i)) {
            val lang = FENCE_OPEN.find(line)?.groupValues?.get(1).orEmpty()
            val close = fenceCloseAfter(i)
            blocks.add(BodyBlock.CodeBlock(straightQuotes(lines.subList(i + 1, close).joinToString("\n")), lang.ifEmpty { null }?.lowercase()))
            i = close + 1
            continue
        }
        val math = mathBlock(lines, i)
        if (math != null) {
            blocks.add(BodyBlock.Math(math.first))
            i = math.second + 1
            continue
        }
        HEADING.find(line)?.let { h ->
            blocks.add(BodyBlock.Heading(h.groupValues[1].length, tokenizeInline(h.groupValues[2]), if (canvas) i else null))
            i++
            continue
        }
        if (isTask(i)) {
            val items = ArrayList<BodyTaskItem>()
            while (i < lines.size && isTask(i)) {
                val m = TASK_LINE.find(lines[i])!!
                val indent = m.groupValues[1].replace("\t", "  ").length
                items.add(BodyTaskItem(if (indent >= 2) 1 else 0, m.groupValues[2] != " ", tokenizeInline(m.groupValues[3]), i))
                i++
            }
            blocks.add(BodyBlock.Tasks(items))
            continue
        }
        if (isImage(i)) {
            val m = IMAGE_LINE.find(line)!!
            blocks.add(BodyBlock.Image(m.groupValues[1], m.groupValues[2], i))
            i++
            continue
        }
        if (isRule(i)) {
            blocks.add(BodyBlock.Rule)
            i++
            continue
        }
        if (QUOTE.matches(line)) {
            val quoted = ArrayList<List<BodyToken>>()
            while (i < lines.size) {
                val q = QUOTE.find(lines[i]) ?: break
                quoted.add(tokenizeInline(q.groupValues[1]))
                i++
            }
            blocks.add(BodyBlock.Quote(quoted))
            continue
        }
        if (opensTable(i)) {
            val header = splitTableRow(line)
            val align = splitTableRow(lines[i + 1]).map(::tableAlign)
            val rows = ArrayList<List<List<BodyToken>>>()
            i += 2
            while (i < lines.size && '|' in lines[i] && lines[i].isNotBlank()) {
                val cells = splitTableRow(lines[i])
                rows.add(header.indices.map { tokenizeInline(cells.getOrElse(it) { "" }) }) // short rows pad, long rows are cut (GFM)
                i++
            }
            blocks.add(BodyBlock.Table(align, header.map(::tokenizeInline), rows))
            continue
        }
        if (listLine(line) != null) {
            val rows = ArrayList<ListLine>()
            while (i < lines.size && !isTask(i)) {
                rows.add(listLine(lines[i]) ?: break)
                i++
            }
            // A top-level item of the other kind starts a new list (as in CommonMark).
            val items = listItems(rows)
            var from = 0
            for (k in 1..items.size) {
                if (k < items.size && !(items[k].level == 0 && items[k].ordered != items[from].ordered)) continue
                val run = items.subList(from, k).toList()
                blocks.add(BodyBlock.ListBlock(run[0].ordered, if (run[0].ordered) run[0].number else 1, run))
                from = k
            }
            continue
        }
        val paragraph = ArrayList<List<BodyToken>>()
        while (i < lines.size) {
            val current = lines[i]
            if (paragraph.isNotEmpty() && (opensFence(i) || opensTable(i) || HEADING.matches(current) || QUOTE.matches(current) || BULLET.matches(current) || NUMBERED.matches(current) || isImage(i) || isRule(i) || mathBlock(lines, i) != null)) break
            paragraph.add(tokenizeInline(current))
            i++
        }
        blocks.add(BodyBlock.Paragraph(paragraph))
    }
    return blocks
}

/**
 * How a paragraph block is drawn (apps/shared/body-paragraphs.json, the same in the three clients): [gapBefore] /
 * [gapAfter] = blank lines at its start / end (a gap toward the block before / after); [groups] = the runs of lines
 * between blank lines, empty when the paragraph is only blank lines (then it is one gap).
 */
data class ParagraphLayout(val gapBefore: Boolean, val gapAfter: Boolean, val groups: List<List<List<BodyToken>>>)

/**
 * 2026-10-05: one newline is a line break; one or more blank lines are a paragraph gap (about 0.4 of a line) rather
 * than empty lines, several blank lines collapsing into one gap (as in Slack and markdown). A line of spaces is blank.
 */
fun paragraphLayout(lines: List<List<BodyToken>>): ParagraphLayout {
    fun blank(tokens: List<BodyToken>) = tokens.all { it is BodyToken.Text && it.text.isBlank() }
    val groups = mutableListOf<List<List<BodyToken>>>()
    var current = mutableListOf<List<BodyToken>>()
    for (row in lines) {
        if (blank(row)) {
            if (current.isNotEmpty()) groups.add(current)
            current = mutableListOf()
        } else current.add(row)
    }
    if (current.isNotEmpty()) groups.add(current)
    if (groups.isEmpty()) return ParagraphLayout(gapBefore = false, gapAfter = false, groups = emptyList())
    return ParagraphLayout(gapBefore = blank(lines.first()), gapAfter = blank(lines.last()), groups = groups)
}

/** What a reader sees of inline tokens as text: a link shows its label, emphasis markers are gone (tests, the outline). */
fun visibleText(tokens: List<BodyToken>): String = buildString {
    for (token in tokens) {
        when (token) {
            is BodyToken.Text -> append(token.text)
            is BodyToken.Bold -> append(token.text)
            is BodyToken.Italic -> append(token.text)
            is BodyToken.Strike -> append(token.text)
            is BodyToken.Code -> append(token.text)
            is BodyToken.CodeBlock -> append(token.text)
            is BodyToken.Link -> append(token.label ?: token.url)
            is BodyToken.Mention -> append("@")
            is BodyToken.MentionGroup -> append("@")
            is BodyToken.MentionAll -> append("@" + token.target)
            is BodyToken.Math -> append(if (token.display) "$$" + token.tex + "$$" else "$" + token.tex + "$")
            BodyToken.Newline -> append("\n")
        }
    }
}

/** Lines for rendering by older callers: code blocks stand alone, newlines split. */
fun splitIntoLines(tokens: List<BodyToken>): List<List<BodyToken>> {
    val lines = ArrayList<MutableList<BodyToken>>().apply { add(ArrayList()) }
    for (token in tokens) {
        when (token) {
            BodyToken.Newline -> lines.add(ArrayList())
            is BodyToken.CodeBlock -> { lines.add(mutableListOf(token)); lines.add(ArrayList()) }
            else -> lines.last().add(token)
        }
    }
    return lines.filter { it.isNotEmpty() }
}

/** What a reader sees of an inline token as text; mention tokens stay as they are (callers name them first). */
private fun inlineText(token: BodyToken): String = when (token) {
    is BodyToken.Text -> token.text
    is BodyToken.Bold -> token.text
    is BodyToken.Italic -> token.text
    is BodyToken.Strike -> token.text
    is BodyToken.Code -> token.text
    is BodyToken.CodeBlock -> token.text
    is BodyToken.Link -> token.label ?: token.url
    is BodyToken.Mention -> "<@${token.userId}>"
    is BodyToken.MentionGroup -> "<@group:${token.groupId}>"
    is BodyToken.MentionAll -> "<!${token.target}>"
    is BodyToken.Math -> if (token.display) "$$" + token.tex + "$$" else "$" + token.tex + "$" // the source as written
    BodyToken.Newline -> "\n"
}

/** One-line plain text for notifications and previews: markers removed, newlines collapsed. */
fun plainText(body: String, maxLength: Int = 200): String {
    val text = body
        .replace(Regex("""(?m)^```[A-Za-z0-9_+#.-]*\s*$"""), "")
        .replace(Regex("""(?m)^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$"""), "") // M15g: table separators
        .replace(Regex("""(?m)^[ \t]*\|(.*)\|[ \t]*$""")) { match -> splitTableRow(match.value).joinToString(" ") }
        .replace(Regex("""(?m)^#{1,3}\s+"""), "")
        .replace(Regex("""(?m)^>\s?"""), "")
        .replace(Regex("""(?m)^\s*(?:[-*•]|\d{1,3}\.)\s+"""), "")
        // M107: the inline markers are those the tokenizer reads (apps/shared/inline-format.json), not patterns of their own.
        .split("\n")
        .joinToString("\n") { line -> tokenizeInline(line).joinToString("") { inlineText(it) } }
        .replace(Regex("""\s*\n+\s*"""), " ")
        .trim()
    return if (text.length > maxLength) text.take(maxLength - 1) + "…" else text
}

/**
 * What a message with no text but attachments says in one line (the notification, the thread's parent, the activity
 * feed): every attachment an image 「画像を送信しました」 / 「画像を n 枚送信しました」, every one a video 「動画を送信しました」 /
 * 「動画を n 本送信しました」, otherwise 「ファイルを送信しました」 / 「ファイルを n 件送信しました」, from each content_type (the
 * same rule on desktop, iOS and the server). "" with no attachments.
 */
fun attachmentSummary(contentTypes: List<String>): String {
    val count = contentTypes.size
    if (count == 0) return ""
    fun every(prefix: String) = contentTypes.all { it.trim().lowercase().startsWith(prefix) }
    return when {
        every("image/") -> if (count == 1) L10n.str(R.string.body_tokenizer_sent_an_image) else L10n.str(R.string.body_tokenizer_sent_images, count)
        every("video/") -> if (count == 1) L10n.str(R.string.body_tokenizer_sent_a_video) else L10n.str(R.string.body_tokenizer_sent_videos, count)
        else -> if (count == 1) L10n.str(R.string.body_tokenizer_sent_a_file) else L10n.str(R.string.body_tokenizer_sent_files, count)
    }
}

/** A message's one line: its plain text (names for mentions), else what its attachments are ([attachmentSummary]). */
fun messageLine(body: String, attachments: List<AttachmentOut>, store: Store, maxLength: Int = 200): String =
    messageLine(body, attachments.map { it.contentType }, store.users, store.groups, maxLength)

/** The same line from its parts (the DM list's preview, which the Store builds itself, M49). */
fun messageLine(body: String, contentTypes: List<String>, users: Map<String, UserPublic>, groups: Map<String, GroupOut>, maxLength: Int = 200): String =
    plainText(Mentions.toNames(body, users, groups), maxLength).ifEmpty { attachmentSummary(contentTypes) }
