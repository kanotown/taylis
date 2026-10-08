package jp.chikuwachat.android.ui

import jp.chikuwachat.android.api.CalendarEventOut
import jp.chikuwachat.android.api.ChannelOut
import jp.chikuwachat.android.api.GroupOut
import jp.chikuwachat.android.api.MessageTaskOut
import jp.chikuwachat.android.api.SubtaskIn
import jp.chikuwachat.android.api.TaskAssigned
import jp.chikuwachat.android.api.TaskColumnOut
import jp.chikuwachat.android.api.TaskCreate
import jp.chikuwachat.android.api.TaskDue
import jp.chikuwachat.android.api.TaskKind
import jp.chikuwachat.android.api.TaskNeighbors
import jp.chikuwachat.android.api.TaskOut
import jp.chikuwachat.android.api.TaskReviewDone
import jp.chikuwachat.android.api.TaskStatus
import jp.chikuwachat.android.api.TaskUpdate
import jp.chikuwachat.android.api.UserPublic
import jp.chikuwachat.android.sync.ChannelState
import kotlinx.serialization.Serializable
import java.text.Collator
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.format.DateTimeFormatter
import java.util.Locale
import java.util.UUID
import jp.chikuwachat.android.R
import jp.chikuwachat.android.L10n

/** The task form's fields (TASKS.md §6). `dueOn` "" = none. */
data class TaskDraft(
    val title: String,
    val notes: String = "",
    val status: String = TaskStatus.TODO,
    val dueOn: String = "",
    val assigneeIds: List<String> = emptyList(),
    /** M84: "HH:mm" in the device's zone, "" = the whole day. */
    val dueTime: String = "",
    /** M84: 「繰り返し」 (only with a due date; its start is the due date). */
    val repeat: RepeatDraft = RepeatDraft(),
    /** M84: 「サブタスク」, in order. */
    val subtasks: List<SubtaskDraft> = emptyList(),
    /** M86 (DEADLINES.md §8 4.): a deadline's 「事前の通知」, days before (null: not a deadline). */
    val noticeDays: List<Int>? = null,
)

/** M84: a checklist item in the form (`id` null: new). `key` keeps a row's identity across edits (new ones have no id). */
@Serializable
data class SubtaskDraft(val id: String?, val title: String, val done: Boolean = false, val key: String = id ?: UUID.randomUUID().toString())

/** M84: 「左へ」 / 「右へ」's place: right of the column `afterId` (null: the left end), as PATCH /tasks/columns/{id} takes it. */
data class ColumnPlace(val afterId: String?)

/**
 * What the form starts a new task with. `channelId` null: 「自分のタスク」. 「タスクにする」 adds the message, its one-line
 * excerpt, and the boards offered besides 「自分のタスク」 (its channel's when I may add to it; none from a DM).
 *
 * L9 (REVIEWS.md §2.1, §2.3): `dmChannelId` is the DM a message came from: its members can be picked as assignees, and
 * with any picked the task is shared in that DM (none: personal, as before). `kind` review is 「レビューを依頼」: the
 * conversation is fixed (`channelId`, a board or a DM), 依頼先 come first and at least one is needed, 期限 reads 希望日.
 * `assigneeIds`: picked from the start (a 1:1 DM's other person for a review).
 */
data class TaskCreateInit(
    val channelId: String?,
    val status: String = TaskStatus.TODO,
    val title: String = "",
    val sourceMessageId: String? = null,
    val sourceExcerpt: String? = null,
    val boardChoices: List<String> = emptyList(),
    val kind: String = TaskKind.TASK,
    val dmChannelId: String? = null,
    val assigneeIds: List<String> = emptyList(),
    /** M73: the due date picked from the start ("YYYY-MM-DD", "" none): a checklist item's `📅 YYYY-MM-DD`. */
    val dueOn: String = "",
    /** M73 (CANVAS.md §18.3): 「タスクにする」 on a canvas's checklist item — the canvas, the line as in its body, its text. */
    val sourceCanvasId: String? = null,
    val sourceCanvasLine: String? = null,
    val sourceCanvasExcerpt: String? = null,
) {
    val isReview: Boolean get() = kind == TaskKind.REVIEW

    /**
     * M86 (DEADLINES.md §8 4.): whether the form offers 「タスク / 締切」 — a new task on a channel's board (not a review
     * request, not from a message, a canvas or a DM).
     */
    val canBeDeadline: Boolean
        get() = !isReview && dmChannelId == null && sourceMessageId == null && sourceCanvasId == null

    /** The conversation a new task goes to: a DM once someone is assigned there, else the chosen board (null: mine). */
    fun targetChannel(board: String?, assigneeIds: List<String>): String? =
        if (dmChannelId != null && !isReview) dmChannelId.takeIf { assigneeIds.isNotEmpty() } else board
}

/** L9: how a chip under a message is coloured — grey once done, red past its due date, else the accent. */
enum class TaskChipTone { OPEN, DONE, OVERDUE }

/** L9 (REVIEWS.md §2.2): a chip under a message, 「レビュー依頼 · 加納 · 依頼中 · 10/9 まで」. */
data class TaskChip(val taskId: String, val text: String, val tone: TaskChipTone)

/** What a task says of the message it came from. */
sealed interface TaskSource {
    data object None : TaskSource
    /** 「元のメッセージは削除されました」. */
    data object Deleted : TaskSource
    data class Link(val messageId: String, val excerpt: String?) : TaskSource
}

/** M73: what a task says of the canvas checklist item it came from (TaskOut.canvas_source). */
sealed interface CanvasTaskSource {
    data object None : CanvasTaskSource
    /** 「元のキャンバスは削除されました」 (purged from the trash). */
    data class Deleted(val excerpt: String?) : CanvasTaskSource
    data class Link(val canvasId: String, val excerpt: String?) : CanvasTaskSource
}

/** 「自分の担当」's group: one channel's tasks assigned to me. */
data class MineGroup(val channelId: String, val channelName: String, val tasks: List<TaskOut>)

