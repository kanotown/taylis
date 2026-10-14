package jp.chikuwachat.android.widget

import android.os.Build
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AlternateEmail
import androidx.compose.material.icons.filled.CheckBoxOutlineBlank
import androidx.compose.material.icons.filled.DoneAll
import androidx.compose.material.icons.filled.EventAvailable
import androidx.compose.material.icons.filled.Group
import androidx.compose.material.icons.filled.Tag
import androidx.compose.material.icons.filled.TaskAlt
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.ColorFilter
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.action.Action
import androidx.glance.action.clickable
import androidx.glance.appwidget.appWidgetBackground
import androidx.glance.appwidget.cornerRadius
import androidx.glance.background
import androidx.glance.color.ColorProvider
import androidx.glance.color.ColorProviders
import androidx.glance.color.DynamicThemeColorProviders
import androidx.glance.color.colorProviders
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.ColumnScope
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.layout.width
import androidx.glance.semantics.contentDescription
import androidx.glance.semantics.semantics
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextAlign
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import jp.chikuwachat.android.R
import jp.chikuwachat.android.app.Workspaces
import jp.chikuwachat.android.platform.ConversationStyle
import jp.chikuwachat.android.ui.BrandPalette
import jp.chikuwachat.android.ui.Timeline
import kotlinx.coroutines.flow.MutableStateFlow

/**
 * What the three home-screen widgets share, so they read as one family: Material You colours (the wallpaper's dynamic
 * colours from Android 12, the app's brand palette before), the system's widget corner radius, one frame with the same
 * padding, one header (the workspace's initial on a small tile + its name, an optional note on the right), avatars in
 * the app's colours, tinted pills and icons.
 */
internal object WidgetLook {
    val PAD_H = 16.dp
    val PAD_V = 14.dp
    /** One-row widgets (a 2×1 / 4×1 cell is about 100 dp high): a little less above and below. */
    val PAD_V_SHORT = 12.dp
    val HEADER = 20.dp
    /** Below this height a widget is a one-row one. */
    val SHORT_BELOW = 130.dp

    private fun brand(role: String): ColorProvider = ColorProvider(
        day = Color(BrandPalette.light.getValue(role)), night = Color(BrandPalette.dark.getValue(role)),
    )

    /** Before Android 12 (no dynamic colours): the app's own palette, day and night. */
    val fallback: ColorProviders by lazy {
        colorProviders(
            primary = brand("primary"), onPrimary = brand("onPrimary"),
            primaryContainer = brand("primaryContainer"), onPrimaryContainer = brand("onPrimaryContainer"),
            secondary = brand("secondary"), onSecondary = brand("onSecondary"),
            secondaryContainer = brand("secondaryContainer"), onSecondaryContainer = brand("onSecondaryContainer"),
            tertiary = brand("tertiary"), onTertiary = brand("onTertiary"),
            tertiaryContainer = brand("tertiaryContainer"), onTertiaryContainer = brand("onTertiaryContainer"),
            error = brand("error"), errorContainer = brand("errorContainer"),
            onError = brand("onError"), onErrorContainer = brand("onErrorContainer"),
            background = brand("background"), onBackground = brand("onBackground"),
            surface = brand("surface"), onSurface = brand("onSurface"),
            surfaceVariant = brand("surfaceVariant"), onSurfaceVariant = brand("onSurfaceVariant"),
            outline = brand("outline"), inverseOnSurface = brand("inverseOnSurface"),
            inverseSurface = brand("inverseSurface"), inversePrimary = brand("inversePrimary"),
            widgetBackground = brand("surfaceContainer"),
        )
    }

    val colors: ColorProviders get() = if (Build.VERSION.SDK_INT >= 31) DynamicThemeColorProviders else fallback

    /** Moved when everything a widget says must be read again (the app's language changed). */
    val epoch = MutableStateFlow(0)

    fun recompose() {
        epoch.value += 1
    }

    /** Overdue / failed red that reads on the widget's background in both modes. */
    val OVERDUE: ColorProvider = ColorProvider(day = Color(0xFFC62828), night = Color(0xFFFF8A80))
}

/**
 * The widgets' theme. Their words are read when they are composed, and a running widget recomposes only when its data
 * changes: a new app language moves [WidgetLook.epoch], which composes them again from scratch.
 */
