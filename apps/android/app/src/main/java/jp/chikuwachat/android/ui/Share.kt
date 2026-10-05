package jp.chikuwachat.android.ui
import jp.chikuwachat.android.R
import jp.chikuwachat.android.L10n

/** Sharing a message into another conversation (M13c): a comment, the original as a quote, its permalink. */
object Share {
    fun body(original: String, permalink: String, comment: String, maxQuote: Int = 300): String {
        val text = original.trim()
        val clipped = if (text.length > maxQuote) text.take(maxQuote).trimEnd() + "…" else text
        val quote = clipped.ifEmpty { L10n.str(R.string.share_attachment) }.split("\n").joinToString("\n") { "> $it" }
        return listOf(comment.trim(), quote, permalink).filter { it.isNotEmpty() }.joinToString("\n")
    }
}
