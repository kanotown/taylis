package jp.chikuwachat.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.outlined.EmojiEmotions
import androidx.compose.material.icons.outlined.MeetingRoom
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.L10n
import jp.chikuwachat.android.R
import jp.chikuwachat.android.api.activeStatus
import jp.chikuwachat.android.app.AppController
import java.time.Instant
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * docs/PRESENCE.md §11 (§11.6, §11.7): my avatar as the button that opens the status menu — the top bar's (phone) and
 * the one at the top of 「自分」. It draws my dot ([PresenceRules.myLook], the hollow ring while I appear offline) and
 * TalkBack says 「自分のステータスを変える（離席中）」.
 */
@Composable
fun MyStatusButton(controller: AppController, version: Int, size: androidx.compose.ui.unit.Dp, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val store = controller.store
    val me = remember(version) { PresenceRules.currentMe(store.me ?: controller.me, store.me?.id?.let { store.users[it] }) } ?: return
    val choice = PresenceRules.myChoice(me)
    val label = stringResource(R.string.presence_open_menu, PresenceRules.myLine(me))
    Box(
        modifier.touchTarget { source ->
            Modifier.semantics { contentDescription = label }.clickable(interactionSource = source, indication = null, role = Role.Button, onClick = onClick)
        },
    ) {
        Avatar(me.id, me.displayName, size = size, presence = PresenceRules.myLook(choice, store.connectionOf(me.id)), showOffline = true)
    }
}

