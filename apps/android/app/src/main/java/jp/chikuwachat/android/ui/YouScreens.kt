package jp.chikuwachat.android.ui

import android.graphics.Bitmap
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.outlined.AdminPanelSettings
import androidx.compose.material.icons.outlined.Bedtime
import androidx.compose.material.icons.outlined.Business
import androidx.compose.material.icons.outlined.Computer
import androidx.compose.material.icons.outlined.EmojiEmotions
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.Notifications
import androidx.compose.material.icons.outlined.NotificationsPaused
import androidx.compose.material.icons.outlined.Palette
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.PhoneAndroid
import androidx.compose.material.icons.outlined.PhoneIphone
import androidx.compose.material.icons.outlined.Public
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.time.ZoneId
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.QuietHours
import jp.chikuwachat.android.api.SessionOut
import jp.chikuwachat.android.api.TotpStatusOut
import jp.chikuwachat.android.api.UserMe
import jp.chikuwachat.android.api.activeStatus
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.sync.NotificationLevels
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.put

/**
 * M40 (MOBILE_UI.md §6.5): the 自分 tab. On a phone its list, or the screen pushed over it ([Route.Settings]); from
 * [YouSettings.TWO_PANE_MIN_WIDTH] the list with the chosen screen beside it (the same screens, the same order).
 * `listScroll`: the tab's re-tap scrolls the list to the top. `onSelect` is a row of the list (pushed on a phone,
 * replacing the screen beside the list when wide), `onOpen` a screen's own link (アカウント → パスワード: always pushed,
 * so the row stays marked), `onClose` leaves the screen on top, `onLogout` asks before signing out.
 */
@Composable
fun YouTab(
    controller: AppController,
    version: Int,
    stack: List<Route>,
    twoPane: Boolean,
    listScroll: ScrollState,
    onSelect: (SettingsPage) -> Unit,
    onOpen: (SettingsPage) -> Unit,
    onClose: () -> Unit,
    onLogout: () -> Unit,
) {
    val page = MainNav.settingsPage(stack)
    if (twoPane) {
        Row(Modifier.fillMaxSize()) {
            Box(Modifier.width(360.dp).fillMaxHeight()) {
                YouList(controller, version, listScroll, selected = MainNav.settingsRow(stack), onOpen = onSelect, onLogout = onLogout)
            }
            VerticalDivider()
            Box(Modifier.weight(1f).fillMaxHeight()) {
                if (page != null) {
                    key(page) { SettingsScreen(controller, version, page, onOpen, onClose) }
                } else {
                    Text(
                        "左の一覧から項目を選んでください",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.align(Alignment.Center).padding(24.dp),
                    )
                }
            }
        }
    } else if (page != null) {
        key(page) { SettingsScreen(controller, version, page, onOpen, onClose) }
    } else {
        YouList(controller, version, listScroll, selected = null, onOpen = onSelect, onLogout = onLogout)
    }
}

/** The screen of one row (its title is the app bar's, [SettingsPage.title]). */
@Composable
private fun SettingsScreen(controller: AppController, version: Int, page: SettingsPage, onOpen: (SettingsPage) -> Unit, onClose: () -> Unit) {
    when (page) {
        SettingsPage.STATUS -> StatusScreen(controller, version, onDone = onClose)
        SettingsPage.QUIET_HOURS -> QuietHoursScreen(controller, version, onDone = onClose)
        SettingsPage.NOTIFICATIONS -> NotificationSettingsScreen(controller, version)
        SettingsPage.APPEARANCE -> AppearanceScreen(controller)
        SettingsPage.PROFILE -> ProfileEditScreen(controller, version)
        SettingsPage.ACCOUNT -> AccountScreen(controller, onOpen)
        SettingsPage.PASSWORD -> PasswordScreen(controller)
        SettingsPage.WORKSPACES -> WorkspacesPane(controller)
        SettingsPage.ADMIN -> AdminScreen(controller)
    }
}

/** Me as the Store has me (the socket's updates), else as the login returned me. */
private fun meOf(controller: AppController): UserMe? = controller.store.me ?: controller.me

// --- the list ---

