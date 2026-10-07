package jp.chikuwachat.android.ui

import android.graphics.Bitmap
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.clickable
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.height
import androidx.compose.ui.draw.clip
import androidx.compose.material.icons.outlined.Add
import androidx.compose.ui.semantics.clearAndSetSemantics
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
import androidx.compose.foundation.text.KeyboardOptions
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
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.automirrored.filled.Logout
import androidx.compose.material.icons.outlined.AdminPanelSettings
import androidx.compose.material.icons.outlined.Bedtime
import androidx.compose.material.icons.outlined.Business
import androidx.compose.material.icons.outlined.Computer
import androidx.compose.material.icons.outlined.EmojiEmotions
import androidx.compose.material.icons.outlined.Flag
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
import androidx.compose.material3.IconButton
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
import androidx.compose.runtime.collectAsState
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
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import java.time.ZoneId
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.NavItem
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
import jp.chikuwachat.android.R
import jp.chikuwachat.android.L10n
import androidx.compose.ui.res.stringResource

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
                        stringResource(R.string.common_choose_an_item_from_the_list),
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
        SettingsPage.APPEARANCE -> AppearanceScreen(controller, version)
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
                Modifier.fillMaxWidth().clickable(onClickLabel = stringResource(R.string.common_edit_profile)) { onOpen(SettingsPage.PROFILE) }.padding(horizontal = 16.dp, vertical = 16.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Avatar(me.id, me.displayName, size = 64.dp)
                Column(Modifier.padding(start = 16.dp).weight(1f)) {
                    Text(me.displayName, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.SemiBold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    Text(YouSettings.handle(me.username, Roster.displayTitle(me.title, controller.store.roster[me.id])), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
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
                    // A custom status emoji is its image (SectionIcon), not its `:name:`.
                    status?.first?.ifEmpty { null }?.let { SectionIcon(controller, it, version, size = 22.dp) }
                        ?: Text("😀", style = MaterialTheme.typography.titleMedium)
                    Column(Modifier.padding(start = 10.dp).weight(1f)) {
                        Text(
                            status?.second?.ifEmpty { null } ?: if (status != null) stringResource(R.string.you_screens_status) else stringResource(R.string.common_update_status),
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
                    Icons.Outlined.NotificationsPaused, stringResource(R.string.common_pause_notifications), YouSettings.pauseSummary(dndUntil), chevron = false,
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
                    title = stringResource(R.string.common_pause_notifications),
                    confirm = stringResource(R.string.you_screens_pause),
                    describe = { L10n.str(R.string.common_notifications_paused_until, Schedule.label(it)) },
                ) { at ->
                    pickingPause = false
                    pause(YouSettings.dndUntil(PauseChoice.CUSTOM, picked = at))
                }
            }
            SettingsRow(
                Icons.Outlined.Bedtime, stringResource(R.string.common_quiet_hours), YouSettings.quietSummary(public?.quietHours),
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
        // M119 (MODERATION.md §3.1): its own row in the main list, for everyone (guests too); the form never leaves the app.
        var reportingProblem by rememberSaveable { mutableStateOf(false) }
        SettingsRow(Icons.Outlined.Flag, stringResource(R.string.report_problem_title), null, onClick = { reportingProblem = true })
        if (reportingProblem) ReportProblemDialog(controller, userId = null, onDismiss = { reportingProblem = false })
        HorizontalDivider(Modifier.padding(vertical = 8.dp))
        // M16c: with several workspaces, say which one this signs out of (the others stay signed in).
        val logoutLabel = if (controller.workspaces.size > 1) stringResource(R.string.common_sign_out_of, controller.workspaceName) else stringResource(R.string.common_sign_out)
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

private val STATUS_PRESETS get() = listOf("📅" to L10n.str(R.string.you_screens_in_a_meeting), "🚌" to L10n.str(R.string.you_screens_commuting), "🤒" to L10n.str(R.string.you_screens_out_sick), "🌴" to L10n.str(R.string.you_screens_on_vacation), "🏠" to L10n.str(R.string.you_screens_working_remotely), "🍱" to L10n.str(R.string.you_screens_lunch_break))
private val EXPIRY_OPTIONS get() = listOf("never" to L10n.str(R.string.you_screens_dont_clear), "30m" to L10n.str(R.string.you_screens_in_30_minutes), "1h" to L10n.str(R.string.common_in_1_hour), "4h" to L10n.str(R.string.you_screens_in_4_hours), "today" to L10n.str(R.string.you_screens_end_of_today), "week" to L10n.str(R.string.you_screens_end_of_this_week))

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
        EmojiPickerSheet(recent = QuickReactions.read(controller.prefs), store = store,
            onNeedImage = { controller.loadEmojiImage(it) }, onNeedPackTab = { controller.loadPackTab(it) }, onDismiss = { pickingEmoji = false }, onPick = { pickingEmoji = false; emoji = it })
    }
    ScreenColumn {
        Row(verticalAlignment = Alignment.CenterVertically) {
            OutlinedButton(onClick = { pickingEmoji = true }, modifier = Modifier.size(56.dp), contentPadding = PaddingValues(0.dp),
                shape = RoundedCornerShape(12.dp)) {
                if (emoji.isEmpty()) Icon(Icons.Outlined.EmojiEmotions, contentDescription = stringResource(R.string.you_screens_choose_emoji))
                else Box(Modifier.semantics(mergeDescendants = true) { contentDescription = L10n.str(R.string.you_screens_change_emoji) }) { SectionIcon(controller, emoji, version, size = 28.dp) }
            }
            if (emoji.isNotEmpty()) TextButton(onClick = { emoji = "" }) { Text(stringResource(R.string.common_remove)) }
            Spacer(Modifier.width(8.dp))
            OutlinedTextField(text, { text = it.take(100) }, modifier = Modifier.weight(1f), label = { Text(stringResource(R.string.you_screens_what_are_you_up_to)) }, singleLine = true)
        }
        FlowRow(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            STATUS_PRESETS.forEach { (e, t) -> FilterChip(selected = text == t && emoji == e, onClick = { emoji = e; text = t }, label = { Text("$e $t") }) }
        }
        SectionTitle(stringResource(R.string.you_screens_clear_after))
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
            ) { Text(stringResource(R.string.common_save)) }
            if (current != null) {
                OutlinedButton(enabled = !busy, onClick = {
                    scope.launch {
                        busy = true
                        val ok = controller.updateProfile(mapOf("status_emoji" to null, "status_text" to null, "status_expires_at" to null))
                        busy = false
                        if (ok) onDone()
                    }
                }) { Text(stringResource(R.string.you_screens_clear)) }
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
        SwitchRow(stringResource(R.string.common_quiet_hours), stringResource(R.string.you_screens_pause_notifications_during_these_hours), checked = on, onChange = { on = it })
        if (on) {
            Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedButton(onClick = { picking = "start" }, modifier = Modifier.weight(1f)) { Text(stringResource(R.string.you_screens_start, start)) }
                OutlinedButton(onClick = { picking = "end" }, modifier = Modifier.weight(1f)) { Text(stringResource(R.string.you_screens_end, end)) }
            }
            SectionTitle(stringResource(R.string.common_days_of_the_week))
            FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                Dnd.DAY_LABELS.forEachIndexed { day, label ->
                    FilterChip(selected = day in days, onClick = { days = if (day in days) days - day else days + day }, label = { Text(label) })
                }
            }
            Hint(stringResource(R.string.common_time_zone, zone), Modifier.padding(top = 8.dp))
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
        ) { Text(stringResource(R.string.common_save)) }
    }
    picking?.let { which ->
        val (h, m) = (if (which == "start") start else end).split(":").map { it.toIntOrNull() ?: 0 }
        TimePickDialog(h, m, title = if (which == "start") stringResource(R.string.common_start_time) else stringResource(R.string.common_end_time), onDismiss = { picking = null }) { hour, minute ->
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
        SectionTitle(stringResource(R.string.you_screens_what_to_notify))
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
            SwitchRow(stringResource(R.string.you_screens_reaction_banners), stringResource(R.string.you_screens_shown_in_activity_even_when_off), checked = me?.notifyReactions ?: false, enabled = !savingReactions) { on ->
                scope.launch {
                    savingReactions = true
                    controller.setNotifyReactions(on)
                    savingReactions = false
                }
            }
        }
        // M56 (TASKS.md §5): only against a server that has tasks (it sends notify_tasks).
        me?.notifyTasks?.let { notifyTasks ->
            var savingTasks by remember { mutableStateOf(false) }
            Spacer(Modifier.padding(top = 8.dp))
            SwitchRow(stringResource(R.string.you_screens_tasks_assignments_and_due_dates), stringResource(R.string.you_screens_notifies_you_when_youre_assigned_and), checked = notifyTasks, enabled = !savingTasks) { on ->
                scope.launch {
                    savingTasks = true
                    controller.setNotifyTasks(on)
                    savingTasks = false
                }
            }
        }
        SectionTitle(stringResource(R.string.you_screens_notification_keywords))
        val savedKeywords = me?.notifyKeywords ?: emptyList()
        var keywords by rememberSaveable { mutableStateOf(savedKeywords.joinToString(", ")) }
        // i18n: keep (keyword separators)
        val parsed = keywords.split(Regex("[,、\\n]")).map { it.trim() }.filter { it.isNotEmpty() }.take(20)
        var busy by remember { mutableStateOf(false) }
        var saved by remember { mutableStateOf(false) }
        OutlinedTextField(keywords, { keywords = it; saved = false }, label = { Text(stringResource(R.string.you_screens_keywords_comma_separated)) }, singleLine = true, modifier = Modifier.fillMaxWidth())
        Hint(stringResource(R.string.you_screens_messages_containing_these_words_notify), Modifier.padding(top = 4.dp))
        Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 4.dp)) {
            TextButton(enabled = !busy && parsed != savedKeywords, onClick = {
                scope.launch {
                    busy = true
                    saved = controller.updateProfileJson(buildJsonObject { put("notify_keywords", buildJsonArray { parsed.forEach { add(JsonPrimitive(it)) } }) })
                    busy = false
                }
            }) { Text(stringResource(R.string.you_screens_save_keywords)) }
            if (saved) Hint(stringResource(R.string.common_saved_2))
        }
        SectionTitle(stringResource(R.string.you_screens_notifications_on_this_device))
        // Read again when the app comes back from the system's page.
        val permitted = remember(controller.appForeground) { controller.notificationsPermitted }
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(if (permitted) stringResource(R.string.you_screens_allowed) else stringResource(R.string.you_screens_not_allowed))
                if (!permitted) Hint(stringResource(R.string.you_screens_you_wont_get_notifications_for_new))
            }
        }
        OutlinedButton(onClick = { controller.openNotificationSettings() }, modifier = Modifier.padding(top = 8.dp)) {
            Text(if (permitted) stringResource(R.string.you_screens_open_device_notification_settings) else stringResource(R.string.you_screens_allow_in_device_settings))
        }
        // PUSH_NOTIFICATIONS.md §15: does a notification reach this phone and my other devices?
        TestNotificationSection(controller, permitted)
    }
}

