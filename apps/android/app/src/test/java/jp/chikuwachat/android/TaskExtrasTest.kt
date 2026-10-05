package jp.chikuwachat.android

import jp.chikuwachat.android.TaskFixtures.task
import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.ErrorMessages
import jp.chikuwachat.android.api.MessageTaskOut
import jp.chikuwachat.android.api.SubtaskIn
import jp.chikuwachat.android.api.SubtaskOut
import jp.chikuwachat.android.api.TaskColumnOut
import jp.chikuwachat.android.api.TaskCreate
import jp.chikuwachat.android.api.TaskDue
import jp.chikuwachat.android.api.TaskKind
import jp.chikuwachat.android.api.TaskNeighbors
import jp.chikuwachat.android.api.TaskOut
import jp.chikuwachat.android.api.TaskUpdate
import jp.chikuwachat.android.api.taskColumnCreateJson
import jp.chikuwachat.android.api.taskColumnMoveJson
import jp.chikuwachat.android.api.taskColumnUpdateJson
import jp.chikuwachat.android.sync.TaskApi
import jp.chikuwachat.android.sync.TaskHub
import jp.chikuwachat.android.sync.TaskListState
import jp.chikuwachat.android.ui.CalendarRecurrence
import jp.chikuwachat.android.ui.ColumnPlace
import jp.chikuwachat.android.ui.RepeatKind
import jp.chikuwachat.android.ui.SubtaskDraft
import jp.chikuwachat.android.ui.TaskCreateInit
import jp.chikuwachat.android.ui.TaskRules
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import java.time.Instant
import java.time.LocalDate

/**
 * M84 (TASKS.md §11.8): due times, checklists, repeats and board columns on Android — decoding (an older server's JSON
 * and M81's), the columns' rules and their fallback, the hub's column reads, moves and checklist ticks, the form → request
 * mapping and the card / calendar / chip / notice texts. The desktop's tests/taskExtras.test.ts examples, ported.
 */
class TaskExtrasTest {
    @get:Rule val tokyo = TokyoZone()

    private val columns = listOf(
        TaskColumnOut("col-todo", "c-lab", "未着手", "todo", builtin = true, position = 1.0),
        TaskColumnOut("col-doing", "c-lab", "進行中", "doing", builtin = true, position = 2.0),
        TaskColumnOut("col-review", "c-lab", "レビュー待ち", "doing", builtin = false, position = 2.5),
        TaskColumnOut("col-done", "c-lab", "完了", "done", builtin = true, position = 3.0),
    )

    private fun json(text: String): JsonObject = Codec.plain.parseToJsonElement(text).jsonObject

    // --- decoding ----------------------------------------------------------------------------------

    @Test fun anOlderServersTaskDecodesWithTheDefaults() {
        val old = Codec.snake.decodeFromJsonElement(
            TaskOut.serializer(),
            json("""{"id":"t1","channel_id":"c-lab","owner_id":"u","title":"a","status":"doing","position":1,"due_on":"2030-01-10","assignee_ids":[],"created_at":"x","updated_at":"x","can_delete":true}"""),
        )
        assertEquals("doing", old.status)
        assertNull(old.dueAt)
        assertNull(old.dueTz)
        assertEquals(emptyList<SubtaskOut>(), old.subtasks)
        assertNull(old.rrule)
        assertNull(old.columnId)
    }

    @Test fun anM81TaskDecodesItsTimeChecklistRuleAndColumn() {
        val task = Codec.snake.decodeFromJsonElement(
            TaskOut.serializer(),
            json(
                """{"id":"t1","channel_id":"c-lab","owner_id":"u","title":"a","status":"doing","position":1,"due_on":"2030-01-10",
                "due_at":"2030-01-10T05:00:00Z","due_tz":"Asia/Tokyo","subtasks":[{"id":"s1","title":"x","done":true},{"id":"s2","title":"y","done":false}],
                "rrule":"FREQ=WEEKLY;BYDAY=TH","column_id":"col-review","next_task_id":null,"assignee_ids":[],"created_at":"x","updated_at":"x","can_delete":false}""",
            ),
        )
        assertEquals("2030-01-10T05:00:00Z", task.dueAt)
        assertEquals("Asia/Tokyo", task.dueTz)
        assertEquals(listOf(SubtaskOut("s1", "x", true), SubtaskOut("s2", "y", false)), task.subtasks)
        assertEquals("FREQ=WEEKLY;BYDAY=TH", task.rrule)
        assertEquals("col-review", task.columnId)
        // An unknown status-free column id still shows: in its status's built-in column.
        assertEquals("col-review", TaskRules.columnOfTask(task, columns)?.id)
        assertEquals("col-doing", TaskRules.columnOfTask(task.copy(columnId = "col-gone"), columns)?.id)
    }