/** What task.assigned / task.due say while the app is open (worded like the push), and the task a tap opens. */
data class TaskNoticeText(val body: String, val taskId: String, val channelId: String?)

/**
 * M56 (TASKS.md): the tasks' pure rules, a port of the desktop's ui/tasks.ts — the columns' order, where a moved card lands
 * (its neighbours for POST /tasks/{id}/move), the optimistic move, events, due dates, who may edit a board, 「自分のタスク」's
 * groups, the form's patch, 「タスクにする」's prefill and the notices' wording. No store, no Compose: the hub
 * (sync/Tasks.kt) and the screens share them, and TaskRulesTest reads them. Dates are "YYYY-MM-DD" strings (they sort).
 */
object TaskRules {
    val STATUS_LABELS: Map<String, String> get() = mapOf(TaskStatus.TODO to L10n.str(R.string.task_rules_to_do), TaskStatus.DOING to L10n.str(R.string.task_rules_in_progress), TaskStatus.DONE to L10n.str(R.string.common_done_2))
    const val MAX_TITLE = 200
    const val MAX_NOTES = 4000
    /** A board brings this many completed cards (then 「完了をすべて表示」 reads them all). */
    const val BOARD_DONE_LIMIT = 100
    /** Avatars on a card before 「+N」. */
    const val CARD_AVATARS = 3

    private val collator: Collator = Collator.getInstance(Locale.JAPANESE)

    fun label(status: String): String = STATUS_LABELS[status] ?: status

    // --- L9: kinds and the chips under a message (REVIEWS.md §2.2) ----------------------------------

    /** A review request's states: 依頼中 / 対応中 / 完了. */
    val REVIEW_LABELS: Map<String, String> get() = mapOf(TaskStatus.TODO to L10n.str(R.string.task_rules_requested), TaskStatus.DOING to L10n.str(R.string.task_rules_in_review), TaskStatus.DONE to L10n.str(R.string.common_done_2))

    /** A status in its kind's words (a review: 依頼中 / 対応中 / 完了; a task: 未着手 / 進行中 / 完了). */
    fun label(kind: String, status: String): String = if (kind == TaskKind.REVIEW) REVIEW_LABELS[status] ?: status else label(status)

    /** The chip's first word: 「レビュー依頼」 or 「タスク」. */
    fun kindLabel(kind: String): String = if (kind == TaskKind.REVIEW) L10n.str(R.string.common_review_request) else L10n.str(R.string.common_tasks)

    /** Names on a chip before 「ほか N 人」. */
    const val CHIP_NAMES = 2

    /**
     * The chip of a task made from a message: its kind, the assignees (2 names, then 「ほか N 人」; none: left out), the state
     * in its kind's words, and the due date (「10/9 まで」, 「今日まで」) while not done. Done is grey; open past its due date red.
     */
    fun chip(task: MessageTaskOut, today: String, nameOf: (String) -> String?): TaskChip = chipAt(task, today, Instant.now(), nameOf)

    /** [chip] at `now` (a due time is late once it has passed). */
    fun chipAt(task: MessageTaskOut, today: String, now: Instant, nameOf: (String) -> String?): TaskChip {
        val names = task.assigneeIds.take(CHIP_NAMES).map { nameOf(it) ?: "?" }
        val rest = task.assigneeIds.size - names.size
        val who = names.joinToString(L10n.str(R.string.common_list_separator)) + if (rest > 0) L10n.str(R.string.common_and_others, rest) else ""
        val done = task.status == TaskStatus.DONE
        val parts = buildList {
            add(kindLabel(task.kind))
            if (who.isNotEmpty()) add(who)
            add(label(task.kind, task.status))
            // M84: with its time when it has one (「10/9 14:00 まで」).
            if (!done && task.dueOn != null) dueText(task.dueOn, task.dueAt, today).let { due -> add(if (due == L10n.str(R.string.common_today)) L10n.str(R.string.task_rules_due_today) else L10n.str(R.string.common_until, due)) }
        }
        val overdue = !done && overdue(task.dueOn, task.dueAt, today, now)
        return TaskChip(task.id, parts.joinToString(" · "), if (done) TaskChipTone.DONE else if (overdue) TaskChipTone.OVERDUE else TaskChipTone.OPEN)
    }

    /** The task detail's big buttons for an assignee (REVIEWS.md §2.2): 「対応を始める」 from todo, 「完了にする」 until done. */
    fun quickStatuses(task: TaskOut, me: String?): List<String> {
        if (me == null || me !in task.assigneeIds || task.channelId == null) return emptyList()
        return when (task.status) {
            TaskStatus.TODO -> listOf(TaskStatus.DOING, TaskStatus.DONE)
            TaskStatus.DOING -> listOf(TaskStatus.DONE)
            else -> emptyList()
        }
    }

    fun quickLabel(status: String): String = if (status == TaskStatus.DOING) L10n.str(R.string.task_rules_start) else L10n.str(R.string.task_rules_mark_done)

    /** 「自分が依頼した」: a shared task I made with someone else assigned (the server's GET /tasks/requested rule). */
    fun isRequested(task: TaskOut, me: String?): Boolean =
        me != null && task.channelId != null && task.ownerId == me && task.assigneeIds.any { it != me }

    /**
     * Where a task lives, as a card's line says it: 「自分のタスク」, 「#lab」, or (L9) for a DM's task, which has no channel
     * name, the other people of that DM (`dmTitle`; 「DM」 when not known here).
     */
    fun placeLabel(task: TaskOut, dmTitle: (String) -> String? = { null }): String {
        val channelId = task.channelId ?: return L10n.str(R.string.common_my_tasks)
        task.channelName?.let { return "#$it" }
        return dmTitle(channelId) ?: "DM"
    }

    /** 「自分が依頼した」's order: open ones by due date (none last), then the completed ones, newest first. */
    fun sortRequested(tasks: List<TaskOut>): Pair<List<TaskOut>, List<TaskOut>> {
        val open = tasks.filter { it.status != TaskStatus.DONE }
            .sortedWith(compareBy<TaskOut> { it.dueOn == null }.thenBy { it.dueOn ?: "" }.thenBy { it.createdAt }.thenBy { it.id })
        val done = tasks.filter { it.status == TaskStatus.DONE }.sortedWith(compareByDescending<TaskOut> { it.completedAt ?: "" }.thenBy { it.id })
        return open to done
    }