@Composable
internal fun WidgetTheme(content: @Composable () -> Unit) {
    val epoch by WidgetLook.epoch.collectAsState()
    key(epoch) { GlanceTheme(colors = WidgetLook.colors, content = content) }
}

/** A rounded fill: Glance's corner radius from Android 12, a tinted rounded drawable before (where it does nothing). */
internal fun GlanceModifier.rounded(color: ColorProvider, radius: Dp): GlanceModifier =
    if (Build.VERSION.SDK_INT >= 31) background(color).cornerRadius(radius)
    else background(ImageProvider(roundDrawable(radius)), colorFilter = ColorFilter.tint(color))

private fun roundDrawable(radius: Dp): Int = when {
    radius <= 8.dp -> R.drawable.widget_round_s
    radius <= 14.dp -> R.drawable.widget_round_m
    radius <= 24.dp -> R.drawable.widget_round_l
    else -> R.drawable.widget_round_full
}

/** A pill or circle (half the height). */
internal fun GlanceModifier.pill(color: ColorProvider): GlanceModifier = rounded(color, 999.dp)

/**
 * The widget's whole surface: the widget background colour with the system's widget radius (Android 12+), the same
 * padding everywhere; a tap anywhere not on a button or row does [open].
 */
@Composable
internal fun WidgetFrame(open: Action, label: String, short: Boolean, content: @Composable ColumnScope.() -> Unit) {
    val base = GlanceModifier.fillMaxSize().appWidgetBackground()
    val shaped = if (Build.VERSION.SDK_INT >= 31) {
        base.background(GlanceTheme.colors.widgetBackground).cornerRadius(android.R.dimen.system_app_widget_background_radius)
    } else {
        base.background(ImageProvider(R.drawable.widget_round_l), colorFilter = ColorFilter.tint(GlanceTheme.colors.widgetBackground))
    }
    Column(
        shaped.clickable(open).semantics { contentDescription = label }
            .padding(horizontal = WidgetLook.PAD_H, vertical = if (short) WidgetLook.PAD_V_SHORT else WidgetLook.PAD_V),
        content = content,
    )
}

/**
 * The header every widget starts with: the workspace's initial on a small primary tile and its name; on the right an
 * optional [note] (a count, the day) or, after a failure, 「更新できません」 in red.
 */
@Composable
internal fun WidgetHeader(workspace: String, note: String? = null, noteColor: ColorProvider? = null, stale: Boolean = false) {
    Row(GlanceModifier.fillMaxWidth().height(WidgetLook.HEADER), verticalAlignment = Alignment.CenterVertically) {
        val initials = Workspaces.initials(workspace).ifEmpty { "T" }
        Box(GlanceModifier.size(18.dp).rounded(GlanceTheme.colors.primary, 5.dp), contentAlignment = Alignment.Center) {
            Text(
                initials, maxLines = 1,
                style = TextStyle(color = GlanceTheme.colors.onPrimary, fontSize = if (initials.length > 1) 8.sp else 10.sp, fontWeight = FontWeight.Bold),
            )
        }
        Spacer(GlanceModifier.width(7.dp))
        Text(
            workspace, maxLines = 1, modifier = GlanceModifier.defaultWeight(),
            style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 12.sp, fontWeight = FontWeight.Medium),
        )
        when {
            stale -> Text(
                jp.chikuwachat.android.L10n.str(R.string.widget_stale), maxLines = 1,
                style = TextStyle(color = GlanceTheme.colors.error, fontSize = 11.sp, fontWeight = FontWeight.Medium),
            )
            note != null -> Text(
                note, maxLines = 1,
                style = TextStyle(color = noteColor ?: GlanceTheme.colors.onSurfaceVariant, fontSize = 12.sp, fontWeight = FontWeight.Medium),
            )
        }
    }
}

/** A widget that has nothing to draw yet (signed out, loading, off): the header when known, an icon and one line. */
@Composable
internal fun WidgetNotice(workspace: String?, text: String, icon: ImageVector? = null) {
    if (workspace != null) WidgetHeader(workspace)
    Column(
        GlanceModifier.fillMaxSize(),
        verticalAlignment = Alignment.CenterVertically, horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        if (icon != null) {
            WidgetIcon(icon, 24.dp, GlanceTheme.colors.onSurfaceVariant)
            Spacer(GlanceModifier.height(6.dp))
        }
        Text(text, maxLines = 2, style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 13.sp, textAlign = TextAlign.Center))
    }
}

