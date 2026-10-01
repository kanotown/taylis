package jp.chikuwachat.android

import jp.chikuwachat.android.api.ApiClient
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.CommentChange
import jp.chikuwachat.android.api.MessageOut
import jp.chikuwachat.android.api.PollAnswerIn
import jp.chikuwachat.android.api.PollCommentOut
import jp.chikuwachat.android.api.PollDecidedOut
import jp.chikuwachat.android.api.PollOut
import jp.chikuwachat.android.api.ScheduleSlotIn
import jp.chikuwachat.android.api.SlotAnswersOut
import jp.chikuwachat.android.sync.MessageState
import jp.chikuwachat.android.sync.Store
import jp.chikuwachat.android.sync.toOut
import jp.chikuwachat.android.ui.SchedulePollInitial
import jp.chikuwachat.android.ui.SchedulePolls
import jp.chikuwachat.android.ui.SlotDraft
import jp.chikuwachat.android.ui.Templates
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonObject
import okhttp3.Interceptor
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import java.time.LocalDate
import java.time.LocalTime

/**
 * M54 (docs/SCHEDULING.md): scheduling polls on Android, the cases of the desktop's schedulePolls.test.tsx: the form's
 * candidates and labels, reading the answers, decoding (old servers too), the my_answers / my_comment merge
 * (SYNC_PROTOCOL.md §8) and the request bodies. In Tokyo, as the desktop's tests.
 */
class SchedulePollsTest {
    @get:Rule val tokyo = TokyoZone()

    private fun day(text: String) = LocalDate.parse(text)
    private fun timed(d: String, start: String, minutes: Int = 60) = SlotDraft(day(d), allDay = false, start = LocalTime.parse(start.padStart(5, '0')), minutes = minutes)
    private fun allDay(d: String) = SlotDraft(day(d), allDay = true)
    private fun labels(slots: List<SlotDraft>) = slots.map { SchedulePolls.slotLabel(it) }

    // --- the candidates ---------------------------------------------------------------------------

    @Test fun labelsThemAsTheServerDoes() {
        assertEquals("10/3 (土) 14:00〜15:00", SchedulePolls.slotLabel(timed("2026-10-03", "14:00")))
        assertEquals("10/3 (土) 9:05〜10:35", SchedulePolls.slotLabel(timed("2026-10-03", "09:05", 90)))
        assertEquals("10/5 (月) 終日", SchedulePolls.slotLabel(allDay("2026-10-05")))
        assertEquals("10/6 (火) 22:00〜24:00", SchedulePolls.slotLabel(timed("2026-10-06", "22:00", 120)))
        assertEquals("10/7 (水) 23:00〜翌1:30", SchedulePolls.slotLabel(timed("2026-10-07", "23:00", 150)))
    }

    @Test fun sendsLocalTimesAsUtcInstantsAndAllDayCandidatesAsDates() {
        assertEquals(ScheduleSlotIn(startsAt = "2026-10-03T05:00:00Z", endsAt = "2026-10-03T06:00:00Z"), SchedulePolls.slotToIn(timed("2026-10-03", "14:00")))
        assertEquals(ScheduleSlotIn(date = "2026-10-05"), SchedulePolls.slotToIn(allDay("2026-10-05")))
    }

    @Test fun checksTheFormBeforeSending() {
        val two = listOf(timed("2026-10-03", "14:00"), allDay("2026-10-05"))
        assertEquals("題名を入れてください", SchedulePolls.problem(" ", two))
        assertEquals("候補を 2 つ以上選んでください", SchedulePolls.problem("ゼミ", two.take(1)))
        assertEquals("候補は 20 個までです", SchedulePolls.problem("ゼミ", (1..21).map { allDay("2026-11-%02d".format(it)) }))
        assertEquals("時間の長さは 15 分〜12 時間にしてください", SchedulePolls.problem("ゼミ", listOf(timed("2026-10-03", "14:00", 10), allDay("2026-10-05"))))
        assertEquals("時間の長さは 15 分〜12 時間にしてください", SchedulePolls.problem("ゼミ", listOf(timed("2026-10-03", "14:00", 721), allDay("2026-10-05"))))
        assertEquals("同じ候補が複数あります", SchedulePolls.problem("ゼミ", listOf(allDay("2026-10-05"), allDay("2026-10-05"))))
        assertNull(SchedulePolls.problem("ゼミ", listOf(timed("2026-10-05", "10:00"), allDay("2026-10-05"))))
        assertNull(SchedulePolls.problem("ゼミ", listOf(timed("2026-10-03", "14:00", 15), timed("2026-10-03", "14:00", 720))))
    }

