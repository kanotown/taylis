package jp.chikuwachat.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.outlined.MeetingRoom
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.minimumInteractiveComponentSize
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.R
import jp.chikuwachat.android.app.AppController
import kotlinx.coroutines.launch

/**
 * 在室状況 (docs/PRESENCE.md §7.1, §9.1): the quick switch. A small chip with my state (its icon, colour and short name; an
 * outlined 「在室状況」 with a dashed circle while I have none) beside the workspace's name in the home header and at the
 * top of 「自分」. It opens a bottom sheet with all my states as one-tap rows, the note, and 「在室状況を開く」. Only while
 * the board is on and I am not a guest ([AttendanceRules.quickSwitchShown]).
 *
 * [mode] ICON shows only the picture (a narrow header; WorkspaceTitle decides with [AttendanceRules.chipMode]).
 */
@Composable
fun AttendanceQuickSwitch(
    controller: AppController, version: Int, onOpenBoard: () -> Unit, modifier: Modifier = Modifier,
    mode: AttendanceRules.ChipMode = AttendanceRules.ChipMode.FULL,
) {
    val store = controller.store
    val board = store.attendance
    val meId = store.me?.id
    if (!AttendanceRules.quickSwitchShown(board, store.me?.role, meId) || mode == AttendanceRules.ChipMode.HIDDEN) return
    var open by rememberSaveable { mutableStateOf(false) }
    val state = AttendanceRules.myState(board, meId)
    val label = AttendanceRules.chipLabel(state)
    val shape = RoundedCornerShape(50)
    val iconOnly = mode == AttendanceRules.ChipMode.ICON
    // The visible chip is 30 dp high; the touch target is 48 dp (minimumInteractiveComponentSize).
    Box(
        modifier.minimumInteractiveComponentSize()
            .clickable(role = Role.Button, onClickLabel = stringResource(R.string.attendance_pill_menu)) { open = true }
            .semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        val face = Modifier.height(30.dp).clip(shape).clearAndSetSemantics {}
        if (state != null) {
            val (bg, fg) = attendanceColors(state.color)
            Row(face.background(bg, shape).padding(horizontal = if (iconOnly) 7.dp else 10.dp), verticalAlignment = Alignment.CenterVertically) {
                StateGlyph(controller, state.icon, state.emoji, version, size = 16.dp, tint = fg)
                if (!iconOnly) {
                    if (AttendanceIcons.glyph(state) != AttendanceIcons.Glyph.None) Spacer(Modifier.size(5.dp))
                    Text(
                        AttendanceRules.chipText(state.label), color = fg, style = MaterialTheme.typography.labelLarge,
                        fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        } else {
            val outline = MaterialTheme.colorScheme.outline
            Row(
                face.border(1.dp, MaterialTheme.colorScheme.outlineVariant, shape).padding(horizontal = if (iconOnly) 7.dp else 10.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                DashedCircle(outline)
                if (!iconOnly) {
                    Spacer(Modifier.size(5.dp))
                    Text(
                        stringResource(R.string.attendance_pill_none), color = MaterialTheme.colorScheme.onSurfaceVariant,
                        style = MaterialTheme.typography.labelLarge, maxLines = 1,
                    )
                }
            }
        }
    }
    if (open) AttendanceQuickSheet(controller, version, onDismiss = { open = false }, onOpenBoard = { open = false; onOpenBoard() })
}

/** The 「no state yet」 picture: a dashed circle (lucide's CircleDashed on the web). */
@Composable
private fun DashedCircle(color: androidx.compose.ui.graphics.Color) {
    androidx.compose.foundation.Canvas(Modifier.size(16.dp)) {
        val stroke = 1.6.dp.toPx()
        drawCircle(
            color, radius = size.minDimension / 2 - stroke,
            style = Stroke(width = stroke, pathEffect = PathEffect.dashPathEffect(floatArrayOf(3.dp.toPx(), 2.6.dp.toPx()))),
        )
    }
}

/**
 * The sheet: 「在室状況を変える」, my states (the workspace's, then mine) as rows of at least 48 dp — a coloured square
 * with the icon, the name, 「（自分用）」, a check on the current one (TalkBack: a radio group, 「選択済み」). A tap sets the
 * state at once and closes (the note stays only when the same state is tapped again). The note (when I have a state;
 * the keyboard's Done or 「保存」 saves and closes), then 「在室状況を開く」.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun AttendanceQuickSheet(controller: AppController, version: Int, onDismiss: () -> Unit, onOpenBoard: () -> Unit) {
    val store = controller.store
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    val meId = store.me?.id
    val board = remember(version) { store.attendance?.takeIf { AttendanceRules.shown(it, store.me?.role) } }
    if (board == null) {
        // Turned off (or the workspace changed) while open.
        LaunchedEffect(Unit) { onDismiss() }
        return
    }
    val mine = AttendanceRules.entryOf(board, meId ?: "")
    var note by rememberSaveable { mutableStateOf(mine?.note ?: "") }
    fun close(then: () -> Unit = {}) {
        scope.launch { sheet.hide() }.invokeOnCompletion { onDismiss(); then() }
    }
    fun send(press: AttendanceRules.Press?) {
        if (press == null) { close(); return }
        if (busy) return
        busy = true
        scope.launch {
            val ok = try { controller.setMyAttendance(press.stateId, press.note) } finally { busy = false }
            if (ok) close()
        }
    }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet) {
        Column(Modifier.fillMaxWidth().navigationBarsPadding().verticalScroll(rememberScrollState())) {
            Text(
                stringResource(R.string.attendance_pill_menu), style = MaterialTheme.typography.titleMedium,
                modifier = Modifier.padding(start = 24.dp, end = 24.dp, bottom = 8.dp).semantics { heading() },
            )
            Column(Modifier.selectableGroup()) {
                AttendanceRules.choices(board, meId).forEach { choice ->
                    val state = choice.state
                    val (bg, fg) = attendanceColors(state.color)
                    val personal = if (state.ownerId != null) " " + stringResource(R.string.attendance_personal) else ""
                    Row(
                        Modifier.fillMaxWidth().heightIn(min = 52.dp)
                            .selectable(selected = choice.selected, enabled = !busy, role = Role.RadioButton) {
                                send(AttendanceRules.sheetPress(board, meId, state.id))
                            }
                            .semantics { contentDescription = state.label + personal }
                            .padding(horizontal = 24.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Row(Modifier.weight(1f).clearAndSetSemantics {}, verticalAlignment = Alignment.CenterVertically) {
                            Box(Modifier.size(30.dp).background(bg, RoundedCornerShape(8.dp)), contentAlignment = Alignment.Center) {
                                StateGlyph(controller, state.icon, state.emoji, version, size = 18.dp, tint = fg)
                            }
                            Text(
                                state.label, modifier = Modifier.weight(1f).padding(start = 14.dp),
                                style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis,
                                fontWeight = if (choice.selected) FontWeight.SemiBold else FontWeight.Normal,
                            )
                            if (state.ownerId != null) {
                                Text(
                                    stringResource(R.string.attendance_personal), modifier = Modifier.padding(start = 6.dp),
                                    style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            if (choice.selected) {
                                Icon(Icons.Filled.Check, contentDescription = null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(start = 8.dp).size(20.dp))
                            }
                        }
                    }
                }
            }
            if (mine != null) {
                HorizontalDivider(Modifier.padding(top = 4.dp))
                Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                    OutlinedTextField(
                        note, { note = it.take(100) }, modifier = Modifier.weight(1f), singleLine = true,
                        label = { Text(stringResource(R.string.attendance_note)) },
                        placeholder = { Text(stringResource(R.string.attendance_note_placeholder), maxLines = 1, overflow = TextOverflow.Ellipsis) },
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                        keyboardActions = KeyboardActions(onDone = { send(AttendanceRules.sheetNote(board, meId, note)) }),
                    )
                    TextButton(
                        onClick = { send(AttendanceRules.sheetNote(board, meId, note)) },
                        enabled = !busy && AttendanceRules.cleanNote(note) != mine.note,
                        modifier = Modifier.padding(start = 4.dp),
                    ) { Text(stringResource(R.string.common_save)) }
                }
            }
            HorizontalDivider()
            Row(
                Modifier.fillMaxWidth().heightIn(min = TouchTarget.MIN).clickable(role = Role.Button) { close(onOpenBoard) }.padding(horizontal = 24.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(Icons.Outlined.MeetingRoom, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(22.dp))
                Text(stringResource(R.string.attendance_pill_open), modifier = Modifier.padding(start = 14.dp), style = MaterialTheme.typography.bodyLarge)
            }
            Spacer(Modifier.height(8.dp))
        }
    }
}
