package jp.chikuwachat.android.ui

import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

/**
 * 在室状況 (docs/PRESENCE.md §2.2): the solid badge palette — a copy of apps/shared/attendance-badge-colors.json
 * (AttendanceBadgeColorsTest compares it and checks the contrast). A badge is the state's colour key as a solid shade
 * with white text and icon, the same in light and dark.
 */
object AttendanceBadgeColors {
    const val FG: Long = 0xFFFFFF

    /** Colour key → 0xRRGGBB, in the swatches' order. */
    val COLORS: Map<String, Long> = linkedMapOf(
        "gray" to 0x4B5563L,
        "red" to 0xDC2626L,
        "orange" to 0xC2410CL,
        "yellow" to 0xA16207L,
        "green" to 0x15803DL,
        "blue" to 0x2563EBL,
        "purple" to 0x7C3AEDL,
        "pink" to 0xBE185DL,
    )

    /** A colour key's shade (an unknown key = gray). */
    fun solid(color: String?): Long = COLORS[color ?: "gray"] ?: COLORS.getValue("gray")

    /** WCAG 2.x contrast ratio of two 0xRRGGBB colours (1…21). */
    fun contrast(a: Long, b: Long): Double {
        fun linear(channel: Long): Double {
            val c = (channel and 0xFF).toDouble() / 255
            return if (c <= 0.04045) c / 12.92 else ((c + 0.055) / 1.055).pow(2.4)
        }
        fun luminance(rgb: Long): Double = 0.2126 * linear(rgb shr 16) + 0.7152 * linear(rgb shr 8) + 0.0722 * linear(rgb)
        val (x, y) = luminance(a) to luminance(b)
        return (max(x, y) + 0.05) / (min(x, y) + 0.05)
    }
}
