package jp.chikuwachat.android

import jp.chikuwachat.android.TaskFixtures.channel
import jp.chikuwachat.android.TaskFixtures.task
import jp.chikuwachat.android.api.ApiException
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.TaskCreate
import jp.chikuwachat.android.api.TaskKind
import jp.chikuwachat.android.api.TaskNeighbors
import jp.chikuwachat.android.api.TaskOut
import jp.chikuwachat.android.api.TaskUpdate
import jp.chikuwachat.android.sync.TaskApi
import jp.chikuwachat.android.sync.TaskHub
import jp.chikuwachat.android.sync.TaskListState
import jp.chikuwachat.android.ui.DeadlineGroupKey
import jp.chikuwachat.android.ui.DeadlineRules
import jp.chikuwachat.android.ui.DeadlineTone
import jp.chikuwachat.android.ui.MainNav
import jp.chikuwachat.android.ui.RepeatKind
import jp.chikuwachat.android.ui.Route
import jp.chikuwachat.android.ui.TaskCreateInit
import jp.chikuwachat.android.ui.TaskDraft
import jp.chikuwachat.android.ui.TaskRules
import jp.chikuwachat.android.ui.deadlinesNote
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
import org.junit.Rule
import org.junit.Test
import java.time.Instant

/**
 * M86 (DEADLINES.md §8): deadlines on Android — the desktop's tests/deadlines.test.tsx examples ported (the remaining-days
 * text, whether one has passed, the channel's next one, the four sections, the create and change bodies, the hub's window
 * in and out, 422 = unsupported), and the decoding, the form's switch and the 「締切」 tile's route.
 */
class DeadlinesTest {
    @get:Rule val tokyo = TokyoZone()

    private val today = "2026-10-07" // a Wednesday
    private val now: Instant = Instant.parse("2026-10-07T03:00:00Z") // 12:00 in Tokyo

    private fun deadline(title: String, dueOn: String, status: String = "todo", channelId: String = "c-lab", dueAt: String? = null, completedAt: String? = null) =
        task(title, dueOn = dueOn, status = status, channelId = channelId, completedAt = completedAt)
            .copy(kind = TaskKind.DEADLINE, noticeDays = listOf(7, 3, 1, 0), dueAt = dueAt)

    private fun at(dueOn: String, dueAt: String? = null) = task("x", dueOn = dueOn).copy(kind = TaskKind.DEADLINE, dueAt = dueAt)

    // --- the rules ---------------------------------------------------------------------------------

    @Test fun saysHowFarADeadlineIs() {
        assertEquals("今日", DeadlineRules.remainingText(at("2026-10-07"), today))
        assertEquals("今日 17:00", DeadlineRules.remainingText(at("2026-10-07", "2026-10-07T08:00:00Z"), today))
        assertEquals("明日", DeadlineRules.remainingText(at("2026-10-08"), today))
        assertEquals("明日 9:30", DeadlineRules.remainingText(at("2026-10-08", "2026-10-08T00:30:00Z"), today))
        assertEquals("あと 3 日", DeadlineRules.remainingText(at("2026-10-10"), today))
        assertEquals("全国大会 原稿 あと 3 日", DeadlineRules.chipText(deadline("全国大会 原稿", "2026-10-10"), today))
        assertEquals("10/9 (金)", DeadlineRules.whenText(at("2026-10-09"), today))
        assertEquals("10/9 (金) 17:00", DeadlineRules.whenText(at("2026-10-09", "2026-10-09T08:00:00Z"), today))
        assertEquals("今日 17:00", DeadlineRules.whenText(at("2026-10-07", "2026-10-07T08:00:00Z"), today))
        assertEquals("2027/1/8 (金)", DeadlineRules.whenText(at("2027-01-08"), today))
        assertEquals("7 日前・3 日前・前日・当日", DeadlineRules.noticeSummary(listOf(0, 7, 1, 3)))
        assertEquals("通知しない", DeadlineRules.noticeSummary(emptyList()))
        assertEquals("通知しない", DeadlineRules.noticeSummary(null))
    }

