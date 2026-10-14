package jp.chikuwachat.android.widget

import android.content.Context
import android.content.Intent
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.DpSize
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
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.action.ActionCallback
import androidx.glance.appwidget.action.actionRunCallback
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.provideContent
import androidx.glance.color.ColorProvider
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.ColumnScope
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
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
import jp.chikuwachat.android.L10n
import jp.chikuwachat.android.MainActivity
import jp.chikuwachat.android.R
import jp.chikuwachat.android.app.Workspaces
import jp.chikuwachat.android.platform.Notifier
import jp.chikuwachat.android.ui.AttendanceBadgeColors
import jp.chikuwachat.android.ui.AttendanceIcons
import jp.chikuwachat.android.ui.TextEmojiPill

/**
 * 在室状況 on the home screen (docs/PRESENCE.md §1–§9). Draws [AttendanceWidgetData]'s snapshot of the widget's workspace
 * ([WidgetWorkspaces]: its own choice, else the one on screen in the app): my state as a tinted badge, who is in the
 * room (a face pile, or faces with names when wide and tall), 「在室 n 人」, and buttons.
 *
 * Sizes: compact (2×1, 2×2) with one toggle between 在室 and 帰宅 ([AttendanceWidgetRules.toggle]) filled with the
 * colour of the state it goes to; wide (4×1, 4×2) with my states as buttons, as many as fit
 * ([AttendanceWidgetRules.wideButtons]): my state filled with its colour, the others tonal. A button sets my state at
 * once on the widget and asks the app to send it ([SetAttendanceAction] → [AttendanceWidgetWorker]); the rest of the
 * widget opens 「在室状況」 in the app, in the widget's workspace.
 */
class AttendanceWidget : GlanceAppWidget() {
    // Exact: drawn for the size the launcher gives (a 4×1 cell is 70–110 dp high depending on the launcher), so the
    // layout and the number of buttons follow the real width and height instead of the nearest of a few fixed sizes.
    override val sizeMode: SizeMode = SizeMode.Exact

    override val previewSizeMode = SizeMode.Responsive(WidgetPreviews.SIZES)

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val appWidgetId = WidgetWorkspaces.appWidgetId(context, id) ?: -1
        val snapshots = AttendanceWidgetData.flow(context)
        val workspaces = WidgetWorkspaces.flow(context)
        provideContent {
            val all by snapshots.collectAsState()
            val chosen by workspaces.collectAsState()
            val key = chosen.resolve(appWidgetId)
            WidgetTheme { AttendanceBody(context, key, key?.let { all[it] }, key?.let { chosen.names[it] }) }
        }
    }

    override suspend fun providePreview(context: Context, widgetCategory: Int) {
        provideContent { WidgetTheme { AttendanceBody(context, WidgetPreviews.SERVER, WidgetPreviews.attendance(), null) } }
    }

    companion object {
        /** From this width the wide layout (my states as buttons), below it the compact one (one toggle). */
        val WIDE_FROM = 200.dp
        /** From this height the tall layouts (a row of named buttons, or the named toggle under my state). */
        val TALL_FROM = WidgetLook.SHORT_BELOW
        /** From this height the wide and tall layout names the people in the room under their faces. */
        val NAMES_FROM = 200.dp

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

    override fun onDeleted(context: Context, appWidgetIds: IntArray) {
        super.onDeleted(context, appWidgetIds)
        WidgetWorkspaces.deleted(context, appWidgetIds)
    }
}

/** A state button: drawn as my state at once (the optimistic update), then sent by the app ([AttendanceWidgetWorker]). */
class SetAttendanceAction : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        val stateId = parameters[STATE] ?: return
        val server = parameters[SERVER] ?: return
        val now = System.currentTimeMillis()
        var pressed: AttendanceWidgetSnapshot? = null
        val changed = AttendanceWidgetData.store.update(context, server) { old ->
            old?.let { AttendanceWidgetRules.pressed(it, stateId, now) }?.also { pressed = it } ?: old
        }
        val snapshot = pressed ?: return
        if (changed) AttendanceWidgetData.redraw(context)
        AttendanceWidgetWorker.enqueue(context, snapshot.serverUrl, snapshot.meId, stateId)
    }

    companion object {
        val STATE = ActionParameters.Key<String>("state_id")
        val SERVER = ActionParameters.Key<String>("server")
    }
}

// --- drawing ---------------------------------------------------------------------------------------

private fun solid(color: String): ColorProvider = androidx.glance.unit.ColorProvider(Color(0xFF000000L or AttendanceBadgeColors.solid(color)))