    // --- order and moves ---------------------------------------------------------------------------

    /** The server's order inside a column: position, then id. */
    val order: Comparator<TaskOut> = compareBy<TaskOut> { it.position }.thenBy { it.id }

    /** One column of a board, in the server's order (never a local index: the server may renumber). */
    fun sortColumn(tasks: List<TaskOut>, status: String): List<TaskOut> = tasks.filter { it.status == status }.sortedWith(order)

    /**
     * Where a card put into slot `dropIndex` of `column` lands: the card ending up directly above (after_id) and directly
     * below (before_id). `column` is the target column as shown (it may hold the card itself: a move within the column),
     * `dropIndex` a slot of it, 0 (over the first card) to column.size (under the last).
     */
    fun computeNeighbors(column: List<TaskOut>, taskId: String, dropIndex: Int): TaskNeighbors {
        val from = column.indexOfFirst { it.id == taskId }
        val rest = column.filter { it.id != taskId }
        var index = dropIndex.coerceIn(0, column.size)
        if (from in 0 until index) index -= 1
        index = minOf(index, rest.size)
        return TaskNeighbors(rest.getOrNull(index - 1)?.id, rest.getOrNull(index)?.id)
    }

    /** The move changes nothing (the card back where it was). */
    fun isNoopMove(column: List<TaskOut>, taskId: String, dropIndex: Int): Boolean {
        val from = column.indexOfFirst { it.id == taskId }
        return from >= 0 && (dropIndex == from || dropIndex == from + 1)
    }

    /** 「上へ」 (-1) / 「下へ」 (1) within its column: the neighbours one place up or down (null at the top / bottom). */
    fun moveWithin(column: List<TaskOut>, taskId: String, direction: Int): TaskNeighbors? {
        val from = column.indexOfFirst { it.id == taskId }
        if (from < 0) return null
        val to = from + direction
        if (to < 0 || to >= column.size) return null
        return computeNeighbors(column, taskId, if (direction < 0) to else to + 1)
    }

    /**
     * The position a move would get here (the optimistic guess; the server's answer replaces it): between the neighbours,
     * else past the one given, else the bottom of todo / doing and the top of done (the server's rule without neighbours).
     */
    fun guessPosition(tasks: List<TaskOut>, taskId: String, status: String, neighbors: TaskNeighbors): Double {
        val column = sortColumn(tasks, status).filter { it.id != taskId }
        val above = column.indexOfFirst { it.id == neighbors.afterId }
        val below = column.indexOfFirst { it.id == neighbors.beforeId }
        if (above >= 0 && below >= 0) return (column[above].position + column[below].position) / 2
        if (above >= 0) {
            val next = column.getOrNull(above + 1)
            return if (next != null) (column[above].position + next.position) / 2 else column[above].position + 1
        }
        if (below >= 0) {
            val previous = column.getOrNull(below - 1)
            return if (previous != null) (previous.position + column[below].position) / 2 else column[below].position - 1
        }
        if (column.isEmpty()) return 0.0
        return if (status == TaskStatus.DONE) column.first().position - 1 else column.last().position + 1
    }

    /**
     * The optimistic move: the card in its new column at its guessed position (completion as the server would set it).
     * M84: `into` is the board's column it goes to (its id when added, else the built-in one: null `column_id`); without
     * one, the server's rule for a status alone — the card's column while the status stays, else the built-in one.
     */
    fun applyLocalMove(
        tasks: List<TaskOut>, taskId: String, status: String, neighbors: TaskNeighbors, now: String, me: String?, into: TaskColumnOut? = null,
    ): List<TaskOut> {
        val task = tasks.firstOrNull { it.id == taskId } ?: return tasks
        val columnId = when {
            into != null -> columnIdFor(into)
            status == task.status -> task.columnId
            else -> null
        }
        // The neighbours are among the cards of that column (a board's columns are numbered apart).
        val position = guessPosition(tasks.filter { it.id == taskId || it.columnId == columnId }, taskId, status, neighbors)
        val moved = when {
            status == task.status -> task.copy(position = position, columnId = columnId)
            status == TaskStatus.DONE -> task.copy(status = status, position = position, completedAt = now, completedBy = me, columnId = columnId)
            else -> task.copy(status = status, position = position, completedAt = null, completedBy = null, columnId = columnId)
        }
        return tasks.map { if (it.id == taskId) moved else it }
    }

    // --- M84: a board's columns (TASKS.md §11.5) ---------------------------------------------------

    const val MAX_COLUMNS = 20
    const val MAX_COLUMN_NAME = 50
    const val MAX_SUBTASKS = 50

    /**
     * The three built-in columns before the server's answer, or from a server before M81 (GET /tasks/columns 404 / 422).
     * Their ids are the statuses: a move into one sends the status alone.
     */
    val FALLBACK_COLUMNS: List<TaskColumnOut> = TaskStatus.all.mapIndexed { i, status ->
        TaskColumnOut(id = status, name = label(status), status = status, builtin = true, position = (i + 1).toDouble())
    }

    /** 「種類」 of a new column: the status its cards get. */
    val COLUMN_KIND_LABELS: Map<String, String> get() = mapOf(
        TaskStatus.TODO to L10n.str(R.string.task_rules_to_do_not_started), TaskStatus.DOING to L10n.str(R.string.task_rules_in_progress), TaskStatus.DONE to L10n.str(R.string.task_rules_done_the_card_is_marked_done),
    )

    /** Whether these are the fallback columns (ids = statuses: no adding, renaming or moving columns). */
    fun isFallbackColumns(columns: List<TaskColumnOut>): Boolean = columns.all { it.builtin && it.id == it.status }

