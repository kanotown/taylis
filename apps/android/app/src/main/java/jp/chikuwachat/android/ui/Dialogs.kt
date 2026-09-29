package jp.chikuwachat.android.ui

import android.graphics.Bitmap
import kotlinx.serialization.json.put
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
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
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.HorizontalDivider
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.RadioButton
import androidx.compose.ui.text.input.PasswordVisualTransformation
import jp.chikuwachat.android.api.MemberOut
import jp.chikuwachat.android.api.TotpStatusOut
import jp.chikuwachat.android.sync.ChannelState
import jp.chikuwachat.android.sync.NotificationLevels
import java.time.Instant
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
 * Channel details (M29: a full-screen page in place of the conversation, the app bar's ← and back return to it): topic
 * and purpose (editable by members), notification level and mute, members with roles and 「メンバーを追加」, links,
 * posting policy, convert, rename, archive, leave. `onClose` leaves the page (also after leaving or archiving).
 * `version` (M28c): the members' names, presence and status come from the Store.
 */
@Composable
fun ChannelDetailsPane(controller: AppController, channel: ChannelState, version: Int, onClose: () -> Unit) {
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
    // M35: the channel's own level (null = it follows the overall setting), the mute until unmuted, the timed mute.
    val ownLevel = NotificationLevels.own(channel)
    val overall = (store.me ?: controller.me)?.notificationDefault ?: NotificationLevels.MENTIONS
    val mutedOn = NotificationLevels.mutedUntilUnmuted(channel)
    val mute = Timeline.muteLabel(channel.channel.notification?.mutedUntil)

    Column(Modifier.fillMaxSize().imePadding().verticalScroll(rememberScrollState()).padding(horizontal = 16.dp).padding(bottom = 24.dp)) {
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
                if (channel.isMember && !channel.channel.archived) TextButton(onClick = { topic = channel.channel.topic ?: ""; editingTopic = true }, contentPadding = PaddingValues(0.dp)) { Text("編集") }
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
                if (channel.isMember && !channel.channel.archived) TextButton(onClick = { purpose = channel.channel.purpose ?: ""; editingPurpose = true }, contentPadding = PaddingValues(0.dp)) { Text("編集") }
            }
        }
        if (channel.isMember) {
            SectionLabel("通知")
            // Whole rows as radio buttons, 48 dp high (TalkBack reads the choice and its state).
            Column(Modifier.selectableGroup()) {
                (listOf<Pair<String?, String>>(null to NotificationLabels.defaultChoice(overall)) + NotificationLevels.levels.map { it to NotificationLabels.label(it) })
                    .forEach { (value, label) ->
                        Row(
                            Modifier.fillMaxWidth().heightIn(min = TouchTarget.MIN).selectable(selected = ownLevel == value, role = Role.RadioButton) {
                                scope.launch { controller.setChannelLevel(channel.id, value) }
                            },
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            RadioButton(selected = ownLevel == value, onClick = null)
                            Text(label, modifier = Modifier.padding(start = 8.dp))
                        }
                    }
            }
            // M35: muted until unmuted; the whole row toggles it (48 dp, TalkBack reads it as a switch).
            Row(
                Modifier.fillMaxWidth().heightIn(min = TouchTarget.MIN).toggleable(value = mutedOn, role = Role.Switch) { on ->
                    scope.launch { controller.setChannelMuted(channel.id, on) }
                },
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text("ミュート")
                    Text("解除するまで通知しません (メンションだけ未読になります)", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Switch(checked = mutedOn, onCheckedChange = null, modifier = Modifier.padding(start = 8.dp))
            }
            if (mute != null) {
                TextButton(onClick = { scope.launch { controller.setChannelTimedMute(channel.id, null) } }, contentPadding = PaddingValues(0.dp)) { Text("ミュート解除 ($mute)") }
            } else {
                TextButton(onClick = { scope.launch { controller.setChannelTimedMute(channel.id, Instant.now().plusSeconds(8 * 3600).toString()) } }, contentPadding = PaddingValues(0.dp)) { Text("8 時間ミュート") }
            }
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
                            StatusEmoji(user, modifier = Modifier.padding(start = 6.dp))
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
 * M34, the 自分 tab (MOBILE_UI.md §6.5): what the settings dialog held, as a page (M36 splits it into screens): the
 * photo, status, presence, profile, notification keywords, two-factor, password and logout. `version`: 「在席を隠す」
 * follows my UserMe in the Store (M31). `scrollState`: the tab's re-tap scrolls it to the top.
 */
@Composable
fun YouScreen(controller: AppController, version: Int, scrollState: ScrollState) {
    val me = controller.store.me ?: controller.me
    val presenceHidden = remember(version) { (controller.store.me ?: controller.me)?.presenceHidden ?: false }
    var savingPresence by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    var displayName by rememberSaveable { mutableStateOf(me?.displayName ?: "") }
    var title by rememberSaveable { mutableStateOf(me?.title ?: "") }
    val myName = me?.displayName
    val myTitle = me?.title
    // M12g: notification keywords, edited as a comma-separated line.
    var keywords by rememberSaveable { mutableStateOf((me?.notifyKeywords ?: emptyList()).joinToString(", ")) }
    val parsedKeywords: List<String> = keywords.split(Regex("[,、\\n]")).map { it.trim() }.filter { it.isNotEmpty() }.take(20)
    val keywordsChanged = parsedKeywords != (me?.notifyKeywords ?: emptyList<String>())
    // M23: my research topic and reading, only when an administrator has put me on the lab roster (keyed on that, so
    // the fields start from my line whenever it appears).
    val line = me?.let { controller.store.roster[it.id] }
    var topic by remember(line == null) { mutableStateOf(line?.researchTopic ?: "") }
    var reading by remember(line == null) { mutableStateOf(line?.reading ?: "") }
    val lineChanged = line != null && (topic.trim().ifEmpty { null } != line.researchTopic || reading.trim().ifEmpty { null } != line.reading)
    var nameSaved by remember { mutableStateOf(false) }
    var editingStatus by rememberSaveable { mutableStateOf(false) }
    if (editingStatus) StatusDialog(controller, onDismiss = { editingStatus = false })
    // M12i: whether my account asks for an authenticator code, and the setup / disable dialogs.
    var totp by remember { mutableStateOf<TotpStatusOut?>(null) }
    var totpDialog by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) { totp = controller.totpStatus() }
    when (totpDialog) {
        "setup" -> TotpSetupDialog(controller, onDismiss = { totpDialog = null }, onEnabled = { totpDialog = null; scope.launch { totp = controller.totpStatus() } })
        "disable" -> TotpDisableDialog(controller, onDismiss = { totpDialog = null }, onDisabled = { totpDialog = null; scope.launch { totp = controller.totpStatus() } })
    }
    var current by remember { mutableStateOf("") }
    var next by remember { mutableStateOf("") }
    var repeat by remember { mutableStateOf("") }
    var passwordMessage by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    // The keyboard of a field pushes the page up (the bottom bar's height is already taken off, MainScreen).
    Column(Modifier.fillMaxSize().imePadding().verticalScroll(scrollState).padding(horizontal = 24.dp, vertical = 16.dp)) {
        if (me != null) {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(bottom = 8.dp)) {
                Avatar(me.id, me.displayName, size = 44.dp)
                Column(Modifier.padding(start = 12.dp)) {
                    Text(me.displayName, style = MaterialTheme.typography.titleMedium)
                    Text("@" + me.username, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            // M14a / M16g: profile picture — any photo, loaded small, then its square chosen in AvatarCropDialog
            var cropping by remember { mutableStateOf<Bitmap?>(null) }
            var loadingPhoto by remember { mutableStateOf(false) }
            val avatarPicker = rememberLauncherForActivityResult(ActivityResultContracts.GetContent()) { uri ->
                if (uri != null) scope.launch {
                    loadingPhoto = true
                    cropping = controller.loadAvatarPhoto(uri)
                    loadingPhoto = false
                }
            }
            cropping?.let { bitmap ->
                AvatarCropDialog(bitmap, onCancel = { cropping = null }) { jpeg ->
                    cropping = null
                    scope.launch { controller.uploadAvatar(jpeg) }
                }
            }
            Row(horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                TextButton(onClick = { avatarPicker.launch("image/*") }, enabled = !loadingPhoto, contentPadding = PaddingValues(0.dp)) {
                    Text(if (loadingPhoto) "写真を読み込んでいます…" else "写真を選ぶ")
                }
                if (me.avatarUpdatedAt != null) TextButton(onClick = { scope.launch { controller.deleteAvatar() } }, contentPadding = PaddingValues(0.dp)) { Text("写真を削除", color = MaterialTheme.colorScheme.error) }
            }
        }
        SectionLabel("ステータス")
        val status = jp.chikuwachat.android.api.activeStatus(me?.let { controller.store.users[it.id] ?: it.asPublic })
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(status?.let { (it.first + " " + it.second).trim() } ?: "未設定", modifier = Modifier.weight(1f), color = if (status == null) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface)
            TextButton(onClick = { editingStatus = true }) { Text(if (status == null) "設定" else "変更") }
        }
        // L4 (M31): others always see me offline; the whole row toggles it (48 dp).
        SectionLabel("在席")
        Row(
            Modifier.fillMaxWidth().heightIn(min = TouchTarget.MIN).toggleable(value = presenceHidden, enabled = !savingPresence, role = Role.Switch) { on ->
                scope.launch {
                    savingPresence = true
                    controller.setPresenceHidden(on)
                    savingPresence = false
                }
            },
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text("在席を隠す")
                Text("ほかの人からは常にオフラインに見えます", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Switch(checked = presenceHidden, onCheckedChange = null, enabled = !savingPresence, modifier = Modifier.padding(start = 8.dp))
        }
        SectionLabel("プロフィール")
        OutlinedTextField(displayName, { displayName = it.take(80); nameSaved = false }, label = { Text("表示名") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(title, { title = it.take(80); nameSaved = false }, label = { Text("肩書 (任意)") }, singleLine = true, modifier = Modifier.fillMaxWidth().padding(top = 6.dp))
        if (line != null) {
            OutlinedTextField(
                topic, { topic = it.take(200); nameSaved = false }, label = { Text("研究テーマ (任意)") }, placeholder = { Text("例: 拡散モデルによる音声合成") },
                singleLine = true, modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
            )
            OutlinedTextField(
                reading, { reading = it.take(80); nameSaved = false }, label = { Text("よみ (任意、名簿の並び順に使います)") }, placeholder = { Text("例: かのう とおる") },
                singleLine = true, modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
            )
        }
        OutlinedTextField(keywords, { keywords = it; nameSaved = false }, label = { Text("通知キーワード (任意、コンマ区切り)") }, singleLine = true, modifier = Modifier.fillMaxWidth().padding(top = 6.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextButton(
                enabled = !busy && displayName.isNotBlank() && (displayName.trim() != myName || title.trim().ifEmpty { null } != myTitle || keywordsChanged || lineChanged),
                onClick = {
                    scope.launch {
                        busy = true
                        var ok = true
                        if (displayName.trim() != me?.displayName) ok = controller.updateDisplayName(displayName)
                        if (ok && title.trim().ifEmpty { null } != me?.title) ok = controller.updateProfile(mapOf("title" to title.trim().ifEmpty { null }))
                        if (ok && keywordsChanged) ok = controller.updateProfileJson(buildJsonObject { put("notify_keywords", buildJsonArray { parsedKeywords.forEach { add(JsonPrimitive(it)) } }) })
                        if (ok && lineChanged) ok = controller.updateMyRosterLine(topic.trim().ifEmpty { null }, reading.trim().ifEmpty { null })
                        nameSaved = ok
                        busy = false
                    }
                },
            ) { Text("プロフィールを保存") }
            if (nameSaved) Text("保存しました", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        // M35: the overall notification setting, for channels without a level of their own (pushes only).
        SectionLabel("通知")
        val overall = remember(version) { (controller.store.me ?: controller.me)?.notificationDefault ?: NotificationLevels.MENTIONS }
        var savingOverall by remember { mutableStateOf(false) }
        Column(Modifier.selectableGroup()) {
            NotificationLevels.levels.forEach { value ->
                Row(
                    Modifier.fillMaxWidth().heightIn(min = TouchTarget.MIN)
                        .selectable(selected = overall == value, enabled = !savingOverall, role = Role.RadioButton) {
                            if (overall != value) scope.launch {
                                savingOverall = true
                                controller.setNotificationDefault(value)
                                savingOverall = false
                            }
                        },
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    RadioButton(selected = overall == value, onClick = null, enabled = !savingOverall)
                    Text(NotificationLabels.overallLabel(value), modifier = Modifier.padding(start = 8.dp))
                }
            }
        }
        Text(NotificationLabels.OVERALL_FOOTNOTE, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        // M28c: the notification permission is asked once after sign-in; a refusal shows here with the way to the
        // system's page (checked again when the app comes back from it).
        val notificationsPermitted = remember(controller.appForeground) { controller.notificationsPermitted }
        if (!notificationsPermitted) {
            Text("通知が許可されていないため、新しいメッセージの通知は届きません", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 8.dp))
            TextButton(onClick = { controller.openNotificationSettings() }, contentPadding = PaddingValues(0.dp)) { Text("端末の設定で許可する") }
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
        HorizontalDivider(Modifier.padding(vertical = 12.dp))
        // M16c: with several workspaces, say which one this signs out of (the others stay signed in).
        val logoutLabel = if (controller.workspaces.size > 1) "${controller.workspaceName} からログアウト" else "ログアウト"
        TextButton(onClick = { scope.launch { controller.logout() } }, contentPadding = PaddingValues(0.dp)) {
            Text(logoutLabel, color = MaterialTheme.colorScheme.error)
        }
    }
}

@Composable
private fun SectionLabel(text: String) {
    Text(text, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 12.dp, bottom = 4.dp))
}