/** One of the widgets' Material icons, tinted. */
@Composable
internal fun WidgetIcon(vector: ImageVector, size: Dp, tint: ColorProvider) {
    Image(
        ImageProvider(WidgetIcons.bitmap(vector.name, vector)), contentDescription = null,
        modifier = GlanceModifier.size(size), colorFilter = ColorFilter.tint(tint),
    )
}

internal object WidgetGlyphs {
    val channel: ImageVector get() = Icons.Filled.Tag
    val group: ImageVector get() = Icons.Filled.Group
    val mention: ImageVector get() = Icons.Filled.AlternateEmail
    val task: ImageVector get() = Icons.Filled.CheckBoxOutlineBlank
    val noEvents: ImageVector get() = Icons.Filled.EventAvailable
    val allRead: ImageVector get() = Icons.Filled.DoneAll
    val tasksDone: ImageVector get() = Icons.Filled.TaskAlt
}

/** A person's picture-less avatar as the app draws it: their initials on hsl(hue of their id, 55%, 45%). */
@Composable
internal fun WidgetAvatar(id: String, name: String, size: Dp, ring: Dp = 0.dp) {
    val face = ColorProvider(Color(ConversationStyle.colorFor(id)))
    // Small faces (a pile) take one letter: two would not read where the next face overlaps.
    val initials = Timeline.initials(name).let { if (size < 28.dp) it.take(1) else it }
    val text: TextUnit = (size.value * if (initials.length > 1) 0.34f else 0.46f).sp
    val inner = @Composable {
        Box(GlanceModifier.size(size).pill(face), contentAlignment = Alignment.Center) {
            Text(initials, maxLines = 1, style = TextStyle(color = ColorProvider(Color.White), fontSize = text, fontWeight = FontWeight.Bold))
        }
    }
    if (ring > 0.dp) {
        // The ring in the widget's own colour parts overlapping faces (a face pile).
        Box(GlanceModifier.size(size + ring * 2).pill(GlanceTheme.colors.widgetBackground), contentAlignment = Alignment.Center) { inner() }
    } else {
        inner()
    }
}

/**
 * A face pile: up to [max] faces overlapping by a fifth, then 「+n」 for the rest of [total] (a Box draws at most 10
 * children: [max] is at most 8).
 */
@Composable
internal fun FacePile(people: List<WidgetPerson>, total: Int, max: Int, size: Dp) {
    val ring = 2.dp
    val step = size * 0.78f
    val shown = people.take(max.coerceIn(0, 8))
    val more = total - shown.size
    Box {
        shown.forEachIndexed { index, person ->
            Box(GlanceModifier.padding(start = step * index)) { WidgetAvatar(person.id, person.name, size, ring) }
        }
        if (more > 0) {
            Box(GlanceModifier.padding(start = step * shown.size)) {
                Box(GlanceModifier.size(size + ring * 2).pill(GlanceTheme.colors.widgetBackground), contentAlignment = Alignment.Center) {
                    Box(GlanceModifier.size(size).pill(GlanceTheme.colors.secondaryContainer), contentAlignment = Alignment.Center) {
                        Text(
                            "+$more", maxLines = 1,
                            style = TextStyle(color = GlanceTheme.colors.onSecondaryContainer, fontSize = (size.value * 0.38f).sp, fontWeight = FontWeight.Bold),
                        )
                    }
                }
            }
        }
    }
}

/** A count pill (the app's red badge): 「3」, or 「@3」 for a channel's mentions. */
@Composable
internal fun CountPill(text: String) {
    Box(
        GlanceModifier.pill(GlanceTheme.colors.error).padding(horizontal = 7.dp, vertical = 1.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(text, maxLines = 1, style = TextStyle(color = GlanceTheme.colors.onError, fontSize = 11.sp, fontWeight = FontWeight.Bold))
    }
}

/** A gap that takes what is left (pushes the next element to the far end of a Row or Column). */
@Composable
internal fun ColumnScope.Fill() = Spacer(GlanceModifier.defaultWeight())

/** The plain secondary line under a big element. */
@Composable
internal fun SecondaryText(text: String, modifier: GlanceModifier = GlanceModifier, size: Int = 12) {
    Text(text, modifier = modifier, maxLines = 1, style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = size.sp))
}
