package jp.chikuwachat.android

import jp.chikuwachat.android.TaskFixtures.channel
import jp.chikuwachat.android.TaskFixtures.task
import jp.chikuwachat.android.api.CalendarEventOut
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.TaskAssigned
import jp.chikuwachat.android.api.TaskCreate
import jp.chikuwachat.android.api.TaskDue
import jp.chikuwachat.android.api.TaskNeighbors
import jp.chikuwachat.android.api.TaskOut
import jp.chikuwachat.android.api.TaskSourceOut
import jp.chikuwachat.android.api.TaskUpdate
import jp.chikuwachat.android.api.UserPublic
import jp.chikuwachat.android.api.taskMoveJson
import jp.chikuwachat.android.ui.CalendarDates
import jp.chikuwachat.android.ui.TaskDraft
import jp.chikuwachat.android.ui.TaskRules
import jp.chikuwachat.android.ui.TaskSource
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate

/**
 * M56 (TASKS.md): the tasks' pure rules (ui/TaskRules.kt), the cases of the desktop's tasks.test.ts — order, where a moved
 * card lands, the optimistic move, events, due dates, who may edit, 「自分のタスク」's groups, the form's patch, 「タスクにする」's
 * prefill, the notices' wording — and the request bodies as the server reads them.
 */
class TaskRulesTest {
    private fun ids(list: List<TaskOut>) = list.map { it.id }

    @Test
    fun aColumnIsInTheServersOrderNeverTheOrderHeld() {
        val a = task("a", position = 2.0, id = "b-id")
        val b = task("b", position = 1.0)
        val c = task("c", position = 2.0, id = "a-id")
        val d = task("d", position = 0.0, status = "done")
        assertEquals(listOf(b.id, "a-id", "b-id"), ids(TaskRules.sortColumn(listOf(a, b, c, d), "todo")))
        assertEquals(listOf(d.id), ids(TaskRules.sortColumn(listOf(a, b, c, d), "done")))
    }

    @Test
    fun whereAMovedCardLands() {
        val column = listOf(task("1"), task("2"), task("3"))
        val (one, two, three) = column
        // From another column: top, middle, bottom; an empty column: neither.
        assertEquals(TaskNeighbors(null, one.id), TaskRules.computeNeighbors(column, "x", 0))
        assertEquals(TaskNeighbors(one.id, two.id), TaskRules.computeNeighbors(column, "x", 1))
        assertEquals(TaskNeighbors(three.id, null), TaskRules.computeNeighbors(column, "x", 3))
        assertEquals(TaskNeighbors.NONE, TaskRules.computeNeighbors(emptyList(), "x", 0))
        // Within its column the card itself is not a neighbour.
        assertEquals(TaskNeighbors(two.id, three.id), TaskRules.computeNeighbors(column, one.id, 2))
        assertEquals(TaskNeighbors(null, one.id), TaskRules.computeNeighbors(column, three.id, 0))
        assertEquals(TaskNeighbors(three.id, null), TaskRules.computeNeighbors(column, one.id, 3))
        assertTrue(TaskRules.isNoopMove(column, two.id, 1))
        assertTrue(TaskRules.isNoopMove(column, two.id, 2))
        assertFalse(TaskRules.isNoopMove(column, two.id, 3))
        // 上へ / 下へ: one place, nothing past the ends.
        assertEquals(TaskNeighbors(null, one.id), TaskRules.moveWithin(column, two.id, -1))
        assertEquals(TaskNeighbors(three.id, null), TaskRules.moveWithin(column, two.id, 1))
        assertEquals(TaskNeighbors(two.id, three.id), TaskRules.moveWithin(column, one.id, 1))
        assertNull(TaskRules.moveWithin(column, one.id, -1))
        assertNull(TaskRules.moveWithin(column, three.id, 1))
    }