@Composable
private fun YouList(controller: AppController, version: Int, scroll: ScrollState, selected: SettingsPage?, onOpen: (SettingsPage) -> Unit, onLogout: () -> Unit) {
    val me = remember(version, controller.me) { meOf(controller) }
    val public = remember(version, me) { me?.let { controller.store.users[it.id] ?: it.asPublic } }
    val scope = rememberCoroutineScope()
    Column(Modifier.fillMaxSize().verticalScroll(scroll).padding(bottom = 16.dp)) {
        if (me != null) {
            // (1) Me: the picture, the name, @username · 肩書 (a tap edits the profile).
            Row(
                Modifier.fillMaxWidth().clickable(onClickLabel = "プロフィールを編集") { onOpen(SettingsPage.PROFILE) }.padding(horizontal = 16.dp, vertical = 16.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Avatar(me.id, me.displayName, size = 64.dp)
                Column(Modifier.padding(start = 16.dp).weight(1f)) {
                    Text(me.displayName, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Text(YouSettings.handle(me.username, me.title), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
            // 「ステータスを更新」: the status as it is, or the invitation to set one.
            val status = activeStatus(public)
            Surface(
                onClick = { onOpen(SettingsPage.STATUS) },
                shape = RoundedCornerShape(12.dp),
                color = if (selected == SettingsPage.STATUS) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.surfaceContainerHigh,
                modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp).heightIn(min = 48.dp),
            ) {
                Row(Modifier.padding(horizontal = 14.dp, vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(status?.first?.ifEmpty { null } ?: "😀", style = MaterialTheme.typography.titleMedium)
                    Column(Modifier.padding(start = 10.dp).weight(1f)) {
                        Text(
                            status?.second?.ifEmpty { null } ?: if (status != null) "ステータス" else "ステータスを更新",
                            color = if (status == null) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
                            maxLines = 1, overflow = TextOverflow.Ellipsis,
                        )
                        if (status != null) expiryLabel(public?.statusExpiresAt)?.let {
                            Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
            Spacer(Modifier.padding(top = 8.dp))
            // (2) What is used often: the pause (a menu of its choices) and the quiet hours.
            val dndUntil = public?.dndUntil
            val paused = YouSettings.paused(dndUntil)
            var pauseMenu by remember { mutableStateOf(false) }
            var pickingPause by rememberSaveable { mutableStateOf(false) }
            fun pause(value: String?) { scope.launch { controller.updateProfile(mapOf("dnd_until" to value)) } }
            Box {
                SettingsRow(
                    Icons.Outlined.NotificationsPaused, "通知を一時停止", YouSettings.pauseSummary(dndUntil), chevron = false,
                    onClick = { pauseMenu = true },
                )
                DropdownMenu(expanded = pauseMenu, onDismissRequest = { pauseMenu = false }, modifier = Modifier.widthIn(min = 200.dp)) {
                    YouSettings.pauseChoices(paused).forEach { choice ->
                        DropdownMenuItem(
                            text = { Text(choice.label, color = if (choice == PauseChoice.RESUME) MaterialTheme.colorScheme.primary else Color.Unspecified) },
                            onClick = {
                                pauseMenu = false
                                if (choice == PauseChoice.CUSTOM) pickingPause = true else pause(YouSettings.dndUntil(choice))
                            },
                        )
                    }
                }
            }
            if (pickingPause) {
                ScheduleDialog(
                    onDismiss = { pickingPause = false },
                    title = "通知を一時停止",
                    confirm = "停止する",
                    describe = { Schedule.label(it) + " まで通知を止めます" },
                ) { at ->
                    pickingPause = false
                    pause(YouSettings.dndUntil(PauseChoice.CUSTOM, picked = at))
                }
            }
            SettingsRow(
                Icons.Outlined.Bedtime, "おやすみ時間", YouSettings.quietSummary(public?.quietHours),
                selected = selected == SettingsPage.QUIET_HOURS, onClick = { onOpen(SettingsPage.QUIET_HOURS) },
            )
        }
        HorizontalDivider(Modifier.padding(vertical = 8.dp))
        // (3) The screens.
        SettingsPage.listed(isAdmin = me?.role == "admin").forEach { page ->
            val value = when (page) {
                SettingsPage.NOTIFICATIONS -> NotificationLabels.overallLabel(me?.notificationDefault ?: NotificationLevels.MENTIONS)
                SettingsPage.APPEARANCE -> controller.appearance.label
                SettingsPage.WORKSPACES -> controller.workspaceName
                else -> null
            }
            SettingsRow(rowIcon(page), page.title, value, selected = selected == page, onClick = { onOpen(page) })
        }
        HorizontalDivider(Modifier.padding(vertical = 8.dp))
        // M16c: with several workspaces, say which one this signs out of (the others stay signed in).
        val logoutLabel = if (controller.workspaces.size > 1) "${controller.workspaceName} からログアウト" else "ログアウト"
        ListItem(
            headlineContent = { Text(logoutLabel, color = MaterialTheme.colorScheme.error) },
            leadingContent = { Icon(Icons.AutoMirrored.Filled.Logout, contentDescription = null, tint = MaterialTheme.colorScheme.error) },
            colors = ListItemDefaults.colors(containerColor = Color.Transparent),
            modifier = Modifier.fillMaxWidth().clickable(onClick = onLogout),
        )
    }
}

private fun rowIcon(page: SettingsPage): ImageVector = when (page) {
    SettingsPage.NOTIFICATIONS -> Icons.Outlined.Notifications
    SettingsPage.APPEARANCE -> Icons.Outlined.Palette
    SettingsPage.PROFILE -> Icons.Outlined.Person
    SettingsPage.ACCOUNT, SettingsPage.PASSWORD -> Icons.Outlined.Lock
    SettingsPage.WORKSPACES -> Icons.Outlined.Business
    SettingsPage.ADMIN -> Icons.Outlined.AdminPanelSettings
    SettingsPage.STATUS -> Icons.Outlined.Person
    SettingsPage.QUIET_HOURS -> Icons.Outlined.Bedtime
}

/** A row of the list: icon, title, its value on the right and › (a screen opens); highlighted beside its screen (wide). */
@Composable
private fun SettingsRow(icon: ImageVector, title: String, value: String?, selected: Boolean = false, chevron: Boolean = true, onClick: () -> Unit) {
    ListItem(
        headlineContent = { Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
        leadingContent = { Icon(icon, contentDescription = null) },
        trailingContent = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                if (value != null) {
                    Text(value, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.widthIn(max = 160.dp))
                }
                if (chevron) Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        },
        colors = ListItemDefaults.colors(containerColor = if (selected) MaterialTheme.colorScheme.secondaryContainer else Color.Transparent),
        modifier = Modifier.fillMaxWidth().clickable(onClick = onClick),
    )
}

// --- the screens ---

/** A screen's scrolling column; a field's keyboard pushes it up. */
@Composable
private fun ScreenColumn(content: @Composable () -> Unit) {
    // A form no wider than 640 dp (a tablet's pane would stretch its fields across the screen).
    Column(Modifier.fillMaxSize().imePadding().verticalScroll(rememberScrollState())) {
        Column(Modifier.widthIn(max = 680.dp).padding(horizontal = 20.dp, vertical = 12.dp)) { content() }
    }
}

@Composable
private fun SectionTitle(text: String) {
    Text(
        text, style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary,
        modifier = Modifier.padding(top = 16.dp, bottom = 6.dp).semantics { heading() },
    )
}

@Composable
private fun Hint(text: String, modifier: Modifier = Modifier) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = modifier)
}

/** A whole row as a switch (48 dp; TalkBack reads it as one). */
@Composable
private fun SwitchRow(title: String, detail: String?, checked: Boolean, enabled: Boolean = true, onChange: (Boolean) -> Unit) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = TouchTarget.MIN).toggleable(value = checked, enabled = enabled, role = Role.Switch, onValueChange = onChange),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title)
            if (detail != null) Hint(detail)
        }
        Switch(checked = checked, onCheckedChange = null, enabled = enabled, modifier = Modifier.padding(start = 8.dp))
    }
}

/** A whole row as a radio button (48 dp). */
@Composable
private fun RadioRow(label: String, selected: Boolean, enabled: Boolean = true, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = TouchTarget.MIN).selectable(selected = selected, enabled = enabled, role = Role.RadioButton, onClick = onClick),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        RadioButton(selected = selected, onClick = null, enabled = enabled)
        Text(label, modifier = Modifier.padding(start = 12.dp))
    }
}

