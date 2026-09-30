package jp.chikuwachat.android.ui

import android.app.Activity
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow

/**
 * M40 (ROADMAP の既定, IMPLEMENTATION_PLAN.md M40 (4)): the brand colour #5b5bd6 on every client. The roles are
 * Material 3's scheme for that seed (the "fidelity" variant of material-color-utilities, so the brand keeps its
 * chroma), with one change in light: `primary` is the brand itself (white on it is 5.4:1) and its container the tone-90
 * lavender. The wallpaper's colours (dynamic colour) are not used: the app looks the same on every phone.
 * ARGB values, so the contrast rules are checked on the JVM (ThemeTest).
 */
object BrandPalette {
    const val BRAND = 0xFF5B5BD6

    val light: Map<String, Long> = mapOf(
        "primary" to BRAND,
        "onPrimary" to 0xFFFFFFFF,
        "primaryContainer" to 0xFFE2DFFF,
        "onPrimaryContainer" to 0xFF3533B0,
        "inversePrimary" to 0xFFC1C1FF,
        "secondary" to 0xFF5A5A8A,
        "onSecondary" to 0xFFFFFFFF,
        "secondaryContainer" to 0xFFE2DFFF,
        "onSecondaryContainer" to 0xFF424270,
        "tertiary" to 0xFF804300,
        "onTertiary" to 0xFFFFFFFF,
        "tertiaryContainer" to 0xFFFFDCC3,
        "onTertiaryContainer" to 0xFF6E3900,
        "background" to 0xFFFCF8FF,
        "onBackground" to 0xFF1B1B22,
        "surface" to 0xFFFCF8FF,
        "onSurface" to 0xFF1B1B22,
        "surfaceVariant" to 0xFFE3E0F2,
        "onSurfaceVariant" to 0xFF464553,
        "surfaceTint" to BRAND,
        "inverseSurface" to 0xFF303038,
        "inverseOnSurface" to 0xFFF2EFFA,
        "error" to 0xFFBA1A1A,
        "onError" to 0xFFFFFFFF,
        "errorContainer" to 0xFFFFDAD6,
        "onErrorContainer" to 0xFF93000A,
        "outline" to 0xFF777585,
        "outlineVariant" to 0xFFC7C4D6,
        "scrim" to 0xFF000000,
        "surfaceBright" to 0xFFFCF8FF,
        "surfaceContainer" to 0xFFF0ECF7,
        "surfaceContainerHigh" to 0xFFEAE6F1,
        "surfaceContainerHighest" to 0xFFE4E1EC,
        "surfaceContainerLow" to 0xFFF5F2FD,
        "surfaceContainerLowest" to 0xFFFFFFFF,
        "surfaceDim" to 0xFFDCD8E3,
    )

    val dark: Map<String, Long> = mapOf(
        "primary" to 0xFFC1C1FF,
        "onPrimary" to 0xFF1B119B,
        "primaryContainer" to BRAND,
        "onPrimaryContainer" to 0xFFFFFFFF,
        "inversePrimary" to 0xFF4E4EC9,
        "secondary" to 0xFFC2C2F8,
        "onSecondary" to 0xFF2B2C58,
        "secondaryContainer" to 0xFF464775,
        "onSecondaryContainer" to 0xFFE2DFFF,
        "tertiary" to 0xFFFFB77E,
        "onTertiary" to 0xFF4D2600,
        "tertiaryContainer" to 0xFF6E3900,
        "onTertiaryContainer" to 0xFFFFDCC3,
        "background" to 0xFF13131A,
        "onBackground" to 0xFFE4E1EC,
        "surface" to 0xFF13131A,
        "onSurface" to 0xFFE4E1EC,
        "surfaceVariant" to 0xFF464553,
        "onSurfaceVariant" to 0xFFC7C4D6,
        "surfaceTint" to 0xFFC1C1FF,
        "inverseSurface" to 0xFFE4E1EC,
        "inverseOnSurface" to 0xFF303038,
        "error" to 0xFFFFB4AB,
        "onError" to 0xFF690005,
        "errorContainer" to 0xFF93000A,
        "onErrorContainer" to 0xFFFFDAD6,
        "outline" to 0xFF918F9F,
        "outlineVariant" to 0xFF464553,
        "scrim" to 0xFF000000,
        "surfaceBright" to 0xFF393841,
        "surfaceContainer" to 0xFF1F1F27,
        "surfaceContainerHigh" to 0xFF2A2931,
        "surfaceContainerHighest" to 0xFF34343C,
        "surfaceContainerLow" to 0xFF1B1B22,
        "surfaceContainerLowest" to 0xFF0E0D15,
        "surfaceDim" to 0xFF13131A,
    )

    fun palette(dark: Boolean): Map<String, Long> = if (dark) this.dark else light

    /** WCAG 2 contrast ratio of two opaque ARGB colours (1 to 21). */
    fun contrast(a: Long, b: Long): Double {
        val la = luminance(a)
        val lb = luminance(b)
        return (max(la, lb) + 0.05) / (min(la, lb) + 0.05)
    }

