package jp.chikuwachat.android.ui

/** Sharing a message into another conversation (M13c): a comment, the original as a quote, its permalink. */
object Share {
    fun body(original: String, permalink: String, comment: String, maxQuote: Int = 300): String {
        val text = original.trim()
        val clipped = if (text.length > maxQuote) text.take(maxQuote).trimEnd() + "…" else text
        val quote = clipped.ifEmpty { "(添付ファイル)" }.split("\n").joinToString("\n") { "> $it" }
        return listOf(comment.trim(), quote, permalink).filter { it.isNotEmpty() }.joinToString("\n")
    }
}