    @Test fun theChipTheDueEventAndTheColumnsEventDecode() {
        val chip = Codec.snake.decodeFromJsonElement(
            MessageTaskOut.serializer(), json("""{"id":"t1","kind":"task","status":"todo","assignee_ids":[],"due_on":"2030-01-10","due_at":"2030-01-10T05:00:00Z","owner_id":"u"}"""),
        )
        assertEquals("2030-01-10T05:00:00Z", chip.dueAt)
        val oldChip = Codec.snake.decodeFromJsonElement(MessageTaskOut.serializer(), json("""{"id":"t1","status":"todo","due_on":"2030-01-10"}"""))
        assertNull(oldChip.dueAt)
        val due = Codec.snake.decodeFromJsonElement(
            TaskDue.serializer(), json("""{"task_id":"t","channel_id":null,"channel_name":null,"title":"会議","due_on":"2030-01-10","due_at":"2030-01-10T05:00:00Z","tz":"Asia/Tokyo"}"""),
        )
        assertEquals("2030-01-10T05:00:00Z" to "Asia/Tokyo", due.dueAt to due.tz)
    }

    // --- columns -----------------------------------------------------------------------------------

    @Test fun cardsGoToTheirAddedColumnElseTheBuiltInOneOfTheirStatus() {
        val a = task("a", status = "doing")
        val b = task("b", status = "doing").copy(columnId = "col-review")
        val c = task("c", status = "doing").copy(columnId = "col-gone") // a column deleted meanwhile
        assertEquals("col-doing", TaskRules.columnOfTask(a, columns)?.id)
        assertEquals("col-review", TaskRules.columnOfTask(b, columns)?.id)
        assertEquals("col-doing", TaskRules.columnOfTask(c, columns)?.id)
        assertEquals(listOf("a", "c"), TaskRules.sortBoardColumn(listOf(a, b, c), columns[1], columns).map { it.title })
        assertEquals(listOf("b"), TaskRules.sortBoardColumn(listOf(a, b, c), columns[2], columns).map { it.title })
        assertTrue(TaskRules.isFallbackColumns(TaskRules.FALLBACK_COLUMNS))
        assertFalse(TaskRules.isFallbackColumns(columns))
        assertEquals(listOf("todo", "doing", "done"), TaskRules.FALLBACK_COLUMNS.map { it.id })
        assertEquals(listOf("未着手", "進行中", "完了"), TaskRules.FALLBACK_COLUMNS.map { it.name })
    }

    @Test fun leftAndRightNameTheColumnToGoRightOf() {
        assertEquals(ColumnPlace("col-todo"), TaskRules.columnMoveTarget(columns, "col-review", -1))
        assertEquals(ColumnPlace("col-done"), TaskRules.columnMoveTarget(columns, "col-review", 1))
        assertEquals(ColumnPlace(null), TaskRules.columnMoveTarget(columns, "col-doing", -1))
        assertNull(TaskRules.columnMoveTarget(columns, "col-todo", -1))
        assertNull(TaskRules.columnMoveTarget(columns, "col-done", 1))
        assertEquals("""{"after_id":null}""", taskColumnUpdateJson(move = true, afterId = null).toString())
        assertEquals("""{"name":"確認"}""", taskColumnUpdateJson(name = "確認").toString())
        assertEquals("""{"channel_id":"c","name":"確認","status":"doing"}""", taskColumnCreateJson("c", "確認", "doing").toString())
    }