private val STATUS_PRESETS = listOf("📅" to "会議中", "🚌" to "移動中", "🤒" to "体調不良", "🌴" to "休暇中", "🏠" to "在宅勤務", "🍱" to "昼休み")
private val EXPIRY_OPTIONS = listOf("never" to "消さない", "30m" to "30 分後", "1h" to "1 時間後", "4h" to "4 時間後", "today" to "今日の終わり", "week" to "今週の終わり")

/** 「ステータスを更新」 (M11d): the emoji, the words, when it disappears; presets; クリア. Saved, the screen closes. */
@Composable
private fun StatusScreen(controller: AppController, version: Int, onDone: () -> Unit) {
    val me = remember(version) { meOf(controller) }
    val current = remember(version) { activeStatus(me?.let { controller.store.users[it.id] ?: it.asPublic }) }
    var emoji by rememberSaveable { mutableStateOf(current?.first ?: "") }
    var text by rememberSaveable { mutableStateOf(current?.second ?: "") }
    var expiry by rememberSaveable { mutableStateOf("never") }
    var busy by remember { mutableStateOf(false) }
    // The emoji comes from the picker: a text field there only brought up the keyboard (testers, 2026-09-30).
    var pickingEmoji by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val store = controller.store
    if (pickingEmoji) {
        EmojiPickerDialog(custom = store.customEmoji.values.toList(), images = store.emojiImages, animations = store.emojiAnimations,
            onNeedImage = { controller.loadEmojiImage(it) }, onDismiss = { pickingEmoji = false }, onPick = { pickingEmoji = false; emoji = it })
    }
    ScreenColumn {
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedButton(onClick = { pickingEmoji = true }, modifier = Modifier.size(56.dp), contentPadding = PaddingValues(0.dp),
                shape = RoundedCornerShape(12.dp)) {
                if (emoji.isEmpty()) Icon(Icons.Outlined.EmojiEmotions, contentDescription = "絵文字を選ぶ")
                else Text(emoji, fontSize = 24.sp, modifier = Modifier.semantics { contentDescription = "絵文字を変更" })
            }
            if (emoji.isNotEmpty()) TextButton(onClick = { emoji = "" }) { Text("外す") }
            Spacer(Modifier.width(8.dp))
            OutlinedTextField(text, { text = it.take(100) }, modifier = Modifier.weight(1f), label = { Text("今なにしてる？") }, singleLine = true)
        }
        FlowRow(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            STATUS_PRESETS.forEach { (e, t) -> FilterChip(selected = text == t && emoji == e, onClick = { emoji = e; text = t }, label = { Text("$e $t") }) }
        }
        SectionTitle("消えるタイミング")
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            EXPIRY_OPTIONS.forEach { (value, label) -> FilterChip(selected = expiry == value, onClick = { expiry = value }, label = { Text(label) }) }
        }
        expiryLabel(expiryAt(expiry))?.let { Hint(it, Modifier.padding(top = 4.dp)) }
        Row(Modifier.padding(top = 20.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Button(
                enabled = !busy && (emoji.isNotBlank() || text.isNotBlank()),
                onClick = {
                    scope.launch {
                        busy = true
                        val body = buildJsonObject {
                            emoji.trim().ifEmpty { null }.let { if (it == null) put("status_emoji", JsonNull) else put("status_emoji", it) }
                            text.trim().ifEmpty { null }.let { if (it == null) put("status_text", JsonNull) else put("status_text", it) }
                            expiryAt(expiry).let { if (it == null) put("status_expires_at", JsonNull) else put("status_expires_at", it) }
                        }
                        val ok = controller.updateProfileJson(body)
                        busy = false
                        if (ok) onDone()
                    }
                },
            ) { Text("保存") }
            if (current != null) {
                OutlinedButton(enabled = !busy, onClick = {
                    scope.launch {
                        busy = true
                        val ok = controller.updateProfile(mapOf("status_emoji" to null, "status_text" to null, "status_expires_at" to null))
                        busy = false
                        if (ok) onDone()
                    }
                }) { Text("クリア") }
            }
        }
    }
}

