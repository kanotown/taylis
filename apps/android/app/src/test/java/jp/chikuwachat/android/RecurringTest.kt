package jp.chikuwachat.android

import jp.chikuwachat.android.api.ChannelOut
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.CollectDue
import jp.chikuwachat.android.api.CollectSpec
import jp.chikuwachat.android.api.CollectTargets
import jp.chikuwachat.android.api.CollectionOut
import jp.chikuwachat.android.api.MembershipOut
import jp.chikuwachat.android.api.MessageOut
import jp.chikuwachat.android.api.ParentThread
import jp.chikuwachat.android.api.RecurringPostOut
import jp.chikuwachat.android.api.RecurringSchedule
import jp.chikuwachat.android.api.ReminderOut
import jp.chikuwachat.android.sync.ChannelState
import jp.chikuwachat.android.sync.EngineOptions
import jp.chikuwachat.android.sync.MessageState
import jp.chikuwachat.android.sync.Store
import jp.chikuwachat.android.sync.SyncEngine
import jp.chikuwachat.android.sync.toOut
import jp.chikuwachat.android.ui.Recurring
import jp.chikuwachat.android.ui.RecurringDraft
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/** L6 (M60, RECURRING.md): the desktop's tests/recurring.test.ts, case for case, then decoding, bodies and the store. */
class RecurringTest {
    private val tokyo = ZoneId.of("Asia/Tokyo")

    // --- summaries -----------------------------------------------------------------------------------------------

    @Test fun readsAScheduleTheWayPeopleSayIt() {
        assertEquals("9:00", Recurring.clockLabel("09:00"))
        assertEquals("18:30", Recurring.clockLabel("18:30"))
        assertEquals("毎週 月・木 9:00", Recurring.scheduleSummary(RecurringSchedule("weekly", weekdays = listOf(3, 0), time = "09:00")))
        assertEquals("毎日 8:15", Recurring.scheduleSummary(RecurringSchedule("weekly", weekdays = listOf(0, 1, 2, 3, 4, 5, 6), time = "08:15")))
        assertEquals("毎週 日 23:59", Recurring.scheduleSummary(RecurringSchedule("weekly", weekdays = listOf(6), time = "23:59")))
        assertEquals("毎月 1 日 9:00", Recurring.scheduleSummary(RecurringSchedule("monthly", day = 1, time = "09:00")))
        assertEquals("毎月 30 日 (ない月は末日) 9:00", Recurring.scheduleSummary(RecurringSchedule("monthly", day = 30, time = "09:00")))
        assertEquals("毎月 末日 18:00", Recurring.scheduleSummary(RecurringSchedule("monthly", day = 31, time = "18:00")))
        // Another zone than this device's is named.
        assertEquals("毎月 1 日 9:00 (America/New_York)", Recurring.scheduleSummary(RecurringSchedule("monthly", day = 1, time = "09:00"), "America/New_York", "Asia/Tokyo"))
        assertEquals("毎月 1 日 9:00", Recurring.scheduleSummary(RecurringSchedule("monthly", day = 1, time = "09:00"), "Asia/Tokyo", "Asia/Tokyo"))
        // A kind a newer server adds: its time, and the form does not offer to edit it.
        assertEquals("9:00 (このアプリでは表示できない予定)", Recurring.scheduleSummary(RecurringSchedule("yearly", time = "09:00")))
        assertFalse(Recurring.editable(post(schedule = RecurringSchedule("yearly"))))
        assertTrue(Recurring.editable(post()))
    }