/**
 * 「表示」: 端末に合わせる / ライト / ダーク and 「連続した投稿をまとめる」 (M47), kept on this device; M50 「リアクションの候補」,
 * on my account.
 */
@Composable
private fun AppearanceScreen(controller: AppController, version: Int) {
    val me = remember(version) { meOf(controller) }
    ScreenColumn {
        // docs/I18N.md: the UI language (null follows the device); each language is named in itself.
        SectionTitle(stringResource(R.string.you_language))
        Column(Modifier.selectableGroup()) {
            listOf(
                null to stringResource(R.string.you_follow_device),
                "ja" to stringResource(R.string.language_ja),
                "en" to stringResource(R.string.language_en),
                "zh-Hans" to stringResource(R.string.language_zh_hans),
            ).forEach { (value, label) ->
                RadioRow(label, selected = controller.language == value) { if (controller.language != value) controller.changeLanguage(value) }
            }
        }
        if (me?.knowsLocale == true) Hint(stringResource(R.string.you_language_hint), Modifier.padding(top = 4.dp))
        SectionTitle(stringResource(R.string.you_screens_theme))
        Column(Modifier.selectableGroup()) {
            Appearance.entries.forEach { value ->
                RadioRow(value.label, selected = controller.appearance == value) { controller.changeAppearance(value) }
            }
        }
        SectionTitle(stringResource(R.string.common_message))
        SwitchRow(
            stringResource(R.string.you_screens_group_consecutive_posts),
            stringResource(R.string.you_screens_off_show_the_avatar_and_name),
            checked = controller.groupPosts,
        ) { controller.changeGroupPosts(it) }
        // Issue #1 (MOBILE_UI.md §5.1): the horizontal swipe between a conversation and the list, for whom it gets in the way.
        SectionTitle(stringResource(R.string.you_screens_gestures))
        SwitchRow(
            stringResource(R.string.you_screens_swipe_back_forward),
            stringResource(R.string.you_screens_swipe_back_forward_detail),
            checked = controller.swipeNavigation,
        ) { controller.changeSwipeNavigation(it) }
        Hint(stringResource(R.string.you_screens_this_setting_is_only_for_this), Modifier.padding(top = 4.dp))
        // Only against a server that sends the field (null or a list): an older one would drop what is saved here.
        if (me != null && me.knowsQuickReactions) QuickReactionsSection(controller, me)
        // M111: likewise only against a server that knows `nav_items`.
        if (me != null && me.knowsNavItems) HomeTilesSection(controller, me)
    }
}

