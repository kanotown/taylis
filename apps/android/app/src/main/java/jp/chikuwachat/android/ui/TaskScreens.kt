package jp.chikuwachat.android.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.automirrored.outlined.Article
import androidx.compose.material.icons.outlined.Alarm
import androidx.compose.material.icons.outlined.AlarmAdd
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import jp.chikuwachat.android.api.TaskColumnOut
import jp.chikuwachat.android.api.TaskCreate
import jp.chikuwachat.android.api.TaskKind
import jp.chikuwachat.android.api.TaskNeighbors
import jp.chikuwachat.android.api.TaskOut
import jp.chikuwachat.android.api.TaskStatus
import jp.chikuwachat.android.api.TaskUpdate
import jp.chikuwachat.android.app.AppController
import jp.chikuwachat.android.sync.ChannelState
import jp.chikuwachat.android.sync.TaskHub
import jp.chikuwachat.android.sync.TaskListState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import java.time.ZoneId
import java.util.UUID
import jp.chikuwachat.android.R
import jp.chikuwachat.android.L10n
import androidx.compose.ui.res.stringResource

/** M56: the task form to show: a task (null = a new one from `init`). */
data class TaskForm(val task: TaskOut?, val init: TaskCreateInit?)

/** The tasks' changes as Compose state (0 without a hub): the screens read their windows again on each. */
@Composable
fun taskVersion(hub: TaskHub?): Int {
    val flow = remember(hub) { hub?.version ?: MutableStateFlow(0) }
    return flow.collectAsState().value
}

private fun listNote(state: TaskListState?, available: Boolean): String? = when {
    !available || state == TaskListState.UNSUPPORTED -> L10n.str(R.string.common_this_server_doesnt_support_tasks)
    state == TaskListState.FAILED -> L10n.str(R.string.common_couldnt_load_tasks_they_will_reload)
    else -> null
}

/**
 * M56 (TASKS.md §6, phone column): a channel's 「タスク」 tab. The columns as a switch on top (「未着手 3」 「進行中 1」
 * 「完了」), that column's cards under it in the server's order, and 「＋ 追加」 after the last card. A card's ⋮ (or a long
 * press) moves it to another column, one place up or down, or deletes it. A board I may not change says why.
 *
 * M84 (TASKS.md §11.8 2.): one switch per column of the board (GET /tasks/columns, left to right; a server before M81 has
 * the three built-in ones), cards by `column_id` (null or unknown: their status's built-in column). For those who may post,
 * a long press on a column (or ⋯ 「列を編集」) renames it, moves it left / right, deletes an added one, or adds a column.
 */
