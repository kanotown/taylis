package jp.chikuwachat.android.ui

import androidx.compose.ui.draw.clip
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
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
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import java.time.Instant
import jp.chikuwachat.android.R
import jp.chikuwachat.android.api.AttendanceStateOut
import jp.chikuwachat.android.app.AppController
import kotlinx.coroutines.launch

/**
 * M140 (docs/PRESENCE.md §9): 「在室状況」 — my one-tap state buttons (the pressed one is my state; TalkBack says
 * 「選択済み」), a note, my own states when the administrator's rule allows them, and the board grouped by state
 * (avatars, names, notes, 「9:15 から」). A person opens the profile card. On a wide screen the people fill columns.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun AttendancePane(controller: AppController, version: Int) {
    val store = controller.store
    // Opening the page reads the board (the bootstrap's may be old after a long background).
    LaunchedEffect(Unit) { controller.engine?.loadAttendance() }
    val board = remember(version) { store.attendance?.takeIf { AttendanceRules.shown(it, store.me?.role) } }
    if (board == null) {
        Text(stringResource(R.string.attendance_off), modifier = Modifier.padding(16.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
        return
    }
    val meId = store.me?.id
    val scope = rememberCoroutineScope()
    var busy by remember { mutableStateOf(false) }
    fun run(call: suspend () -> Unit) {
        if (busy) return
        busy = true
        scope.launch { try { call() } finally { busy = false } }
    }
    val mine = AttendanceRules.entryOf(board, meId ?: "")
    var note by rememberSaveable { mutableStateOf(mine?.note ?: "") }
    var noteFocused by remember { mutableStateOf(false) }
    // Another device (or an outside system) changed my note: shown unless I am typing.
    LaunchedEffect(mine?.note, noteFocused) { if (!noteFocused) note = mine?.note ?: "" }
    var editing by remember { mutableStateOf<AttendanceStateOut?>(null) }
    var adding by remember { mutableStateOf(false) }
    var deleting by remember { mutableStateOf<AttendanceStateOut?>(null) }
    var profileUserId by remember { mutableStateOf<String?>(null) }
    val now = remember(version) { Instant.now() }
    val users = remember(version) { store.users.values.toList() }
    val groups = remember(board, users) { AttendanceRules.groups(board, users) }
    val count = remember(board, users) { AttendanceRules.inRoomCount(board, users) }
    val choices = AttendanceRules.choices(board, meId)
    val own = AttendanceRules.myOwnStates(board, meId)
    fun saveNote() {
        val current = mine ?: return
        val cleaned = AttendanceRules.cleanNote(note)
        if (cleaned != current.note) run { controller.setMyAttendance(current.stateId, cleaned) }
    }

    BoxWithConstraints(Modifier.fillMaxSize()) {
        val columns = maxOf(1, (maxWidth / 300.dp).toInt())
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 32.dp)) {
            item(key = "count") {
                Text(
                    stringResource(R.string.attendance_in_room, count),
                    modifier = Modifier.padding(start = 16.dp, end = 16.dp, top = 12.dp),
                    style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            item(key = "mine") {
                Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
                    Heading(stringResource(R.string.attendance_mine))
                    FlowRow(
                        Modifier.fillMaxWidth().padding(top = 8.dp).selectableGroup(),
                        horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp),
                    ) {
                        choices.forEach { choice ->
                            StateButton(controller, choice.state, choice.selected, enabled = !busy, version = version) {
                                val stateId = choice.state.id
                                run { controller.setMyAttendance(stateId, AttendanceRules.noteForPress(board, meId, stateId)) }
                            }
                        }
                    }
                    if (mine != null) {
                        Row(Modifier.fillMaxWidth().padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                            OutlinedTextField(
                                note, { note = it.take(100) },
                                modifier = Modifier.weight(1f).onFocusChanged { noteFocused = it.isFocused },
                                singleLine = true,
                                label = { Text(stringResource(R.string.attendance_note)) },
                                placeholder = { Text(stringResource(R.string.attendance_note_placeholder), maxLines = 1, overflow = TextOverflow.Ellipsis) },
                                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                                keyboardActions = KeyboardActions(onDone = { saveNote() }),
                            )
                            TextButton(
                                onClick = { saveNote() },
                                enabled = !busy && AttendanceRules.cleanNote(note) != mine.note,
                                modifier = Modifier.padding(start = 4.dp),
                            ) { Text(stringResource(R.string.common_save)) }
                        }
                    } else {
                        Text(
                            stringResource(R.string.attendance_not_set_yet), modifier = Modifier.padding(top = 8.dp),
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
            if (board.canPersonalize || own.isNotEmpty()) {
                item(key = "own") {
                    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Box(Modifier.weight(1f)) { Heading(stringResource(R.string.attendance_own_states)) }
                            if (board.canPersonalize) {
                                TextButton(onClick = { adding = true }, enabled = !busy && own.size < 10) {
                                    Icon(Icons.Filled.Add, contentDescription = null, modifier = Modifier.size(18.dp))
                                    Text(stringResource(R.string.attendance_add_own), modifier = Modifier.padding(start = 4.dp))
                                }
                            }
                        }
                        if (own.isEmpty()) {
                            Text(stringResource(R.string.attendance_own_none), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        own.forEach { state ->
                            Row(Modifier.fillMaxWidth().heightIn(min = TouchTarget.MIN), verticalAlignment = Alignment.CenterVertically) {
                                StatePill(controller, state, version)
                                Text(
                                    AttendanceRules.kindLabel(state.kind), modifier = Modifier.weight(1f).padding(start = 8.dp),
                                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis,
                                )
                                if (board.canPersonalize) {
                                    IconButton(onClick = { editing = state }, enabled = !busy) {
                                        Icon(Icons.Outlined.Edit, contentDescription = stringResource(R.string.attendance_edit_own, state.label))
                                    }
                                }
                                IconButton(onClick = { deleting = state }, enabled = !busy) {
                                    Icon(Icons.Outlined.Delete, contentDescription = stringResource(R.string.attendance_delete_own, state.label))
                                }
                            }
                        }
                    }
                }
            }
            item(key = "board") {
                Box(Modifier.padding(start = 16.dp, end = 16.dp, top = 12.dp)) { Heading(stringResource(R.string.attendance_board)) }
            }
            groups.forEach { group ->
                val groupKey = group.state?.id ?: "unset"
                item(key = "g:$groupKey") {
                    Row(
                        Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 4.dp).semantics(mergeDescendants = true) { heading() },
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        if (group.state != null) StatePill(controller, group.state, version)
                        else Text(stringResource(R.string.attendance_unset), style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text(
                            pluralStringResource(R.plurals.attendance_people, group.people.size, group.people.size),
                            modifier = Modifier.padding(start = 8.dp), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
                group.people.chunked(columns).forEachIndexed { index, row ->
                    item(key = "p:$groupKey:$index:${row.first().user.id}") {
                        Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp)) {
                            row.forEach { person ->
                                PersonRow(controller, person, meId, now, version, Modifier.weight(1f)) { profileUserId = person.user.id }
                            }
                            repeat(columns - row.size) { Spacer(Modifier.weight(1f)) }
                        }
                    }
                }
            }
        }
    }

    if (adding || editing != null) {
        OwnStateDialog(
            state = editing, busy = busy,
            onDismiss = { adding = false; editing = null },
            onSubmit = { label, emoji, color, kind ->
                val id = editing?.id
                run { if (controller.saveMyAttendanceState(id, label, emoji, color, kind)) { adding = false; editing = null } }
            },
        )
    }
    deleting?.let { state ->
        AlertDialog(
            onDismissRequest = { deleting = null },
            title = { Text(stringResource(R.string.attendance_delete_own, state.label)) },
            text = { Text(stringResource(R.string.attendance_delete_own_body)) },
            confirmButton = {
                TextButton(onClick = { deleting = null; run { controller.deleteMyAttendanceState(state.id) } }) {
                    Text(stringResource(R.string.common_delete), color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = { TextButton(onClick = { deleting = null }) { Text(stringResource(R.string.common_cancel)) } },
        )
    }
    profileUserId?.let { id ->
        ProfileDialog(controller, id, version, onDismiss = { profileUserId = null }, onOpenDm = { profileUserId = null; controller.pendingChannelId = it })
    }
}

@Composable
private fun Heading(text: String) {
    Text(text, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold, modifier = Modifier.semantics { heading() })
}

/** One person on the board: avatar, name (「（自分）」 for me), the note and since when; the row opens the profile card. */
@Composable
private fun PersonRow(
    controller: AppController, person: AttendanceRules.Person, meId: String?, now: Instant, version: Int, modifier: Modifier, onClick: () -> Unit,
) {
    val user = person.user
    Row(
        modifier.heightIn(min = TouchTarget.MIN).clickable(onClickLabel = stringResource(R.string.common_open_profile), onClick = onClick)
            .padding(horizontal = 8.dp, vertical = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Avatar(user.id, user.displayName, size = 36.dp, presence = controller.store.presenceOf(user.id))
        Column(Modifier.weight(1f).padding(start = 10.dp)) {
            Text(
                user.displayName + if (user.id == meId) " " + stringResource(R.string.attendance_me) else "",
                style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            person.entry?.let { entry ->
                val detail = remember(entry, now) { AttendanceRules.detail(entry, now) }
                if (detail.isNotEmpty()) {
                    EmojiLineText(detail, controller, version, MaterialTheme.typography.bodySmall, MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
        }
    }
}

/** The light or dark (background, text) pair of a text emoji colour, as the theme is. */
@Composable
private fun attendanceColors(color: String): Pair<Color, Color> {
    val palette = TextEmojiPill.PALETTE[color] ?: TextEmojiPill.PALETTE.getValue("gray")
    val dark = MaterialTheme.colorScheme.background.luminance() < 0.5f
    val (bg, fg) = if (dark) palette.second else palette.first
    return Color(0xFF000000L or bg) to Color(0xFF000000L or fg)
}

/** A state's emoji and name on its colour (the board's headings, my own states, the chip when [small]). */
@Composable
fun StatePill(controller: AppController, state: AttendanceStateOut, version: Int, modifier: Modifier = Modifier, small: Boolean = false) {
    val (bg, fg) = attendanceColors(state.color)
    Row(
        modifier.background(bg, RoundedCornerShape(if (small) 4.dp else 6.dp))
            .padding(horizontal = if (small) 5.dp else 8.dp, vertical = if (small) 1.dp else 3.dp)
            .clearAndSetSemantics { contentDescription = state.label },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        state.emoji?.let {
            SectionIcon(controller, it, version, size = if (small) 12.dp else 16.dp)
            Spacer(Modifier.size(if (small) 3.dp else 4.dp))
        }
        Text(
            state.label, color = fg, maxLines = 1, overflow = TextOverflow.Ellipsis, fontWeight = FontWeight.Medium,
            style = if (small) MaterialTheme.typography.labelSmall else MaterialTheme.typography.labelLarge,
        )
    }
}

/**
 * A one-tap state button: at least 48 dp high, the pressed one filled in its colour and announced as selected (a radio
 * group: exactly one is mine). My own states say 「（自分用）」 to TalkBack.
 */
@Composable
private fun StateButton(controller: AppController, state: AttendanceStateOut, selected: Boolean, enabled: Boolean, version: Int, onClick: () -> Unit) {
    val (bg, fg) = attendanceColors(state.color)
    val personal = if (state.ownerId != null) " " + stringResource(R.string.attendance_personal) else ""
    val shape = RoundedCornerShape(10.dp)
    // One node: the role, the selected state and the name (the emoji and label inside are drawn only).
    Row(
        Modifier.heightIn(min = TouchTarget.MIN).clip(shape)
            .background(if (selected) bg else MaterialTheme.colorScheme.surface, shape)
            .border(if (selected) 2.dp else 1.dp, if (selected) fg else MaterialTheme.colorScheme.outlineVariant, shape)
            .selectable(selected = selected, enabled = enabled, role = Role.RadioButton, onClick = onClick)
            .semantics { contentDescription = state.label + personal },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Row(Modifier.padding(horizontal = 14.dp).clearAndSetSemantics {}, verticalAlignment = Alignment.CenterVertically) {
            state.emoji?.let {
                SectionIcon(controller, it, version, size = 18.dp)
                Spacer(Modifier.size(6.dp))
            }
            Text(
                state.label, maxLines = 1, overflow = TextOverflow.Ellipsis,
                color = if (selected) fg else MaterialTheme.colorScheme.onSurface,
                fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
                style = MaterialTheme.typography.bodyLarge,
                modifier = Modifier.widthIn(max = 220.dp),
            )
        }
    }
}

/**
 * The small 「在室状況」 chip next to a name (the profile card, a channel's member list): the person's state in its colour.
 * Nothing while the board is off, for a guest, or when the person has no state.
 */
@Composable
fun AttendanceChip(controller: AppController, userId: String, version: Int, modifier: Modifier = Modifier, maxWidth: Dp = 110.dp) {
    val store = controller.store
    val board = remember(version) { store.attendance?.takeIf { AttendanceRules.shown(it, store.me?.role) } } ?: return
    val entry = AttendanceRules.entryOf(board, userId) ?: return
    val state = AttendanceRules.stateOf(board, entry.stateId) ?: return
    StatePill(controller, state, version, modifier.widthIn(max = maxWidth), small = true)
}

/** The profile card's line: the chip, then the note and since when. */
@Composable
fun AttendanceProfileLine(controller: AppController, userId: String, version: Int, modifier: Modifier = Modifier) {
    val store = controller.store
    val board = remember(version) { store.attendance?.takeIf { AttendanceRules.shown(it, store.me?.role) } } ?: return
    val entry = AttendanceRules.entryOf(board, userId) ?: return
    val state = AttendanceRules.stateOf(board, entry.stateId) ?: return
    Row(modifier.semantics(mergeDescendants = true) {}, verticalAlignment = Alignment.CenterVertically) {
        StatePill(controller, state, version, Modifier.widthIn(max = 160.dp), small = true)
        val detail = remember(entry) { AttendanceRules.detail(entry) }
        if (detail.isNotEmpty()) {
            EmojiLineText(detail, controller, version, MaterialTheme.typography.labelSmall, MaterialTheme.colorScheme.onSurfaceVariant, Modifier.padding(start = 6.dp))
        }
    }
}

/** Adding ([state] null) or changing one of my own states: name, emoji, colour, kind. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun OwnStateDialog(state: AttendanceStateOut?, busy: Boolean, onDismiss: () -> Unit, onSubmit: (String, String?, String, String) -> Unit) {
    var label by rememberSaveable { mutableStateOf(state?.label ?: "") }
    var emoji by rememberSaveable { mutableStateOf(state?.emoji ?: "") }
    var color by rememberSaveable { mutableStateOf(state?.color ?: "gray") }
    var kind by rememberSaveable { mutableStateOf(state?.kind ?: "on_site") }
    val cleaned = label.trim().split(Regex("\\s+")).joinToString(" ")
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (state != null) stringResource(R.string.attendance_edit_own, state.label) else stringResource(R.string.attendance_add_own)) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                OutlinedTextField(
                    label, { label = it.take(40) }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                    label = { Text(stringResource(R.string.attendance_form_label)) },
                    placeholder = { Text(stringResource(R.string.attendance_form_label_placeholder)) },
                )
                OutlinedTextField(
                    emoji, { emoji = it.take(32) }, singleLine = true, modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
                    label = { Text(stringResource(R.string.attendance_form_emoji)) }, placeholder = { Text("🗣️") },
                )
                Text(stringResource(R.string.attendance_form_color), style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(top = 12.dp))
                FlowRow(Modifier.fillMaxWidth().selectableGroup()) {
                    SectionLetterIcon.COLORS.forEach { (key, name) ->
                        val (bg, fg) = attendanceColors(key)
                        Box(
                            Modifier.size(TouchTarget.MIN)
                                .selectable(selected = color == key, role = Role.RadioButton) { color = key }
                                .semantics { contentDescription = name },
                            contentAlignment = Alignment.Center,
                        ) {
                            Box(
                                Modifier.size(30.dp).background(bg, CircleShape)
                                    .border(if (color == key) 3.dp else 1.dp, if (color == key) fg else MaterialTheme.colorScheme.outlineVariant, CircleShape),
                            )
                        }
                    }
                }
                Text(stringResource(R.string.attendance_form_kind), style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(top = 12.dp))
                Text(stringResource(R.string.attendance_form_kind_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Column(Modifier.selectableGroup()) {
                    AttendanceRules.KINDS.forEach { value ->
                        Row(
                            Modifier.fillMaxWidth().heightIn(min = TouchTarget.MIN).selectable(selected = kind == value, role = Role.RadioButton) { kind = value },
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            RadioButton(selected = kind == value, onClick = null)
                            Text(AttendanceRules.kindLabel(value), modifier = Modifier.padding(start = 8.dp))
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = { onSubmit(cleaned, emoji.trim().ifEmpty { null }, color, kind) }, enabled = !busy && cleaned.isNotEmpty()) {
                Text(if (state != null) stringResource(R.string.common_save) else stringResource(R.string.common_add))
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.common_cancel)) } },
    )
}
