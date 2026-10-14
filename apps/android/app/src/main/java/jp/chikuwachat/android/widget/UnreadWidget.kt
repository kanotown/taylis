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
import androidx.glance.appwidget.lazy.LazyColumn
import androidx.glance.appwidget.lazy.items
import androidx.glance.appwidget.provideContent
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
import androidx.glance.text.TextStyle
import jp.chikuwachat.android.L10n
import jp.chikuwachat.android.R
import jp.chikuwachat.android.app.Workspaces

/**
 * 未読・メンション on the home screen: the app icon's number for the widget's workspace ([UnreadWidgetSnapshot]: my
 * mentions in channels and unread DMs, by the app's own rule; [WidgetWorkspaces]: the widget's own choice, else the one
 * on screen in the app), large with 「未読」 and its parts (「@3・DM 4」), and — when there is room — the conversations
 * that make it up, newest first (a kind mark or the person's face, the name, a count pill; never a message).
 *
 * Sizes (exact, as the launcher gives them): 2×1 the number; 2×2 the number over a list; 4×1 the number beside the two
 * newest; 4×2 and up the number beside a scrolling list. A row opens its conversation (as its notification would);
 * anywhere else opens the app on its home tab, in the widget's workspace.
 */
class UnreadWidget : GlanceAppWidget() {
    override val sizeMode: SizeMode = SizeMode.Exact

    override val previewSizeMode = SizeMode.Responsive(WidgetPreviews.SIZES)

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val appWidgetId = WidgetWorkspaces.appWidgetId(context, id) ?: -1
        val snapshots = UnreadWidgetData.flow(context)
        val workspaces = WidgetWorkspaces.flow(context)
        provideContent {
            val all by snapshots.collectAsState()
            val chosen by workspaces.collectAsState()
            val key = chosen.resolve(appWidgetId)
            WidgetTheme { UnreadBody(context, key, key?.let { all[it] }, key?.let { chosen.names[it] }) }
        }
    }

    override suspend fun providePreview(context: Context, widgetCategory: Int) {
        provideContent { WidgetTheme { UnreadBody(context, WidgetPreviews.SERVER, WidgetPreviews.unread(), null) } }
    }

    companion object {
        val WIDE_FROM = 200.dp
        val TALL_FROM = WidgetLook.SHORT_BELOW
        /** The number's column beside the list (wide). */
        val NUMBER_COLUMN = 104.dp
        const val ROW_DP = 34f
    }
}

class UnreadWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = UnreadWidget()

    override fun onDeleted(context: Context, appWidgetIds: IntArray) {
        super.onDeleted(context, appWidgetIds)
        WidgetWorkspaces.deleted(context, appWidgetIds)
    }
}

@Composable
private fun UnreadBody(context: Context, key: String?, snapshot: UnreadWidgetSnapshot?, name: String?) {
    val size = LocalSize.current
    val wide = size.width >= UnreadWidget.WIDE_FROM
    val tall = size.height >= UnreadWidget.TALL_FROM
    val open = actionStartActivity(WidgetLinks.intent(context, WidgetLink.Screen(snapshot?.serverUrl ?: key, WidgetScreen.HOME)))
    val label = when {
        key == null -> L10n.str(R.string.widget_sign_in)
        snapshot == null -> L10n.str(R.string.widget_loading)
        else -> L10n.str(R.string.unread_widget_open, snapshot.workspaceName, snapshot.total)
    }
    WidgetFrame(open, label, short = !tall) {
        when {
            key == null -> WidgetNotice(null, L10n.str(R.string.widget_sign_in))
            snapshot == null -> WidgetNotice(name ?: Workspaces.hostLabel(key), L10n.str(R.string.widget_loading))
            wide && tall -> UnreadWideTall(context, snapshot)
            wide -> UnreadWideShort(context, snapshot)
            tall -> UnreadTall(context, snapshot)
            else -> UnreadCompact(snapshot)
        }
    }
}