@Composable
fun ChannelTasksPane(controller: AppController, channel: ChannelState, version: Int) {
    val hub = controller.tasks
    val changes = taskVersion(hub)
    val today = rememberToday().toString()
    LaunchedEffect(hub, channel.id) { hub?.openBoard(channel.id) }
    DisposableEffect(hub, channel.id) { onDispose { hub?.closeBoard(channel.id) } }
    val board = remember(changes, hub, channel.id) { hub?.board(channel.id) }
    val tasks = board?.tasks ?: emptyList()
    val columns = board?.columns ?: TaskRules.FALLBACK_COLUMNS
    // The column shown: its id, and its status for when the id is gone (the fallback ids before the columns are read).
    var selectedId by rememberSaveable(channel.id) { mutableStateOf(TaskStatus.TODO) }
    var selectedStatus by rememberSaveable(channel.id) { mutableStateOf(TaskStatus.TODO) }
    val column = TaskRules.pickColumn(columns, selectedId, selectedStatus) ?: TaskRules.FALLBACK_COLUMNS.first()
    val current = remember(version, channel.id) { controller.store.channel(channel.id) ?: channel }
    val canEdit = hub?.available == true && TaskRules.canEditBoard(current, controller.isAdmin)
    val canEditColumns = canEdit && board?.columnsSupported == true
    // M86 (DEADLINES.md §8 5.): 「締切を追加」 on the board (not for a guest).
    val canAddDeadline = canEdit && !controller.isGuest
    val cards = remember(tasks, column, columns) { TaskRules.sortBoardColumn(tasks, column, columns) }
    var confirmDelete by remember { mutableStateOf<TaskOut?>(null) }
    var columnDialog by remember { mutableStateOf<ColumnDialog?>(null) }
    var deleteColumn by remember { mutableStateOf<TaskColumnOut?>(null) }
    var boardMenu by remember { mutableStateOf(false) }
    val note = listNote(board?.state, hub?.available == true)
        ?: TaskRules.boardNote(unsupported = false, failed = false, channel = current, canEdit = canEdit || hub?.available != true)

    fun select(target: TaskColumnOut) {
        selectedId = target.id
        selectedStatus = target.status
    }

    fun move(task: TaskOut, target: TaskColumnOut, neighbors: TaskNeighbors) {
        val tasksHub = hub ?: return
        controller.scope.launch {
            try {
                tasksHub.move(task.id, target.status, neighbors, target)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                controller.report(e)
            }
        }
    }

    fun columnChange(change: suspend (TaskHub) -> Unit) {
        val tasksHub = hub ?: return
        controller.scope.launch {
            try {
                change(tasksHub)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                controller.report(e)
            }
        }
    }

    val columnMenu: @Composable (TaskColumnOut, () -> Unit) -> Unit = { target, dismiss ->
        ColumnMenuItems(
            target, columns, dismiss,
            onRename = { columnDialog = ColumnDialog(target) },
            onMove = { place -> columnChange { it.moveColumn(channel.id, target.id, place) } },
            onDelete = { deleteColumn = target },
            onAdd = { columnDialog = ColumnDialog(null) },
        )
    }

    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(start = 12.dp, end = 4.dp, top = 8.dp, bottom = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Row(
                Modifier.weight(1f).horizontalScroll(rememberScrollState()).selectableGroup(),
                horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically,
            ) {
                columns.forEach { item ->
                    val count = tasks.count { TaskRules.columnOfTask(it, columns)?.id == item.id }
                    ColumnSwitch(
                        TaskRules.columnLabel(item, count), selected = item.id == column.id, onClick = { select(item) },
                        menu = if (canEditColumns) ({ dismiss -> columnMenu(item, dismiss) }) else null,
                    )
                }
            }
            if (canAddDeadline) {
                IconButton(onClick = { controller.taskForm = TaskForm(null, DeadlineRules.createInit(channel.id, emptyList())) }) {
                    Icon(Icons.Outlined.AlarmAdd, contentDescription = stringResource(R.string.common_add_deadline))
                }
            }
            if (canEditColumns) {
                Box {
                    IconButton(onClick = { boardMenu = true }) { Icon(Icons.Default.MoreVert, contentDescription = stringResource(R.string.task_screens_edit_columns)) }
                    DropdownMenu(expanded = boardMenu, onDismissRequest = { boardMenu = false }) { columnMenu(column) { boardMenu = false } }
                }
            }
        }
        note?.let { NoteStrip(it) }
        HorizontalDivider()
        LazyColumn(Modifier.fillMaxWidth().weight(1f), contentPadding = PaddingValues(start = 12.dp, end = 12.dp, top = 8.dp, bottom = 88.dp)) {
            if (cards.isEmpty()) {
                item(key = "empty") {
                    val loading = hub?.available == true && (board == null || board.state == TaskListState.LOADING)
                    Text(
                        if (loading) stringResource(R.string.common_loading) else stringResource(R.string.task_screens_no_tasks_in, column.name),
                        style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(vertical = 16.dp, horizontal = 4.dp),
                    )
                }
            }
            items(cards, key = { it.id }) { task ->
                TaskCard(
                    controller, task, today, version, onOpen = { controller.taskForm = TaskForm(task, null) },
                    modifier = Modifier.padding(bottom = 6.dp),
                    menu = if (canEdit || task.canDelete) { dismiss ->
                        if (canEdit) {
                            columns.filter { it.id != column.id }.forEach { target ->
                                DropdownMenuItem(
                                    text = { Text(stringResource(R.string.task_screens_move_to, target.name)) },
                                    onClick = { dismiss(); move(task, target, TaskNeighbors.NONE) },
                                )
                            }
                            val up = TaskRules.moveWithin(cards, task.id, -1)
                            val down = TaskRules.moveWithin(cards, task.id, 1)
                            DropdownMenuItem(text = { Text(stringResource(R.string.common_move_up)) }, enabled = up != null, onClick = { dismiss(); up?.let { move(task, column, it) } })
                            DropdownMenuItem(text = { Text(stringResource(R.string.common_move_down)) }, enabled = down != null, onClick = { dismiss(); down?.let { move(task, column, it) } })
                        }
                        if (task.canDelete) {
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.common_delete), color = MaterialTheme.colorScheme.error) },
                                onClick = { dismiss(); confirmDelete = task },
                            )
                        }
                    } else null,
                )
            }
            // Every completed column reads the same 「all」 (TASKS.md §11.7).
            val doneCount = tasks.count { it.status == TaskStatus.DONE }
            if (column.status == TaskStatus.DONE && board != null && !board.allDone && doneCount >= TaskRules.BOARD_DONE_LIMIT) {
                item(key = "all-done") {
                    TextButton(onClick = { controller.scope.launch { hub?.openBoard(channel.id, allDone = true) } }) { Text(stringResource(R.string.task_screens_show_all_done)) }
                }
            }
            if (canEdit && hub != null) {
                item(key = "add:${column.id}") {
                    InlineAdd(controller) { title ->
                        val created = hub.create(
                            TaskCreate(channelId = channel.id, title = title, status = column.status, clientTaskId = UUID.randomUUID().toString(), tz = ZoneId.systemDefault().id),
                        )
                        // An added column: made in its status's built-in column, then moved in (TASKS.md §11.7).
                        if (TaskRules.columnIdFor(column) != null) hub.move(created.id, column.status, TaskNeighbors.NONE, column)
                    }
                }
            }
        }
    }
    confirmDelete?.let { task -> DeleteTaskDialog(controller, task, onDismiss = { confirmDelete = null }) }
    columnDialog?.let { dialog ->
        ColumnNameDialog(
            controller, dialog.column, atLimit = columns.size >= TaskRules.MAX_COLUMNS, onDismiss = { columnDialog = null },
            onSave = { name, status ->
                val tasksHub = hub ?: return@ColumnNameDialog
                val editing = dialog.column
                if (editing == null) select(tasksHub.addColumn(channel.id, name, status)) else tasksHub.renameColumn(channel.id, editing.id, name)
            },
        )
    }
    deleteColumn?.let { target ->
        AlertDialog(
            onDismissRequest = { deleteColumn = null },
            title = { Text(stringResource(R.string.task_screens_delete_column, target.name)) },
            text = { Text(TaskRules.deleteColumnText(target, columns)) },
            confirmButton = {
                TextButton(onClick = {
                    deleteColumn = null
                    if (column.id == target.id) TaskRules.builtinFor(columns, target.status)?.let { select(it) }
                    columnChange { it.removeColumn(channel.id, target.id) }
                }) { Text(stringResource(R.string.common_delete), color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton(onClick = { deleteColumn = null }) { Text(stringResource(R.string.common_cancel)) } },
        )
    }
}

/** M84: the column dialog — `column` null: 「列を追加」, else 「名前を変更」 of it. */
private data class ColumnDialog(val column: TaskColumnOut?)

/** M84: a column on the board's switch (a tap shows it; a long press, when given, opens its menu). */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ColumnSwitch(label: String, selected: Boolean, onClick: () -> Unit, menu: (@Composable (dismiss: () -> Unit) -> Unit)?) {
    var open by remember { mutableStateOf(false) }
    Box {
        Surface(
            shape = RoundedCornerShape(8.dp),
            color = if (selected) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.surface,
            border = BorderStroke(1.dp, if (selected) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.outline),
            modifier = Modifier
                .heightIn(min = TouchTarget.MIN)
                .combinedClickable(
                    role = Role.Tab, onClick = onClick,
                    onLongClickLabel = if (menu != null) stringResource(R.string.task_screens_column_actions) else null, onLongClick = if (menu != null) ({ open = true }) else null,
                )
                .semantics { this.selected = selected },
        ) {
            Box(Modifier.heightIn(min = TouchTarget.MIN).padding(horizontal = 14.dp), contentAlignment = Alignment.Center) {
                Text(
                    label, style = MaterialTheme.typography.labelLarge, maxLines = 1,
                    color = if (selected) MaterialTheme.colorScheme.onSecondaryContainer else MaterialTheme.colorScheme.onSurface,
                )
            }
        }
        if (menu != null) DropdownMenu(expanded = open, onDismissRequest = { open = false }) { menu { open = false } }
    }
}

/** M84: a column's operations — 名前を変更, 左へ / 右へ, 削除 (added columns only), and 列を追加. */
@Composable
private fun ColumnMenuItems(
    column: TaskColumnOut, columns: List<TaskColumnOut>, dismiss: () -> Unit, onRename: () -> Unit, onMove: (ColumnPlace) -> Unit,
    onDelete: () -> Unit, onAdd: () -> Unit,
) {
    val left = TaskRules.columnMoveTarget(columns, column.id, -1)
    val right = TaskRules.columnMoveTarget(columns, column.id, 1)
    DropdownMenuItem(text = { Text(stringResource(R.string.task_screens_rename, column.name)) }, onClick = { dismiss(); onRename() })
    DropdownMenuItem(text = { Text(stringResource(R.string.task_screens_left)) }, enabled = left != null, onClick = { dismiss(); left?.let(onMove) })
    DropdownMenuItem(text = { Text(stringResource(R.string.task_screens_right)) }, enabled = right != null, onClick = { dismiss(); right?.let(onMove) })
    if (!column.builtin) {
        DropdownMenuItem(text = { Text(stringResource(R.string.common_delete_column), color = MaterialTheme.colorScheme.error) }, onClick = { dismiss(); onDelete() })
    }
    HorizontalDivider()
    DropdownMenuItem(
        text = { Text(if (columns.size >= TaskRules.MAX_COLUMNS) stringResource(R.string.task_screens_add_column_up_to, TaskRules.MAX_COLUMNS) else stringResource(R.string.task_screens_add_column)) },
        enabled = columns.size < TaskRules.MAX_COLUMNS, onClick = { dismiss(); onAdd() },
    )
}

/**
 * M84: 「列を追加」 (名前 and 種類: 未着手 / 進行中 / 完了) or 「名前を変更」 (`column`; its kind cannot change, TASKS.md §11.7).
 * `onSave` throws when the server refuses (the reason shows; the dialog stays).
 */
@Composable
private fun ColumnNameDialog(
    controller: AppController, column: TaskColumnOut?, atLimit: Boolean, onDismiss: () -> Unit, onSave: suspend (name: String, status: String) -> Unit,
) {
    var name by rememberSaveable { mutableStateOf(column?.name ?: "") }
    var status by rememberSaveable { mutableStateOf(column?.status ?: TaskStatus.DOING) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    fun save() {
        val problem = TaskRules.columnNameProblem(name) ?: if (column == null && atLimit) L10n.str(R.string.task_screens_up_to_columns, TaskRules.MAX_COLUMNS) else null
        if (problem != null) {
            error = problem
            return
        }
        busy = true
        scope.launch {
            try {
                onSave(TaskRules.cleanTitle(name), status)
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
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(if (column == null) stringResource(R.string.task_screens_add_column) else stringResource(R.string.task_screens_rename_column)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = name, onValueChange = { name = it.take(TaskRules.MAX_COLUMN_NAME); error = null }, label = { Text(stringResource(R.string.common_name)) },
                    placeholder = { Text(stringResource(R.string.task_screens_awaiting_review)) }, singleLine = true, modifier = Modifier.fillMaxWidth(),
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done), keyboardActions = KeyboardActions(onDone = { save() }),
                )
                if (column == null) {
                    Text(stringResource(R.string.common_type), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Column(Modifier.selectableGroup()) {
                        TaskStatus.all.forEach { kind ->
                            Row(
                                Modifier.fillMaxWidth().heightIn(min = TouchTarget.MIN).selectable(selected = status == kind, role = Role.RadioButton) { status = kind },
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                RadioButton(selected = status == kind, onClick = null)
                                Text(" " + (TaskRules.COLUMN_KIND_LABELS[kind] ?: kind), style = MaterialTheme.typography.bodyLarge)
                            }
                        }
                    }
                } else {
                    Text(stringResource(R.string.task_screens_type_cant_be_changed, TaskRules.label(column.status)), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium) }
            }
        },
        confirmButton = { TextButton(enabled = !busy, onClick = ::save) { Text(if (column == null) stringResource(R.string.common_add) else stringResource(R.string.common_save)) } },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.common_cancel)) } },
    )
}

