package jp.chikuwachat.android

import jp.chikuwachat.android.TaskFixtures.task
import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.TaskCreate
import jp.chikuwachat.android.api.TaskNeighbors
import jp.chikuwachat.android.api.TaskOut
import jp.chikuwachat.android.api.TaskUpdate
import jp.chikuwachat.android.sync.TaskApi
import jp.chikuwachat.android.sync.TaskHub
import jp.chikuwachat.android.sync.TaskListState
import jp.chikuwachat.android.sync.TaskNotice
import jp.chikuwachat.android.ui.TaskRules
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * M56: the tasks on this device (sync/Tasks.kt), the scenarios of the desktop's taskHub.test.ts — windows read from the
 * server, task.* events as ws-events.json shapes them (decoded here), the optimistic move and its undo, reading again after
 * reconnecting, leaving a channel, and the notices of task.assigned / task.due.
 */
class TaskHubTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)

    private class FakeTaskApi(var board: List<TaskOut> = emptyList(), var mine: List<TaskOut> = emptyList(), var due: List<TaskOut> = emptyList()) : TaskApi {
        val calls = ArrayList<String>()
        var failWith: Exception? = null
        var moveAnswer: CompletableDeferred<TaskOut>? = null
        var moveFailure: Exception? = null

        override suspend fun listTasks(channelId: String, includeDone: String): List<TaskOut> {
            calls += "list $channelId $includeDone"
            failWith?.let { throw it }
            return board
        }

        override suspend fun myTasks(): List<TaskOut> {
            calls += "mine"
            return mine
        }

        override suspend fun dueTasks(from: String, to: String): List<TaskOut> {
            calls += "due $from $to"
            return due
        }

        override suspend fun getTask(taskId: String): TaskOut {
            calls += "get $taskId"
            return task("read", id = taskId)
        }

        override suspend fun createTask(body: TaskCreate): TaskOut {
            calls += "create ${body.clientTaskId}"
            return task(body.title, channelId = body.channelId, status = body.status)
        }

        override suspend fun updateTask(taskId: String, patch: TaskUpdate): TaskOut {
            calls += "update $taskId ${patch.toJson()}"
            return (board + mine).first { it.id == taskId }.copy(status = patch.status ?: "todo", updatedAt = "2026-10-01T09:00:00Z")
        }

        override suspend fun moveTask(taskId: String, status: String, neighbors: TaskNeighbors): TaskOut {
            calls += "move $taskId $status ${neighbors.afterId} ${neighbors.beforeId}"
            moveFailure?.let { throw it }
            return moveAnswer!!.await()
        }

        override suspend fun deleteTask(taskId: String) {
            calls += "delete $taskId"
        }
    }

    private fun hub(api: TaskApi?, notices: MutableList<TaskNotice>? = null) =
        TaskHub(api, scope, { "u-me" }, { "2026-10-01T03:00:00Z" }).also { hub -> notices?.let { list -> hub.onNotice = { list += it } } }

    /** task.updated as the server sends it: the task without `can_delete`, and `deleter_ids`. */
    private fun updated(task: TaskOut, deleters: List<String>): JsonObject {
        val shared = Codec.snake.encodeToJsonElement(TaskOut.serializer(), task).jsonObject.filterKeys { it != "can_delete" }
        return JsonObject(mapOf("task" to JsonObject(shared), "deleter_ids" to JsonArray(deleters.map { JsonPrimitive(it) })))
    }

    private fun json(text: String): JsonObject = Codec.plain.parseToJsonElement(text).jsonObject

    private fun titles(list: List<TaskOut>?) = list?.map { it.title }

    @Test
    fun aBoardIsReadAndKeptCurrentByEvents() = runBlocking {
        val a = task("a", position = 1.0)
        val api = FakeTaskApi(board = listOf(a))
        val hub = hub(api)
        hub.openBoard("c-lab")
        assertEquals(listOf("list c-lab recent"), api.calls)
        assertEquals(TaskListState.READY, hub.board("c-lab")!!.state)
        val b = task("b", position = 2.0)
        hub.applyEvent("task.updated", updated(b, listOf("u-other")))
        assertEquals(listOf("a", "b"), titles(hub.board("c-lab")!!.tasks))
        assertEquals(false, hub.find(b.id)!!.canDelete)
        hub.applyEvent("task.updated", updated(a.copy(title = "A", updatedAt = "2026-10-01T01:00:00Z"), listOf("u-me")))
        assertEquals("A", hub.find(a.id)!!.title)
        assertTrue(hub.find(a.id)!!.canDelete)
        hub.applyEvent("task.deleted", json("""{"id":"${a.id}","channel_id":"c-lab"}"""))
        assertEquals(listOf("b"), titles(hub.board("c-lab")!!.tasks))
        // Another channel's task is not on this board; an unreadable event changes nothing.
        hub.applyEvent("task.updated", updated(task("x", channelId = "c-other"), emptyList()))
        hub.applyEvent("task.updated", json("""{"deleter_ids":[]}"""))
        assertEquals(1, hub.board("c-lab")!!.tasks.size)
        hub.closeBoard("c-lab")
        assertNull(hub.board("c-lab"))
    }

    @Test
    fun aRenumberedColumnArrivesCardByCardAndAnOlderCopyLoses() = runBlocking {
        val a = task("a", position = 1.0)
        val b = task("b", position = 1.0000001)
        val c = task("c", position = 1.0000002)
        val hub = hub(FakeTaskApi(board = listOf(a, b, c)))
        hub.openBoard("c-lab")
        val later = "2026-10-01T02:00:00Z"
        hub.applyEvent("task.updated", updated(c.copy(position = 1024.0, updatedAt = later), emptyList()))
        hub.applyEvent("task.updated", updated(a.copy(position = 2048.0, updatedAt = later), emptyList()))
        hub.applyEvent("task.updated", updated(b.copy(position = 3072.0, updatedAt = later), emptyList()))
        assertEquals(listOf("c", "a", "b"), titles(TaskRules.sortColumn(hub.board("c-lab")!!.tasks, "todo")))
        hub.put(a.copy(position = 0.0)) // a late answer: older than what is held
        assertEquals(listOf("c", "a", "b"), titles(TaskRules.sortColumn(hub.board("c-lab")!!.tasks, "todo")))
    }

    @Test
    fun allDoneAndReconnectingReadTheWindowsAgain() = runBlocking {
        val api = FakeTaskApi()
        val hub = hub(api)
        hub.openBoard("c-lab")
        hub.openBoard("c-lab") // already read: not again
        hub.openBoard("c-lab", allDone = true)
        assertEquals(listOf("list c-lab recent", "list c-lab all"), api.calls)
        hub.openMine()
        hub.openDue("calendar", "2026-09-27", "2026-11-01")
        api.calls.clear()
        hub.online()
        yield()
        assertEquals(listOf("list c-lab all", "mine", "due 2026-09-27 2026-11-01"), api.calls)
    }

    @Test
    fun aServerBeforeM55IsUnsupportedAndAFailureIsFailed() = runBlocking {
        val api = FakeTaskApi()
        api.failWith = ApiException.Api(404, "not_found", "Not Found")
        val hub = hub(api)
        hub.openBoard("c-lab")
        assertEquals(TaskListState.UNSUPPORTED, hub.board("c-lab")!!.state)
        api.failWith = ApiException.Network(java.io.IOException("down"))
        hub.openBoard("c-other")
        assertEquals(TaskListState.FAILED, hub.board("c-other")!!.state)
        assertEquals(false, hub(null).available)
    }

    @Test
    fun aMoveShowsAtOnceThenTheServersPlace() = runBlocking {
        val a = task("a", position = 1.0)
        val b = task("b", position = 2.0)
        val api = FakeTaskApi(board = listOf(a, b))
        val hub = hub(api)
        hub.openBoard("c-lab")
        val answer = CompletableDeferred<TaskOut>()
        api.moveAnswer = answer
        val moving = scope.async { hub.move(b.id, "todo", TaskNeighbors(null, a.id)) }
        assertEquals("move ${b.id} todo null ${a.id}", api.calls.last())
        assertEquals(listOf("b", "a"), titles(TaskRules.sortColumn(hub.board("c-lab")!!.tasks, "todo"))) // at once
        answer.complete(b.copy(position = 0.5, updatedAt = "2026-10-01T05:00:00Z"))
        moving.await()
        assertEquals(0.5, hub.find(b.id)!!.position, 0.0)
        // Into 完了: completed at once by me, as the server would.
        api.moveAnswer = CompletableDeferred()
        scope.async { hub.move(a.id, "done", TaskNeighbors.NONE) }
        assertEquals("done", hub.find(a.id)!!.status)
        assertEquals("u-me", hub.find(a.id)!!.completedBy)
    }

    @Test
    fun aRefusedMovePutsTheCardBack() = runBlocking {
        val a = task("a", position = 1.0)
        val api = FakeTaskApi(board = listOf(a))
        val hub = hub(api)
        hub.openBoard("c-lab")
        api.moveFailure = ApiException.Api(403, "posting_restricted", "no")
        try {
            hub.move(a.id, "doing", TaskNeighbors.NONE)
            fail("expected the refusal")
        } catch (e: ApiException.Api) {
            assertEquals("posting_restricted", e.code)
        }
        assertEquals("todo", hub.find(a.id)!!.status)
        assertEquals(1.0, hub.find(a.id)!!.position, 0.0)
    }

    @Test
    fun myTasksHoldWhatIsPersonalOrAssignedToMe() = runBlocking {
        val mine = task("mine", assignees = listOf("u-me"))
        val api = FakeTaskApi(mine = listOf(mine))
        val hub = hub(api)
        hub.openMine()
        hub.applyEvent("task.updated", updated(mine.copy(assigneeIds = listOf("u-other"), updatedAt = "2026-10-02T00:00:00Z"), emptyList()))
        assertEquals(emptyList<TaskOut>(), hub.mineList()!!.tasks)
        hub.applyEvent("task.updated", updated(task("p", channelId = null), listOf("u-me")))
        hub.applyEvent("task.updated", updated(task("theirs", assignees = listOf("u-other")), emptyList()))
        assertEquals(listOf("p"), titles(hub.mineList()!!.tasks))
        // Created and completed here.
        val created = hub.create(TaskCreate(title = "new", clientTaskId = "k1"))
        assertEquals(listOf("p", "new"), titles(hub.mineList()!!.tasks))
        api.mine = listOf(created)
        hub.update(created.id, TaskUpdate(status = "done"))
        assertEquals("done", hub.find(created.id)!!.status)
        hub.remove(created.id)
        assertNull(hub.find(created.id))
        assertEquals(listOf("create k1", "update ${created.id} {\"status\":\"done\"}", "delete ${created.id}"), api.calls.drop(1))
    }

    @Test
    fun aCalendarRangeHoldsTheTasksDueInIt() = runBlocking {
        val t = task("t", dueOn = "2026-10-05")
        val hub = hub(FakeTaskApi(due = listOf(t)))
        hub.openDue("calendar", "2026-10-01", "2026-10-08")
        hub.applyEvent("task.updated", updated(t.copy(dueOn = "2026-10-08", updatedAt = "2026-10-02T00:00:00Z"), emptyList()))
        assertEquals(emptyList<TaskOut>(), hub.dueWindow("calendar")!!.tasks) // `to` excluded
        hub.applyEvent("task.updated", updated(task("n", dueOn = "2026-10-07"), emptyList()))
        hub.applyEvent("task.updated", updated(task("none"), emptyList()))
        assertEquals(listOf("n"), titles(hub.dueWindow("calendar")!!.tasks))
        hub.closeDue("calendar")
        assertNull(hub.dueWindow("calendar"))
    }

    @Test
    fun leavingAChannelTakesItsTasksOffEveryWindow() = runBlocking {
        val hub = hub(FakeTaskApi(board = listOf(task("a")), mine = listOf(task("m", assignees = listOf("u-me")), task("p", channelId = null))))
        hub.openBoard("c-lab")
        hub.openMine()
        hub.removeChannel("c-lab")
        assertNull(hub.board("c-lab"))
        assertEquals(listOf("p"), titles(hub.mineList()!!.tasks))
    }

    @Test
    fun aTaskKnownOnlyByItsIdIsRead() = runBlocking {
        val api = FakeTaskApi()
        val hub = hub(api)
        assertEquals("t9", hub.load("t9").id)
        assertEquals(listOf("get t9"), api.calls)
    }

    @Test
    fun assignedAndDueGoToTheApp() {
        val notices = ArrayList<TaskNotice>()
        val hub = hub(FakeTaskApi(), notices)
        hub.applyEvent("task.assigned", json("""{"task_id":"t1","channel_id":"c-lab","channel_name":"lab","title":"資料","by_user_id":"u-bob"}"""))
        hub.applyEvent("task.due", json("""{"task_id":"t2","channel_id":null,"channel_name":null,"title":"買い物","due_on":"2026-10-01"}"""))
        assertEquals(2, notices.size)
        val assigned = notices[0] as TaskNotice.Assigned
        assertEquals("u-bob", assigned.data.byUserId)
        val due = notices[1] as TaskNotice.Due
        assertNull(due.data.channelId)
        assertEquals("買い物", due.data.title)
    }
}