    @Test fun ordersThemAndReadsScheduleArgumentsAsCandidates() {
        assertEquals(
            listOf("10/3 (土) 9:00〜10:00", "10/5 (月) 終日", "10/5 (月) 13:00〜14:00"),
            labels(SchedulePolls.sortSlots(listOf(timed("2026-10-05", "13:00"), allDay("2026-10-05"), timed("2026-10-03", "9:00")))),
        )
        val read = Templates.readSchedule("ゼミ 10/3-10/4 13:00 10/6 9:30-12:00 10/3", day("2026-09-29"))!!
        assertEquals("ゼミ", read.question)
        assertEquals(
            listOf("10/3 (土) 終日", "10/3 (土) 13:00〜14:00", "10/4 (日) 13:00〜14:00", "10/6 (火) 9:30〜12:00"),
            labels(SchedulePolls.slotsFromEntries(read.entries)),
        )
        // No limit on how many (the form says when there are too many); nothing that is not a date or a time.
        assertEquals(11, Templates.readSchedule("10/1-10/11", day("2026-09-29"))!!.entries.size)
        assertNull(Templates.readSchedule("ゼミ 10/1 10/2 午後", day("2026-09-29")))
        assertEquals("30 分", SchedulePolls.durationLabel(30))
        assertEquals("1 時間", SchedulePolls.durationLabel(60))
        assertEquals("1 時間半", SchedulePolls.durationLabel(90))
        assertEquals("2 時間 15 分", SchedulePolls.durationLabel(135))
        assertEquals(SchedulePolls.DURATIONS, SchedulePolls.lengthChoices(60))
        assertTrue(80 in SchedulePolls.lengthChoices(80))
    }

    @Test fun theFormsEditsPickDaysTimeForAllPerCandidateAndAnotherTimeOnTheSameDay() {
        val start = SchedulePolls.DEFAULT_START
        var slots = SchedulePolls.toggleDay(emptyList(), day("2026-10-03"), false, start, 60)
        slots = SchedulePolls.toggleDay(slots, day("2026-09-30"), false, start, 60)
        assertEquals(listOf("9/30 (水) 10:00〜11:00", "10/3 (土) 10:00〜11:00"), labels(slots))
        // The time above goes to every candidate.
        slots = SchedulePolls.applyToAll(slots, false, LocalTime.of(14, 0), 60)
        slots = SchedulePolls.applyToAll(slots, false, LocalTime.of(14, 0), 90)
        assertEquals(listOf("9/30 (水) 14:00〜15:30", "10/3 (土) 14:00〜15:30"), labels(slots))
        // One candidate changed on its own; another time added after it; picking a day again removes it.
        slots = slots.mapIndexed { i, s -> if (i == 1) s.copy(start = LocalTime.of(13, 0)) else s }
        slots = SchedulePolls.addAfter(slots, 1)
        assertEquals(listOf("9/30 (水) 14:00〜15:30", "10/3 (土) 13:00〜14:30", "10/3 (土) 14:30〜16:00"), labels(slots))
        slots = SchedulePolls.toggleDay(slots, day("2026-09-30"), false, start, 60)
        assertEquals(listOf("10/3 (土) 13:00〜14:30", "10/3 (土) 14:30〜16:00"), labels(slots))
        assertEquals(
            listOf(ScheduleSlotIn("2026-10-03T04:00:00Z", "2026-10-03T05:30:00Z"), ScheduleSlotIn("2026-10-03T05:30:00Z", "2026-10-03T07:00:00Z")),
            slots.map { SchedulePolls.slotToIn(it) },
        )
        // 終日 makes one whole-day candidate per day; picked again, the day's candidates all go.
        val whole = SchedulePolls.applyToAll(slots, true, LocalTime.of(14, 0), 90)
        assertEquals(listOf("10/3 (土) 終日"), labels(whole))
        assertEquals("候補を 2 つ以上選んでください", SchedulePolls.problem("ゼミ", whole))
        val two = SchedulePolls.toggleDay(whole, day("2026-11-02"), true, start, 60)
        assertEquals(listOf(ScheduleSlotIn(date = "2026-10-03"), ScheduleSlotIn(date = "2026-11-02")), two.map { SchedulePolls.slotToIn(it) })
        assertEquals(emptyList<SlotDraft>(), SchedulePolls.toggleDay(slots, day("2026-10-03"), false, start, 60))
        // Another time after one that ends past midnight starts at 10:00.
        assertEquals(listOf("10/7 (水) 10:00〜12:00", "10/7 (水) 23:00〜翌1:00"), labels(SchedulePolls.addAfter(listOf(timed("2026-10-07", "23:00", 120)), 0)))
    }

