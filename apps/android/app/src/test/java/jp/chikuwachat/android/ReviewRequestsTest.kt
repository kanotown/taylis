package jp.chikuwachat.android

import jp.chikuwachat.android.TaskFixtures.channel
import jp.chikuwachat.android.TaskFixtures.task
import jp.chikuwachat.android.api.ChannelOut
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.MembershipOut
import jp.chikuwachat.android.api.MessageOut
import jp.chikuwachat.android.api.MessageTaskOut
import jp.chikuwachat.android.api.TaskAssigned
import jp.chikuwachat.android.api.TaskCreate
import jp.chikuwachat.android.api.TaskKind
import jp.chikuwachat.android.api.TaskNeighbors
import jp.chikuwachat.android.api.TaskOut
import jp.chikuwachat.android.api.TaskReviewDone
import jp.chikuwachat.android.api.TaskUpdate
import jp.chikuwachat.android.api.UserPublic
import jp.chikuwachat.android.sync.ChannelState
import jp.chikuwachat.android.sync.EngineOptions
import jp.chikuwachat.android.sync.EngineStatus
import jp.chikuwachat.android.sync.MessageState
import jp.chikuwachat.android.sync.Store
import jp.chikuwachat.android.sync.SyncEngine
import jp.chikuwachat.android.sync.TaskApi
import jp.chikuwachat.android.sync.TaskHub
import jp.chikuwachat.android.sync.TaskListState
import jp.chikuwachat.android.sync.TaskNotice
import jp.chikuwachat.android.sync.toOut
import jp.chikuwachat.android.ui.TaskChip
import jp.chikuwachat.android.ui.TaskChipTone
import jp.chikuwachat.android.ui.TaskRules
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * L9 (M64, REVIEWS.md): review requests on top of tasks — the wire shapes (TaskOut.kind, MessageOut.tasks, POST /tasks'
 * kind), the rows kept with messages, the chip under a message, 「レビューを依頼」's form, DM tasks, 「自分が依頼した」 and
 * the notices.
 */
class ReviewRequestsTest {
    private val names = mapOf("u-kano" to "加納", "u-ebi" to "海老", "u-ika" to "烏賊")
    private val nameOf: (String) -> String? = { names[it] }

    private fun mt(kind: String = TaskKind.REVIEW, status: String = "todo", assignees: List<String> = listOf("u-kano"), due: String? = "2026-10-09") =
        MessageTaskOut("t1", kind, status, assignees, due, "u-me")

    // --- chips ---------------------------------------------------------------------------------

    @Test fun aReviewChipSaysWhoItsStateAndTheDate() {
        val today = "2026-10-02"
        assertEquals(TaskChip("t1", "レビュー依頼 · 加納 · 依頼中 · 10/9 まで", TaskChipTone.OPEN), TaskRules.chip(mt(), today, nameOf))
        assertEquals("レビュー依頼 · 加納 · 対応中 · 10/9 まで", TaskRules.chip(mt(status = "doing"), today, nameOf).text)
        // Done: grey, no date.
        val done = TaskRules.chip(mt(status = "done"), today, nameOf)
        assertEquals("レビュー依頼 · 加納 · 完了", done.text)
        assertEquals(TaskChipTone.DONE, done.tone)
        // Past its date and open: red; today: 「今日まで」.
        assertEquals(TaskChipTone.OVERDUE, TaskRules.chip(mt(due = "2026-10-01"), today, nameOf).tone)
        assertEquals(TaskChipTone.DONE, TaskRules.chip(mt(status = "done", due = "2026-10-01"), today, nameOf).tone)
        assertEquals("レビュー依頼 · 加納 · 依頼中 · 今日まで", TaskRules.chip(mt(due = today), today, nameOf).text)
        assertEquals(TaskChipTone.OPEN, TaskRules.chip(mt(due = today), today, nameOf).tone)
        // Another year's date carries the year; no date: none.
        assertEquals("レビュー依頼 · 加納 · 依頼中 · 2027/1/5 まで", TaskRules.chip(mt(due = "2027-01-05"), today, nameOf).text)
        assertEquals("レビュー依頼 · 加納 · 依頼中", TaskRules.chip(mt(due = null), today, nameOf).text)
    }

