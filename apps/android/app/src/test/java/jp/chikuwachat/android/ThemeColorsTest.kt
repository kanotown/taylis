package jp.chikuwachat.android

import java.io.File
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.ui.PaletteColors
import jp.chikuwachat.android.ui.ThemeColors
import jp.chikuwachat.android.ui.ThemeMode
import jp.chikuwachat.android.ui.ThemePalette
import jp.chikuwachat.android.ui.ThemePrefs
import jp.chikuwachat.android.ui.ThemeScope
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 「テーマの色」 and 「ダークを真っ黒にする」 (2026-10-27, MOBILE_UI.md §27): the palettes against apps/shared/palettes.json,
 * the Material roles' contrast in every palette and mode, the black mode's elevation steps, and the per-workspace choice.
 */
class ThemeColorsTest {
    private val shared = run {
        val file = File("../../shared/palettes.json")
        check(file.isFile) { "apps/shared/palettes.json not found from ${File("").absolutePath}" }
        Codec.snake.parseToJsonElement(file.readText()).jsonObject
    }

    private fun rgb(hex: String): Long = 0xFF000000L or hex.removePrefix("#").toLong(16)

    @Test fun thePalettesAreTheSharedFiles() {
        val order = shared.getValue("order").jsonArray.map { it.jsonPrimitive.content }
        assertEquals(order, ThemePalette.entries.map { it.key })
        assertEquals(ThemePalette.TAYLIS, ThemePalette.DEFAULT)
        assertEquals(order.first(), ThemePalette.DEFAULT.key)
        val palettes = shared.getValue("palettes").jsonObject
        for (palette in ThemePalette.entries) for (dark in listOf(false, true)) {
            val json = palettes.getValue(palette.key).jsonObject.getValue(if (dark) "dark" else "light").jsonObject
            fun field(name: String) = rgb(json.getValue(name).jsonPrimitive.content)
            val tones = PaletteColors.tones(palette, dark)
            val where = "${palette.key} dark=$dark"
            assertEquals(where, field("accent"), tones.accent)
            assertEquals(where, field("accent-solid"), tones.accentSolid)
            assertEquals(where, field("accent-soft"), tones.accentSoft)
        }
    }

    private val modes = ThemeMode.entries

    @Test fun everyModeHasEveryRole() {
        val keys = ThemeColors.roles(ThemePalette.DEFAULT, ThemeMode.LIGHT).keys
        assertEquals(36, keys.size)
        for (palette in ThemePalette.entries) for (mode in modes) {
            assertEquals("$palette $mode", keys, ThemeColors.roles(palette, mode).keys)
        }
    }

    @Test fun textOnEveryFilledRoleReadsInEveryPaletteAndMode() {
        // WCAG AA for text (4.5:1): buttons, chips, badges, containers, selected rows and the surfaces' own text.
        val textPairs = listOf(
            "primary" to "onPrimary", "primaryContainer" to "onPrimaryContainer",
            "secondary" to "onSecondary", "secondaryContainer" to "onSecondaryContainer",
            "secondaryContainer" to "onSurface", "primaryContainer" to "onSurface",
            "tertiary" to "onTertiary", "tertiaryContainer" to "onTertiaryContainer",
            "error" to "onError", "errorContainer" to "onErrorContainer",
            "surface" to "onSurface", "surface" to "onSurfaceVariant", "background" to "onBackground",
            "surfaceContainer" to "onSurface", "surfaceContainer" to "onSurfaceVariant",
            "surfaceContainerHigh" to "onSurface", "surfaceContainerHigh" to "onSurfaceVariant",
            "surfaceContainerHighest" to "onSurfaceVariant", "surfaceVariant" to "onSurfaceVariant",
            "inverseSurface" to "inverseOnSurface",
            "surface" to "primary", "surfaceContainerLow" to "primary", "surface" to "error", // links (on a sheet too), the red ログアウト
        )
        for (palette in ThemePalette.entries) for (mode in modes) {
            val p = ThemeColors.roles(palette, mode)
            for ((back, fore) in textPairs) {
                val ratio = ThemeColors.contrast(p.getValue(back), p.getValue(fore))
                assertTrue("$fore on $back ($palette $mode) is ${"%.2f".format(ratio)}", ratio >= 4.5)
            }
            // Non-text parts (a switch's track, the unread dot, an outlined field) stand out 3:1 from the surface.
            for (part in listOf("primary", "outline")) {
                val ratio = ThemeColors.contrast(p.getValue("surface"), p.getValue(part))
                assertTrue("$part on surface ($palette $mode) is ${"%.2f".format(ratio)}", ratio >= 3.0)
            }
        }
        assertEquals(21.0, ThemeColors.contrast(0xFF000000, 0xFFFFFFFF), 0.01)
    }

    @Test fun lightUsesTheAccentAsTheFillUnderWhiteAndDarkKeepsTheSolidForContainers() {
        for (palette in ThemePalette.entries) {
            val light = ThemeColors.roles(palette, ThemeMode.LIGHT)
            assertEquals(PaletteColors.tones(palette, false).accent, light.getValue("primary"))
            assertEquals(0xFFFFFFFF, light.getValue("onPrimary"))
            for (mode in listOf(ThemeMode.DARK, ThemeMode.BLACK)) {
                val dark = ThemeColors.roles(palette, mode)
                assertEquals(PaletteColors.tones(palette, true).accent, dark.getValue("primary"))
                assertEquals(PaletteColors.tones(palette, true).accentSolid, dark.getValue("primaryContainer"))
                assertEquals(0xFFFFFFFF, dark.getValue("onPrimaryContainer"))
                assertEquals(PaletteColors.tones(palette, true).accentSoft, dark.getValue("secondaryContainer"))
            }
            // Semantic colours do not follow the palette.
            assertEquals(0xFFBA1A1A, light.getValue("error"))
            assertEquals(ThemeColors.roles(ThemePalette.DEFAULT, ThemeMode.DARK).getValue("error"), ThemeColors.roles(palette, ThemeMode.DARK).getValue("error"))
        }
    }