    @Test fun theSwitchTheSelectionAndTheDeleteNote() {
        assertEquals("レビュー待ち 2", TaskRules.columnLabel(columns[2], 2))
        assertEquals("完了", TaskRules.columnLabel(columns[3], 120))
        // The selection made before the columns were read (a status id) lands in that status's built-in column.
        assertEquals("col-doing", TaskRules.pickColumn(columns, "doing", "doing")?.id)
        assertEquals("col-review", TaskRules.pickColumn(columns, "col-review", "doing")?.id)
        assertEquals("col-doing", TaskRules.pickColumn(columns, "col-deleted", "doing")?.id)
        assertEquals("col-todo", TaskRules.pickColumn(columns, null, null)?.id)
        assertEquals("カードは『進行中』へ移ります", TaskRules.deleteColumnText(columns[2], columns))
        assertEquals("列の名前を入れてください", TaskRules.columnNameProblem("  "))
        assertEquals("列の名前は 50 文字までです", TaskRules.columnNameProblem("x".repeat(51)))
        assertNull(TaskRules.columnNameProblem(" レビュー  待ち "))
    }

    @Test fun theOptimisticMoveKeepsTheColumnWhileTheStatusStaysElseTheBuiltInOne() {
        val a = task("a", status = "doing", position = 1.0).copy(columnId = "col-review")
        val b = task("b", status = "doing", position = 5.0)
        val same = TaskRules.applyLocalMove(listOf(a, b), a.id, "doing", TaskNeighbors.NONE, "now", "u-me")
        assertEquals("col-review", same.first { it.id == a.id }.columnId)
        val done = TaskRules.applyLocalMove(listOf(a, b), a.id, "done", TaskNeighbors.NONE, "now", "u-me")
        assertNull(done.first { it.id == a.id }.columnId)
        val into = TaskRules.applyLocalMove(listOf(a, b), b.id, "doing", TaskNeighbors(a.id, null), "now", "u-me", columns[2])
        val moved = into.first { it.id == b.id }
        assertEquals("col-review", moved.columnId)
        assertTrue(moved.position > 1.0)
    }

    // --- the hub -----------------------------------------------------------------------------------

    private class Api(var board: List<TaskOut> = emptyList(), var columns: List<TaskColumnOut>? = null) : TaskApi {
        val calls = ArrayList<String>()
        var columnsFailure: Exception? = null
        var subtaskFailure: Exception? = null

        override suspend fun listTasks(channelId: String, includeDone: String) = board
        override suspend fun myTasks() = emptyList<TaskOut>()
        override suspend fun requestedTasks() = emptyList<TaskOut>()
        override suspend fun dueTasks(from: String, to: String) = emptyList<TaskOut>()
        override suspend fun getTask(taskId: String) = board.first { it.id == taskId }
        override suspend fun createTask(body: TaskCreate) = task(body.title)
        override suspend fun updateTask(taskId: String, patch: TaskUpdate) = board.first { it.id == taskId }
        override suspend fun deleteTask(taskId: String) {}

        override suspend fun moveTask(taskId: String, status: String, neighbors: TaskNeighbors): TaskOut {
            calls += "move $taskId status=$status"
            return board.first { it.id == taskId }.copy(status = status, updatedAt = "2026-10-03T00:00:00Z")
        }

        override suspend fun moveTaskToColumn(taskId: String, columnId: String, neighbors: TaskNeighbors): TaskOut {
            calls += "move $taskId column=$columnId"
            val column = columns!!.first { it.id == columnId }
            return board.first { it.id == taskId }.copy(status = column.status, columnId = TaskRules.columnIdFor(column), updatedAt = "2026-10-03T00:00:00Z")
        }

        override suspend fun listTaskColumns(channelId: String): List<TaskColumnOut>? {
            calls += "columns $channelId"
            columnsFailure?.let { throw it }
            return columns
        }

        override suspend fun createTaskColumn(channelId: String, name: String, status: String, afterId: String?): TaskColumnOut {
            calls += "add $name $status"
            val made = TaskColumnOut("col-new", channelId, name, status, position = 9.0)
            columns = columns!! + made
            return made
        }

        override suspend fun updateTaskColumn(columnId: String, name: String?, move: Boolean, afterId: String?): TaskColumnOut {
            calls += "patch $columnId name=$name move=$move after=$afterId"
            return columns!!.first { it.id == columnId }
        }