    @Test fun readsTheDueTimeTheDateAndTheTargets() {
        assertEquals("当日 18:00 締切", Recurring.dueSummary(CollectDue(0, "18:00")))
        assertEquals("3 日後 9:30 締切", Recurring.dueSummary(CollectDue(3, "09:30")))
        assertEquals("10/9 (金) 18:00", Recurring.shortDateTime("2026-10-09T09:00:00Z", tokyo))
        assertEquals("10/5 (月) 0:05", Recurring.shortDateTime("2026-10-04T15:05:00Z", tokyo))
        assertEquals("10/9 (金) 18:00", Recurring.shortDateTime("2026-10-09T09:00:00+00:00", tokyo))
        assertEquals("", Recurring.shortDateTime("", tokyo))
        assertEquals("", Recurring.shortDateTime("soon", tokyo))
        val groups = mapOf("g1" to "students")
        val users = mapOf("u1" to "ボブ", "u2" to "キャロル")
        val due = CollectDue(1, "18:00")
        assertEquals("チャンネルの全員", Recurring.targetsSummary(CollectSpec(CollectTargets(allMembers = true, groupIds = listOf("g1")), due), groups::get, users::get))
        assertEquals("@students、ボブ、キャロル", Recurring.targetsSummary(CollectSpec(CollectTargets(groupIds = listOf("g1"), userIds = listOf("u1", "u2")), due), groups::get, users::get))
        assertEquals(
            "ボブ、キャロル、ボブ、キャロル ほか 2",
            Recurring.targetsSummary(CollectSpec(CollectTargets(userIds = listOf("u1", "u2", "u1", "u2", "u1", "u2")), due), groups::get, users::get),
        )
        // Someone no longer known.
        assertEquals("@グループ、?", Recurring.targetsSummary(CollectSpec(CollectTargets(groupIds = listOf("gx"), userIds = listOf("ux")), due), groups::get, users::get))
    }

    @Test fun explainsThePlaceholdersWithTodaysValues() {
        assertEquals(
            "{date} → 2026/09/28 (月)、{weekday} → 月、{week} → 週番号 (例 2026-W40)。投稿した日に置き換わります",
            Recurring.placeholderHint(LocalDate.of(2026, 9, 28)),
        )
        assertTrue(Recurring.placeholderHint(LocalDate.of(2027, 1, 1)).contains("(例 2026-W53)"))
    }

    // --- who manages -----------------------------------------------------------------------------------------------

    @Test fun ownersAndAdministratorsWhoAreMembersInChannelsOnly() {
        fun channel(type: String = "public", role: String? = "member", member: Boolean = true) = ChannelState(
            ChannelOut(
                id = "c", type = type, name = "lab", archived = false, lastSeq = 0, createdAt = "2026-10-01T00:00:00Z", updatedAt = "2026-10-01T00:00:00Z",
                membership = role?.let { MembershipOut(it, "2026-10-01T00:00:00Z") },
            ),
            isMember = member,
        )
        assertTrue(Recurring.canManage(channel(role = "owner"), isAdmin = false))
        assertTrue(Recurring.canManage(channel(), isAdmin = true))
        assertTrue(Recurring.canManage(channel(type = "private", role = "owner"), isAdmin = false))
        assertFalse(Recurring.canManage(channel(), isAdmin = false))
        assertFalse(Recurring.canManage(channel(member = false, role = null), isAdmin = true))
        assertFalse(Recurring.canManage(channel(type = "dm"), isAdmin = true))
        assertFalse(Recurring.canManage(channel(type = "group_dm", role = "owner"), isAdmin = false))
        assertFalse(Recurring.canManage(null, isAdmin = true))
    }

    // --- the form's draft --------------------------------------------------------------------------------------------

    private fun valid(change: (RecurringDraft) -> RecurringDraft = { it }) =
        change(Recurring.emptyDraft(LocalDate.of(2026, 10, 1)).copy(name = "週報", body = "**週報 {date}**"))

    @Test fun startsOnTodaysWeekdayAt9NotCollecting() {
        val draft = Recurring.emptyDraft(LocalDate.of(2026, 10, 1)) // a Thursday
        assertEquals("weekly", draft.kind)
        assertEquals(listOf(3), draft.weekdays)
        assertEquals("09:00", draft.time)
        assertFalse(draft.collect)
        assertEquals(3, draft.afterDays)
        assertEquals("18:00", draft.dueTime)
        assertEquals(listOf(6), Recurring.emptyDraft(LocalDate.of(2026, 10, 4)).weekdays) // Sunday
    }