    @Test fun aTaskChipUsesTheTaskWordsAndShortensTheNames() {
        val today = "2026-10-02"
        assertEquals("タスク · 加納、海老 · 未着手 · 10/9 まで", TaskRules.chip(mt(kind = "task", assignees = listOf("u-kano", "u-ebi")), today, nameOf).text)
        assertEquals("タスク · 加納、海老 ほか 1 人 · 進行中", TaskRules.chip(mt(kind = "task", status = "doing", assignees = listOf("u-kano", "u-ebi", "u-ika"), due = null), today, nameOf).text)
        assertEquals("タスク · 完了", TaskRules.chip(mt(kind = "task", status = "done", assignees = emptyList()), today, nameOf).text)
        assertEquals("タスク · ? · 未着手", TaskRules.chip(mt(kind = "task", assignees = listOf("u-gone"), due = null), today, nameOf).text)
        // An unknown kind reads as a task.
        assertEquals("タスク · 加納 · 未着手", TaskRules.chip(mt(kind = "later", due = null), today, nameOf).text)
    }

    // --- decoding and the rows kept with messages ----------------------------------------------

    private val wire = """
        {"id": "m1", "channel_id": "c1", "sender_id": "u1", "seq": 3, "updated_seq": 9, "body": "原稿です", "created_at": "2026-10-02T01:00:00Z",
         "deleted": false, "tasks": [{"id": "t1", "kind": "review", "status": "doing", "assignee_ids": ["u-kano"], "due_on": "2026-10-09", "owner_id": "u1"},
         {"id": "t2", "kind": "task", "status": "todo", "assignee_ids": [], "due_on": null, "owner_id": "u1", "extra": 1}]}
    """.trimIndent()

    @Test fun messageTasksDecodeAndSurvivePersistence() {
        val message = Codec.snake.decodeFromString(MessageOut.serializer(), wire)
        assertEquals(listOf(MessageTaskOut("t1", "review", "doing", listOf("u-kano"), "2026-10-09", "u1"), MessageTaskOut("t2", "task", "todo", emptyList(), null, "u1")), message.tasks)
        val state = MessageState.from(message)
        val persisted = Codec.plain.decodeFromString(MessageState.serializer(), Codec.plain.encodeToString(MessageState.serializer(), state))
        assertEquals(message.tasks, persisted.tasks)
        assertEquals(message.tasks, persisted.toOut()?.tasks)
        // A server before M63 (no tasks), and a row persisted before M64: none.
        val old = Codec.snake.decodeFromString(MessageOut.serializer(), wire.substringBefore(", \"tasks\"") + "}")
        assertEquals(emptyList<MessageTaskOut>(), old.tasks)
        val oldRow = """{"id":"m1","channelId":"c1","senderId":"u1","seq":3,"updatedSeq":9,"clientMsgId":null,"body":"x","createdAt":"2026-10-02T01:00:00Z"}"""
        assertEquals(emptyList<MessageTaskOut>(), Codec.plain.decodeFromString(MessageState.serializer(), oldRow).tasks)
        // A sparse entry takes the defaults.
        assertEquals(MessageTaskOut("t3"), Codec.snake.decodeFromString(MessageTaskOut.serializer(), """{"id":"t3"}"""))
    }