/**
 * M111 「ホームのタイル」: a switch per tile; 「並べ替え」 turns the rows into ↑ / ↓ (an edit mode, as iOS's list), 「元に戻す」
 * back to the defaults. Each change saves the whole list at once (the desktop's and newer clients' items kept).
 */
@Composable
private fun HomeTilesSection(controller: AppController, me: UserMe) {
    val scope = rememberCoroutineScope()
    val stored = me.navItems
    val full = NavItems.full(stored)
    // M140: 「在室状況」 is listed only while the workspace has the board on.
    val implemented = NavItems.implemented(attendance = AttendanceRules.shown(controller.store.attendance, me.role))
    val shown = NavItems.shown(full, implemented = implemented)
    var saving by remember { mutableStateOf(false) }
    var reordering by rememberSaveable { mutableStateOf(false) }
    fun save(value: List<NavItem>?) {
        scope.launch {
            saving = true
            controller.setNavItems(value)  // a refusal shows the app's error and puts the list back
            saving = false
        }
    }
    Row(verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.weight(1f)) { SectionTitle(stringResource(R.string.you_screens_home_tiles)) }
        TextButton(onClick = { reordering = !reordering }) { Text(if (reordering) stringResource(R.string.common_done_2) else stringResource(R.string.you_screens_reorder)) }
    }
    shown.forEachIndexed { index, item ->
        val label = NavItems.label(item.key)
        if (reordering) {
            Row(Modifier.fillMaxWidth().heightIn(min = TouchTarget.MIN), verticalAlignment = Alignment.CenterVertically) {
                Text(label, modifier = Modifier.weight(1f), color = if (item.visible) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant)
                IconButton(enabled = !saving && index > 0, onClick = { save(NavItems.move(full, item.key, -1, implemented)) }) {
                    Icon(Icons.Default.KeyboardArrowUp, contentDescription = stringResource(R.string.you_screens_move_up, label))
                }
                IconButton(enabled = !saving && index < shown.lastIndex, onClick = { save(NavItems.move(full, item.key, 1, implemented)) }) {
                    Icon(Icons.Default.KeyboardArrowDown, contentDescription = stringResource(R.string.you_screens_move_down, label))
                }
            }
        } else {
            SwitchRow(label, null, checked = item.visible, enabled = !saving) { save(NavItems.setVisible(full, item.key, it)) }
        }
    }
    Hint(stringResource(R.string.you_screens_the_tiles_at_the_top_of), Modifier.padding(top = 6.dp))
    TextButton(enabled = !saving && stored != null, onClick = { save(null) }) { Text(stringResource(R.string.you_screens_reset)) }
}