    @Test fun theFormSurvivesARotationAsStrings() {
        val initial = SchedulePollInitial("ゼミ", listOf(timed("2026-10-03", "13:00", 80), allDay("2026-10-05")))
        assertEquals(initial, SchedulePollInitial.decode(initial.encode()))
        assertEquals(SchedulePollInitial(), SchedulePollInitial.decode(SchedulePollInitial().encode()))
    }

    // --- reading the answers ------------------------------------------------------------------------

    /** A scheduling poll as the server sends it; `answers` per slot as (yes, maybe, no) user ids. */
    private fun schedulePoll(answers: List<Triple<List<String>, List<String>, List<String>>>, anonymous: Boolean = false) = PollOut(
        question = "M2 中間発表の練習",
        options = listOf("10/3 (土) 14:00〜15:00", "10/5 (月) 終日", "10/6 (火) 22:00〜24:00").take(answers.size),
        multiple = true,
        anonymous = anonymous,
        votes = answers.map { if (anonymous) emptyList() else it.first },
        counts = answers.map { it.first.size },
        kind = "schedule",
        tz = "Asia/Tokyo",
        answers = answers.map { (yes, maybe, no) ->
            SlotAnswersOut(
                if (anonymous) emptyList() else yes, if (anonymous) emptyList() else maybe, if (anonymous) emptyList() else no,
                yes.size, maybe.size, no.size,
            )
        },
        respondents = if (anonymous) emptyList() else answers.flatMap { it.first + it.second + it.third }.distinct(),
    )

    private fun a(yes: List<String> = emptyList(), maybe: List<String> = emptyList(), no: List<String> = emptyList()) = Triple(yes, maybe, no)

    @Test fun takesMineFromANamedPollsListsAndFromMyAnswersInAnAnonymousOne() {
        val named = schedulePoll(listOf(a(listOf("me", "u2")), a(maybe = listOf("me")), a(no = listOf("u2")))).copy(comments = listOf(PollCommentOut("me", "午後なら")))
        assertEquals(listOf("yes", "maybe", null), SchedulePolls.myAnswers(named, "me"))
        assertEquals("午後なら", SchedulePolls.myComment(named, "me"))
        assertEquals(listOf(0), SchedulePolls.bestSlots(named))
        assertEquals(2, SchedulePolls.respondentCount(named))
        // A named poll's lists win over a my_answers kept from before (changed on another device).
        assertEquals(listOf("yes", "maybe", null), SchedulePolls.myAnswers(named.copy(myAnswers = listOf("no", "no", "no")), "me"))
        val anonymous = schedulePoll(listOf(a(listOf("a", "b")), a(listOf("c", "d"))), anonymous = true).copy(myAnswers = listOf(null, "yes"), myComment = "どちらでも")
        assertEquals(listOf(null, "yes"), SchedulePolls.myAnswers(anonymous, "me"))
        assertEquals("どちらでも", SchedulePolls.myComment(anonymous, "me"))
        assertEquals(listOf(0, 1), SchedulePolls.bestSlots(anonymous)) // a tie stars both
        assertEquals(2, SchedulePolls.respondentCount(anonymous))
        assertEquals(listOf(null, null), SchedulePolls.myAnswers(anonymous.copy(myAnswers = null), "me")) // an event's copy says nothing
        assertEquals(emptyList<Int>(), SchedulePolls.bestSlots(schedulePoll(listOf(a(maybe = listOf("x")), a())))) // no ○ yet: no star
    }

