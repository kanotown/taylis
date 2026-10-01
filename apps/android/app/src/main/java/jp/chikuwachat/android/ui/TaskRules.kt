package jp.chikuwachat.android.ui

import jp.chikuwachat.android.api.CalendarEventOut
import jp.chikuwachat.android.api.ChannelOut
import jp.chikuwachat.android.api.GroupOut
import jp.chikuwachat.android.api.TaskAssigned
import jp.chikuwachat.android.api.TaskDue
import jp.chikuwachat.android.api.TaskNeighbors
import jp.chikuwachat.android.api.TaskOut
import jp.chikuwachat.android.api.TaskStatus
import jp.chikuwachat.android.api.TaskUpdate
import jp.chikuwachat.android.api.UserPublic
import jp.chikuwachat.android.sync.ChannelState
import java.text.Collator
import java.time.LocalDate
import java.util.Locale

/** The task form's fields (TASKS.md §6). `dueOn` "" = none. */
data class TaskDraft(
    val title: String,
    val notes: String = "",
    val status: String = TaskStatus.TODO,
    val dueOn: String = "",
    val assigneeIds: List<String> = emptyList(),
)

/**
 * What the form starts a new task with. `channelId` null: 「自分のタスク」. 「タスクにする」 adds the message, its one-line
 * excerpt, and the boards offered besides 「自分のタスク」 (its channel's when I may add to it; none from a DM).
 */
data class TaskCreateInit(
    val channelId: String?,
    val status: String = TaskStatus.TODO,
    val title: String = "",
    val sourceMessageId: String? = null,
    val sourceExcerpt: String? = null,
    val boardChoices: List<String> = emptyList(),
)

/** What a task says of the message it came from. */
sealed interface TaskSource {
    data object None : TaskSource
    /** 「元のメッセージは削除されました」. */
    data object Deleted : TaskSource
    data class Link(val messageId: String, val excerpt: String?) : TaskSource
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
    val STATUS_LABELS: Map<String, String> = mapOf(TaskStatus.TODO to "未着手", TaskStatus.DOING to "進行中", TaskStatus.DONE to "完了")
    const val MAX_TITLE = 200
    const val MAX_NOTES = 4000
    /** A board brings this many completed cards (then 「完了をすべて表示」 reads them all). */
    const val BOARD_DONE_LIMIT = 100
    /** Avatars on a card before 「+N」. */
    const val CARD_AVATARS = 3

    private val collator: Collator = Collator.getInstance(Locale.JAPANESE)

    fun label(status: String): String = STATUS_LABELS[status] ?: status

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

    /** The optimistic move: the card in its new column at its guessed position (completion as the server would set it). */
    fun applyLocalMove(tasks: List<TaskOut>, taskId: String, status: String, neighbors: TaskNeighbors, now: String, me: String?): List<TaskOut> {
        val task = tasks.firstOrNull { it.id == taskId } ?: return tasks
        val position = guessPosition(tasks, taskId, status, neighbors)
        val moved = when {
            status == task.status -> task.copy(position = position)
            status == TaskStatus.DONE -> task.copy(status = status, position = position, completedAt = now, completedBy = me)
            else -> task.copy(status = status, position = position, completedAt = null, completedBy = null)
        }
        return tasks.map { if (it.id == taskId) moved else it }
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

    fun isOverdue(task: TaskOut, today: String): Boolean = task.dueOn != null && task.status != TaskStatus.DONE && task.dueOn < today

    /** A card's due date: 「今日」, else M/D (with the year when not this year's). */
    fun dueLabel(dueOn: String, today: String): String {
        if (dueOn == today) return "今日"
        val date = runCatching { LocalDate.parse(dueOn) }.getOrNull() ?: return dueOn
        val md = "${date.monthValue}/${date.dayOfMonth}"
        return if (dueOn.take(4) == today.take(4)) md else "${date.year}/$md"
    }

    /** The tasks due on a day (the calendar's rows), open ones first, then by title. */
    fun tasksForDay(tasks: List<TaskOut>, day: String): List<TaskOut> =
        tasks.filter { it.dueOn == day }.sortedWith { a, b ->
            val done = (a.status == TaskStatus.DONE).compareTo(b.status == TaskStatus.DONE)
            if (done != 0) done else collator.compare(a.title, b.title).takeIf { it != 0 } ?: a.id.compareTo(b.id)
        }

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

    /** A task I may change: a personal one always (only I see it), a shared one when I may edit its board. */
    fun canEditTask(task: TaskOut, channel: ChannelState?, isAdmin: Boolean): Boolean = task.channelId == null || canEditBoard(channel, isAdmin)

    /** The strip over a board: why it cannot be read, or why I cannot change it (null: nothing to say). */
    fun boardNote(unsupported: Boolean, failed: Boolean, channel: ChannelState, canEdit: Boolean): String? = when {
        unsupported -> "このサーバはタスクに対応していません"
        failed -> "タスクを読み込めませんでした。再接続すると読み直します"
        canEdit -> null
        channel.channel.archived -> "アーカイブされたチャンネルのタスクは変更できません"
        !channel.isMember -> null
        else -> "このボードを変更できるのは、チャンネルのオーナーと管理者だけです"
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

    fun draftFromTask(task: TaskOut): TaskDraft = TaskDraft(task.title, task.notes ?: "", task.status, task.dueOn ?: "", task.assigneeIds)

    /** The title as the server keeps it (whitespace collapsed). */
    fun cleanTitle(title: String): String = title.replace(Regex("\\s+"), " ").trim()

    fun draftProblem(draft: TaskDraft): String? {
        val title = cleanTitle(draft.title)
        return when {
            title.isEmpty() -> "題名を入れてください"
            title.length > MAX_TITLE -> "題名は $MAX_TITLE 文字までです"
            draft.notes.length > MAX_NOTES -> "メモは $MAX_NOTES 文字までです"
            else -> null
        }
    }

    /** PATCH /tasks/{id} with only what changed (`tz` with a new due date: its notification is read in my zone). */
    fun taskPatch(task: TaskOut, draft: TaskDraft, tz: String): TaskUpdate {
        val title = cleanTitle(draft.title).takeIf { it != task.title }
        val notes = draft.notes.takeIf { it.isNotBlank() }
        val notesChanged = notes != task.notes
        val status = draft.status.takeIf { it != task.status }
        val due = draft.dueOn.ifEmpty { null }
        val dueChanged = due != task.dueOn
        var assignees: List<String>? = null
        if (task.channelId != null) {
            val after = draft.assigneeIds.distinct().sorted()
            if (task.assigneeIds.sorted() != after) assignees = after
        }
        return TaskUpdate(
            title = title, setNotes = notesChanged, notes = notes, status = status, setDueOn = dueChanged, dueOn = due,
            tz = if (dueChanged) tz else null, assigneeIds = assignees,
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
            boardChoices = listOfNotNull(board),
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
    fun assignedText(data: TaskAssigned, nameOf: (String) -> String?): TaskNoticeText =
        TaskNoticeText("${nameOf(data.byUserId) ?: "メンバー"} がタスクを割り当てました: ${data.title} (#${data.channelName})", data.taskId, data.channelId)

    /** task.due while the app is open: 「今日が期限: 題名」 (+ the channel for a shared one). */
    fun dueText(data: TaskDue): TaskNoticeText {
        val where = if (data.channelId != null && !data.channelName.isNullOrEmpty()) " (#${data.channelName})" else ""
        return TaskNoticeText("今日が期限: ${data.title}$where", data.taskId, data.channelId)
    }
}
