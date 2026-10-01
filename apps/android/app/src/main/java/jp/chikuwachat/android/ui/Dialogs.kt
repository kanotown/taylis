package jp.chikuwachat.android.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import jp.chikuwachat.android.api.MemberOut
import jp.chikuwachat.android.sync.ChannelState
import jp.chikuwachat.android.api.UserPublic
import jp.chikuwachat.android.app.AppController
import kotlinx.coroutines.launch

@Composable
fun NewChannelDialog(controller: AppController, onDismiss: () -> Unit, onOpened: (String) -> Unit) {
    // The forms in this file survive a rotation (M28c): what was typed was lost with the activity.
    var name by rememberSaveable { mutableStateOf("") }
    var isPrivate by rememberSaveable { mutableStateOf(false) }
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
    val version by store.version.collectAsState()
    val users = remember(store, version) { store.users.values.filter { it.id != store.me?.id && it.deactivatedAt == null }.sortedBy { it.displayName } }
    var selected by remember { mutableStateOf(setOf<String>()) }
    var query by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    fun start(ids: List<String>) {
        if (busy || ids.isEmpty()) return
        busy = true
        error = null
        scope.launch {
            try {
                controller.createDm(ids).onSuccess { onOpened(it); onDismiss() }.onFailure { error = controller.describe(it) }
            } finally { busy = false }
        }
    }
    // The server allows nine members including me, so at most eight recipients.
    val maxRecipients = 8
    val visible = users.filter { it.displayName.contains(query, ignoreCase = true) || it.username.contains(query, ignoreCase = true) }
    val recipients = selected.filter { id -> users.any { it.id == id } }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("ダイレクトメッセージ") },
        text = {
            Column {
                Text("複数選ぶとグループ DM になります (相手は8人まで)", style = MaterialTheme.typography.bodySmall)
                // A DM with only myself, titled with my name (as in Slack / Mattermost).
                store.me?.id?.let { me ->
                    TextButton(enabled = !busy, onClick = { start(listOf(me)) }) { Text("${myDisplayName(store)} (${MainTabs.SELF_NOTES_HINT})") }
                }
                OutlinedTextField(query, { query = it }, label = { Text("名前で検索") }, singleLine = true, modifier = Modifier.fillMaxWidth())
                if (users.isEmpty()) Text("相手になるユーザーがいません")
                else if (visible.isEmpty()) Text("一致するユーザーがいません")
                LazyColumn(Modifier.heightIn(max = 280.dp)) {
                    items(visible, key = { it.id }) { user ->
                        val checked = user.id in selected
                        val enabled = !busy && (checked || recipients.size < maxRecipients)
                        Row(
                            Modifier.fillMaxWidth().toggleable(value = checked, enabled = enabled, role = Role.Checkbox, onValueChange = {
                                selected = if (checked) selected - user.id else selected + user.id
                            }).padding(vertical = 8.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Checkbox(checked = checked, onCheckedChange = null, enabled = enabled)
                            Column(Modifier.padding(start = 8.dp)) {
                                Text(user.displayName)
                                Text("@${user.username}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                    }
                }
                Text("${recipients.size} / $maxRecipients 人を選択", style = MaterialTheme.typography.bodySmall)
                error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            }
        },
        confirmButton = { TextButton(enabled = !busy && recipients.isNotEmpty(), onClick = { start(recipients) }) { Text(if (busy) "開始中…" else "開始") } },
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

/**
 * Channel details (M29: a full-screen page in place of the conversation, the app bar's ← and back return to it): D1's
 * header (glyph, name, member count, topic and round buttons: favourite, notifications, search, add), topic and purpose
 * (editable by members), notifications in one row, members with roles and 「メンバーを追加」, links, posting policy,
 * convert, rename, archive, leave. `onClose` leaves the page (also after leaving or archiving); `onSearch` searches
 * this conversation. `version` (M28c): the members' names, presence and status come from the Store.
 */
@Composable
fun ChannelDetailsPane(controller: AppController, channel: ChannelState, version: Int, onClose: () -> Unit, onSearch: () -> Unit = {}) {
    val store = controller.store
    val scope = rememberCoroutineScope()
    val isChannel = !channel.channel.isDm
    var members by remember { mutableStateOf<List<MemberOut>?>(null) }
    // Loaded again after 「メンバーを追加」 closes (the page stays under the dialog).
    var membersLoad by remember { mutableIntStateOf(0) }
    var profileUserId by rememberSaveable { mutableStateOf<String?>(null) }
    profileUserId?.let { id ->
        ProfileDialog(controller, id, version, onDismiss = { profileUserId = null }, onOpenDm = { profileUserId = null; onClose(); controller.pendingChannelId = it })
    }
    var addingMember by rememberSaveable { mutableStateOf(false) }
    if (addingMember) AddMemberDialog(controller, channel.id, onDismiss = { addingMember = false; membersLoad += 1 })
    var editingTopic by rememberSaveable { mutableStateOf(false) }
    var topic by rememberSaveable { mutableStateOf(channel.channel.topic ?: "") }
    // M11h: purpose editor and channel management (leave; rename / archive for owners and admins).
    var editingPurpose by rememberSaveable { mutableStateOf(false) }
    var purpose by rememberSaveable { mutableStateOf(channel.channel.purpose ?: "") }
    var renaming by rememberSaveable { mutableStateOf(false) }
    var newName by rememberSaveable { mutableStateOf("") }
    var confirm by rememberSaveable { mutableStateOf<String?>(null) }
    val isAdmin = store.me?.role == "admin"
    val canManage = channel.channel.membership?.role == "owner" || isAdmin
    val toPrivate = channel.channel.type == "public"
    // M15f: add a link from channel info (the bar itself only shows once there is one).
    var addingLink by remember { mutableStateOf(false) }
    if (addingLink) ChannelLinkDialog(controller, channel.id, null, onDismiss = { addingLink = false })
    // M31: channel.member_updated (an owner added or taken back, here or elsewhere) loads the list again.
    val memberEpoch = remember(version, channel.id) { store.memberEpoch(channel.id) }
    LaunchedEffect(channel.id, membersLoad, memberEpoch) { controller.memberList(channel.id).onSuccess { members = it } }
    val ownerCount = members?.count { it.role == "owner" } ?: 0
    val myRole = store.me?.role
    // M23: people on the lab roster first in roster order (with their label), then the others by name (someone not
    // loaded yet as a nameless member off the roster).
    val sortedMembers = remember(members, version) {
        members?.sortedWith(compareBy(Roster.listOrder(store.roster, compareBy { it.displayName })) {
            store.users[it.userId] ?: UserPublic(it.userId, "", "", "member", createdAt = "", updatedAt = "")
        })
    }

    Column(Modifier.fillMaxSize().imePadding().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).padding(bottom = 24.dp)) {
        ChannelDetailsHeader(controller, channel, version, memberCount = members?.size, onSearch = onSearch, onAddMember = { addingMember = true })
        // M66 (docs/AI.md §4): what reaches the AI while an AI bot is a member.
        AiTexts.memberNotice(controller.aiStatus?.agents ?: emptyList(), members?.map { it.userId } ?: emptyList())?.let {
            AiMemberNotice(it, Modifier.padding(top = 8.dp))
        }
        val editable = channel.isMember && !channel.channel.archived
        if (isChannel) {
            if (editingTopic) {
                SectionLabel("トピック")
                OutlinedTextField(topic, { topic = it.take(250) }, singleLine = true, modifier = Modifier.fillMaxWidth(), placeholder = { Text("例: 週次の進捗共有") })
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    TextButton(onClick = { scope.launch { if (controller.updateTopic(channel.id, topic)) editingTopic = false } }) { Text("保存") }
                    TextButton(onClick = { editingTopic = false; topic = channel.channel.topic ?: "" }) { Text("キャンセル") }
                }
            } else {
                EditableRow("トピック", channel.channel.topic, editable) { topic = channel.channel.topic ?: ""; editingTopic = true }
            }
            if (editingPurpose) {
                SectionLabel("説明")
                OutlinedTextField(purpose, { purpose = it.take(250) }, singleLine = true, modifier = Modifier.fillMaxWidth(), placeholder = { Text("例: デザインレビューの依頼と結果を共有する") })
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    TextButton(onClick = { scope.launch { if (controller.updatePurpose(channel.id, purpose)) editingPurpose = false } }) { Text("保存") }
                    TextButton(onClick = { editingPurpose = false; purpose = channel.channel.purpose ?: "" }) { Text("キャンセル") }
                }
            } else {
                EditableRow("説明", channel.channel.purpose, editable) { purpose = channel.channel.purpose ?: ""; editingPurpose = true }
            }
        }
        // D1: the level, the mute and the timed mute were six rows here; one row now, the choices open from it.
        if (channel.isMember) ChannelNotificationRow(controller, channel)
        // M66 (docs/AI.md §6): 「要約」 (未読 / 直近 1 日 / 直近 7 日), only to me.
        if (channel.isMember && controller.aiSummaryAvailable) {
            TextButton(onClick = { controller.aiSummaryChooser = channel.id }, contentPadding = PaddingValues(0.dp)) { Text("要約 (未読 / 直近 1 日 / 直近 7 日)") }
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.weight(1f)) { SectionLabel("メンバー" + (members?.let { " (${it.size})" } ?: "")) }
            if (isChannel && channel.isMember && !channel.channel.archived) {
                TextButton(onClick = { addingMember = true }) { Text("メンバーを追加") }
            }
        }
        when (val list = sortedMembers) {
            null -> Text("読み込み中…", color = MaterialTheme.colorScheme.onSurfaceVariant)
            else -> list.forEach { member ->
                val user = store.users[member.userId]
                // The whole row opens the profile (48 dp high).
                Row(
                    Modifier.fillMaxWidth().heightIn(min = TouchTarget.MIN).clickable(onClickLabel = "プロフィールを開く") { profileUserId = member.userId }.padding(vertical = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    val presence = store.presenceOf(member.userId)
                    Avatar(member.userId, user?.displayName ?: "?", size = 28.dp, presence = presence)
                    Column(Modifier.weight(1f).padding(start = 10.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(user?.displayName ?: "?")
                            StatusEmoji(user, controller, version, modifier = Modifier.padding(start = 6.dp))
                            store.roster[member.userId]?.let { RosterBadge(it, Modifier.padding(start = 6.dp)) }
                        }
                        Text("@" + (user?.username ?: "") + (user?.title?.takeIf { it.isNotBlank() }?.let { " · $it" } ?: ""), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    if (presence != "offline") Text(presenceLabel(presence), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(end = 8.dp))
                    if (member.role == "owner") Text("オーナー", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    // M31: 「オーナーにする」 / 「オーナーから外す」 behind a 48 dp menu button (a text button leaves no room for
                    // the name at 360 dp).
                    ChannelOwners.action(channel, myRole, member, user, ownerCount)?.let { action ->
                        var menu by remember { mutableStateOf(false) }
                        Box {
                            IconButton(onClick = { menu = true }) { Icon(Icons.Filled.MoreVert, contentDescription = "メンバーの操作") }
                            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                                DropdownMenuItem(
                                    text = { Text(ChannelOwners.actionLabel(action)) },
                                    onClick = { menu = false; scope.launch { controller.setMemberRole(channel.id, member.userId, action) } },
                                )
                            }
                        }
                    }
                }
            }
        }
        // L6 (M60, RECURRING.md §5): every member reads the list; owners and admins manage it.
        if (isChannel && channel.isMember) RecurringPostsSection(controller, channel, version)
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
                    TextButton(onClick = { scope.launch { if (controller.leaveChannel(channel.id)) onClose() } }) { Text("退出", color = MaterialTheme.colorScheme.error) }
                    TextButton(onClick = { confirm = null }) { Text("キャンセル") }
                }
                "archive" -> Row(verticalAlignment = Alignment.CenterVertically) {
                    Text("アーカイブすると読み取り専用になります。", style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
                    TextButton(onClick = { scope.launch { if (controller.archiveChannel(channel.id)) onClose() } }) { Text("アーカイブ", color = MaterialTheme.colorScheme.error) }
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
                        TextButton(onClick = { scope.launch { if (controller.unarchiveChannel(channel.id)) onClose() } }, contentPadding = PaddingValues(0.dp)) { Text("アーカイブを解除") }
                    }
                    TextButton(onClick = { confirm = "leave" }, contentPadding = PaddingValues(0.dp)) { Text("退出", color = MaterialTheme.colorScheme.error) }
                }
                if (canManage && !channel.channel.archived) {
                    // M15a: an announcement channel; thread replies stay open to everyone. In a times (M24) the same
                    // policy reads as the owner's choice: others answer in threads only.
                    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
                        Text(
                            if (channel.channel.isTimes) "他の人はスレッドでだけ返信できるようにする" else "投稿をオーナーと管理者に限る",
                            style = MaterialTheme.typography.bodyMedium,
                            modifier = Modifier.weight(1f),
                        )
                        Switch(
                            checked = channel.channel.isAnnouncement,
                            onCheckedChange = { on -> scope.launch { controller.setPostingPolicy(channel.id, if (on) "owners" else "everyone") } },
                        )
                    }
                }
                if (ChannelLinks.canEdit(channel, store.me?.role)) {
                    TextButton(onClick = { addingLink = true }, contentPadding = PaddingValues(0.dp)) { Text("リンクを追加") }
                }
                if (ChannelOwners.canConvert(channel, myRole)) {
                    TextButton(onClick = { confirm = "convert" }, contentPadding = PaddingValues(0.dp)) {
                        Text(if (toPrivate) "非公開チャンネルに変換" else "公開チャンネルに変換")
                    }
                }
            }
        }
    }
}

/**
 * D1: a topic / purpose as a label over its text with 「編集」 at the end of the row (the button sat under the text,
 * indented by its own padding).
 */
@Composable
private fun EditableRow(label: String, value: String?, editable: Boolean, onEdit: () -> Unit) {
    Row(Modifier.fillMaxWidth().padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(label, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(
                value?.takeIf { it.isNotBlank() } ?: "未設定",
                color = if (value.isNullOrBlank()) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.padding(top = 2.dp),
            )
        }
        if (editable) TextButton(onClick = onEdit) { Text("編集") }
    }
}

@Composable
private fun SectionLabel(text: String) {
    Text(text, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 12.dp, bottom = 4.dp))
}
