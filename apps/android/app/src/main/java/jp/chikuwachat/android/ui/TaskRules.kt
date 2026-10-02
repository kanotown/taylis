package jp.chikuwachat.android.ui

import jp.chikuwachat.android.api.CalendarEventOut
import jp.chikuwachat.android.api.ChannelOut
import jp.chikuwachat.android.api.GroupOut
import jp.chikuwachat.android.api.MessageTaskOut
import jp.chikuwachat.android.api.TaskAssigned
import jp.chikuwachat.android.api.TaskDue
import jp.chikuwachat.android.api.TaskKind
import jp.chikuwachat.android.api.TaskNeighbors
import jp.chikuwachat.android.api.TaskOut
import jp.chikuwachat.android.api.TaskReviewDone
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
    val STATUS_LABELS: Map<String, String> = mapOf(TaskStatus.TODO to "未着手", TaskStatus.DOING to "進行中", TaskStatus.DONE to "完了")
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
    val REVIEW_LABELS: Map<String, String> = mapOf(TaskStatus.TODO to "依頼中", TaskStatus.DOING to "対応中", TaskStatus.DONE to "完了")

    /** A status in its kind's words (a review: 依頼中 / 対応中 / 完了; a task: 未着手 / 進行中 / 完了). */
    fun label(kind: String, status: String): String = if (kind == TaskKind.REVIEW) REVIEW_LABELS[status] ?: status else label(status)

    /** The chip's first word: 「レビュー依頼」 or 「タスク」. */
    fun kindLabel(kind: String): String = if (kind == TaskKind.REVIEW) "レビュー依頼" else "タスク"

    /** Names on a chip before 「ほか N 人」. */
    const val CHIP_NAMES = 2

    /**
     * The chip of a task made from a message: its kind, the assignees (2 names, then 「ほか N 人」; none: left out), the state
     * in its kind's words, and the due date (「10/9 まで」, 「今日まで」) while not done. Done is grey; open past its due date red.
     */
    fun chip(task: MessageTaskOut, today: String, nameOf: (String) -> String?): TaskChip {
        val names = task.assigneeIds.take(CHIP_NAMES).map { nameOf(it) ?: "?" }
        val rest = task.assigneeIds.size - names.size
        val who = names.joinToString("、") + if (rest > 0) " ほか $rest 人" else ""
        val done = task.status == TaskStatus.DONE
        val parts = buildList {
            add(kindLabel(task.kind))
            if (who.isNotEmpty()) add(who)
            add(label(task.kind, task.status))
            if (!done) task.dueOn?.let { dueLabel(it, today).let { day -> add(if (day == "今日") "今日まで" else "$day まで") } }
        }
        val overdue = !done && task.dueOn != null && task.dueOn < today
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

    fun quickLabel(status: String): String = if (status == TaskStatus.DOING) "対応を始める" else "完了にする"

    /** 「自分が依頼した」: a shared task I made with someone else assigned (the server's GET /tasks/requested rule). */
    fun isRequested(task: TaskOut, me: String?): Boolean =
        me != null && task.channelId != null && task.ownerId == me && task.assigneeIds.any { it != me }

    /**
     * Where a task lives, as a card's line says it: 「自分のタスク」, 「#lab」, or (L9) for a DM's task, which has no channel
     * name, the other people of that DM (`dmTitle`; 「DM」 when not known here).
     */
    fun placeLabel(task: TaskOut, dmTitle: (String) -> String? = { null }): String {
        val channelId = task.channelId ?: return "自分のタスク"
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

    /**
     * L9 (REVIEWS.md §2.1): a DM or group DM whose members may share a task made from one of its messages (no board: such
     * tasks show under the message, in 「自分のタスク」 and in the calendar). Posting limits do not apply to DMs.
     */
    fun canShareInDm(channel: ChannelState?): Boolean = channel != null && channel.channel.isDm && channel.isMember && !channel.channel.archived

    /** L9: 「レビューを依頼」 is offered where a shared task can be made: a board I may add to, or a DM I am in. */
    fun canRequestReview(channel: ChannelState?, isAdmin: Boolean): Boolean = canEditBoard(channel, isAdmin) || canShareInDm(channel)

    /** A task I may change: a personal one always (only I see it), a shared one when I may edit its board (or its DM's). */
    fun canEditTask(task: TaskOut, channel: ChannelState?, isAdmin: Boolean): Boolean =
        task.channelId == null || canEditBoard(channel, isAdmin) || canShareInDm(channel)

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

    /** `review`: a review request needs someone to ask (依頼先). */
    fun draftProblem(draft: TaskDraft, review: Boolean = false): String? {
        val title = cleanTitle(draft.title)
        return when {
            review && draft.assigneeIds.isEmpty() -> "依頼先を選んでください"
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
            boardChoices = listOfNotNull(board), dmChannelId = channel?.takeIf { canShareInDm(it) }?.id,
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
            channelId = channel.id, title = ("レビュー: $line").take(MAX_TITLE).trim(), sourceMessageId = messageId,
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
        val who = nameOf(data.byUserId) ?: "メンバー"
        // A DM's task has no channel name to show (L9).
        val where = if (data.channelName.isNotEmpty()) " (#${data.channelName})" else ""
        val what = if (data.kind == TaskKind.REVIEW) "レビューを依頼しました" else "タスクを割り当てました"
        return TaskNoticeText("$who が$what: ${data.title}$where", data.taskId, data.channelId)
    }

    /** L9 task.review_done while the app is open: 「〇〇 がレビューを完了しました: 題名」 (REVIEWS.md §4). */
    fun reviewDoneText(data: TaskReviewDone, nameOf: (String) -> String?): TaskNoticeText =
        TaskNoticeText("${nameOf(data.byUserId) ?: "メンバー"} がレビューを完了しました: ${data.title}", data.taskId, data.channelId)

    /** task.due while the app is open: 「今日が期限: 題名」 (+ the channel for a shared one). */
    fun dueText(data: TaskDue): TaskNoticeText {
        val where = if (data.channelId != null && !data.channelName.isNullOrEmpty()) " (#${data.channelName})" else ""
        return TaskNoticeText("今日が期限: ${data.title}$where", data.taskId, data.channelId)
    }
}
