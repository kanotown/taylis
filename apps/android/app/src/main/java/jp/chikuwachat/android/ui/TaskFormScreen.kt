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
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.outlined.ChatBubbleOutline
import androidx.compose.material3.AlertDialog
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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalView
import androidx.compose.ui.semantics.Role
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
import jp.chikuwachat.android.api.MemberOut
import jp.chikuwachat.android.api.TaskCreate
import jp.chikuwachat.android.api.TaskOut
import jp.chikuwachat.android.api.TaskStatus
import jp.chikuwachat.android.app.AppController
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import java.text.Collator
import java.time.LocalDate
import java.time.ZoneId
import java.util.Locale
import java.util.UUID

/** The form's fields across a rotation (the form itself stays open: the controller holds it). */
private val TaskDraftSaver = listSaver<TaskDraft, String>(
    save = { listOf(it.title, it.notes, it.status, it.dueOn, it.assigneeIds.joinToString(",")) },
    restore = { TaskDraft(it[0], it[1], it[2], it[3], it[4].split(",").filter { id -> id.isNotEmpty() }) },
)

/** 追加先's value for 「自分のタスク」. */
private const val MINE = ""

/**
 * M56 (TASKS.md §6, phone column): a task's full-screen form — 題名, メモ, 状態, 期限 (a date picker, and 「期限をなくす」),
 * 担当者 (the channel's members; not for a personal task), the message it came from (「メッセージを開く」), and 削除 with a
 * confirmation. New tasks too (「タスクにする」, 「自分のタスク」's ＋), with 追加先 (a channel's board or 「自分のタスク」).
 * Someone who may not change the board sees the task read-only. Saving sends only what changed (the device's zone with a
 * new due date).
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
        form.task?.let { TaskRules.draftFromTask(it) } ?: TaskDraft(title = init?.title ?: "", status = init?.status ?: TaskStatus.TODO)
    }
    var draft by rememberSaveable(form, stateSaver = TaskDraftSaver) { mutableStateOf(initial) }
    var board by rememberSaveable(form) { mutableStateOf(init?.channelId ?: MINE) }
    var busy by remember(form) { mutableStateOf(false) }
    var error by rememberSaveable(form) { mutableStateOf<String?>(null) }
    var confirmDelete by rememberSaveable(form) { mutableStateOf(false) }
    var picking by rememberSaveable(form) { mutableStateOf(false) }
    // The idempotency key of this form's create: a retry after a lost answer returns the same task.
    val clientId = rememberSaveable(form) { UUID.randomUUID().toString() }
    val channelId = if (form.task != null) task?.channelId else board.ifEmpty { null }
    val channel = remember(version, channelId) { channelId?.let { store.channel(it) } }
    val editable = task == null || TaskRules.canEditTask(task, channel, controller.isAdmin)
    val boards = remember(form, version) { init?.boardChoices?.filter { TaskRules.canEditBoard(store.channel(it), controller.isAdmin) } ?: emptyList() }
    val available = hub?.available == true
    fun change(next: TaskDraft) {
        draft = next
        error = null
    }
    fun boardName(id: String?): String = if (id == null) "自分のタスク" else "#" + (store.channel(id)?.channel?.name ?: task?.channelName ?: "?") + " のボード"

    fun save() {
        if (hub == null || busy) return
        val problem = TaskRules.draftProblem(draft)
        if (problem != null) {
            error = problem
            return
        }
        busy = true
        controller.scope.launch {
            try {
                val zone = ZoneId.systemDefault().id
                if (task == null) {
                    hub.create(
                        TaskCreate(
                            channelId = channelId, title = TaskRules.cleanTitle(draft.title), notes = draft.notes.takeIf { it.isNotBlank() },
                            status = draft.status, dueOn = draft.dueOn.ifEmpty { null },
                            assigneeIds = draft.assigneeIds.distinct().takeIf { channelId != null && it.isNotEmpty() },
                            sourceMessageId = init?.sourceMessageId, clientTaskId = clientId, tz = zone,
                        ),
                    )
                    controller.notice = "タスクを作成しました"
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
        task == null -> "タスクを追加"
        editable -> "タスクを編集"
        else -> "タスク"
    }
    val source = when {
        task != null -> TaskRules.sourceState(task)
        init?.sourceMessageId != null -> TaskSource.Link(init.sourceMessageId, init.sourceExcerpt)
        else -> TaskSource.None
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
                    IconButton(onClick = onDismiss) { Icon(Icons.Default.Close, contentDescription = "閉じる") }
                    Text(title, style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f).semantics { heading() })
                    if (editable) {
                        TextButton(enabled = !busy && available, onClick = ::save) { Text(if (busy) "保存中…" else if (task == null) "追加" else "保存") }
                    }
                }
                HorizontalDivider()
                Column(
                    Modifier.fillMaxWidth().weight(1f).verticalScroll(rememberScrollState()).padding(16.dp),
                    verticalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    if (task == null) {
                        BoardChoice(
                            value = if (board == MINE) "自分のタスク (自分だけに表示)" else boardName(board),
                            options = boards.map { it to boardName(it) } + (MINE to "自分のタスク (自分だけに表示)"),
                            enabled = boards.isNotEmpty(),
                            onPick = { picked -> board = picked; change(draft.copy(assigneeIds = emptyList())) },
                        )
                    } else {
                        Text(boardName(task.channelId), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    if (editable) {
                        OutlinedTextField(
                            value = draft.title, onValueChange = { change(draft.copy(title = it.take(TaskRules.MAX_TITLE))) },
                            label = { Text("題名") }, placeholder = { Text("資料をまとめる") }, modifier = Modifier.fillMaxWidth(),
                        )
                        OutlinedTextField(
                            value = draft.notes, onValueChange = { change(draft.copy(notes = it.take(TaskRules.MAX_NOTES))) },
                            label = { Text("メモ") }, placeholder = { Text("Markdown で書けます") }, minLines = 3, modifier = Modifier.fillMaxWidth(),
                        )
                        Column {
                            FieldLabel("状態")
                            SingleChoiceSegmentedButtonRow(Modifier.fillMaxWidth()) {
                                TaskStatus.all.forEachIndexed { index, status ->
                                    SegmentedButton(
                                        selected = draft.status == status, onClick = { change(draft.copy(status = status)) },
                                        shape = SegmentedButtonDefaults.itemShape(index, TaskStatus.all.size),
                                    ) { Text(TaskRules.label(status)) }
                                }
                            }
                        }
                        Column {
                            FieldLabel("期限")
                            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                OutlinedButton(onClick = { picking = true }, modifier = Modifier.weight(1f)) {
                                    Text(draft.dueOn.takeIf { it.isNotEmpty() }?.let { dueText(it) } ?: "なし", maxLines = 1)
                                }
                                if (draft.dueOn.isNotEmpty()) {
                                    TextButton(onClick = { change(draft.copy(dueOn = "")) }) { Text("期限をなくす") }
                                }
                            }
                        }
                        if (channelId != null) {
                            AssigneePicker(controller, channelId, version, draft.assigneeIds, onChange = { change(draft.copy(assigneeIds = it)) })
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
                                Text("元のメッセージ", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                source.excerpt?.let { Text(it, style = MaterialTheme.typography.bodyMedium, maxLines = 3, overflow = TextOverflow.Ellipsis) }
                            }
                            if (task != null) {
                                TextButton(onClick = {
                                    onDismiss()
                                    controller.scope.launch { controller.openPermalink(source.messageId) }
                                }) { Text("メッセージを開く") }
                            }
                        }
                        TaskSource.Deleted -> Text(
                            "元のメッセージは削除されました", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceContainerHigh, RoundedCornerShape(10.dp)).padding(12.dp),
                        )
                        TaskSource.None -> Unit
                    }
                    if (!available) Text("このサーバはタスクに対応していません", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium) }
                    if (task?.canDelete == true) {
                        TextButton(enabled = !busy, onClick = { confirmDelete = true }) {
                            Icon(Icons.Default.Delete, contentDescription = null, tint = MaterialTheme.colorScheme.error, modifier = Modifier.size(18.dp))
                            Text(" タスクを削除", color = MaterialTheme.colorScheme.error)
                        }
                    }
                }
            }
        }
        if (picking) {
            val state = rememberDatePickerState(
                initialSelectedDateMillis = Schedule.pickerMillis(draft.dueOn.takeIf { it.isNotEmpty() }?.let { LocalDate.parse(it) } ?: CalendarDates.today()),
            )
            DatePickerDialog(
                onDismissRequest = { picking = false },
                confirmButton = {
                    TextButton(enabled = state.selectedDateMillis != null, onClick = {
                        state.selectedDateMillis?.let { change(draft.copy(dueOn = Schedule.pickerDate(it).toString())) }
                        picking = false
                    }) { Text("決定") }
                },
                dismissButton = { TextButton(onClick = { picking = false }) { Text("キャンセル") } },
            ) { DatePicker(state = state) }
        }
        if (confirmDelete && task != null) {
            AlertDialog(
                onDismissRequest = { confirmDelete = false },
                title = { Text("タスクを削除しますか？") },
                text = { Text("「${task.title}」を削除します。" + if (task.channelId != null) "ボードのメンバー全員から消えます。" else "") },
                confirmButton = { TextButton(onClick = { confirmDelete = false; remove() }) { Text("削除", color = MaterialTheme.colorScheme.error) } },
                dismissButton = { TextButton(onClick = { confirmDelete = false }) { Text("キャンセル") } },
            )
        }
    }
}

/** 「10月5日 (月)」, with 「(今日)」 on today. */
private fun dueText(dueOn: String): String {
    val day = runCatching { LocalDate.parse(dueOn) }.getOrNull() ?: return dueOn
    return CalendarDates.dayLabel(day) + if (day == CalendarDates.today()) " (今日)" else ""
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
        FieldLabel("追加先")
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
private fun AssigneePicker(controller: AppController, channelId: String, version: Int, selected: List<String>, onChange: (List<String>) -> Unit) {
    var members by remember(channelId) { mutableStateOf<List<MemberOut>?>(null) }
    var failed by remember(channelId) { mutableStateOf(false) }
    LaunchedEffect(channelId) {
        controller.memberList(channelId).onSuccess { members = it }.onFailure { failed = true }
    }
    var query by rememberSaveable(channelId) { mutableStateOf("") }
    val me = controller.store.me?.id
    val rows = remember(members, version) {
        val collator = Collator.getInstance(Locale.JAPANESE)
        (members ?: emptyList()).map { member ->
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
        FieldLabel("担当者" + if (selected.isNotEmpty()) " (${selected.size} 人)" else "")
        when {
            failed -> Text("メンバーを読み込めませんでした", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.error)
            members == null -> Text("読み込み中…", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            else -> {
                if (rows.size > 8) {
                    OutlinedTextField(
                        query, { query = it }, placeholder = { Text("名前で絞り込む") }, singleLine = true,
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
                        Text(name + if (id == me) " (自分)" else "", style = MaterialTheme.typography.bodyLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
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
        Text("状態: " + TaskRules.label(task.status), style = MaterialTheme.typography.bodyLarge)
        Text("期限: " + (task.dueOn?.let { dueText(it) } ?: "なし"), style = MaterialTheme.typography.bodyLarge)
        if (task.channelId != null) {
            Text(
                "担当者: " + task.assigneeIds.joinToString("、") { users[it]?.displayName ?: "?" }.ifEmpty { "なし" },
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
        Text("このボードを変更できるのは、チャンネルに投稿できるメンバーです。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        HorizontalDivider(Modifier.padding(top = 4.dp))
    }
}