    @Test fun pressingAnAnswerSetsItAndPressingItAgainTakesItBack() {
        assertEquals(listOf("yes", "maybe", "no"), SchedulePolls.pressAnswer(listOf("yes", null, "no"), 1, "maybe"))
        assertEquals(listOf(null, null, "no"), SchedulePolls.pressAnswer(listOf("yes", null, "no"), 0, "yes"))
        assertEquals(listOf(PollAnswerIn(0, "yes"), PollAnswerIn(2, "no")), SchedulePolls.answersBody(listOf("yes", null, "no")))
        // The table's cell: ○ → △ → × → unanswered.
        assertEquals(listOf("yes", "maybe", "no", null), listOf(null, "yes", "maybe", "no").map { SchedulePolls.nextAnswer(it) })
    }

    @Test fun theAuthorAnOwnerOrAnAdminDecides() {
        assertTrue(SchedulePolls.canDecide("alice", "alice", isAdmin = false, channelRole = "member"))
        assertTrue(SchedulePolls.canDecide("bob", "alice", isAdmin = false, channelRole = "owner"))
        assertTrue(SchedulePolls.canDecide("bob", "alice", isAdmin = true, channelRole = null))
        assertFalse(SchedulePolls.canDecide("bob", "alice", isAdmin = false, channelRole = "member"))
        assertFalse(SchedulePolls.canDecide(null, "alice", isAdmin = true, channelRole = "owner"))
        val poll = schedulePoll(listOf(a(listOf("b", "c"), listOf("a")), a()))
        assertEquals("3 人が回答", SchedulePolls.footer(poll))
        assertEquals("締め切りました · 3 人が回答", SchedulePolls.footer(poll.copy(closedAt = "2026-10-01T00:00:00Z")))
        assertEquals("決定済み · 3 人が回答", SchedulePolls.footer(poll.copy(closedAt = "2026-10-01T00:00:00Z", decided = PollDecidedOut(0, "e1", "a", "2026-10-01T00:00:00Z"))))
    }

    // --- decoding ---------------------------------------------------------------------------------

    @Test fun decodesAScheduleAndStillAPollFromAnOlderServerOrStoredBefore() {
        val wire = """{"question":"発表練習","options":["10/3 (土) 14:00〜15:00","10/5 (月) 終日"],"multiple":true,"anonymous":false,"closed_at":"2026-10-01T00:00:00Z",
            "votes":[["u1"],[]],"counts":[1,0],"mine":[0],"kind":"schedule",
            "slots":[{"starts_at":"2026-10-03T05:00:00Z","ends_at":"2026-10-03T06:00:00Z","date":null},{"starts_at":null,"ends_at":null,"date":"2026-10-05"}],
            "tz":"Asia/Tokyo","decided":{"index":0,"event_id":"e1","by":"u1","at":"2026-10-01T00:00:00Z"},
            "answers":[{"yes":["u1"],"maybe":["u2"],"no":[],"yes_count":1,"maybe_count":1,"no_count":0},{"yes":[],"maybe":[],"no":["u2"],"yes_count":0,"maybe_count":0,"no_count":1}],
            "respondents":["u1","u2"],"comments":[{"user_id":"u2","text":"午後なら"}],"my_answers":["yes",null],"my_comment":"","future_field":1}"""
        val poll = Codec.snake.decodeFromString(PollOut.serializer(), wire)
        assertTrue(poll.isSchedule)
        assertEquals("2026-10-05", poll.slots[1].date)
        assertEquals("2026-10-03T05:00:00Z", poll.slots[0].startsAt)
        assertEquals(PollDecidedOut(0, "e1", "u1", "2026-10-01T00:00:00Z"), poll.decided)
        assertEquals(listOf(1, 0), SchedulePolls.counts(poll).map { it.maybe })
        assertEquals(listOf("yes", null), poll.myAnswers)
        assertEquals("", poll.myComment)
        assertEquals(listOf(PollCommentOut("u2", "午後なら")), poll.comments)
        assertEquals(listOf("yes", null), SchedulePolls.myAnswers(poll, "u1"))
        assertEquals(listOf("maybe", "no"), SchedulePolls.myAnswers(poll, "u2"))
        // Anonymous comments carry no user.
        assertNull(Codec.snake.decodeFromString(PollCommentOut.serializer(), """{"user_id":null,"text":"x"}""").userId)

        // A server before M53: no kind (a choice poll), none of the rest.
        val old = Codec.snake.decodeFromString(PollOut.serializer(), """{"question":"Q","options":["A","B"],"multiple":false,"closed_at":null,"votes":[["u1"],[]]}""")
        assertFalse(old.isSchedule)
        assertEquals("choice", old.kind)
        assertTrue(old.answers.isEmpty() && old.slots.isEmpty() && old.comments.isEmpty())
        assertNull(old.myAnswers)
        assertNull(old.decided)

        // A row persisted before M54 (the plain codec, camelCase, no new fields) still loads; a new one round-trips.
        val stored = """{"question":"Q","options":["A","B"],"multiple":true,"votes":[[],[]],"anonymous":false,"counts":[0,0]}"""
        assertFalse(Codec.plain.decodeFromString(PollOut.serializer(), stored).isSchedule)
        val message = MessageOut(id = "m1", channelId = "c1", senderId = "u1", seq = 3, updatedSeq = 3, body = "📊 発表練習", createdAt = "2026-10-01T00:00:00Z", deleted = false, poll = poll)
        val state = MessageState.from(message)
        val back = Codec.plain.decodeFromString(MessageState.serializer(), Codec.plain.encodeToString(MessageState.serializer(), state))
        assertEquals(poll, back.poll)
        assertEquals(poll, back.toOut()?.poll)
    }

