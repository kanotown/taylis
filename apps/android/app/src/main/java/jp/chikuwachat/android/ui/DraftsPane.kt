package jp.chikuwachat.android.ui

import kotlinx.coroutines.launch
import androidx.compose.material3.TextButton
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.api.ErrorTexts
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.R
import androidx.compose.ui.res.stringResource

/** 「下書き」 (M11h): conversations with unsent text or attachments; a row opens the conversation with the draft restored. */
@Composable
fun DraftsPane(controller: AppController, version: Int, onOpen: (channelId: String, parentId: String?) -> Unit) {
    val store = controller.store
    val drafts = remember(version) { store.listDrafts().filter { store.channel(it.channelId) != null } }
    val scheduled = remember(version) { store.listScheduled() }
    LazyColumn(Modifier.fillMaxSize()) {
        if (scheduled.isNotEmpty()) {
            item { Text(stringResource(R.string.drafts_pane_scheduled), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) }
            items(scheduled, key = { "sch:" + it.id }) { row ->
                val channel = store.channel(row.channelId)
                Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(channel?.let { channelTitle(it, store) } ?: "?", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
                        if (row.parentId != null) Text(stringResource(R.string.drafts_pane_thread), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        val failed = row.status == "failed"
                        if (failed) Text(stringResource(R.string.drafts_pane_couldnt_send), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.error)
                        else Text(stringResource(R.string.drafts_pane_sends_at, Schedule.label(row.sendAt)), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        if (row.attachments.isNotEmpty()) Text(stringResource(R.string.drafts_pane_attachments, row.attachments.size), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Text(plainText(Mentions.toNames(row.body, store.users, store.groups)).ifBlank { stringResource(R.string.drafts_pane_no_text) }, style = MaterialTheme.typography.bodyMedium, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp))
                    // Codex audit C3: a failed row says why; its text can go back to a draft or be dismissed.
                    if (row.status == "failed") {
                        Text(ErrorTexts.code(row.error ?: "") ?: stringResource(R.string.drafts_pane_couldnt_send_2), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 2.dp))
                        Row {
                            TextButton(onClick = { controller.scope.launch { controller.cancelScheduled(row) } }) { Text(stringResource(R.string.drafts_pane_back_to_drafts)) }
                            TextButton(onClick = { controller.scope.launch { controller.dismissScheduled(row) } }) { Text(stringResource(R.string.common_delete)) }
                        }
                    } else {
                        Row {
                            TextButton(onClick = { controller.scope.launch { controller.sendScheduledNow(row) } }) { Text(stringResource(R.string.drafts_pane_send_now)) }
                            TextButton(onClick = { controller.scope.launch { controller.cancelScheduled(row) } }) { Text(stringResource(R.string.common_cancel_2)) }
                        }
                    }
                }
                HorizontalDivider()
            }
        }
        if (drafts.isEmpty() && scheduled.isEmpty()) {
            item {
                Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 48.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(stringResource(R.string.drafts_pane_no_drafts), style = MaterialTheme.typography.titleSmall)
                    Text(stringResource(R.string.drafts_pane_unfinished_messages_are_saved), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 4.dp))
                }
            }
        }
        items(drafts, key = { "${it.channelId}:${it.parentId ?: ""}" }) { entry ->
            val channel = store.channel(entry.channelId) ?: return@items
            Column(Modifier.fillMaxWidth().clickable { onOpen(entry.channelId, entry.parentId) }.padding(horizontal = 16.dp, vertical = 10.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(channelTitle(channel, store), style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
                    if (entry.parentId != null) Text(stringResource(R.string.drafts_pane_thread), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (entry.draft.attachments.isNotEmpty()) Text(stringResource(R.string.drafts_pane_attachments, entry.draft.attachments.size), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Text(entry.draft.text.ifBlank { stringResource(R.string.drafts_pane_no_text) }, style = MaterialTheme.typography.bodyMedium, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp))
            }
            HorizontalDivider()
        }
    }
}