    /** Left to right (position, then id). */
    fun sortColumns(columns: List<TaskColumnOut>): List<TaskColumnOut> = columns.sortedWith(compareBy<TaskColumnOut> { it.position }.thenBy { it.id })

    /** The column a card shows in: its added column, else (or when that column is unknown here) the built-in one of its status. */
    fun columnOfTask(task: TaskOut, columns: List<TaskColumnOut>): TaskColumnOut? =
        task.columnId?.let { id -> columns.firstOrNull { it.id == id && !it.builtin } } ?: builtinFor(columns, task.status)

    /** A column's cards in the server's order. */
    fun sortBoardColumn(tasks: List<TaskOut>, column: TaskColumnOut, columns: List<TaskColumnOut>): List<TaskOut> =
        tasks.filter { columnOfTask(it, columns)?.id == column.id }.sortedWith(order)

    /** A task's `column_id` once in `column` (null: a built-in one). */
    fun columnIdFor(column: TaskColumnOut): String? = if (column.builtin) null else column.id

    /** The built-in column of a status (where a deleted column's cards go). */
    fun builtinFor(columns: List<TaskColumnOut>, status: String): TaskColumnOut? = columns.firstOrNull { it.builtin && it.status == status }

    /** The column shown when `selected` (an id, or a status from before the columns were read) is gone: its status's, else the first. */
    fun pickColumn(columns: List<TaskColumnOut>, selected: String?, selectedStatus: String?): TaskColumnOut? =
        columns.firstOrNull { it.id == selected }
            ?: selectedStatus?.let { builtinFor(columns, it) }
            ?: selected?.let { builtinFor(columns, it) }
            ?: columns.firstOrNull()

    fun columnNameProblem(name: String): String? {
        val cleaned = cleanTitle(name)
        return when {
            cleaned.isEmpty() -> L10n.str(R.string.task_rules_enter_a_column_name)
            cleaned.length > MAX_COLUMN_NAME -> L10n.str(R.string.task_rules_column_names_can_be_up_to, MAX_COLUMN_NAME)
            else -> null
        }
    }

    /** 「左へ」 (-1) / 「右へ」 (1): the place to go to, or null when it cannot move that way. */
    fun columnMoveTarget(columns: List<TaskColumnOut>, columnId: String, direction: Int): ColumnPlace? {
        val sorted = sortColumns(columns)
        val index = sorted.indexOfFirst { it.id == columnId }
        if (index < 0) return null
        val to = index + direction
        if (to < 0 || to >= sorted.size) return null
        val rest = sorted.filter { it.id != columnId }
        return ColumnPlace(if (to == 0) null else rest[to - 1].id)
    }

    /** A column's count on the switch: the open ones (a completed column holds only the latest 100: no number). */
    fun columnLabel(column: TaskColumnOut, count: Int): String = column.name + if (column.status != TaskStatus.DONE) " $count" else ""

    /** 「カードは『未着手』へ移ります」: where a deleted column's cards go. */
    fun deleteColumnText(column: TaskColumnOut, columns: List<TaskColumnOut>): String =
        L10n.str(R.string.task_rules_cards_move_to, builtinFor(columns, column.status)?.name ?: label(column.status))

    // --- M84: checklists ---------------------------------------------------------------------------

    /** A card's checklist progress (done, total), or null without one. */
    fun subtaskProgress(task: TaskOut): Pair<Int, Int>? =
        task.subtasks.takeIf { it.isNotEmpty() }?.let { items -> items.count { it.done } to items.size }

    /** 「☑ 2/5」. */
    fun progressText(progress: Pair<Int, Int>): String = "☑ ${progress.first}/${progress.second}"

    /** The checklist as sent (titles cleaned, blank items left out; ids kept). */
    fun subtasksBody(items: List<SubtaskDraft>): List<SubtaskIn> =
        items.map { it.copy(title = cleanTitle(it.title)) }.filter { it.title.isNotEmpty() }.map { SubtaskIn(it.id, it.title.take(MAX_TITLE), it.done) }

    /** ↑ (-1) / ↓ (1): the list with the item at `index` moved one place (unchanged at an end). */
    fun moveSubtask(items: List<SubtaskDraft>, index: Int, direction: Int): List<SubtaskDraft> {
        val to = index + direction
        if (index !in items.indices || to !in items.indices) return items
        return items.toMutableList().also { list -> list[index] = items[to]; list[to] = items[index] }
    }

    /** A task as it is now (an event, an answer): replaces the one held, or joins the list. */
    fun upsert(tasks: List<TaskOut>, task: TaskOut): List<TaskOut> {
        val index = tasks.indexOfFirst { it.id == task.id }
        if (index < 0) return tasks + task
        return tasks.toMutableList().also { it[index] = task }
    }

    fun remove(tasks: List<TaskOut>, taskId: String): List<TaskOut> = tasks.filter { it.id != taskId }

    /** task.updated's task: `can_delete` is `deleter_ids` holding me. */
    fun fromEvent(task: TaskOut, deleterIds: List<String>, me: String?): TaskOut = task.copy(canDelete = me != null && me in deleterIds)

    /** In 「自分のタスク」: personal (only I see them) or assigned to me. */
    fun isMine(task: TaskOut, me: String?): Boolean = task.channelId == null || (me != null && me in task.assigneeIds)

    // --- due dates ---------------------------------------------------------------------------------

    /** Past due while open: a due time once it has passed (M84), a date once the day is over. */
    fun isOverdue(task: TaskOut, today: String, now: Instant = Instant.now()): Boolean =
        task.status != TaskStatus.DONE && overdue(task.dueOn, task.dueAt, today, now)

    private fun overdue(dueOn: String?, dueAt: String?, today: String, now: Instant): Boolean {
        if (dueOn == null) return false
        if (dueAt != null) return runCatching { CalendarDates.instant(dueAt).isBefore(now) }.getOrDefault(false)
        return dueOn < today
    }

    /** M84: the local day a task is due on — a due time's date in the device's zone, else `due_on`. */
    fun dueDay(dueOn: String?, dueAt: String?): String? =
        dueAt?.let { runCatching { CalendarDates.local(it).toLocalDate().toString() }.getOrNull() } ?: dueOn

