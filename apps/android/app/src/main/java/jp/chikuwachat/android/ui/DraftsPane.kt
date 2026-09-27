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
import jp.chikuwachat.android.app.AppController

/** 「下書き」 (M11h): conversations with unsent text or attachments; a row opens the conversation with the draft restored. */
@Composable
fun DraftsPane(controller: AppController, version: Int, onOpen: (channelId: String, parentId: String?) -> Unit) {
    val store = controller.store
    val drafts = remember(version) { store.listDrafts().filter { store.channel(it.channelId) != null } }
    val scheduled = remember(version) { store.listScheduled() }
    LazyColumn(Modifier.fillMaxSize()) {
        if (scheduled.isNotEmpty()) {
            item { Text("予約送信", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp)) }
            items(scheduled, key = { "sch:" + it.id }) { row ->
                val channel = store.channel(row.channelId)
                Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(channel?.let { channelTitle(it, store) } ?: "?", style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
                        if (row.parentId != null) Text(" · スレッド", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text(" · " + Schedule.label(row.sendAt) + " に送信", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        if (row.attachments.isNotEmpty()) Text(" · 添付 ${row.attachments.size}", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    Text(plainText(Mentions.toNames(row.body, store.users, store.groups)).ifBlank { "(本文なし)" }, style = MaterialTheme.typography.bodyMedium, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp))
                    Row {
                        TextButton(onClick = { controller.scope.launch { controller.sendScheduledNow(row) } }) { Text("今すぐ送信") }
                        TextButton(onClick = { controller.scope.launch { controller.cancelScheduled(row) } }) { Text("取り消し") }
                    }
                }
                HorizontalDivider()
            }
        }
        if (drafts.isEmpty() && scheduled.isEmpty()) {
            item {
                Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp, vertical = 48.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text("下書きはありません", style = MaterialTheme.typography.titleSmall)
                    Text("入力途中のメッセージは会話ごとに自動で残ります。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center, modifier = Modifier.padding(top = 4.dp))
                }
            }
        }
        items(drafts, key = { "${it.channelId}:${it.parentId ?: ""}" }) { entry ->
            val channel = store.channel(entry.channelId) ?: return@items
            Column(Modifier.fillMaxWidth().clickable { onOpen(entry.channelId, entry.parentId) }.padding(horizontal = 16.dp, vertical = 10.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(channelTitle(channel, store), style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
                    if (entry.parentId != null) Text(" · スレッド", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (entry.draft.attachments.isNotEmpty()) Text(" · 添付 ${entry.draft.attachments.size}", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Text(entry.draft.text.ifBlank { "(本文なし)" }, style = MaterialTheme.typography.bodyMedium, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(top = 2.dp))
            }
            HorizontalDivider()
        }
    }
}