    @Test fun namesWhatIsMissing() {
        assertNull(Recurring.problem(valid()))
        assertEquals("名前を入力してください", Recurring.problem(valid { it.copy(name = "  ") }))
        assertEquals("名前を入力してください", Recurring.problem(valid { it.copy(name = "　") }))
        assertEquals("名前は 40 文字までです", Recurring.problem(valid { it.copy(name = "あ".repeat(41)) }))
        // Spaces fold, as on the server.
        assertNull(Recurring.problem(valid { it.copy(name = "  ${"あ".repeat(20)}   ${"い".repeat(19)} ") }))
        // Counted in characters, not UTF-16 units.
        assertNull(Recurring.problem(valid { it.copy(name = "🍤".repeat(40)) }))
        assertEquals("本文を入力してください", Recurring.problem(valid { it.copy(body = "\n ") }))
        assertEquals("本文は 4000 文字までです", Recurring.problem(valid { it.copy(body = "x".repeat(4001)) }))
        assertEquals("曜日を 1 つ以上選んでください", Recurring.problem(valid { it.copy(weekdays = emptyList()) }))
        assertNull(Recurring.problem(valid { it.copy(kind = "monthly", weekdays = emptyList(), day = 31) }))
        assertEquals("日は 1〜31 で選んでください", Recurring.problem(valid { it.copy(kind = "monthly", day = 0) }))
        assertEquals("時刻を選んでください", Recurring.problem(valid { it.copy(time = "") }))
        assertEquals("時刻を選んでください", Recurring.problem(valid { it.copy(time = "24:00") }))
        assertEquals("提出する人を選んでください", Recurring.problem(valid { it.copy(collect = true) }))
        assertNull(Recurring.problem(valid { it.copy(collect = true, allMembers = true) }))
        assertNull(Recurring.problem(valid { it.copy(collect = true, groupIds = listOf("g")) }))
        assertEquals("締切は 0〜30 日後で選んでください", Recurring.problem(valid { it.copy(collect = true, userIds = listOf("u"), afterDays = 31) }))
        assertEquals("締切の時刻を選んでください", Recurring.problem(valid { it.copy(collect = true, userIds = listOf("u"), dueTime = "") }))
        // Collecting off: its fields do not matter.
        assertNull(Recurring.problem(valid { it.copy(collect = false, dueTime = "") }))
    }

    private fun json(text: String): JsonObject = Json.parseToJsonElement(text).jsonObject

    @Test fun makesTheRequestBodies() {
        assertEquals(
            json("""{"name":"週報","body":"**週報 {date}**","schedule":{"kind":"weekly","weekdays":[0,4],"time":"09:00"},"tz":"Asia/Tokyo","collect":null,"enabled":true}"""),
            Recurring.createBody(valid { it.copy(name = " 週報 ", weekdays = listOf(4, 0, 4)) }, "Asia/Tokyo"),
        )
        // A monthly schedule sends no weekdays (the server refuses the other kind's fields).
        assertEquals(
            json(
                """{"name":"週報","body":"**週報 {date}**","schedule":{"kind":"monthly","day":15,"time":"09:00"},
                |"collect":{"targets":{"all_members":false,"group_ids":["g"],"user_ids":["u"]},"due":{"after_days":0,"time":"17:00"}}}""".trimMargin(),
            ),
            Recurring.updateBody(valid { it.copy(kind = "monthly", day = 15, collect = true, groupIds = listOf("g"), userIds = listOf("u"), afterDays = 0, dueTime = "17:00") }),
        )
        // 「チャンネルの全員」 sends no names.
        assertEquals(
            json("""{"targets":{"all_members":true,"group_ids":[],"user_ids":[]},"due":{"after_days":3,"time":"18:00"}}"""),
            Recurring.createBody(valid { it.copy(collect = true, allMembers = true, userIds = listOf("u")) }, "Asia/Tokyo")["collect"],
        )
        // Collecting turned off is an explicit null (PATCH: "collect: null stops collecting"); the zone stays the post's.
        val off = Recurring.updateBody(valid())
        assertEquals(kotlinx.serialization.json.JsonNull, off["collect"])
        assertFalse("tz" in off)
        assertEquals(json("""{"enabled":false}"""), Recurring.enabledBody(false))
    }

    @Test fun readsAPostBack() {
        val stored = post(
            name = "日報", schedule = RecurringSchedule("monthly", day = 31, time = "18:00"),
            collect = CollectSpec(CollectTargets(groupIds = listOf("g")), CollectDue(2, "12:00")),
        )
        val draft = Recurring.draftFromPost(stored, LocalDate.of(2026, 10, 1))
        assertEquals("日報", draft.name)
        assertEquals("monthly", draft.kind)
        assertEquals(31, draft.day)
        assertEquals("18:00", draft.time)
        assertTrue(draft.collect)
        assertEquals(listOf("g"), draft.groupIds)
        assertEquals(2, draft.afterDays)
        assertEquals("12:00", draft.dueTime)
        assertEquals(listOf(3), draft.weekdays) // not weekly: today's weekday, for a switch to 毎週
        assertEquals(Codec.snake.encodeToJsonElement(CollectSpec.serializer(), stored.collect!!), Recurring.updateBody(draft)["collect"])
        // A post without collecting reads back with the defaults for turning it on.
        val plain = Recurring.draftFromPost(post(), LocalDate.of(2026, 10, 1))
        assertFalse(plain.collect)
        assertEquals(listOf(0, 3), plain.weekdays)
        assertEquals(3, plain.afterDays)
    }

