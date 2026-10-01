package jp.chikuwachat.android.sync

import android.util.Log
import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.TaskAssigned
import jp.chikuwachat.android.api.TaskCreate
import jp.chikuwachat.android.api.TaskDeleted
import jp.chikuwachat.android.api.TaskDue
import jp.chikuwachat.android.api.TaskNeighbors
import jp.chikuwachat.android.api.TaskOut
import jp.chikuwachat.android.api.TaskUpdate
import jp.chikuwachat.android.api.TaskUpdated
// The order and move rules are plain list work shared with the screens (TaskRules.kt), as the calendar's CalendarDates.
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

/** A channel's board; `allDone`: every completed card (「完了をすべて表示」), not only the latest 100. */
data class TaskBoard(val channelId: String, val allDone: Boolean, val state: TaskListState, val tasks: List<TaskOut>)

/** A calendar's range: the tasks due in the dates [from, to). */
data class TaskDueWindow(val from: String, val to: String, val state: TaskListState, val tasks: List<TaskOut>)

/** What task.assigned / task.due say to me (the app shows a notification while open). */
sealed interface TaskNotice {
    data class Assigned(val data: TaskAssigned) : TaskNotice
    data class Due(val data: TaskDue) : TaskNotice
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
    private val due = LinkedHashMap<String, TaskDueWindow>()
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

    fun dueWindow(key: String): TaskDueWindow? = due[key]

    // --- windows -----------------------------------------------------------------------------------

    /** A channel's 「タスク」 tab is on screen: read its board. */
    suspend fun openBoard(channelId: String, allDone: Boolean = false) {
        val current = boards[channelId]
        if (current != null && current.state == TaskListState.READY && current.allDone == allDone) return
        boards[channelId] = TaskBoard(channelId, allDone, TaskListState.LOADING, current?.tasks ?: emptyList())
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
            val now = boards[channelId]
            if (reads[key] != ticket || now == null) return
            boards[channelId] = now.copy(state = TaskListState.READY, tasks = tasks)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            val now = boards[channelId]
            if (reads[key] != ticket || now == null) return
            boards[channelId] = now.copy(state = failure(e))
        }
        changed()
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
    suspend fun move(taskId: String, status: String, neighbors: TaskNeighbors): TaskOut {
        val api = requireApi()
        val before = find(taskId)
        if (before != null) putLocalMove(before, status, neighbors)
        try {
            return api.moveTask(taskId, status, neighbors).also { put(it) }
        } catch (e: Exception) {
            if (before != null) put(before) // unless a newer copy came meanwhile
            throw e
        }
    }

    private fun putLocalMove(task: TaskOut, status: String, neighbors: TaskNeighbors) {
        // The guess is made among the cards of the window that holds the task (its board, else 「自分のタスク」).
        val pool = task.channelId?.let { boards[it]?.tasks } ?: mine?.tasks ?: listOf(task)
        val moved = TaskRules.applyLocalMove(if (pool.any { it.id == task.id }) pool else pool + task, task.id, status, neighbors, now(), me())
        moved.firstOrNull { it.id == task.id }?.let { put(it) }
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
        for ((key, window) in due.entries.toList()) {
            if (!newer(window.tasks)) continue
            val fits = TaskRules.dueInRange(task, window.from, window.to)
            if (!fits && window.tasks.none { it.id == task.id }) continue
            due[key] = window.copy(tasks = if (fits) TaskRules.upsert(window.tasks, task) else TaskRules.remove(window.tasks, task.id))
        }
        changed()
    }

    private fun drop(taskId: String) {
        for ((channelId, board) in boards.entries.toList()) {
            if (board.tasks.any { it.id == taskId }) boards[channelId] = board.copy(tasks = TaskRules.remove(board.tasks, taskId))
        }
        mine?.let { list -> if (list.tasks.any { it.id == taskId }) mine = list.copy(tasks = TaskRules.remove(list.tasks, taskId)) }
        for ((key, window) in due.entries.toList()) {
            if (window.tasks.any { it.id == taskId }) due[key] = window.copy(tasks = TaskRules.remove(window.tasks, taskId))
        }
        changed()
    }

    fun find(taskId: String): TaskOut? =
        boards.values.firstNotNullOfOrNull { board -> board.tasks.firstOrNull { it.id == taskId } }
            ?: mine?.tasks?.firstOrNull { it.id == taskId }
            ?: due.values.firstNotNullOfOrNull { window -> window.tasks.firstOrNull { it.id == taskId } }

    // --- lifecycle ---------------------------------------------------------------------------------

    /** After (re)connecting: every open window is read again (events missed while away, §4). */
    fun online() {
        if (api == null) return
        boards.keys.toList().forEach { channelId -> scope.launch { readBoard(channelId) } }
        if (mine != null) scope.launch { readMine() }
        due.keys.toList().forEach { key -> scope.launch { readDue(key) } }
    }

    /** I left the channel (or was removed): its board closes and its tasks leave the other windows. */
    fun removeChannel(channelId: String) {
        boards.remove(channelId)
        mine?.let { list -> mine = list.copy(tasks = list.tasks.filter { it.channelId != channelId }) }
        for ((key, window) in due.entries.toList()) due[key] = window.copy(tasks = window.tasks.filter { it.channelId != channelId })
        changed()
    }

    fun stop() {
        boards.clear()
        mine = null
        due.clear()
        changed()
    }

    companion object {
        private const val MINE = "mine"

        /** A server from before M55 has no such route (404 not_found): trying again cannot help until it is updated. */
        fun serverLacksTasks(e: Throwable): Boolean = e is ApiException.Api && e.status == 404 && (e.code == "not_found" || e.code == "http_404")
    }
}
