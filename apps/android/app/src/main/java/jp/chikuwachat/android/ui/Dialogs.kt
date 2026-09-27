package jp.chikuwachat.android.ui

import kotlinx.serialization.json.put
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
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
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.RadioButton
import androidx.compose.ui.text.input.PasswordVisualTransformation
import jp.chikuwachat.android.api.MemberOut
import jp.chikuwachat.android.api.TotpStatusOut
import jp.chikuwachat.android.sync.ChannelState
import java.time.Instant
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

/** Channel info: topic (editable by members), notification level, members with roles. */
@Composable
fun ChannelInfoDialog(controller: AppController, channel: ChannelState, onDismiss: () -> Unit, onAddMember: () -> Unit) {
    val store = controller.store
    val scope = rememberCoroutineScope()
    val isChannel = !channel.channel.isDm
    var members by remember { mutableStateOf<List<MemberOut>?>(null) }
    var profileUserId by remember { mutableStateOf<String?>(null) }
    profileUserId?.let { id ->
        ProfileDialog(controller, id, onDismiss = { profileUserId = null }, onOpenDm = { profileUserId = null; onDismiss(); controller.pendingChannelId = it })
        return
    }
    var editingTopic by remember { mutableStateOf(false) }
    var topic by remember { mutableStateOf(channel.channel.topic ?: "") }
    // M11h: purpose editor and channel management (leave; rename / archive for owners and admins).
    var editingPurpose by remember { mutableStateOf(false) }
    var purpose by remember { mutableStateOf(channel.channel.purpose ?: "") }
    var renaming by remember { mutableStateOf(false) }
    var newName by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf<String?>(null) }
    val isAdmin = store.me?.role == "admin"
    val canManage = channel.channel.membership?.role == "owner" || isAdmin
    val toPrivate = channel.channel.type == "public"
    LaunchedEffect(channel.id) { controller.memberList(channel.id).onSuccess { members = it } }
    val level = channel.channel.notification?.level ?: if (isChannel) "mentions" else "all"
    val mute = Timeline.muteLabel(channel.channel.notification?.mutedUntil)

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(channelTitle(channel, store)) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                if (isChannel) {
                    SectionLabel("トピック")
                    if (editingTopic) {
                        OutlinedTextField(topic, { topic = it.take(250) }, singleLine = true, modifier = Modifier.fillMaxWidth(), placeholder = { Text("例: 週次の進捗共有") })
                        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                            TextButton(onClick = { scope.launch { if (controller.updateTopic(channel.id, topic)) editingTopic = false } }) { Text("保存") }
                            TextButton(onClick = { editingTopic = false; topic = channel.channel.topic ?: "" }) { Text("キャンセル") }
                        }
                    } else {
                        Text(channel.channel.topic?.takeIf { it.isNotBlank() } ?: "未設定", color = if (channel.channel.topic.isNullOrBlank()) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface)
                        if (channel.isMember && !channel.channel.archived) TextButton(onClick = { editingTopic = true }, contentPadding = PaddingValues(0.dp)) { Text("編集") }
                    }
                    SectionLabel("説明")
                    if (editingPurpose) {
                        OutlinedTextField(purpose, { purpose = it.take(250) }, singleLine = true, modifier = Modifier.fillMaxWidth(), placeholder = { Text("例: デザインレビューの依頼と結果を共有する") })
                        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                            TextButton(onClick = { scope.launch { if (controller.updatePurpose(channel.id, purpose)) editingPurpose = false } }) { Text("保存") }
                            TextButton(onClick = { editingPurpose = false; purpose = channel.channel.purpose ?: "" }) { Text("キャンセル") }
                        }
                    } else {
                        Text(channel.channel.purpose?.takeIf { it.isNotBlank() } ?: "未設定", color = if (channel.channel.purpose.isNullOrBlank()) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface)
                        if (channel.isMember && !channel.channel.archived) TextButton(onClick = { editingPurpose = true }, contentPadding = PaddingValues(0.dp)) { Text("編集") }
                    }
                }
                if (channel.isMember) {
                    SectionLabel("通知")
                    listOf("all" to "すべてのメッセージ", "mentions" to "メンションのみ", "none" to "通知しない").forEach { (value, label) ->
                        Row(
                            Modifier.fillMaxWidth().clickable { scope.launch { controller.setNotification(channel.id, value, channel.channel.notification?.mutedUntil) } },
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            RadioButton(selected = level == value, onClick = null)
                            Text(label, modifier = Modifier.padding(start = 4.dp))
                        }
                    }
                    if (mute != null) {
                        TextButton(onClick = { scope.launch { controller.setNotification(channel.id, level, null) } }, contentPadding = PaddingValues(0.dp)) { Text("ミュート解除 ($mute)") }
                    } else {
                        TextButton(onClick = { scope.launch { controller.setNotification(channel.id, level, Instant.now().plusSeconds(8 * 3600).toString()) } }, contentPadding = PaddingValues(0.dp)) { Text("8 時間ミュート") }
                    }
                }
                SectionLabel("メンバー" + (members?.let { " (${it.size})" } ?: ""))
                when (val list = members) {
                    null -> Text("読み込み中…", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    else -> list.sortedBy { store.users[it.userId]?.displayName ?: "" }.forEach { member ->
                        val user = store.users[member.userId]
                        Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                            val presence = store.presenceOf(member.userId)
                            Avatar(member.userId, user?.displayName ?: "?", size = 28.dp, presence = presence, modifier = Modifier.clickable { profileUserId = member.userId })
                            Column(Modifier.weight(1f).padding(start = 10.dp).clickable { profileUserId = member.userId }) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text(user?.displayName ?: "?")
                                    StatusEmoji(user, modifier = Modifier.padding(start = 6.dp))
                                }
                                Text("@" + (user?.username ?: "") + (user?.title?.takeIf { it.isNotBlank() }?.let { " · $it" } ?: ""), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            if (presence != "offline") Text(presenceLabel(presence), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(end = 8.dp))
                            if (member.role == "owner") Text("オーナー", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
                if (isChannel && channel.isMember) {
                    SectionLabel("管理")
                    if (renaming) {
                        OutlinedTextField(newName, { newName = it }, singleLine = true, modifier = Modifier.fillMaxWidth(), label = { Text("新しい名前") })
                        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                            TextButton(enabled = newName.isNotBlank(), onClick = { scope.launch { if (controller.renameChannel(channel.id, newName)) renaming = false } }) { Text("変更") }
                            TextButton(onClick = { renaming = false }) { Text("キャンセル") }
                        }
                    }
                    when (confirm) {
                        "leave" -> Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("このチャンネルを退出しますか？", style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
                            TextButton(onClick = { scope.launch { if (controller.leaveChannel(channel.id)) onDismiss() } }) { Text("退出", color = MaterialTheme.colorScheme.error) }
                            TextButton(onClick = { confirm = null }) { Text("キャンセル") }
                        }
                        "archive" -> Row(verticalAlignment = Alignment.CenterVertically) {
                            Text("アーカイブすると読み取り専用になります。", style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
                            TextButton(onClick = { scope.launch { if (controller.archiveChannel(channel.id)) onDismiss() } }) { Text("アーカイブ", color = MaterialTheme.colorScheme.error) }
                            TextButton(onClick = { confirm = null }) { Text("キャンセル") }
                        }
                        // M15b: making a channel public shows its whole history, so that direction is for admins only.
                        "convert" -> Column {
                            Text(
                                if (toPrivate) "非公開にすると、メンバー以外はこのチャンネルを見つけられず、これまでのメッセージもメンバーだけが読めます。" + (if (isAdmin) "" else "公開に戻せるのは管理者だけです。")
                                else "公開すると、ゲスト以外の全員が参加でき、これまでのメッセージも読めるようになります。",
                                style = MaterialTheme.typography.bodySmall,
                            )
                            Row {
                                TextButton(onClick = { scope.launch { if (controller.convertChannel(channel.id, if (toPrivate) "private" else "public")) confirm = null } }) {
                                    Text(if (toPrivate) "非公開にする" else "公開にする", color = MaterialTheme.colorScheme.error)
                                }
                                TextButton(onClick = { confirm = null }) { Text("キャンセル") }
                            }
                        }
                    }
                    if (confirm == null && !renaming) {
                        Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                            if (canManage && !channel.channel.archived) {
                                TextButton(onClick = { newName = channel.channel.name ?: ""; renaming = true }, contentPadding = PaddingValues(0.dp)) { Text("名前を変更") }
                                TextButton(onClick = { confirm = "archive" }, contentPadding = PaddingValues(0.dp)) { Text("アーカイブ") }
                            }
                            if (canManage && channel.channel.archived) {
                                TextButton(onClick = { scope.launch { if (controller.unarchiveChannel(channel.id)) onDismiss() } }, contentPadding = PaddingValues(0.dp)) { Text("アーカイブを解除") }
                            }
                            TextButton(onClick = { confirm = "leave" }, contentPadding = PaddingValues(0.dp)) { Text("退出", color = MaterialTheme.colorScheme.error) }
                        }
                        if (canManage && !channel.channel.archived) {
                            // M15a: an announcement channel; thread replies stay open to everyone.
                            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                                Text("投稿をオーナーと管理者に限る", style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                                Switch(
                                    checked = channel.channel.isAnnouncement,
                                    onCheckedChange = { on -> scope.launch { controller.setPostingPolicy(channel.id, if (on) "owners" else "everyone") } },
                                )
                            }
                        }
                        if ((toPrivate && canManage) || (channel.channel.type == "private" && isAdmin)) {
                            TextButton(onClick = { confirm = "convert" }, contentPadding = PaddingValues(0.dp)) {
                                Text(if (toPrivate) "非公開チャンネルに変換" else "公開チャンネルに変換")
                            }
                        }
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("閉じる") } },
        dismissButton = {
            if (isChannel && channel.isMember && !channel.channel.archived) TextButton(onClick = onAddMember) { Text("メンバーを追加") }
        },
    )
}

/** Profile (display name), password change and logout. */
@Composable
fun SettingsDialog(controller: AppController, onDismiss: () -> Unit) {
    val me = controller.store.me ?: controller.me
    val scope = rememberCoroutineScope()
    var displayName by remember { mutableStateOf(me?.displayName ?: "") }
    var title by remember { mutableStateOf(me?.title ?: "") }
    // M12g: notification keywords, edited as a comma-separated line.
    var keywords by remember { mutableStateOf((me?.notifyKeywords ?: emptyList()).joinToString(", ")) }
    val parsedKeywords: List<String> = keywords.split(Regex("[,、\\n]")).map { it.trim() }.filter { it.isNotEmpty() }.take(20)
    val keywordsChanged = parsedKeywords != (me?.notifyKeywords ?: emptyList<String>())
    var nameSaved by remember { mutableStateOf(false) }
    var editingStatus by remember { mutableStateOf(false) }
    if (editingStatus) {
        StatusDialog(controller, onDismiss = { editingStatus = false })
        return
    }
    // M12i: whether my account asks for an authenticator code, and the setup / disable dialogs.
    var totp by remember { mutableStateOf<TotpStatusOut?>(null) }
    var totpDialog by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) { totp = controller.totpStatus() }
    when (totpDialog) {
        "setup" -> { TotpSetupDialog(controller, onDismiss = { totpDialog = null }, onEnabled = { totpDialog = null; scope.launch { totp = controller.totpStatus() } }); return }
        "disable" -> { TotpDisableDialog(controller, onDismiss = { totpDialog = null }, onDisabled = { totpDialog = null; scope.launch { totp = controller.totpStatus() } }); return }
    }
    var current by remember { mutableStateOf("") }
    var next by remember { mutableStateOf("") }
    var repeat by remember { mutableStateOf("") }
    var passwordMessage by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("設定") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                if (me != null) {
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(bottom = 8.dp)) {
                        Avatar(me.id, me.displayName, size = 44.dp)
                        Column(Modifier.padding(start = 12.dp)) {
                            Text(me.displayName, style = MaterialTheme.typography.titleMedium)
                            Text("@" + me.username, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                    // M14a: profile picture
                    val avatarPicker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri -> if (uri != null) scope.launch { controller.uploadAvatar(uri) } }
                    Row {
                        TextButton(onClick = { avatarPicker.launch("image/*") }, contentPadding = PaddingValues(0.dp)) { Text("写真を選ぶ") }
                        if (me.avatarUpdatedAt != null) TextButton(onClick = { scope.launch { controller.deleteAvatar() } }, contentPadding = PaddingValues(0.dp)) { Text("写真を削除", color = MaterialTheme.colorScheme.error) }
                    }
                }
                SectionLabel("ステータス")
                val status = jp.chikuwachat.android.api.activeStatus(me?.let { controller.store.users[it.id] ?: it.asPublic })
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(status?.let { (it.first + " " + it.second).trim() } ?: "未設定", modifier = Modifier.weight(1f), color = if (status == null) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface)
                    TextButton(onClick = { editingStatus = true }) { Text(if (status == null) "設定" else "変更") }
                }
                SectionLabel("プロフィール")
                OutlinedTextField(displayName, { displayName = it.take(80); nameSaved = false }, label = { Text("表示名") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                OutlinedTextField(title, { title = it.take(80); nameSaved = false }, label = { Text("肩書 (任意)") }, singleLine = true, modifier = Modifier.fillMaxWidth().padding(top = 6.dp))
                OutlinedTextField(keywords, { keywords = it; nameSaved = false }, label = { Text("通知キーワード (任意、コンマ区切り)") }, singleLine = true, modifier = Modifier.fillMaxWidth().padding(top = 6.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    TextButton(
                        enabled = !busy && displayName.isNotBlank() && (displayName.trim() != me?.displayName || title.trim().ifEmpty { null } != me?.title || keywordsChanged),
                        onClick = {
                            scope.launch {
                                busy = true
                                var ok = true
                                if (displayName.trim() != me?.displayName) ok = controller.updateDisplayName(displayName)
                                if (ok && title.trim().ifEmpty { null } != me?.title) ok = controller.updateProfile(mapOf("title" to title.trim().ifEmpty { null }))
                                if (ok && keywordsChanged) ok = controller.updateProfileJson(buildJsonObject { put("notify_keywords", buildJsonArray { parsedKeywords.forEach { add(JsonPrimitive(it)) } }) })
                                nameSaved = ok
                                busy = false
                            }
                        },
                    ) { Text("プロフィールを保存") }
                    if (nameSaved) Text("保存しました", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                SectionLabel("2 要素認証")
                Row(verticalAlignment = Alignment.CenterVertically) {
                    val status = totp
                    Column(Modifier.weight(1f)) {
                        Text(when { status == null -> "確認中…"; status.enabled -> "有効"; else -> "無効" })
                        if (status != null) Text(
                            if (status.enabled) "ログイン時に認証アプリのコードが必要です · 回復コード残り ${status.recoveryCodesLeft}" else "パスワードだけでログインできます",
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    if (status != null) TextButton(onClick = { totpDialog = if (status.enabled) "disable" else "setup" }) { Text(if (status.enabled) "無効にする" else "有効にする") }
                }
                SectionLabel("パスワードの変更")
                OutlinedTextField(current, { current = it }, label = { Text("現在のパスワード") }, singleLine = true, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth())
                OutlinedTextField(next, { next = it }, label = { Text("新しいパスワード (8 文字以上)") }, singleLine = true, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth().padding(top = 6.dp))
                OutlinedTextField(repeat, { repeat = it }, label = { Text("新しいパスワード (確認)") }, singleLine = true, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth().padding(top = 6.dp))
                passwordMessage?.let { Text(it, color = if (it.endsWith("しました")) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 6.dp)) }
                TextButton(
                    enabled = !busy && current.isNotEmpty() && next.length >= 8,
                    onClick = {
                        if (next != repeat) { passwordMessage = "新しいパスワードが一致しません"; return@TextButton }
                        scope.launch {
                            busy = true
                            val error = controller.changePasswordInSession(current, next)
                            busy = false
                            passwordMessage = error ?: "パスワードを変更しました"
                            if (error == null) { current = ""; next = ""; repeat = "" }
                        }
                    },
                ) { Text("変更する") }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("閉じる") } },
        dismissButton = { TextButton(onClick = { scope.launch { controller.logout() } }) { Text("ログアウト", color = MaterialTheme.colorScheme.error) } },
    )
}

@Composable
private fun SectionLabel(text: String) {
    Text(text, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 12.dp, bottom = 4.dp))
}