/**
 * M50 (tester request, 2026-10-01): the long-press sheet's six reactions. A slot opens the picker (standard emoji only,
 * as the server takes); the pick replaces the slot, or swaps with the slot that has it already. Each change saves at once.
 * Not chosen yet, the slots show today's row (recent first, then the defaults), and the first change keeps it.
 */
@Composable
private fun QuickReactionsSection(controller: AppController, me: UserMe) {
    val scope = rememberCoroutineScope()
    val chosen = me.quickReactions
    val slots = chosen ?: QuickReactions.pick(QuickReactions.read(controller.prefs))
    var saving by remember { mutableStateOf(false) }
    var picking by rememberSaveable { mutableStateOf<Int?>(null) }
    fun save(value: List<String>?) {
        scope.launch {
            saving = true
            controller.setQuickReactions(value)  // a failure shows the app's error, the slots stay as they were
            saving = false
        }
    }
    SectionTitle(stringResource(R.string.you_screens_reaction_choices))
    Row(Modifier.fillMaxWidth().widthIn(max = 376.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        repeat(QuickReactions.COUNT) { index ->
            val glyph = slots.getOrNull(index)
            val shape = RoundedCornerShape(12.dp)
            Box(
                Modifier.weight(1f).height(52.dp).clip(shape)
                    .background(MaterialTheme.colorScheme.surfaceVariant)
                    .border(1.dp, MaterialTheme.colorScheme.outlineVariant, shape)
                    .clickable(enabled = !saving, role = Role.Button, onClickLabel = stringResource(R.string.common_change)) { picking = index }
                    .semantics { contentDescription = L10n.str(R.string.you_screens_reaction_choice, index + 1, glyph ?: L10n.str(R.string.you_screens_empty_slot)) },
                contentAlignment = Alignment.Center,
            ) {
                if (glyph != null) Text(glyph, fontSize = 24.sp, modifier = Modifier.clearAndSetSemantics {})
                else Icon(Icons.Outlined.Add, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
    Hint(stringResource(R.string.you_screens_the_emoji_in_the_long_press), Modifier.padding(top = 6.dp))
    if (chosen == null) Hint(stringResource(R.string.you_screens_showing_your_recently_used_emoji_for), Modifier.padding(top = 2.dp))
    TextButton(enabled = !saving && chosen != null, onClick = { save(null) }) { Text(stringResource(R.string.you_screens_reset)) }
    picking?.let { index ->
        EmojiPickerSheet(
            recent = QuickReactions.read(controller.prefs), store = controller.store, plainOnly = true,
            onDismiss = { picking = null },
            onPick = { glyph ->
                picking = null
                val next = QuickReactions.replace(slots, index, glyph)
                if (next != chosen) save(next)
            },
        )
    }
}

/**
 * M96: my username with its own 「ユーザー名を変更」 (one request with its own refusals: taken, reserved, 3 times in 24
 * hours). Typed lowercase and checked as typed ([UsernameRules]); the server's refusal stays under the field.
 */
@Composable
private fun UsernameEditor(controller: AppController, current: String, hasPassword: Boolean, limited: Boolean) {
    val scope = rememberCoroutineScope()
    var value by rememberSaveable(current) { mutableStateOf(current) }
    var serverError by remember { mutableStateOf<String?>(null) }
    var saved by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val name = UsernameRules.normalize(value)
    val changed = name != current
    val problem = if (changed) UsernameRules.problem(value) else null
    val message = problem ?: serverError
    OutlinedTextField(
        value,
        { value = it.lowercase().take(32); serverError = null; saved = null },
        label = { Text(stringResource(R.string.common_username_3_32_characters_a_z)) },
        prefix = { Text("@") },
        singleLine = true,
        isError = message != null,
        supportingText = message?.let { { Text(it) } },
        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, keyboardType = KeyboardType.Ascii),
        modifier = Modifier.fillMaxWidth(),
    )
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 4.dp)) {
        OutlinedButton(
            enabled = !busy && changed && problem == null,
            onClick = {
                scope.launch {
                    busy = true
                    val error = controller.renameMe(name)
                    busy = false
                    serverError = error
                    if (error == null) saved = name
                }
            },
        ) { Text(stringResource(R.string.you_screens_change_username)) }
        saved?.takeIf { it == current }?.let {
            Hint(stringResource(R.string.you_screens_changed_to, it) + if (hasPassword) stringResource(R.string.you_screens_sign_in_with_this_name_from) else "", Modifier.padding(start = 12.dp))
        }
    }
    Hint(UsernameRules.hint(hasPassword) + if (limited) " " + UsernameRules.LIMIT_NOTE else "", Modifier.padding(top = 4.dp))
}

/**
 * 「プロフィールを編集」: the picture (M14a / M16g), the username (M96, its own button), display name, title, and on the
 * lab roster (M23) my research topic and reading; 「在席を隠す」 (L4, M31) applies at once.
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
                    Text(if (loadingPhoto) stringResource(R.string.you_screens_loading_photo) else stringResource(R.string.common_choose_photos))
                }
                if (me.avatarUpdatedAt != null) {
                    TextButton(onClick = { scope.launch { controller.deleteAvatar() } }) { Text(stringResource(R.string.you_screens_remove_photo), color = MaterialTheme.colorScheme.error) }
                }
            }
        }
        UsernameEditor(controller, current = controller.store.users[me.id]?.username ?: me.username, hasPassword = me.hasPassword != false, limited = me.role != "admin")
        OutlinedTextField(displayName, { displayName = it.take(80); saved = false }, label = { Text(stringResource(R.string.common_display_name)) }, singleLine = true, modifier = Modifier.fillMaxWidth().padding(top = 12.dp))
        OutlinedTextField(title, { title = it.take(80); saved = false }, label = { Text(stringResource(R.string.you_screens_title_optional)) }, placeholder = { Text(stringResource(R.string.you_screens_e_g_lab_head_ta_year)) }, singleLine = true, modifier = Modifier.fillMaxWidth().padding(top = 6.dp))
        if (line != null) {
            OutlinedTextField(
                topic, { topic = it.take(200); saved = false }, label = { Text(stringResource(R.string.you_screens_research_topic_optional)) }, placeholder = { Text(stringResource(R.string.you_screens_e_g_speech_synthesis_with_diffusion)) },
                singleLine = true, modifier = Modifier.fillMaxWidth().padding(top = 6.dp),
            )
            OutlinedTextField(
                reading, { reading = it.take(80); saved = false }, label = { Text(stringResource(R.string.you_screens_reading_optional_used_to_sort_the)) }, placeholder = { Text(stringResource(R.string.you_screens_e_g)) },
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
            ) { Text(stringResource(R.string.common_save)) }
            if (saved) Hint(stringResource(R.string.common_saved_2), Modifier.padding(start = 12.dp))
        }
        SectionTitle(stringResource(R.string.you_screens_presence))
        var savingPresence by remember { mutableStateOf(false) }
        SwitchRow(stringResource(R.string.you_screens_hide_presence), stringResource(R.string.you_screens_others_always_see_you_as_offline), checked = me.presenceHidden, enabled = !savingPresence) { on ->
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
 * devices signed in (GET /auth/sessions): this one marked, the others signed out with confirmation. An account without a
 * password (Google sign-in only, M48 docs/SSO.md §4) has neither the password nor two-factor rows.
 */
@Composable
private fun AccountScreen(controller: AppController, onOpen: (SettingsPage) -> Unit) {
    val scope = rememberCoroutineScope()
    val hasPassword = meOf(controller)?.hasPassword != false
    var totp by remember { mutableStateOf<TotpStatusOut?>(null) }
    var totpDialog by rememberSaveable { mutableStateOf<String?>(null) }
    LaunchedEffect(hasPassword) { if (hasPassword) totp = controller.totpStatus() }
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
    var deletingAccount by remember { mutableStateOf(false) }
    val storeVersion by controller.store.version.collectAsState()
    val list = sessions
    // Lazy: an account signed in from many places (a test account has hundreds) lists them all.
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(horizontal = 20.dp, vertical = 12.dp)) {
        item(key = "top") {
            Column {
                val me = meOf(controller)
                if (me != null) Hint(stringResource(R.string.you_screens_username, me.username))
                if (hasPassword) {
                    SectionTitle(stringResource(R.string.common_password))
                    ListItem(
                        headlineContent = { Text(stringResource(R.string.you_screens_change_password)) },
                        trailingContent = { Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null) },
                        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                        modifier = Modifier.fillMaxWidth().clickable { onOpen(SettingsPage.PASSWORD) },
                    )
                    SectionTitle(stringResource(R.string.you_screens_two_factor_authentication))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        val status = totp
                        Column(Modifier.weight(1f)) {
                            Text(when { status == null -> stringResource(R.string.you_screens_checking); status.enabled -> stringResource(R.string.you_screens_on); else -> stringResource(R.string.you_screens_off) })
                            if (status != null) Hint(
                                if (status.enabled) stringResource(R.string.you_screens_sign_in_asks_for_a_code, status.recoveryCodesLeft) else stringResource(R.string.you_screens_you_can_sign_in_with_just),
                            )
                        }
                        if (status != null) TextButton(onClick = { totpDialog = if (status.enabled) "disable" else "setup" }) { Text(if (status.enabled) stringResource(R.string.common_turn_off) else stringResource(R.string.you_screens_turn_on)) }
                    }
                } else {
                    Hint(stringResource(R.string.you_screens_this_account_signs_in_with_google), Modifier.padding(top = 4.dp))
                }
                SectionTitle(stringResource(R.string.you_screens_signed_in_devices) + (list?.let { " (${it.size})" } ?: ""))
                when {
                    list == null && sessionsError == null -> Hint(stringResource(R.string.common_loading))
                    list == null -> Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(sessionsError ?: "", color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
                        TextButton(onClick = { reload += 1 }) { Text(stringResource(R.string.common_reload)) }
                    }
                    else -> Hint(stringResource(R.string.you_screens_signing_out_another_device_means_it), Modifier.padding(bottom = 4.dp))
                }
            }
        }
        if (list != null) {
            items(list, key = { it.id }) { session ->
                SessionRow(session, onSignOut = { revoking = session })
                HorizontalDivider()
            }
        }
        // M104 (MODERATION.md §2, §4): the people I blocked, and deleting my account (App Store 5.1.1(v), Google Play).
        item(key = "moderation") {
            Column {
                if (controller.store.blockedUsers.isNotEmpty()) {
                    SectionTitle(stringResource(R.string.you_screens_blocked_users))
                    BlockedUsersList(controller, storeVersion)
                }
                SectionTitle(stringResource(R.string.common_delete_account))
                Hint(stringResource(R.string.you_screens_signs_you_out_of_all_devices))
                DeleteAccountRow(onClick = { deletingAccount = true })
            }
        }
    }
    if (deletingAccount) DeleteAccountDialog(controller, onDismiss = { deletingAccount = false })
    revoking?.let { session ->
        AlertDialog(
            onDismissRequest = { revoking = null },
            title = { Text(stringResource(R.string.you_screens_sign_out, YouSettings.deviceLabel(session))) },
            text = { Text(stringResource(R.string.you_screens_that_device_will_have_to_sign)) },
            confirmButton = {
                TextButton(onClick = {
                    revoking = null
                    scope.launch { if (controller.revokeSession(session.id)) reload += 1 }
                }) { Text(stringResource(R.string.common_sign_out), color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { revoking = null }) { Text(stringResource(R.string.common_cancel)) } },
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
                        Text(stringResource(R.string.you_screens_this_device), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onPrimaryContainer, modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp))
                    }
                }
            }
            val version = session.device.appVersion?.let { " · v$it" } ?: ""
            Hint(stringResource(R.string.you_screens_last_used) + YouSettings.lastUsedLabel(session.lastUsedAt) + version)
        }
        if (YouSettings.canSignOut(session)) TextButton(onClick = onSignOut) { Text(stringResource(R.string.common_sign_out), color = MaterialTheme.colorScheme.error) }
    }
}

