package jp.chikuwachat.android.ui

import android.app.Activity
import androidx.core.graphics.drawable.toDrawable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat

/**
 * M40 / 2026-10-27: the scheme of a palette in a mode (ThemeColors). The wallpaper's colours (dynamic colour) are not
 * used: the app looks the same on every phone, in the palette chosen in 「表示」.
 */
fun themeColorScheme(palette: ThemePalette, mode: ThemeMode): ColorScheme {
    val p = ThemeColors.roles(palette, mode)
    fun c(role: String) = Color(p.getValue(role))
    return if (mode != ThemeMode.LIGHT) {
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

/**
 * `appearance` (M40 「表示」): the system's light / dark, or always one of them; `black` (「ダークを真っ黒にする」) whenever
 * dark is shown; `palette` (「テーマの色」) the workspace on screen's.
 */
@Composable
fun ChikuwaTheme(
    appearance: Appearance = Appearance.SYSTEM,
    palette: ThemePalette = ThemePalette.DEFAULT,
    black: Boolean = false,
    content: @Composable () -> Unit,
) {
    val dark = appearance.isDark(isSystemInDarkTheme())
    val mode = when {
        !dark -> ThemeMode.LIGHT
        black -> ThemeMode.BLACK
        else -> ThemeMode.DARK
    }
    val scheme = remember(palette, mode) { themeColorScheme(palette, mode) }
    // The status and navigation bars are see-through (edge to edge): their icons follow the app's appearance, not only
    // the system's, and the window behind the app (seen while a screen or the keyboard animates) is the canvas.
    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            val window = (view.context as? Activity)?.window ?: return@SideEffect
            WindowCompat.getInsetsController(window, view).apply {
                isAppearanceLightStatusBars = !dark
                isAppearanceLightNavigationBars = !dark
            }
            window.setBackgroundDrawable(scheme.background.toArgb().toDrawable())
        }
    }
    MaterialTheme(colorScheme = scheme, content = content)
}
