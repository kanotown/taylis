package jp.chikuwachat.android.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.api.UserPublic
import jp.chikuwachat.android.api.activeStatus
import jp.chikuwachat.android.app.AppController
import kotlinx.coroutines.launch

/** 「メンバー」(M13g): everyone in the workspace, with presence, title and status; a DM is one tap away. */
@Composable
fun DirectoryDialog(controller: AppController, onDismiss: () -> Unit, onOpened: (String) -> Unit) {
    val store = controller.store
    val scope = rememberCoroutineScope()
    var query by remember { mutableStateOf("") }
    fun rank(user: UserPublic): Int = if (user.role == "bot") 3 else when (store.presenceOf(user.id)) { "online" -> 0; "away" -> 1; else -> 2 }
    val q = query.trim().lowercase()
    val people = store.users.values
        .filter { it.deactivatedAt == null }
        .filter { q.isEmpty() || it.username.lowercase().contains(q) || it.displayName.lowercase().contains(q) || (it.title ?: "").lowercase().contains(q) }
        .sortedWith(compareBy({ rank(it) }, { it.displayName }))
    fun subtitle(user: UserPublic): String {
        val parts = listOfNotNull(user.title?.takeIf { it.isNotEmpty() }, activeStatus(user)?.let { (it.first + " " + it.second).trim() })
        if (parts.isNotEmpty()) return parts.joinToString(" · ")
        if (user.role == "bot") return "受信 Webhook"
        return when (store.presenceOf(user.id)) { "online" -> "オンライン"; "away" -> "離席中"; else -> "オフライン" }
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("メンバー (${people.size})") },
        text = {
            Column {
                OutlinedTextField(query, { query = it }, label = { Text("名前・ユーザー名・肩書で検索") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                LazyColumn(Modifier.heightIn(max = 420.dp).padding(top = 8.dp)) {
                    items(people, key = { it.id }) { user ->
                        Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                            Avatar(user.id, user.displayName, size = 36.dp, presence = if (user.role == "bot") null else store.presenceOf(user.id))
                            Spacer(Modifier.width(10.dp))
                            Column(Modifier.weight(1f)) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text(user.displayName, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                    Spacer(Modifier.width(6.dp))
                                    Text("@" + user.username, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
                                    val tag = when (user.role) { "admin" -> "管理者"; "guest" -> "ゲスト"; "bot" -> "BOT"; else -> null }
                                    if (tag != null) { Spacer(Modifier.width(6.dp)); Text(tag, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary) }
                                    if (user.dndUntil != null) { Spacer(Modifier.width(4.dp)); Text("🔕", style = MaterialTheme.typography.labelSmall) }
                                }
                                Text(subtitle(user), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            }
                            if (user.id != store.me?.id && user.role != "bot") {
                                TextButton(onClick = { scope.launch { controller.openDmWith(user.id)?.let { onOpened(it); onDismiss() } } }) { Text("DM") }
                            }
                        }
                    }
                    if (people.isEmpty()) item { Text("該当するメンバーがいません", color = MaterialTheme.colorScheme.onSurfaceVariant) }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("閉じる") } },
    )
}