    @Test
    fun theOptimisticMoveGuessesAPositionAndCompletion() {
        val a = task("a", position = 1.0)
        val b = task("b", position = 2.0)
        val c = task("c", position = 3.0, status = "doing")
        val d = task("d", position = 5.0, status = "done")
        val all = listOf(a, b, c, d)
        val now = "2026-10-01T03:00:00Z"
        val between = TaskRules.applyLocalMove(all, c.id, "todo", TaskNeighbors(a.id, b.id), now, "u-me")
        assertEquals(listOf(a.id, c.id, b.id), ids(TaskRules.sortColumn(between, "todo")))
        assertEquals("todo", between.first { it.id == c.id }.status)
        val top = TaskRules.applyLocalMove(all, b.id, "todo", TaskNeighbors(null, a.id), now, "u-me")
        assertEquals(listOf(b.id, a.id), ids(TaskRules.sortColumn(top, "todo")))
        val bottom = TaskRules.applyLocalMove(all, a.id, "doing", TaskNeighbors.NONE, now, "u-me")
        assertEquals(listOf(c.id, a.id), ids(TaskRules.sortColumn(bottom, "doing")))
        // Into done without neighbours: its top (the newest completion first), completed now by me.
        val done = TaskRules.applyLocalMove(all, a.id, "done", TaskNeighbors.NONE, now, "u-me")
        assertEquals(listOf(a.id, d.id), ids(TaskRules.sortColumn(done, "done")))
        assertEquals(now, done.first { it.id == a.id }.completedAt)
        assertEquals("u-me", done.first { it.id == a.id }.completedBy)
        val back = TaskRules.applyLocalMove(done, d.id, "todo", TaskNeighbors(b.id, null), now, "u-me")
        val moved = back.first { it.id == d.id }
        assertEquals("todo", moved.status)
        assertNull(moved.completedAt)
        assertNull(moved.completedBy)
        assertEquals(listOf(b.id, d.id), ids(TaskRules.sortColumn(back, "todo")))
    }

    @Test
    fun eventsUpsertRemoveAndCanDeleteFromDeleterIds() {
        val a = task("a")
        val list = TaskRules.upsert(listOf(a), a.copy(title = "A"))
        assertEquals(listOf("A"), list.map { it.title })
        assertEquals(2, TaskRules.upsert(list, task("b")).size)
        assertEquals(emptyList<TaskOut>(), TaskRules.remove(list, a.id))
        assertTrue(TaskRules.fromEvent(a.copy(canDelete = false), listOf("u-me"), "u-me").canDelete)
        assertFalse(TaskRules.fromEvent(a, listOf("u-other"), "u-me").canDelete)
        assertFalse(TaskRules.fromEvent(a, listOf("u-me"), null).canDelete)
        // 「自分のタスク」: personal ones and those assigned to me.
        assertTrue(TaskRules.isMine(task("p", channelId = null), "u-me"))
        assertTrue(TaskRules.isMine(task("s", assignees = listOf("u-me")), "u-me"))
        assertFalse(TaskRules.isMine(task("s", assignees = listOf("u-other")), "u-me"))
    }

    @Test
    fun dueDates() {
        assertTrue(TaskRules.isOverdue(task("a", dueOn = "2026-09-30"), "2026-10-01"))
        assertFalse(TaskRules.isOverdue(task("a", dueOn = "2026-09-30", status = "done"), "2026-10-01"))
        assertFalse(TaskRules.isOverdue(task("a", dueOn = "2026-10-01"), "2026-10-01"))
        assertFalse(TaskRules.isOverdue(task("a"), "2026-10-01"))
        assertEquals("今日", TaskRules.dueLabel("2026-10-01", "2026-10-01"))
        assertEquals("10/5", TaskRules.dueLabel("2026-10-05", "2026-10-01"))
        assertEquals("2027/1/5", TaskRules.dueLabel("2027-01-05", "2026-10-01"))
        // A day's tasks: open ones first.
        val open = task("b-open", dueOn = "2026-10-05")
        val done = task("a-done", dueOn = "2026-10-05", status = "done")
        val other = task("c", dueOn = "2026-10-06")
        assertEquals(listOf(open.id, done.id), ids(TaskRules.tasksForDay(listOf(done, open, other), "2026-10-05")))
        assertTrue(TaskRules.dueInRange(open, "2026-10-05", "2026-10-06"))
        assertFalse(TaskRules.dueInRange(other, "2026-10-05", "2026-10-06")) // `to` excluded
        assertFalse(TaskRules.dueInRange(task("none"), "2026-10-01", "2026-11-01"))
    }

