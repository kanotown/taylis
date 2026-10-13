package jp.chikuwachat.android.widget

import android.content.Context
import android.content.Intent
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.ColorFilter
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.LocalSize
import androidx.glance.action.ActionParameters
import androidx.glance.action.actionParametersOf
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.action.ActionCallback
import androidx.glance.appwidget.action.actionRunCallback
import androidx.glance.appwidget.appWidgetBackground
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.color.ColorProvider
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
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
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import jp.chikuwachat.android.L10n
import jp.chikuwachat.android.MainActivity
import jp.chikuwachat.android.R
import jp.chikuwachat.android.platform.Notifier
import jp.chikuwachat.android.ui.AttendanceBadgeColors
import jp.chikuwachat.android.ui.AttendanceIcons

/**
 * 在室状況 on the home screen (docs/PRESENCE.md §1–§9). Draws [AttendanceWidgetData]'s snapshot of the workspace on screen
 * in the app: my state as the app shows it (its icon on its solid colour, its name), 「在室 n 人」 and the workspace's name.
 *
 * Sizes: compact (2×1, 2×2) with one toggle button between 在室 and 帰宅 ([AttendanceWidgetRules.toggle]); wide (4×1,
 * 4×2) with my states as buttons, as many as fit ([AttendanceWidgetRules.wideButtons]). A button sets my state at once
 * on the widget and asks the app to send it ([SetAttendanceAction] → [AttendanceWidgetWorker]); the rest of the widget
 * opens 「在室状況」 in the app.
 */
class AttendanceWidget : GlanceAppWidget() {
    // Exact: drawn for the size the launcher gives (a 4×1 cell is 70–110 dp high depending on the launcher), so the
    // layout and the number of buttons follow the real width and height instead of the nearest of a few fixed sizes.
    override val sizeMode: SizeMode = SizeMode.Exact

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val flow = AttendanceWidgetData.flow(context)
        provideContent {
            val snapshot by flow.collectAsState()
            GlanceTheme { WidgetBody(context, snapshot) }
        }
    }

    companion object {
        /** From this width the wide layout (my states as buttons), below it the compact one (one toggle). */
        val WIDE_FROM = 200.dp
        /** From this height the tall layouts (a row of named buttons, or the named toggle under my state). */
        val TALL_FROM = 130.dp

        /** MainActivity's extra: open 「在室状況」 (with Notifier.EXTRA_WORKSPACE, the widget's workspace). */
        const val EXTRA_OPEN = "jp.chikuwachat.android.extra.ATTENDANCE_WIDGET"
        private const val ACTION_OPEN = "jp.chikuwachat.android.action.OPEN_ATTENDANCE"

        fun openIntent(context: Context, serverUrl: String?): Intent = Intent(context, MainActivity::class.java).apply {
            action = ACTION_OPEN
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra(EXTRA_OPEN, true)
            if (serverUrl != null) putExtra(Notifier.EXTRA_WORKSPACE, serverUrl)
        }
    }
}

class AttendanceWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = AttendanceWidget()
}

/** A state button: drawn as my state at once (the optimistic update), then sent by the app ([AttendanceWidgetWorker]). */
class SetAttendanceAction : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        val stateId = parameters[STATE] ?: return
        val now = System.currentTimeMillis()
        var pressed: AttendanceWidgetSnapshot? = null
        val changed = AttendanceWidgetData.update(context) { old ->
            old?.let { AttendanceWidgetRules.pressed(it, stateId, now) }?.also { pressed = it } ?: old
        }
        val snapshot = pressed ?: return
        if (changed) AttendanceWidgetData.redraw(context)
        AttendanceWidgetWorker.enqueue(context, snapshot.serverUrl, snapshot.meId, stateId)
    }

    companion object {
        val STATE = ActionParameters.Key<String>("state_id")
    }
}

// --- drawing ---------------------------------------------------------------------------------------

private fun solid(color: String): ColorProvider = ColorProvider(Color(0xFF000000L or AttendanceBadgeColors.solid(color)))

private val WHITE = ColorProvider(Color.White)

/** An unpressed button's icon: the state's colour, lighter on a dark home screen (AttendanceBadgeColors.glyphTint). */
private fun tint(color: String): ColorProvider = ColorProvider(
    day = Color(0xFF000000L or AttendanceBadgeColors.glyphTint(color, solid = false, dark = false)),
    night = Color(0xFF000000L or AttendanceBadgeColors.glyphTint(color, solid = false, dark = true)),
)