/** 「@2・DM 3」, 「未読なし」, or nothing when a summary's number does not say how it splits. */
private fun partsText(snapshot: UnreadWidgetSnapshot): String? = when {
    snapshot.total == 0 -> L10n.str(R.string.widget_unread_none_short)
    !snapshot.partsKnown -> null
    else -> L10n.str(R.string.widget_unread_parts_short, snapshot.mentions, snapshot.dms)
}

/** The big number with 「未読」 and its parts beside it. */
@Composable
private fun NumberBlock(snapshot: UnreadWidgetSnapshot, fontSize: Int, stacked: Boolean) {
    val number = @Composable {
        Text(
            UnreadWidgetRules.countText(snapshot.total), maxLines = 1,
            style = TextStyle(
                color = if (snapshot.total > 0) GlanceTheme.colors.primary else GlanceTheme.colors.onSurfaceVariant,
                fontSize = fontSize.sp, fontWeight = FontWeight.Bold,
            ),
        )
    }
    val words = @Composable {
        Text(L10n.str(R.string.widget_unread_label), maxLines = 1, style = TextStyle(color = GlanceTheme.colors.onSurface, fontSize = 13.sp, fontWeight = FontWeight.Medium))
        partsText(snapshot)?.let { SecondaryText(it) }
    }
    if (stacked) {
        Column {
            number()
            words()
        }
    } else {
        Row(verticalAlignment = Alignment.CenterVertically) {
            number()
            Spacer(GlanceModifier.width(10.dp))
            Column { words() }
        }
    }
}

/** 2×1: the header, then the number with 「未読」 and its parts, and the newest conversations' marks on the right. */
@Composable
private fun ColumnScope.UnreadCompact(snapshot: UnreadWidgetSnapshot) {
    WidgetHeader(snapshot.workspaceName)
    Spacer(GlanceModifier.defaultWeight())
    Row(GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Box(GlanceModifier.defaultWeight()) { NumberBlock(snapshot, 34, stacked = false) }
        val marks = if (LocalSize.current.width >= 230.dp) 2 else 1
        snapshot.rows.take(marks).forEach { Box(GlanceModifier.padding(start = 4.dp)) { RowMark(it) } }
    }
}

/** 2×2: the header, the number, then the conversations (a scrolling list). */
@Composable
private fun ColumnScope.UnreadTall(context: Context, snapshot: UnreadWidgetSnapshot) {
    WidgetHeader(snapshot.workspaceName)
    Spacer(GlanceModifier.height(8.dp))
    NumberBlock(snapshot, 34, stacked = false)
    Spacer(GlanceModifier.height(8.dp))
    Conversations(context, snapshot)
}

/** 4×1: the header, the number on the left and the two newest conversations on the right. */
@Composable
private fun ColumnScope.UnreadWideShort(context: Context, snapshot: UnreadWidgetSnapshot) {
    WidgetHeader(snapshot.workspaceName)
    Spacer(GlanceModifier.height(4.dp))
    Row(GlanceModifier.fillMaxWidth().defaultWeight(), verticalAlignment = Alignment.CenterVertically) {
        Box(GlanceModifier.width(UnreadWidget.NUMBER_COLUMN)) { NumberBlock(snapshot, 30, stacked = false) }
        Column(GlanceModifier.defaultWeight()) {
            if (snapshot.rows.isEmpty()) {
                AllRead(snapshot)
            } else {
                snapshot.rows.take(2).forEach { ConversationRow(context, snapshot, it, height = 28) }
            }
        }
    }
}

