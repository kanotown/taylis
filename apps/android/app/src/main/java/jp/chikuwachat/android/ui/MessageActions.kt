package jp.chikuwachat.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.sync.MessageState
import jp.chikuwachat.android.sync.Store

val REACTION_PALETTE = listOf("👍", "❤️", "😂", "🎉", "👀", "✅")

/** Long-press menu on a message: quick reactions, edit (author) and delete (author / admin). */
@Composable
fun MessageMenu(
    expanded: Boolean,
    canEdit: Boolean,
    canDelete: Boolean,
    onDismiss: () -> Unit,
    onReact: (String) -> Unit,
    onEdit: () -> Unit,
    onDelete: () -> Unit,
) {
    DropdownMenu(expanded = expanded, onDismissRequest = onDismiss) {
        Row(Modifier.padding(horizontal = 8.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            REACTION_PALETTE.forEach { emoji ->
                Text(emoji, style = MaterialTheme.typography.titleLarge, modifier = Modifier.clickable { onReact(emoji); onDismiss() }.padding(6.dp))
            }
        }
        if (canEdit || canDelete) HorizontalDivider()
        if (canEdit) DropdownMenuItem(text = { Text("編集") }, onClick = { onDismiss(); onEdit() })
        if (canDelete) DropdownMenuItem(text = { Text("削除") }, onClick = { onDismiss(); onDelete() })
    }
}

/** Reaction chips under a message; tapping toggles my reaction. */
@Composable
fun ReactionChips(message: MessageState, store: Store, onToggle: (String) -> Unit) {
    if (message.reactions.isEmpty()) return
    val me = store.me?.id
    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.padding(top = 4.dp)) {
        message.reactions.forEach { reaction ->
            val mine = me != null && me in reaction.userIds
            val shape = RoundedCornerShape(12.dp)
            val background = if (mine) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceVariant
            Text(
                "${reaction.emoji} ${reaction.count}",
                style = MaterialTheme.typography.labelLarge,
                modifier = Modifier
                    .border(1.dp, if (mine) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant, shape)
                    .background(background, shape)
                    .clickable { onToggle(reaction.emoji) }
                    .padding(horizontal = 8.dp, vertical = 3.dp),
            )
        }
    }
}

@Composable
fun EditMessageDialog(initial: String, onDismiss: () -> Unit, onSave: (String) -> Unit) {
    var text by remember { mutableStateOf(initial) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("メッセージを編集") },
        text = { OutlinedTextField(text, { text = it }, maxLines = 8) },
        confirmButton = { TextButton(enabled = text.isNotBlank(), onClick = { onSave(text.trim()) }) { Text("保存") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("キャンセル") } },
    )
}

@Composable
fun ConfirmDeleteDialog(onDismiss: () -> Unit, onConfirm: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("メッセージを削除") },
        text = { Column { Text("削除したメッセージは元に戻せません。") } },
        confirmButton = { TextButton(onClick = onConfirm) { Text("削除", color = MaterialTheme.colorScheme.error) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("キャンセル") } },
    )
}
