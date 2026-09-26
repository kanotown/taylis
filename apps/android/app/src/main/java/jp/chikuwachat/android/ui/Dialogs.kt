package jp.chikuwachat.android.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.api.UserPublic
import jp.chikuwachat.android.app.AppController
import kotlinx.coroutines.launch

@Composable
fun NewChannelDialog(controller: AppController, onDismiss: () -> Unit, onOpened: (String) -> Unit) {
    var name by remember { mutableStateOf("") }
    var isPrivate by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("チャンネルを作成") },
        text = {
            Column {
                OutlinedTextField(name, { name = it }, label = { Text("名前") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 8.dp)) {
                    Switch(checked = isPrivate, onCheckedChange = { isPrivate = it })
                    Text("プライベート", modifier = Modifier.padding(start = 8.dp))
                }
                error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 8.dp)) }
            }
        },
        confirmButton = {
            TextButton(enabled = name.isNotBlank(), onClick = {
                scope.launch {
                    controller.createChannel(name.trim(), if (isPrivate) "private" else "public")
                        .onSuccess { onOpened(it); onDismiss() }
                        .onFailure { error = controller.describe(it) }
                }
            }) { Text("作成") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("キャンセル") } },
    )
}

@Composable
fun NewDmDialog(controller: AppController, onDismiss: () -> Unit, onOpened: (String) -> Unit) {
    val store = controller.store
    val users = remember { store.users.values.filter { it.id != store.me?.id && it.deactivatedAt == null }.sortedBy { it.displayName } }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("ダイレクトメッセージ") },
        text = {
            Column {
                if (users.isEmpty()) Text("相手になるユーザーがいません")
                UserPicker(users) { user ->
                    scope.launch {
                        controller.createDm(listOf(user.id)).onSuccess { onOpened(it); onDismiss() }.onFailure { error = controller.describe(it) }
                    }
                }
                error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            }
        },
        confirmButton = {},
        dismissButton = { TextButton(onClick = onDismiss) { Text("キャンセル") } },
    )
}

@Composable
fun AddMemberDialog(controller: AppController, channelId: String, onDismiss: () -> Unit) {
    val store = controller.store
    var memberIds by remember { mutableStateOf<Set<String>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(channelId) {
        controller.members(channelId).onSuccess { memberIds = it.toSet() }.onFailure { error = controller.describe(it) }
    }
    val candidates = memberIds?.let { ids -> store.users.values.filter { it.id !in ids && it.deactivatedAt == null }.sortedBy { it.displayName } } ?: emptyList()
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("メンバーを追加") },
        text = {
            Column {
                when {
                    memberIds == null && error == null -> Text("読み込み中…")
                    candidates.isEmpty() && error == null -> Text("追加できるユーザーはいません")
                    else -> UserPicker(candidates) { user ->
                        scope.launch {
                            controller.addMember(channelId, user.id).onSuccess { memberIds = memberIds.orEmpty() + user.id }.onFailure { error = controller.describe(it) }
                        }
                    }
                }
                error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("閉じる") } },
    )
}

@Composable
private fun UserPicker(users: List<UserPublic>, onPick: (UserPublic) -> Unit) {
    LazyColumn(Modifier.heightIn(max = 320.dp)) {
        items(users, key = { it.id }) { user ->
            Column(Modifier.fillMaxWidth().clickable { onPick(user) }.padding(vertical = 10.dp)) {
                Text(user.displayName)
                Text("@" + user.username, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}