    @Test
    fun theAgendaHasTheDaysWithATaskDueToo() {
        val start = LocalDate.parse("2026-10-01")
        val end = LocalDate.parse("2026-10-08")
        val event = CalendarEventOut(id = "e1", title = "ゼミ", allDay = true, startDate = "2026-10-03", endDate = "2026-10-03")
        val days = TaskRules.agendaDays(
            listOf(LocalDate.parse("2026-10-03") to listOf(event)),
            listOf(task("a", dueOn = "2026-10-05"), task("b", dueOn = "2026-10-03"), task("c", dueOn = "2026-10-08"), task("d", dueOn = "2026-10-05")),
            start, end,
        )
        assertEquals(listOf("2026-10-03", "2026-10-05"), days.map { it.first.toString() })
        assertEquals(listOf("e1"), days[0].second.map { it.id })
        assertTrue(days[1].second.isEmpty())
    }

    @Test
    fun whoMayEditABoardIsTheComposersRule() {
        val isAdmin = false
        assertTrue(TaskRules.canEditBoard(channel("lab"), isAdmin))
        assertFalse(TaskRules.canEditBoard(channel("news", postingPolicy = "owners"), isAdmin))
        assertTrue(TaskRules.canEditBoard(channel("own", postingPolicy = "owners", role = "owner"), isAdmin))
        assertFalse(TaskRules.canEditBoard(channel("old", archived = true), isAdmin))
        assertFalse(TaskRules.canEditBoard(channel("dm", type = "dm", role = null), isAdmin))
        assertFalse(TaskRules.canEditBoard(channel("other", member = false, role = null), isAdmin))
        assertFalse(TaskRules.canEditBoard(null, isAdmin))
        assertTrue(TaskRules.canEditBoard(channel("news", postingPolicy = "owners"), isAdmin = true))
        // A personal task is always mine to change.
        assertTrue(TaskRules.canEditTask(task("p", channelId = null), null, false))
        assertFalse(TaskRules.canEditTask(task("s", channelId = "news"), channel("news", postingPolicy = "owners"), false))
        // The strip over the board says why.
        assertEquals("アーカイブされたチャンネルのタスクは変更できません", TaskRules.boardNote(false, false, channel("old", archived = true), canEdit = false))
        assertEquals("このボードを変更できるのは、チャンネルのオーナーと管理者だけです", TaskRules.boardNote(false, false, channel("news", postingPolicy = "owners"), canEdit = false))
        assertNull(TaskRules.boardNote(false, false, channel("lab"), canEdit = true))
        assertEquals("このサーバはタスクに対応していません", TaskRules.boardNote(true, false, channel("lab"), canEdit = true))
    }

    @Test
    fun myTasksArePersonalApartAndAssignedByChannel() {
        val p1 = task("p1", channelId = null, status = "doing", position = 1.0)
        val p2 = task("p2", channelId = null, status = "todo", position = 9.0)
        val p3 = task("p3", channelId = null, status = "done", completedAt = "2026-09-01T00:00:00Z")
        val p4 = task("p4", channelId = null, status = "done", completedAt = "2026-09-20T00:00:00Z")
        val s1 = task("s1", channelId = "c-zoo", channelName = "zoo", assignees = listOf("u-me"))
        val s2 = task("s2", channelId = "c-lab", channelName = "lab", assignees = listOf("u-me", "u-other"))
        val s3 = task("s3", channelId = "c-lab", channelName = "lab", assignees = listOf("u-other"))
        val (personal, groups) = TaskRules.groupMineByChannel(listOf(s1, p1, s2, p2, s3, p3, p4), "u-me")
        assertEquals(listOf(p1.id, p2.id, p3.id, p4.id), ids(personal))
        assertEquals(listOf("lab" to listOf(s2.id), "zoo" to listOf(s1.id)), groups.map { it.channelName to ids(it.tasks) })
        // The store's name wins over the one the task carries.
        assertEquals("研究室", TaskRules.groupMineByChannel(listOf(s2), "u-me") { if (it == "c-lab") "研究室" else null }.second.single().channelName)
        val (open, done) = TaskRules.splitOpenDone(personal)
        assertEquals(listOf(p2.id, p1.id), ids(open))
        assertEquals(listOf(p4.id, p3.id), ids(done))
    }