    @Test fun theChipsToneFollowsHowClose() {
        assertEquals(DeadlineTone.SOON, DeadlineRules.tone(at("2026-10-07"), today))
        assertEquals(DeadlineTone.SOON, DeadlineRules.tone(at("2026-10-08"), today))
        assertEquals(DeadlineTone.WEEK, DeadlineRules.tone(at("2026-10-09"), today))
        assertEquals(DeadlineTone.WEEK, DeadlineRules.tone(at("2026-10-14"), today))
        assertEquals(DeadlineTone.LATER, DeadlineRules.tone(at("2026-10-15"), today))
    }

    @Test fun knowsWhenItHasPassedAndPicksTheChannelsNextOpenOne() {
        assertTrue(DeadlineRules.passed(at("2026-10-06"), today, now))
        assertFalse(DeadlineRules.passed(at("2026-10-07"), today, now))
        assertTrue(DeadlineRules.passed(at("2026-10-07", "2026-10-07T02:00:00Z"), today, now))
        assertFalse(DeadlineRules.passed(at("2026-10-07", "2026-10-07T08:00:00Z"), today, now))
        val past = deadline("過ぎた", "2026-10-06")
        val done = deadline("済み", "2026-10-08", status = "done", completedAt = "2026-10-05T00:00:00Z")
        val later = deadline("後", "2026-10-20")
        val soon = deadline("次", "2026-10-09")
        val elsewhere = deadline("他", "2026-10-08", channelId = "c-other")
        val plain = task("ただのタスク", dueOn = "2026-10-08")
        assertEquals("次", DeadlineRules.next(listOf(past, done, later, soon, elsewhere, plain), "c-lab", today, now)?.title)
        assertNull(DeadlineRules.next(listOf(past, done), "c-lab", today, now))
        // The same day: a timed one comes before the whole-day one; a timed one already over is skipped.
        val wholeDay = deadline("終日", "2026-10-07")
        val timed = deadline("17 時", "2026-10-07", dueAt = "2026-10-07T08:00:00Z")
        val morning = deadline("朝", "2026-10-07", dueAt = "2026-10-07T00:00:00Z")
        assertEquals("17 時", DeadlineRules.next(listOf(wholeDay, timed, morning), "c-lab", today, now)?.title)
    }

    @Test fun groupsThisWeekThisMonthLaterAndPast() {
        val rows = listOf(
            deadline("土曜", "2026-10-10"),
            deadline("今日", "2026-10-07"),
            deadline("日曜", "2026-10-11"),
            deadline("月末", "2026-10-31"),
            deadline("来月", "2026-11-02"),
            deadline("昨日", "2026-10-06"),
            deadline("先週", "2026-09-30", status = "done", completedAt = "2026-09-29T00:00:00Z"),
            task("タスク", dueOn = "2026-10-08"),
        )
        val groups = DeadlineRules.groups(rows, today, now)
        assertEquals(
            listOf(
                "今週" to listOf("今日", "土曜"),
                "今月" to listOf("日曜", "月末"),
                "それ以降" to listOf("来月"),
                "過ぎたもの" to listOf("昨日", "先週"),
            ),
            groups.map { group -> group.label to group.tasks.map { it.title } },
        )
        // Empty sections are left out.
        assertEquals(listOf(DeadlineGroupKey.LATER), DeadlineRules.groups(listOf(deadline("先", "2026-12-01")), today, now).map { it.key })
    }

    @Test fun theNoticeChecksKeepOtherDaysAndTheServersOrder() {
        assertEquals(listOf(14, 7, 3, 1, 0), DeadlineRules.noticeChoices(listOf(7, 3)))
        assertEquals(listOf(30, 14, 7, 3, 1, 0), DeadlineRules.noticeChoices(listOf(30, 1)))
        assertEquals(listOf(7, 3, 0), DeadlineRules.toggleNotice(listOf(0, 7), 3, true))
        assertEquals(listOf(7), DeadlineRules.toggleNotice(listOf(0, 7), 0, false))
        assertTrue(DeadlineRules.sameNoticeDays(listOf(0, 3, 7, 1), listOf(7, 3, 1, 0)))
        assertEquals(listOf("14 日前", "前日", "当日"), listOf(14, 1, 0).map { DeadlineRules.noticeLabel(it) })
    }

    // --- the form ----------------------------------------------------------------------------------

