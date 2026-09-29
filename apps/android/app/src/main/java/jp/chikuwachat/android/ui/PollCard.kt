package jp.chikuwachat.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.api.PollOut
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.sync.MessageState
import kotlinx.coroutines.launch

/**
 * The server makes a poll's text 「📊 質問」 for previews, pushes and search (DATA_MODEL.md); under it the card shows the
 * question again, and testers saw it twice in a row (2026-09-29). Text the author wrote stays.
 */
fun pollHidesBody(body: String, poll: PollOut?): Boolean = poll != null && body.trim() == "📊 ${poll.question}".trim()

/** A poll under a message (M14b): options with counts and bars; tapping votes, only its author can close it. */
@Composable
fun PollCard(poll: PollOut, message: MessageState, controller: AppController) {
    val me = controller.store.me?.id
    val total = poll.votes.sumOf { it.size }
    val closed = poll.closedAt != null
    val canClose = !closed && message.senderId == me // not an admin either (testers, 2026-09-29)
    val shape = RoundedCornerShape(10.dp)
    Column(
        Modifier.fillMaxWidth().padding(top = 4.dp).border(1.dp, MaterialTheme.colorScheme.outlineVariant, shape)
            .background(MaterialTheme.colorScheme.surface, shape).padding(10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("📊 " + poll.question, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
            if (poll.multiple) { Spacer(Modifier.width(6.dp)); Text("複数選択可", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
        poll.options.forEachIndexed { index, option ->
            val voters = poll.votes.getOrNull(index) ?: emptyList()
            val mine = me != null && me in voters
            val share = if (total == 0) 0f else voters.size.toFloat() / total
            Column(
                Modifier.fillMaxWidth().padding(top = 6.dp)
                    .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(8.dp))
                    .clickable(enabled = !closed && !message.pending) { controller.scope.launch { controller.vote(message, index, !mine) } }
                    .padding(horizontal = 8.dp, vertical = 6.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (mine) { Text("✓", color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.Bold); Spacer(Modifier.width(4.dp)) }
                    Text(option, modifier = Modifier.weight(1f))
                    Text("${voters.size}", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Box(Modifier.fillMaxWidth().padding(top = 4.dp).height(5.dp).background(MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(3.dp))) {
                    Box(Modifier.fillMaxWidth(share).height(5.dp).background(if (mine) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant, RoundedCornerShape(3.dp)))
                }
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 4.dp)) {
            Text(if (closed) "締め切りました · $total 票" else "$total 票", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
            if (canClose) TextButton(onClick = { controller.scope.launch { controller.closePoll(message) } }) { Text("締め切る") }
        }
    }
}
