package jp.chikuwachat.android.sync

import jp.chikuwachat.android.api.TaskCreate
import jp.chikuwachat.android.api.TaskNeighbors
import jp.chikuwachat.android.api.TaskOut
import jp.chikuwachat.android.api.TaskUpdate

/** M56: the task endpoints (TASKS.md §3, §8), apart from SyncApi like CalendarApi (ApiClient and the test fakes). */
interface TaskApi {
    /** A channel's board: every open task, and the latest 100 completed ones (`include_done` "all": every one). */
    suspend fun listTasks(channelId: String, includeDone: String = "recent"): List<TaskOut>
    /** 「自分のタスク」: my personal tasks and the shared ones assigned to me (the latest 50 completed). */
    suspend fun myTasks(): List<TaskOut>
    /**
     * L9 「自分が依頼した」 (REVIEWS.md §8): the shared tasks I made with someone else assigned, DMs' too (open ones by due
     * date, then the latest 50 completed).
     */
    suspend fun requestedTasks(): List<TaskOut>
    /** The tasks due in the dates [from, to) (at most 100 days), every one I may see, completed ones too. */
    suspend fun dueTasks(from: String, to: String): List<TaskOut>
    suspend fun getTask(taskId: String): TaskOut
    suspend fun createTask(body: TaskCreate): TaskOut
    suspend fun updateTask(taskId: String, patch: TaskUpdate): TaskOut
    /** Into `status` between `neighbors` (the server picks the position). */
    suspend fun moveTask(taskId: String, status: String, neighbors: TaskNeighbors): TaskOut
    suspend fun deleteTask(taskId: String)
}