    private fun luminance(argb: Long): Double {
        fun channel(shift: Int): Double {
            val c = ((argb shr shift) and 0xFF).toDouble() / 255.0
            return if (c <= 0.04045) c / 12.92 else ((c + 0.055) / 1.055).pow(2.4)
        }
        return 0.2126 * channel(16) + 0.7152 * channel(8) + 0.0722 * channel(0)
    }
}

private fun scheme(dark: Boolean): ColorScheme {
    val p = BrandPalette.palette(dark)
    fun c(role: String) = Color(p.getValue(role))
    return if (dark) {
        darkColorScheme(
            primary = c("primary"),
            onPrimary = c("onPrimary"),
            primaryContainer = c("primaryContainer"),
            onPrimaryContainer = c("onPrimaryContainer"),
            inversePrimary = c("inversePrimary"),
            secondary = c("secondary"),
            onSecondary = c("onSecondary"),
            secondaryContainer = c("secondaryContainer"),
            onSecondaryContainer = c("onSecondaryContainer"),
            tertiary = c("tertiary"),
            onTertiary = c("onTertiary"),
            tertiaryContainer = c("tertiaryContainer"),
            onTertiaryContainer = c("onTertiaryContainer"),
            background = c("background"),
            onBackground = c("onBackground"),
            surface = c("surface"),
            onSurface = c("onSurface"),
            surfaceVariant = c("surfaceVariant"),
            onSurfaceVariant = c("onSurfaceVariant"),
            surfaceTint = c("surfaceTint"),
            inverseSurface = c("inverseSurface"),
            inverseOnSurface = c("inverseOnSurface"),
            error = c("error"),
            onError = c("onError"),
            errorContainer = c("errorContainer"),
            onErrorContainer = c("onErrorContainer"),
            outline = c("outline"),
            outlineVariant = c("outlineVariant"),
            scrim = c("scrim"),
            surfaceBright = c("surfaceBright"),
            surfaceContainer = c("surfaceContainer"),
            surfaceContainerHigh = c("surfaceContainerHigh"),
            surfaceContainerHighest = c("surfaceContainerHighest"),
            surfaceContainerLow = c("surfaceContainerLow"),
            surfaceContainerLowest = c("surfaceContainerLowest"),
            surfaceDim = c("surfaceDim"),
        )
    } else {
        lightColorScheme(
            primary = c("primary"),
            onPrimary = c("onPrimary"),
            primaryContainer = c("primaryContainer"),
            onPrimaryContainer = c("onPrimaryContainer"),
            inversePrimary = c("inversePrimary"),
            secondary = c("secondary"),
            onSecondary = c("onSecondary"),
            secondaryContainer = c("secondaryContainer"),
            onSecondaryContainer = c("onSecondaryContainer"),
            tertiary = c("tertiary"),
            onTertiary = c("onTertiary"),
            tertiaryContainer = c("tertiaryContainer"),
            onTertiaryContainer = c("onTertiaryContainer"),
            background = c("background"),
            onBackground = c("onBackground"),
            surface = c("surface"),
            onSurface = c("onSurface"),
            surfaceVariant = c("surfaceVariant"),
            onSurfaceVariant = c("onSurfaceVariant"),
            surfaceTint = c("surfaceTint"),
            inverseSurface = c("inverseSurface"),
            inverseOnSurface = c("inverseOnSurface"),
            error = c("error"),
            onError = c("onError"),
            errorContainer = c("errorContainer"),
            onErrorContainer = c("onErrorContainer"),
            outline = c("outline"),
            outlineVariant = c("outlineVariant"),
            scrim = c("scrim"),
            surfaceBright = c("surfaceBright"),
            surfaceContainer = c("surfaceContainer"),
            surfaceContainerHigh = c("surfaceContainerHigh"),
            surfaceContainerHighest = c("surfaceContainerHighest"),
            surfaceContainerLow = c("surfaceContainerLow"),
            surfaceContainerLowest = c("surfaceContainerLowest"),
            surfaceDim = c("surfaceDim"),
        )
    }
}

private val LightScheme = scheme(dark = false)
private val DarkScheme = scheme(dark = true)

/** `appearance` (M40 「表示」): the system's light / dark, or always one of them. */
@Composable
fun ChikuwaTheme(appearance: Appearance = Appearance.SYSTEM, content: @Composable () -> Unit) {
    val dark = appearance.isDark(isSystemInDarkTheme())
    // The status and navigation bars' icons follow the app's appearance, not only the system's.
    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            val window = (view.context as? Activity)?.window ?: return@SideEffect
            WindowCompat.getInsetsController(window, view).apply {
                isAppearanceLightStatusBars = !dark
                isAppearanceLightNavigationBars = !dark
            }
        }
    }
    MaterialTheme(colorScheme = if (dark) DarkScheme else LightScheme, content = content)
}
