package jp.chikuwachat.android.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.automirrored.outlined.Article
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.window.DialogWindowProvider
import androidx.core.view.WindowCompat
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.MemberOut
import jp.chikuwachat.android.api.TaskKind
import jp.chikuwachat.android.api.TaskOut
import jp.chikuwachat.android.api.TaskStatus
import jp.chikuwachat.android.app.AppController
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.builtins.ListSerializer
import java.text.Collator
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId
import java.util.Locale
import java.util.UUID
import jp.chikuwachat.android.R
import jp.chikuwachat.android.L10n
import androidx.compose.ui.res.stringResource

/** The form's fields across a rotation (the form itself stays open: the controller holds it). */
private val TaskDraftSaver = listSaver<TaskDraft, String>(
    save = {
        listOf(
            it.title, it.notes, it.status, it.dueOn, it.assigneeIds.joinToString(","), it.dueTime, CalendarRecurrence.save(it.repeat),
            Codec.plain.encodeToString(ListSerializer(SubtaskDraft.serializer()), it.subtasks),
            it.noticeDays?.joinToString(",") ?: "-",
        )
    },
    restore = {
        val start = runCatching { LocalDate.parse(it[3]) }.getOrElse { CalendarDates.today() }
        TaskDraft(
            it[0], it[1], it[2], it[3], it[4].split(",").filter { id -> id.isNotEmpty() },
            dueTime = it.getOrElse(5) { "" },
            repeat = it.getOrNull(6)?.let { text -> CalendarRecurrence.restore(text, start) } ?: CalendarRecurrence.noRepeat(start),
            subtasks = it.getOrNull(7)?.let { text -> runCatching { Codec.plain.decodeFromString(ListSerializer(SubtaskDraft.serializer()), text) }.getOrNull() } ?: emptyList(),
            noticeDays = it.getOrNull(8)?.takeIf { text -> text != "-" }?.split(",")?.mapNotNull { day -> day.toIntOrNull() },
        )
    },
)

/** M84: which picker is open over the form. */
private enum class TaskPicker { DATE, TIME, UNTIL }

/** 追加先's value for 「自分のタスク」. */
private const val MINE = ""