    @Test
    fun theFormSendsOnlyWhatChanged() {
        val t = task("資料", notes = "メモ", dueOn = "2026-10-05", assignees = listOf("u-a"))
        val draft = TaskRules.draftFromTask(t)
        assertTrue(TaskRules.taskPatch(t, draft, "Asia/Tokyo").isEmpty)
        assertEquals("""{"title":"資料 を 作る"}""", TaskRules.taskPatch(t, draft.copy(title = "  資料  を 作る "), "Asia/Tokyo").toJson().toString())
        assertEquals("""{"notes":null}""", TaskRules.taskPatch(t, draft.copy(notes = "  "), "Asia/Tokyo").toJson().toString())
        assertEquals("""{"due_on":null,"tz":"Asia/Tokyo"}""", TaskRules.taskPatch(t, draft.copy(dueOn = ""), "Asia/Tokyo").toJson().toString())
        assertEquals("""{"due_on":"2026-10-09","tz":"Asia/Tokyo"}""", TaskRules.taskPatch(t, draft.copy(dueOn = "2026-10-09"), "Asia/Tokyo").toJson().toString())
        assertEquals(
            """{"status":"done","assignee_ids":["u-a","u-b"]}""",
            TaskRules.taskPatch(t, draft.copy(status = "done", assigneeIds = listOf("u-b", "u-a", "u-b")), "Asia/Tokyo").toJson().toString(),
        )
        // A personal task has no assignees to send.
        val p = task("p", channelId = null)
        assertTrue(TaskRules.taskPatch(p, TaskRules.draftFromTask(p).copy(assigneeIds = listOf("u-a")), "Asia/Tokyo").isEmpty)
        assertEquals("題名を入れてください", TaskRules.draftProblem(draft.copy(title = "   ")))
        assertEquals("題名は 200 文字までです", TaskRules.draftProblem(draft.copy(title = "あ".repeat(201))))
        assertEquals("メモは 4000 文字までです", TaskRules.draftProblem(draft.copy(notes = "x".repeat(4001))))
        assertNull(TaskRules.draftProblem(draft))
        // M84: the rule picker starts from the due date (its weekday); no time, no checklist.
        assertEquals(TaskDraft("資料", "メモ", "todo", "2026-10-05", listOf("u-a")), draft.copy(repeat = jp.chikuwachat.android.ui.RepeatDraft()))
    }

    @Test
    fun theSourceIsALinkWhileTheMessageExists() {
        assertEquals(TaskSource.None, TaskRules.sourceState(task("a")))
        assertEquals(TaskSource.Link("m1", "抜粋"), TaskRules.sourceState(task("a", source = TaskSourceOut("m1", "c-lab", "抜粋"))))
        assertEquals(TaskSource.Link("m1", null), TaskRules.sourceState(task("a", source = TaskSourceOut("m1", "c-lab", null))))
        assertEquals(TaskSource.Deleted, TaskRules.sourceState(task("a", source = TaskSourceOut(null, "c-lab", null))))
    }

    @Test
    fun makingATaskFromAMessage() {
        val bob = "0b0b0b0b-0000-4000-8000-000000000001"
        val users = mapOf(bob to UserPublic(bob, "bob", "ボブ", "member", null, "", ""))
        // A channel message: its one-line text as the title, its board (switchable to mine).
        val init = TaskRules.messageTaskInit("m1", "**明日** までに\n<@$bob> と資料", emptyList(), channel("lab"), users, emptyMap(), false)
        assertEquals("lab", init.channelId)
        assertEquals("明日 までに @ボブ と資料", init.title)
        assertEquals("m1", init.sourceMessageId)
        assertEquals("明日 までに @ボブ と資料", init.sourceExcerpt)
        assertEquals(listOf("lab"), init.boardChoices)
        // A DM (or a board I may not add to): 「自分のタスク」; a long body is cut to 200.
        val dm = TaskRules.messageTaskInit("m1", "あ".repeat(300), emptyList(), channel("dm", type = "dm", role = null), users, emptyMap(), false)
        assertNull(dm.channelId)
        assertEquals(emptyList<String>(), dm.boardChoices)
        assertEquals(200, dm.title.length)
        assertNull(TaskRules.messageTaskInit("m2", "x", emptyList(), channel("news", postingPolicy = "owners"), users, emptyMap(), false).channelId)
        // No text: what the attachments were.
        assertEquals("画像を送信しました", TaskRules.messageTaskInit("m3", "", listOf("image/png"), channel("dm", type = "dm", role = null), users, emptyMap(), false).title)
    }