/** 「このタスクを削除しますか？」, then the delete (the hub drops it everywhere). */
@Composable
fun DeleteTaskDialog(controller: AppController, task: TaskOut, onDismiss: () -> Unit, onDeleted: () -> Unit = {}) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(L10n.str(R.string.common_delete_this_task)) },
        text = { Text(L10n.str(R.string.common_will_be_deleted, task.title) + if (task.channelId != null) L10n.str(R.string.common_it_will_disappear_for_all_members) else "") },
        confirmButton = {
            TextButton(onClick = {
                onDismiss()
                val hub = controller.tasks ?: return@TextButton
                controller.scope.launch {
                    try {
                        hub.remove(task.id)
                        onDeleted()
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        controller.report(e)
                    }
                }
            }) { Text(L10n.str(R.string.common_delete), color = MaterialTheme.colorScheme.error) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(L10n.str(R.string.common_cancel)) } },
    )
}

/**
 * 「＋ 追加」: a field that adds a task on 追加 / the keyboard's done, and stays open for the next one (TASKS.md §8: as the
 * web). `add` throws when the server refuses (the error shows; the text stays).
 */
@Composable
fun InlineAdd(controller: AppController, add: suspend (String) -> Unit) {
    var open by rememberSaveable { mutableStateOf(false) }
    var text by rememberSaveable { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    if (!open) {
        TextButton(onClick = { open = true }) {
            Icon(Icons.Default.Add, contentDescription = null, modifier = Modifier.size(18.dp))
            Text(stringResource(R.string.task_screens_add))
        }
        return
    }
    fun submit() {
        val title = TaskRules.cleanTitle(text)
        if (title.isEmpty() || busy) return
        busy = true
        scope.launch {
            try {
                add(title.take(TaskRules.MAX_TITLE))
                text = ""
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                controller.report(e)
            } finally {
                busy = false
            }
        }
    }
    // Opened with the keyboard up, as the web's autofocus.
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        OutlinedTextField(
            value = text, onValueChange = { text = it.take(TaskRules.MAX_TITLE) }, placeholder = { Text(stringResource(R.string.task_screens_task_title)) }, singleLine = true,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done), keyboardActions = KeyboardActions(onDone = { submit() }),
            modifier = Modifier.weight(1f).focusRequester(focus),
        )
        TextButton(enabled = !busy && text.isNotBlank(), onClick = ::submit) { Text(stringResource(R.string.common_add)) }
        IconButton(onClick = { open = false; text = "" }) { Icon(Icons.Default.Close, contentDescription = stringResource(R.string.common_close)) }
    }
}

