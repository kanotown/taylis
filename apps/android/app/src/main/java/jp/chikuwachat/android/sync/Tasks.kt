package jp.chikuwachat.android.sync

import android.util.Log
import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.TaskAssigned
import jp.chikuwachat.android.api.TaskColumnOut
import jp.chikuwachat.android.api.TaskColumnsUpdated
import jp.chikuwachat.android.api.TaskCreate
import jp.chikuwachat.android.api.TaskDeleted
import jp.chikuwachat.android.api.TaskDue
import jp.chikuwachat.android.api.TaskNeighbors
import jp.chikuwachat.android.api.TaskReviewDone
import jp.chikuwachat.android.api.TaskOut
import jp.chikuwachat.android.api.TaskUpdate
import jp.chikuwachat.android.api.TaskUpdated
// The order and move rules are plain list work shared with the screens (TaskRules.kt), as the calendar's CalendarDates.
import jp.chikuwachat.android.ui.CalendarDates
import jp.chikuwachat.android.ui.DeadlineRules
import jp.chikuwachat.android.ui.TaskRules
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import java.time.Instant

/** How a window stands: being read, read, failed (read again on reconnecting), or a server without tasks. */
enum class TaskListState { LOADING, READY, FAILED, UNSUPPORTED }

/** 「自分のタスク」's tasks (unordered: the screens sort). */
data class TaskList(val state: TaskListState, val tasks: List<TaskOut>)

/**
 * A channel's board; `allDone`: every completed card (「完了をすべて表示」), not only the latest 100. M84: `columns`, left
 * to right — TaskRules.FALLBACK_COLUMNS (ids = statuses) until read, or from a server before M81 (`columnsSupported`
 * false: no adding, renaming or moving columns).
 */
data class TaskBoard(
    val channelId: String, val allDone: Boolean, val state: TaskListState, val tasks: List<TaskOut>,
    val columns: List<TaskColumnOut> = TaskRules.FALLBACK_COLUMNS, val columnsSupported: Boolean = false,
)

/** A calendar's range: the tasks due in the dates [from, to). */
data class TaskDueWindow(val from: String, val to: String, val state: TaskListState, val tasks: List<TaskOut>)

/** What task.assigned / task.due say to me (the app shows a notification while open). */
sealed interface TaskNotice {
    data class Assigned(val data: TaskAssigned) : TaskNotice
    data class Due(val data: TaskDue) : TaskNotice
    /** L9: an assignee completed my review request (task.review_done). */
    data class ReviewDone(val data: TaskReviewDone) : TaskNotice
}

/**
 * M56: the tasks on this device (TASKS.md §4, SYNC_PROTOCOL.md §16), as the desktop's src/sync/tasks.ts. Like the calendar,
 * nothing is kept for long: each screen that shows tasks opens a window — a channel's board, 「自分のタスク」, a calendar
 * range — read from the server, and task.* events update the windows they concern (the rest are dropped: the next read
 * has them). After reconnecting every open window is read again, which fills whatever events were missed.
 *
 * Columns are always ordered by the server's `position` (a renumbered column arrives card by card as task.updated), never
 * by a local index. A move shows at once (a guessed position) and is put back when the server refuses it. Runs on the
 * app's main thread (the controller's scope), like the engine's queue.
 */