/** 「おやすみ時間」 (M12c, moved out of the status editor): on / off, start and end, the days; saved with 保存. */
@Composable
private fun QuietHoursScreen(controller: AppController, version: Int, onDone: () -> Unit) {
    val saved = remember(version) { meOf(controller)?.let { controller.store.users[it.id]?.quietHours ?: it.quietHours } }
    var on by rememberSaveable { mutableStateOf(saved != null) }
    var start by rememberSaveable { mutableStateOf(saved?.start ?: "22:00") }
    var end by rememberSaveable { mutableStateOf(saved?.end ?: "07:00") }
    var days by rememberSaveable { mutableStateOf((saved?.days?.ifEmpty { null } ?: (0..6).toList()).toSet()) }
    var picking by rememberSaveable { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val zone = remember { ZoneId.systemDefault().id }
    val problem = YouSettings.quietHoursProblem(on, start, end, days)
    val draft = YouSettings.quietHours(on, start, end, days, zone)
    val changed = YouSettings.quietHoursChanged(saved, draft)
    ScreenColumn {
        SwitchRow("おやすみ時間", "毎日この時間帯は通知を止めます", checked = on, onChange = { on = it })
        if (on) {
            Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedButton(onClick = { picking = "start" }, modifier = Modifier.weight(1f)) { Text("開始 $start") }
                OutlinedButton(onClick = { picking = "end" }, modifier = Modifier.weight(1f)) { Text("終了 $end") }
            }
            SectionTitle("曜日")
            FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                Dnd.DAY_LABELS.forEachIndexed { day, label ->
                    FilterChip(selected = day in days, onClick = { days = if (day in days) days - day else days + day }, label = { Text(label) })
                }
            }
            Hint("タイムゾーン: $zone", Modifier.padding(top = 8.dp))
        }
        problem?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(top = 8.dp)) }
        Button(
            enabled = !busy && problem == null && changed,
            modifier = Modifier.padding(top = 20.dp),
            onClick = {
                scope.launch {
                    busy = true
                    val body = buildJsonObject {
                        if (draft == null) put("quiet_hours", JsonNull)
                        else put("quiet_hours", Codec.snake.encodeToJsonElement(QuietHours.serializer(), draft))
                    }
                    val ok = controller.updateProfileJson(body)
                    busy = false
                    if (ok) onDone()
                }
            },
        ) { Text("保存") }
    }
    picking?.let { which ->
        val (h, m) = (if (which == "start") start else end).split(":").map { it.toIntOrNull() ?: 0 }
        TimePickDialog(h, m, title = if (which == "start") "開始時刻" else "終了時刻", onDismiss = { picking = null }) { hour, minute ->
            val value = Dnd.hhmm(hour * 60 + minute)
            if (which == "start") start = value else end = value
            picking = null
        }
    }
}

