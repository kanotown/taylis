package jp.chikuwachat.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.api.SystemEventOut
import jp.chikuwachat.android.sync.MessageState
import jp.chikuwachat.android.sync.Store

/**
 * M89 (MEMBERSHIP.md §5 items 2 and 3): a system row (`type != "user"`: the join / leave lines of M88). The line is written
 * from its `system_event` with the directory's names today (a renamed person reads with the new name), the same rules as
 * the desktop's `systemMessageText` (apps/desktop/src/ui/systemMessage.ts). The body (names as they were, written by the
 * server) stands in when the event is missing, of a kind this version does not know, or names someone the directory does
 * not have.
 */
object SystemMessages {
    /** 「A、B」 as the server writes the list (the Japanese comma, no 「と」). */
    fun joinNames(names: List<String>): String = names.joinToString("、")

    fun text(body: String, event: SystemEventOut?, nameOf: (String) -> String?): String {
        if (event == null) return body
        val actor = nameOf(event.actorId) ?: return body
        val others = event.userIds.map { nameOf(it) ?: return body }
        val list = joinNames(others)
        return when (event.kind) {
            "member_joined" -> "$actor が参加しました"
            "member_left" -> "$actor が退出しました"
            "members_added" -> "$actor が $list を追加しました"
            "member_removed" -> "$actor が $list を外しました"
            else -> body
        }
    }

    /** [text] with the Store's directory (the people bootstrap listed, and me). */
    fun text(message: MessageState, store: Store): String = text(message.body, message.systemEvent) { id ->
        store.users[id]?.displayName ?: store.me?.takeIf { it.id == id }?.displayName
    }
}

/**
 * One centered, muted line with its time: no picture, name, reactions, thread line, tap or long press (no actions sheet,
 * no 「ここから未読にする」). `highlighted`: the message a link or a search result points at.
 */
@Composable
fun SystemMessageRow(message: MessageState, store: Store, highlighted: Boolean = false) {
    val text = SystemMessages.text(message, store)
    val time = Timeline.timeLabel(message.createdAt)
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Box(
        Modifier.fillMaxWidth().background(if (highlighted) MaterialTheme.colorScheme.tertiaryContainer else Color.Transparent)
            .padding(horizontal = 24.dp, vertical = 6.dp)
            .clearAndSetSemantics { contentDescription = "$text $time" },
        contentAlignment = Alignment.Center,
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(text, style = MaterialTheme.typography.bodySmall, color = muted, textAlign = TextAlign.Center, modifier = Modifier.weight(1f, fill = false))
            Box(Modifier.width(6.dp))
            Text(time, style = MaterialTheme.typography.labelSmall, color = muted.copy(alpha = 0.7f))
        }
    }
}