/** 「パスワードの変更」: the current one and the new one twice (this session stays signed in). */
@Composable
private fun PasswordScreen(controller: AppController) {
    var current by remember { mutableStateOf("") }
    var next by remember { mutableStateOf("") }
    var repeat by remember { mutableStateOf("") }
    var message by remember { mutableStateOf<String?>(null) }
    var changed by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    ScreenColumn {
        OutlinedTextField(current, { current = it }, label = { Text(stringResource(R.string.common_current_password)) }, singleLine = true, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth())
        OutlinedTextField(next, { next = it }, label = { Text(stringResource(R.string.you_screens_new_password_at_least_8_characters)) }, singleLine = true, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth().padding(top = 6.dp))
        OutlinedTextField(repeat, { repeat = it }, label = { Text(stringResource(R.string.you_screens_new_password_confirm)) }, singleLine = true, visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth().padding(top = 6.dp))
        message?.let { Text(it, color = if (changed) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 8.dp)) }
        Button(
            enabled = !busy && current.isNotEmpty() && next.length >= 8,
            modifier = Modifier.padding(top = 16.dp),
            onClick = {
                if (next != repeat) { message = L10n.str(R.string.you_screens_the_new_passwords_dont_match); changed = false; return@Button }
                scope.launch {
                    busy = true
                    val error = controller.changePasswordInSession(current, next)
                    busy = false
                    message = error ?: L10n.str(R.string.you_screens_password_changed)
                    changed = error == null
                    if (error == null) { current = ""; next = ""; repeat = "" }
                }
            },
        ) { Text(stringResource(R.string.common_change_2)) }
    }
}