/**
 * A card (TASKS.md §6): the title (struck through when done), the due date (「今日」, M/D; red when past and not done), the
 * notes' and the source message's marks, and the assignees' avatars (3, then 「+N」). A tap opens the task; `menu` (its
 * items) shows under ⋮ and on a long press. `leading`: 「自分のタスク」's checkbox.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun TaskCard(
    controller: AppController, task: TaskOut, today: String, version: Int, onOpen: () -> Unit, modifier: Modifier = Modifier,
    leading: (@Composable () -> Unit)? = null, showBoard: Boolean = false, menu: (@Composable (dismiss: () -> Unit) -> Unit)? = null,
    /** L9: the state in its kind's words (「自分が依頼した」: 依頼中 / 対応中 / 完了). */
    badge: String? = null,
) {
    val store = controller.store
    var menuOpen by remember { mutableStateOf(false) }
    val done = task.status == TaskStatus.DONE
    val overdue = TaskRules.isOverdue(task, today)
    val progress = TaskRules.subtaskProgress(task)
    // M86 (DEADLINES.md §8 5.): a deadline carries ⏰.
    val deadline = task.kind == TaskKind.DEADLINE
    val names = remember(version, task.assigneeIds) { task.assigneeIds.map { store.users[it]?.displayName ?: "?" } }
    val summary = buildString {
        if (deadline) append(stringResource(R.string.task_screens_deadline))
        append(task.title)
        if (done) append(stringResource(R.string.task_screens_done))
        badge?.let { append(stringResource(R.string.common_fmt_6)).append(it) }
        if (task.dueOn != null) {
            append(stringResource(R.string.common_fmt_6)).append(TaskRules.cardDueText(task, today))
            if (overdue) append(stringResource(R.string.task_screens_overdue))
        }
        if (task.rrule != null) append(stringResource(R.string.task_screens_repeats))
        progress?.let { append(stringResource(R.string.task_screens_subtasks_done, it.first, it.second)) }
        if (names.isNotEmpty()) append(stringResource(R.string.task_screens_assigned_to)).append(names.joinToString(stringResource(R.string.common_fmt_6)))
        if (!task.notes.isNullOrBlank()) append(stringResource(R.string.task_screens_has_notes))
        if (task.source?.messageId != null) append(stringResource(R.string.task_screens_has_original_message))
        if (task.canvasSource?.canvasId != null) append(stringResource(R.string.task_screens_has_original_canvas))
    }
    Surface(
        shape = RoundedCornerShape(10.dp), color = MaterialTheme.colorScheme.surfaceContainerLow,
        modifier = modifier.fillMaxWidth().border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(10.dp)),
    ) {
        Row(
            Modifier.fillMaxWidth().heightIn(min = TouchTarget.MIN)
                .combinedClickable(onClickLabel = stringResource(R.string.common_open), onLongClickLabel = if (menu != null) stringResource(R.string.task_screens_task_actions) else null, onLongClick = if (menu != null) ({ menuOpen = true }) else null, onClick = onOpen)
                .padding(start = if (leading != null) 0.dp else 12.dp, top = 8.dp, bottom = 8.dp, end = if (menu != null) 0.dp else 12.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            leading?.invoke()
            Column(Modifier.weight(1f).semantics(mergeDescendants = true) { contentDescription = summary }) {
                if (showBoard) {
                    Text(
                        TaskRules.placeLabel(task) { id -> store.channel(id)?.let { channelTitle(it, store) } }, style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1,
                    )
                }
                Text(
                    task.title, style = MaterialTheme.typography.bodyLarge, maxLines = 3, overflow = TextOverflow.Ellipsis,
                    textDecoration = if (done) TextDecoration.LineThrough else null,
                    color = if (done) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
                )
                val canvasId = task.canvasSource?.canvasId
                val marks = deadline || badge != null || task.dueOn != null || !task.notes.isNullOrBlank() || task.source?.messageId != null || canvasId != null ||
                    names.isNotEmpty() || progress != null || task.rrule != null
                if (marks) {
                    Row(Modifier.padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        if (deadline) {
                            Icon(Icons.Outlined.Alarm, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(15.dp))
                        }
                        badge?.let {
                            Text(
                                it, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold,
                                color = if (done) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.primary,
                            )
                        }
                        if (task.dueOn != null) {
                            val color = if (overdue) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant
                            Text(
                                TaskRules.cardDueText(task, today), style = MaterialTheme.typography.labelMedium, color = color,
                                fontWeight = if (overdue || TaskRules.dueDay(task.dueOn, task.dueAt) == today) FontWeight.SemiBold else FontWeight.Normal,
                            )
                        }
                        // M84: the repeat mark and the checklist's progress (green once every item is done).
                        if (task.rrule != null) Text("🔁", style = MaterialTheme.typography.labelMedium)
                        progress?.let { (doneItems, total) ->
                            Text(
                                TaskRules.progressText(doneItems to total), style = MaterialTheme.typography.labelMedium,
                                color = if (doneItems == total) ProgressDone else MaterialTheme.colorScheme.onSurfaceVariant,
                                fontWeight = if (doneItems == total) FontWeight.SemiBold else FontWeight.Normal,
                            )
                        }
                        if (!task.notes.isNullOrBlank()) {
                            Icon(Icons.Outlined.Description, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(15.dp))
                        }
                        if (task.source?.messageId != null) {
                            Icon(Icons.Outlined.ChatBubbleOutline, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.size(15.dp))
                        }
                        // M73: made from a canvas's checklist item — a tap opens that canvas (the desktop's card button).
                        if (canvasId != null) {
                            Icon(
                                Icons.AutoMirrored.Outlined.Article, contentDescription = stringResource(R.string.task_screens_open_original_canvas), tint = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier
                                    .clickable(role = Role.Button, onClickLabel = stringResource(R.string.task_screens_open_original_canvas)) { controller.scope.launch { controller.openCanvasLink(canvasId) } }
                                    .padding(4.dp)
                                    .size(15.dp),
                            )
                        }
                        Spacer(Modifier.weight(1f))
                        if (task.assigneeIds.isNotEmpty()) AssigneeAvatars(task.assigneeIds, names)
                    }
                }
            }
            if (menu != null) {
                Box {
                    IconButton(onClick = { menuOpen = true }) { Icon(Icons.Default.MoreVert, contentDescription = stringResource(R.string.task_screens_task_actions)) }
                    DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) { menu { menuOpen = false } }
                }
            }
        }
    }
}