    @Test fun taskKindOnTheWire() {
        val review = Codec.snake.decodeFromString(TaskOut.serializer(), """{"id":"t1","channel_id":null,"channel_name":null,"owner_id":"u","title":"x","kind":"review"}""")
        assertEquals("review", review.kind)
        assertEquals("task", Codec.snake.decodeFromString(TaskOut.serializer(), """{"id":"t1","title":"x"}""").kind)
        // POST /tasks: kind only for a review (a plain task leaves it to the server's default).
        val plain = Codec.snake.encodeToJsonElement(TaskCreate.serializer(), TaskCreate(title = "x")).jsonObject
        assertFalse("kind" in plain)
        val asked = Codec.snake.encodeToJsonElement(TaskCreate.serializer(), TaskCreate(channelId = "dm", title = "x", kind = "review", sourceMessageId = "m1", assigneeIds = listOf("u"))).jsonObject
        assertEquals(JsonPrimitive("review"), asked["kind"])
        assertEquals(JsonPrimitive("m1"), asked["source_message_id"])
        // task.assigned's kind, task.review_done.
        assertEquals("review", Codec.snake.decodeFromString(TaskAssigned.serializer(), """{"task_id":"t","channel_id":"c","kind":"review"}""").kind)
        assertEquals("task", Codec.snake.decodeFromString(TaskAssigned.serializer(), """{"task_id":"t","channel_id":"c"}""").kind)
        assertEquals(TaskReviewDone("t", "c", "", "原稿", "u-kano"), Codec.snake.decodeFromString(TaskReviewDone.serializer(), """{"task_id":"t","channel_id":"c","channel_name":"","title":"原稿","by_user_id":"u-kano"}"""))
    }

    @Test fun messageUpdatedWithChangeTasksReachesTheRow() = runBlocking {
        val server = FakeServer()
        val alice = server.addUser("alice")
        val bob = server.addUser("bob")
        val channel = server.createChannel("lab", alice.id)
        server.join(channel.id, bob.id)
        val store = Store()
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val time = ManualTime()
        val engine = SyncEngine(
            server.api(bob.id), server.connector(bob.id), "ws://fake", store, { "token" }, scope,
            EngineOptions(reconnectMinMs = 0, sleep = {}, random = { 0.5 }, clock = time.clock, timer = time.timer),
        )
        engine.isActive = { false }
        suspend fun settle() { repeat(20) { engine.idle(); yield() } }
        engine.start(); engine.openChannel(channel.id); settle()

        val (post, _) = server.post(channel.id, alice.id, "原稿を見てください")
        settle()
        assertEquals(emptyList<MessageTaskOut>(), store.message(channel.id, post.id)?.tasks)
        server.setTasks(channel.id, post.id, listOf(MessageTaskOut("t1", "review", "todo", listOf(bob.id), "2026-10-09", alice.id)))
        settle()
        assertEquals("todo", store.message(channel.id, post.id)?.tasks?.single()?.status)
        // Across a dropped connection: the catch-up brings the row with its tasks as they are now.
        server.disconnect(bob.id)
        server.setTasks(channel.id, post.id, listOf(MessageTaskOut("t1", "review", "done", listOf(bob.id), "2026-10-09", alice.id)))
        repeat(50) { if (engine.status.value != EngineStatus.ONLINE) settle() }
        settle()
        assertEquals("done", store.message(channel.id, post.id)?.tasks?.single()?.status)
        assertEquals(server.channels.getValue(channel.id).channel.lastSeq, store.channel(channel.id)?.syncedSeq)
        engine.stop(); scope.cancel()
    }

    // --- 「レビューを依頼」 and DM tasks ----------------------------------------------------------

    private val users = mapOf("u-me" to UserPublic("u-me", "me", "自分", "member", null, "", ""))

    private fun dm(id: String, members: List<String>, type: String = "dm") = ChannelState(
        ChannelOut(
            id = id, type = type, name = null, archived = false, lastSeq = 0, createdAt = "2026-01-01T00:00:00Z", updatedAt = "2026-01-01T00:00:00Z",
            membership = MembershipOut("member", "2026-01-01T00:00:00Z"), dmUserIds = members,
        ),
        isMember = true,
    )