    /** M84: a card's due — 「今日」 / 「10/9」, with the time (device's zone) when it has one: 「今日 14:00」, 「10/9 14:00」. */
    fun dueText(dueOn: String?, dueAt: String?, today: String): String {
        val day = dueDay(dueOn, dueAt) ?: return ""
        val label = dueLabel(day, today)
        return if (dueAt != null) "$label ${CalendarDates.clock(dueAt)}" else label
    }

    fun dueText(task: TaskOut, today: String): String = dueText(task.dueOn, task.dueAt, today)

    /** A card's due line: 「期限 10/9 14:00」 (a review request's 「希望日 …」). */
    fun cardDueText(task: TaskOut, today: String): String = when (task.kind) {
        TaskKind.REVIEW -> L10n.str(R.string.task_rules_preferred)
        TaskKind.DEADLINE -> L10n.str(R.string.task_rules_deadline)
        else -> L10n.str(R.string.common_due_2)
    } + dueText(task, today)

    private val HHMM: DateTimeFormatter = DateTimeFormatter.ofPattern("HH:mm")

    /** M84: the form's "HH:mm" of a due time (device's zone), "" without one. */
    fun dueTimeOf(dueAt: String?): String = dueAt?.let { runCatching { CalendarDates.local(it).toLocalTime().format(HHMM) }.getOrNull() } ?: ""

    /** M84: the due time as the server takes it — the date and "HH:mm" on the device's wall clock, with its offset. */
    fun dueAtOf(dueOn: String, dueTime: String): String? {
        if (dueOn.isEmpty() || dueTime.isEmpty()) return null
        val day = runCatching { LocalDate.parse(dueOn) }.getOrNull() ?: return null
        val time = runCatching { LocalTime.parse(dueTime) }.getOrNull() ?: return null
        return CalendarDates.isoLocal(day.atTime(time).atZone(CalendarDates.zone()))
    }

    /** A card's due date: 「今日」, else M/D (with the year when not this year's). */
    fun dueLabel(dueOn: String, today: String): String {
        if (dueOn == today) return L10n.str(R.string.common_today)
        val date = runCatching { LocalDate.parse(dueOn) }.getOrNull() ?: return dueOn
        val md = "${date.monthValue}/${date.dayOfMonth}"
        return if (dueOn.take(4) == today.take(4)) md else "${date.year}/$md"
    }

    /** The tasks due on a day (the calendar's rows), open ones first, then (M84) the whole-day ones before the timed ones by time, then by title. */
    fun tasksForDay(tasks: List<TaskOut>, day: String): List<TaskOut> {
        fun time(task: TaskOut): Long = task.dueAt?.let { runCatching { CalendarDates.instant(it).toEpochMilli() }.getOrNull() } ?: Long.MIN_VALUE
        return tasks.filter { it.dueOn == day }.sortedWith { a, b ->
            val done = (a.status == TaskStatus.DONE).compareTo(b.status == TaskStatus.DONE)
            val byTime = time(a).compareTo(time(b))
            when {
                done != 0 -> done
                byTime != 0 -> byTime
                else -> collator.compare(a.title, b.title).takeIf { it != 0 } ?: a.id.compareTo(b.id)
            }
        }
    }

    /** M84: a calendar row's 「☐ 14:00 題名」 time ("" for a whole-day one). */
    fun calendarTime(task: TaskOut): String = task.dueAt?.let { runCatching { CalendarDates.clock(it) }.getOrNull() } ?: ""

    /**
     * The agenda's days (the calendar's 一覧): the days with events, and those of [start, end) with a task due (with no
     * events of their own), in date order.
     */
    fun agendaDays(
        eventDays: List<Pair<LocalDate, List<CalendarEventOut>>>, tasks: List<TaskOut>, start: LocalDate, end: LocalDate,
    ): List<Pair<LocalDate, List<CalendarEventOut>>> {
        val known = eventDays.map { it.first }.toSet()
        val extra = tasks.mapNotNull { task -> task.dueOn?.let { runCatching { LocalDate.parse(it) }.getOrNull() } }
            .filter { !it.isBefore(start) && it.isBefore(end) && it !in known }
            .distinct()
            .map { it to emptyList<CalendarEventOut>() }
        return (eventDays + extra).sortedBy { it.first }
    }

    /** Whether a task is due inside [from, to) (dates; a calendar's window). */
    fun dueInRange(task: TaskOut, from: String, to: String): Boolean = task.dueOn != null && from <= task.dueOn && task.dueOn < to

    // --- permissions -------------------------------------------------------------------------------

    /** Public and private channels have a board; DMs and group DMs do not (TASKS.md §2). */
    fun hasBoard(channel: ChannelOut): Boolean = channel.type == "public" || channel.type == "private"

    /**
     * Whether I may add, change and move a board's cards: the composer's rule (a member, not archived, and in an
     * announcement channel only owners and admins). The server checks it again (403 posting_restricted, 409 channel_archived).
     */
    fun canEditBoard(channel: ChannelState?, isAdmin: Boolean): Boolean =
        channel != null && channel.isMember && hasBoard(channel.channel) && !channel.channel.archived && channel.canPostTopLevel(isAdmin)

    /**
     * L9 (REVIEWS.md §2.1): a DM or group DM whose members may share a task made from one of its messages (no board: such
     * tasks show under the message, in 「自分のタスク」 and in the calendar). Posting limits do not apply to DMs.
     */
    fun canShareInDm(channel: ChannelState?): Boolean = channel != null && channel.channel.isDm && channel.isMember && !channel.channel.archived

    /**
     * A DM with someone besides me: my own DM (only me in `dm_user_ids`) has nobody to share a task with or to ask for a
     * review, so its tasks stay personal (2026-10-09). Unknown members (an older server) count as others.
     */
    fun hasOthers(channel: ChannelState?): Boolean {
        val ids = channel?.channel?.dmUserIds
        return channel == null || channel.channel.type != "dm" || ids == null || ids.toSet().size > 1
    }