        override suspend fun deleteTaskColumn(columnId: String) {
            calls += "delete $columnId"
            columns = columns!!.filter { it.id != columnId }
        }

        override suspend fun updateSubtask(taskId: String, subtaskId: String, done: Boolean): TaskOut {
            calls += "subtask $taskId $subtaskId $done"
            subtaskFailure?.let { throw it }
            val held = board.first { it.id == taskId }
            return held.copy(subtasks = held.subtasks.map { if (it.id == subtaskId) it.copy(done = done) else it }, updatedAt = "2026-10-03T00:00:00Z")
        }
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)

    private fun hub(api: TaskApi) = TaskHub(api, scope, { "u-me" }, { "2026-10-03T00:00:00Z" })

    @Test fun aBoardsColumnsAreReadWithItAndReplacedByTheEvent() = runBlocking {
        val api = Api(columns = listOf(columns[3], columns[0], columns[2], columns[1]))
        val hub = hub(api)
        hub.openBoard("c-lab")
        val board = hub.board("c-lab")!!
        assertEquals(TaskListState.READY, board.state)
        assertTrue(board.columnsSupported)
        assertEquals(listOf("col-todo", "col-doing", "col-review", "col-done"), board.columns.map { it.id })
        val event = JsonObject(
            mapOf(
                "channel_id" to JsonPrimitive("c-lab"),
                "columns" to JsonArray(listOf(columns[3], columns[0]).map { Codec.snake.encodeToJsonElement(TaskColumnOut.serializer(), it) }),
            ),
        )
        hub.applyEvent("task.columns.updated", event)
        assertEquals(listOf("col-todo", "col-done"), hub.board("c-lab")!!.columns.map { it.id })
        // Another board's columns are not kept (the next read has them).
        hub.applyEvent("task.columns.updated", JsonObject(mapOf("channel_id" to JsonPrimitive("c-other"), "columns" to JsonArray(emptyList()))))
        assertNull(hub.board("c-other"))
        // Reconnecting reads them again with the board.
        api.calls.clear()
        hub.online()
        assertEquals(listOf("columns c-lab"), api.calls)
        assertEquals(4, hub.board("c-lab")!!.columns.size)
    }

    @Test fun aServerBeforeM81LeavesTheThreeBuiltInColumns() = runBlocking {
        for (error in listOf(ApiException.Api(404, "not_found", "x"), ApiException.Api(422, "validation_error", "x"))) {
            val api = Api(board = listOf(task("a")), columns = columns).also { it.columnsFailure = error }
            val hub = hub(api)
            hub.openBoard("c-lab")
            val board = hub.board("c-lab")!!
            assertEquals(TaskListState.READY, board.state)
            assertFalse(board.columnsSupported)
            assertEquals(listOf("todo", "doing", "done"), board.columns.map { it.id })
            assertEquals(1, board.tasks.size)
        }
        // A fake (or client) without the endpoint: the same.
        val plain = hub(Api(columns = null))
        plain.openBoard("c-lab")
        assertEquals(TaskRules.FALLBACK_COLUMNS, plain.board("c-lab")!!.columns)
        // Any other refusal fails the board (read again on reconnecting).
        val broken = hub(Api(columns = columns).also { it.columnsFailure = ApiException.Api(500, "internal", "x") })
        broken.openBoard("c-lab")
        assertEquals(TaskListState.FAILED, broken.board("c-lab")!!.state)
    }

    @Test fun aMoveIntoAColumnSendsItsIdAndAFallbackColumnSendsTheStatus() = runBlocking {
        val a = task("a")
        val api = Api(board = listOf(a), columns = columns)
        val hub = hub(api)
        hub.openBoard("c-lab")
        hub.move(a.id, "doing", TaskNeighbors.NONE, columns[2])
        assertEquals("move ${a.id} column=col-review", api.calls.last())
        assertEquals("col-review", hub.find(a.id)?.columnId)
        hub.move(a.id, "done", TaskNeighbors.NONE, TaskRules.FALLBACK_COLUMNS[2])
        assertEquals("move ${a.id} status=done", api.calls.last())
        assertEquals("""{"column_id":"c1","after_id":"x","before_id":null}""", taskColumnMoveJson("c1", TaskNeighbors("x", null)).toString())
    }