    @Test fun theDraftSurvivesARotationAsJson() {
        val draft = valid { it.copy(collect = true, userIds = listOf("u1"), kind = "monthly", day = 30) }
        assertEquals(draft, Codec.plain.decodeFromString(RecurringDraft.serializer(), Codec.plain.encodeToString(RecurringDraft.serializer(), draft)))
    }

    // --- the collection chip ------------------------------------------------------------------------------------------

    private fun collection(submitted: List<String>, targets: List<String> = listOf("a", "b", "c"), due: String = "2026-10-09T09:00:00Z") =
        CollectionOut(dueAt = due, targetUserIds = targets, targetCount = targets.size, submittedUserIds = submitted, remindedAt = null)

    private val before = Instant.parse("2026-10-08T00:00:00Z")
    private val after = Instant.parse("2026-10-09T09:00:01Z")

    @Test fun countsAndDates() {
        assertEquals(Recurring.ChipState("提出 1/3 · 締切 10/9 (金) 18:00", null, overdue = false, complete = false), Recurring.chip(collection(listOf("a")), null, before, tokyo))
        val all = Recurring.chip(collection(listOf("a", "b", "c")), "z", after, tokyo)
        assertEquals("提出 3/3 · 締切 10/9 (金) 18:00", all.label)
        assertTrue(all.overdue)
        assertTrue(all.complete)
        val none = Recurring.chip(collection(emptyList(), emptyList()), "a", before, tokyo)
        assertEquals("提出 0/0 · 締切 10/9 (金) 18:00", none.label)
        assertNull(none.mine)
        assertFalse(none.complete)
        // Exactly at the due time it has passed (the server's `due_at <= now`).
        assertTrue(Recurring.chip(collection(emptyList()), null, Instant.parse("2026-10-09T09:00:00Z"), tokyo).overdue)
        // An incomplete row: no date, never overdue.
        val bare = Recurring.chip(CollectionOut(), "a", after, tokyo)
        assertEquals("提出 0/0", bare.label)
        assertFalse(bare.overdue)
    }

    @Test fun saysWhetherIOweOne() {
        assertEquals(Recurring.Mine.PENDING, Recurring.chip(collection(listOf("a")), "b", before, tokyo).mine)
        assertEquals(Recurring.Mine.SUBMITTED, Recurring.chip(collection(listOf("a")), "a", before, tokyo).mine)
        val late = Recurring.chip(collection(listOf("a")), "b", after, tokyo)
        assertEquals(Recurring.Mine.PENDING, late.mine)
        assertTrue(late.overdue)
    }

    @Test fun splitsTheTargetsInTheirOrder() {
        assertEquals(listOf("a", "c") to listOf("b"), Recurring.lists(collection(listOf("c", "a"))))
        // Someone who replied but is no target (the server would not list them) is not shown.
        assertEquals(listOf("a") to listOf("b", "c"), Recurring.lists(collection(listOf("a", "z"))))
    }

    @Test fun marksTheRemindersOthersCaused() {
        assertEquals("確認のお願い", Recurring.reminderBadge("ack"))
        assertEquals("提出のお願い", Recurring.reminderBadge("collect"))
        assertNull(Recurring.reminderBadge("personal"))
        assertNull(Recurring.reminderBadge("something_new"))
    }

    // --- decoding -----------------------------------------------------------------------------------------------------