    @Test fun theDraftNeedsADateAndNoticesGoWithANewDeadlineAndChangeAlone() {
        val draft = TaskDraft(title = "原稿", noticeDays = listOf(1, 7))
        assertEquals("締切の日付を入れてください", TaskRules.draftProblem(draft, deadline = true))
        assertNull(TaskRules.draftProblem(draft))
        val init = DeadlineRules.createInit("c-lab", emptyList())
        val body = TaskRules.taskCreateBody(draft.copy(dueOn = "2026-10-20"), "c-lab", init, "k1", "Asia/Tokyo")
        assertEquals(TaskKind.DEADLINE, body.kind)
        assertEquals("c-lab", body.channelId)
        assertEquals("2026-10-20", body.dueOn)
        assertEquals(listOf(7, 1), body.noticeDays)
        assertNull(body.rrule)
        val json = Codec.snake.encodeToJsonElement(TaskCreate.serializer(), body).jsonObject
        assertEquals(JsonArray(listOf(JsonPrimitive(7), JsonPrimitive(1))), json["notice_days"])
        assertEquals(JsonPrimitive("deadline"), json["kind"])
        assertFalse(json.containsKey("rrule"))
        // A repeat picked as a task is dropped once it is a deadline; a plain task sends no notices.
        val weekly = TaskRules.withDueOn(TaskDraft(title = "週報"), "2026-10-20").let { it.copy(repeat = it.repeat.copy(kind = RepeatKind.WEEKLY)) }
        assertEquals(RepeatKind.NONE, TaskRules.asKind(weekly, TaskKind.DEADLINE).repeat.kind)
        assertEquals(DeadlineRules.DEFAULT_NOTICE_DAYS, TaskRules.asKind(weekly, TaskKind.DEADLINE).noticeDays)
        assertNull(TaskRules.asKind(TaskRules.asKind(weekly, TaskKind.DEADLINE), TaskKind.TASK).noticeDays)
        assertNull(TaskRules.taskCreateBody(weekly, "c-lab", TaskCreateInit(channelId = "c-lab"), "k2", "Asia/Tokyo").noticeDays)
        // The form's kind wins over the init's (the switch back to タスク).
        assertNull(TaskRules.taskCreateBody(draft.copy(dueOn = "2026-10-20"), "c-lab", init, "k3", "Asia/Tokyo", kind = TaskKind.TASK).kind)
        // Saved: the same days in any order change nothing; others send the whole set; never a rule.
        val saved = deadline("原稿", "2026-10-20")
        assertTrue(TaskRules.taskPatch(saved, TaskRules.draftFromTask(saved).copy(noticeDays = listOf(0, 3, 7, 1)), "Asia/Tokyo").isEmpty)
        val changed = TaskRules.taskPatch(saved, TaskRules.draftFromTask(saved).copy(noticeDays = listOf(1)), "Asia/Tokyo")
        assertEquals(listOf(1), changed.noticeDays)
        assertFalse(changed.setRrule)
        assertEquals("""{"notice_days":[1]}""", changed.toJson().toString())
        assertEquals("""{"notice_days":[]}""", TaskUpdate(noticeDays = emptyList()).toJson().toString())
    }

    @Test fun theSwitchShowsOnlyForANewBoardTask() {
        assertTrue(TaskCreateInit(channelId = "c-lab", boardChoices = listOf("c-lab")).canBeDeadline)
        assertTrue(DeadlineRules.createInit("c-a", listOf("c-a", "c-b")).canBeDeadline)
        assertEquals(listOf("c-a", "c-b"), DeadlineRules.createInit("c-a", listOf("c-b", "c-a")).boardChoices)
        assertFalse(TaskCreateInit(channelId = "c-lab", sourceMessageId = "m1").canBeDeadline) // 「タスクにする」
        assertFalse(TaskCreateInit(channelId = "c-lab", kind = TaskKind.REVIEW).canBeDeadline)
        assertFalse(TaskCreateInit(channelId = null, dmChannelId = "d1").canBeDeadline)
        assertFalse(TaskCreateInit(channelId = null, sourceCanvasId = "cv1").canBeDeadline)
        // Who may add one: whoever may change the board, never a guest; no board in a DM.
        assertTrue(DeadlineRules.canAdd(channel("c-lab"), isAdmin = false, isGuest = false))
        assertFalse(DeadlineRules.canAdd(channel("c-lab"), isAdmin = false, isGuest = true))
        assertFalse(DeadlineRules.canAdd(channel("d1", type = "dm"), isAdmin = false, isGuest = false))
        assertFalse(DeadlineRules.canAdd(channel("c-news", postingPolicy = "owners"), isAdmin = false, isGuest = false))
    }