    @Test
    fun theCalendarsFilterOnTasks() {
        val p = task("p", channelId = null)
        val a = task("a", assignees = listOf("u-me"))
        val o = task("o", channelId = "c-other")
        assertEquals(3, TaskRules.filterTasks(listOf(p, a, o), CalendarDates.FILTER_ALL, "u-me").size)
        assertEquals(listOf(p.id, a.id), ids(TaskRules.filterTasks(listOf(p, a, o), CalendarDates.FILTER_ME, "u-me")))
        assertEquals(listOf(o.id), ids(TaskRules.filterTasks(listOf(p, a, o), "c-other", "u-me")))
    }

    @Test
    fun noticesAreWordedLikeThePush() {
        val nameOf = { id: String -> if (id == "u-bob") "ボブ" else null }
        val assigned = TaskRules.assignedText(TaskAssigned("t1", "c-lab", "lab", "資料", "u-bob"), nameOf)
        assertEquals("ボブ がタスクを割り当てました: 資料 (#lab)", assigned.body)
        assertEquals("t1", assigned.taskId)
        assertEquals("c-lab", assigned.channelId)
        assertEquals("メンバー がタスクを割り当てました: 資料 (#lab)", TaskRules.assignedText(TaskAssigned("t1", "c-lab", "lab", "資料", "u-x"), nameOf).body)
        assertEquals("今日が期限: 買い物", TaskRules.dueText(TaskDue("t2", null, null, "買い物", "2026-10-01")).body)
        assertEquals("今日が期限: 発表 (#lab)", TaskRules.dueText(TaskDue("t3", "c-lab", "lab", "発表", "2026-10-01")).body)
    }

    @Test
    fun requestBodiesAreTheServersShapes() {
        // POST /tasks: absent fields left out (TaskCreate has additionalProperties false).
        val create = TaskCreate(channelId = "c-lab", title = "資料", status = "doing", clientTaskId = "k1", tz = "Asia/Tokyo")
        assertEquals(
            """{"channel_id":"c-lab","title":"資料","status":"doing","client_task_id":"k1","tz":"Asia/Tokyo"}""",
            Codec.snake.encodeToJsonElement(TaskCreate.serializer(), create).toString(),
        )
        val full = TaskCreate(title = "x", notes = "n", dueOn = "2026-10-05", assigneeIds = listOf("u-a"), sourceMessageId = "m1")
        assertEquals(
            """{"title":"x","notes":"n","status":"todo","due_on":"2026-10-05","assignee_ids":["u-a"],"source_message_id":"m1"}""",
            Codec.snake.encodeToJsonElement(TaskCreate.serializer(), full).toString(),
        )
        // POST /tasks/{id}/move: both neighbours written out (null: none).
        assertEquals("""{"status":"todo","after_id":"a","before_id":null}""", taskMoveJson("todo", TaskNeighbors("a", null)).toString())
        assertEquals("""{"status":"done","after_id":null,"before_id":null}""", taskMoveJson("done", TaskNeighbors.NONE).toString())
        // PATCH: only the status (「自分のタスク」's checkbox).
        assertEquals("""{"status":"done"}""", TaskUpdate(status = "done").toJson().toString())
    }

    @Test
    fun taskOutIsDecodedAsTheServerSendsIt() {
        val json = """{"id":"t1","channel_id":null,"channel_name":null,"owner_id":"u-me","title":"買い物","notes":null,"status":"doing",
            "position":1024.5,"due_on":"2026-10-05","assignee_ids":[],"source":{"message_id":null,"channel_id":"c-dm","excerpt":null},
            "completed_at":null,"completed_by":null,"created_at":"2026-10-01T00:00:00Z","updated_at":"2026-10-01T01:00:00Z","can_delete":true,"later":1}"""
        val decoded = Codec.snake.decodeFromString(TaskOut.serializer(), json)
        assertNull(decoded.channelId)
        assertEquals("doing", decoded.status)
        assertEquals(1024.5, decoded.position, 0.0)
        assertEquals("2026-10-05", decoded.dueOn)
        assertEquals(TaskSource.Deleted, TaskRules.sourceState(decoded))
        assertTrue(decoded.canDelete)
    }
}