class TaskHub(
    private val api: TaskApi?,
    private val scope: CoroutineScope,
    /** My user id (`can_delete` is `deleter_ids` holding it; 「自分の担当」 is `assignee_ids` holding it). */
    private val me: () -> String?,
    private val now: () -> String = { Instant.now().toString() },
) {
    private val boards = LinkedHashMap<String, TaskBoard>()
    private var mine: TaskList? = null
    /** L9 「自分が依頼した」 (GET /tasks/requested): open while 「タスク」 is on screen, like [mine]. */
    private var requested: TaskList? = null
    private val due = LinkedHashMap<String, TaskDueWindow>()
    /**
     * M86 (DEADLINES.md §8 1.): my channels' deadlines (GET /tasks/deadlines) — 「締切」 and every conversation header's
     * chip. Opened the first time either shows and kept while the app runs (task.* events keep it, a reconnect and a
     * return to the foreground read it again); UNSUPPORTED from a server before M85.
     */
    private var deadlines: TaskList? = null
    /** A read in flight per window: an older answer never replaces a newer one. */
    private val reads = HashMap<String, Int>()
    private val _version = MutableStateFlow(0)
    /** Bumped by every change: the screens read their windows again. */
    val version: StateFlow<Int> = _version

    /** task.assigned / task.due (the app says so while open: the server's push is not shown then). */
    var onNotice: ((TaskNotice) -> Unit)? = null

    val available: Boolean get() = api != null

    private fun changed() {
        _version.value = _version.value + 1
    }

    fun board(channelId: String): TaskBoard? = boards[channelId]

    fun mineList(): TaskList? = mine

    fun requestedList(): TaskList? = requested

    fun dueWindow(key: String): TaskDueWindow? = due[key]

    fun deadlineList(): TaskList? = deadlines

    // --- windows -----------------------------------------------------------------------------------

    /** A channel's 「タスク」 tab is on screen: read its board. */
    suspend fun openBoard(channelId: String, allDone: Boolean = false) {
        val current = boards[channelId]
        if (current != null && current.state == TaskListState.READY && current.allDone == allDone) return
        boards[channelId] = TaskBoard(
            channelId, allDone, TaskListState.LOADING, current?.tasks ?: emptyList(),
            current?.columns ?: TaskRules.FALLBACK_COLUMNS, current?.columnsSupported ?: false,
        )
        changed()
        readBoard(channelId)
    }

    fun closeBoard(channelId: String) {
        if (boards.remove(channelId) != null) changed()
    }

    suspend fun openMine() {
        if (mine?.state == TaskListState.READY) return
        mine = TaskList(TaskListState.LOADING, mine?.tasks ?: emptyList())
        changed()
        readMine()
    }

    fun closeMine() {
        if (mine == null) return
        mine = null
        changed()
    }

    /** L9: 「自分が依頼した」 is on screen (beside 「自分のタスク」). */
    suspend fun openRequested() {
        if (requested?.state == TaskListState.READY) return
        requested = TaskList(TaskListState.LOADING, requested?.tasks ?: emptyList())
        changed()
        readRequested()
    }

    fun closeRequested() {
        if (requested == null) return
        requested = null
        changed()
    }

    /** A calendar shows the dates [from, to): the tasks due then. */
    suspend fun openDue(key: String, from: String, to: String) {
        val current = due[key]
        val same = current != null && current.from == from && current.to == to
        if (same && current!!.state == TaskListState.READY) return
        due[key] = TaskDueWindow(from, to, TaskListState.LOADING, if (same) current!!.tasks else emptyList())
        changed()
        readDue(key)
    }

    fun closeDue(key: String) {
        if (due.remove(key) != null) changed()
    }

    /** M86: 「締切」 or a header chip is on screen: read the deadlines once (again only after a failure). */
    suspend fun openDeadlines() {
        val current = deadlines
        if (current != null && current.state != TaskListState.FAILED) return
        deadlines = TaskList(TaskListState.LOADING, current?.tasks ?: emptyList())
        changed()
        readDeadlines()
    }

    /** M86: back in the foreground — the deadlines read again (the socket may have stayed up while events were missed). */
    fun refreshDeadlines() {
        if (api == null || deadlines == null) return
        scope.launch { readDeadlines() }
    }

    private fun ticket(key: String): Int = ((reads[key] ?: 0) + 1).also { reads[key] = it }

    private fun failure(e: Exception): TaskListState {
        Log.w("TaskHub", "could not read the tasks", e)
        return if (serverLacksTasks(e)) TaskListState.UNSUPPORTED else TaskListState.FAILED
    }

    private suspend fun readBoard(channelId: String) {
        val api = api ?: return
        val board = boards[channelId] ?: return
        val key = "board:$channelId"
        val ticket = ticket(key)
        try {
            val tasks = api.listTasks(channelId, if (board.allDone) "all" else "recent")
            val columns = readColumns(channelId)
            val now = boards[channelId]
            if (reads[key] != ticket || now == null) return
            boards[channelId] = now.copy(
                state = TaskListState.READY, tasks = tasks, columns = columns ?: TaskRules.FALLBACK_COLUMNS, columnsSupported = columns != null,
            )
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            val now = boards[channelId]
            if (reads[key] != ticket || now == null) return
            boards[channelId] = now.copy(state = failure(e))
        }
        changed()
    }

    /** M84: a board's columns; null from a server before M81 (no route: 404, or 422 with "columns" read as a task id) or a fake. */
    private suspend fun readColumns(channelId: String): List<TaskColumnOut>? {
        val api = api ?: return null
        return try {
            api.listTaskColumns(channelId)?.let { TaskRules.sortColumns(it) }?.takeIf { it.isNotEmpty() }
        } catch (e: ApiException.Api) {
            if (e.status == 404 || e.status == 422) null else throw e
        }
    }

    private suspend fun readMine() {
        val api = api ?: return
        if (mine == null) return
        val ticket = ticket(MINE)
        try {
            val tasks = api.myTasks()
            if (reads[MINE] != ticket || mine == null) return
            mine = TaskList(TaskListState.READY, tasks)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            val now = mine
            if (reads[MINE] != ticket || now == null) return
            mine = now.copy(state = failure(e))
        }
        changed()
    }

    private suspend fun readRequested() {
        val api = api ?: return
        if (requested == null) return
        val ticket = ticket(REQUESTED)
        try {
            val tasks = api.requestedTasks()
            if (reads[REQUESTED] != ticket || requested == null) return
            requested = TaskList(TaskListState.READY, tasks)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            val now = requested
            if (reads[REQUESTED] != ticket || now == null) return
            requested = now.copy(state = failure(e))
        }
        changed()
    }

    private suspend fun readDeadlines() {
        val api = api ?: return
        if (deadlines == null) return
        val ticket = ticket(DEADLINES)
        try {
            val tasks = api.deadlineTasks()
            val now = deadlines
            if (reads[DEADLINES] != ticket || now == null) return
            deadlines = if (tasks == null) now.copy(state = TaskListState.UNSUPPORTED) else TaskList(TaskListState.READY, tasks)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            val now = deadlines
            if (reads[DEADLINES] != ticket || now == null) return
            // Before M85 the route is /tasks/{task_id}: "deadlines" is no task id (422); 404 from an older one still.
            val old = e is ApiException.Api && (e.status == 404 || e.status == 422)
            deadlines = now.copy(state = if (old) TaskListState.UNSUPPORTED else failure(e))
        }
        changed()
    }

    private suspend fun readDue(key: String) {
        val api = api ?: return
        val window = due[key] ?: return
        val readKey = "due:$key"
        val ticket = ticket(readKey)
        try {
            val tasks = api.dueTasks(window.from, window.to)
            val now = due[key]
            if (reads[readKey] != ticket || now == null || now.from != window.from || now.to != window.to) return
            due[key] = now.copy(state = TaskListState.READY, tasks = tasks)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            val now = due[key]
            if (reads[readKey] != ticket || now == null) return
            due[key] = now.copy(state = failure(e))
        }
        changed()
    }

    // --- changes made here -------------------------------------------------------------------------

    suspend fun create(body: TaskCreate): TaskOut = requireApi().createTask(body).also { put(it) }

    suspend fun update(taskId: String, patch: TaskUpdate): TaskOut = requireApi().updateTask(taskId, patch).also { put(it) }

    /**
     * Into `status` between `neighbors`: shown at once at a guessed place, then where the server put it. A refusal puts the
     * card back and throws (the screen says why).
     */
    suspend fun move(taskId: String, status: String, neighbors: TaskNeighbors, column: TaskColumnOut? = null): TaskOut {
        val api = requireApi()
        val before = find(taskId)
        val into = column?.takeIf { it.status == status }
        if (before != null) putLocalMove(before, status, neighbors, into)
        try {
            // M84: into a column of the board by its id; a fallback column (id = its status, an older server) by the status.
            val moved = if (into != null && into.id != into.status) api.moveTaskToColumn(taskId, into.id, neighbors) else api.moveTask(taskId, status, neighbors)
            return moved.also { put(it) }
        } catch (e: Exception) {
            if (before != null) put(before) // unless a newer copy came meanwhile
            throw e
        }
    }

    private fun putLocalMove(task: TaskOut, status: String, neighbors: TaskNeighbors, into: TaskColumnOut?) {
        // The guess is made among the cards of the window that holds the task (its board, else 「自分のタスク」).
        val pool = task.channelId?.let { boards[it]?.tasks } ?: mine?.tasks ?: requested?.tasks ?: listOf(task)
        val moved = TaskRules.applyLocalMove(if (pool.any { it.id == task.id }) pool else pool + task, task.id, status, neighbors, now(), me(), into)
        moved.firstOrNull { it.id == task.id }?.let { put(it) }
    }

    /**
     * M84: one checklist item's checkbox, at once (PATCH /tasks/{id}/subtasks/{sid}): shown before the answer, put back
     * when refused (and thrown: the screen says why).
     */
    suspend fun toggleSubtask(taskId: String, subtaskId: String, done: Boolean): TaskOut {
        val api = requireApi()
        val before = find(taskId)
        if (before != null) put(before.copy(subtasks = before.subtasks.map { if (it.id == subtaskId) it.copy(done = done) else it }))
        try {
            return api.updateSubtask(taskId, subtaskId, done).also { put(it) }
        } catch (e: Exception) {
            if (before != null) put(before)
            throw e
        }
    }

    // --- M84: a board's columns (TASKS.md §11.3, §11.5) --------------------------------------------

    /** A new column of `status` at the right end. */
    suspend fun addColumn(channelId: String, name: String, status: String): TaskColumnOut =
        requireApi().createTaskColumn(channelId, name, status).also { refreshColumns(channelId) }

    suspend fun renameColumn(channelId: String, columnId: String, name: String) {
        requireApi().updateTaskColumn(columnId, name = name)
        refreshColumns(channelId)
    }

    /** 「左へ」 / 「右へ」: right of `place.afterId` (null: the left end). */
    suspend fun moveColumn(channelId: String, columnId: String, place: jp.chikuwachat.android.ui.ColumnPlace) {
        requireApi().updateTaskColumn(columnId, move = true, afterId = place.afterId)
        refreshColumns(channelId)
    }

    /** An added column; its cards come back (task.updated) in the built-in column of their status. */
    suspend fun removeColumn(channelId: String, columnId: String) {
        requireApi().deleteTaskColumn(columnId)
        refreshColumns(channelId)
    }

    /** After my own change (task.columns.updated comes too; whichever lands last is the same list). */
    private suspend fun refreshColumns(channelId: String) {
        if (!boards.containsKey(channelId)) return
        val columns = readColumns(channelId) ?: return
        val board = boards[channelId] ?: return
        boards[channelId] = board.copy(columns = columns, columnsSupported = true)
        changed()
    }

    suspend fun remove(taskId: String) {
        requireApi().deleteTask(taskId)
        drop(taskId)
    }

    /** The task as held here, else read (a notification, a calendar row outside every window). */
    suspend fun load(taskId: String): TaskOut = find(taskId) ?: requireApi().getTask(taskId)

    private fun requireApi(): TaskApi = api ?: throw IllegalStateException("Tasks are not available")

    // --- events (§4) -------------------------------------------------------------------------------

    fun applyEvent(event: String, data: JsonObject) {
        when (event) {
            "task.updated" -> {
                val update = decode { Codec.snake.decodeFromJsonElement(TaskUpdated.serializer(), data) } ?: return
                put(TaskRules.fromEvent(update.task, update.deleterIds, me()))
            }
            "task.deleted" -> decode { Codec.snake.decodeFromJsonElement(TaskDeleted.serializer(), data) }?.let { drop(it.id) }
            "task.assigned" -> decode { Codec.snake.decodeFromJsonElement(TaskAssigned.serializer(), data) }?.let { onNotice?.invoke(TaskNotice.Assigned(it)) }
            "task.due" -> decode { Codec.snake.decodeFromJsonElement(TaskDue.serializer(), data) }?.let { onNotice?.invoke(TaskNotice.Due(it)) }
            "task.review_done" -> decode { Codec.snake.decodeFromJsonElement(TaskReviewDone.serializer(), data) }?.let { onNotice?.invoke(TaskNotice.ReviewDone(it)) }
            // M84: a board's columns, all of them (only an open board keeps them; the next read has them otherwise).
            "task.columns.updated" -> decode { Codec.snake.decodeFromJsonElement(TaskColumnsUpdated.serializer(), data) }?.let { update ->
                val board = boards[update.channelId] ?: return@let
                if (update.columns.isEmpty()) return@let
                boards[update.channelId] = board.copy(columns = TaskRules.sortColumns(update.columns), columnsSupported = true)
                changed()
            }
        }
    }

    private fun <T> decode(block: () -> T): T? = runCatching(block).onFailure { Log.w("TaskHub", "unreadable task event", it) }.getOrNull()

    /**
     * A task as it is now, into every window it belongs to (out of those it left): its board, 「自分のタスク」 when personal or
     * assigned to me, a calendar range holding its due date. An older copy (updated_at) never replaces a newer one (the
     * optimistic copy keeps the held updated_at, so the server's answer or a refusal's undo replaces it).
     */
    fun put(task: TaskOut) {
        fun newer(list: List<TaskOut>): Boolean {
            val held = list.firstOrNull { it.id == task.id } ?: return true
            return held.updatedAt <= task.updatedAt
        }
        task.channelId?.let { channelId ->
            val board = boards[channelId]
            if (board != null && newer(board.tasks)) boards[channelId] = board.copy(tasks = TaskRules.upsert(board.tasks, task))
        }
        mine?.let { list ->
            if (newer(list.tasks)) {
                mine = list.copy(tasks = if (TaskRules.isMine(task, me())) TaskRules.upsert(list.tasks, task) else TaskRules.remove(list.tasks, task.id))
            }
        }
        requested?.let { list ->
            if (newer(list.tasks)) {
                requested = list.copy(tasks = if (TaskRules.isRequested(task, me())) TaskRules.upsert(list.tasks, task) else TaskRules.remove(list.tasks, task.id))
            }
        }
        for ((key, window) in due.entries.toList()) {
            if (!newer(window.tasks)) continue
            val fits = TaskRules.dueInRange(task, window.from, window.to)
            if (!fits && window.tasks.none { it.id == task.id }) continue
            due[key] = window.copy(tasks = if (fits) TaskRules.upsert(window.tasks, task) else TaskRules.remove(window.tasks, task.id))
        }
        // M86: a deadline due from 30 days ago on joins; one no longer a deadline (or older) leaves.
        deadlines?.let { list ->
            if (!newer(list.tasks)) return@let
            val fits = DeadlineRules.inWindow(task, today())
            if (fits || list.tasks.any { it.id == task.id }) {
                deadlines = list.copy(tasks = if (fits) TaskRules.upsert(list.tasks, task) else TaskRules.remove(list.tasks, task.id))
            }
        }
        changed()
    }

    private fun drop(taskId: String) {
        for ((channelId, board) in boards.entries.toList()) {
            if (board.tasks.any { it.id == taskId }) boards[channelId] = board.copy(tasks = TaskRules.remove(board.tasks, taskId))
        }
        mine?.let { list -> if (list.tasks.any { it.id == taskId }) mine = list.copy(tasks = TaskRules.remove(list.tasks, taskId)) }
        requested?.let { list -> if (list.tasks.any { it.id == taskId }) requested = list.copy(tasks = TaskRules.remove(list.tasks, taskId)) }
        for ((key, window) in due.entries.toList()) {
            if (window.tasks.any { it.id == taskId }) due[key] = window.copy(tasks = TaskRules.remove(window.tasks, taskId))
        }
        deadlines?.let { list -> if (list.tasks.any { it.id == taskId }) deadlines = list.copy(tasks = TaskRules.remove(list.tasks, taskId)) }
        changed()
    }

    fun find(taskId: String): TaskOut? =
        boards.values.firstNotNullOfOrNull { board -> board.tasks.firstOrNull { it.id == taskId } }
            ?: mine?.tasks?.firstOrNull { it.id == taskId }
            ?: requested?.tasks?.firstOrNull { it.id == taskId }
            ?: due.values.firstNotNullOfOrNull { window -> window.tasks.firstOrNull { it.id == taskId } }
            ?: deadlines?.tasks?.firstOrNull { it.id == taskId }

    /** This device's day of [now] ("YYYY-MM-DD"). */
    private fun today(): String = runCatching { CalendarDates.local(now()).toLocalDate().toString() }.getOrElse { CalendarDates.today().toString() }

    // --- lifecycle ---------------------------------------------------------------------------------

    /** After (re)connecting: every open window is read again (events missed while away, §4). */
    fun online() {
        if (api == null) return
        boards.keys.toList().forEach { channelId -> scope.launch { readBoard(channelId) } }
        if (mine != null) scope.launch { readMine() }
        if (requested != null) scope.launch { readRequested() }
        due.keys.toList().forEach { key -> scope.launch { readDue(key) } }
        if (deadlines != null) scope.launch { readDeadlines() }
    }

    /** I left the channel (or was removed): its board closes and its tasks leave the other windows. */
    fun removeChannel(channelId: String) {
        boards.remove(channelId)
        mine?.let { list -> mine = list.copy(tasks = list.tasks.filter { it.channelId != channelId }) }
        requested?.let { list -> requested = list.copy(tasks = list.tasks.filter { it.channelId != channelId }) }
        for ((key, window) in due.entries.toList()) due[key] = window.copy(tasks = window.tasks.filter { it.channelId != channelId })
        deadlines?.let { list -> deadlines = list.copy(tasks = list.tasks.filter { it.channelId != channelId }) }
        changed()
    }

    fun stop() {
        boards.clear()
        mine = null
        requested = null
        due.clear()
        deadlines = null
        changed()
    }

    companion object {
        private const val MINE = "mine"
        private const val REQUESTED = "requested"
        private const val DEADLINES = "deadlines"

        /** A server from before M55 has no such route (404 not_found): trying again cannot help until it is updated. */
        fun serverLacksTasks(e: Throwable): Boolean = e is ApiException.Api && e.status == 404 && (e.code == "not_found" || e.code == "http_404")
    }
}