    @Test fun columnChangesReadTheColumnsAgain() = runBlocking {
        val api = Api(columns = columns)
        val hub = hub(api)
        hub.openBoard("c-lab")
        hub.addColumn("c-lab", "確認", "doing")
        assertEquals("col-new", hub.board("c-lab")!!.columns.last().id)
        hub.moveColumn("c-lab", "col-review", ColumnPlace(null))
        assertTrue(api.calls.contains("patch col-review name=null move=true after=null"))
        hub.renameColumn("c-lab", "col-doing", "作業中")
        assertTrue(api.calls.contains("patch col-doing name=作業中 move=false after=null"))
        hub.removeColumn("c-lab", "col-new")
        assertFalse(hub.board("c-lab")!!.columns.any { it.id == "col-new" })
    }

    @Test fun aSubtasksCheckboxShowsAtOnceAndGoesBackWhenRefused() = runBlocking {
        val a = task("a").copy(subtasks = listOf(SubtaskOut("s1", "x", false)))
        val api = Api(board = listOf(a), columns = columns)
        val hub = hub(api)
        hub.openBoard("c-lab")
        hub.toggleSubtask(a.id, "s1", true)
        assertEquals(true, hub.find(a.id)?.subtasks?.single()?.done)
        api.subtaskFailure = ApiException.Api(409, "channel_archived", "x")
        api.board = listOf(hub.find(a.id)!!)
        try {
            hub.toggleSubtask(a.id, "s1", false)
            fail("the refusal is thrown")
        } catch (e: ApiException.Api) {
            assertEquals("channel_archived", e.code)
        }
        assertEquals(true, hub.find(a.id)?.subtasks?.single()?.done)
        assertEquals(listOf("subtask ${a.id} s1 true", "subtask ${a.id} s1 false"), api.calls.filter { it.startsWith("subtask") })
    }

    // --- due times ---------------------------------------------------------------------------------

    @Test fun theTimeShowsIsLateOnceItHasPassedAndSortsAfterTheWholeDayOnes() {
        val timed = task("会議", dueOn = "2030-01-10").copy(dueAt = "2030-01-10T05:00:00Z", dueTz = "Asia/Tokyo")
        assertEquals("今日 14:00", TaskRules.dueText(timed, "2030-01-10"))
        assertEquals("1/10 14:00", TaskRules.dueText(timed, "2030-01-01"))
        assertFalse(TaskRules.isOverdue(timed, "2030-01-10", Instant.parse("2030-01-10T04:59:00Z")))
        assertTrue(TaskRules.isOverdue(timed, "2030-01-10", Instant.parse("2030-01-10T05:01:00Z")))
        assertFalse(TaskRules.isOverdue(timed.copy(status = "done"), "2030-01-11", Instant.parse("2030-01-11T00:00:00Z")))
        val day = task("提出", dueOn = "2030-01-10")
        val early = task("朝会", dueOn = "2030-01-10").copy(dueAt = "2030-01-10T00:30:00Z")
        assertEquals(listOf("提出", "朝会", "会議"), TaskRules.tasksForDay(listOf(timed, day, early), "2030-01-10").map { it.title })
        assertEquals("14:00", TaskRules.calendarTime(timed))
        assertEquals("", TaskRules.calendarTime(day))
        // A due time is shown in this device's zone (the task's own zone may differ).
        val newYork = task("NY", dueOn = "2030-01-09").copy(dueAt = "2030-01-10T01:00:00Z", dueTz = "America/New_York")
        assertEquals("1/10 10:00", TaskRules.dueText(newYork, "2030-01-01"))
    }

