package jp.chikuwachat.android.ui

/** Emoji shortcodes and the picker's search (M11f); the table is generated from apps/shared/emoji.json. */
object Emoji {
    private val byShortcode: Map<String, EmojiEntry> = EmojiData.all.associateBy { it.shortcode }
    private val SHORTCODE = Regex(":([a-z0-9_+\\-]{1,30}):")
    /** ":ta" at the end of the text, at a word start; the query needs at least 2 characters. */
    private val QUERY = Regex("(^|[\\s(（「])[:：]([a-z0-9_+\\-]{2,30})$")

    fun byShortcode(shortcode: String): EmojiEntry? = byShortcode[shortcode]

    /** `:tada:` → 🎉 wherever the shortcode is known; unknown ones stay as typed. */
    fun replaceShortcodes(text: String): String {
        if (!text.contains(':')) return text
        return SHORTCODE.replace(text) { match -> byShortcode[match.groupValues[1]]?.glyph ?: match.value }
    }

    /** The `:query` being typed at the end of the text (the composer edits at the end), like Mentions.query. */
    fun query(text: String): String? = QUERY.find(text)?.groupValues?.get(2)?.lowercase()

    /** Matches by shortcode prefix first, then by keyword / shortcode substring. */
    fun candidates(query: String, limit: Int = 8): List<EmojiEntry> {
        val q = query.lowercase()
        if (q.isEmpty()) return emptyList()
        val prefix = EmojiData.all.filter { it.shortcode.startsWith(q) }
        val rest = EmojiData.all.filter { !it.shortcode.startsWith(q) && (it.shortcode.contains(q) || it.keywords.lowercase().contains(q)) }
        return (prefix + rest).take(limit)
    }

    /** Free-text search for the picker: an empty query lists everything. */
    fun search(query: String): List<EmojiEntry> {
        val q = query.trim()
        return if (q.isEmpty()) EmojiData.all else candidates(q, EmojiData.all.size)
    }

    /** Replace the trailing `:query` with the glyph and a space. */
    fun complete(text: String, glyph: String): String {
        val match = QUERY.find(text) ?: return "$text$glyph "
        return text.substring(0, match.groups[2]!!.range.first - 1) + glyph + " "
    }
}