    // --- the merge (SYNC_PROTOCOL.md §8) ---------------------------------------------------------------

    private val anonymousPoll = schedulePoll(listOf(a(), a()), anonymous = true)

    private fun message(updatedSeq: Int, poll: PollOut) = MessageOut(
        id = "m1", channelId = "c1", senderId = "u1", seq = 3, updatedSeq = updatedSeq, body = "📊 ${poll.question}",
        createdAt = "2026-10-01T00:00:00Z", deleted = false, poll = poll,
    )

    private fun counted(yes: Int, maybe: Int = 0) = listOf(SlotAnswersOut(yesCount = yes, maybeCount = maybe), SlotAnswersOut())

    @Test fun anEventWithoutMyAnswersKeepsThemAndTheLaterResponseStillBringsThem() {
        val persistence = MemoryPersistence()
        val store = Store(persistence)
        // My answer's event lands first (no my_answers), then its response with the same updated_seq.
        store.upsertMessage(message(4, anonymousPoll.copy(answers = counted(1))))
        assertNull(store.message("c1", "m1")?.poll?.myAnswers)
        assertTrue(store.upsertMessage(message(4, anonymousPoll.copy(answers = counted(1), myAnswers = listOf("yes", null), myComment = "どちらでも"))))
        assertEquals(listOf("yes", null), store.message("c1", "m1")?.poll?.myAnswers)
        assertEquals("どちらでも", persistence.messages["m1"]?.poll?.myComment)
        // Someone else answers: a newer event without them keeps mine and takes the new counts.
        store.upsertMessage(message(5, anonymousPoll.copy(answers = counted(1, 1))))
        val kept = store.message("c1", "m1")!!.poll!!
        assertEquals(listOf("yes", null), kept.myAnswers)
        assertEquals("どちらでも", kept.myComment)
        assertEquals(1, kept.answers[0].maybeCount)
        // The same response again changes nothing.
        assertFalse(store.upsertMessage(message(5, anonymousPoll.copy(answers = counted(1, 1), myAnswers = listOf("yes", null), myComment = "どちらでも"))))
    }

    @Test fun myResponseOvertakenBySomeoneElsesEventStillSetsMineAndAnEmptyCommentIsKnown() {
        val store = Store()
        store.upsertMessage(message(4, anonymousPoll.copy(myAnswers = listOf(null, null), myComment = "前の")))
        // Someone else's answer (updated_seq 6) lands before the response to mine (5).
        store.upsertMessage(message(6, anonymousPoll.copy(answers = counted(1, 1))))
        store.applyMyPollResponse(message(5, anonymousPoll.copy(answers = counted(0, 1), myAnswers = listOf(null, "no"), myComment = "")))
        val stored = store.message("c1", "m1")!!
        assertEquals(6, stored.updatedSeq)
        assertEquals(listOf(null, "no"), stored.poll?.myAnswers)
        assertEquals("", stored.poll?.myComment) // removed, not missing
        assertEquals(1, stored.poll?.answers?.get(0)?.yesCount) // the newer row's counts
        // A decision's response (closed, decided) with my answers unchanged: the row moves on, mine stay.
        store.applyMyPollResponse(message(7, anonymousPoll.copy(closedAt = "2026-10-01T01:00:00Z", decided = PollDecidedOut(1, null, "u1", "2026-10-01T01:00:00Z"), myAnswers = listOf(null, "no"), myComment = "")))
        assertEquals(1, store.message("c1", "m1")?.poll?.decided?.index)
        assertEquals(listOf(null, "no"), store.message("c1", "m1")?.poll?.myAnswers)
    }