    @Test fun decodesTheServersShapes() {
        val message = Codec.snake.decodeFromString(
            MessageOut.serializer(),
            """{"id":"m1","channel_id":"c1","sender_id":"bot","seq":5,"updated_seq":6,"body":"**週報 2026/10/05 (月)**","created_at":"2026-10-05T00:00:00Z","deleted":false,
               "collection":{"due_at":"2026-10-08T09:00:00Z","target_user_ids":["a","b"],"target_count":2,"submitted_user_ids":["a"],"reminded_at":null}}""",
        )
        assertEquals(CollectionOut("2026-10-08T09:00:00Z", listOf("a", "b"), 2, listOf("a"), null), message.collection)
        assertEquals(message.collection, MessageState.from(message).collection)
        assertEquals(message.collection, MessageState.from(message).toOut()?.collection)
        // A server before M59, and any other message: no key, or null.
        assertNull(Codec.snake.decodeFromString(MessageOut.serializer(), """{"id":"m2","channel_id":"c1","sender_id":"u","seq":1,"updated_seq":1,"body":"x","created_at":"","deleted":false}""").collection)
        assertNull(Codec.snake.decodeFromString(MessageOut.serializer(), """{"id":"m2","channel_id":"c1","sender_id":"u","seq":1,"updated_seq":1,"body":"x","created_at":"","deleted":false,"collection":null}""").collection)
        // An incomplete collection still decodes.
        assertEquals(CollectionOut(dueAt = "2026-10-08T09:00:00Z", targetCount = 3), Codec.snake.decodeFromString(CollectionOut.serializer(), """{"due_at":"2026-10-08T09:00:00Z","target_count":3}"""))

        val listed = Codec.snake.decodeFromString(
            kotlinx.serialization.builtins.ListSerializer(RecurringPostOut.serializer()),
            """[{"id":"p1","channel_id":"c1","bot_user_id":"b1","created_by":"u1","name":"週報","body":"**週報 {date}**",
                "schedule":{"kind":"weekly","weekdays":[0,3],"time":"09:00"},"tz":"Asia/Tokyo",
                "collect":{"targets":{"group_ids":["g1"],"user_ids":[],"all_members":false},"due":{"after_days":3,"time":"18:00"}},
                "enabled":true,"next_run_at":"2026-10-05T00:00:00Z","last_run_at":null,"created_at":"2026-10-01T00:00:00Z","updated_at":"2026-10-01T00:00:00Z"},
               {"id":"p2","channel_id":"c1","bot_user_id":"b2","created_by":"u1","name":"月報","body":"x",
                "schedule":{"kind":"monthly","day":31,"time":"18:00"},"tz":"America/New_York","collect":null,"enabled":false,
                "next_run_at":"2026-10-31T22:00:00Z","last_run_at":"2026-09-30T22:00:00Z","created_at":"","updated_at":"","something_new":1},
               {"id":"p3","channel_id":"c1","name":"未来","schedule":{"kind":"yearly","month":4,"day":1,"time":"09:00"}}]""",
        )
        assertEquals(listOf(0, 3), listed[0].schedule.weekdays)
        assertEquals(CollectSpec(CollectTargets(groupIds = listOf("g1")), CollectDue(3, "18:00")), listed[0].collect)
        assertEquals(RecurringSchedule("monthly", day = 31, time = "18:00"), listed[1].schedule)
        assertNull(listed[1].collect)
        assertFalse(listed[1].enabled)
        assertEquals("yearly", listed[2].schedule.kind)
        assertTrue(listed[2].enabled)

        val reminder = Codec.snake.decodeFromString(
            ReminderOut.serializer(),
            """{"id":"r1","message_id":"m1","channel_id":"c1","note":"週報 の提出をお願いします (締切 10/9 (金) 18:00)","preview":"週報","remind_at":"2026-10-09T09:00:00Z",
               "status":"fired","fired_at":"2026-10-09T09:00:05Z","created_at":"2026-10-09T09:00:05Z","kind":"collect"}""",
        )
        assertEquals("collect", reminder.kind)
    }

    @Test fun rowsStoredBeforeStillDecode() {
        // A message row persisted before M60 (no `collection`) and one after (with it) — the local store's JSON.
        val before = Codec.plain.decodeFromString(MessageState.serializer(), """{"id":"m1","channelId":"c1","senderId":"u","seq":1,"updatedSeq":1,"clientMsgId":null,"body":"x","createdAt":""}""")
        assertNull(before.collection)
        val withOne = before.copy(collection = collection(listOf("a")))
        assertEquals(withOne, Codec.plain.decodeFromString(MessageState.serializer(), Codec.plain.encodeToString(MessageState.serializer(), withOne)))
    }

    // --- the store and the event ------------------------------------------------------------------------------------

