package jp.chikuwachat.android.ui

import jp.chikuwachat.android.L10n
import jp.chikuwachat.android.R
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.platform.KeyValueStore
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

/**
 * 「テーマの色」 (2026-10-27, MOBILE_UI.md §27): the desktop's palettes (apps/desktop/src/ui/theme.ts `PALETTES`), in the
 * settings' order; the first is the default. Labels as the desktop's `theme.palette.*`.
 */
enum class ThemePalette(val key: String, private val labelRes: Int) {
    TAYLIS("taylis", R.string.theme_palette_taylis),
    INDIGO("indigo", R.string.theme_palette_indigo),
    GREEN("green", R.string.theme_palette_green),
    PURPLE("purple", R.string.theme_palette_purple),
    ROSE("rose", R.string.theme_palette_rose),
    GRAY("gray", R.string.theme_palette_gray),
    ;

    val label: String get() = L10n.str(labelRes)

    companion object {
        val DEFAULT = TAYLIS

        fun of(key: String?): ThemePalette? = entries.firstOrNull { it.key == key }
    }
}

/**
 * A palette's brand colours in one mode, as apps/shared/palettes.json (PaletteTest keeps them equal): [accent] for text
 * and lines (links, icons), [accentSolid] the fill under white text, [accentSoft] a light tint (selected rows). Both
 * modes meet WCAG AA for the accent on the canvas and white on the solid (the desktop's tests/theme.test.ts).
 */
data class PaletteTones(val accent: Long, val accentSolid: Long, val accentSoft: Long)

object PaletteColors {
    val light: Map<ThemePalette, PaletteTones> = mapOf(
        ThemePalette.TAYLIS to PaletteTones(0xFF7A4526, 0xFF7A4526, 0xFFF6ECE3),
        ThemePalette.INDIGO to PaletteTones(0xFF5050C8, 0xFF5050C8, 0xFFECEBFF),
        ThemePalette.GREEN to PaletteTones(0xFF2E7550, 0xFF2E7550, 0xFFE4F2EA),
        ThemePalette.PURPLE to PaletteTones(0xFF7C3FB0, 0xFF7C3FB0, 0xFFF3EAFB),
        ThemePalette.ROSE to PaletteTones(0xFFB02F50, 0xFFB02F50, 0xFFFBE9EE),
        ThemePalette.GRAY to PaletteTones(0xFF4F5B6B, 0xFF4F5B6B, 0xFFECEEF2),
    )

    val dark: Map<ThemePalette, PaletteTones> = mapOf(
        ThemePalette.TAYLIS to PaletteTones(0xFFE6B48A, 0xFF7A4526, 0xFF3A2A1F),
        ThemePalette.INDIGO to PaletteTones(0xFF9A9AF5, 0xFF5050C8, 0xFF2A2A4A),
        ThemePalette.GREEN to PaletteTones(0xFF6FCF98, 0xFF2E7550, 0xFF1D3A2B),
        ThemePalette.PURPLE to PaletteTones(0xFFC39AF0, 0xFF7C3FB0, 0xFF35224A),
        ThemePalette.ROSE to PaletteTones(0xFFF590A8, 0xFFB02F50, 0xFF4A1F2C),
        ThemePalette.GRAY to PaletteTones(0xFFA9B4C4, 0xFF556274, 0xFF2B2F36),
    )

    fun tones(palette: ThemePalette, dark: Boolean): PaletteTones = (if (dark) this.dark else light).getValue(palette)
}

/** How the app looks: light or dark, 「ダークを真っ黒にする」 (only while dark) and the palette. */
enum class ThemeMode { LIGHT, DARK, BLACK }

/**
 * The Material 3 roles of a palette in a mode, as opaque ARGB (checked on the JVM: ThemeColorsTest). The accent maps onto
 * `primary` (links, icons, switches, the send button), the soft tint onto `secondaryContainer` (selected rows, the tab's
 * indicator); in dark the light accent is `primary` with dark text on it and the solid fill is `primaryContainer` with
 * white text (as M3's own dark schemes). The neutrals are greys tinted a few per cent by the accent. Error and tertiary
 * (semantic) stay as they were. [ThemeMode.BLACK]: the canvas is #000 (OLED) and the containers (the tab bar, sheets,
 * cards, fields) step up through very dark greys so they stay apart from it.
 */
object ThemeColors {
    private const val WHITE = 0xFFFFFFFF
    private const val BLACK = 0xFF000000

