package jp.chikuwachat.android.ui

/** Custom emoji (M12f): `:name:` in text and reactions renders as the uploaded image. */
object CustomEmoji {
    private val EXACT = Regex("^:([a-z0-9][a-z0-9_+-]{1,31}):$")
    private val INLINE = Regex(":([a-z0-9][a-z0-9_+-]{1,31}):")

    sealed class Piece {
        data class Text(val text: String) : Piece()
        data class Emoji(val name: String) : Piece()
    }

    /** The custom emoji name when `text` is exactly `:name:` (reactions, picker picks). */
    fun name(text: String): String? = EXACT.find(text)?.groupValues?.get(1)

    /**
     * The custom emoji a status emoji is (picked from the emoji picker, it can be `:name:`), when it exists: drawn as its
     * image (2026-10-02: it showed as its text). Null for a standard emoji or a name this workspace does not have.
     */
    fun <T> of(emoji: String, custom: Map<String, T>): T? = name(emoji.trim())?.let { custom[it] }

    /** Split text into plain runs and known custom emoji names; unknown `:x:` stay text. */
    fun split(text: String, known: (String) -> Boolean): List<Piece> {
        if (!text.contains(':')) return listOf(Piece.Text(text))
        val pieces = ArrayList<Piece>()
        var last = 0
        for (match in INLINE.findAll(text)) {
            val name = match.groupValues[1]
            if (!known(name)) continue
            if (match.range.first > last) pieces += Piece.Text(text.substring(last, match.range.first))
            pieces += Piece.Emoji(name)
            last = match.range.last + 1
        }
        if (last < text.length) pieces += Piece.Text(text.substring(last))
        return pieces
    }
}
