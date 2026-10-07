package jp.chikuwachat.android.ui

import androidx.compose.foundation.background
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
import androidx.compose.material3.AlertDialogDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
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
import jp.chikuwachat.android.R
import jp.chikuwachat.android.L10n
import androidx.compose.ui.res.stringResource

/**
 * 「メンバー」(M13g): everyone in the workspace, with presence, title and status; a DM is one tap away. People on the lab
 * roster (M23) come first in roster order under their headings (教員, D3 … B3, その他, 卒業生); the others follow, online
 * first.
 */
@Composable
fun DirectoryDialog(controller: AppController, onDismiss: () -> Unit, onOpened: (String) -> Unit) {
    val store = controller.store
    // Custom status emoji images land in the Store after the first draw (EmojiLineText).
    val version by store.version.collectAsState()
    val scope = rememberCoroutineScope()
    var query by remember { mutableStateOf("") }
    fun rank(user: UserPublic): Int = if (user.role == "bot") 3 else when (store.presenceOf(user.id)) { "online" -> 0; "away" -> 1; else -> 2 }
    val q = query.trim().lowercase()
    val roster = store.roster
    val headed = roster.isNotEmpty()
    val people = store.users.values
        .filter { it.deactivatedAt == null }
        .filter { user ->
            q.isEmpty() || listOf(user.username, user.displayName, user.title, roster[user.id]?.researchTopic, roster[user.id]?.reading)
                .any { (it ?: "").lowercase().contains(q) }
        }
        .sortedWith(Roster.listOrder(roster, compareBy({ rank(it) }, { it.displayName })))
    val sections = if (headed) Roster.sections(people, roster) else listOf(null to people)
    fun subtitle(user: UserPublic): String {
        val parts = listOfNotNull(
            // The roster label is the badge; the title adds the rest (LAB.md 「肩書と名簿」).
            Roster.titleExtra(user.title, roster[user.id]),
            roster[user.id]?.researchTopic?.takeIf { it.isNotEmpty() },
            activeStatus(user)?.let { (it.first + " " + it.second).trim() },
        )
        if (parts.isNotEmpty()) return parts.joinToString(" · ")
        if (user.role == "bot") return L10n.str(R.string.directory_dialog_incoming_webhook)
        return when (store.presenceOf(user.id)) { "online" -> L10n.str(R.string.common_online); "away" -> L10n.str(R.string.common_away); else -> L10n.str(R.string.common_offline) }
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.directory_dialog_members, people.size)) },
        text = {
            Column {
                OutlinedTextField(
                    query, { query = it }, label = { Text(if (headed) stringResource(R.string.directory_dialog_search_by_name_username_title_or) else stringResource(R.string.directory_dialog_search_by_name_username_or_title)) },
                    singleLine = true, modifier = Modifier.fillMaxWidth(),
                )
                LazyColumn(Modifier.heightIn(max = 420.dp).padding(top = 8.dp)) {
                    sections.forEachIndexed { index, (heading, rows) ->
                        // The index keeps keys unique should a heading come back (an unknown grade among 「学生」).
                        if (heading != null) stickyHeader(key = "heading:$index") {
                            Text(
                                heading, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.fillMaxWidth().background(AlertDialogDefaults.containerColor).padding(top = 8.dp, bottom = 2.dp),
                            )
                        }
                        items(rows, key = { it.id }) { user ->
                            Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                                Avatar(user.id, user.displayName, size = 36.dp, presence = if (user.role == "bot") null else store.presenceOf(user.id))
                                Spacer(Modifier.width(10.dp))
                                Column(Modifier.weight(1f)) {
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        Text(user.displayName, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                        Spacer(Modifier.width(6.dp))
                                        Text("@" + user.username, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
                                        roster[user.id]?.let { RosterBadge(it, Modifier.padding(start = 6.dp)) }
                                        val tag = when (user.role) { "admin" -> stringResource(R.string.directory_dialog_admin); "manager" -> stringResource(R.string.directory_dialog_manager); "guest" -> stringResource(R.string.directory_dialog_guest); "bot" -> "BOT"; else -> null }
                                        if (tag != null) { Spacer(Modifier.width(6.dp)); Text(tag, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary) }
                                        if (user.dndUntil != null) { Spacer(Modifier.width(4.dp)); Text("🔕", style = MaterialTheme.typography.labelSmall) }
                                    }
                                    EmojiLineText(subtitle(user), controller, version, MaterialTheme.typography.bodySmall, MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                                if (user.id != store.me?.id && user.role != "bot") {
                                    TextButton(onClick = { scope.launch { controller.openDmWith(user.id)?.let { onOpened(it); onDismiss() } } }) { Text("DM") }
                                }
                            }
                        }
                    }
                    if (people.isEmpty()) item { Text(stringResource(R.string.directory_dialog_no_matching_members), color = MaterialTheme.colorScheme.onSurfaceVariant) }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.common_close)) } },
    )
}