    @Test fun aReviewIsAskedInTheMessagesConversation() {
        val init = TaskRules.messageReviewInit("m1", "**修論** の第 3 章です", emptyList(), channel("lab"), users, emptyMap(), false, "u-me")!!
        assertEquals("lab", init.channelId)
        assertEquals(TaskKind.REVIEW, init.kind)
        assertTrue(init.isReview)
        assertEquals("レビュー：修論 の第 3 章です", init.title)
        assertEquals("修論 の第 3 章です", init.sourceExcerpt)
        assertEquals("m1", init.sourceMessageId)
        assertEquals(emptyList<String>(), init.assigneeIds)
        // The board stays (no 「自分のタスク」 for a review), assignees or not.
        assertEquals("lab", init.targetChannel("lab", emptyList()))
        // A 1:1 DM: the other person is asked already; a group DM: nobody yet.
        val one = TaskRules.messageReviewInit("m2", "見てください", emptyList(), dm("d1", listOf("u-me", "u-kano")), users, emptyMap(), false, "u-me")!!
        assertEquals("d1", one.channelId)
        assertEquals(listOf("u-kano"), one.assigneeIds)
        val group = TaskRules.messageReviewInit("m3", "x", emptyList(), dm("g1", listOf("u-me", "u-kano", "u-ebi"), "group_dm"), users, emptyMap(), false, "u-me")!!
        assertEquals(emptyList<String>(), group.assigneeIds)
        // The title is cut to 200.
        assertEquals(200, TaskRules.messageReviewInit("m4", "あ".repeat(300), emptyList(), channel("lab"), users, emptyMap(), false, "u-me")!!.title.length)
        // Where no shared task can be made: none.
        assertNull(TaskRules.messageReviewInit("m5", "x", emptyList(), channel("news", postingPolicy = "owners"), users, emptyMap(), false, "u-me"))
        assertNull(TaskRules.messageReviewInit("m5", "x", emptyList(), channel("old", archived = true), users, emptyMap(), false, "u-me"))
        assertNull(TaskRules.messageReviewInit("m5", "x", emptyList(), null, users, emptyMap(), false, "u-me"))
        assertTrue(TaskRules.canRequestReview(channel("news", postingPolicy = "owners", role = "owner"), false))
        assertFalse(TaskRules.canRequestReview(dm("d2", listOf("u-me")).copy(isMember = false), false))
    }

    @Test fun aDmTaskIsSharedOnlyWithAssignees() {
        val init = TaskRules.messageTaskInit("m1", "資料", emptyList(), dm("d1", listOf("u-me", "u-kano")), users, emptyMap(), false)
        assertNull(init.channelId)
        assertEquals("d1", init.dmChannelId)
        assertNull(init.targetChannel(null, emptyList()))
        assertEquals("d1", init.targetChannel(null, listOf("u-kano")))
        // A channel's 「タスクにする」 is as before.
        val board = TaskRules.messageTaskInit("m1", "資料", emptyList(), channel("lab"), users, emptyMap(), false)
        assertNull(board.dmChannelId)
        assertEquals("lab", board.targetChannel("lab", emptyList()))
        assertNull(board.targetChannel(null, listOf("u-kano")))
        // A review needs someone to ask.
        assertEquals("依頼先を選んでください", TaskRules.draftProblem(jp.chikuwachat.android.ui.TaskDraft("レビュー：x"), review = true))
        assertNull(TaskRules.draftProblem(jp.chikuwachat.android.ui.TaskDraft("レビュー：x", assigneeIds = listOf("u-kano")), review = true))
        assertNull(TaskRules.draftProblem(jp.chikuwachat.android.ui.TaskDraft("x")))
    }

    /** 2026-10-09: my own DM has nobody to share with or ask — a plain personal task, and no 「レビューを依頼」. */
    @Test fun myOwnDmKeepsTasksPersonal() {
        val notes = dm("n1", listOf("u-me"))
        assertFalse(TaskRules.hasOthers(notes))
        assertTrue(TaskRules.hasOthers(dm("d1", listOf("u-me", "u-kano"))))
        assertTrue(TaskRules.hasOthers(channel("lab")))
        assertNull(TaskRules.messageTaskInit("m1", "あとで読む", emptyList(), notes, users, emptyMap(), false).dmChannelId)
        assertFalse(TaskRules.canRequestReview(notes, false))
        assertNull(TaskRules.messageReviewInit("m1", "x", emptyList(), notes, users, emptyMap(), false, "u-me"))
        assertTrue(TaskRules.canRequestReview(dm("g1", listOf("u-me", "u-kano", "u-ebi"), "group_dm"), false))
        // A task already shared there stays mine to change.
        assertTrue(TaskRules.canEditTask(task("x", channelId = "n1", channelName = null), notes, false))
    }

