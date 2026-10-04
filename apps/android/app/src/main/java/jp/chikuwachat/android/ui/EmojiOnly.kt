package jp.chikuwachat.android.ui

import jp.chikuwachat.android.api.CustomEmojiOut

/**
 * Emoji-only messages (M101, docs/EMOJI.md §7): a body that is nothing but emoji (standard ones, `:shortcode:`s and
 * custom emoji of any kind; at most [MAX_ITEMS], whitespace between them) is shown large in the timeline and threads.
 * The rule and its cases are shared with the web and iOS: apps/shared/emoji-only.json (EmojiOnlyTest compares the
 * tables below with it and runs the cases).
 */
object EmojiOnly {
    enum class Kind(val key: String) { UNICODE("unicode"), IMAGE("image"), TEXT("text"), PACK("pack") }

    data class Result(val kinds: List<Kind>) {
        /** Exactly one emoji of a pack: shown as a stamp. */
        val stamp: Boolean get() = kinds == listOf(Kind.PACK)
    }

    const val MAX_ITEMS = 23
    val WHITESPACE = listOf(0x20, 0x09, 0x0A, 0x0D, 0xA0, 0x3000)

    /** The Unicode Emoji property without ASCII and the sequence components, plus all of 1F000–1FAFF. */
    val PICTOGRAPHIC: List<IntRange> = listOf(
        0xA9..0xA9, 0xAE..0xAE, 0x203C..0x203C, 0x2049..0x2049, 0x2122..0x2122, 0x2139..0x2139, 0x2194..0x2199,
        0x21A9..0x21AA, 0x231A..0x231B, 0x2328..0x2328, 0x23CF..0x23CF, 0x23E9..0x23F3, 0x23F8..0x23FA,
        0x24C2..0x24C2, 0x25AA..0x25AB, 0x25B6..0x25B6, 0x25C0..0x25C0, 0x25FB..0x25FE, 0x2600..0x2604,
        0x260E..0x260E, 0x2611..0x2611, 0x2614..0x2615, 0x2618..0x2618, 0x261D..0x261D, 0x2620..0x2620,
        0x2622..0x2623, 0x2626..0x2626, 0x262A..0x262A, 0x262E..0x262F, 0x2638..0x263A, 0x2640..0x2640,
        0x2642..0x2642, 0x2648..0x2653, 0x265F..0x2660, 0x2663..0x2663, 0x2665..0x2666, 0x2668..0x2668,
        0x267B..0x267B, 0x267E..0x267F, 0x2692..0x2697, 0x2699..0x2699, 0x269B..0x269C, 0x26A0..0x26A1,
        0x26A7..0x26A7, 0x26AA..0x26AB, 0x26B0..0x26B1, 0x26BD..0x26BE, 0x26C4..0x26C5, 0x26C8..0x26C8,
        0x26CE..0x26CF, 0x26D1..0x26D1, 0x26D3..0x26D4, 0x26E9..0x26EA, 0x26F0..0x26F5, 0x26F7..0x26FA,
        0x26FD..0x26FD, 0x2702..0x2702, 0x2705..0x2705, 0x2708..0x270D, 0x270F..0x270F, 0x2712..0x2712,
        0x2714..0x2714, 0x2716..0x2716, 0x271D..0x271D, 0x2721..0x2721, 0x2728..0x2728, 0x2733..0x2734,
        0x2744..0x2744, 0x2747..0x2747, 0x274C..0x274C, 0x274E..0x274E, 0x2753..0x2755, 0x2757..0x2757,
        0x2763..0x2764, 0x2795..0x2797, 0x27A1..0x27A1, 0x27B0..0x27B0, 0x27BF..0x27BF, 0x2934..0x2935,
        0x2B05..0x2B07, 0x2B1B..0x2B1C, 0x2B50..0x2B50, 0x2B55..0x2B55, 0x3030..0x3030, 0x303D..0x303D,
        0x3297..0x3297, 0x3299..0x3299, 0x1F000..0x1F1E5, 0x1F200..0x1F3FA, 0x1F400..0x1FAFF,
    )

