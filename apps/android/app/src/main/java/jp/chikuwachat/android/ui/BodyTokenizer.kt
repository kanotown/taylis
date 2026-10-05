package jp.chikuwachat.android.ui

import jp.chikuwachat.android.api.AttachmentOut
import jp.chikuwachat.android.api.GroupOut
import jp.chikuwachat.android.api.UserPublic
import jp.chikuwachat.android.sync.Store

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
    data object Newline : BodyToken()
}

data class BodyListItem(val level: Int, val tokens: List<BodyToken>)

/** A task of the canvas dialect: `line` is its line in the body (0-based), which a tick changes. */
data class BodyTaskItem(val level: Int, val done: Boolean, val tokens: List<BodyToken>, val line: Int)

sealed class BodyBlock {
    /** `line`: the heading's line in the body (canvas only; the outline and the section editor use it). */
    data class Heading(val level: Int, val tokens: List<BodyToken>, val line: Int? = null) : BodyBlock()
    data class Paragraph(val lines: List<List<BodyToken>>) : BodyBlock()
    data class Quote(val lines: List<List<BodyToken>>) : BodyBlock()
    data class ListBlock(val ordered: Boolean, val start: Int, val items: List<BodyListItem>) : BodyBlock()
    data class CodeBlock(val text: String, val lang: String?) : BodyBlock()
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
private const val INLINE =
    """(\*\*((?:\\.|[^*\n\\])+?)\*\*)|(`([^`\n]+)`)|(\*((?:\\.|[^*\n\\])+)\*)|((?<![\p{L}\p{N}_])_(?![\s\u3000_])((?:\\.|[^\n\\])*?(?:\\.|[^\s\u3000_\\]))_(?![\p{L}\p{N}_]))|(~~((?:\\.|[^~\n\\])+)~~)|(\[([^\]\n]+)\]\((https?://[^\s)]+)\))|(<@group:([0-9a-f-]{36})>)|(<@([0-9a-f-]{36})>)|(<!(channel|here)>)|(https?://[^\s<>]+)|(\\([_*~`]))|([A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,8}|¯\\_\(ツ\)_/¯)"""
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

private val ESCAPED = Regex("""\\([_*~`])""")

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
            group(3) != null -> tokens.add(BodyToken.Code(group(4) ?: ""))
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
        return BodyToken.CodeBlock(lines.drop(1).joinToString("\n").removeSuffix("\n"), first.lowercase())
    }
    return BodyToken.CodeBlock(raw.trim('\n'))
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
            blocks.add(BodyBlock.CodeBlock(lines.subList(i + 1, close).joinToString("\n"), lang.ifEmpty { null }?.lowercase()))
            i = close + 1
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
        val isBullet = BULLET.matches(line)
        if (isBullet || NUMBERED.matches(line)) {
            val ordered = !isBullet
            val items = ArrayList<BodyListItem>()
            val start = if (ordered) NUMBERED.find(line)?.groupValues?.get(2)?.toIntOrNull() ?: 1 else 1
            while (i < lines.size) {
                val m = (if (ordered) NUMBERED else BULLET).find(lines[i]) ?: break
                if (isTask(i)) break
                val indent = m.groupValues[1].replace("\t", "  ").length
                val text = m.groupValues[if (ordered) 3 else 2]
                items.add(BodyListItem(if (indent >= 2) 1 else 0, tokenizeInline(text)))
                i++
            }
            blocks.add(BodyBlock.ListBlock(ordered, start, items))
            continue
        }
        val paragraph = ArrayList<List<BodyToken>>()
        while (i < lines.size) {
            val current = lines[i]
            if (paragraph.isNotEmpty() && (opensFence(i) || opensTable(i) || HEADING.matches(current) || QUOTE.matches(current) || BULLET.matches(current) || NUMBERED.matches(current) || isImage(i) || isRule(i))) break
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
        every("image/") -> if (count == 1) "画像を送信しました" else "画像を $count 枚送信しました"
        every("video/") -> if (count == 1) "動画を送信しました" else "動画を $count 本送信しました"
        else -> if (count == 1) "ファイルを送信しました" else "ファイルを $count 件送信しました"
    }
}

/** A message's one line: its plain text (names for mentions), else what its attachments are ([attachmentSummary]). */
fun messageLine(body: String, attachments: List<AttachmentOut>, store: Store, maxLength: Int = 200): String =
    messageLine(body, attachments.map { it.contentType }, store.users, store.groups, maxLength)

/** The same line from its parts (the DM list's preview, which the Store builds itself, M49). */
fun messageLine(body: String, contentTypes: List<String>, users: Map<String, UserPublic>, groups: Map<String, GroupOut>, maxLength: Int = 200): String =
    plainText(Mentions.toNames(body, users, groups), maxLength).ifEmpty { attachmentSummary(contentTypes) }