@Composable
private fun WidgetBody(context: Context, snapshot: AttendanceWidgetSnapshot?) {
    val size = LocalSize.current
    val wide = size.width >= AttendanceWidget.WIDE_FROM
    val tall = size.height >= AttendanceWidget.TALL_FROM
    val open = actionStartActivity(AttendanceWidget.openIntent(context, snapshot?.serverUrl))
    // TalkBack: the whole picture in one line (the buttons are read on their own), then what a tap does.
    val openLabel = when {
        snapshot == null -> L10n.str(R.string.attendance_widget_sign_in)
        !snapshot.enabled -> snapshot.workspaceName + " " + L10n.str(R.string.attendance_widget_off)
        else -> L10n.str(R.string.attendance_widget_open, snapshot.workspaceName, stateLabel(snapshot), countLabel(snapshot)) +
            if (snapshot.failed) " " + L10n.str(R.string.attendance_widget_stale) else ""
    }
    Box(
        GlanceModifier.fillMaxSize().appWidgetBackground().background(GlanceTheme.colors.widgetBackground).cornerRadius(16.dp)
            .clickable(open).semantics { contentDescription = openLabel }
            .padding(horizontal = 10.dp, vertical = 6.dp),
        contentAlignment = Alignment.CenterStart,
    ) {
        when {
            snapshot == null -> Message(L10n.str(R.string.attendance_widget_sign_in), null)
            !snapshot.enabled -> Message(L10n.str(R.string.attendance_widget_off), snapshot.workspaceName)
            wide && tall -> WideTall(snapshot)
            wide -> WideShort(snapshot)
            tall -> CompactTall(snapshot)
            else -> CompactShort(snapshot)
        }
    }
}

@Composable
private fun Message(text: String, workspace: String?) {
    Column {
        if (workspace != null) SmallLine(workspace)
        Text(text, style = TextStyle(color = GlanceTheme.colors.onSurface, fontSize = 13.sp), maxLines = 2)
    }
}

/** The workspace's name, or 「更新できません」 after a failure. */
@Composable
private fun TopLine(snapshot: AttendanceWidgetSnapshot) {
    if (snapshot.failed) {
        Text(L10n.str(R.string.attendance_widget_stale), style = TextStyle(color = GlanceTheme.colors.error, fontSize = 11.sp, fontWeight = FontWeight.Medium), maxLines = 1)
    } else {
        SmallLine(snapshot.workspaceName)
    }
}

@Composable
private fun SmallLine(text: String) {
    Text(text, style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 11.sp), maxLines = 1)
}

private fun stateLabel(snapshot: AttendanceWidgetSnapshot): String = snapshot.shownState?.label ?: L10n.str(R.string.attendance_unset)

private fun countLabel(snapshot: AttendanceWidgetSnapshot): String = L10n.str(R.string.attendance_in_room, snapshot.inRoomCount)

/** The state's picture: its icon in [tint], else its emoji (a custom `:name:` one is left out), else nothing. */
@Composable
private fun Glyph(state: WidgetState, size: androidx.compose.ui.unit.Dp, tint: ColorProvider) {
    when (val glyph = AttendanceIcons.glyph(state.icon, state.emoji)) {
        is AttendanceIcons.Glyph.Icon -> WidgetIcons.bitmap(glyph.key)?.let {
            Image(ImageProvider(it), contentDescription = null, modifier = GlanceModifier.size(size), colorFilter = ColorFilter.tint(tint))
        }
        is AttendanceIcons.Glyph.Emoji -> if (!glyph.text.startsWith(":")) {
            Text(glyph.text, style = TextStyle(fontSize = (size.value * 0.8f).sp), maxLines = 1)
        }
        AttendanceIcons.Glyph.None -> Unit
    }
}

/** My state's badge: its icon in white on its solid colour (a grey outline-less square while I have none). */
@Composable
private fun Badge(state: WidgetState?, size: androidx.compose.ui.unit.Dp) {
    Box(
        GlanceModifier.size(size).background(state?.let { solid(it.color) } ?: GlanceTheme.colors.surfaceVariant).cornerRadius(size / 4),
        contentAlignment = Alignment.Center,
    ) {
        if (state != null) Glyph(state, size * 0.6f, WHITE)
    }
}

/** My state and the count beside the badge. */
@Composable
private fun MineColumn(snapshot: AttendanceWidgetSnapshot, modifier: GlanceModifier = GlanceModifier) {
    Column(modifier) {
        TopLine(snapshot)
        Text(stateLabel(snapshot), style = TextStyle(color = GlanceTheme.colors.onSurface, fontSize = 15.sp, fontWeight = FontWeight.Bold), maxLines = 1)
        Text(countLabel(snapshot), style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 12.sp), maxLines = 1)
    }
}

private fun pressAction(state: WidgetState) = actionRunCallback<SetAttendanceAction>(actionParametersOf(SetAttendanceAction.STATE to state.id))

private fun buttonLabel(state: WidgetState) = L10n.str(R.string.attendance_widget_set, state.label)

/** A round icon button (the short layouts): filled with the state's colour when it is mine, else its icon in its colour. */
@Composable
private fun RoundButton(button: WidgetButton, size: androidx.compose.ui.unit.Dp) {
    val state = button.state
    val label = buttonLabel(state)
    Box(
        GlanceModifier.size(size)
            .background(if (button.selected) solid(state.color) else GlanceTheme.colors.secondaryContainer)
            .cornerRadius(size / 2)
            .clickable(pressAction(state))
            .semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        Glyph(state, size * 0.55f, if (button.selected) WHITE else tint(state.color))
        if (AttendanceIcons.glyph(state.icon, state.emoji) == AttendanceIcons.Glyph.None) {
            Text(state.label.take(1), style = TextStyle(color = if (button.selected) WHITE else GlanceTheme.colors.onSecondaryContainer, fontSize = 14.sp, fontWeight = FontWeight.Bold))
        }
    }
}

