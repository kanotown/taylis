package jp.chikuwachat.android.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.api.MessageRevisionOut
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.sync.MessageState
import jp.chikuwachat.android.R
import jp.chikuwachat.android.L10n
import androidx.compose.ui.res.stringResource

/** 「編集履歴」(M14c): the bodies my edits replaced, oldest first, then the current one. Author only. */
@Composable
fun RevisionsDialog(controller: AppController, message: MessageState, onDismiss: () -> Unit) {
    val store = controller.store
    var rows by remember { mutableStateOf<List<MessageRevisionOut>?>(null) }
    var failed by remember { mutableStateOf(false) }
    LaunchedEffect(message.id, message.editedAt) {
        val list = controller.messageRevisions(message.id)
        if (list == null) failed = true else rows = list
    }
    fun text(body: String) = Mentions.toNames(body, store.users, store.groups)
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(L10n.str(R.string.common_edit_history)) },
        text = {
            Column {
                Text(stringResource(R.string.revisions_dialog_only_you_can_see_earlier_versions), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                val list = rows
                when {
                    failed -> Text(stringResource(R.string.revisions_dialog_couldnt_load_the_edit_history), color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 8.dp))
                    list == null -> CircularProgressIndicator(Modifier.padding(top = 8.dp))
                    else -> LazyColumn(Modifier.heightIn(max = 420.dp).padding(top = 8.dp)) {
                        if (list.isEmpty()) item { Text(stringResource(R.string.revisions_dialog_no_earlier_versions_were_recorded_edited), color = MaterialTheme.colorScheme.onSurfaceVariant) }
                        itemsIndexed(list) { _, row ->
                            Text(stringResource(R.string.revisions_dialog_version_line, Timeline.fullLabel(row.writtenAt), Timeline.fullLabel(row.replacedAt)), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp))
                            SelectionContainer { Text(text(row.body), style = MaterialTheme.typography.bodyMedium) }
                            HorizontalDivider(Modifier.padding(top = 8.dp))
                        }
                        item {
                            Text(stringResource(R.string.common_current_version) + (message.editedAt?.let { " · " + Timeline.fullLabel(it) } ?: ""), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(top = 8.dp))
                            SelectionContainer { Text(text(message.body), style = MaterialTheme.typography.bodyMedium) }
                        }
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.common_close)) } },
    )
}