/**
 * 「通知」: the overall setting (M35), reaction banners (M39), notification keywords (M12g), and whether this device
 * lets the app notify at all, with the way to the system's page (M28c).
 */
@Composable
private fun NotificationSettingsScreen(controller: AppController, version: Int) {
    val me = remember(version) { meOf(controller) }
    val scope = rememberCoroutineScope()
    ScreenColumn {
        SectionTitle("通知する内容")
        val overall = me?.notificationDefault ?: NotificationLevels.MENTIONS
        var savingOverall by remember { mutableStateOf(false) }
        Column(Modifier.selectableGroup()) {
            NotificationLevels.levels.forEach { value ->
                RadioRow(NotificationLabels.overallLabel(value), selected = overall == value, enabled = !savingOverall) {
                    if (overall != value) scope.launch {
                        savingOverall = true
                        controller.setNotificationDefault(value)
                        savingOverall = false
                    }
                }
            }
        }
        Hint(NotificationLabels.OVERALL_FOOTNOTE)
        // M39: only against a server that has the activity.
        if (controller.store.activity != null) {
            var savingReactions by remember { mutableStateOf(false) }
            Spacer(Modifier.padding(top = 8.dp))
            SwitchRow("リアクションのバナー", "オフでもアクティビティに表示されます", checked = me?.notifyReactions ?: false, enabled = !savingReactions) { on ->
                scope.launch {
                    savingReactions = true
                    controller.setNotifyReactions(on)
                    savingReactions = false
                }
            }
        }
        SectionTitle("通知キーワード")
        val savedKeywords = me?.notifyKeywords ?: emptyList()
        var keywords by rememberSaveable { mutableStateOf(savedKeywords.joinToString(", ")) }
        val parsed = keywords.split(Regex("[,、\\n]")).map { it.trim() }.filter { it.isNotEmpty() }.take(20)
        var busy by remember { mutableStateOf(false) }
        var saved by remember { mutableStateOf(false) }
        OutlinedTextField(keywords, { keywords = it; saved = false }, label = { Text("キーワード (コンマ区切り)") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        Hint("この言葉を含むメッセージはメンションと同じように通知されます", Modifier.padding(top = 4.dp))
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 4.dp)) {
            TextButton(enabled = !busy && parsed != savedKeywords, onClick = {
                scope.launch {
                    busy = true
                    saved = controller.updateProfileJson(buildJsonObject { put("notify_keywords", buildJsonArray { parsed.forEach { add(JsonPrimitive(it)) } }) })
                    busy = false
                }
            }) { Text("キーワードを保存") }
            if (saved) Hint("保存しました")
        }
        SectionTitle("この端末の通知")
        // Read again when the app comes back from the system's page.
        val permitted = remember(controller.appForeground) { controller.notificationsPermitted }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(if (permitted) "許可されています" else "許可されていません")
                if (!permitted) Hint("新しいメッセージの通知は届きません")
            }
        }
        OutlinedButton(onClick = { controller.openNotificationSettings() }, modifier = Modifier.padding(top = 8.dp)) {
            Text(if (permitted) "端末の通知設定を開く" else "端末の設定で許可する")
        }
    }
}

