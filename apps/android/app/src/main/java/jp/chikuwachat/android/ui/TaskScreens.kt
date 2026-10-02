package jp.chikuwachat.android.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
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
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
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
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
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

/** M56: the task form to show: a task (null = a new one from `init`). */
data class TaskForm(val task: TaskOut?, val init: TaskCreateInit?)

/** The tasks' changes as Compose state (0 without a hub): the screens read their windows again on each. */
@Composable
fun taskVersion(hub: TaskHub?): Int {
    val flow = remember(hub) { hub?.version ?: MutableStateFlow(0) }
    return flow.collectAsState().value
}

private fun listNote(state: TaskListState?, available: Boolean): String? = when {
    !available || state == TaskListState.UNSUPPORTED -> "このサーバはタスクに対応していません"
    state == TaskListState.FAILED -> "タスクを読み込めませんでした。再接続すると読み直します"
    else -> null
}

/**
 * M56 (TASKS.md §6, phone column): a channel's 「タスク」 tab. The three columns as a switch on top (「未着手 3」 「進行中 1」
 * 「完了」), that column's cards under it in the server's order, and 「＋ 追加」 after the last card. A card's ⋮ (or a long
 * press) moves it to another column, one place up or down, or deletes it. A board I may not change says why.
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
    var column by rememberSaveable(channel.id) { mutableStateOf(TaskStatus.TODO) }
    val current = remember(version, channel.id) { controller.store.channel(channel.id) ?: channel }
    val canEdit = hub?.available == true && TaskRules.canEditBoard(current, controller.isAdmin)
    val cards = remember(tasks, column) { TaskRules.sortColumn(tasks, column) }
    var confirmDelete by remember { mutableStateOf<TaskOut?>(null) }
    val note = listNote(board?.state, hub?.available == true)
        ?: TaskRules.boardNote(unsupported = false, failed = false, channel = current, canEdit = canEdit || hub?.available != true)

    fun move(task: TaskOut, status: String, neighbors: TaskNeighbors) {
        val tasksHub = hub ?: return
        controller.scope.launch {
            try {
                tasksHub.move(task.id, status, neighbors)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                controller.report(e)
            }
        }
    }

    Column(Modifier.fillMaxSize()) {
        SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp)) {
            TaskStatus.all.forEachIndexed { index, status ->
                val count = tasks.count { it.status == status }
                // 「完了」 without a number: the board holds only the latest 100 of them (TASKS.md §6).
                val label = TaskRules.label(status) + if (status != TaskStatus.DONE) " $count" else ""
                SegmentedButton(
                    selected = column == status,
                    onClick = { column = status },
                    shape = SegmentedButtonDefaults.itemShape(index, TaskStatus.all.size),
                    icon = {},
                ) { Text(label, maxLines = 1) }
            }
        }
        note?.let { NoteStrip(it) }
        HorizontalDivider()
        LazyColumn(Modifier.fillMaxWidth().weight(1f), contentPadding = PaddingValues(start = 12.dp, end = 12.dp, top = 8.dp, bottom = 88.dp)) {
            if (cards.isEmpty()) {
                item(key = "empty") {
                    val loading = hub?.available == true && (board == null || board.state == TaskListState.LOADING)
                    Text(
                        if (loading) "読み込み中…" else "${TaskRules.label(column)}のタスクはありません",
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
                            TaskStatus.all.filter { it != task.status }.forEach { status ->
                                DropdownMenuItem(
                                    text = { Text("「${TaskRules.label(status)}」へ移動") },
                                    onClick = { dismiss(); move(task, status, TaskNeighbors.NONE) },
                                )
                            }
                            val up = TaskRules.moveWithin(cards, task.id, -1)
                            val down = TaskRules.moveWithin(cards, task.id, 1)
                            DropdownMenuItem(text = { Text("上へ") }, enabled = up != null, onClick = { dismiss(); up?.let { move(task, task.status, it) } })
                            DropdownMenuItem(text = { Text("下へ") }, enabled = down != null, onClick = { dismiss(); down?.let { move(task, task.status, it) } })
                        }
                        if (task.canDelete) {
                            DropdownMenuItem(
                                text = { Text("削除", color = MaterialTheme.colorScheme.error) },
                                onClick = { dismiss(); confirmDelete = task },
                            )
                        }
                    } else null,
                )
            }
            if (column == TaskStatus.DONE && board != null && !board.allDone && cards.size >= TaskRules.BOARD_DONE_LIMIT) {
                item(key = "all-done") {
                    TextButton(onClick = { controller.scope.launch { hub?.openBoard(channel.id, allDone = true) } }) { Text("完了をすべて表示") }
                }
            }
            if (canEdit && hub != null) {
                item(key = "add:$column") {
                    InlineAdd(controller) { title ->
                        hub.create(TaskCreate(channelId = channel.id, title = title, status = column, clientTaskId = UUID.randomUUID().toString(), tz = ZoneId.systemDefault().id))
                    }
                }
            }
        }
    }
    confirmDelete?.let { task -> DeleteTaskDialog(controller, task, onDismiss = { confirmDelete = null }) }
}

/** 「このタスクを削除しますか？」, then the delete (the hub drops it everywhere). */
@Composable
fun DeleteTaskDialog(controller: AppController, task: TaskOut, onDismiss: () -> Unit, onDeleted: () -> Unit = {}) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("タスクを削除しますか？") },
        text = { Text("「${task.title}」を削除します。" + if (task.channelId != null) "ボードのメンバー全員から消えます。" else "") },
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
            }) { Text("削除", color = MaterialTheme.colorScheme.error) }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("キャンセル") } },
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
            Text(" 追加")
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
            value = text, onValueChange = { text = it.take(TaskRules.MAX_TITLE) }, placeholder = { Text("タスクの題名") }, singleLine = true,
            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done), keyboardActions = KeyboardActions(onDone = { submit() }),
            modifier = Modifier.weight(1f).focusRequester(focus),
        )
        TextButton(enabled = !busy && text.isNotBlank(), onClick = ::submit) { Text("追加") }
        IconButton(onClick = { open = false; text = "" }) { Icon(Icons.Default.Close, contentDescription = "閉じる") }
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
    val names = remember(version, task.assigneeIds) { task.assigneeIds.map { store.users[it]?.displayName ?: "?" } }
    val summary = buildString {
        append(task.title)
        if (done) append("、完了")
        badge?.let { append("、").append(it) }
        task.dueOn?.let { append(if (task.kind == TaskKind.REVIEW) "、希望日 " else "、期限 ").append(TaskRules.dueLabel(it, today)); if (overdue) append(" (過ぎています)") }
        if (names.isNotEmpty()) append("、担当 ").append(names.joinToString("、"))
        if (!task.notes.isNullOrBlank()) append("、メモあり")
        if (task.source?.messageId != null) append("、元のメッセージあり")
        if (task.canvasSource?.canvasId != null) append("、元のキャンバスあり")
    }
    Surface(
        shape = RoundedCornerShape(10.dp), color = MaterialTheme.colorScheme.surfaceContainerLow,
        modifier = modifier.fillMaxWidth().border(1.dp, MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(10.dp)),
    ) {
        Row(
            Modifier.fillMaxWidth().heightIn(min = TouchTarget.MIN)
                .combinedClickable(onClickLabel = "開く", onLongClickLabel = if (menu != null) "タスクの操作" else null, onLongClick = if (menu != null) ({ menuOpen = true }) else null, onClick = onOpen)
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
                val marks = badge != null || task.dueOn != null || !task.notes.isNullOrBlank() || task.source?.messageId != null || canvasId != null || names.isNotEmpty()
                if (marks) {
                    Row(Modifier.padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        badge?.let {
                            Text(
                                it, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold,
                                color = if (done) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.primary,
                            )
                        }
                        task.dueOn?.let { due ->
                            val color = if (overdue) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant
                            Text(
                                (if (task.kind == TaskKind.REVIEW) "希望日 " else "期限 ") + TaskRules.dueLabel(due, today), style = MaterialTheme.typography.labelMedium, color = color,
                                fontWeight = if (overdue || due == today) FontWeight.SemiBold else FontWeight.Normal,
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
                                Icons.AutoMirrored.Outlined.Article, contentDescription = "元のキャンバスを開く", tint = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier
                                    .clickable(role = Role.Button, onClickLabel = "元のキャンバスを開く") { controller.scope.launch { controller.openCanvasLink(canvasId) } }
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
                    IconButton(onClick = { menuOpen = true }) { Icon(Icons.Default.MoreVert, contentDescription = "タスクの操作") }
                    DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) { menu { menuOpen = false } }
                }
            }
        }
    }
}

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
                    if (loading) "読み込み中…" else empty, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
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
                    Modifier.fillMaxWidth().heightIn(min = TouchTarget.MIN).clickable(onClickLabel = if (expanded) "畳む" else "表示") {
                        shownDone = if (expanded) shownDone - key else shownDone + key
                    }.padding(horizontal = 16.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Icon(
                        if (expanded) Icons.Default.ExpandMore else Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null,
                        modifier = Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text(" 完了 (${done.size})", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            if (expanded) items(done, key = { "$key:${it.id}" }) { task -> MineCard(controller, task, today, version, onToggle = ::toggle) }
        }
    }

    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize()) {
            listNote(list?.state, hub?.available == true)?.let { NoteStrip(it) }
            LazyColumn(Modifier.fillMaxWidth().weight(1f), contentPadding = PaddingValues(bottom = 88.dp)) {
                item(key = "h:personal") { SectionHeader("自分のタスク", "自分だけに表示") }
                taskList(
                    "personal", personal, "個人用のタスクはまだありません",
                    footer = if (hub?.available == true) ({
                        InlineAdd(controller) { title ->
                            hub.create(TaskCreate(title = title, clientTaskId = UUID.randomUUID().toString(), tz = ZoneId.systemDefault().id))
                        }
                    }) else null,
                )
                item(key = "h:assigned") { SectionHeader("自分の担当", null) }
                if (groups.isEmpty()) {
                    item(key = "assigned:empty") {
                        Text(
                            if (loading) "読み込み中…" else "担当のタスクはありません", style = MaterialTheme.typography.bodyMedium,
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
                                .clickable(onClickLabel = if (dm) "${group.channelName} との DM を開く" else "#${group.channelName} のタスクを開く") {
                                    if (dm) controller.pendingChannelId = group.channelId else onOpenBoard(group.channelId)
                                }
                                .padding(horizontal = 16.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            if (private) Icon(Icons.Outlined.Lock, contentDescription = "非公開", modifier = Modifier.size(14.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
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
                item(key = "h:requested") { SectionHeader("自分が依頼した", null) }
                val (requestedOpen, requestedDone) = requestedRows
                if (requestedOpen.isEmpty() && requestedDone.isEmpty()) {
                    item(key = "requested:empty") {
                        Text(
                            if (requestedLoading) "読み込み中…" else "依頼したタスクはありません", style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
                        )
                    }
                }
                items(requestedOpen, key = { "r:${it.id}" }) { task -> RequestedCard(controller, task, today, version) }
                if (requestedDone.isNotEmpty()) {
                    val expanded = "requested" in shownDone
                    item(key = "r:done") {
                        Row(
                            Modifier.fillMaxWidth().heightIn(min = TouchTarget.MIN).clickable(onClickLabel = if (expanded) "畳む" else "表示") {
                                shownDone = if (expanded) shownDone - "requested" else shownDone + "requested"
                            }.padding(horizontal = 16.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(
                                if (expanded) Icons.Default.ExpandMore else Icons.AutoMirrored.Filled.KeyboardArrowRight, contentDescription = null,
                                modifier = Modifier.size(18.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                            Text(" 完了 (${requestedDone.size})", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
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
            ) { Icon(Icons.Default.Add, contentDescription = "タスクを追加") }
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
                modifier = Modifier.semantics { contentDescription = if (done) "「${task.title}」を未完了に戻す" else "「${task.title}」を完了にする" },
            )
        },
    )
}

/** A task due on a calendar day: 「☐ 題名」 (done 「☑」, struck through) in its board's colour. */
@Composable
fun TaskDayRow(task: TaskOut, onOpen: (TaskOut) -> Unit, showBoard: Boolean = true) {
    val done = task.status == TaskStatus.DONE
    val color = Color(CalendarDates.channelColor(task.channelId))
    val board = if (task.channelId == null) "自分" else TaskRules.placeLabel(task)
    Row(
        Modifier.fillMaxWidth().heightIn(min = TouchTarget.MIN).clickable(onClickLabel = "開く") { onOpen(task) }
            .padding(horizontal = 16.dp, vertical = 8.dp)
            .semantics(mergeDescendants = true) { contentDescription = "期限 ${task.title}、$board" + if (done) "、完了" else "" },
        verticalAlignment = Alignment.Top,
    ) {
        Text("期限", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.width(92.dp).padding(top = 2.dp))
        Text(if (done) "☑" else "☐", color = color, style = MaterialTheme.typography.bodyLarge)
        Spacer(Modifier.width(8.dp))
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