    /** L9: 「レビューを依頼」 is offered where a shared task can be made: a board I may add to, or a DM with someone else I am in. */
    fun canRequestReview(channel: ChannelState?, isAdmin: Boolean): Boolean =
        canEditBoard(channel, isAdmin) || (canShareInDm(channel) && hasOthers(channel))

    /** 「タスク」's ＋ (TASKS.md §6): 「自分のタスク」 to start with, the boards I may add to offered beside it (assignees need a board). */
    fun newTaskInit(boards: List<String>): TaskCreateInit = TaskCreateInit(channelId = null, boardChoices = boards)

    /** The boards I may add a task to, by name. */
    fun editableBoards(channels: Collection<ChannelState>, isAdmin: Boolean): List<String> {
        val collator = java.text.Collator.getInstance(java.util.Locale.JAPANESE)
        return channels.filter { canEditBoard(it, isAdmin) }.sortedWith { a, b -> collator.compare(a.channel.name ?: "", b.channel.name ?: "") }.map { it.id }
    }

    /** A task I may change: a personal one always (only I see it), a shared one when I may edit its board (or its DM's). */
    fun canEditTask(task: TaskOut, channel: ChannelState?, isAdmin: Boolean): Boolean =
        task.channelId == null || canEditBoard(channel, isAdmin) || canShareInDm(channel)

    /** The strip over a board: why it cannot be read, or why I cannot change it (null: nothing to say). */
    fun boardNote(unsupported: Boolean, failed: Boolean, channel: ChannelState, canEdit: Boolean): String? = when {
        unsupported -> L10n.str(R.string.common_this_server_doesnt_support_tasks)
        failed -> L10n.str(R.string.common_couldnt_load_tasks_they_will_reload)
        canEdit -> null
        channel.channel.archived -> L10n.str(R.string.task_rules_tasks_in_archived_channels_cant_be)
        !channel.isMember -> null
        else -> L10n.str(R.string.task_rules_only_the_channels_owners_and)
    }

    // --- 「自分のタスク」 --------------------------------------------------------------------------

    /** Open ones by status (todo, doing) then the server's order; completed ones apart, newest first. */
    fun splitOpenDone(tasks: List<TaskOut>): Pair<List<TaskOut>, List<TaskOut>> {
        val open = tasks.filter { it.status != TaskStatus.DONE }.sortedWith(compareBy<TaskOut> { TaskStatus.all.indexOf(it.status) }.then(order))
        val done = tasks.filter { it.status == TaskStatus.DONE }.sortedWith(compareByDescending<TaskOut> { it.completedAt ?: "" }.then(order))
        return open to done
    }

    /** 「自分のタスク」 (personal) and 「自分の担当」 by channel (channels by name). */
    fun groupMineByChannel(tasks: List<TaskOut>, me: String?, channelName: (String) -> String? = { null }): Pair<List<TaskOut>, List<MineGroup>> {
        val personal = tasks.filter { it.channelId == null }
        val byChannel = LinkedHashMap<String, MutableList<TaskOut>>()
        tasks.forEach { task ->
            val channelId = task.channelId ?: return@forEach
            if (me == null || me !in task.assigneeIds) return@forEach
            byChannel.getOrPut(channelId) { ArrayList() } += task
        }
        val groups = byChannel.map { (channelId, list) ->
            MineGroup(channelId, channelName(channelId) ?: list.first().channelName ?: "?", list)
        }.sortedWith { a, b -> collator.compare(a.channelName, b.channelName) }
        return personal to groups
    }

    // --- the form ----------------------------------------------------------------------------------

    fun draftFromTask(task: TaskOut): TaskDraft {
        // M84: a due time's date and time on this device's clock (its zone may differ from the task's `due_tz`).
        val dueOn = dueDay(task.dueOn, task.dueAt) ?: ""
        val start = runCatching { LocalDate.parse(dueOn) }.getOrNull() ?: CalendarDates.today()
        return TaskDraft(
            task.title, task.notes ?: "", task.status, dueOn, task.assigneeIds,
            dueTime = dueTimeOf(task.dueAt),
            repeat = CalendarRecurrence.rruleToRepeat(task.rrule, start),
            subtasks = task.subtasks.map { SubtaskDraft(it.id, it.title, it.done) },
            noticeDays = task.noticeDays?.let { DeadlineRules.normalize(it) } ?: if (task.kind == TaskKind.DEADLINE) emptyList() else null,
        )
    }

    /** M86: the form switched to 締切 (the default notices, no repeat) or back to タスク (the notices dropped). */
    fun asKind(draft: TaskDraft, kind: String): TaskDraft =
        if (kind == TaskKind.DEADLINE) draft.copy(noticeDays = draft.noticeDays ?: DeadlineRules.DEFAULT_NOTICE_DAYS, repeat = draft.repeat.copy(kind = RepeatKind.NONE))
        else draft.copy(noticeDays = null)

    /** M84: what a due date picked in the form does to the rest (before a rule is picked, 毎週's weekday follows the date). */
    fun withDueOn(draft: TaskDraft, dueOn: String): TaskDraft {
        // No due date, nothing to repeat from (the patch sends `rrule: null` with it).
        if (dueOn.isEmpty()) return draft.copy(dueOn = "", dueTime = "", repeat = draft.repeat.copy(kind = RepeatKind.NONE))
        val day = runCatching { LocalDate.parse(dueOn) }.getOrNull() ?: return draft.copy(dueOn = dueOn)
        val repeat = if (draft.repeat.kind == RepeatKind.NONE) CalendarRecurrence.noRepeat(day) else draft.repeat
        return draft.copy(dueOn = dueOn, repeat = repeat)
    }

    /** M84: the rule the form says (null: しない, or no due date to repeat from). */
    fun repeatRule(draft: TaskDraft): String? {
        val day = runCatching { LocalDate.parse(draft.dueOn) }.getOrNull() ?: return null
        return CalendarRecurrence.repeatToRrule(draft.repeat, day)
    }

