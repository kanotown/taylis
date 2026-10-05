package jp.chikuwachat.android.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AddTask
import androidx.compose.material.icons.outlined.RateReview
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.api.TaskKind
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.sync.MessageState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import jp.chikuwachat.android.R
import androidx.compose.ui.res.stringResource

/**
 * L9 (M64, REVIEWS.md §2.2): one chip per shared task made from the message (MessageOut.tasks), 「レビュー依頼 · 加納 ·
 * 依頼中 · 10/9 まで」 (TaskRules.chip). Grey once done, red past its due date. A tap opens the task's form (read from the
 * server when no window holds it); an assignee finds 「対応を始める」 / 「完了にする」 there. The row follows message.updated
 * (change "tasks"), so the chip changes on every device.
 */
@Composable
fun MessageTaskChips(message: MessageState, controller: AppController, version: Int) {
    val store = controller.store
    val today = rememberToday().toString()
    val chips = remember(message.tasks, version, today) {
        message.tasks.map { task -> task to TaskRules.chip(task, today) { id -> store.users[id]?.displayName } }
    }
    Column(Modifier.padding(top = 4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        chips.forEach { (task, chip) ->
            val (background, content) = when (chip.tone) {
                TaskChipTone.DONE -> MaterialTheme.colorScheme.surfaceVariant to MaterialTheme.colorScheme.onSurfaceVariant
                TaskChipTone.OVERDUE -> MaterialTheme.colorScheme.errorContainer to MaterialTheme.colorScheme.onErrorContainer
                TaskChipTone.OPEN -> MaterialTheme.colorScheme.secondaryContainer to MaterialTheme.colorScheme.onSecondaryContainer
            }
            Surface(
                color = background, contentColor = content, shape = RoundedCornerShape(8.dp),
                modifier = Modifier.clip(RoundedCornerShape(8.dp)).clickable(role = Role.Button, onClickLabel = stringResource(R.string.common_open)) { open(controller, task.id) },
            ) {
                Row(Modifier.heightIn(min = 32.dp).padding(horizontal = 10.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(
                        if (task.kind == TaskKind.REVIEW) Icons.Outlined.RateReview else Icons.Outlined.AddTask, contentDescription = null,
                        modifier = Modifier.size(15.dp),
                    )
                    Spacer(Modifier.width(6.dp))
                    Text(
                        chip.text, style = MaterialTheme.typography.labelLarge, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        fontWeight = if (chip.tone == TaskChipTone.OVERDUE) FontWeight.SemiBold else FontWeight.Medium,
                    )
                }
            }
        }
    }
}

private fun open(controller: AppController, taskId: String) {
    val hub = controller.tasks ?: return
    controller.scope.launch {
        try {
            controller.taskForm = TaskForm(hub.load(taskId), null)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            controller.report(e)
        }
    }
}