/**
 * M56 (TASKS.md §6, phone column): a task's full-screen form — 題名, メモ, 状態, 期限 (a date picker, and 「期限をなくす」),
 * 担当者 (the channel's members; not for a personal task), the message it came from (「メッセージを開く」), and 削除 with a
 * confirmation. New tasks too (「タスクにする」, 「自分のタスク」's ＋), with 追加先 (a channel's board or 「自分のタスク」).
 * Someone who may not change the board sees the task read-only. Saving sends only what changed (the device's zone with a
 * new due date).
 *
 * L9 (M64, REVIEWS.md §2): 「レビューを依頼」 opens it in review mode (the message's conversation fixed, 依頼先 first and
 * needed, 期限 named 希望日, the states 依頼中 / 対応中 / 完了); a review task reads the same. From a DM, 「タスクにする」 offers
 * the DM's members: with someone picked the task is shared in the DM. An assignee of a shared task gets big 「対応を始める」 /
 * 「完了にする」 buttons on top (they save the form with that state).
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TaskFormScreen(controller: AppController, form: TaskForm, version: Int, onDismiss: () -> Unit) {
    val hub = controller.tasks
    val changes = taskVersion(hub)
    val store = controller.store
    // The task as it is now (an event may change it while the form is open).
    val task = remember(form, changes) { form.task?.let { hub?.find(it.id) ?: it } }
    val init = form.init
    val initial = remember(form) {
        form.task?.let { TaskRules.draftFromTask(it) }
            ?: TaskRules.withDueOn(
                TaskDraft(title = init?.title ?: "", status = init?.status ?: TaskStatus.TODO, assigneeIds = init?.assigneeIds ?: emptyList()),
                init?.dueOn ?: "",
            ).let { if (init?.kind == TaskKind.DEADLINE) TaskRules.asKind(it, TaskKind.DEADLINE) else it }
    }
    // M86: a new task's 「タスク / 締切」 (a review keeps its kind).
    var newKind by rememberSaveable(form) { mutableStateOf(init?.kind ?: TaskKind.TASK) }
    var draft by rememberSaveable(form, stateSaver = TaskDraftSaver) { mutableStateOf(initial) }
    var board by rememberSaveable(form) { mutableStateOf(init?.channelId ?: MINE) }
    var busy by remember(form) { mutableStateOf(false) }
    var error by rememberSaveable(form) { mutableStateOf<String?>(null) }
    var confirmDelete by rememberSaveable(form) { mutableStateOf(false) }
    var picking by rememberSaveable(form) { mutableStateOf<TaskPicker?>(null) }
    // The idempotency key of this form's create: a retry after a lost answer returns the same task.
    val clientId = rememberSaveable(form) { UUID.randomUUID().toString() }
    // A new task's conversation: the chosen board, or (L9) the DM once someone there is assigned.
    val channelId = if (form.task != null) task?.channelId else init?.targetChannel(board.ifEmpty { null }, draft.assigneeIds) ?: board.ifEmpty { null }
    val kind = task?.kind ?: newKind
    val review = kind == TaskKind.REVIEW
    val deadline = kind == TaskKind.DEADLINE
    // Whose members can be assigned: the task's conversation, or the DM a new one may be shared in.
    val pickFrom = if (task == null && init?.dmChannelId != null && !review) init.dmChannelId else channelId
    val channel = remember(version, channelId) { channelId?.let { store.channel(it) } }
    val editable = task == null || TaskRules.canEditTask(task, channel, controller.isAdmin)
    val boards = remember(form, version) { init?.boardChoices?.filter { TaskRules.canEditBoard(store.channel(it), controller.isAdmin) } ?: emptyList() }
    val available = hub?.available == true
    // M86 (DEADLINES.md §8 4.): 「タスク / 締切」 on a new board task, where I may add to a board (never a guest).
    val canBeDeadline = task == null && init?.canBeDeadline == true && boards.isNotEmpty() && !controller.isGuest
    fun change(next: TaskDraft) {
        draft = next
        error = null
    }
    fun boardName(id: String?): String {
        if (id == null) return L10n.str(R.string.common_my_tasks)
        val held = store.channel(id)
        // A DM has no board (L9): its shared tasks are named after the other people.
        if (held?.channel?.isDm == true || (held == null && task?.channelId == id && task?.channelName == null)) {
            return L10n.str(R.string.task_form_screen_dm_with, held?.let { channelTitle(it, store) } ?: "DM")
        }
        return L10n.str(R.string.task_form_screen_board_of, held?.channel?.name ?: task?.channelName ?: "?")
    }

    fun save() {
        if (hub == null || busy) return
        val problem = TaskRules.draftProblem(draft, review = task == null && review, deadline = deadline)
        if (problem != null) {
            error = problem
            return
        }
        busy = true
        controller.scope.launch {
            try {
                val zone = ZoneId.systemDefault().id
                if (task == null) {
                    // M73 (CANVAS.md §18.3): the server looks for the checklist line in the canvas's saved body, so what is
                    // typed (or ticked) there goes out first.
                    init?.sourceCanvasId?.let { id ->
                        controller.engine?.canvases?.current(id)?.let { saver ->
                            saver.flush()
                            withTimeoutOrNull(5_000) { saver.settled() }
                        }
                    }
                    hub.create(TaskRules.taskCreateBody(draft, channelId, init, clientId, zone, kind = kind))
                    controller.notice = if (review) L10n.str(R.string.common_review_requested) else if (deadline) L10n.str(R.string.task_form_screen_deadline_added) else L10n.str(R.string.task_form_screen_task_created)
                } else {
                    val patch = TaskRules.taskPatch(task, draft, zone)
                    if (!patch.isEmpty) hub.update(task.id, patch)
                }
                onDismiss()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = controller.describe(e)
            } finally {
                busy = false
            }
        }
    }

    /**
     * M84: a saved item's checkbox goes out at once (PATCH /tasks/{id}/subtasks/{sid}), shown first and put back when
     * refused; a new item (or a new task) waits for 保存 with the rest.
     */
    fun tick(item: SubtaskDraft, done: Boolean) {
        fun set(value: Boolean) {
            draft = draft.copy(subtasks = draft.subtasks.map { if (it.key == item.key) it.copy(done = value) else it })
        }
        set(done)
        val existing = task ?: return
        val id = item.id?.takeIf { sid -> existing.subtasks.any { it.id == sid } } ?: return
        if (hub == null) return
        controller.scope.launch {
            try {
                hub.toggleSubtask(existing.id, id, done)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                set(!done)
                error = controller.describe(e)
            }
        }
    }

    fun remove() {
        val existing = task ?: return
        if (hub == null || busy) return
        busy = true
        controller.scope.launch {
            try {
                hub.remove(existing.id)
                onDismiss()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = controller.describe(e)
            } finally {
                busy = false
            }
        }
    }

    val title = when {
        task == null -> if (review) stringResource(R.string.common_request_review) else if (deadline) stringResource(R.string.common_add_deadline) else stringResource(R.string.common_add_task)
        review -> stringResource(R.string.common_review_request)
        editable -> if (deadline) stringResource(R.string.task_form_screen_edit_deadline) else stringResource(R.string.task_form_screen_edit_task)
        else -> if (deadline) stringResource(R.string.common_deadlines) else stringResource(R.string.common_tasks)
    }
    val dueName = if (review) stringResource(R.string.task_form_screen_preferred_date) else if (deadline) stringResource(R.string.task_form_screen_deadline) else stringResource(R.string.common_due)
    val assigneeName = if (review) stringResource(R.string.task_form_screen_reviewer) else stringResource(R.string.task_form_screen_assignee)
    // L9: an assignee's big buttons (the form saved with that state).
    val quick = if (task != null && editable && available) TaskRules.quickStatuses(task, store.me?.id) else emptyList()
    val source = when {
        task != null -> TaskRules.sourceState(task)
        init?.sourceMessageId != null -> TaskSource.Link(init.sourceMessageId, init.sourceExcerpt)
        else -> TaskSource.None
    }
    // M73: the canvas checklist item it came from (TASKS.md §10).
    val canvasSource = when {
        task != null -> TaskRules.canvasSourceState(task)
        init?.sourceCanvasId != null -> CanvasTaskSource.Link(init.sourceCanvasId, init.sourceCanvasExcerpt)
        else -> CanvasTaskSource.None
    }
    Dialog(onDismissRequest = onDismiss, properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
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
                    IconButton(onClick = onDismiss) { Icon(Icons.Default.Close, contentDescription = stringResource(R.string.common_close)) }
                    Text(title, style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f).semantics { heading() })
                    if (editable) {
                        TextButton(enabled = !busy && available, onClick = ::save) { Text(if (busy) stringResource(R.string.common_saving) else if (task == null) (if (review) stringResource(R.string.task_form_screen_request) else stringResource(R.string.common_add)) else stringResource(R.string.common_save)) }
                    }
                }
                HorizontalDivider()
                val formScroll = rememberScrollState()
                // The error line sits near the end of a long form, below the fold when 追加 / 保存 at the top is pressed
                // (a deadline without a date looked like nothing happened): scroll it into view once laid out.
                LaunchedEffect(error) {
                    if (error != null) {
                        withFrameNanos { }
                        formScroll.animateScrollTo(formScroll.maxValue)
                    }
                }
                Column(
                    Modifier.fillMaxWidth().weight(1f).verticalScroll(formScroll).padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    if (quick.isNotEmpty()) {
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.fillMaxWidth()) {
                            quick.forEach { status ->
                                val go = {
                                    change(draft.copy(status = status))
                                    save()
                                }
                                val size = Modifier.weight(1f).heightIn(min = 56.dp)
                                if (status == TaskStatus.DONE) {
                                    Button(enabled = !busy, onClick = go, modifier = size) { Text(TaskRules.quickLabel(status), style = MaterialTheme.typography.titleMedium) }
                                } else {
                                    FilledTonalButton(enabled = !busy, onClick = go, modifier = size) { Text(TaskRules.quickLabel(status), style = MaterialTheme.typography.titleMedium) }
                                }
                            }
                        }
                    }
                    if (task == null && (review || init?.dmChannelId != null)) {
                        // Review: the message's conversation. DM 「タスクにする」: shared there once someone is assigned.
                        Column(Modifier.fillMaxWidth()) {
                            FieldLabel(if (review) stringResource(R.string.task_form_screen_where_to_request) else stringResource(R.string.task_form_screen_add_to))
                            Text(
                                when {
                                    review -> boardName(channelId)
                                    channelId != null -> boardName(channelId) + stringResource(R.string.task_form_screen_shown_to_members)
                                    else -> stringResource(R.string.task_form_screen_my_tasks_also_shown_to_this)
                                },
                                style = MaterialTheme.typography.bodyLarge,
                            )
                        }
                        if (editable && pickFrom != null) {
                            AssigneePicker(controller, pickFrom, version, draft.assigneeIds, label = assigneeName, excludeMe = review, onChange = { change(draft.copy(assigneeIds = it)) })
                        }
                    } else if (task == null) {
                        if (canBeDeadline) {
                            KindSwitch(deadline, onPick = { next ->
                                newKind = next
                                change(TaskRules.asKind(draft, next))
                                // A deadline is a board's: never 「自分のタスク」.
                                if (next == TaskKind.DEADLINE && board == MINE) board = boards.first()
                            })
                        }
                        BoardChoice(
                            value = if (board == MINE) stringResource(R.string.task_form_screen_my_tasks_only_shown_to_me) else boardName(board),
                            options = boards.map { it to boardName(it) } + if (deadline) emptyList() else listOf(MINE to stringResource(R.string.task_form_screen_my_tasks_only_shown_to_me)),
                            enabled = boards.isNotEmpty(),
                            onPick = { picked -> board = picked; change(draft.copy(assigneeIds = emptyList())) },
                        )
                    } else {
                        Text(boardName(task.channelId), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    if (editable) {
                        OutlinedTextField(
                            value = draft.title, onValueChange = { change(draft.copy(title = it.take(TaskRules.MAX_TITLE))) },
                            label = { Text(stringResource(R.string.common_title)) }, placeholder = { Text(stringResource(R.string.task_form_screen_put_the_materials_together)) }, modifier = Modifier.fillMaxWidth(),
                        )
                        OutlinedTextField(
                            value = draft.notes, onValueChange = { change(draft.copy(notes = it.take(TaskRules.MAX_NOTES))) },
                            label = { Text(stringResource(R.string.task_form_screen_notes)) }, placeholder = { Text(stringResource(R.string.task_form_screen_markdown_is_supported)) }, minLines = 3, modifier = Modifier.fillMaxWidth(),
                        )
                        Column {
                            FieldLabel(stringResource(R.string.task_form_screen_status))
                            SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                                TaskStatus.all.forEachIndexed { index, status ->
                                    SegmentedButton(
                                        selected = draft.status == status, onClick = { change(draft.copy(status = status)) },
                                        shape = SegmentedButtonDefaults.itemShape(index, TaskStatus.all.size),
                                    ) { Text(TaskRules.label(kind, status)) }
                                }
                            }
                        }
                        Column {
                            FieldLabel(dueName)
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                OutlinedButton(onClick = { picking = TaskPicker.DATE }, modifier = Modifier.weight(1f)) {
                                    Text(draft.dueOn.takeIf { it.isNotEmpty() }?.let { dueText(it) } ?: if (deadline) stringResource(R.string.common_pick_a_date) else stringResource(R.string.common_none), maxLines = 1)
                                }
                                // M84: the time beside the date (none: the whole day).
                                if (draft.dueOn.isNotEmpty()) {
                                    OutlinedButton(onClick = { picking = TaskPicker.TIME }) {
                                        Text(draft.dueTime.takeIf { it.isNotEmpty() }?.let { clockText(it) } ?: stringResource(R.string.task_form_screen_no_time), maxLines = 1)
                                    }
                                }
                            }
                            if (draft.dueOn.isNotEmpty()) {
                                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                                    if (draft.dueTime.isNotEmpty()) TextButton(onClick = { change(draft.copy(dueTime = "")) }) { Text(stringResource(R.string.task_form_screen_remove_time)) }
                                    // Without a due date nothing repeats: the save sends `rrule: null` with it. M86: a deadline keeps its date.
                                    if (!deadline) TextButton(onClick = { change(TaskRules.withDueOn(draft, "")) }) { Text(stringResource(R.string.task_form_screen_clear_due, dueName)) }
                                }
                            }
                        }
                        // M84: 「繰り返し」, the calendar's picker (M69) from the due date; not for a review request.
                        val dueDate = draft.dueOn.takeIf { it.isNotEmpty() }?.let { runCatching { LocalDate.parse(it) }.getOrNull() }
                        if (dueDate != null && !review && !deadline) {
                            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                RepeatSection(draft.repeat, dueDate, onChange = { change(draft.copy(repeat = it)) }, onPickUntil = { picking = TaskPicker.UNTIL })
                                if (draft.repeat.kind != RepeatKind.NONE) {
                                    Text(stringResource(R.string.task_form_screen_completing_it_creates_the_next_task), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                            }
                        }
                        // M86: 「事前の通知」 — the days the 「締切」 bot posts in the channel.
                        if (deadline) {
                            NoticeDaysPicker(draft.noticeDays ?: DeadlineRules.DEFAULT_NOTICE_DAYS, enabled = !busy, onChange = { change(draft.copy(noticeDays = it)) })
                        }
                        SubtaskEditor(draft.subtasks, enabled = !busy, onChange = { change(draft.copy(subtasks = it)) }, onTick = ::tick)
                        if (channelId != null && !(task == null && (review || init?.dmChannelId != null))) {
                            AssigneePicker(controller, channelId, version, draft.assigneeIds, label = assigneeName, onChange = { change(draft.copy(assigneeIds = it)) })
                        }
                    } else if (task != null) {
                        ReadOnlyTask(controller, task, version)
                    }
                    when (source) {
                        is TaskSource.Link -> Row(
                            Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceContainerHigh, RoundedCornerShape(10.dp)).padding(12.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(Icons.Outlined.ChatBubbleOutline, contentDescription = null, modifier = Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                            Spacer(Modifier.width(10.dp))
                            Column(Modifier.weight(1f)) {
                                Text(stringResource(R.string.common_original_message), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                source.excerpt?.let { Text(it, style = MaterialTheme.typography.bodyMedium, maxLines = 3, overflow = TextOverflow.Ellipsis) }
                            }
                            if (task != null) {
                                TextButton(onClick = {
                                    onDismiss()
                                    controller.scope.launch { controller.openPermalink(source.messageId) }
                                }) { Text(stringResource(R.string.task_form_screen_open_message)) }
                            }
                        }
                        TaskSource.Deleted -> Text(
                            stringResource(R.string.task_form_screen_the_original_message_was_deleted), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceContainerHigh, RoundedCornerShape(10.dp)).padding(12.dp),
                        )
                        TaskSource.None -> Unit
                    }
                    if (canvasSource !is CanvasTaskSource.None) {
                        CanvasSourceBox(controller, canvasSource, version, onOpen = if (task != null) ({ id ->
                            onDismiss()
                            controller.scope.launch { controller.openCanvasLink(id) }
                        }) else null)
                    }
                    if (!available) Text(stringResource(R.string.common_this_server_doesnt_support_tasks), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium) }
                    if (task?.canDelete == true) {
                        TextButton(enabled = !busy, onClick = { confirmDelete = true }) {
                            Icon(Icons.Default.Delete, contentDescription = null, tint = MaterialTheme.colorScheme.error, modifier = Modifier.size(18.dp))
                            Text(if (deadline) stringResource(R.string.task_form_screen_delete_deadline) else stringResource(R.string.task_form_screen_delete_task), color = MaterialTheme.colorScheme.error)
                        }
                    }
                }
            }
        }
        when (picking) {
            TaskPicker.DATE, TaskPicker.UNTIL -> {
                val until = picking == TaskPicker.UNTIL
                val due = draft.dueOn.takeIf { it.isNotEmpty() }?.let { runCatching { LocalDate.parse(it) }.getOrNull() }
                val shown = if (until) draft.repeat.until ?: due?.plusMonths(1) else due
                val state = rememberDatePickerState(initialSelectedDateMillis = Schedule.pickerMillis(shown ?: CalendarDates.today()))
                DatePickerDialog(
                    onDismissRequest = { picking = null },
                    confirmButton = {
                        TextButton(enabled = state.selectedDateMillis != null, onClick = {
                            state.selectedDateMillis?.let { millis ->
                                val day = Schedule.pickerDate(millis)
                                change(if (until) draft.copy(repeat = draft.repeat.copy(until = day)) else TaskRules.withDueOn(draft, day.toString()))
                            }
                            picking = null
                        }) { Text(stringResource(R.string.common_done)) }
                    },
                    dismissButton = { TextButton(onClick = { picking = null }) { Text(stringResource(R.string.common_cancel)) } },
                ) { DatePicker(state = state) }
            }
            TaskPicker.TIME -> {
                // A new time starts at 9:00 (the desktop's empty time field picks the hour).
                val time = draft.dueTime.takeIf { it.isNotEmpty() }?.let { runCatching { LocalTime.parse(it) }.getOrNull() } ?: LocalTime.of(9, 0)
                TimePickDialog(time.hour, time.minute, title = L10n.str(R.string.task_form_screen_due_time, dueName), onDismiss = { picking = null }) { hour, minute ->
                    change(draft.copy(dueTime = LocalTime.of(hour, minute).toString()))
                    picking = null
                }
            }
            null -> Unit
        }
        if (confirmDelete && task != null) {
            AlertDialog(
                onDismissRequest = { confirmDelete = false },
                title = { Text(if (deadline) stringResource(R.string.task_form_screen_delete_this_deadline_advance_notices) else stringResource(R.string.common_delete_this_task)) },
                text = { Text(stringResource(R.string.common_will_be_deleted, task.title) + if (task.channelId != null) stringResource(R.string.common_it_will_disappear_for_all_members) else "") },
                confirmButton = { TextButton(onClick = { confirmDelete = false; remove() }) { Text(stringResource(R.string.common_delete), color = MaterialTheme.colorScheme.error) } },
                dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text(stringResource(R.string.common_cancel)) } },
            )
        }
    }
}

