package jp.chikuwachat.android.ui

import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.systemBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Bolt
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.InputChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.view.WindowCompat
import jp.chikuwachat.android.api.MessageWorkflowOut
import jp.chikuwachat.android.api.WorkflowField
import jp.chikuwachat.android.api.WorkflowOut
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.sync.ChannelState
import kotlinx.coroutines.launch
import java.time.LocalDate
import java.time.LocalTime
import jp.chikuwachat.android.R
import jp.chikuwachat.android.L10n
import androidx.compose.ui.res.stringResource

/*
 * Workflows on the phone (M95, WORKFLOWS.md §8): the 「⚡ name」 label above a message a workflow posted, the list of a
 * channel's workflows (the composer's ＋ and channel details), and the full-screen form. Managing them stays on the
 * desktop and the web (§8 5.).
 */

/** The workflow's own emoji (a glyph or `:shortcode:`), else ⚡. */
fun workflowEmoji(workflow: WorkflowOut): String = workflow.emoji?.let { Emoji.replaceShortcodes(it) } ?: Workflows.DEFAULT_EMOJI

/** Above a message a workflow posted: a small 「⚡ name」; a tap opens that workflow's form when I can still use it. */
@Composable
fun WorkflowLabel(workflow: MessageWorkflowOut, onOpen: () -> Unit) {
    Row(
        Modifier.padding(bottom = 2.dp).touchTarget { source ->
            Modifier.clickable(interactionSource = source, indication = null, onClickLabel = L10n.str(R.string.workflow_views_use_this_workflow), onClick = onOpen)
        },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.Filled.Bolt, contentDescription = null, tint = MaterialTheme.colorScheme.tertiary, modifier = Modifier.size(13.dp))
        Text(
            workflow.name, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(start = 2.dp),
        )
    }
}

/**
 * A channel's workflows as rows: emoji, name, description, 「→ #送り先 に投稿」 when it posts elsewhere, and, greyed out
 * and not tappable, why I cannot run it (the desktop's runBlockedText).
 */