    @Test fun theChipAndTheInAppNoticeSayTheTime() {
        val chip = MessageTaskOut("t1", TaskKind.TASK, "todo", emptyList(), "2030-01-10", "u", dueAt = "2030-01-10T05:00:00Z")
        assertEquals("タスク · 未着手 · 1/10 14:00 まで", TaskRules.chipAt(chip, "2030-01-01", Instant.parse("2030-01-01T00:00:00Z")) { null }.text)
        assertEquals("タスク · 未着手 · 今日 14:00 まで", TaskRules.chipAt(chip, "2030-01-10", Instant.parse("2030-01-10T01:00:00Z")) { null }.text)
        assertEquals(
            jp.chikuwachat.android.ui.TaskChipTone.OVERDUE,
            TaskRules.chipAt(chip, "2030-01-10", Instant.parse("2030-01-10T06:00:00Z")) { null }.tone,
        )
        assertEquals("14:00 が期限：会議", TaskRules.dueText(TaskDue("t", title = "会議", dueOn = "2030-01-10", dueAt = "2030-01-10T05:00:00Z")).body)
        assertEquals("今日が期限：会議", TaskRules.dueText(TaskDue("t", title = "会議", dueOn = "2030-01-10")).body)
    }

    @Test fun theCardSaysItsTimeItsChecklistAndItsRepeat() {
        val t = task("a", dueOn = "2030-01-10").copy(
            dueAt = "2030-01-10T05:00:00Z", rrule = "FREQ=WEEKLY",
            subtasks = listOf(SubtaskOut("s1", "x", true), SubtaskOut("s2", "y", false), SubtaskOut("s3", "z", true), SubtaskOut("s4", "w", false), SubtaskOut("s5", "v", false)),
        )
        assertEquals("期限 1/10 14:00", TaskRules.cardDueText(t, "2030-01-01"))
        assertEquals("希望日 1/10 14:00", TaskRules.cardDueText(t.copy(kind = TaskKind.REVIEW), "2030-01-01"))
        assertEquals("期限 1/10", TaskRules.cardDueText(t.copy(dueAt = null), "2030-01-01"))
        assertEquals(2 to 5, TaskRules.subtaskProgress(t))
        assertEquals("☑ 2/5", TaskRules.progressText(TaskRules.subtaskProgress(t)!!))
        assertNull(TaskRules.subtaskProgress(task("none")))
    }

    // --- the form ----------------------------------------------------------------------------------

    @Test fun theFormSendsATimeWithTheDevicesOffsetDropsItOrMovesTheDate() {
        val plain = task("a", dueOn = "2030-01-10")
        val draft = TaskRules.draftFromTask(plain).copy(dueTime = "14:30")
        val patch = TaskRules.taskPatch(plain, draft, "Asia/Tokyo")
        assertEquals("""{"due_at":"2030-01-10T14:30:00+09:00","tz":"Asia/Tokyo"}""", patch.toJson().toString())
        val timed = task("b", dueOn = "2030-01-10").copy(dueAt = "2030-01-10T05:30:00Z", dueTz = "Asia/Tokyo")
        val same = TaskRules.draftFromTask(timed)
        assertEquals("14:30", same.dueTime)
        assertTrue(TaskRules.taskPatch(timed, same, "Asia/Tokyo").isEmpty)
        assertEquals("""{"due_at":null}""", TaskRules.taskPatch(timed, same.copy(dueTime = ""), "Asia/Tokyo").toJson().toString())
        val cleared = TaskRules.withDueOn(same, "")
        assertEquals("""{"due_on":null,"tz":"Asia/Tokyo"}""", TaskRules.taskPatch(timed, cleared, "Asia/Tokyo").toJson().toString())
        // Another date at the same time: the new due_at (its date goes with it).
        val moved = TaskRules.withDueOn(same, "2030-01-12")
        assertEquals("""{"due_at":"2030-01-12T14:30:00+09:00","tz":"Asia/Tokyo"}""", TaskRules.taskPatch(timed, moved, "Asia/Tokyo").toJson().toString())
    }