    @Test fun aCardSaysSo() {
        assertEquals("締切 10/9", TaskRules.cardDueText(deadline("a", "2026-10-09"), today))
        assertEquals("期限 10/9", TaskRules.cardDueText(task("b", dueOn = "2026-10-09"), today))
    }

    // --- decoding ----------------------------------------------------------------------------------

    @Test fun aDeadlineDecodesWithItsNoticesAndAnOlderTaskWithout() {
        fun decode(text: String) = Codec.snake.decodeFromJsonElement(TaskOut.serializer(), Codec.plain.parseToJsonElement(text).jsonObject)
        val made = decode("""{"id":"t1","channel_id":"c-lab","owner_id":"u","title":"原稿","kind":"deadline","due_on":"2026-10-20","notice_days":[7,3,1,0],"created_at":"x","updated_at":"x"}""")
        assertEquals(TaskKind.DEADLINE, made.kind)
        assertEquals(listOf(7, 3, 1, 0), made.noticeDays)
        val old = decode("""{"id":"t2","channel_id":"c-lab","owner_id":"u","title":"a","created_at":"x","updated_at":"x"}""")
        assertEquals(TaskKind.TASK, old.kind)
        assertNull(old.noticeDays)
        // A kind still to come reads as a task: no ⏰, no window.
        val later = decode("""{"id":"t3","channel_id":"c-lab","owner_id":"u","title":"a","kind":"later_kind","due_on":"2099-01-01","created_at":"x","updated_at":"x"}""")
        assertFalse(DeadlineRules.isDeadline(later))
        assertFalse(DeadlineRules.inWindow(later, today))
        assertEquals(emptyList<Int>(), TaskRules.draftFromTask(made.copy(noticeDays = emptyList())).noticeDays)
        assertNull(TaskRules.draftFromTask(old).noticeDays)
    }

    // --- the hub's window --------------------------------------------------------------------------

    private class Api(var deadlines: List<TaskOut>? = emptyList()) : TaskApi {
        var reads = 0
        var failure: Exception? = null
        override suspend fun listTasks(channelId: String, includeDone: String) = emptyList<TaskOut>()
        override suspend fun myTasks() = emptyList<TaskOut>()
        override suspend fun requestedTasks() = emptyList<TaskOut>()
        override suspend fun dueTasks(from: String, to: String) = emptyList<TaskOut>()
        override suspend fun getTask(taskId: String) = deadlines!!.first { it.id == taskId }
        override suspend fun createTask(body: TaskCreate) = task(body.title, channelId = body.channelId, dueOn = body.dueOn)
            .copy(kind = body.kind ?: TaskKind.TASK, noticeDays = body.noticeDays, updatedAt = "2026-10-07T00:00:00Z")
        override suspend fun updateTask(taskId: String, patch: TaskUpdate) = deadlines!!.first { it.id == taskId }
        override suspend fun moveTask(taskId: String, status: String, neighbors: TaskNeighbors) = deadlines!!.first { it.id == taskId }
        override suspend fun deleteTask(taskId: String) {}
        override suspend fun deadlineTasks(): List<TaskOut>? {
            reads += 1
            failure?.let { throw it }
            return deadlines
        }
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined)

    private fun hub(api: TaskApi) = TaskHub(api, scope, { "u-me" }, { "2026-10-07T03:00:00Z" })

    private fun updated(task: TaskOut) = JsonObject(
        mapOf("task" to Codec.snake.encodeToJsonElement(TaskOut.serializer(), task), "deleter_ids" to JsonArray(emptyList())),
    )

