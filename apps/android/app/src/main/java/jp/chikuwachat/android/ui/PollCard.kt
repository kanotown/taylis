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
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
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

/**
 * A poll under a message (M14b): options with counts and bars; tapping votes, only its author can close it. M27: a named
 * poll says under each option who voted (up to three names, then 「ほか N 人」; tapping them lists everyone), an
 * anonymous one says 「匿名」 and names nobody. `readOnly`: a channel only previewed (SYNC_PROTOCOL.md §7.6.1), where
 * nobody votes or closes. `version` is read: the voters' names live in the Store.
 */
@Composable
fun PollCard(poll: PollOut, message: MessageState, controller: AppController, version: Int, readOnly: Boolean = false) {
    // M54: a scheduling poll (日程調整) has its own card; a choice poll (or one from a server before M53) stays as it was.
    if (poll.isSchedule) {
        ScheduleCard(poll, message, controller, version, readOnly)
        return
    }
    val store = controller.store
    val me = remember(version) { store.me?.id }
    val total = poll.total
    val mine = poll.mineFor(me)
    val voters = remember(version, poll) { poll.options.indices.map { PeopleText.people(store, poll.voters(it)) } }
    val closed = poll.closedAt != null
    val canClose = !readOnly && !closed && message.senderId == me // not an admin either (testers, 2026-09-29)
    var listing by remember { mutableStateOf<Int?>(null) }
    val shape = RoundedCornerShape(10.dp)
    Column(
        Modifier.fillMaxWidth().padding(top = 4.dp).border(1.dp, MaterialTheme.colorScheme.outlineVariant, shape)
            .background(MaterialTheme.colorScheme.surface, shape).padding(10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("📊 " + poll.question, style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold, modifier = Modifier.weight(1f, fill = false))
            if (poll.anonymous) { Spacer(Modifier.width(6.dp)); PollTag("匿名") }
            if (poll.multiple) { Spacer(Modifier.width(6.dp)); PollTag("複数選択可") }
        }
        poll.options.forEachIndexed { index, option ->
            val count = poll.count(index)
            val picked = index in mine
            val share = if (total == 0) 0f else count.toFloat() / total
            Column(
                Modifier.fillMaxWidth().padding(top = 6.dp)
                    .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(8.dp))
                    .clickable(enabled = !readOnly && !closed && !message.pending) { controller.scope.launch { controller.vote(message, index, !picked) } }
                    .padding(horizontal = 8.dp, vertical = 6.dp),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    if (picked) { Text("✓", color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.Bold); Spacer(Modifier.width(4.dp)) }
                    Text(option, modifier = Modifier.weight(1f))
                    Text("$count", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Box(Modifier.fillMaxWidth().padding(top = 4.dp).height(5.dp).background(MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(3.dp))) {
                    Box(Modifier.fillMaxWidth(share).height(5.dp).background(if (picked) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant, RoundedCornerShape(3.dp)))
                }
                val people = voters.getOrNull(index) ?: emptyList()
                if (people.isNotEmpty()) {
                    // M28c: a 40 dp touch target around the names line (48 would take the option's own tap area above it).
                    Text(
                        PeopleText.compact(people.map { it.name }), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        maxLines = 2, overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.padding(top = 4.dp).touchTarget(min = 40.dp) { source ->
                            Modifier.clickable(interactionSource = source, indication = null, onClickLabel = "投票した人") { listing = index }
                        },
                    )
                }
            }
        }
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 4.dp)) {
            Text(if (closed) "締め切りました · $total 票" else "$total 票", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
            if (canClose) TextButton(onClick = { controller.scope.launch { controller.closePoll(message) } }) { Text("締め切る") }
        }
    }
    listing?.let { index ->
        PeopleDialog(poll.options.getOrNull(index) ?: "", voters.getOrNull(index) ?: emptyList(), onDismiss = { listing = null })
    }
}

/** 「匿名」 / 「複数選択可」 beside the question. */
@Composable
private fun PollTag(text: String) {
    Text(
        text, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(4.dp)).padding(horizontal = 4.dp, vertical = 1.dp),
    )
}