/**
 * The status menu as a bottom sheet (like the 在室状況 quick switch's): on top my picture with the dot, my name and the
 * state now (「取り込み中（〜15:30）」 with 「解除」); my custom status (opens 「ステータスを設定」); the four choices —
 * オンライン（自動）, 離席中, 取り込み中 (its lengths unfold under it), オフライン表示 — a tap sets it and closes; then
 * 「ステータスを設定」, 在室状況 (while the board is on, not for guests: the quick switch's sheet), 「プロフィールを編集」
 * and 設定 (the 自分 tab; left out where the menu is opened from 「自分」 itself).
 *
 * `onOpenSettings`: a 自分 screen ([SettingsPage.STATUS], [SettingsPage.PROFILE]), or null for the 自分 list.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MyStatusSheet(
    controller: AppController,
    version: Int,
    onDismiss: () -> Unit,
    onOpenSettings: (SettingsPage?) -> Unit,
    onOpenAttendance: () -> Unit,
    showSettings: Boolean = true,
) {
    val store = controller.store
    var attendance by rememberSaveable { mutableStateOf(false) }
    if (attendance) {
        AttendanceQuickSheet(controller, version, onDismiss = onDismiss, onOpenBoard = { onDismiss(); onOpenAttendance() })
        return
    }
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    var durations by rememberSaveable { mutableStateOf(false) }
    val me = remember(version) { PresenceRules.currentMe(store.me ?: controller.me, store.me?.id?.let { store.users[it] }) }
    if (me == null) {
        LaunchedEffect(Unit) { onDismiss() }
        return
    }
    fun close(then: () -> Unit = {}) {
        scope.launch { sheet.hide() }.invokeOnCompletion { onDismiss(); then() }
    }
    fun choose(choice: PresenceChoice, duration: DndDuration? = null) {
        controller.chooseMyPresence(choice, duration)
        close()
    }
    val choice = PresenceRules.myChoice(me)
    val title = stringResource(R.string.presence_menu)
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet) {
        // TalkBack names the sheet 「自分のステータス」 when it opens.
        Column(Modifier.fillMaxWidth().navigationBarsPadding().verticalScroll(rememberScrollState()).semantics { paneTitle = title }) {
            // 1. Me: the picture with the dot, the name, the state now; 「解除」 while 取り込み中.
            Row(Modifier.fillMaxWidth().padding(start = 24.dp, end = 16.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                Avatar(me.id, me.displayName, size = 48.dp, presence = PresenceRules.myLook(choice, store.connectionOf(me.id)), showOffline = true)
                Column(Modifier.weight(1f).padding(start = 14.dp).semantics(mergeDescendants = true) { heading() }) {
                    Text(me.displayName, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text(PresenceRules.myLine(me), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                if (choice == PresenceChoice.DND) {
                    val clearLabel = stringResource(R.string.presence_clear_label)
                    // Ends the pause only (Settings' 「再開」, PATCH {dnd_until: null}): 「オンライン（自動）」 would also drop
                    // 離席中 / 「在席を隠す」 set in Settings underneath it (§11.1 reads the columns in order).
                    OutlinedButton(onClick = { controller.clearMyPause(); close() }, modifier = Modifier.padding(start = 8.dp).semantics { contentDescription = clearLabel }) {
                        Text(stringResource(R.string.presence_clear))
                    }
                }
            }
            // 2. My custom status, when I have one.
            val status = activeStatus(store.users[me.id] ?: me.asPublic)
            if (status != null) {
                Surface(
                    onClick = { close { onOpenSettings(SettingsPage.STATUS) } },
                    shape = RoundedCornerShape(12.dp),
                    color = MaterialTheme.colorScheme.surfaceContainerHigh,
                    modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp).heightIn(min = TouchTarget.MIN),
                ) {
                    Row(Modifier.padding(horizontal = 14.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
                        status.first.ifEmpty { null }?.let { SectionIcon(controller, it, version, size = 20.dp) }
                            ?: Icon(Icons.Outlined.EmojiEmotions, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text(status.second, modifier = Modifier.padding(start = 10.dp), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
            HorizontalDivider(Modifier.padding(top = 8.dp))
            // 3. The four choices (TalkBack: a radio group); 取り込み中 unfolds its lengths.
            Column(Modifier.selectableGroup()) {
                ChoiceRow(PresenceChoice.AUTO, choice) { choose(PresenceChoice.AUTO) }
                ChoiceRow(PresenceChoice.AWAY, choice) { choose(PresenceChoice.AWAY) }
                ChoiceRow(PresenceChoice.DND, choice, expanded = durations) { durations = !durations }
                if (durations) {
                    Text(
                        stringResource(R.string.presence_duration_title), style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(start = 64.dp, top = 4.dp, bottom = 2.dp).semantics { heading() },
                    )
                    DndDuration.entries.forEach { duration ->
                        Row(
                            Modifier.fillMaxWidth().heightIn(min = TouchTarget.MIN).clickable(role = Role.Button) { choose(PresenceChoice.DND, duration) }
                                .padding(start = 64.dp, end = 24.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) { Text(duration.label, style = MaterialTheme.typography.bodyLarge) }
                    }
                }
                ChoiceRow(PresenceChoice.INVISIBLE, choice) { choose(PresenceChoice.INVISIBLE) }
            }
            HorizontalDivider(Modifier.padding(vertical = 4.dp))
            // 4. The rest.
            LinkRow(Icons.Outlined.EmojiEmotions, stringResource(R.string.presence_set_status)) { close { onOpenSettings(SettingsPage.STATUS) } }
            val board = store.attendance
            if (AttendanceRules.quickSwitchShown(board, store.me?.role, me.id)) {
                val state = AttendanceRules.myState(board, me.id)
                Row(
                    Modifier.fillMaxWidth().heightIn(min = TouchTarget.MIN).clickable(role = Role.Button) { attendance = true }.padding(horizontal = 24.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    if (state != null) {
                        Box(Modifier.size(24.dp).background(attendanceColors(state.color).first, RoundedCornerShape(6.dp)), contentAlignment = Alignment.Center) {
                            StateGlyph(controller, state.icon, state.emoji, version, size = 14.dp, tint = attendanceTint(state.color, solid = true))
                        }
                    } else {
                        Icon(Icons.Outlined.MeetingRoom, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(24.dp))
                    }
                    Text(
                        state?.let { stringResource(R.string.presence_attendance, it.label) } ?: stringResource(R.string.presence_attendance_none),
                        modifier = Modifier.padding(start = 14.dp), style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            LinkRow(Icons.Outlined.Person, stringResource(R.string.common_edit_profile)) { close { onOpenSettings(SettingsPage.PROFILE) } }
            if (showSettings) LinkRow(Icons.Outlined.Settings, stringResource(R.string.common_settings)) { close { onOpenSettings(null) } }
            Spacer(Modifier.height(8.dp))
        }
    }
}

@Composable
private fun ChoiceRow(value: PresenceChoice, current: PresenceChoice, expanded: Boolean? = null, onClick: () -> Unit) {
    val selected = value == current
    val expandedText = expanded?.let { if (it) L10n.str(R.string.presence_duration_title) else null }
    Row(
        Modifier.fillMaxWidth().heightIn(min = 56.dp)
            .selectable(selected = selected, role = if (expanded == null) Role.RadioButton else Role.Button, onClick = onClick)
            .semantics { if (expandedText != null) stateDescription = expandedText }
            .padding(horizontal = 24.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(24.dp).clearAndSetSemantics {}, contentAlignment = Alignment.Center) { PresenceDot(value.look, Modifier.size(12.dp)) }
        Column(Modifier.weight(1f).padding(start = 16.dp)) {
            Text(value.label, style = MaterialTheme.typography.bodyLarge, fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal)
            Text(value.hint, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
        }
        if (selected) Icon(Icons.Filled.Check, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(start = 8.dp).size(20.dp))
        if (expanded != null) {
            Icon(
                if (expanded) Icons.Filled.KeyboardArrowUp else Icons.Filled.KeyboardArrowDown, contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 4.dp),
            )
        }
    }
}

@Composable
private fun LinkRow(icon: ImageVector, label: String, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().heightIn(min = TouchTarget.MIN).clickable(role = Role.Button, onClick = onClick).padding(horizontal = 24.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(icon, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(24.dp))
        Text(label, modifier = Modifier.padding(start = 14.dp), style = MaterialTheme.typography.bodyLarge)
    }
}

/**
 * §11.3: 取り込み中 ends by the clock, with no event. One wait for the soonest end of anyone's pause (read again on every
 * Store change); then everything that draws a presence reads it again. 「解除するまで」 never ends by itself.
 */
@Composable
fun DndExpiryTimer(controller: AppController, version: Int) {
    val store = controller.store
    val next = remember(version) { store.nextDndEnd() }
    LaunchedEffect(next) {
        while (true) {
            val at = store.nextDndEnd() ?: break
            // A far end waits a day at most, then looks again (the clock may have moved).
            delay((at.toEpochMilli() - Instant.now().toEpochMilli() + 50).coerceIn(0, 24 * 60 * 60 * 1000L))
            store.dndEnded()
        }
    }
}