/**
 * M73: 「元のキャンバス: 題名」 and the item's text, 「キャンバスを開く」 (`onOpen`, for a saved task); 「元のキャンバスは
 * 削除されました」 once the canvas was purged.
 */
@Composable
private fun CanvasSourceBox(controller: AppController, source: CanvasTaskSource, version: Int, onOpen: ((String) -> Unit)?) {
    val link = source as? CanvasTaskSource.Link
    val title = remember(version, link?.canvasId) { link?.let { controller.store.canvasMeta(it.canvasId)?.title } }
    val excerpt = when (source) {
        is CanvasTaskSource.Link -> source.excerpt
        is CanvasTaskSource.Deleted -> source.excerpt
        CanvasTaskSource.None -> null
    }
    Row(
        Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceContainerHigh, RoundedCornerShape(10.dp)).padding(12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(Icons.AutoMirrored.Outlined.Article, contentDescription = null, modifier = Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.width(10.dp))
        Column(Modifier.weight(1f)) {
            Text(
                when {
                    link == null -> stringResource(R.string.task_form_screen_the_original_canvas_was_deleted)
                    title != null -> stringResource(R.string.task_form_screen_original_canvas, title)
                    else -> stringResource(R.string.task_form_screen_original_canvas_2)
                },
                style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            excerpt?.let { Text(it, style = MaterialTheme.typography.bodyMedium, maxLines = 3, overflow = TextOverflow.Ellipsis) }
        }
        if (link != null && onOpen != null) {
            TextButton(onClick = { onOpen(link.canvasId) }) { Text(stringResource(R.string.common_open_canvas)) }
        }
    }
}

/** 「10月5日 (月)」, with 「(今日)」 on today. */
private fun dueText(dueOn: String): String {
    val day = runCatching { LocalDate.parse(dueOn) }.getOrNull() ?: return dueOn
    return CalendarDates.dayLabel(day) + if (day == CalendarDates.today()) L10n.str(R.string.task_form_screen_today) else ""
}

/** "14:30" → 「14:30」, "09:00" → 「9:00」 (the calendar's clock). */
private fun clockText(hhmm: String): String = runCatching { CalendarDates.clock(LocalTime.parse(hhmm)) }.getOrDefault(hhmm)

/**
 * M84 (TASKS.md §11.8 4.): 「サブタスク」 — each item's checkbox, its title, ↑ / ↓ and 削除, and 「＋ サブタスクを追加」. The list
 * goes out whole with 保存 (ids kept); `onTick` is a checkbox (a saved item's goes out at once).
 */
@Composable
private fun SubtaskEditor(items: List<SubtaskDraft>, enabled: Boolean, onChange: (List<SubtaskDraft>) -> Unit, onTick: (SubtaskDraft, Boolean) -> Unit) {
    Column(Modifier.fillMaxWidth()) {
        val doneCount = items.count { it.done }
        FieldLabel(stringResource(R.string.task_form_screen_subtasks) + if (items.isNotEmpty()) " ($doneCount/${items.size})" else "")
        items.forEachIndexed { index, item ->
            key(item.key) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Checkbox(
                    checked = item.done, enabled = enabled, onCheckedChange = { onTick(item, it) },
                    modifier = Modifier.semantics { contentDescription = L10n.str(if (item.done) R.string.task_screens_mark_not_done else R.string.task_screens_mark_done, item.title) },
                )
                OutlinedTextField(
                    value = item.title, singleLine = true, enabled = enabled, placeholder = { Text(stringResource(R.string.task_form_screen_subtasks)) },
                    onValueChange = { text -> onChange(items.map { if (it.key == item.key) it.copy(title = text.take(TaskRules.MAX_TITLE)) else it }) },
                    textStyle = MaterialTheme.typography.bodyLarge.copy(textDecoration = if (item.done) TextDecoration.LineThrough else null),
                    modifier = Modifier.weight(1f),
                )
                IconButton(enabled = enabled && index > 0, onClick = { onChange(TaskRules.moveSubtask(items, index, -1)) }) {
                    Icon(Icons.Default.KeyboardArrowUp, contentDescription = stringResource(R.string.common_move_up))
                }
                IconButton(enabled = enabled && index < items.size - 1, onClick = { onChange(TaskRules.moveSubtask(items, index, 1)) }) {
                    Icon(Icons.Default.KeyboardArrowDown, contentDescription = stringResource(R.string.common_move_down))
                }
                IconButton(enabled = enabled, onClick = { onChange(items.filter { it.key != item.key }) }) {
                    Icon(Icons.Default.Close, contentDescription = stringResource(R.string.common_delete))
                }
            }
            }
        }
        TextButton(enabled = enabled && items.size < TaskRules.MAX_SUBTASKS, onClick = { onChange(items + SubtaskDraft(null, "")) }) {
            Icon(Icons.Default.Add, contentDescription = null, modifier = Modifier.size(18.dp))
            Text(stringResource(R.string.task_form_screen_add_subtask))
        }
    }
}