/** M84: a checklist with every item done (「☑ 5/5」). */
private val ProgressDone = Color(0xFF16A34A)

/** Up to [TaskRules.CARD_AVATARS] faces, overlapping, then 「+N」. */
@Composable
private fun AssigneeAvatars(ids: List<String>, names: List<String>) {
    Row(horizontalArrangement = Arrangement.spacedBy((-6).dp), verticalAlignment = Alignment.CenterVertically) {
        ids.take(TaskRules.CARD_AVATARS).forEachIndexed { index, id ->
            Box(Modifier.background(MaterialTheme.colorScheme.surface, RoundedCornerShape(50)).padding(1.dp)) {
                Avatar(id, names.getOrElse(index) { "?" }, size = 20.dp)
            }
        }
        if (ids.size > TaskRules.CARD_AVATARS) {
            Text(
                "+${ids.size - TaskRules.CARD_AVATARS}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(start = 8.dp),
            )
        }
    }
}

/**
 * M56 (TASKS.md §6, phone column): the home's 「タスク」 tile. 「自分のタスク」, my personal list (a checkbox completes a
 * task, 「＋ 追加」 adds one, the completed ones fold under 「完了 (N)」), and 「自分の担当」, the shared tasks assigned to me,
 * by channel (its name opens that channel's 「タスク」 tab). ＋ makes a task with the whole form.
 */
