package jp.chikuwachat.android.ui

/** Message body format (DATA_MODEL.md "本文の形式"): plain text plus a small inline subset. */
sealed class BodyToken {
    data class Text(val text: String) : BodyToken()
    data class Bold(val text: String) : BodyToken()
    data class Italic(val text: String) : BodyToken()
    data class Code(val text: String) : BodyToken()
    data class CodeBlock(val text: String) : BodyToken()
    data class Link(val url: String) : BodyToken()
    data class Mention(val userId: String) : BodyToken()
    data class MentionAll(val target: String) : BodyToken()
    data object Newline : BodyToken()
}

private val PATTERN = Regex(
    """(```([\s\S]*?)```)|(`([^`\n]+)`)|(\*([^*\n]+)\*)|(_([^_\n]+)_)|(<@([0-9a-f-]{36})>)|(<!(channel|here)>)|(https?://[^\s<>]+)|(\n)""",
)

/** Same grammar as the desktop and iOS tokenizers; unmatched markup stays literal text. */
fun tokenizeBody(body: String): List<BodyToken> {
    val tokens = ArrayList<BodyToken>()
    var last = 0
    for (match in PATTERN.findAll(body)) {
        if (match.range.first > last) tokens.add(BodyToken.Text(body.substring(last, match.range.first)))
        val g = match.groups
        tokens.add(
            when {
                g[1] != null -> BodyToken.CodeBlock((g[2]?.value ?: "").trim('\n'))
                g[3] != null -> BodyToken.Code(g[4]?.value ?: "")
                g[5] != null -> BodyToken.Bold(g[6]?.value ?: "")
                g[7] != null -> BodyToken.Italic(g[8]?.value ?: "")
                g[9] != null -> BodyToken.Mention(g[10]?.value ?: "")
                g[11] != null -> BodyToken.MentionAll(g[12]?.value ?: "")
                g[13] != null -> BodyToken.Link(g[13]?.value ?: "")
                else -> BodyToken.Newline
            },
        )
        last = match.range.last + 1
    }
    if (last < body.length) tokens.add(BodyToken.Text(body.substring(last)))
    return tokens
}

/** Lines for rendering: code blocks stand alone, newlines split. */
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