/** 「表示」: 端末に合わせる / ライト / ダーク, kept on this device. */
@Composable
private fun AppearanceScreen(controller: AppController) {
    ScreenColumn {
        SectionTitle("テーマ")
        Column(Modifier.selectableGroup()) {
            Appearance.entries.forEach { value ->
                RadioRow(value.label, selected = controller.appearance == value) { controller.changeAppearance(value) }
            }
        }
        Hint("この端末だけの設定です", Modifier.padding(top = 4.dp))
    }
}

/**
 * 「プロフィールを編集」: the picture (M14a / M16g), display name, title, and on the lab roster (M23) my research topic
 * and reading; 「在席を隠す」 (L4, M31) applies at once.
 */
@Composable
private fun ProfileEditScreen(controller: AppController, version: Int) {
    val me = remember(version, controller.me) { meOf(controller) } ?: return
    val scope = rememberCoroutineScope()
    var displayName by rememberSaveable { mutableStateOf(me.displayName) }
    var title by rememberSaveable { mutableStateOf(me.title ?: "") }
    val line = remember(version) { controller.store.roster[me.id] }
    var topic by rememberSaveable(line == null) { mutableStateOf(line?.researchTopic ?: "") }
    var reading by rememberSaveable(line == null) { mutableStateOf(line?.reading ?: "") }
    val lineChanged = line != null && (topic.trim().ifEmpty { null } != line.researchTopic || reading.trim().ifEmpty { null } != line.reading)
    val nameChanged = displayName.trim() != me.displayName
    val titleChanged = title.trim().ifEmpty { null } != me.title
    var busy by remember { mutableStateOf(false) }
    var saved by remember { mutableStateOf(false) }
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
    ScreenColumn {
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(vertical = 8.dp)) {
            Avatar(me.id, me.displayName, size = 80.dp)
            Column(Modifier.padding(start = 16.dp)) {
                TextButton(onClick = { avatarPicker.launch("image/*") }, enabled = !loadingPhoto) {
                    Text(if (loadingPhoto) "写真を読み込んでいます…" else "写真を選ぶ")
                }
                if (me.avatarUpdatedAt != null) {
                    TextButton(onClick = { scope.launch { controller.deleteAvatar() } }) { Text("写真を削除", color = MaterialTheme.colorScheme.error) }
                }
            }
        }
        OutlinedTextField(displayName, { displayName = it.take(80); saved = false }, label = { Text("表示名") }, singleLine = true, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(title, { title = it.take(80); saved = false }, label = { Text("肩書 (任意)") }, singleLine = true, modifier = Modifier.fillMaxWidth().padding(top = 6.dp))
        if (line != null) {
            OutlinedTextField(
                topic, { topic = it.take(200); saved = false }, label = { Text("研究テーマ (任意)") }, placeholder = { Text("例: 拡散モデルによる音声合成") },
                singleLine = true, modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
            )
            OutlinedTextField(
                reading, { reading = it.take(80); saved = false }, label = { Text("よみ (任意、名簿の並び順に使います)") }, placeholder = { Text("例: かのう とおる") },
                singleLine = true, modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
            )
        }
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 12.dp)) {
            Button(
                enabled = !busy && displayName.isNotBlank() && (nameChanged || titleChanged || lineChanged),
                onClick = {
                    scope.launch {
                        busy = true
                        var ok = true
                        if (nameChanged) ok = controller.updateDisplayName(displayName)
                        if (ok && titleChanged) ok = controller.updateProfile(mapOf("title" to title.trim().ifEmpty { null }))
                        if (ok && lineChanged) ok = controller.updateMyRosterLine(topic.trim().ifEmpty { null }, reading.trim().ifEmpty { null })
                        saved = ok
                        busy = false
                    }
                },
            ) { Text("保存") }
            if (saved) Hint("保存しました", Modifier.padding(start = 12.dp))
        }
        SectionTitle("在席")
        var savingPresence by remember { mutableStateOf(false) }
        SwitchRow("在席を隠す", "ほかの人からは常にオフラインに見えます", checked = me.presenceHidden, enabled = !savingPresence) { on ->
            scope.launch {
                savingPresence = true
                controller.setPresenceHidden(on)
                savingPresence = false
            }
        }
    }
}