/** 2×1: the badge, my state with the workspace's name and the count, and the toggle as a round button. */
@Composable
private fun CompactShort(snapshot: AttendanceWidgetSnapshot) {
    Row(GlanceModifier.fillMaxSize(), verticalAlignment = Alignment.CenterVertically) {
        Badge(snapshot.shownState, 32.dp)
        Spacer(GlanceModifier.width(8.dp))
        MineColumn(snapshot, GlanceModifier.defaultWeight())
        AttendanceWidgetRules.toggle(snapshot)?.let {
            Spacer(GlanceModifier.width(4.dp))
            RoundButton(it, 36.dp)
        }
    }
}

/** 2×2: the workspace, the badge with my state, the count, and the toggle as a wide button with its name. */
@Composable
private fun CompactTall(snapshot: AttendanceWidgetSnapshot) {
    Column(GlanceModifier.fillMaxSize().padding(vertical = 4.dp)) {
        TopLine(snapshot)
        Spacer(GlanceModifier.height(4.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            Badge(snapshot.shownState, 36.dp)
            Spacer(GlanceModifier.width(8.dp))
            Column(GlanceModifier.defaultWeight()) {
                Text(stateLabel(snapshot), style = TextStyle(color = GlanceTheme.colors.onSurface, fontSize = 16.sp, fontWeight = FontWeight.Bold), maxLines = 1)
                Text(countLabel(snapshot), style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 12.sp), maxLines = 1)
            }
        }
        Spacer(GlanceModifier.defaultWeight())
        AttendanceWidgetRules.toggle(snapshot)?.let { button ->
            val state = button.state
            val label = buttonLabel(state)
            Row(
                GlanceModifier.fillMaxWidth().height(40.dp).background(solid(state.color)).cornerRadius(20.dp)
                    .clickable(pressAction(state)).semantics { contentDescription = label },
                verticalAlignment = Alignment.CenterVertically,
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                Glyph(state, 18.dp, WHITE)
                Spacer(GlanceModifier.width(6.dp))
                Text(state.label, style = TextStyle(color = WHITE, fontSize = 14.sp, fontWeight = FontWeight.Medium), maxLines = 1)
            }
        }
    }
}

/** 4×1: the badge and my state on the left, my states as round buttons on the right. */
@Composable
private fun WideShort(snapshot: AttendanceWidgetSnapshot) {
    val count = AttendanceWidgetRules.wideButtonCount(LocalSize.current.width.value, tall = false)
    Row(GlanceModifier.fillMaxSize(), verticalAlignment = Alignment.CenterVertically) {
        Badge(snapshot.shownState, 36.dp)
        Spacer(GlanceModifier.width(8.dp))
        MineColumn(snapshot, GlanceModifier.defaultWeight())
        // One child per button (a Row draws at most 10 children; spacers would count too).
        AttendanceWidgetRules.wideButtons(snapshot, count).forEach {
            Box(GlanceModifier.padding(start = 4.dp)) { RoundButton(it, 40.dp) }
        }
    }
}

/** 4×2: my state and the count above, a row of my states (icon over name) below. */
@Composable
private fun WideTall(snapshot: AttendanceWidgetSnapshot) {
    val count = AttendanceWidgetRules.wideButtonCount(LocalSize.current.width.value, tall = true)
    Column(GlanceModifier.fillMaxSize().padding(vertical = 4.dp)) {
        Row(GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Badge(snapshot.shownState, 36.dp)
            Spacer(GlanceModifier.width(8.dp))
            MineColumn(snapshot, GlanceModifier.defaultWeight())
        }
        Spacer(GlanceModifier.defaultWeight())
        Row(GlanceModifier.fillMaxWidth()) {
            val buttons = AttendanceWidgetRules.wideButtons(snapshot, count)
            buttons.forEachIndexed { index, button ->
                Box(GlanceModifier.defaultWeight().padding(start = if (index > 0) 4.dp else 0.dp)) {
                    LabelButton(button, GlanceModifier.fillMaxWidth())
                }
            }
        }
    }
}

/** A button with the icon over the name (4×2): filled with the state's colour when it is mine. */
@Composable
private fun LabelButton(button: WidgetButton, modifier: GlanceModifier) {
    val state = button.state
    val label = buttonLabel(state)
    Column(
        modifier.height(52.dp)
            .background(if (button.selected) solid(state.color) else GlanceTheme.colors.secondaryContainer)
            .cornerRadius(12.dp)
            .clickable(pressAction(state))
            .semantics { contentDescription = label },
        verticalAlignment = Alignment.CenterVertically,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Glyph(state, 20.dp, if (button.selected) WHITE else tint(state.color))
        Text(
            state.label, maxLines = 1,
            style = TextStyle(color = if (button.selected) WHITE else GlanceTheme.colors.onSecondaryContainer, fontSize = 11.sp, fontWeight = FontWeight.Medium),
        )
    }
}