    @Test fun blackModeIsPureBlackWithVisibleElevationSteps() {
        val steps = listOf("surfaceContainerLow", "surfaceContainer", "surfaceContainerHigh", "surfaceContainerHighest", "surfaceBright")
        for (palette in ThemePalette.entries) {
            val black = ThemeColors.roles(palette, ThemeMode.BLACK)
            val dark = ThemeColors.roles(palette, ThemeMode.DARK)
            for (role in listOf("background", "surface", "surfaceDim", "surfaceContainerLowest")) {
                assertEquals("$palette $role", 0xFF000000, black.getValue(role))
            }
            // The tab bar, sheets, cards and fields step up from the black canvas, each a little lighter.
            var previous = 0xFF000000
            for (role in steps) {
                val value = black.getValue(role)
                assertTrue("$palette $role", ThemeColors.luminance(value) > ThemeColors.luminance(previous))
                assertTrue("$palette $role is ${"%.3f".format(ThemeColors.contrast(value, 0xFF000000))}", ThemeColors.contrast(value, 0xFF000000) >= 1.1)
                // ...but stay darker than the grey dark mode's (still near-black).
                assertTrue("$palette $role", ThemeColors.luminance(value) <= ThemeColors.luminance(dark.getValue(role)))
                previous = value
            }
            // Only the backgrounds change: the accent and the text are the dark mode's.
            for (role in listOf("primary", "onPrimary", "primaryContainer", "secondaryContainer", "onSurface", "onSurfaceVariant", "outline", "error")) {
                assertEquals("$palette $role", dark.getValue(role), black.getValue(role))
            }
            assertFalse(dark.getValue("surface") == 0xFF000000)
        }
    }

    @Test fun eachWorkspaceMayKeepItsOwnPaletteAndFallsBackToTheCommonOne() {
        val prefs = MemoryStore()
        val a = "https://a.example"
        val b = "https://b.example"
        assertEquals(ThemePalette.TAYLIS, ThemePrefs.palette(prefs, a))
        assertEquals(ThemeScope.ALL, ThemePrefs.scope(prefs, a))
        // Every workspace: the common choice.
        ThemePrefs.write(prefs, ThemePalette.GREEN, ThemeScope.ALL, a)
        assertEquals(ThemePalette.GREEN, ThemePrefs.palette(prefs, a))
        assertEquals(ThemePalette.GREEN, ThemePrefs.palette(prefs, b))
        assertEquals(ThemePalette.GREEN, ThemePrefs.palette(prefs, null))
        // This workspace only: a wins, b falls back.
        ThemePrefs.write(prefs, ThemePalette.ROSE, ThemeScope.WORKSPACE, a)
        assertEquals(ThemePalette.ROSE, ThemePrefs.palette(prefs, a))
        assertEquals(ThemeScope.WORKSPACE, ThemePrefs.scope(prefs, a))
        assertEquals(ThemePalette.GREEN, ThemePrefs.palette(prefs, b))
        assertEquals(ThemeScope.ALL, ThemePrefs.scope(prefs, b))
        ThemePrefs.write(prefs, ThemePalette.GRAY, ThemeScope.WORKSPACE, b)
        assertEquals(ThemePalette.ROSE, ThemePrefs.palette(prefs, a))
        assertEquals(ThemePalette.GRAY, ThemePrefs.palette(prefs, b))
        // No workspace on screen (the add-workspace login): the common choice, and a write goes there.
        ThemePrefs.write(prefs, ThemePalette.PURPLE, ThemeScope.WORKSPACE, null)
        assertEquals(ThemePalette.PURPLE, ThemePrefs.global(prefs))
        assertNull(prefs.values["theme.palette.workspaces"]) // ...dropping the workspaces' own, as the desktop
        assertEquals(ThemePalette.PURPLE, ThemePrefs.palette(prefs, a))
        // 「すべてのワークスペース」 drops the workspaces' own choices; the default leaves no key behind.
        ThemePrefs.write(prefs, ThemePalette.ROSE, ThemeScope.WORKSPACE, a)
        ThemePrefs.write(prefs, ThemePalette.TAYLIS, ThemeScope.ALL, a)
        assertEquals(ThemePalette.TAYLIS, ThemePrefs.palette(prefs, a))
        assertNull(prefs.values["theme.palette"])
        assertNull(prefs.values["theme.palette.workspaces"])
        // Something unreadable is the default.
        val broken = MemoryStore(mapOf("theme.palette" to "sepia", "theme.palette.workspaces" to "{not json"))
        assertEquals(ThemePalette.TAYLIS, ThemePrefs.palette(broken, a))
        val unknown = MemoryStore(mapOf("theme.palette.workspaces" to """{"$a":"sepia","$b":"indigo"}"""))
        assertEquals(ThemePalette.TAYLIS, ThemePrefs.palette(unknown, a))
        assertEquals(ThemePalette.INDIGO, ThemePrefs.palette(unknown, b))
    }

    @Test fun pureBlackIsKeptOnTheDeviceAndOffByDefault() {
        val prefs = MemoryStore()
        assertFalse(ThemePrefs.black(prefs))
        ThemePrefs.writeBlack(prefs, true)
        assertTrue(ThemePrefs.black(prefs))
        ThemePrefs.writeBlack(prefs, false)
        assertFalse(ThemePrefs.black(prefs))
        assertNull(prefs.values["theme.black"])
    }
}