/**
 * 「アカウント」: the password (its own screen), two-factor authentication (M12i, its setup and disable dialogs), and the
 * devices signed in (GET /auth/sessions): this one marked, the others signed out with confirmation.
 */
@Composable
private fun AccountScreen(controller: AppController, onOpen: (SettingsPage) -> Unit) {
    val scope = rememberCoroutineScope()
    var totp by remember { mutableStateOf<TotpStatusOut?>(null) }
    var totpDialog by rememberSaveable { mutableStateOf<String?>(null) }
    LaunchedEffect(Unit) { totp = controller.totpStatus() }
    when (totpDialog) {
        "setup" -> TotpSetupDialog(controller, onDismiss = { totpDialog = null }, onEnabled = { totpDialog = null; scope.launch { totp = controller.totpStatus() } })
        "disable" -> TotpDisableDialog(controller, onDismiss = { totpDialog = null }, onDisabled = { totpDialog = null; scope.launch { totp = controller.totpStatus() } })
    }
    var sessions by remember { mutableStateOf<List<SessionOut>?>(null) }
    var sessionsError by remember { mutableStateOf<String?>(null) }
    var reload by remember { mutableIntStateOf(0) }
    LaunchedEffect(reload) {
        sessionsError = null
        controller.sessions()
            .onSuccess { sessions = YouSettings.orderedSessions(it) }
            .onFailure { sessionsError = controller.describe(it) }
    }
    var revoking by remember { mutableStateOf<SessionOut?>(null) }
    val list = sessions
    // Lazy: an account signed in from many places (a test account has hundreds) lists them all.
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(horizontal = 20.dp, vertical = 12.dp)) {
        item(key = "top") {
            Column {
                val me = meOf(controller)
                if (me != null) Hint("ユーザー名: @${me.username}")
                SectionTitle("パスワード")
                ListItem(
                    headlineContent = { Text("パスワードを変更") },
                    trailingContent = { Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null) },
                    colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                    modifier = Modifier.fillMaxWidth().clickable { onOpen(SettingsPage.PASSWORD) },
                )
                SectionTitle("2 要素認証")
                Row(verticalAlignment = Alignment.CenterVertically) {
                    val status = totp
                    Column(Modifier.weight(1f)) {
                        Text(when { status == null -> "確認中…"; status.enabled -> "有効"; else -> "無効" })
                        if (status != null) Hint(
                            if (status.enabled) "ログイン時に認証アプリのコードが必要です · 回復コード残り ${status.recoveryCodesLeft}" else "パスワードだけでログインできます",
                        )
                    }
                    if (status != null) TextButton(onClick = { totpDialog = if (status.enabled) "disable" else "setup" }) { Text(if (status.enabled) "無効にする" else "有効にする") }
                }
                SectionTitle("ログイン中の端末" + (list?.let { " (${it.size})" } ?: ""))
                when {
                    list == null && sessionsError == null -> Hint("読み込み中…")
                    list == null -> Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(sessionsError ?: "", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
                        TextButton(onClick = { reload += 1 }) { Text("再読み込み") }
                    }
                    else -> Hint("ほかの端末をログアウトすると、その端末ではもう一度ログインが必要になります。", Modifier.padding(bottom = 4.dp))
                }
            }
        }
        if (list != null) {
            items(list, key = { it.id }) { session ->
                SessionRow(session, onSignOut = { revoking = session })
                HorizontalDivider()
            }
        }
    }
    revoking?.let { session ->
        AlertDialog(
            onDismissRequest = { revoking = null },
            title = { Text("${YouSettings.deviceLabel(session)} をログアウトしますか？") },
            text = { Text("その端末では、もう一度ログインが必要になります。") },
            confirmButton = {
                TextButton(onClick = {
                    revoking = null
                    scope.launch { if (controller.revokeSession(session.id)) reload += 1 }
                }) { Text("ログアウト", color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { revoking = null }) { Text("キャンセル") } },
        )
    }
}

