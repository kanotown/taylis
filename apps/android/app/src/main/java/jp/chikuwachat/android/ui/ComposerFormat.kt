package jp.chikuwachat.android.ui

/**
 * The composer's 「書式」 menu (仕上げ B, MOBILE_POLISH C2 / MUI-5; the same marks as iOS ComposerFormat.swift and the
 * web): the markdown the message body shows (BodyTokenizer), put around the selected text or at the cursor. A line
 * style goes at the start of each line the selection touches. Offsets are the text field's (UTF-16).
 */
enum class ComposerFormat(val label: String) {
    BOLD("太字"),
    ITALIC("斜体"),
    STRIKE("取り消し線"),
    CODE("コード"),
    CODE_BLOCK("コードブロック"),
    HEADING("見出し"),
    QUOTE("引用"),
    BULLET("箇条書き"),
    NUMBERED("番号付きリスト"),
    LINK("リンク");

    /** A text and its selection (`start == end`: the cursor). */
    data class Result(val text: String, val start: Int, val end: Int)

    /** The text with this format applied to [start]..[end]; where the cursor or selection goes after it. */
    fun apply(text: String, start: Int, end: Int): Result {
        val lower = minOf(start, end).coerceIn(0, text.length)
        val upper = maxOf(start, end).coerceIn(lower, text.length)
        val selected = text.substring(lower, upper)
        fun wrap(open: String, close: String): Result {
            val at = lower + open.length
            return Result(text.substring(0, lower) + open + selected + close + text.substring(upper), at, at + selected.length)
        }
        return when (this) {
            BOLD -> wrap("**", "**")
            ITALIC -> wrap("_", "_")
            STRIKE -> wrap("~~", "~~")
            CODE -> wrap("`", "`")
            CODE_BLOCK -> wrap((if (lower > 0 && text[lower - 1] != '\n') "\n" else "") + "```\n", "\n```")
            LINK -> if (selected.isEmpty()) wrap("[", "](https://)") else {
                val cursor = lower + selected.length + "[](https://".length
                Result(text.substring(0, lower) + "[" + selected + "](https://)" + text.substring(upper), cursor, cursor)
            }
            HEADING, QUOTE, BULLET, NUMBERED -> {
                // Every line the selection touches, from the start of the first one.
                var from = lower
                while (from > 0 && text[from - 1] != '\n') from--
                var to = upper
                while (to < text.length && text[to] != '\n') to++
                val lines = text.substring(from, to).split("\n")
                val marked = lines.mapIndexed { index, line ->
                    when (this) {
                        HEADING -> "## "
                        QUOTE -> "> "
                        BULLET -> "- "
                        else -> "${index + 1}. "
                    } + line
                }.joinToString("\n")
                val result = text.substring(0, from) + marked + text.substring(to)
                // One line: the cursor keeps its place after the mark; several: they stay selected.
                if (lines.size == 1) {
                    val shift = marked.length - lines[0].length
                    Result(result, lower + shift, upper + shift)
                } else {
                    Result(result, from, to + marked.length - (to - from))
                }
            }
        }
    }
}

/** What the composer shows and where text goes in (仕上げ B). */
object ComposerText {
    /**
     * The input's placeholder, as on iOS: 「#general へのメッセージ」, a DM 「山田 へのメッセージ」 (the conversation's
     * title, [channelTitle]), a thread 「スレッドに返信」.
     */
    fun placeholder(title: String?, inThread: Boolean): String = when {
        inThread -> "スレッドに返信"
        title.isNullOrBlank() || title == "#" -> "メッセージ"
        else -> "$title へのメッセージ"
    }

    /**
     * [inserted] in place of the selection [start]..[end] (clamped: a selection from before a send may be past the
     * end), the cursor after it.
     */
    fun insert(text: String, start: Int, end: Int, inserted: String): ComposerFormat.Result {
        val lower = minOf(start, end).coerceIn(0, text.length)
        val upper = maxOf(start, end).coerceIn(lower, text.length)
        val cursor = lower + inserted.length
        return ComposerFormat.Result(text.substring(0, lower) + inserted + text.substring(upper), cursor, cursor)
    }

    /**
     * The tool row's 「@」: an `@` at the cursor, after a space when the text before would join it to a word
     * (`abc@` is not a mention, [Mentions]); the completions then show as the name is typed.
     */
    fun mention(text: String, start: Int, end: Int): ComposerFormat.Result {
        val at = minOf(start, end).coerceIn(0, text.length)
        val before = text.getOrNull(at - 1)
        val joins = before != null && (before.isLetterOrDigit() && before.code < 0x80 || before in "._@<-")
        return insert(text, start, end, if (joins) " @" else "@")
    }
}
