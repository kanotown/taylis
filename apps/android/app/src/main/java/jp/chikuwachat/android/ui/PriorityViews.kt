package jp.chikuwachat.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.DoneAll
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material.icons.outlined.Warning
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.sync.MessageState
import jp.chikuwachat.android.sync.Store
import kotlinx.coroutines.launch
import jp.chikuwachat.android.R
import androidx.compose.ui.res.stringResource
import jp.chikuwachat.android.L10n

/** M15e: 「重要」 / 「緊急」 above a message and in the composer. */
@Composable
fun PriorityLabel(priority: String, modifier: Modifier = Modifier) {
    val urgent = priority == "urgent"
    val color = if (urgent) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary
    Row(
        modifier.background(color.copy(alpha = 0.12f), RoundedCornerShape(4.dp)).padding(horizontal = 6.dp, vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(if (urgent) Icons.Outlined.Warning else Icons.Outlined.Info, contentDescription = null, tint = color, modifier = Modifier.size(12.dp))
        Text(if (urgent) stringResource(R.string.priority_views_urgent) else stringResource(R.string.priority_views_important), style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold, color = color)
    }
}

/**
 * M15e: 「確認しました」 for readers, and who has acknowledged so far. M27: the first names are on the line (「山田、佐藤 が確認」,
 * then 「… ほか N 人が確認」); tapping it lists everyone, oldest first. `readOnly`: a channel only previewed (§7.6.1), where
 * nobody acknowledges. `version` keeps the names current.
 */
@Composable
fun AckBar(message: MessageState, store: Store, controller: AppController, version: Int = 0, readOnly: Boolean = false) {
    val me = remember(version) { store.me }
    val mine = me != null && message.acks.any { it.userId == me.id }
    val own = me?.id == message.senderId
    val people = remember(version, message.acks) { PeopleText.people(store, message.acks.map { it.userId }) }
    var showNames by remember { mutableStateOf(false) }
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 4.dp)) {
        if (!own && !readOnly) {
            OutlinedButton(onClick = { controller.scope.launch { controller.toggleAck(message) } }, contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 10.dp, vertical = 0.dp)) {
                Icon(Icons.Outlined.DoneAll, contentDescription = null, modifier = Modifier.size(16.dp), tint = if (mine) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
                Text(if (mine) stringResource(R.string.priority_views_acknowledged) else stringResource(R.string.priority_views_acknowledge), style = MaterialTheme.typography.labelMedium)
            }
        }
        // M28c: a 48 dp touch target around the names line (the row's layout is unchanged).
        Text(
            if (people.isEmpty()) stringResource(R.string.priority_views_no_one_has_acknowledged_yet) else PeopleText.acknowledged(people.map { it.name }),
            style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 2, overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false).padding(start = if (!own && !readOnly) 8.dp else 0.dp).touchTarget { source ->
                // M31: members open it with nobody listed too, for 「未確認」 and the reminder.
                Modifier.clickable(interactionSource = source, indication = null, enabled = people.isNotEmpty() || !readOnly, onClickLabel = L10n.str(R.string.priority_views_acknowledged_by)) { showNames = true }
            },
        )
    }
    if (showNames) {
        if (readOnly) PeopleDialog(stringResource(R.string.priority_views_acknowledged_by), people, onDismiss = { showNames = false })
        else AckPeopleDialog(message, people, store, controller, version, onDismiss = { showNames = false })
    }
}

/**
 * 「確認した人」 with 「未確認 N 人」 (L4, M31): the pending names come from GET …/ack/pending when the dialog opens, again
 * after each acknowledgement that arrives and after a reminder. The author or an admin may remind them (once an hour).
 */
@Composable
private fun AckPeopleDialog(message: MessageState, people: List<Person>, store: Store, controller: AppController, version: Int, onDismiss: () -> Unit) {
    var pendingIds by remember { mutableStateOf<List<String>?>(null) }
    var reload by remember { mutableIntStateOf(0) }
    var busy by remember { mutableStateOf(false) }
    // The outcome of the reminder under its button: the app's snackbar sits behind this dialog.
    var outcome by remember { mutableStateOf<AckReminders.Outcome?>(null) }
    // A failed load in words, shown in place of the list (the snackbar sits behind this dialog); a later load clears it.
    var loadError by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(message.id, message.acks.size, reload) {
        controller.ackPending(message.id)
            .onSuccess { pendingIds = it; loadError = null }
            .onFailure { if (pendingIds == null) loadError = controller.describe(it) }
    }
    val pending = remember(version, pendingIds) { pendingIds?.let { PeopleText.people(store, it) } }
    val me = remember(version) { store.me }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.priority_views_acknowledged_by)) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                if (people.isEmpty()) Text(stringResource(R.string.priority_views_no_one_has_acknowledged_yet), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                people.forEach { PersonRow(it) }
                Text(
                    stringResource(R.string.priority_views_pending) + (pending?.let { stringResource(R.string.common_members, it.size) } ?: ""),
                    style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 6.dp),
                )
                val failure = loadError
                when {
                    pending == null && failure != null -> Text(failure, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error)
                    pending == null -> Text(stringResource(R.string.common_loading), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    pending.isEmpty() -> Text(stringResource(R.string.priority_views_everyone_has_acknowledged), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    else -> pending.forEach { PersonRow(it) }
                }
                if (AckReminders.canRemind(message, me, pending?.size ?: 0)) {
                    TextButton(
                        enabled = !busy,
                        onClick = {
                            // The app's scope: a reminder being sent is not cancelled when the dialog closes.
                            controller.scope.launch {
                                busy = true
                                outcome = null
                                val result = controller.remindAck(message.id)
                                outcome = result
                                if (!result.failed) reload += 1
                                busy = false
                            }
                        },
                        modifier = Modifier.heightIn(min = TouchTarget.MIN),
                    ) { Text(stringResource(R.string.priority_views_remind_those_who_havent_acknowledged)) }
                }
                // Stays after the pending list empties (the button goes then, the result should not).
                outcome?.let {
                    Text(
                        it.text, style = MaterialTheme.typography.bodySmall,
                        color = if (it.failed) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.common_close)) } },
    )
}
