package jp.chikuwachat.android.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Block
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.sync.MessageState
import kotlinx.coroutines.launch
import jp.chikuwachat.android.R
import jp.chikuwachat.android.L10n
import androidx.compose.ui.res.stringResource

/** M104 (docs/MODERATION.md): the rules the other clients share, used by the views below. */
object Moderation {
    /** The reasons of 「報告する」, in the order every client shows them (the server's `reason`; M119 `child_safety` first). */
    val reasons: List<Pair<String, String>> get() = listOf(
        "child_safety" to L10n.str(R.string.moderation_child_safety),
        "spam" to L10n.str(R.string.moderation_spam),
        "harassment" to L10n.str(R.string.moderation_harassment),
        "inappropriate" to L10n.str(R.string.moderation_inappropriate_content),
        "other" to L10n.str(R.string.common_other),
    )

    /** 「報告する」 on someone else's message once it is stored (not mine, not sending, not deleted, not a join / leave line). */
    fun canReport(message: MessageState, meId: String?): Boolean =
        message.senderId != meId && !message.pending && !message.deleted && message.seq != null && message.type == "user"

    /** The row folds to 「ブロック中のユーザーのメッセージ」: its sender is blocked, it is not deleted and not shown on request. */
    fun folds(message: MessageState, blocked: Set<String>, shown: Boolean): Boolean =
        message.senderId in blocked && !message.deleted && !shown
}

/** The folded row of a blocked person's message, with 「表示」 (MODERATION.md §4). */
@Composable
fun BlockedMessageRow(onShow: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(Icons.Outlined.Block, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(14.dp))
        Spacer(Modifier.width(8.dp))
        Text(
            stringResource(R.string.moderation_message_from_a_blocked_user), style = MaterialTheme.typography.bodySmall, fontStyle = FontStyle.Italic,
            color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f, fill = false),
        )
        TextButton(onClick = onShow) { Text(stringResource(R.string.common_show)) }
    }
}

/** 「報告する」 (MODERATION.md §3): a reason and an optional note; the administrators are told, the author is not. */
@Composable
fun ReportMessageDialog(controller: AppController, message: MessageState, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    var reason by rememberSaveable { mutableStateOf<String?>(null) }
    var note by rememberSaveable { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.moderation_report_message)) },
        text = {
            Column {
                Text(stringResource(R.string.moderation_the_workspace_administrators_are_told), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Moderation.reasons.forEach { (value, label) ->
                    Row(
                        Modifier.fillMaxWidth().selectable(selected = reason == value, role = Role.RadioButton) { reason = value }.padding(vertical = 2.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        RadioButton(selected = reason == value, onClick = null)
                        Spacer(Modifier.width(8.dp))
                        Text(label)
                    }
                }
                OutlinedTextField(
                    value = note, onValueChange = { note = it.take(1000) }, label = { Text(stringResource(R.string.moderation_note_optional)) }, minLines = 2,
                    modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                )
            }
        },
        confirmButton = {
            TextButton(enabled = reason != null && !busy, onClick = {
                val chosen = reason ?: return@TextButton
                busy = true
                scope.launch {
                    val ok = controller.reportMessage(message.id, chosen, note)
                    busy = false
                    if (ok) onDismiss()
                }
            }) { Text(stringResource(R.string.common_report)) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.common_cancel)) } },
    )
}

/**
 * 「アカウントを削除」 (MODERATION.md §2): confirmed with my password, or my username for an account without one (Google
 * sign-in). Immediate and final; my messages stay under 「退会したユーザー」.
 */
@Composable
fun DeleteAccountDialog(controller: AppController, onDismiss: () -> Unit) {
    val scope = rememberCoroutineScope()
    val me = controller.store.me
    val hasPassword = me?.hasPassword != false
    var secret by remember { mutableStateOf("") }
    var failure by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text(stringResource(R.string.common_delete_account)) },
        text = {
            Column {
                Text(stringResource(R.string.moderation_you_are_signed_out_of_all), style = MaterialTheme.typography.bodySmall)
                OutlinedTextField(
                    value = secret, onValueChange = { secret = it }, singleLine = true,
                    label = { Text(if (hasPassword) stringResource(R.string.moderation_enter_your_password_to_confirm) else stringResource(R.string.moderation_enter_your_username_to_confirm, me?.username ?: "")) },
                    visualTransformation = if (hasPassword) PasswordVisualTransformation() else androidx.compose.ui.text.input.VisualTransformation.None,
                    keyboardOptions = KeyboardOptions(keyboardType = if (hasPassword) KeyboardType.Password else KeyboardType.Ascii),
                    modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
                )
                failure?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 6.dp)) }
            }
        },
        confirmButton = {
            TextButton(enabled = secret.isNotBlank() && !busy, onClick = {
                busy = true
                failure = null
                scope.launch {
                    val error = controller.deleteAccount(secret)
                    busy = false
                    if (error != null) failure = error else onDismiss()
                }
            }) { Text(stringResource(R.string.common_delete_account), color = MaterialTheme.colorScheme.error) }
        },
        dismissButton = { TextButton(enabled = !busy, onClick = onDismiss) { Text(stringResource(R.string.common_cancel)) } },
    )
}

/** The people I blocked, each with 「解除」 (Settings → アカウント); `version` is the Store's. */
@Composable
fun BlockedUsersList(controller: AppController, version: Int) {
    val store = controller.store
    val ids = remember(version) { store.blockedUsers.sortedBy { store.users[it]?.displayName ?: "" } }
    val scope = rememberCoroutineScope()
    ids.forEach { id ->
        Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(store.users[id]?.displayName ?: stringResource(R.string.moderation_unknown_user), modifier = Modifier.weight(1f))
            TextButton(onClick = { scope.launch { controller.setUserBlocked(id, false) } }) { Text(stringResource(R.string.moderation_unblock)) }
        }
    }
}

/** A row that opens the delete dialog (destructive colour). */
@Composable
fun DeleteAccountRow(onClick: () -> Unit) {
    Text(
        stringResource(R.string.moderation_delete_account), color = MaterialTheme.colorScheme.error,
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick).padding(vertical = 14.dp),
    )
}