@Composable
fun MyTasksPane(controller: AppController, version: Int, onOpenBoard: (String) -> Unit) {
    val hub = controller.tasks
    val changes = taskVersion(hub)
    val today = rememberToday().toString()
    LaunchedEffect(hub) { hub?.openMine() }
    LaunchedEffect(hub) { hub?.openRequested() }  // L9 「自分が依頼した」
    DisposableEffect(hub) { onDispose { hub?.closeMine(); hub?.closeRequested() } }
    val list = remember(changes, hub) { hub?.mineList() }
    val requested = remember(changes, hub) { hub?.requestedList() }
    val me = controller.store.me?.id
    val (personal, groups) = remember(list, version) {
        // A DM's tasks (L9) have no channel name: the group is named after the other people.
        TaskRules.groupMineByChannel(list?.tasks ?: emptyList(), me) { id ->
            controller.store.channel(id)?.let { if (it.channel.isDm) channelTitle(it, controller.store) else it.channel.name }
        }
    }
    val requestedRows = remember(requested) { TaskRules.sortRequested(requested?.tasks ?: emptyList()) }
    val requestedLoading = hub?.available == true && (requested == null || requested.state == TaskListState.LOADING)
    val loading = hub?.available == true && (list == null || list.state == TaskListState.LOADING)
    var shownDone by rememberSaveable { mutableStateOf(emptyList<String>()) }

    fun toggle(task: TaskOut) {
        val tasksHub = hub ?: return
        controller.scope.launch {
            try {
                tasksHub.update(task.id, TaskUpdate(status = if (task.status == TaskStatus.DONE) TaskStatus.TODO else TaskStatus.DONE))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                controller.report(e)
            }
        }
    }

    fun LazyListScope.taskList(key: String, tasks: List<TaskOut>, empty: String?, footer: (@Composable () -> Unit)? = null) {
        val (open, done) = TaskRules.splitOpenDone(tasks)
        if (open.isEmpty() && done.isEmpty() && empty != null) {
            item(key = "$key:empty") {
                Text(
                    if (loading) stringResource(R.string.common_loading) else empty, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
                )
            }
        }
        items(open, key = { "$key:${it.id}" }) { task -> MineCard(controller, task, today, version, onToggle = ::toggle) }
        footer?.let { content -> item(key = "$key:add") { Box(Modifier.padding(horizontal = 4.dp)) { content() } } }
        if (done.isNotEmpty()) {
            val expanded = key in shownDone
            item(key = "$key:done") {
                Row(
                    Modifier.fillMaxWidth().heightIn(min = TouchTarget.MIN).clickable(onClickLabel = if (expanded) stringResource(R.string.task_screens_collapse) else stringResource(R.string.common_show)) {
                        shownDone = if (expanded) shownDone - key else shownDone + key
                    }.padding(horizontal = 16.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        if (expanded) Icons.Default.ExpandMore else Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null,
                        modifier = Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text(stringResource(R.string.task_screens_done_2, done.size), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            if (expanded) items(done, key = { "$key:${it.id}" }) { task -> MineCard(controller, task, today, version, onToggle = ::toggle) }
        }
    }

    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize()) {
            listNote(list?.state, hub?.available == true)?.let { NoteStrip(it) }
            LazyColumn(Modifier.fillMaxWidth().weight(1f), contentPadding = PaddingValues(bottom = 88.dp)) {
                item(key = "h:personal") { SectionHeader(stringResource(R.string.common_my_tasks), stringResource(R.string.task_screens_only_visible_to_you)) }
                taskList(
                    "personal", personal, L10n.str(R.string.task_screens_no_personal_tasks_yet),
                    footer = if (hub?.available == true) ({
                        InlineAdd(controller) { title ->
                            hub.create(TaskCreate(title = title, clientTaskId = UUID.randomUUID().toString(), tz = ZoneId.systemDefault().id))
                        }
                    }) else null,
                )
                item(key = "h:assigned") { SectionHeader(stringResource(R.string.task_screens_assigned_to_me), null) }
                if (groups.isEmpty()) {
                    item(key = "assigned:empty") {
                        Text(
                            if (loading) stringResource(R.string.common_loading) else stringResource(R.string.task_screens_no_assigned_tasks), style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
                        )
                    }
                }
                groups.forEach { group ->
                    item(key = "g:${group.channelId}") {
                        val private = controller.store.channel(group.channelId)?.channel?.type == "private"
                        // A DM has no board (L9): its name opens the conversation.
                        val dm = controller.store.channel(group.channelId)?.channel?.isDm == true
                        Row(
                            Modifier.fillMaxWidth().heightIn(min = TouchTarget.MIN)
                                .clickable(onClickLabel = if (dm) stringResource(R.string.task_screens_open_dm_with, group.channelName) else stringResource(R.string.task_screens_open_tasks_in, group.channelName)) {
                                    if (dm) controller.pendingChannelId = group.channelId else onOpenBoard(group.channelId)
                                }
                                .padding(horizontal = 16.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            if (private) Icon(Icons.Outlined.Lock, contentDescription = stringResource(R.string.task_screens_private), modifier = Modifier.size(14.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                            Text(
                                (if (private) " " else if (dm) "" else "# ") + group.channelName, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold,
                                color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis,
                            )
                            Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                    taskList("g:${group.channelId}", group.tasks, null)
                }
                // L9 (REVIEWS.md §2.3): the shared tasks I made for someone else, open ones by due date.
                item(key = "h:requested") { SectionHeader(stringResource(R.string.task_screens_requested_by_me), null) }
                val (requestedOpen, requestedDone) = requestedRows
                if (requestedOpen.isEmpty() && requestedDone.isEmpty()) {
                    item(key = "requested:empty") {
                        Text(
                            if (requestedLoading) stringResource(R.string.common_loading) else stringResource(R.string.task_screens_no_requested_tasks), style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
                        )
                    }
                }
                items(requestedOpen, key = { "r:${it.id}" }) { task -> RequestedCard(controller, task, today, version) }
                if (requestedDone.isNotEmpty()) {
                    val expanded = "requested" in shownDone
                    item(key = "r:done") {
                        Row(
                            Modifier.fillMaxWidth().heightIn(min = TouchTarget.MIN).clickable(onClickLabel = if (expanded) stringResource(R.string.task_screens_collapse) else stringResource(R.string.common_show)) {
                                shownDone = if (expanded) shownDone - "requested" else shownDone + "requested"
                            }.padding(horizontal = 16.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(
                                if (expanded) Icons.Default.ExpandMore else Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null,
                                modifier = Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            Text(stringResource(R.string.task_screens_done_2, requestedDone.size), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                    if (expanded) items(requestedDone, key = { "r:${it.id}" }) { task -> RequestedCard(controller, task, today, version) }
                }
            }
        }
        if (hub?.available == true) {
            FloatingActionButton(
                onClick = { controller.taskForm = TaskForm(null, TaskCreateInit(channelId = null)) },
                modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp),
            ) { Icon(Icons.Default.Add, contentDescription = stringResource(R.string.common_add_task)) }
        }
    }
}

@Composable
private fun SectionHeader(title: String, detail: String?) {
    Row(Modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 16.dp, bottom = 4.dp).semantics(mergeDescendants = true) { heading() }, verticalAlignment = Alignment.Bottom) {
        Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
        detail?.let { Text("  $it", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}

/** L9: a row of 「自分が依頼した」: where it lives (the DM's other person), its state in its kind's words, its assignees. */
@Composable
private fun RequestedCard(controller: AppController, task: TaskOut, today: String, version: Int) {
    TaskCard(
        controller, task, today, version, onOpen = { controller.taskForm = TaskForm(task, null) },
        modifier = Modifier.padding(horizontal = 12.dp, vertical = 3.dp), showBoard = true, badge = TaskRules.label(task.kind, task.status),
    )
}

/** A row of 「自分のタスク」: the card with its checkbox (done / back to 未着手), when I may change it. */
@Composable
private fun MineCard(controller: AppController, task: TaskOut, today: String, version: Int, onToggle: (TaskOut) -> Unit) {
    val editable = remember(version, task.channelId) {
        TaskRules.canEditTask(task, task.channelId?.let { controller.store.channel(it) }, controller.isAdmin)
    }
    val done = task.status == TaskStatus.DONE
    TaskCard(
        controller, task, today, version, onOpen = { controller.taskForm = TaskForm(task, null) },
        modifier = Modifier.padding(horizontal = 12.dp, vertical = 3.dp),
        leading = {
            Checkbox(
                checked = done, enabled = editable && controller.tasks?.available == true, onCheckedChange = { onToggle(task) },
                modifier = Modifier.semantics { contentDescription = if (done) L10n.str(R.string.task_screens_mark_not_done, task.title) else L10n.str(R.string.task_screens_mark_done, task.title) },
            )
        },
    )
}

/** A task due on a calendar day: 「☐ 題名」 (done 「☑」, struck through) in its board's colour. */
@Composable
fun TaskDayRow(task: TaskOut, onOpen: (TaskOut) -> Unit, showBoard: Boolean = true) {
    val done = task.status == TaskStatus.DONE
    val color = Color(CalendarDates.channelColor(task.channelId))
    val board = if (task.channelId == null) stringResource(R.string.common_you) else TaskRules.placeLabel(task)
    // M84: a due time shows before the title (「☐ 14:00 題名」).
    val time = TaskRules.calendarTime(task)
    Row(
        Modifier.fillMaxWidth().heightIn(min = TouchTarget.MIN).clickable(onClickLabel = stringResource(R.string.common_open)) { onOpen(task) }
            .padding(horizontal = 16.dp, vertical = 8.dp)
            .semantics(mergeDescendants = true) {
                contentDescription = L10n.str(R.string.common_due_2) + (if (time.isNotEmpty()) "$time " else "") + L10n.str(R.string.common_fmt_8, task.title, board) + if (done) L10n.str(R.string.task_screens_done) else ""
            },
        verticalAlignment = Alignment.Top,
    ) {
        Text(stringResource(R.string.common_due), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.width(92.dp).padding(top = 2.dp))
        Text(if (done) "☑" else "☐", color = color, style = MaterialTheme.typography.bodyLarge)
        Spacer(Modifier.width(8.dp))
        if (time.isNotEmpty()) {
            Text(time, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.width(6.dp))
        }
        Column(Modifier.weight(1f)) {
            Text(
                task.title, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium, maxLines = 2, overflow = TextOverflow.Ellipsis,
                textDecoration = if (done) TextDecoration.LineThrough else null,
                color = if (done) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface,
            )
            if (showBoard) Text(board, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
        }
    }
}