    private fun parent(updatedSeq: Int, collection: CollectionOut?) = MessageOut(
        id = "m1", channelId = "c1", senderId = "bot", seq = 1, updatedSeq = updatedSeq, body = "週報", createdAt = "2026-10-05T00:00:00Z", deleted = false,
        collection = collection,
    )

    @Test fun theStoreTakesANewerCollectionAndKeepsItAcrossThreadCounters() {
        val store = Store()
        store.upsertMessage(parent(1, null))
        // §7: the post's message.created has no row yet; message.updated (change collection) follows with a new seq.
        assertTrue(store.upsertMessage(parent(2, collection(emptyList()))))
        assertEquals(0, store.message("c1", "m1")?.collection?.submittedUserIds?.size)
        // A target's reply: the parent's thread counters move (parent_thread), then its collection (one seq later).
        store.applyParentThread("c1", ParentThread("m1", replyCount = 1, lastReplyAt = "2026-10-05T01:00:00Z", updatedSeq = 3))
        assertEquals(collection(emptyList()), store.message("c1", "m1")?.collection) // the counters keep it
        store.upsertMessage(parent(4, collection(listOf("a"))).copy(replyCount = 1))
        assertEquals(listOf("a"), store.message("c1", "m1")?.collection?.submittedUserIds)
        assertEquals(1, store.message("c1", "m1")?.replyCount)
        // A late copy (a catch-up page fetched before) does not take it back.
        assertFalse(store.upsertMessage(parent(2, collection(emptyList()))))
        assertEquals(listOf("a"), store.message("c1", "m1")?.collection?.submittedUserIds)
    }

    @Test fun messageUpdatedWithChangeCollectionReachesTheRow() = runBlocking {
        val server = FakeServer()
        val alice = server.addUser("alice")
        val bob = server.addUser("bob")
        val channel = server.createChannel("weekly", alice.id)
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

        // The bot's post, then its collection in a message.updated of its own.
        val (post, _) = server.post(channel.id, alice.id, "**週報 2026/10/05 (月)**")
        server.setCollection(channel.id, post.id, CollectionOut("2026-10-08T09:00:00Z", listOf(alice.id, bob.id), 2, emptyList(), null))
        settle()
        assertEquals(Recurring.Mine.PENDING, store.message(channel.id, post.id)?.collection?.let { Recurring.chip(it, bob.id, before, tokyo).mine })

        // Bob replies in the thread; the server counts him and says so with change=collection.
        val (reply, _) = server.post(channel.id, bob.id, "今週の進捗です", parentId = post.id)
        server.setCollection(channel.id, post.id, CollectionOut("2026-10-08T09:00:00Z", listOf(alice.id, bob.id), 2, listOf(bob.id), null))
        settle()
        val row = store.message(channel.id, post.id)!!
        assertEquals(listOf(bob.id), row.collection?.submittedUserIds)
        assertEquals(1, row.replyCount)
        assertEquals(Recurring.Mine.SUBMITTED, Recurring.chip(row.collection!!, bob.id, before, tokyo).mine)
        assertEquals(server.channels.getValue(channel.id).channel.lastSeq, store.channel(channel.id)?.syncedSeq)

        // Across a dropped connection: the catch-up brings the newer row with its collection (the reply was deleted).
        server.disconnect(bob.id)
        server.delete(channel.id, bob.id, reply.id)
        server.setCollection(channel.id, post.id, CollectionOut("2026-10-08T09:00:00Z", listOf(alice.id, bob.id), 2, emptyList(), null))
        repeat(50) { if (engine.status.value != jp.chikuwachat.android.sync.EngineStatus.ONLINE) settle() }
        settle()
        assertEquals(emptyList<String>(), store.message(channel.id, post.id)?.collection?.submittedUserIds)
        assertEquals(server.channels.getValue(channel.id).channel.lastSeq, store.channel(channel.id)?.syncedSeq)
        engine.stop(); scope.cancel()
    }

    private fun post(
        name: String = "週報",
        schedule: RecurringSchedule = RecurringSchedule("weekly", weekdays = listOf(0, 3), time = "09:00"),
        collect: CollectSpec? = null,
    ) = RecurringPostOut(
        id = "p", channelId = "c", botUserId = "b", createdBy = "u", name = name, body = "{date}", schedule = schedule, tz = "Asia/Tokyo",
        collect = collect, enabled = true, nextRunAt = "2026-10-31T09:00:00Z",
    )
}