    // --- the requests -----------------------------------------------------------------------------

    private fun stubbed(handler: (okhttp3.Request) -> Pair<Int, String>): OkHttpClient =
        OkHttpClient.Builder().addInterceptor(Interceptor { chain ->
            val (status, body) = handler(chain.request())
            Response.Builder().request(chain.request()).protocol(Protocol.HTTP_1_1).code(status).message("stub")
                .body(body.toResponseBody("application/json".toMediaType())).build()
        }).build()

    @Test fun theRequestsCarryWhatTheApiSays() = runBlocking {
        val calls = ArrayList<Triple<String, String, String>>()
        val response = """{"id":"m1","channel_id":"c1","sender_id":"u","seq":4,"updated_seq":4,"body":"📊 Q","created_at":"2026-10-01T00:00:00Z","deleted":false,
            "poll":{"question":"Q","options":["10/3 (土) 終日","10/5 (月) 終日"],"multiple":true,"votes":[[],[]],"kind":"schedule","my_answers":[null,null],"my_comment":""}}"""
        val client = ApiClient("http://server", stubbed { request ->
            val buffer = okio.Buffer(); request.body?.writeTo(buffer)
            calls.add(Triple(request.method, request.url.encodedPath, buffer.readUtf8()))
            201 to response
        })
        client.accessToken = "a"
        val slots = listOf(SchedulePolls.slotToIn(timed("2026-10-03", "14:00")), SchedulePolls.slotToIn(allDay("2026-10-05")))
        val made = client.postSchedulePoll("c1", null, "Q", slots, "Asia/Tokyo")
        assertTrue(made.poll!!.isSchedule)
        assertEquals(listOf(null, null), made.poll!!.myAnswers)
        client.postSchedulePoll("c1", "p1", "Q", slots, "Asia/Tokyo", anonymous = true)
        client.answerPoll("m1", listOf(PollAnswerIn(0, "yes"), PollAnswerIn(1, "maybe")))
        client.answerPoll("m1", emptyList(), CommentChange.Set("午後なら"))
        client.answerPoll("m1", emptyList(), CommentChange.Set(null))
        client.decidePoll("m1", 1)
        client.decidePoll("m1", 1, createEvent = false)
        client.undecidePoll("m1")

        val created = Json.parseToJsonElement(calls[0].third).jsonObject
        assertEquals("POST" to "/api/v1/channels/c1/messages", calls[0].first to calls[0].second)
        val poll = created.getValue("poll").jsonObject
        assertEquals(setOf("kind", "question", "slots", "tz"), poll.keys) // no options, no multiple, anonymous only when set
        assertEquals("""[{"starts_at":"2026-10-03T05:00:00Z","ends_at":"2026-10-03T06:00:00Z"},{"date":"2026-10-05"}]""", poll.getValue("slots").toString())
        assertEquals("\"schedule\"", poll.getValue("kind").toString())
        val anonymous = Json.parseToJsonElement(calls[1].third).jsonObject
        assertEquals("true", anonymous.getValue("poll").jsonObject.getValue("anonymous").toString())
        assertEquals("\"p1\"", anonymous.getValue("parent_id").toString())

        assertEquals(Triple("PUT", "/api/v1/messages/m1/poll/answers", """{"answers":[{"index":0,"answer":"yes"},{"index":1,"answer":"maybe"}]}"""), calls[2])
        assertEquals("""{"answers":[],"comment":"午後なら"}""", calls[3].third)
        assertEquals(JsonNull, Json.parseToJsonElement(calls[4].third).jsonObject.getValue("comment"))
        assertEquals(Triple("POST", "/api/v1/messages/m1/poll/decide", """{"index":1,"create_event":true}"""), calls[5])
        assertEquals("""{"index":1,"create_event":false}""", calls[6].third)
        assertEquals("DELETE" to "/api/v1/messages/m1/poll/decide", calls[7].first to calls[7].second)
    }
}