private val WHITE = androidx.glance.unit.ColorProvider(Color.White)

private fun palette(color: String) = TextEmojiPill.PALETTE[color] ?: TextEmojiPill.PALETTE.getValue("gray")

/** A tonal button or badge: the state's colour as a light (dark at night) container. */
private fun tonal(color: String): ColorProvider =
    ColorProvider(day = Color(0xFF000000L or palette(color).first.first), night = Color(0xFF000000L or palette(color).second.first))

/** What goes on [tonal]: the state's colour as text. */
private fun onTonal(color: String): ColorProvider =
    ColorProvider(day = Color(0xFF000000L or palette(color).first.second), night = Color(0xFF000000L or palette(color).second.second))

@Composable
private fun AttendanceBody(context: Context, key: String?, snapshot: AttendanceWidgetSnapshot?, name: String?) {
    val size = LocalSize.current
    val wide = size.width >= AttendanceWidget.WIDE_FROM
    val tall = size.height >= AttendanceWidget.TALL_FROM
    val open = actionStartActivity(AttendanceWidget.openIntent(context, snapshot?.serverUrl ?: key))
    // TalkBack: the whole picture in one line (the buttons are read on their own), then what a tap does.
    val openLabel = when {
        key == null -> L10n.str(R.string.attendance_widget_sign_in)
        snapshot == null -> L10n.str(R.string.widget_loading)
        !snapshot.enabled -> snapshot.workspaceName + " " + L10n.str(R.string.attendance_widget_off)
        else -> L10n.str(R.string.attendance_widget_open, snapshot.workspaceName, stateLabel(snapshot), countLabel(snapshot)) +
            if (snapshot.failed) " " + L10n.str(R.string.attendance_widget_stale) else ""
    }
    WidgetFrame(open, openLabel, short = !tall) {
        when {
            key == null -> WidgetNotice(null, L10n.str(R.string.attendance_widget_sign_in))
            snapshot == null -> WidgetNotice(name ?: Workspaces.hostLabel(key), L10n.str(R.string.widget_loading))
            !snapshot.enabled -> WidgetNotice(snapshot.workspaceName, L10n.str(R.string.attendance_widget_off))
            wide && tall -> WideTall(snapshot)
            wide -> WideShort(snapshot)
            tall -> CompactTall(snapshot)
            else -> CompactShort(snapshot)
        }
    }
}

private fun stateLabel(snapshot: AttendanceWidgetSnapshot): String = snapshot.shownState?.label ?: L10n.str(R.string.attendance_unset)

private fun countLabel(snapshot: AttendanceWidgetSnapshot): String = L10n.str(R.string.attendance_in_room, snapshot.inRoomCount)

