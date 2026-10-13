package jp.chikuwachat.android.widget

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.LocalSize
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.appWidgetBackground
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.width
import androidx.glance.semantics.contentDescription
import androidx.glance.semantics.semantics
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import jp.chikuwachat.android.L10n
import jp.chikuwachat.android.R

/**
 * 未読・メンション on the home screen: the app icon's number for the workspace on screen ([UnreadWidgetSnapshot]: my
 * mentions in channels and unread DMs, by the app's own rule), with the workspace's name, and — when there is room —
 * the conversations that make it up, newest first (name and number; never a message).
 *
 * Sizes (exact, as the launcher gives them): compact (2×1) the number, its parts and the workspace; tall (2×2 and up)
 * and wide (4×1, 4×2) add as many conversation rows as fit. A row opens its conversation (as its notification would);
 * anywhere else opens the app on its home tab, in the widget's workspace.
 */
class UnreadWidget : GlanceAppWidget() {
    override val sizeMode: SizeMode = SizeMode.Exact

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val flow = UnreadWidgetData.flow(context)
        provideContent {
            val snapshot by flow.collectAsState()
            GlanceTheme { UnreadBody(context, snapshot) }
        }
    }

    companion object {
        val WIDE_FROM = 200.dp
        val TALL_FROM = 110.dp
        /** Most rows drawn (a Column draws at most 10 children: the rows have a Column of their own). */
        const val MAX_SHOWN = 10
        const val ROW_DP = 26f
    }
}

class UnreadWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = UnreadWidget()
}

@Composable
private fun UnreadBody(context: Context, snapshot: UnreadWidgetSnapshot?) {
    val size = LocalSize.current
    val wide = size.width >= UnreadWidget.WIDE_FROM
    val tall = size.height >= UnreadWidget.TALL_FROM
    val open = actionStartActivity(WidgetLinks.intent(context, WidgetLink.Screen(snapshot?.serverUrl, WidgetScreen.HOME)))
    val label = when (snapshot) {
        null -> L10n.str(R.string.widget_sign_in)
        else -> L10n.str(R.string.unread_widget_open, snapshot.workspaceName, snapshot.total)
    }
    Box(
        GlanceModifier.fillMaxSize().appWidgetBackground().background(GlanceTheme.colors.widgetBackground).cornerRadius(16.dp)
            .clickable(open).semantics { contentDescription = label }
            .padding(horizontal = 12.dp, vertical = 8.dp),
        contentAlignment = Alignment.TopStart,
    ) {
        when {
            snapshot == null -> WidgetMessage(L10n.str(R.string.widget_sign_in), null)
            wide && !tall -> UnreadWideShort(context, snapshot)
            wide || tall -> UnreadList(context, snapshot, size.height.value)
            else -> UnreadCompact(snapshot)
        }
    }
}

/** A short text in the middle of the widget (signed out), with the workspace's name above when known. */
@Composable
internal fun WidgetMessage(text: String, workspace: String?) {
    Column(GlanceModifier.fillMaxSize(), verticalAlignment = Alignment.CenterVertically) {
        if (workspace != null) WidgetSmallLine(workspace)
        Text(text, style = TextStyle(color = GlanceTheme.colors.onSurface, fontSize = 13.sp), maxLines = 2)
    }
}

@Composable
internal fun WidgetSmallLine(text: String, modifier: GlanceModifier = GlanceModifier) {
    Text(text, modifier = modifier, style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 11.sp), maxLines = 1)
}

/** 「メンション 2・DM 3」, or 「未読はありません」. */
private fun partsText(snapshot: UnreadWidgetSnapshot): String =
    if (snapshot.total == 0) L10n.str(R.string.unread_widget_none) else L10n.str(R.string.unread_widget_parts, snapshot.mentions, snapshot.dms)

/** The big number: red-ish (the app's badge) while anything is waiting. */
@Composable
private fun BigNumber(snapshot: UnreadWidgetSnapshot, fontSize: Int) {
    Text(
        UnreadWidgetRules.countText(snapshot.total), maxLines = 1,
        style = TextStyle(
            color = if (snapshot.total > 0) GlanceTheme.colors.error else GlanceTheme.colors.onSurfaceVariant,
            fontSize = fontSize.sp, fontWeight = FontWeight.Bold,
        ),
    )
}