/** M86 (DEADLINES.md §8 4.): 「タスク / 締切」 for a new task on a channel's board. */
@Composable
private fun KindSwitch(deadline: Boolean, onPick: (String) -> Unit) {
    Column(Modifier.fillMaxWidth()) {
        FieldLabel(stringResource(R.string.common_type))
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
            listOf(TaskKind.TASK to stringResource(R.string.common_tasks), TaskKind.DEADLINE to stringResource(R.string.task_form_screen_deadline_2)).forEachIndexed { index, (value, label) ->
                SegmentedButton(
                    selected = deadline == (value == TaskKind.DEADLINE), onClick = { onPick(value) },
                    shape = SegmentedButtonDefaults.itemShape(index, 2),
                ) { Text(label) }
            }
        }
    }
}

/**
 * M86: 「事前の通知」 — a check per day (14 日前・7 日前・3 日前・前日・当日, and any other day the deadline already has); the
 * 「締切」 bot posts in the channel at 9:00 of each.
 */
@Composable
private fun NoticeDaysPicker(days: List<Int>, enabled: Boolean, onChange: (List<Int>) -> Unit) {
    Column(Modifier.fillMaxWidth()) {
        FieldLabel(stringResource(R.string.task_form_screen_advance_notice))
        DeadlineRules.noticeChoices(days).forEach { day ->
            val checked = day in days
            Row(
                Modifier.fillMaxWidth().heightIn(min = TouchTarget.MIN)
                    .clickable(enabled = enabled, role = Role.Checkbox) { onChange(DeadlineRules.toggleNotice(days, day, !checked)) },
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Checkbox(checked = checked, onCheckedChange = null, enabled = enabled, modifier = Modifier.padding(horizontal = 8.dp))
                Text(DeadlineRules.noticeLabel(day), style = MaterialTheme.typography.bodyLarge)
            }
        }
        Text(
            stringResource(R.string.task_form_screen_the_deadlines_bot_posts_in_this), style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

@Composable
private fun FieldLabel(text: String) {
    Text(text, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(bottom = 4.dp))
}

/** 追加先: a channel's board or 「自分のタスク」 (a button that opens its menu). */
@Composable
private fun BoardChoice(value: String, options: List<Pair<String, String>>, enabled: Boolean, onPick: (String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Column(Modifier.fillMaxWidth()) {
        FieldLabel(stringResource(R.string.task_form_screen_add_to))
        Box {
            OutlinedButton(onClick = { open = true }, enabled = enabled, modifier = Modifier.fillMaxWidth()) {
                Text(value, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (enabled) Icon(Icons.Default.ArrowDropDown, contentDescription = null)
            }
            DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                options.forEach { (key, text) -> DropdownMenuItem(text = { Text(text) }, onClick = { open = false; onPick(key) }) }
            }
        }
    }
}

/** 担当者: the channel's members (me first, then by name), each a checkbox; a filter field once there are more than 8. */
@Composable
private fun AssigneePicker(
    controller: AppController, channelId: String, version: Int, selected: List<String>, label: String = L10n.str(R.string.task_form_screen_assignee), excludeMe: Boolean = false,
    onChange: (List<String>) -> Unit,
) {
    var members by remember(channelId) { mutableStateOf<List<MemberOut>?>(null) }
    var failed by remember(channelId) { mutableStateOf(false) }
    LaunchedEffect(channelId) {
        controller.memberList(channelId).onSuccess { members = it }.onFailure { failed = true }
    }
    var query by rememberSaveable(channelId) { mutableStateOf("") }
    val me = controller.store.me?.id
    val rows = remember(members, version) {
        val collator = Collator.getInstance(Locale.JAPANESE)
        (members ?: emptyList()).filter { !excludeMe || it.userId != me }.map { member ->
            val user = controller.store.users[member.userId]
            Triple(member.userId, user?.displayName ?: "?", user?.username ?: "")
        }.sortedWith { a, b ->
            val mine = (b.first == me).compareTo(a.first == me)
            if (mine != 0) mine else collator.compare(a.second, b.second)
        }
    }
    val q = query.trim().lowercase()
    val shown = if (q.isEmpty()) rows else rows.filter { it.second.lowercase().contains(q) || it.third.lowercase().contains(q) }
    Column(Modifier.fillMaxWidth()) {
        FieldLabel(label + if (selected.isNotEmpty()) stringResource(R.string.task_form_screen_people_count, selected.size) else "")
        when {
            failed -> Text(stringResource(R.string.common_couldnt_load_members), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error)
            members == null -> Text(stringResource(R.string.common_loading), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            else -> {
                if (rows.size > 8) {
                    OutlinedTextField(
                        query, { query = it }, placeholder = { Text(stringResource(R.string.common_filter_by_name)) }, singleLine = true,
                        modifier = Modifier.fillMaxWidth().padding(bottom = 4.dp),
                    )
                }
                shown.forEach { (id, name, _) ->
                    val checked = id in selected
                    Row(
                        Modifier.fillMaxWidth().heightIn(min = TouchTarget.MIN)
                            .clickable(role = Role.Checkbox) { onChange(if (checked) selected - id else selected + id) },
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Checkbox(checked = checked, onCheckedChange = null, modifier = Modifier.padding(horizontal = 8.dp))
                        Avatar(id, name, size = 24.dp)
                        Spacer(Modifier.width(8.dp))
                        Text(name + if (id == me) stringResource(R.string.common_you_2) else "", style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }
    }
}

/** What someone who may not change the task sees of it. */
@Composable
private fun ReadOnlyTask(controller: AppController, task: TaskOut, version: Int) {
    val users = remember(version) { controller.store.users }
    val done = task.status == TaskStatus.DONE
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        SelectionContainer {
            Text(
                task.title, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.SemiBold,
                textDecoration = if (done) TextDecoration.LineThrough else null,
            )
        }
        val review = task.kind == TaskKind.REVIEW
        Text(stringResource(R.string.task_form_screen_status_2) + TaskRules.label(task.kind, task.status), style = MaterialTheme.typography.bodyLarge)
        // M84: with its time (this device's clock), the rule and the checklist.
        val dueDay = TaskRules.dueDay(task.dueOn, task.dueAt)
        val time = TaskRules.dueTimeOf(task.dueAt).takeIf { it.isNotEmpty() }?.let { " " + clockText(it) } ?: ""
        val deadline = task.kind == TaskKind.DEADLINE
        Text((if (review) stringResource(R.string.task_form_screen_preferred_date_2) else if (deadline) stringResource(R.string.task_form_screen_deadline_3) else stringResource(R.string.task_form_screen_due)) + (dueDay?.let { dueText(it) + time } ?: stringResource(R.string.common_none)), style = MaterialTheme.typography.bodyLarge)
        // M86: who hears of it beforehand.
        if (deadline) Text(stringResource(R.string.task_form_screen_advance_notice_2) + DeadlineRules.noticeSummary(task.noticeDays), style = MaterialTheme.typography.bodyLarge)
        if (task.rrule != null) {
            val start = dueDay?.let { runCatching { LocalDate.parse(it) }.getOrNull() } ?: CalendarDates.today()
            Text("🔁 " + CalendarRecurrence.describeRrule(task.rrule, start), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (task.subtasks.isNotEmpty()) {
            Column {
                Text(stringResource(R.string.task_form_screen_subtasks_2, task.subtasks.count { it.done }, task.subtasks.size), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                task.subtasks.forEach { item ->
                    Text(
                        (if (item.done) "☑ " else "☐ ") + item.title, style = MaterialTheme.typography.bodyLarge,
                        textDecoration = if (item.done) TextDecoration.LineThrough else null,
                    )
                }
            }
        }
        if (task.channelId != null) {
            Text(
                (if (review) stringResource(R.string.task_form_screen_reviewer_2) else stringResource(R.string.task_form_screen_assignee_2)) + task.assigneeIds.joinToString(stringResource(R.string.common_list_separator)) { users[it]?.displayName ?: "?" }.ifEmpty { stringResource(R.string.common_none) },
                style = MaterialTheme.typography.bodyLarge,
            )
        }
        task.notes?.takeIf { it.isNotBlank() }?.let {
            SelectionContainer {
                Text(
                    it, style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceContainerHigh, RoundedCornerShape(10.dp)).padding(12.dp),
                )
            }
        }
        Text(stringResource(R.string.task_form_screen_members_who_can_post_in_the), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        HorizontalDivider(Modifier.padding(top = 4.dp))
    }
}