@Composable
fun WorkflowRows(controller: AppController, here: String, workflows: List<WorkflowOut>, onRun: (WorkflowOut) -> Unit) {
    workflows.forEachIndexed { index, workflow ->
        if (index > 0) HorizontalDivider()
        val target = controller.workflowTarget(workflow.channelId)
        val blocked = Workflows.runBlockedText(workflow.runBlocked, target) ?: if (!workflow.canRun) stringResource(R.string.common_this_workflow_cant_be_used) else null
        Row(
            Modifier.fillMaxWidth().heightIn(min = TouchTarget.MIN).clickable(enabled = blocked == null) { onRun(workflow) }
                .padding(horizontal = 16.dp, vertical = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(workflowEmoji(workflow), style = MaterialTheme.typography.titleMedium, modifier = Modifier.width(30.dp).alpha(if (blocked == null) 1f else 0.38f))
            Column(Modifier.weight(1f).alpha(if (blocked == null) 1f else 0.6f)) {
                Text(workflow.name, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (workflow.description.isNotBlank()) {
                    Text(workflow.description, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
                if (workflow.channelId != here) Text(stringResource(R.string.workflow_views_posts_to, target), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (blocked != null) Text(blocked, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
            }
        }
    }
}

/** The list for one channel, read when it shows (kept a minute); 「読み込み中…」, a failure, or none in place. */
@Composable
fun ChannelWorkflowList(controller: AppController, channelId: String, onRun: (WorkflowOut) -> Unit) {
    var rows by remember(channelId) { mutableStateOf<List<WorkflowOut>?>(null) }
    var failed by remember(channelId) { mutableStateOf(false) }
    var reload by remember { mutableIntStateOf(0) }
    LaunchedEffect(channelId, reload) {
        controller.channelWorkflows(channelId, fresh = reload > 0)
            .onSuccess { rows = it; failed = false }
            .onFailure {
                // A server before M94 has no list (404): there are none.
                if (it is jp.chikuwachat.android.api.ApiException.Api && it.status == 404) { rows = emptyList(); failed = false } else failed = true
            }
    }
    val list = rows
    when {
        list == null && failed -> Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(horizontal = 16.dp)) {
            Text(stringResource(R.string.common_couldnt_load), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
            TextButton(onClick = { reload += 1 }) { Text(stringResource(R.string.common_reload)) }
        }
        list == null -> Text(stringResource(R.string.common_loading), color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(16.dp))
        list.isEmpty() -> Text(
            stringResource(R.string.workflow_views_this_channel_has_no_workflows_create), style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(16.dp),
        )
        else -> WorkflowRows(controller, channelId, list, onRun)
    }
}

/** Channel details' 「ワークフロー」 (§8 2.): the channel's workflows; a tap opens the form. */
@Composable
fun ChannelWorkflowsSection(controller: AppController, channel: ChannelState) {
    Text(
        stringResource(R.string.common_workflow), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(top = 12.dp, bottom = 4.dp).semantics { heading() },
    )
    Column(Modifier.fillMaxWidth().border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(10.dp))) {
        ChannelWorkflowList(controller, channel.id) { controller.openWorkflow(it, channel.id) }
    }
}

/** Which picker is up in the form: a field's date or time (a datetime asks for the date, then the time). */
private data class Picking(val key: String, val time: Boolean)

/**
 * The form (§8 4., full screen): one control per field (text, multi-line text, date / time / datetime pickers starting
 * from the field's value, a dropdown, people, a switch), the required mark and help under each, the server's per-field
 * reason under its field, and the preview of the message. 投稿 posts with the form's one key ([WorkflowSession]).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WorkflowFormScreen(controller: AppController, session: WorkflowSession, version: Int, onDismiss: () -> Unit) {
    val workflow = session.workflow
    val store = controller.store
    val scope = rememberCoroutineScope()
    val target = controller.workflowTarget(workflow.channelId)
    var picking by remember(session) { mutableStateOf<Picking?>(null) }
    val preview = remember(session.values) { Workflows.renderPreview(workflow.template, workflow.fields, session.values) }
    fun submit() {
        if (session.busy) return
        scope.launch { controller.submitWorkflow(session) }
    }

    Dialog(onDismissRequest = { if (!session.busy) onDismiss() }, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        val view = LocalView.current
        val lightBars = !isSystemInDarkTheme()
        SideEffect {
            (view.parent as? DialogWindowProvider)?.window?.let { window ->
                WindowCompat.getInsetsController(window, view).apply {
                    isAppearanceLightStatusBars = lightBars
                    isAppearanceLightNavigationBars = lightBars
                }
            }
        }
        Surface(Modifier.fillMaxSize()) {
            Column(Modifier.fillMaxSize().systemBarsPadding().imePadding()) {
                Row(Modifier.fillMaxWidth().padding(4.dp), verticalAlignment = Alignment.CenterVertically) {
                    IconButton(enabled = !session.busy, onClick = onDismiss) { Icon(Icons.Default.Close, contentDescription = stringResource(R.string.common_close)) }
                    Text(
                        workflowEmoji(workflow) + " " + workflow.name, style = MaterialTheme.typography.titleLarge, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f).semantics { heading() },
                    )
                    TextButton(enabled = !session.busy && workflow.canRun, onClick = ::submit) { Text(if (session.busy) stringResource(R.string.workflow_views_posting) else stringResource(R.string.workflow_views_post)) }
                }
                HorizontalDivider()
                Column(
                    Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState()).padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(14.dp),
                ) {
                    Text(
                        workflow.description.ifBlank { stringResource(R.string.workflow_views_posts_to_2, target) }, style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    workflow.fields.forEach { field ->
                        WorkflowFieldInput(
                            controller, field, session.values[field.key], session.errors[field.key], version,
                            onChange = { session.set(field.key, it) },
                            onPick = { time -> picking = Picking(field.key, time) },
                        )
                    }
                    Column(
                        Modifier.fillMaxWidth().border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(10.dp)).padding(12.dp)
                            .semantics { contentDescription = L10n.str(R.string.common_preview) },
                    ) {
                        Text(stringResource(R.string.workflow_views_preview_in_posted_as_you, target), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Spacer(Modifier.size(6.dp))
                        if (preview.isEmpty()) {
                            Text(stringResource(R.string.workflow_views_empty), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        } else {
                            MessageBody(
                                preview, store.users, groups = store.groups, internalBase = controller.serverBase,
                                customEmoji = store.customEmoji, emojiImages = store.emojiImages, emojiAnimations = store.emojiAnimations,
                                onNeedEmojiImage = { controller.loadEmojiImage(it) }, version = version,
                            )
                        }
                    }
                    session.problem?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium) }
                }
            }
        }
        picking?.let { pick ->
            val field = workflow.fields.firstOrNull { it.key == pick.key } ?: return@let
            val current = (session.values[pick.key] as? FieldValue.Text)?.text.orEmpty()
            val datePart = if (field.type == "datetime") current.substringBefore('T') else current
            val timePart = if (field.type == "datetime") current.substringAfter('T', "") else current
            if (!pick.time) {
                val day = runCatching { LocalDate.parse(datePart) }.getOrNull() ?: LocalDate.now()
                val state = rememberDatePickerState(initialSelectedDateMillis = Schedule.pickerMillis(day))
                DatePickerDialog(
                    onDismissRequest = { picking = null },
                    confirmButton = {
                        TextButton(enabled = state.selectedDateMillis != null, onClick = {
                            val chosen = state.selectedDateMillis?.let { Schedule.pickerDate(it) }
                            if (chosen != null) {
                                if (field.type == "datetime") {
                                    val time = timePart.ifEmpty { "09:00" }
                                    session.set(field.key, FieldValue.Text("${chosen}T$time"))
                                    picking = Picking(field.key, time = true) // then the time
                                    return@TextButton
                                }
                                session.set(field.key, FieldValue.Text(chosen.toString()))
                            }
                            picking = null
                        }) { Text(if (field.type == "datetime") stringResource(R.string.common_next) else stringResource(R.string.common_done)) }
                    },
                    dismissButton = { TextButton(onClick = { picking = null }) { Text(stringResource(R.string.common_cancel)) } },
                ) { DatePicker(state = state) }
            } else {
                val time = runCatching { LocalTime.parse(timePart) }.getOrNull() ?: LocalTime.of(9, 0)
                TimePickDialog(time.hour, time.minute, title = field.label, onDismiss = { picking = null }) { h, m ->
                    val clock = "%02d:%02d".format(h, m)
                    val date = datePart.takeIf { field.type == "datetime" && it.isNotEmpty() } ?: LocalDate.now().toString()
                    session.set(field.key, FieldValue.Text(if (field.type == "datetime") "${date}T$clock" else clock))
                    picking = null
                }
            }
        }
    }
}

/** 「2026年7月28日 (火)」 / 「13:00」 / both for a datetime; "選んでください" when empty. */
private fun pickedLabel(field: WorkflowField, value: String): String {
    if (value.isEmpty()) return L10n.str(R.string.workflow_views_choose_one)
    return when (field.type) {
        "date" -> Workflows.dateLabel(value).ifEmpty { value }
        "datetime" -> Workflows.formatValue(field, FieldValue.Text(value)).ifEmpty { value }
        else -> value
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun WorkflowFieldInput(
    controller: AppController,
    field: WorkflowField,
    value: FieldValue?,
    error: String?,
    version: Int,
    onChange: (FieldValue) -> Unit,
    onPick: (time: Boolean) -> Unit,
) {
    val text = (value as? FieldValue.Text)?.text.orEmpty()
    val errorText = error?.let { Workflows.VALUE_ERROR_TEXT[it] ?: Workflows.VALUE_ERROR_TEXT["invalid"] }
    @Composable
    fun Label() {
        Text(
            field.label + if (field.required) " *" else "", style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = if (field.required) Modifier.semantics { contentDescription = field.label + L10n.str(R.string.workflow_views_required) } else Modifier,
        )
    }
    @Composable
    fun Under() {
        if (field.help.isNotBlank()) Text(field.help, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (errorText != null) Text(errorText, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
    }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        when (field.type) {
            "text", "textarea" -> {
                val long = field.type == "textarea"
                OutlinedTextField(
                    value = text,
                    onValueChange = { onChange(FieldValue.Text(it.take(if (long) Workflows.MAX_TEXTAREA else Workflows.MAX_TEXT))) },
                    label = { Text(field.label + if (field.required) " *" else "") },
                    singleLine = !long, minLines = if (long) 3 else 1, isError = errorText != null,
                    modifier = Modifier.fillMaxWidth(),
                )
                Under()
            }
            "date", "time", "datetime" -> {
                Label()
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    if (field.type == "datetime") {
                        val date = text.substringBefore('T')
                        val time = text.substringAfter('T', "")
                        OutlinedButton(onClick = { onPick(false) }) { Text(if (date.isEmpty()) stringResource(R.string.common_pick_a_date) else Workflows.dateLabel(date).ifEmpty { date }) }
                        OutlinedButton(onClick = { onPick(true) }) { Text(time.ifEmpty { stringResource(R.string.workflow_views_pick_a_time) }) }
                    } else {
                        OutlinedButton(onClick = { onPick(field.type == "time") }, modifier = Modifier.semantics { contentDescription = field.label + " " + pickedLabel(field, text) }) {
                            Text(pickedLabel(field, text))
                        }
                    }
                    if (text.isNotEmpty() && !field.required) TextButton(onClick = { onChange(FieldValue.Text("")) }) { Text(stringResource(R.string.workflow_views_clear)) }
                }
                Under()
            }
            "select" -> {
                Label()
                var open by remember { mutableStateOf(false) }
                Box {
                    OutlinedButton(onClick = { open = true }, modifier = Modifier.semantics { contentDescription = field.label + " " + text.ifEmpty { L10n.str(R.string.workflow_views_not_selected) } }) {
                        Text(text.ifEmpty { stringResource(R.string.workflow_views_choose_one) })
                        Icon(Icons.Default.ArrowDropDown, contentDescription = null)
                    }
                    DropdownMenu(expanded = open, onDismissRequest = { open = false }, modifier = Modifier.heightIn(max = 360.dp)) {
                        if (!field.required) DropdownMenuItem(text = { Text(stringResource(R.string.workflow_views_none)) }, onClick = { open = false; onChange(FieldValue.Text("")) })
                        field.options.forEach { option ->
                            DropdownMenuItem(text = { Text(option) }, onClick = { open = false; onChange(FieldValue.Text(option)) })
                        }
                    }
                }
                Under()
            }
            "user" -> {
                Label()
                PeoplePicker(controller, field.multiple, (value as? FieldValue.Users)?.ids.orEmpty(), version) { onChange(FieldValue.Users(it)) }
                Under()
            }
            "checkbox" -> {
                val on = (value as? FieldValue.Flag)?.on == true
                Row(
                    Modifier.fillMaxWidth().heightIn(min = TouchTarget.MIN).toggleable(value = on, role = Role.Switch, onValueChange = { onChange(FieldValue.Flag(it)) }),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text(field.label + if (field.required) " *" else "", style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f))
                    Switch(checked = on, onCheckedChange = null)
                }
                Under()
            }
            else -> {
                Label()
                Text(stringResource(R.string.workflow_views_this_field_cant_be_filled_in), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
            }
        }
    }
}

/** People (active, not bots, as on the desktop): the chosen as chips, the rest filtered by name (one or several). */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun PeoplePicker(controller: AppController, multiple: Boolean, chosen: List<String>, version: Int, onChange: (List<String>) -> Unit) {
    val store = controller.store
    var query by rememberSaveable { mutableStateOf("") }
    val people = remember(version) {
        store.users.values.filter { it.role != "bot" && it.deactivatedAt == null }.sortedBy { it.displayName }
    }
    if (chosen.isNotEmpty()) {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            chosen.forEach { id ->
                val name = store.users[id]?.displayName ?: "?"
                InputChip(
                    selected = true, onClick = { onChange(chosen - id) }, label = { Text(name) },
                    avatar = { Avatar(id, name, size = 20.dp) },
                    trailingIcon = { Icon(Icons.Default.Close, contentDescription = stringResource(R.string.common_remove_2, name), modifier = Modifier.size(16.dp)) },
                )
            }
        }
    }
    if (!multiple && chosen.isNotEmpty()) return
    OutlinedTextField(query, { query = it }, singleLine = true, placeholder = { Text(stringResource(R.string.workflow_views_search_by_name)) }, modifier = Modifier.fillMaxWidth())
    val q = query.trim().lowercase()
    if (q.isEmpty()) return
    val shown = people.filter { it.id !in chosen && (it.displayName.lowercase().contains(q) || it.username.lowercase().contains(q)) }.take(30)
    Column(Modifier.fillMaxWidth().border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(8.dp))) {
        if (shown.isEmpty()) Text(stringResource(R.string.common_nothing_found), color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(12.dp))
        shown.forEachIndexed { index, user ->
            if (index > 0) HorizontalDivider()
            Row(
                Modifier.fillMaxWidth().heightIn(min = TouchTarget.MIN).clickable {
                    onChange(if (multiple) chosen + user.id else listOf(user.id))
                    query = ""
                }.padding(horizontal = 8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (multiple) Checkbox(checked = false, onCheckedChange = null) else RadioButton(selected = false, onClick = null)
                Avatar(user.id, user.displayName, size = 24.dp, modifier = Modifier.padding(start = 8.dp))
                Column(Modifier.padding(start = 8.dp).weight(1f).widthIn(min = 0.dp)) {
                    Text(user.displayName, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    Text("@" + user.username, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
                }
            }
        }
    }
}