    /** The title as the server keeps it (whitespace collapsed). */
    fun cleanTitle(title: String): String = title.replace(Regex("\\s+"), " ").trim()

    /** `review`: a review request needs someone to ask (依頼先). M86 `deadline`: a deadline needs its date. */
    fun draftProblem(draft: TaskDraft, review: Boolean = false, deadline: Boolean = false): String? {
        val title = cleanTitle(draft.title)
        return when {
            review && draft.assigneeIds.isEmpty() -> L10n.str(R.string.task_rules_choose_a_reviewer)
            title.isEmpty() -> L10n.str(R.string.common_enter_a_title)
            deadline && draft.dueOn.isEmpty() -> L10n.str(R.string.task_rules_enter_the_deadline_date)
            title.length > MAX_TITLE -> L10n.str(R.string.common_the_title_can_be_up_to, MAX_TITLE)
            draft.notes.length > MAX_NOTES -> L10n.str(R.string.task_rules_notes_can_be_up_to_characters, MAX_NOTES)
            // M84: a rule needs a due date to start from; the checklist's limits are the server's.
            draft.repeat.kind != RepeatKind.NONE && draft.dueOn.isEmpty() -> L10n.str(R.string.task_rules_set_a_due_date_to_repeat)
            subtasksBody(draft.subtasks).size > MAX_SUBTASKS -> L10n.str(R.string.task_rules_up_to_subtasks, MAX_SUBTASKS)
            draft.subtasks.any { cleanTitle(it.title).length > MAX_TITLE } -> L10n.str(R.string.task_rules_subtasks_can_be_up_to_characters, MAX_TITLE)
            else -> runCatching { LocalDate.parse(draft.dueOn) }.getOrNull()?.let { CalendarRecurrence.repeatProblem(draft.repeat, it) }
        }
    }

    /**
     * M84: POST /tasks from the form — the due date, the time (the device's offset; the server takes `due_on` from it), the
     * rule (not for a review request), the checklist (blank items left out), and what was there before (the target, the
     * source, the idempotency key, the zone).
     */
    fun taskCreateBody(
        draft: TaskDraft, channelId: String?, init: TaskCreateInit?, clientId: String, tz: String,
        /** M86: the form's 「タスク / 締切」 (else the init's kind). */
        kind: String = init?.kind ?: TaskKind.TASK,
    ): TaskCreate {
        val review = init?.isReview == true
        // M86 (DEADLINES.md §5): a deadline never repeats, and sends its notices (largest first).
        val deadline = kind == TaskKind.DEADLINE && !review
        val subtasks = subtasksBody(draft.subtasks)
        return TaskCreate(
            channelId = channelId, title = cleanTitle(draft.title), notes = draft.notes.takeIf { it.isNotBlank() },
            status = draft.status, dueOn = draft.dueOn.ifEmpty { null },
            assigneeIds = draft.assigneeIds.distinct().takeIf { channelId != null && it.isNotEmpty() },
            sourceMessageId = init?.sourceMessageId, clientTaskId = clientId, tz = tz,
            kind = if (review) TaskKind.REVIEW else if (deadline) TaskKind.DEADLINE else null,
            sourceCanvasId = init?.sourceCanvasId, sourceCanvasLine = init?.sourceCanvasLine?.takeIf { init.sourceCanvasId != null },
            dueAt = dueAtOf(draft.dueOn, draft.dueTime),
            rrule = if (review || deadline) null else repeatRule(draft),
            subtasks = subtasks.takeIf { it.isNotEmpty() },
            noticeDays = if (deadline) DeadlineRules.normalize(draft.noticeDays ?: DeadlineRules.DEFAULT_NOTICE_DAYS) else null,
        )
    }

    /** PATCH /tasks/{id} with only what changed (`tz` with a new due date: its notification is read in my zone). */
    fun taskPatch(task: TaskOut, draft: TaskDraft, tz: String): TaskUpdate {
        val title = cleanTitle(draft.title).takeIf { it != task.title }
        val notes = draft.notes.takeIf { it.isNotBlank() }
        val notesChanged = notes != task.notes
        val status = draft.status.takeIf { it != task.status }
        val due = draft.dueOn.ifEmpty { null }
        // M84: a due time (its date goes with it), or the whole day (`due_at: null` drops a time, the date kept).
        val dueAt = dueAtOf(draft.dueOn, draft.dueTime)
        var setDueOn = false
        var setDueAt = false
        var sendTz = false
        if (dueAt != null) {
            val same = task.dueAt != null && runCatching { CalendarDates.instant(task.dueAt) == CalendarDates.instant(dueAt) }.getOrDefault(false)
            if (!same) {
                setDueAt = true
                sendTz = true
            }
        } else {
            if (due != dueDay(task.dueOn, task.dueAt)) {
                setDueOn = true
                sendTz = true
            }
            if (due != null && task.dueAt != null) setDueAt = true
        }
        // The rule: compared through the picker (CalendarRecurrence.ruleChanged); no due date stops it.
        val start = due?.let { runCatching { LocalDate.parse(it) }.getOrNull() }
        // M86: a deadline never repeats (the form offers none): nothing to send.
        val deadline = task.kind == TaskKind.DEADLINE
        val ruleChanged = when {
            deadline -> false
            start != null -> CalendarRecurrence.ruleChanged(draft.repeat, start, task.rrule)
            else -> task.rrule != null
        }
        // M86: a deadline's notices, the whole set, only when they changed (largest first).
        val noticeDays = draft.noticeDays?.takeIf { deadline && !DeadlineRules.sameNoticeDays(it, task.noticeDays) }?.let { DeadlineRules.normalize(it) }
        val subtasks = subtasksBody(draft.subtasks).takeIf { body ->
            body.map { Triple(it.id, it.title, it.done) } != task.subtasks.map { Triple(it.id, it.title, it.done) }
        }
        var assignees: List<String>? = null
        if (task.channelId != null) {
            val after = draft.assigneeIds.distinct().sorted()
            if (task.assigneeIds.sorted() != after) assignees = after
        }
        return TaskUpdate(
            title = title, setNotes = notesChanged, notes = notes, status = status, setDueOn = setDueOn, dueOn = due,
            tz = if (sendTz) tz else null, assigneeIds = assignees,
            setDueAt = setDueAt, dueAt = dueAt, setRrule = ruleChanged, rrule = if (ruleChanged) repeatRule(draft) else null,
            subtasks = subtasks, noticeDays = noticeDays,
        )
    }