    fun roles(palette: ThemePalette, mode: ThemeMode): Map<String, Long> {
        val dark = mode != ThemeMode.LIGHT
        val t = PaletteColors.tones(palette, dark)
        val other = PaletteColors.tones(palette, !dark)
        fun n(grey: Long, amount: Double) = mix(grey, t.accent, amount)
        val accentRoles = if (!dark) mapOf(
            "primary" to t.accent,
            "onPrimary" to WHITE,
            "primaryContainer" to mix(WHITE, t.accent, 0.16),
            "onPrimaryContainer" to mix(t.accent, BLACK, 0.45),
            "inversePrimary" to other.accent,
            "secondary" to t.accent,
            "onSecondary" to WHITE,
            "secondaryContainer" to mix(t.accentSoft, t.accent, 0.08),
            "onSecondaryContainer" to mix(t.accent, BLACK, 0.5),
            "surfaceTint" to t.accent,
        ) else mapOf(
            "primary" to t.accent,
            "onPrimary" to mix(t.accent, BLACK, 0.8),
            "primaryContainer" to t.accentSolid,
            "onPrimaryContainer" to WHITE,
            "inversePrimary" to other.accent,
            "secondary" to t.accent,
            "onSecondary" to mix(t.accent, BLACK, 0.8),
            "secondaryContainer" to t.accentSoft,
            "onSecondaryContainer" to mix(WHITE, t.accent, 0.25),
            "surfaceTint" to t.accent,
        )
        val neutrals = when (mode) {
            ThemeMode.LIGHT -> mapOf(
                "background" to n(0xFFFAFAFA, 0.03),
                "onBackground" to n(0xFF1B1B1B, 0.06),
                "surface" to n(0xFFFAFAFA, 0.03),
                "onSurface" to n(0xFF1B1B1B, 0.06),
                "surfaceVariant" to n(0xFFE1E1E4, 0.08),
                "onSurfaceVariant" to n(0xFF45464A, 0.08),
                "inverseSurface" to n(0xFF303030, 0.05),
                "inverseOnSurface" to n(0xFFF1F1F1, 0.03),
                "outline" to n(0xFF76777B, 0.08),
                "outlineVariant" to n(0xFFC6C6CA, 0.08),
                "surfaceBright" to n(0xFFFAFAFA, 0.03),
                "surfaceDim" to n(0xFFDADADA, 0.05),
                "surfaceContainerLowest" to WHITE,
                "surfaceContainerLow" to n(0xFFF4F4F4, 0.04),
                "surfaceContainer" to n(0xFFEEEEEE, 0.05),
                "surfaceContainerHigh" to n(0xFFE8E8E8, 0.05),
                "surfaceContainerHighest" to n(0xFFE2E2E2, 0.06),
            )
            ThemeMode.DARK, ThemeMode.BLACK -> {
                val common = mapOf(
                    "onBackground" to n(0xFFECECEC, 0.03),
                    "onSurface" to n(0xFFECECEC, 0.03),
                    "surfaceVariant" to n(0xFF454549, 0.08),
                    "onSurfaceVariant" to n(0xFFC6C6CA, 0.06),
                    "inverseSurface" to n(0xFFECECEC, 0.03),
                    "inverseOnSurface" to n(0xFF303030, 0.05),
                    "outline" to n(0xFF909094, 0.06),
                    "outlineVariant" to n(0xFF454549, 0.06),
                )
                common + if (mode == ThemeMode.DARK) mapOf(
                    "background" to n(0xFF131313, 0.04),
                    "surface" to n(0xFF131313, 0.04),
                    "surfaceDim" to n(0xFF131313, 0.04),
                    "surfaceBright" to n(0xFF393939, 0.06),
                    "surfaceContainerLowest" to n(0xFF0E0E0E, 0.03),
                    "surfaceContainerLow" to n(0xFF1B1B1B, 0.05),
                    "surfaceContainer" to n(0xFF1F1F1F, 0.06),
                    "surfaceContainerHigh" to n(0xFF2A2A2A, 0.06),
                    "surfaceContainerHighest" to n(0xFF353535, 0.06),
                ) else mapOf(
                    "background" to BLACK,
                    "surface" to BLACK,
                    "surfaceDim" to BLACK,
                    "surfaceBright" to n(0xFF303030, 0.05),
                    "surfaceContainerLowest" to BLACK,
                    "surfaceContainerLow" to n(0xFF101010, 0.04),
                    "surfaceContainer" to n(0xFF171717, 0.05),
                    "surfaceContainerHigh" to n(0xFF212121, 0.05),
                    "surfaceContainerHighest" to n(0xFF2B2B2B, 0.05),
                )
            }
        }
        return accentRoles + neutrals + semantic(dark)
    }