    @Test fun theWindowIsReadOnceAndKeptByTheEvents() = runBlocking {
        val soon = deadline("原稿", "2099-01-10")
        val api = Api(listOf(soon))
        val hub = hub(api)
        assertNull(hub.deadlineList())
        hub.openDeadlines()
        hub.openDeadlines()
        assertEquals(1, api.reads)
        assertEquals(listOf("原稿"), hub.deadlineList()!!.tasks.map { it.title })
        assertEquals(TaskListState.READY, hub.deadlineList()!!.state)
        // A new deadline comes in, a plain task does not; a deadline deleted goes.
        val next = deadline("奨学金", "2099-02-01")
        hub.applyEvent("task.updated", updated(next))
        hub.applyEvent("task.updated", updated(task("ただのタスク", dueOn = "2099-01-01")))
        assertEquals(listOf("原稿", "奨学金"), hub.deadlineList()!!.tasks.map { it.title }.sorted())
        hub.applyEvent("task.deleted", JsonObject(mapOf("id" to JsonPrimitive(soon.id), "channel_id" to JsonPrimitive("c-lab"))))
        assertEquals(listOf("奨学金"), hub.deadlineList()!!.tasks.map { it.title })
        // Moved to more than 30 days ago: it leaves (the server would not send it either); 30 days ago still fits.
        hub.applyEvent("task.updated", updated(next.copy(dueOn = "2026-09-06", updatedAt = "2026-10-02T00:00:00Z")))
        assertEquals(emptyList<TaskOut>(), hub.deadlineList()!!.tasks)
        hub.applyEvent("task.updated", updated(next.copy(dueOn = "2026-09-07", updatedAt = "2026-10-03T00:00:00Z")))
        assertEquals(1, hub.deadlineList()!!.tasks.size)
        assertEquals(next.id, hub.find(next.id)?.id)
        // Leaving the channel takes its deadlines away.
        hub.removeChannel("c-lab")
        assertEquals(emptyList<TaskOut>(), hub.deadlineList()!!.tasks)
        assertFalse(DeadlineRules.inWindow(at("2000-01-01"), today))
        assertFalse(DeadlineRules.inWindow(task("自分の", channelId = null, dueOn = "2099-01-01").copy(kind = TaskKind.DEADLINE), today))
    }

    @Test fun aDeadlineMadeHereJoinsTheWindowAndReconnectingReadsItAgain() = runBlocking {
        val api = Api(emptyList())
        val hub = hub(api)
        hub.openDeadlines()
        hub.create(TaskRules.taskCreateBody(TaskDraft(title = "修論", dueOn = "2099-02-01"), "c-lab", DeadlineRules.createInit("c-lab", emptyList()), "k", "Asia/Tokyo"))
        assertEquals(listOf("修論"), hub.deadlineList()!!.tasks.map { it.title })
        api.deadlines = listOf(deadline("学会", "2099-03-01"))
        hub.online()
        assertEquals(2, api.reads)
        assertEquals(listOf("学会"), hub.deadlineList()!!.tasks.map { it.title })
        hub.refreshDeadlines() // back in the foreground
        assertEquals(3, api.reads)
        hub.stop()
        assertNull(hub.deadlineList())
    }

    @Test fun anOlderServerLeavesItUnsupported() = runBlocking {
        for (error in listOf(ApiException.Api(422, "validation_error", "x"), ApiException.Api(404, "not_found", "x"))) {
            val api = Api().also { it.failure = error }
            val hub = hub(api)
            hub.openDeadlines()
            assertEquals(TaskListState.UNSUPPORTED, hub.deadlineList()!!.state)
            hub.openDeadlines() // not read again
            assertEquals(1, api.reads)
            assertEquals("このサーバは締切に対応していません", deadlinesNote(hub.deadlineList()!!.state, available = true))
        }
        // A fake without the endpoint: the same.
        val plain = hub(Api(deadlines = null))
        plain.openDeadlines()
        assertEquals(TaskListState.UNSUPPORTED, plain.deadlineList()!!.state)
        // Another refusal fails it; opening again (or reconnecting) reads it again.
        val api = Api().also { it.failure = ApiException.Api(500, "internal", "x") }
        val broken = hub(api)
        broken.openDeadlines()
        assertEquals(TaskListState.FAILED, broken.deadlineList()!!.state)
        assertEquals("締切を読み込めませんでした。再接続すると読み直します", deadlinesNote(TaskListState.FAILED, available = true))
        api.failure = null
        broken.openDeadlines()
        assertEquals(TaskListState.READY, broken.deadlineList()!!.state)
        assertNull(deadlinesNote(TaskListState.READY, available = true))
    }

    // --- the tile ----------------------------------------------------------------------------------

    @Test fun 締切StaysBehindAConversationAndIsSaved() {
        val root = MainNav.root
        val list = MainNav.open(root, Route.Deadlines)
        assertEquals(root + Route.Deadlines, list)
        assertEquals(list, MainNav.decode(MainNav.encode(list)))
        assertTrue(Route.Deadlines.keptUnderConversation)
    }
}
