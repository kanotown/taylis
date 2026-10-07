package jp.chikuwachat.android

import java.io.File
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.ui.AttendanceBadgeColors
import jp.chikuwachat.android.ui.TextEmojiPill
import kotlinx.serialization.json.double
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 在室状況 (docs/PRESENCE.md §2.2): the solid badge palette against apps/shared/attendance-badge-colors.json, and white on
 * every shade at WCAG AA (4.5:1 for the name, 3:1 for the icon) — the same shades in light and dark.
 */
class AttendanceBadgeColorsTest {
    private val shared = run {
        val file = File("../../shared/attendance-badge-colors.json")
        check(file.isFile) { "apps/shared/attendance-badge-colors.json not found from ${File("").absolutePath}" }
        Codec.snake.parseToJsonElement(file.readText()).jsonObject
    }

    private fun rgb(hex: String): Long = hex.removePrefix("#").toLong(16)

    @Test fun paletteMatchesTheSharedFile() {
        assertEquals(rgb(shared.getValue("fg").jsonPrimitive.content), AttendanceBadgeColors.FG)
        val colors = shared.getValue("colors").jsonObject.mapValues { rgb(it.value.jsonPrimitive.content) }
        assertEquals(colors.keys.toList(), AttendanceBadgeColors.COLORS.keys.toList())  // the file's order too
        assertEquals(colors, AttendanceBadgeColors.COLORS)
        // Every colour key a state may have (the text emoji palette's).
        assertEquals(TextEmojiPill.PALETTE.keys.toList(), AttendanceBadgeColors.COLORS.keys.toList())
        assertEquals(colors.getValue("gray"), AttendanceBadgeColors.solid("nonsense"))
        assertEquals(colors.getValue("gray"), AttendanceBadgeColors.solid(null))
    }

    /**
     * 2026-10-08: a solid badge's icon must be white like its name (it read as black on the phone). Every badge (the
     * board's headings, chips, the pressed button, the header chip, the sheet's squares) takes the icon's colour from
     * glyphTint(solid = true): white in light and dark, for every colour key and an unknown one. Off the badge (an
     * unpressed button) the icon has the state's colour, never white nor black.
     */
    @Test fun aSolidBadgesIconIsWhiteInBothThemes() {
        val keys = AttendanceBadgeColors.COLORS.keys + listOf("nonsense", null)
        for (key in keys) for (dark in listOf(false, true)) {
            assertEquals("$key dark=$dark", 0xFFFFFFL, AttendanceBadgeColors.glyphTint(key, solid = true, dark = dark))
            val tint = AttendanceBadgeColors.glyphTint(key, solid = false, dark = dark)
            assertTrue("$key dark=$dark: $tint", tint != 0xFFFFFFL && tint != 0x000000L)
        }
        assertEquals(AttendanceBadgeColors.solid("green"), AttendanceBadgeColors.glyphTint("green", solid = false, dark = false))
        assertEquals(TextEmojiPill.PALETTE.getValue("green").second.second, AttendanceBadgeColors.glyphTint("green", solid = false, dark = true))
    }

    @Test fun whiteOnEveryShadeMeetsWcagAA() {
        val minText = shared.getValue("min_text_contrast").jsonPrimitive.double
        val minIcon = shared.getValue("min_icon_contrast").jsonPrimitive.double
        assertTrue(minText >= 4.5)
        assertTrue(minIcon >= 3.0)
        assertEquals(21.0, AttendanceBadgeColors.contrast(0xFFFFFF, 0x000000), 1e-9)
        AttendanceBadgeColors.COLORS.forEach { (key, shade) ->
            val ratio = AttendanceBadgeColors.contrast(AttendanceBadgeColors.FG, shade)
            assertTrue("$key: $ratio", ratio >= minText)
            assertTrue("$key: $ratio", ratio >= minIcon)
        }
    }
}
