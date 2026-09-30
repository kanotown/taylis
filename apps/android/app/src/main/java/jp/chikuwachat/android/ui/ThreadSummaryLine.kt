package jp.chikuwachat.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.zIndex
import jp.chikuwachat.android.sync.MessageState
import jp.chikuwachat.android.sync.Store

private val REPLIER_SIZE = 20.dp
private val REPLIER_STEP = 17.dp

/**
 * C3 (MOBILE_POLISH.md, THREADS.md §3.1): the line under a thread parent, as on Slack and the web (Timeline.tsx
 * ThreadSummaryLine): up to three small overlapping avatars of the latest repliers, 「N 件の返信」 and 「最終返信 今日 14:05」.
 * Without repliers (an older server, or a stored row from before) the speech bubble stands in for the avatars.
 */
@Composable
fun ThreadSummaryLine(message: MessageState, store: Store, onOpen: () -> Unit) {
    val repliers = Timeline.replierAvatars(message.replyUserIds)
    val last = message.lastReplyAt?.let { Timeline.lastReplyLabel(it) } ?: ""
    val count = "${message.replyCount} 件の返信"
    val spoken = listOf(count, last).filter { it.isNotEmpty() }.joinToString("、")
    Row(
        Modifier
            .heightIn(min = 36.dp)
            .clip(RoundedCornerShape(6.dp))
            .clickable(onClick = onOpen)
            .clearAndSetSemantics {
                contentDescription = spoken
                role = Role.Button
                onClick(label = "スレッドを開く") { onOpen(); true }
            }
            .padding(end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (repliers.isEmpty()) {
            Icon(Icons.Outlined.ChatBubbleOutline, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.size(14.dp))
        } else {
            val ring = MaterialTheme.colorScheme.background
            Box(Modifier.width(REPLIER_SIZE + 3.dp + REPLIER_STEP * (repliers.size - 1))) {
                repliers.forEachIndexed { index, id ->
                    // The most recent replier (first) on top; each one ringed in the page colour where they overlap.
                    Box(
                        Modifier
                            .offset(x = REPLIER_STEP * index)
                            .zIndex((repliers.size - index).toFloat())
                            .background(ring, RoundedCornerShape(6.dp))
                            .padding(1.5.dp),
                    ) {
                        Avatar(id, store.users[id]?.displayName ?: "?", size = REPLIER_SIZE)
                    }
                }
            }
        }
        Spacer(Modifier.width(6.dp))
        Text(count, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.primary, maxLines = 1)
        if (last.isNotEmpty()) {
            Spacer(Modifier.width(8.dp))
            Text(
                last, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false),
            )
        }
    }
}