/** 4×2 and up: the header, the number on the left, the conversations on the right (a scrolling list). */
@Composable
private fun ColumnScope.UnreadWideTall(context: Context, snapshot: UnreadWidgetSnapshot) {
    WidgetHeader(snapshot.workspaceName)
    Spacer(GlanceModifier.height(10.dp))
    // Few conversations: the number and the rows centred in the room (no scrolling list with a gap under it).
    val fit = UnreadWidgetRules.rowsThatFit(LocalSize.current.height.value, usedDp = 28f + 20f + 10f, rowDp = UnreadWidget.ROW_DP, max = 9)
    val few = snapshot.rows.size + (if (snapshot.conversations > snapshot.rows.size) 1 else 0) <= fit
    Row(GlanceModifier.fillMaxWidth().defaultWeight(), verticalAlignment = if (few) Alignment.CenterVertically else Alignment.Top) {
        Box(GlanceModifier.width(UnreadWidget.NUMBER_COLUMN)) { NumberBlock(snapshot, 40, stacked = true) }
        Column(GlanceModifier.defaultWeight()) {
            if (few && snapshot.rows.isNotEmpty()) {
                snapshot.rows.forEach { ConversationRow(context, snapshot, it, height = UnreadWidget.ROW_DP.toInt()) }
                val more = snapshot.conversations - snapshot.rows.size
                if (more > 0) SecondaryText(L10n.str(R.string.widget_more, more), GlanceModifier.padding(start = 32.dp, top = 4.dp), size = 11)
            } else {
                Conversations(context, snapshot)
            }
        }
    }
}

/** The conversations, newest first, then 「ほか n 件」 for those the snapshot does not list; 「未読なし」 when none. */
@Composable
private fun Conversations(context: Context, snapshot: UnreadWidgetSnapshot) {
    if (snapshot.rows.isEmpty()) {
        AllRead(snapshot)
        return
    }
    val more = snapshot.conversations - snapshot.rows.size
    LazyColumn(GlanceModifier.fillMaxSize()) {
        items(snapshot.rows, itemId = { it.channelId.hashCode().toLong() }) { row ->
            ConversationRow(context, snapshot, row, height = UnreadWidget.ROW_DP.toInt())
        }
        if (more > 0) item { SecondaryText(L10n.str(R.string.widget_more, more), GlanceModifier.padding(start = 32.dp, top = 4.dp), size = 11) }
    }
}

/** Nothing listed: everything read (a check), or the rows are not known yet (a summary's number alone). */
@Composable
private fun AllRead(snapshot: UnreadWidgetSnapshot) {
    if (snapshot.total > 0) return
    Row(GlanceModifier.fillMaxWidth().height(28.dp), verticalAlignment = Alignment.CenterVertically) {
        WidgetIcon(WidgetGlyphs.allRead, 18.dp, GlanceTheme.colors.primary)
        Spacer(GlanceModifier.width(8.dp))
        SecondaryText(L10n.str(R.string.unread_widget_none), size = 13)
    }
}

/** A conversation: its mark (#, the person's face, people), its name and its count pill; a tap opens it. */
@Composable
private fun ConversationRow(context: Context, snapshot: UnreadWidgetSnapshot, row: UnreadRow, height: Int) {
    val label = L10n.str(R.string.unread_widget_row, row.title, row.count)
    val open = actionStartActivity(WidgetLinks.intent(context, WidgetLink.Conversation(snapshot.serverUrl, row.channelId)))
    Row(
        GlanceModifier.fillMaxWidth().height(height.dp).clickable(open).semantics { contentDescription = label },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RowMark(row)
        Spacer(GlanceModifier.width(8.dp))
        Text(
            row.title.removePrefix("#").takeIf { !row.dm } ?: row.title, modifier = GlanceModifier.defaultWeight(), maxLines = 1,
            style = TextStyle(color = GlanceTheme.colors.onSurface, fontSize = 13.sp, fontWeight = FontWeight.Medium),
        )
        Spacer(GlanceModifier.width(6.dp))
        CountPill((if (row.dm) "" else "@") + UnreadWidgetRules.countText(row.count))
    }
}

/** The row's mark: a channel's #, a 1:1 DM's face (the app's avatar colour), a group DM's people. */
@Composable
private fun RowMark(row: UnreadRow) {
    val size = 24.dp
    when {
        row.dm && !row.group && row.userId != null -> WidgetAvatar(row.userId, row.title, size)
        else -> Box(
            GlanceModifier.size(size).rounded(GlanceTheme.colors.secondaryContainer, 7.dp),
            contentAlignment = Alignment.Center,
        ) {
            WidgetIcon(if (row.dm) WidgetGlyphs.group else WidgetGlyphs.channel, 15.dp, GlanceTheme.colors.onSecondaryContainer)
        }
    }
}