/**
 * 「管理」 (admins): the administration (users, roster, groups, invites, webhooks, channels, emoji) is the web and
 * desktop clients' 管理 dialog; the Android app has none of its own, so this opens the web client in the browser.
 */
@Composable
private fun AdminScreen(controller: AppController) {
    ScreenColumn {
        Text(stringResource(R.string.you_screens_users_roster_groups_invites_webhooks))
        controller.serverBase?.let { Hint(it, Modifier.padding(top = 8.dp)) }
        Button(onClick = { controller.openWebClient() }, modifier = Modifier.padding(top = 16.dp)) { Text(stringResource(R.string.you_screens_open_in_browser)) }
    }
}

/** 「ログアウト」, confirmed (the list's red row and the ⋮ menus). */
@Composable
fun LogoutConfirmDialog(controller: AppController, onDismiss: () -> Unit) {
    val several = controller.workspaces.size > 1
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (several) stringResource(R.string.you_screens_sign_out_of, controller.workspaceName) else stringResource(R.string.you_screens_sign_out_2)) },
        text = {
            Text(
                stringResource(R.string.you_screens_messages_and_drafts_saved_on_this) +
                    if (several) stringResource(R.string.you_screens_your_other_workspaces_stay_signed_in) else "",
            )
        },
        confirmButton = {
            TextButton(onClick = {
                onDismiss()
                // In the controller's scope: the screen goes away with the workspace.
                controller.scope.launch { controller.logout() }
            }) { Text(stringResource(R.string.common_sign_out), color = MaterialTheme.colorScheme.error) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.common_cancel)) } },
    )
}