    /**
     * The message a task came from: a link while the message exists (its excerpt may be null when I can no longer read
     * it), 「元のメッセージは削除されました」 once it is gone, nothing without one.
     */
    fun sourceState(task: TaskOut): TaskSource {
        val source = task.source ?: return TaskSource.None
        val messageId = source.messageId ?: return TaskSource.Deleted
        return TaskSource.Link(messageId, source.excerpt)
    }

    /**
     * M73 (TASKS.md §10): the canvas a task came from — a link while the canvas exists (one in the trash still links; it
     * opens as 「表示できないキャンバス」), 「元のキャンバスは削除されました」 once purged, nothing without one.
     */
    fun canvasSourceState(task: TaskOut): CanvasTaskSource {
        val source = task.canvasSource ?: return CanvasTaskSource.None
        val canvasId = source.canvasId ?: return CanvasTaskSource.Deleted(source.excerpt)
        return CanvasTaskSource.Link(canvasId, source.excerpt)
    }

    /**
     * 「タスクにする」 (TASKS.md §6, §8): the message's one line (the notifications' and the DM list's rule, cut to the
     * title's 200) as the title, the message as the source, and its channel's board — or 「自分のタスク」 for a DM, a group
     * DM, or a board I may not add to.
     */
    fun messageTaskInit(
        messageId: String, body: String, contentTypes: List<String>, channel: ChannelState?, users: Map<String, UserPublic>,
        groups: Map<String, GroupOut>, isAdmin: Boolean,
    ): TaskCreateInit {
        val title = messageLine(body, contentTypes, users, groups, MAX_TITLE)
        val board = channel?.takeIf { canEditBoard(it, isAdmin) }?.id
        return TaskCreateInit(
            channelId = board, title = title, sourceMessageId = messageId, sourceExcerpt = title.ifEmpty { null },
            boardChoices = listOfNotNull(board), dmChannelId = channel?.takeIf { canShareInDm(it) && hasOthers(it) }?.id,
        )
    }

    /**
     * L9 「レビューを依頼」 (REVIEWS.md §2.3): the task form for a review, in the message's conversation (its board, or the
     * DM), titled 「レビュー: <one line>」 (cut to 200). In a 1:1 DM the other person is picked already. Null where no shared
     * task can be made (a board I may not add to, a channel I am not in).
     */
    fun messageReviewInit(
        messageId: String, body: String, contentTypes: List<String>, channel: ChannelState?, users: Map<String, UserPublic>,
        groups: Map<String, GroupOut>, isAdmin: Boolean, me: String?,
    ): TaskCreateInit? {
        if (channel == null || !canRequestReview(channel, isAdmin)) return null
        val line = messageLine(body, contentTypes, users, groups, MAX_TITLE)
        val others = if (channel.channel.isDm) (channel.channel.dmUserIds ?: emptyList()).filter { it != me } else emptyList()
        return TaskCreateInit(
            channelId = channel.id, title = (L10n.str(R.string.task_rules_review, line)).take(MAX_TITLE).trim(), sourceMessageId = messageId,
            sourceExcerpt = line.ifEmpty { null }, boardChoices = listOf(channel.id), kind = TaskKind.REVIEW,
            assigneeIds = others.takeIf { it.size == 1 } ?: emptyList(),
        )
    }

    /** The calendar's filter (すべて / 自分 / a channel) on tasks: 「自分」 is 「自分のタスク」 (personal and assigned to me). */
    fun filterTasks(tasks: List<TaskOut>, filter: String, me: String?): List<TaskOut> = when (filter) {
        CalendarDates.FILTER_ALL -> tasks
        CalendarDates.FILTER_ME -> tasks.filter { isMine(it, me) }
        else -> tasks.filter { it.channelId == filter }
    }

    // --- notices -----------------------------------------------------------------------------------

    /** task.assigned while the app is open, worded like the push (TASKS.md §5). */
    fun assignedText(data: TaskAssigned, nameOf: (String) -> String?): TaskNoticeText {
        val who = nameOf(data.byUserId) ?: L10n.str(R.string.common_member)
        // A DM's task has no channel name to show (L9).
        val where = if (data.channelName.isNotEmpty()) " (#${data.channelName})" else ""
        val what = if (data.kind == TaskKind.REVIEW) L10n.str(R.string.common_review_requested) else L10n.str(R.string.task_rules_assigned_you_a_task)
        return TaskNoticeText(L10n.str(R.string.task_rules_notice, who, what, data.title, where), data.taskId, data.channelId)
    }

    /** L9 task.review_done while the app is open: 「〇〇 がレビューを完了しました: 題名」 (REVIEWS.md §4). */
    fun reviewDoneText(data: TaskReviewDone, nameOf: (String) -> String?): TaskNoticeText =
        TaskNoticeText(L10n.str(R.string.task_rules_review_done, nameOf(data.byUserId) ?: L10n.str(R.string.common_member), data.title), data.taskId, data.channelId)

    /** task.due while the app is open: 「今日が期限: 題名」 (+ the channel for a shared one). */
    fun dueText(data: TaskDue): TaskNoticeText {
        val where = if (data.channelId != null && !data.channelName.isNullOrEmpty()) " (#${data.channelName})" else ""
        // M84: a due time (the notification went out at it): 「14:00 が期限: 題名」.
        val time = data.dueAt?.let { runCatching { CalendarDates.clock(it) }.getOrNull() }
        return TaskNoticeText(if (time != null) L10n.str(R.string.task_rules_due_at, time, data.title, where) else L10n.str(R.string.task_rules_due_today_notice, data.title, where), data.taskId, data.channelId)
    }
}
