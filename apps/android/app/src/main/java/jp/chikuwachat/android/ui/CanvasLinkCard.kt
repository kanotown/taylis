package jp.chikuwachat.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.sync.CanvasLinkState
import kotlinx.coroutines.launch

/**
 * M58 (CANVAS.md §4.13, the desktop's CanvasLinkCard.tsx): a `<server>/c/<id>` link on a line of its own in a message
 * (a canvas shared to its conversation, or pasted) is a card: the title, its conversation, who changed it last and the
 * task progress. A tap opens the canvas in its conversation's 「キャンバス」 tab. Someone outside that conversation sees
 * 「メンバーではありません」 and nothing of the canvas (the server answers 403); a canvas in the trash or gone
 * 「表示できないキャンバス」. A link inside a sentence stays the 「📄 キャンバスを開く」 link (M46).
 */
object CanvasCards {
    sealed class Piece {
        data class Lines(val lines: List<List<BodyToken>>) : Piece()
        data class Card(val canvasId: String, val url: String) : Piece()
    }

    /** The canvas link a line consists of (spaces around it allowed), on the server `base`; null for any other line. */
    fun cardOf(line: List<BodyToken>, base: String): Piece.Card? {
        val meaningful = line.filterNot { it is BodyToken.Text && it.text.isBlank() }
        val link = meaningful.singleOrNull() as? BodyToken.Link ?: return null
        val id = Permalink.canvasId(base, link.url) ?: return null
        return Piece.Card(id, link.url)
    }

    /** A paragraph's lines with each line that is only a canvas link taken out as a card (the other lines kept together). */
    fun split(lines: List<List<BodyToken>>, base: String?): List<Piece> {
        if (base == null) return listOf(Piece.Lines(lines))
        val pieces = ArrayList<Piece>()
        val run = ArrayList<List<BodyToken>>()
        fun close() {
            if (run.isNotEmpty()) pieces.add(Piece.Lines(run.toList()))
            run.clear()
        }
        for (line in lines) {
            val card = cardOf(line, base)
            if (card == null) run.add(line) else { close(); pieces.add(card) }
        }
        close()
        return pieces
    }

    /** Whether a message's first link is a canvas of this server (it gets the card, not the web page's preview). */
    fun isCanvasLink(base: String?, url: String): Boolean = base != null && Permalink.canvasId(base, url) != null

    /** The progress bar's share, 0…1; null without tasks. */
    fun progress(total: Int, done: Int): Float? = if (total > 0) (done.toFloat() / total).coerceIn(0f, 1f) else null
}

@Composable
fun CanvasLinkCard(controller: AppController, canvasId: String, version: Int) {
    val store = controller.store
    // The store's copy (kept current by canvas.* events) wins over the one fetched for the card; read again when the
    // store changes (`version`: its lists change in place).
    val live = remember(version, canvasId) { store.canvasMeta(canvasId) }
    val link = controller.canvasLinks[canvasId]
    LaunchedEffect(canvasId, live == null) { if (live == null) controller.loadCanvasLink(canvasId) }
    val canvas = live ?: (link as? CanvasLinkState.Ok)?.canvas
    val shape = RoundedCornerShape(12.dp)
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val open: () -> Unit = {
        if (link !is CanvasLinkState.Ok && live == null) controller.forgetCanvasLink(canvasId)
        controller.scope.launch { controller.openCanvasLink(canvasId) }
    }
    // One height whatever it shows (loading, the canvas, why not), so the row does not move when the card fills in.
    val frame = Modifier
        .padding(vertical = 4.dp)
        .widthIn(max = 420.dp)
        .fillMaxWidth()
        .heightIn(min = 64.dp)
        .clip(shape)
        .border(1.dp, MaterialTheme.colorScheme.outlineVariant, shape)
    @Composable
    fun Badge(icon: androidx.compose.ui.graphics.vector.ImageVector, tint: Color, background: Color) {
        Box(Modifier.size(36.dp).background(background, RoundedCornerShape(8.dp)), contentAlignment = Alignment.Center) {
            Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(20.dp))
        }
    }
    when {
        canvas != null -> {
            val channel = store.channel(canvas.channelId)
            val where = channel?.let { channelTitle(it, store) } ?: "会話"
            val who = store.users[canvas.updatedBy]?.displayName ?: "メンバー"
            val share = CanvasCards.progress(canvas.taskTotal, canvas.taskDone)
            Row(
                frame.clickable(onClickLabel = "キャンバスを開く", onClick = open).padding(horizontal = 12.dp, vertical = 10.dp)
                    .semantics { contentDescription = "キャンバス: ${canvas.title}" },
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(12.dp),
            ) {
                Badge(Icons.Outlined.Description, MaterialTheme.colorScheme.primary, MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.5f))
                Column(Modifier.weight(1f)) {
                    Text(canvas.title, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(
                        "$where · キャンバス · 更新: $who ${YouSettings.lastUsedLabel(canvas.updatedAt)}",
                        style = MaterialTheme.typography.labelSmall, color = muted, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                    if (share != null) {
                        Row(Modifier.padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                            Box(Modifier.width(96.dp).height(6.dp).clip(RoundedCornerShape(3.dp)).background(MaterialTheme.colorScheme.outlineVariant)) {
                                Box(Modifier.fillMaxHeight().fillMaxWidth(share).background(Color(0xFF2E9E5B)))
                            }
                            Text(
                                "${canvas.taskDone}/${canvas.taskTotal}", style = MaterialTheme.typography.labelSmall, color = muted,
                                modifier = Modifier.padding(start = 8.dp).semantics { contentDescription = "タスク ${canvas.taskDone}/${canvas.taskTotal}" },
                            )
                        }
                    }
                }
            }
        }
        link == null -> Row(frame.padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Badge(Icons.Outlined.Description, muted, MaterialTheme.colorScheme.surfaceVariant)
            Text("キャンバスを読み込み中…", style = MaterialTheme.typography.bodyMedium, color = muted)
        }
        link == CanvasLinkState.Forbidden -> Row(frame.padding(horizontal = 12.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Badge(Icons.Outlined.Lock, muted, MaterialTheme.colorScheme.surfaceVariant)
            Column(Modifier.weight(1f)) {
                Text("メンバーではありません", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
                Text("このキャンバスの会話に参加している人だけが見られます。", style = MaterialTheme.typography.labelSmall, color = muted)
            }
        }
        else -> Row(
            frame.clickable(onClickLabel = "もう一度開く", onClick = open).padding(horizontal = 12.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Badge(Icons.Outlined.WarningAmber, muted, MaterialTheme.colorScheme.surfaceVariant)
            Column(Modifier.weight(1f)) {
                Text("表示できないキャンバス", style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium)
                Text(
                    if (link == CanvasLinkState.Missing) "ゴミ箱に移されたか、削除されました。" else "読み込めませんでした。タップでもう一度試します。",
                    style = MaterialTheme.typography.labelSmall, color = muted,
                )
            }
        }
    }
}