    private val NAME = Regex("^[a-z0-9][a-z0-9_+-]{1,31}$")

    private fun pictographic(cp: Int): Boolean {
        var lo = 0
        var hi = PICTOGRAPHIC.size - 1
        while (lo <= hi) {
            val mid = (lo + hi) / 2
            val range = PICTOGRAPHIC[mid]
            when {
                cp < range.first -> hi = mid - 1
                cp > range.last -> lo = mid + 1
                else -> return true
            }
        }
        return false
    }

    /** The emoji of an emoji-only body (in order), or null when it is not one. [custom]: custom emoji by name. */
    fun parse(body: String, custom: Map<String, CustomEmojiOut>): Result? =
        parse(body) { name -> custom[name]?.let { if (it.isText) Kind.TEXT else if (it.packId != null) Kind.PACK else Kind.IMAGE } }

    fun parse(body: String, kind: (String) -> Kind?): Result? {
        val cps = Emoji.replaceShortcodes(body).codePoints().toArray()
        fun at(index: Int): Int? = cps.getOrNull(index)
        fun regional(cp: Int?) = cp != null && cp in 0x1F1E6..0x1F1FF
        fun skinTone(cp: Int?) = cp != null && cp in 0x1F3FB..0x1F3FF
        fun tag(cp: Int?) = cp != null && cp in 0xE0020..0xE007E
        /** One element of an emoji sequence at [start]: its end, or -1. */
        fun element(start: Int): Int {
            val base = at(start) ?: return -1
            if (!pictographic(base)) return -1
            var j = start + 1
            if (at(j) == 0xFE0F) j++
            if (skinTone(at(j))) j++
            if (base == 0x1F3F4 && tag(at(j))) {
                while (tag(at(j))) j++
                if (at(j) != 0xE007F) return -1
                j++
            }
            return j
        }
        val kinds = ArrayList<Kind>()
        var i = 0
        while (i < cps.size) {
            val cp = cps[i]
            if (cp in WHITESPACE) { i++; continue }
            if (kinds.size == MAX_ITEMS) return null
            if (cp == 0x3A) { // ':' name ':'
                var j = i + 1
                while (j < cps.size && cps[j] != 0x3A && j - i <= 33) j++
                if (at(j) != 0x3A) return null
                val name = String(cps, i + 1, j - i - 1)
                if (!NAME.matches(name)) return null
                kinds += kind(name) ?: return null
                i = j + 1
                continue
            }
            if (cp in 0x30..0x39 || cp == 0x23 || cp == 0x2A) {
                var j = i + 1
                if (at(j) == 0xFE0F) j++
                if (at(j) != 0x20E3) return null
                kinds += Kind.UNICODE
                i = j + 1
                continue
            }
            if (regional(cp)) {
                if (!regional(at(i + 1))) return null
                kinds += Kind.UNICODE
                i += 2
                continue
            }
            var j = element(i)
            if (j < 0) return null
            while (at(j) == 0x200D) {
                j = element(j + 1)
                if (j < 0) return null
            }
            kinds += Kind.UNICODE
            i = j
        }
        return if (kinds.isEmpty()) null else Result(kinds)
    }

    /**
     * The sizes on Android (sp for the font, dp for the rest; docs/EMOJI.md §7): a standard emoji's font size, an image
     * emoji's height (a wide one keeps its ratio, at most 3:1), a text emoji's pill height (its label 1.6× the inline
     * one's), a pack emoji's height (several), and a single pack emoji's (a stamp).
     */
    object Jumbo {
        const val FONT = 30f
        const val IMAGE = 34f
        const val PILL = 32f
        const val PACK = 64f
        const val STAMP = 120f
    }
}