    @Test fun aNewTaskGoesOutWithItsRuleTimeAndChecklist() {
        val start = LocalDate.parse("2030-01-07")
        val draft = TaskRules.withDueOn(jp.chikuwachat.android.ui.TaskDraft(title = "週報"), "2030-01-07").let {
            it.copy(
                dueTime = "09:00", repeat = it.repeat.copy(kind = RepeatKind.WEEKLY),
                subtasks = listOf(SubtaskDraft(null, " まとめる "), SubtaskDraft(null, "  ")),
            )
        }
        assertEquals(listOf(1), draft.repeat.weekdays) // Monday, from the due date
        val body = TaskRules.taskCreateBody(draft, "c-lab", null, "k", "Asia/Tokyo")
        assertEquals("2030-01-07", body.dueOn)
        assertEquals("2030-01-07T09:00:00+09:00", body.dueAt)
        assertEquals("FREQ=WEEKLY;BYDAY=MO", body.rrule)
        assertEquals(listOf(SubtaskIn(null, "まとめる", false)), body.subtasks)
        val wire = Codec.snake.encodeToJsonElement(TaskCreate.serializer(), body).jsonObject
        assertEquals("""[{"title":"まとめる","done":false}]""", wire["subtasks"].toString())
        assertEquals("繰り返すには期限を入れてください", TaskRules.draftProblem(draft.copy(dueOn = "")))
        assertNull(TaskRules.draftProblem(draft))
        assertEquals(CalendarRecurrence.repeatProblem(draft.repeat.copy(weekdays = emptyList()), start), TaskRules.draftProblem(draft.copy(repeat = draft.repeat.copy(weekdays = emptyList()))))
        // A review request never repeats; a plain task without extras sends none.
        val review = TaskCreateInit(channelId = "c-lab", kind = TaskKind.REVIEW, sourceMessageId = "m1")
        assertNull(TaskRules.taskCreateBody(draft, "c-lab", review, "k", "Asia/Tokyo").rrule)
        val bare = Codec.snake.encodeToJsonElement(TaskCreate.serializer(), TaskRules.taskCreateBody(jp.chikuwachat.android.ui.TaskDraft(title = "x"), null, null, "k", "Asia/Tokyo")).jsonObject
        assertFalse(bare.containsKey("due_at") || bare.containsKey("rrule") || bare.containsKey("subtasks"))
    }

    @Test fun theRuleAndTheChecklistArePatchedOnlyWhenTheyChanged() {
        val t = task("a", dueOn = "2030-01-07").copy(rrule = "FREQ=WEEKLY", subtasks = listOf(SubtaskOut("s1", "x", false)))
        val draft = TaskRules.draftFromTask(t)
        assertTrue(TaskRules.taskPatch(t, draft, "Asia/Tokyo").isEmpty)
        assertEquals("""{"rrule":null}""", TaskRules.taskPatch(t, draft.copy(repeat = CalendarRecurrence.noRepeat(LocalDate.parse("2030-01-07"))), "Asia/Tokyo").toJson().toString())
        val list = TaskRules.taskPatch(t, draft.copy(subtasks = draft.subtasks + SubtaskDraft(null, "y", true)), "Asia/Tokyo")
        assertEquals("""{"subtasks":[{"id":"s1","title":"x","done":false},{"title":"y","done":true}]}""", list.toJson().toString())
        // Reordering is a change too; ticking a saved item (sent at once, the task updated) is not.
        val two = t.copy(subtasks = listOf(SubtaskOut("s1", "x", false), SubtaskOut("s2", "y", false)))
        val twoDraft = TaskRules.draftFromTask(two)
        assertEquals(listOf("s2", "s1"), TaskRules.taskPatch(two, twoDraft.copy(subtasks = TaskRules.moveSubtask(twoDraft.subtasks, 0, 1)), "Asia/Tokyo").subtasks?.map { it.id })
        // Dropping the due date of a repeating task stops it too.
        val dropped = TaskRules.taskPatch(t, TaskRules.withDueOn(draft, ""), "Asia/Tokyo").toJson()
        assertEquals("null", dropped["due_on"].toString())
        assertEquals("null", dropped["rrule"].toString())
        // A new rule on a date-only task.
        val weekly = TaskRules.taskPatch(task("b", dueOn = "2030-01-07"), TaskRules.draftFromTask(task("b", dueOn = "2030-01-07")).let { it.copy(repeat = it.repeat.copy(kind = RepeatKind.DAILY)) }, "Asia/Tokyo")
        assertEquals("FREQ=DAILY", weekly.rrule)
        assertTrue(weekly.setRrule)
    }

    @Test fun theNewErrorCodesHaveTheirWords() {
        for (code in listOf("task_invalid_rrule", "task_invalid_column", "task_subtask_not_found", "task_column_not_found", "task_column_builtin", "task_column_limit")) {
            assertTrue(code, !ErrorMessages.byCode[code].isNullOrEmpty())
        }
    }
}