    /** Tertiary (an orange) and error: the same in every palette. */
    private fun semantic(dark: Boolean): Map<String, Long> = if (!dark) mapOf(
        "tertiary" to 0xFF804300,
        "onTertiary" to WHITE,
        "tertiaryContainer" to 0xFFFFDCC3,
        "onTertiaryContainer" to 0xFF6E3900,
        "error" to 0xFFBA1A1A,
        "onError" to WHITE,
        "errorContainer" to 0xFFFFDAD6,
        "onErrorContainer" to 0xFF93000A,
        "scrim" to BLACK,
    ) else mapOf(
        "tertiary" to 0xFFFFB77E,
        "onTertiary" to 0xFF4D2600,
        "tertiaryContainer" to 0xFF6E3900,
        "onTertiaryContainer" to 0xFFFFDCC3,
        "error" to 0xFFFFB4AB,
        "onError" to 0xFF690005,
        "errorContainer" to 0xFF93000A,
        "onErrorContainer" to 0xFFFFDAD6,
        "scrim" to BLACK,
    )

    /** `a` moved `amount` (0 to 1) of the way to `b`, per sRGB channel; opaque. */
    fun mix(a: Long, b: Long, amount: Double): Long {
        fun ch(c: Long, shift: Int) = ((c shr shift) and 0xFF).toDouble()
        fun at(shift: Int) = Math.round(ch(a, shift) + (ch(b, shift) - ch(a, shift)) * amount).coerceIn(0, 255)
        return 0xFF000000L or (at(16) shl 16) or (at(8) shl 8) or at(0)
    }

    /** WCAG 2 contrast ratio of two opaque ARGB colours (1 to 21). */
    fun contrast(a: Long, b: Long): Double {
        val la = luminance(a)
        val lb = luminance(b)
        return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
    }

    fun luminance(argb: Long): Double {
        fun channel(shift: Int): Double {
            val c = ((argb shr shift) and 0xFF).toDouble() / 255.0
            return if (c <= 0.04045) c / 12.92 else ((c + 0.055) / 1.055).pow(2.4)
        }
        return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0)
    }
}

/** Whether 「テーマの色」 applies to the workspace on screen only or to every workspace (the desktop's `ThemeScope`). */
enum class ThemeScope { WORKSPACE, ALL }

/**
 * 「テーマの色」 and 「ダークを真っ黒にする」, kept on this device (not on the server). One choice for every workspace
 * (`theme.palette`, none = the default) and, with two or more workspaces, each workspace's own (`theme.palette.workspaces`,
 * a JSON object keyed by the workspace's list key, its server URL) that wins over it. As the desktop: choosing for every
 * workspace drops the workspaces' own choices.
 */
object ThemePrefs {
    private const val PALETTE_KEY = "theme.palette"
    private const val WORKSPACES_KEY = "theme.palette.workspaces"
    private const val BLACK_KEY = "theme.black"

    fun global(store: KeyValueStore): ThemePalette = ThemePalette.of(store.getString(PALETTE_KEY)) ?: ThemePalette.DEFAULT

    private fun owns(store: KeyValueStore): Map<String, ThemePalette> {
        val raw = store.getString(WORKSPACES_KEY) ?: return emptyMap()
        val obj = runCatching { Codec.snake.parseToJsonElement(raw).jsonObject }.getOrNull() ?: return emptyMap()
        return obj.mapNotNull { (k, v) -> runCatching { ThemePalette.of(v.jsonPrimitive.content) }.getOrNull()?.let { k to it } }.toMap()
    }

    private fun writeOwns(store: KeyValueStore, owns: Map<String, ThemePalette>) =
        store.putString(WORKSPACES_KEY, if (owns.isEmpty()) null else JsonObject(owns.mapValues { JsonPrimitive(it.value.key) }).toString())

    /** The workspace's own choice, if it has one. */
    fun own(store: KeyValueStore, workspace: String?): ThemePalette? = workspace?.let { owns(store)[it] }

    /** The palette a workspace shows: its own, else the one for every workspace. */
    fun palette(store: KeyValueStore, workspace: String?): ThemePalette = own(store, workspace) ?: global(store)

    fun scope(store: KeyValueStore, workspace: String?): ThemeScope = if (own(store, workspace) != null) ThemeScope.WORKSPACE else ThemeScope.ALL

    /** [ThemeScope.WORKSPACE] without a workspace writes the choice for every workspace. */
    fun write(store: KeyValueStore, palette: ThemePalette, scope: ThemeScope, workspace: String?) {
        if (scope == ThemeScope.WORKSPACE && workspace != null) {
            writeOwns(store, owns(store) + (workspace to palette))
        } else {
            store.putString(PALETTE_KEY, if (palette == ThemePalette.DEFAULT) null else palette.key)
            writeOwns(store, emptyMap())
        }
    }

    fun black(store: KeyValueStore): Boolean = store.getString(BLACK_KEY) == "on"

    /** Off leaves no key behind. */
    fun writeBlack(store: KeyValueStore, on: Boolean) = store.putString(BLACK_KEY, if (on) "on" else null)
}