/** 2×1: the number with its parts and the workspace beside it. */
@Composable
private fun UnreadCompact(snapshot: UnreadWidgetSnapshot) {
    Row(GlanceModifier.fillMaxSize(), verticalAlignment = Alignment.CenterVertically) {
        BigNumber(snapshot, 30)
        Spacer(GlanceModifier.width(10.dp))
        Column(GlanceModifier.defaultWeight()) {
            WidgetSmallLine(snapshot.workspaceName)
            Text(partsText(snapshot), style = TextStyle(color = GlanceTheme.colors.onSurface, fontSize = 12.sp), maxLines = 2)
        }
    }
}

/** 4×1: the number on the left, the newest two conversations on the right. */
@Composable
private fun UnreadWideShort(context: Context, snapshot: UnreadWidgetSnapshot) {
    Row(GlanceModifier.fillMaxSize(), verticalAlignment = Alignment.CenterVertically) {
        Column(GlanceModifier.width(104.dp)) {
            WidgetSmallLine(snapshot.workspaceName)
            BigNumber(snapshot, 26)
            Text(partsText(snapshot), style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 10.sp), maxLines = 1)
        }
        Spacer(GlanceModifier.width(8.dp))
        Column(GlanceModifier.defaultWeight()) {
            snapshot.rows.take(2).forEach { ConversationRow(context, snapshot, it) }
        }
    }
}

/** 2×2, 4×2 and taller: the number and its parts above, then as many conversations as fit, then 「ほか n 件」. */
@Composable
private fun UnreadList(context: Context, snapshot: UnreadWidgetSnapshot, heightDp: Float) {
    val fit = UnreadWidgetRules.rowsThatFit(heightDp, usedDp = 16f + 50f + 16f, rowDp = UnreadWidget.ROW_DP, max = UnreadWidget.MAX_SHOWN)
    val rows = snapshot.rows.take(fit)
    val more = snapshot.conversations - rows.size
    Column(GlanceModifier.fillMaxSize()) {
        Row(GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            BigNumber(snapshot, 28)
            Spacer(GlanceModifier.width(10.dp))
            Column(GlanceModifier.defaultWeight()) {
                WidgetSmallLine(snapshot.workspaceName)
                Text(partsText(snapshot), style = TextStyle(color = GlanceTheme.colors.onSurface, fontSize = 12.sp), maxLines = 1)
            }
        }
        Spacer(GlanceModifier.height(4.dp))
        Column(GlanceModifier.fillMaxWidth()) { rows.forEach { ConversationRow(context, snapshot, it) } }
        if (more > 0 && rows.isNotEmpty()) WidgetSmallLine(L10n.str(R.string.widget_more, more), GlanceModifier.padding(top = 2.dp))
    }
}

/** A conversation: its name and its number (a red pill, as the app's badge); a tap opens it. */
@Composable
private fun ConversationRow(context: Context, snapshot: UnreadWidgetSnapshot, row: UnreadRow) {
    val label = L10n.str(R.string.unread_widget_row, row.title, row.count)
    val open = actionStartActivity(WidgetLinks.intent(context, WidgetLink.Conversation(snapshot.serverUrl, row.channelId)))
    Row(
        GlanceModifier.fillMaxWidth().height(UnreadWidget.ROW_DP.dp).cornerRadius(8.dp).clickable(open)
            .semantics { contentDescription = label },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            row.title, modifier = GlanceModifier.defaultWeight(), maxLines = 1,
            style = TextStyle(color = GlanceTheme.colors.onSurface, fontSize = 13.sp, fontWeight = FontWeight.Medium),
        )
        Spacer(GlanceModifier.width(6.dp))
        Box(
            GlanceModifier.background(GlanceTheme.colors.error).cornerRadius(9.dp).padding(horizontal = 6.dp, vertical = 1.dp),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                UnreadWidgetRules.countText(row.count), maxLines = 1,
                style = TextStyle(color = GlanceTheme.colors.onError, fontSize = 11.sp, fontWeight = FontWeight.Bold),
            )
        }
    }
}