    /** 2026-10-09 (「選択肢自分しかない」): 「タスク」's ＋ offers the boards I may add to beside 「自分のタスク」. */
    @Test fun aNewTaskFromMyTasksOffersMyBoards() {
        val boards = TaskRules.editableBoards(
            listOf(channel("zeta"), channel("alpha"), channel("news", postingPolicy = "owners"), channel("old", archived = true), dm("d1", listOf("u-me", "u-kano"))),
            false,
        )
        assertEquals(listOf("alpha", "zeta"), boards)
        val init = TaskRules.newTaskInit(boards)
        assertNull(init.channelId)
        assertEquals(listOf("alpha", "zeta"), init.boardChoices)
        assertNull(init.targetChannel(null, emptyList()))
        assertEquals("alpha", init.targetChannel("alpha", listOf("u-kano")))
    }

    @Test fun dmTasksAreEditableByItsMembersAndNamedAfterThem() {
        val shared = task("x", channelId = "d1", channelName = null)
        assertTrue(TaskRules.canEditTask(shared, dm("d1", listOf("u-me", "u-kano")), false))
        assertFalse(TaskRules.canEditTask(shared, dm("d1", listOf("u-me", "u-kano")).copy(isMember = false), false))
        assertFalse(TaskRules.canEditTask(shared, null, false))
        assertEquals("加納", TaskRules.placeLabel(shared) { if (it == "d1") "加納" else null })
        assertEquals("DM", TaskRules.placeLabel(shared))
        assertEquals("#lab", TaskRules.placeLabel(task("y")))
        assertEquals("自分のタスク", TaskRules.placeLabel(task("z", channelId = null)))
    }

    @Test fun anAssigneeGetsTheBigButtons() {
        val review = task("r", status = "todo", assignees = listOf("u-me", "u-kano")).copy(kind = TaskKind.REVIEW)
        assertEquals(listOf("doing", "done"), TaskRules.quickStatuses(review, "u-me"))
        assertEquals(listOf("done"), TaskRules.quickStatuses(review.copy(status = "doing"), "u-me"))
        assertEquals(emptyList<String>(), TaskRules.quickStatuses(review.copy(status = "done"), "u-me"))
        assertEquals(emptyList<String>(), TaskRules.quickStatuses(review, "u-ebi")) // the requester: no buttons
        assertEquals(emptyList<String>(), TaskRules.quickStatuses(task("p", channelId = null, assignees = listOf("u-me")), "u-me"))
        assertEquals(listOf("対応を始める", "完了にする"), listOf("doing", "done").map { TaskRules.quickLabel(it) })
        assertEquals(listOf("依頼中", "対応中", "完了"), listOf("todo", "doing", "done").map { TaskRules.label(TaskKind.REVIEW, it) })
        assertEquals(listOf("未着手", "進行中", "完了"), listOf("todo", "doing", "done").map { TaskRules.label(TaskKind.TASK, it) })
    }

    // --- 「自分が依頼した」 ------------------------------------------------------------------------

    @Test fun requestedIsWhatIMadeForSomeoneElse() {
        val mine = task("a", assignees = listOf("u-kano")).copy(ownerId = "u-me")
        assertTrue(TaskRules.isRequested(mine, "u-me"))
        assertFalse(TaskRules.isRequested(mine.copy(assigneeIds = listOf("u-me")), "u-me"))
        assertFalse(TaskRules.isRequested(mine.copy(ownerId = "u-kano"), "u-me"))
        assertFalse(TaskRules.isRequested(mine.copy(channelId = null), "u-me"))
        assertFalse(TaskRules.isRequested(mine, null))
        val (open, done) = TaskRules.sortRequested(
            listOf(
                task("none"), task("late", dueOn = "2026-10-20"), task("soon", dueOn = "2026-10-05"),
                task("d1", status = "done", completedAt = "2026-10-01T00:00:00Z"), task("d2", status = "done", completedAt = "2026-10-02T00:00:00Z"),
            ),
        )
        assertEquals(listOf("soon", "late", "none"), open.map { it.title })
        assertEquals(listOf("d2", "d1"), done.map { it.title })
    }

