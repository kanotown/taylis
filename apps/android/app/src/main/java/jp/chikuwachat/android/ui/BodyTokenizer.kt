package jp.chikuwachat.android.ui

/** Message body format (DATA_MODEL.md "本文の形式"): plain text plus a light markdown subset shared with the other clients. */
sealed class BodyToken {
    data class Text(val text: String) : BodyToken()
    data class Bold(val text: String) : BodyToken()
    data class Italic(val text: String) : BodyToken()
    data class Strike(val text: String) : BodyToken()
    data class Code(val text: String) : BodyToken()
    data class CodeBlock(val text: String, val lang: String? = null) : BodyToken()
    data class Link(val url: String, val label: String? = null) : BodyToken()
    data class Mention(val userId: String) : BodyToken()
    data class MentionAll(val target: String) : BodyToken()
    data object Newline : BodyToken()
}

data class BodyListItem(val level: Int, val tokens: List<BodyToken>)

sealed class BodyBlock {
    data class Heading(val level: Int, val tokens: List<BodyToken>) : BodyBlock()
    data class Paragraph(val lines: List<List<BodyToken>>) : BodyBlock()
    data class Quote(val lines: List<List<BodyToken>>) : BodyBlock()
    data class ListBlock(val ordered: Boolean, val start: Int, val items: List<BodyListItem>) : BodyBlock()
    data class CodeBlock(val text: String, val lang: String?) : BodyBlock()
}

private const val INLINE =
    """(\*\*([^*\n]+?)\*\*)|(`([^`\n]+)`)|(\*([^*\n]+)\*)|(_([^_\n]+)_)|(~~([^~\n]+)~~)|(\[([^\]\n]+)\]\((https?://[^\s)]+)\))|(<@([0-9a-f-]{36})>)|(<!(channel|here)>)|(https?://[^\s<>]+)"""
private val INLINE_PATTERN = Regex(INLINE)
private val FULL_PATTERN = Regex("""(```([\s\S]*?)```)|$INLINE|(\n)""")
private val FENCE_OPEN = Regex("""^```([A-Za-z0-9_+#.-]{0,20})\s*$""")
private val FENCE_CLOSE = Regex("""^```\s*$""")
private val BULLET = Regex("""^(\s*)[-*•]\s+(.*)$""")
private val NUMBERED = Regex("""^(\s*)(\d{1,3})\.\s+(.*)$""")
private val QUOTE = Regex("""^>\s?(.*)$""")
private val HEADING = Regex("""^(#{1,3})\s+(\S.*)$""")

/** Whole-body tokens (inline markup, fenced code and newlines); kept for older callers and tests. */
fun tokenizeBody(body: String): List<BodyToken> = scan(body, FULL_PATTERN, withBlocks = true)

/** Inline tokens of a single line. */
fun tokenizeInline(line: String): List<BodyToken> = scan(line, INLINE_PATTERN, withBlocks = false)

private fun scan(body: String, pattern: Regex, withBlocks: Boolean): List<BodyToken> {
    val tokens = ArrayList<BodyToken>()
    var last = 0
    for (match in pattern.findAll(body)) {
        if (match.range.first > last) tokens.add(BodyToken.Text(body.substring(last, match.range.first)))
        val g = match.groups
        fun group(index: Int): String? = g[if (withBlocks) index + 2 else index]?.value
        tokens.add(
            when {
                withBlocks && g[1] != null -> splitFence(g[2]?.value ?: "")
                group(1) != null -> BodyToken.Bold(group(2) ?: "")
                group(3) != null -> BodyToken.Code(group(4) ?: "")
                group(5) != null -> BodyToken.Bold(group(6) ?: "")
                group(7) != null -> BodyToken.Italic(group(8) ?: "")
                group(9) != null -> BodyToken.Strike(group(10) ?: "")
                group(11) != null -> BodyToken.Link(group(13) ?: "", label = group(12))
                group(14) != null -> BodyToken.Mention(group(15) ?: "")
                group(16) != null -> BodyToken.MentionAll(group(17) ?: "")
                group(18) != null -> BodyToken.Link(group(18) ?: "")
                else -> BodyToken.Newline
            },
        )
        last = match.range.last + 1
    }
    if (last < body.length) tokens.add(BodyToken.Text(body.substring(last)))
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

/** Block structure for rendering: paragraphs, quotes, lists and fenced code, in order. */
fun parseBlocks(body: String): List<BodyBlock> {
    val lines = body.replace("\r\n", "\n").replace('\r', '\n').split("\n")
    fun fenceCloseAfter(index: Int): Int = (index + 1 until lines.size).firstOrNull { FENCE_CLOSE.matches(lines[it]) } ?: -1
    fun opensFence(index: Int) = FENCE_OPEN.matches(lines[index]) && fenceCloseAfter(index) != -1
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
            blocks.add(BodyBlock.Heading(h.groupValues[1].length, tokenizeInline(h.groupValues[2])))
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
        val isBullet = BULLET.matches(line)
        if (isBullet || NUMBERED.matches(line)) {
            val ordered = !isBullet
            val items = ArrayList<BodyListItem>()
            val start = if (ordered) NUMBERED.find(line)?.groupValues?.get(2)?.toIntOrNull() ?: 1 else 1
            while (i < lines.size) {
                val m = (if (ordered) NUMBERED else BULLET).find(lines[i]) ?: break
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
            if (paragraph.isNotEmpty() && (opensFence(i) || HEADING.matches(current) || QUOTE.matches(current) || BULLET.matches(current) || NUMBERED.matches(current))) break
            paragraph.add(tokenizeInline(current))
            i++
        }
        blocks.add(BodyBlock.Paragraph(paragraph))
    }
    return blocks
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

/** One-line plain text for notifications and previews: markers removed, newlines collapsed. */
fun plainText(body: String, maxLength: Int = 200): String {
    val text = body
        .replace(Regex("""(?m)^```[A-Za-z0-9_+#.-]*\s*$"""), "")
        .replace(Regex("""(?m)^#{1,3}\s+"""), "")
        .replace(Regex("""(?m)^>\s?"""), "")
        .replace(Regex("""(?m)^\s*(?:[-*•]|\d{1,3}\.)\s+"""), "")
        .replace(Regex("""\*\*([^*\n]+?)\*\*"""), "$1")
        .replace(Regex("""\*([^*\n]+)\*"""), "$1")
        .replace(Regex("""_([^_\n]+)_"""), "$1")
        .replace(Regex("""~~([^~\n]+)~~"""), "$1")
        .replace(Regex("""`([^`\n]+)`"""), "$1")
        .replace(Regex("""\[([^\]\n]+)\]\((https?://[^\s)]+)\)"""), "$1")
        .replace(Regex("""\s*\n+\s*"""), " ")
        .trim()
    return if (text.length > maxLength) text.take(maxLength - 1) + "…" else text
}