@Composable
private fun SessionRow(session: SessionOut, onSignOut: () -> Unit) {
    val icon = when (session.device.platform) {
        "ios" -> Icons.Outlined.PhoneIphone
        "android" -> Icons.Outlined.PhoneAndroid
        "web" -> Icons.Outlined.Public
        else -> Icons.Outlined.Computer
    }
    Row(Modifier.fillMaxWidth().heightIn(min = 64.dp).padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
        Column(Modifier.weight(1f).padding(start = 16.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(YouSettings.deviceLabel(session), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                if (session.current) {
                    Surface(color = MaterialTheme.colorScheme.primaryContainer, shape = RoundedCornerShape(6.dp), modifier = Modifier.padding(start = 8.dp)) {
                        Text("この端末", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onPrimaryContainer, modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp))
                    }
                }
            }
            val version = session.device.appVersion?.let { " · v$it" } ?: ""
            Hint("最後に使った時刻: " + YouSettings.lastUsedLabel(session.lastUsedAt) + version)
        }
        if (YouSettings.canSignOut(session)) TextButton(onClick = onSignOut) { Text("ログアウト", color = MaterialTheme.colorScheme.error) }
    }
}

/** 「パスワードの変更」: the current one and the new one twice (this session stays signed in). */
@Composable
private fun PasswordScreen(controller: AppController) {
    var current by remember { mutableStateOf("") }
    var next by remember { mutableStateOf("") }
    var repeat by remember { mutableStateOf("") }
    var message by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    ScreenColumn {
        OutlinedTextField(current, { current = it }, label = { Text("現在のパスワード") }, singleLine = true, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth())
        OutlinedTextField(next, { next = it }, label = { Text("新しいパスワード (8 文字以上)") }, singleLine = true, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth().padding(top = 6.dp))
        OutlinedTextField(repeat, { repeat = it }, label = { Text("新しいパスワード (確認)") }, singleLine = true, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth().padding(top = 6.dp))
        message?.let { Text(it, color = if (it.endsWith("しました")) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 8.dp)) }
        Button(
            enabled = !busy && current.isNotEmpty() && next.length >= 8,
            modifier = Modifier.padding(top = 16.dp),
            onClick = {
                if (next != repeat) { message = "新しいパスワードが一致しません"; return@Button }
                scope.launch {
                    busy = true
                    val error = controller.changePasswordInSession(current, next)
                    busy = false
                    message = error ?: "パスワードを変更しました"
                    if (error == null) { current = ""; next = ""; repeat = "" }
                }
            },
        ) { Text("変更する") }
    }
}

/**
 * 「管理」 (admins): the administration (users, roster, groups, invites, webhooks, channels, emoji) is the web and
 * desktop clients' 管理 dialog; the Android app has none of its own, so this opens the web client in the browser.
 */
@Composable
private fun AdminScreen(controller: AppController) {
    ScreenColumn {
        Text("ユーザー・名簿・グループ・招待・Webhook・チャンネル・絵文字の管理は、Web 版とデスクトップ版の「管理」で行います。")
        controller.serverBase?.let { Hint(it, Modifier.padding(top = 8.dp)) }
        Button(onClick = { controller.openWebClient() }, modifier = Modifier.padding(top = 16.dp)) { Text("ブラウザで開く") }
    }
}

/** 「ログアウト」, confirmed (the list's red row and the ⋮ menus). */
@Composable
fun LogoutConfirmDialog(controller: AppController, onDismiss: () -> Unit) {
    val several = controller.workspaces.size > 1
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (several) "${controller.workspaceName} からログアウトしますか？" else "ログアウトしますか？") },
        text = {
            Text(
                "この端末に保存したメッセージと下書きを消します。サーバ上のデータは消えません。" +
                    if (several) "ほかのワークスペースはログインしたままです。" else "",
            )
        },
        confirmButton = {
            TextButton(onClick = {
                onDismiss()
                // In the controller's scope: the screen goes away with the workspace.
                controller.scope.launch { controller.logout() }
            }) { Text("ログアウト", color = MaterialTheme.colorScheme.error) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("キャンセル") } },
    )
}
