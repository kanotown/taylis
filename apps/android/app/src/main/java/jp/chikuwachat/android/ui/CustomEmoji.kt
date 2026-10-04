package jp.chikuwachat.android.ui

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import jp.chikuwachat.android.api.CustomEmojiOut

/** Custom emoji (M12f): `:name:` in text and reactions renders as the uploaded image. */
object CustomEmoji {
    /** M100 (docs/EMOJI.md §2): a wide image emoji is drawn wider at the same height, at most 3:1. */
    const val WIDE_MAX = 3f

    /**
     * Width / height of the box a custom emoji is drawn in: an image's own (1 to 3; a tall one in a square box), a text
     * emoji's pill as wide as its label ([TextEmojiPill.aspect]). Known before the image loads: its room is held.
     */
    fun aspect(emoji: CustomEmojiOut): Float {
        if (emoji.isText) return TextEmojiPill.aspect(emoji.label ?: emoji.name)
        if (emoji.width <= 0 || emoji.height <= 0) return 1f
        return (emoji.width.toFloat() / emoji.height).coerceIn(1f, WIDE_MAX)
    }

    /** M100: lower case, full-width as half-width (NFKC), katakana as hiragana (「アリガトウ」 finds 「ありがとう」). */
    fun fold(text: String): String =
        java.text.Normalizer.normalize(text, java.text.Normalizer.Form.NFKC).lowercase()
            .map { if (it in '\u30A1'..'\u30F6') it - 0x60 else it }.joinToString("")

    /**
     * Custom emoji for a query (M12f; M100 also by label and keywords): names starting with it, names containing it, then
     * labels / keywords starting with it, then containing it; by name within each.
     */
    fun candidates(query: String, custom: Collection<CustomEmojiOut>, limit: Int = 4): List<CustomEmojiOut> {
        val q = fold(query.trim())
        if (q.isEmpty()) return emptyList()
        fun rank(emoji: CustomEmojiOut): Int? {
            if (emoji.name.startsWith(q)) return 0
            if (emoji.name.contains(q)) return 1
            val words = (listOfNotNull(emoji.label) + emoji.keywords).filter { it.isNotEmpty() }.map(::fold)
            if (words.any { it.startsWith(q) }) return 2
            if (words.any { it.contains(q) }) return 3
            return null
        }
        return custom.mapNotNull { e -> rank(e)?.let { it to e } }
            .sortedWith(compareBy({ it.first }, { it.second.name })).take(limit).map { it.second }
    }

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

/**
 * A text emoji (M100, docs/EMOJI.md §1): its label as a pill, drawn into a bitmap so that every place that shows a custom
 * emoji's image shows it (inline text, reaction chips, the picker). Colours: apps/shared/text-emoji.json (CustomEmojiTest
 * compares them).
 */
object TextEmojiPill {
    /** Light and dark (background, text) per colour key; null = gray. */
    val PALETTE: Map<String, Pair<Pair<Long, Long>, Pair<Long, Long>>> = linkedMapOf(
        "gray" to ((0xE8E8ECL to 0x3A3A44L) to (0x3A3A44L to 0xE8E8ECL)),
        "red" to ((0xFDE2E1L to 0xB3261EL) to (0x5C1D1AL to 0xFFB4ABL)),
        "orange" to ((0xFFE6CCL to 0xA04A00L) to (0x5A3000L to 0xFFC58AL)),
        "yellow" to ((0xFFF3BFL to 0x7A5C00L) to (0x4D3D00L to 0xFFE08AL)),
        "green" to ((0xDDF4E4L to 0x1E6B3AL) to (0x163D24L to 0x9FE0B4L)),
        "blue" to ((0xDCEBFFL to 0x1D4FA0L) to (0x18325CL to 0xA8C8FFL)),
        "purple" to ((0xECE2FCL to 0x5B2DA6L) to (0x36225AL to 0xD2BCFAL)),
        "pink" to ((0xFCE1EFL to 0xA3215FL) to (0x5A1A3AL to 0xFFB0D5L)),
    )
    const val LABEL_MAX = 12

    /**
     * Width / height of the pill around `label` (the text 0.68 of the height, 0.28 of it on each side), estimated from
     * the characters (wide ones a full em, the rest 0.6) so it is known before drawing; the drawing fits the text into it.
     */
    fun aspect(label: String): Float {
        val ems = label.codePoints().toArray().sumOf { cp -> if (cp < 0x2E80) 0.6 else 1.0 }.toFloat()
        return maxOf(1f, ems * 0.68f + 0.56f)
    }

    private const val HEIGHT = 96

    fun draw(emoji: CustomEmojiOut, dark: Boolean): Bitmap {
        val label = emoji.label ?: emoji.name
        val width = (HEIGHT * aspect(label)).toInt()
        val colors = PALETTE[emoji.color ?: "gray"] ?: PALETTE.getValue("gray")
        val (bg, fg) = if (dark) colors.second else colors.first
        val bitmap = Bitmap.createBitmap(width, HEIGHT, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        val fill = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = (0xFF000000L or bg).toInt() }
        canvas.drawRoundRect(RectF(0f, 0f, width.toFloat(), HEIGHT.toFloat()), HEIGHT * 0.3f, HEIGHT * 0.3f, fill)
        val text = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = (0xFF000000L or fg).toInt()
            textSize = HEIGHT * 0.68f
            typeface = Typeface.create(Typeface.DEFAULT, Typeface.BOLD)
            textAlign = Paint.Align.CENTER
        }
        val room = width - HEIGHT * 0.4f
        val measured = text.measureText(label)
        if (measured > room) text.textSize *= room / measured
        val baseline = HEIGHT / 2f - (text.descent() + text.ascent()) / 2f
        canvas.drawText(label, width / 2f, baseline, text)
        return bitmap
    }
}