    private class Api(var requested: List<TaskOut>) : TaskApi {
        val calls = ArrayList<String>()
        override suspend fun listTasks(channelId: String, includeDone: String) = emptyList<TaskOut>()
        override suspend fun myTasks() = emptyList<TaskOut>()
        override suspend fun requestedTasks(): List<TaskOut> { calls += "requested"; return requested }
        override suspend fun dueTasks(from: String, to: String) = emptyList<TaskOut>()
        override suspend fun getTask(taskId: String) = task("read", id = taskId)
        override suspend fun createTask(body: TaskCreate) = task(body.title, channelId = body.channelId)
        override suspend fun updateTask(taskId: String, patch: TaskUpdate) = requested.first { it.id == taskId }.copy(status = patch.status ?: "todo", updatedAt = "2026-10-02T09:00:00Z")
        override suspend fun moveTask(taskId: String, status: String, neighbors: TaskNeighbors) = requested.first { it.id == taskId }
        override suspend fun deleteTask(taskId: String) {}
    }

    private fun updated(task: TaskOut): JsonObject =
        JsonObject(mapOf("task" to Codec.snake.encodeToJsonElement(TaskOut.serializer(), task), "deleter_ids" to JsonArray(emptyList())))

    @Test fun theRequestedWindowIsReadAndFollowsEvents() = runBlocking {
        val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)
        val a = task("a", channelId = "d1", channelName = null, assignees = listOf("u-kano")).copy(ownerId = "u-me", kind = TaskKind.REVIEW)
        val api = Api(listOf(a))
        val notices = ArrayList<TaskNotice>()
        val hub = TaskHub(api, scope, { "u-me" }, { "2026-10-02T03:00:00Z" }).also { it.onNotice = { n -> notices += n } }
        hub.openRequested()
        assertEquals(listOf("requested"), api.calls)
        assertEquals(TaskListState.READY, hub.requestedList()!!.state)
        assertEquals(a, hub.find(a.id))
        // A new request of mine joins; one handed to me alone leaves; a deleted one goes.
        val b = task("b", assignees = listOf("u-ebi")).copy(ownerId = "u-me")
        hub.applyEvent("task.updated", updated(b))
        assertEquals(setOf("a", "b"), hub.requestedList()!!.tasks.map { it.title }.toSet())
        hub.applyEvent("task.updated", updated(b.copy(assigneeIds = listOf("u-me"), updatedAt = "2026-10-02T01:00:00Z")))
        assertEquals(listOf("a"), hub.requestedList()!!.tasks.map { it.title })
        hub.applyEvent("task.updated", updated(a.copy(status = "done", updatedAt = "2026-10-02T02:00:00Z")))
        assertEquals("done", hub.requestedList()!!.tasks.single().status)
        hub.applyEvent("task.deleted", Codec.plain.parseToJsonElement("""{"id":"${a.id}","channel_id":"d1"}""").jsonObject)
        assertEquals(emptyList<TaskOut>(), hub.requestedList()!!.tasks)
        // Reconnecting reads it again; closing forgets it.
        hub.online()
        assertEquals(listOf("requested", "requested"), api.calls)
        hub.closeRequested()
        assertNull(hub.requestedList())
        // task.review_done is said like the push.
        hub.applyEvent("task.review_done", Codec.plain.parseToJsonElement("""{"task_id":"t9","channel_id":"d1","channel_name":"","title":"第 3 章","by_user_id":"u-kano"}""").jsonObject)
        val said = notices.single() as TaskNotice.ReviewDone
        assertEquals("加納 がレビューを完了しました：第 3 章", TaskRules.reviewDoneText(said.data, nameOf).body)
        scope.cancel()
    }

    @Test fun theAssignmentNoticeSaysReviewAndLeavesOutADmsName() {
        assertEquals(
            "加納 がレビューを依頼しました：第 3 章 (#lab)",
            TaskRules.assignedText(TaskAssigned("t1", "c-lab", "lab", "第 3 章", "u-kano", kind = TaskKind.REVIEW), nameOf).body,
        )
        assertEquals("加納 がタスクを割り当てました：資料", TaskRules.assignedText(TaskAssigned("t1", "d1", "", "資料", "u-kano"), nameOf).body)
    }
}