/** The state's picture: its icon in [tint], else its emoji (a custom `:name:` one is left out), else nothing. */
@Composable
private fun Glyph(state: WidgetState, size: Dp, tint: ColorProvider) {
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

private fun hasGlyph(state: WidgetState) = AttendanceIcons.glyph(state.icon, state.emoji) != AttendanceIcons.Glyph.None

/** My state's square badge: its icon in white on its solid colour (a plain square while I have none). */
@Composable
private fun Badge(state: WidgetState?, size: Dp) {
    Box(
        GlanceModifier.size(size).rounded(state?.let { solid(it.color) } ?: GlanceTheme.colors.surfaceVariant, size * 0.3f),
        contentAlignment = Alignment.Center,
    ) {
        if (state != null) Glyph(state, size * 0.56f, WHITE)
    }
}

/** My state as a tinted badge: its icon and name in its colour on a light container of it. */
@Composable
private fun StateChip(state: WidgetState?) {
    val bg = state?.let { tonal(it.color) } ?: GlanceTheme.colors.surfaceVariant
    val fg = state?.let { onTonal(it.color) } ?: GlanceTheme.colors.onSurfaceVariant
    Row(
        GlanceModifier.height(26.dp).pill(bg).padding(start = if (state != null && hasGlyph(state)) 8.dp else 10.dp, end = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (state != null && hasGlyph(state)) {
            Glyph(state, 15.dp, fg)
            Spacer(GlanceModifier.width(5.dp))
        }
        Text(state?.label ?: L10n.str(R.string.attendance_unset), maxLines = 1, style = TextStyle(color = fg, fontSize = 13.sp, fontWeight = FontWeight.Bold))
    }
}

/** Who is in the room: their faces (and 「+n」), or 「在室中の人はいません」. */
@Composable
private fun PeopleLine(snapshot: AttendanceWidgetSnapshot, max: Int, size: Dp, withCount: Boolean) {
    val faces = snapshot.faces
    if (faces.isEmpty()) {
        SecondaryText(L10n.str(R.string.attendance_widget_nobody), size = 11)
        return
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        FacePile(faces, snapshot.inRoomCount.coerceAtLeast(faces.size), max, size)
        if (withCount) {
            Spacer(GlanceModifier.width(8.dp))
            SecondaryText(countLabel(snapshot))
        }
    }
}

private fun pressAction(state: WidgetState, server: String) =
    actionRunCallback<SetAttendanceAction>(actionParametersOf(SetAttendanceAction.STATE to state.id, SetAttendanceAction.SERVER to server))

private fun buttonLabel(state: WidgetState) = L10n.str(R.string.attendance_widget_set, state.label)

/**
 * A round icon button: [filled] with the state's colour (my current state on the wide layouts; the state the compact
 * toggle goes to), tonal otherwise.
 */
@Composable
private fun RoundButton(state: WidgetState, server: String, size: Dp, filled: Boolean) {
    val label = buttonLabel(state)
    Box(
        GlanceModifier.size(size).pill(if (filled) solid(state.color) else tonal(state.color))
            .clickable(pressAction(state, server))
            .semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        if (hasGlyph(state)) {
            Glyph(state, size * 0.5f, if (filled) WHITE else onTonal(state.color))
        } else {
            Text(state.label.take(1), style = TextStyle(color = if (filled) WHITE else onTonal(state.color), fontSize = 15.sp, fontWeight = FontWeight.Bold))
        }
    }
}

/** 2×1: the header; my state's badge over who is in the room; the toggle (filled with its target's colour). */
@Composable
private fun ColumnScope.CompactShort(snapshot: AttendanceWidgetSnapshot) {
    WidgetHeader(snapshot.workspaceName, stale = snapshot.failed)
    Spacer(GlanceModifier.defaultWeight())
    Row(GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(GlanceModifier.defaultWeight()) {
            StateChip(snapshot.shownState)
            Spacer(GlanceModifier.height(6.dp))
            PeopleLine(snapshot, max = 3, size = 18.dp, withCount = false)
        }
        AttendanceWidgetRules.toggle(snapshot)?.let {
            Spacer(GlanceModifier.width(8.dp))
            RoundButton(it.state, snapshot.serverUrl, 46.dp, filled = true)
        }
    }
}

/** 2×2: the header; my state large; who is in the room; the toggle as a wide button with its name. */
@Composable
private fun ColumnScope.CompactTall(snapshot: AttendanceWidgetSnapshot) {
    WidgetHeader(snapshot.workspaceName, stale = snapshot.failed)
    Spacer(GlanceModifier.height(14.dp))
    MineRow(snapshot)
    Spacer(GlanceModifier.height(14.dp))
    PeopleLine(snapshot, max = 4, size = 24.dp, withCount = false)
    Spacer(GlanceModifier.defaultWeight())
    AttendanceWidgetRules.toggle(snapshot)?.let { button ->
        val state = button.state
        val label = buttonLabel(state)
        Row(
            GlanceModifier.fillMaxWidth().height(44.dp).pill(solid(state.color))
                .clickable(pressAction(state, snapshot.serverUrl)).semantics { contentDescription = label },
            verticalAlignment = Alignment.CenterVertically,
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            if (hasGlyph(state)) {
                Glyph(state, 18.dp, WHITE)
                Spacer(GlanceModifier.width(8.dp))
            }
            Text(state.label, style = TextStyle(color = WHITE, fontSize = 15.sp, fontWeight = FontWeight.Medium), maxLines = 1)
        }
    }
}

/** My state's square badge with its name large and 「在室 n 人」 (and my note) under it. */
@Composable
private fun MineRow(snapshot: AttendanceWidgetSnapshot) {
    Row(GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Badge(snapshot.shownState, 44.dp)
        Spacer(GlanceModifier.width(12.dp))
        Column(GlanceModifier.defaultWeight()) {
            Text(stateLabel(snapshot), maxLines = 1, style = TextStyle(color = GlanceTheme.colors.onSurface, fontSize = 19.sp, fontWeight = FontWeight.Bold))
            val note = snapshot.myNote?.takeIf { it.isNotBlank() && snapshot.pendingStateId == null }
            SecondaryText(listOfNotNull(note, countLabel(snapshot)).joinToString(" · "))
        }
    }
}

/** 4×1: the header with 「在室 n 人」; my state's badge over the faces on the left, my states as round buttons on the right. */
@Composable
private fun ColumnScope.WideShort(snapshot: AttendanceWidgetSnapshot) {
    val count = AttendanceWidgetRules.wideButtonCount(LocalSize.current.width.value, tall = false)
    WidgetHeader(snapshot.workspaceName, note = countLabel(snapshot), stale = snapshot.failed)
    Spacer(GlanceModifier.defaultWeight())
    Row(GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(GlanceModifier.defaultWeight()) {
            StateChip(snapshot.shownState)
            Spacer(GlanceModifier.height(6.dp))
            PeopleLine(snapshot, max = 4, size = 18.dp, withCount = false)
        }
        // One child per button (a Row draws at most 10 children; spacers would count too).
        AttendanceWidgetRules.wideButtons(snapshot, count).forEach {
            Box(GlanceModifier.padding(start = 6.dp)) { RoundButton(it.state, snapshot.serverUrl, 42.dp, filled = it.selected) }
        }
    }
}

/** 4×2: the header; my state large; the people in the room (named when there is room); a row of my states. */
@Composable
private fun ColumnScope.WideTall(snapshot: AttendanceWidgetSnapshot) {
    val size = LocalSize.current
    val count = AttendanceWidgetRules.wideButtonCount(size.width.value, tall = true)
    WidgetHeader(snapshot.workspaceName, stale = snapshot.failed)
    Spacer(GlanceModifier.height(12.dp))
    MineRow(snapshot)
    Spacer(GlanceModifier.defaultWeight())
    if (size.height >= AttendanceWidget.NAMES_FROM && snapshot.faces.isNotEmpty()) {
        NamedFaces(snapshot, size.width.value)
    } else {
        PeopleLine(snapshot, max = 6, size = 24.dp, withCount = false)
    }
    Spacer(GlanceModifier.defaultWeight())
    Row(GlanceModifier.fillMaxWidth()) {
        val buttons = AttendanceWidgetRules.wideButtons(snapshot, count)
        buttons.forEachIndexed { index, button ->
            Box(GlanceModifier.defaultWeight().padding(start = if (index > 0) 6.dp else 0.dp)) {
                LabelButton(button, snapshot.serverUrl, GlanceModifier.fillMaxWidth())
            }
        }
    }
}

/** The people in the room with their names under their faces (as many as fit, then 「+n」). */
@Composable
private fun NamedFaces(snapshot: AttendanceWidgetSnapshot, widthDp: Float) {
    val faces = snapshot.faces
    val total = snapshot.inRoomCount.coerceAtLeast(faces.size)
    val fit = AttendanceWidgetRules.namedFacesThatFit(widthDp - 32f, total)
    val shown = faces.take(fit)
    Row(GlanceModifier.fillMaxWidth()) {
        shown.forEach { person ->
            Column(GlanceModifier.width(AttendanceWidgetRules.NAMED_FACE_DP.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                WidgetAvatar(person.id, person.name, 30.dp)
                Spacer(GlanceModifier.height(3.dp))
                Text(
                    AttendanceWidgetRules.shortName(person.name), maxLines = 1,
                    style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 10.sp, textAlign = TextAlign.Center),
                )
            }
        }
        if (total > shown.size) {
            Column(GlanceModifier.width(AttendanceWidgetRules.NAMED_FACE_DP.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                Box(GlanceModifier.size(30.dp).pill(GlanceTheme.colors.secondaryContainer), contentAlignment = Alignment.Center) {
                    Text("+${total - shown.size}", maxLines = 1, style = TextStyle(color = GlanceTheme.colors.onSecondaryContainer, fontSize = 11.sp, fontWeight = FontWeight.Bold))
                }
            }
        }
    }
}

/** A button with the icon over the name (4×2): filled with the state's colour when it is mine, tonal otherwise. */
@Composable
private fun LabelButton(button: WidgetButton, server: String, modifier: GlanceModifier) {
    val state = button.state
    val label = buttonLabel(state)
    val fg = if (button.selected) WHITE else onTonal(state.color)
    Column(
        modifier.height(54.dp)
            .rounded(if (button.selected) solid(state.color) else tonal(state.color), 16.dp)
            .clickable(pressAction(state, server))
            .semantics { contentDescription = label },
        verticalAlignment = Alignment.CenterVertically,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        if (hasGlyph(state)) Glyph(state, 20.dp, fg)
        Text(state.label, maxLines = 1, style = TextStyle(color = fg, fontSize = 12.sp, fontWeight = FontWeight.Medium))
    }
}
