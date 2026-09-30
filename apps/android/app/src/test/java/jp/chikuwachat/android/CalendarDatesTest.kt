package jp.chikuwachat.android

import jp.chikuwachat.android.CalendarFixtures.allDay
import jp.chikuwachat.android.CalendarFixtures.timed
import jp.chikuwachat.android.api.CalendarAlarmOut
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.api.CalendarEventCreate
import jp.chikuwachat.android.ui.CalendarDates
import jp.chikuwachat.android.ui.CalendarMode
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZonedDateTime

/** M52: the calendar's date math (ui/CalendarDates.kt), the cases of the desktop's calendarDates.test.ts, in Tokyo. */
class CalendarDatesTest {
    @get:Rule val tokyo = TokyoZone()

    private fun d(text: String) = LocalDate.parse(text)

    // --- weeks start on Sunday (日曜始まり) ---

    @Test
    fun theMonthGridRunsFromTheSundayBeforeTheFirstToTheSaturdayAfterTheLastDay() {
        val weeks = CalendarDates.monthGrid(d("2026-10-15")) // 1 Oct 2026 is a Thursday
        assertEquals(5, weeks.size)
        assertEquals(listOf("2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03"), weeks[0].map { it.toString() })
        assertEquals(d("2026-10-31"), weeks[4][6])
        assertEquals(4, CalendarDates.monthGrid(d("2026-02-01")).size) // Feb 2026: Sunday the 1st to Saturday the 28th
        assertEquals(6, CalendarDates.monthGrid(d("2026-08-01")).size) // Aug 2026: Saturday the 1st, 31 days
        assertEquals(d("2026-09-27"), CalendarDates.weekStart(d("2026-10-01")))
        assertEquals(d("2026-10-04"), CalendarDates.weekStart(d("2026-10-04")))
        assertEquals(d("2026-11-01"), CalendarDates.addMonths(d("2026-10-15"), 1))
        assertEquals(d("2026-09-01"), CalendarDates.addMonths(d("2026-10-31"), -1))
    }

    @Test
    fun eachModeHasItsDaysSentAsLocalMidnights() {
        assertEquals(d("2026-09-27") to d("2026-11-01"), CalendarDates.rangeFor(CalendarMode.MONTH, d("2026-10-15")))
        assertEquals(d("2026-10-01") to d("2026-11-30"), CalendarDates.rangeFor(CalendarMode.LIST, d("2026-10-01")))
        assertEquals("2026-10-01T00:00:00+09:00" to "2026-10-02T00:00:00+09:00", CalendarDates.rangeParams(d("2026-10-01"), d("2026-10-02")))
        assertEquals("2026-10-01T14:30:00+09:00", CalendarDates.isoLocal(ZonedDateTime.parse("2026-10-01T05:30:00Z")))
        assertEquals("2026年10月", CalendarDates.rangeTitle(CalendarMode.MONTH, d("2026-10-15")))
        assertEquals("10月1日 (木) から", CalendarDates.rangeTitle(CalendarMode.LIST, d("2026-10-01")))
    }

    // --- timed and all-day events ---

    @Test
    fun aTimedEventCoversItsLocalDaysUpToTheInstantBeforeItsEnd() {
        // 23:00–01:00 Tokyo crosses midnight; one ending exactly at midnight stays on its day.
        assertEquals(d("2026-10-01") to d("2026-10-02"), CalendarDates.eventDays(timed("late", "2026-10-01T14:00:00Z", "2026-10-01T16:00:00Z")))
        assertEquals(d("2026-10-01") to d("2026-10-01"), CalendarDates.eventDays(timed("to midnight", "2026-10-01T13:00:00Z", "2026-10-01T15:00:00Z")))
        assertEquals(d("2026-10-05") to d("2026-10-07"), CalendarDates.eventDays(allDay("学会", "2026-10-05", "2026-10-07")))
        // The server may write the offset instead of Z.
        assertEquals(d("2026-10-02") to d("2026-10-02"), CalendarDates.eventDays(timed("offset", "2026-10-01T15:00:00+00:00", "2026-10-01T16:00:00+00:00")))
    }

    @Test
    fun rangesOverlapLikeTheServerInstantsForTimedEventsDatesForAllDayOnes() {
        val from = "2026-10-01T00:00:00+09:00"
        val to = "2026-10-02T00:00:00+09:00"
        assertFalse(CalendarDates.overlapsRange(timed("ends at from", "2026-09-30T14:00:00Z", "2026-09-30T15:00:00Z"), from, to))
        assertFalse(CalendarDates.overlapsRange(timed("starts at to", "2026-10-01T15:00:00Z", "2026-10-01T16:00:00Z"), from, to))
        assertTrue(CalendarDates.overlapsRange(timed("inside", "2026-10-01T01:00:00Z", "2026-10-01T02:00:00Z"), from, to))
        assertTrue(CalendarDates.overlapsRange(timed("around", "2026-09-30T00:00:00Z", "2026-10-03T00:00:00Z"), from, to))
        assertTrue(CalendarDates.overlapsRange(allDay("on the day", "2026-10-01"), from, to))
        assertFalse(CalendarDates.overlapsRange(allDay("next day", "2026-10-02"), from, to))
        assertFalse(CalendarDates.overlapsRange(allDay("day before", "2026-09-30"), from, to))
        assertTrue(CalendarDates.overlapsRange(allDay("span", "2026-09-20", "2026-10-10"), from, to))
    }

    @Test
    fun aDaysEventsAreAllDayAndContinuingOnesFirstThenByTime() {
        val events = listOf(
            timed("14:00", "2026-10-01T05:00:00Z", "2026-10-01T06:00:00Z"),
            timed("9:30", "2026-10-01T00:30:00Z", "2026-10-01T01:00:00Z"),
            allDay("学会", "2026-10-01"),
            timed("前日から", "2026-09-30T14:00:00Z", "2026-10-01T01:00:00Z"),
            allDay("明日", "2026-10-02"),
        )
        assertEquals(listOf("前日から", "学会", "9:30", "14:00"), CalendarDates.eventsOn(events, d("2026-10-01")).map { it.title })
        val overnight = events[3]
        assertEquals("23:00〜", CalendarDates.timeOnDay(overnight, d("2026-09-30")))
        assertEquals("〜10:00", CalendarDates.timeOnDay(overnight, d("2026-10-01")))
        assertEquals("14:00〜15:00", CalendarDates.timeOnDay(events[0], d("2026-10-01")))
        assertEquals("終日", CalendarDates.timeOnDay(events[2], d("2026-10-01")))
        assertEquals("10月1日 (木) 14:00〜15:00", CalendarDates.eventWhen(events[0]))
        assertEquals("10月5日 (月)〜10月7日 (水) 終日", CalendarDates.eventWhen(allDay("学会", "2026-10-05", "2026-10-07")))
        assertEquals("9月30日 (水) 23:00〜10月1日 (木) 10:00", CalendarDates.eventWhen(overnight))
        // The agenda: only the days with events, each in that order; the month's dots on every day an event covers.
        val agenda = CalendarDates.agenda(events, d("2026-09-30"), d("2026-10-03"))
        assertEquals(listOf(d("2026-09-30"), d("2026-10-01"), d("2026-10-02")), agenda.map { it.first })
        assertEquals(listOf("前日から"), agenda[0].second.map { it.title })
        assertEquals(setOf(d("2026-10-06"), d("2026-10-07")), CalendarDates.busyDays(listOf(allDay("学会", "2026-10-05", "2026-10-09")), d("2026-10-06"), d("2026-10-08")))
    }

    @Test
    fun theWindowOrderIsTheEarliestFirstAllDayBeforeTimedOnADay() {
        val events = listOf(
            timed("b", "2026-10-02T01:00:00Z", "2026-10-02T02:00:00Z"),
            allDay("day", "2026-10-02"),
            timed("a", "2026-10-02T01:00:00Z", "2026-10-02T02:00:00Z"),
            timed("first", "2026-10-01T01:00:00Z", "2026-10-01T02:00:00Z"),
        )
        assertEquals(listOf("first", "day", "a", "b"), events.sortedWith(CalendarDates.eventOrder).map { it.title })
    }

    // --- the event form ---

    private val base by lazy { CalendarDates.newDraft(d("2026-10-01"), null, ZonedDateTime.parse("2026-09-01T00:00:00Z")).copy(title = "ゼミ") }

    @Test
    fun theFormSaysWhatIsWrongBeforeSending() {
        assertEquals(LocalTime.of(10, 0), base.startTime) // not today: 10:00 for an hour
        assertEquals(LocalTime.of(11, 0), base.endTime)
        assertNull(CalendarDates.draftProblem(base))
        assertEquals("題名を入れてください", CalendarDates.draftProblem(base.copy(title = "  ")))
        assertEquals("題名は 200 文字までです", CalendarDates.draftProblem(base.copy(title = "x".repeat(201))))
        assertEquals("場所は 200 文字までです", CalendarDates.draftProblem(base.copy(location = "x".repeat(201))))
        assertEquals("説明は 4000 文字までです", CalendarDates.draftProblem(base.copy(description = "x".repeat(4001))))
        assertEquals("終了は開始より後にしてください", CalendarDates.draftProblem(base.copy(endTime = base.startTime)))
        assertEquals("時刻の予定は 14 日までです", CalendarDates.draftProblem(base.copy(endDay = d("2026-10-16"))))
        assertEquals("終了日は開始日より後にしてください", CalendarDates.draftProblem(base.copy(allDay = true, endDay = d("2026-09-30"))))
        assertEquals("終日の予定は 60 日までです", CalendarDates.draftProblem(base.copy(allDay = true, endDay = d("2026-11-30"))))
        assertNull(CalendarDates.draftProblem(base.copy(allDay = true, endDay = d("2026-11-29"))))
    }

    @Test
    fun aNewEventTodayStartsAtTheNextWholeHour() {
        val now = ZonedDateTime.parse("2026-10-01T05:20:00Z") // 14:20 in Tokyo
        val draft = CalendarDates.newDraft(d("2026-10-01"), "c1", now)
        assertEquals(LocalTime.of(15, 0), draft.startTime)
        assertEquals(LocalTime.of(16, 0), draft.endTime)
        assertEquals("c1", draft.calendar)
        val late = CalendarDates.newDraft(d("2026-10-01"), null, ZonedDateTime.parse("2026-10-01T14:30:00Z")) // 23:30
        assertEquals(LocalTime.of(23, 0), late.startTime)
        assertEquals(LocalTime.of(23, 59), late.endTime)
    }

    @Test
    fun aTimedEventGoesOutAsUtcInstantsAndAnAllDayOneAsDates() {
        val timedBody = CalendarDates.draftToCreate(
            base.copy(startTime = LocalTime.of(14, 0), endTime = LocalTime.of(15, 30), alarm = 10, calendar = "c1", location = " 5 号館 "), "Asia/Tokyo", "k1",
        )
        assertEquals(
            CalendarEventCreate(
                channelId = "c1", title = "ゼミ", allDay = false, startsAt = "2026-10-01T05:00:00Z", endsAt = "2026-10-01T06:30:00Z",
                location = "5 号館", description = null, alarmMinutes = 10, tz = "Asia/Tokyo", clientEventId = "k1",
            ),
            timedBody,
        )
        // On the wire: snake_case, the nulls left out (the server's defaults).
        val json = Codec.snake.encodeToJsonElement(CalendarEventCreate.serializer(), timedBody).jsonObject
        assertEquals("2026-10-01T05:00:00Z", json["starts_at"]!!.jsonPrimitive.content)
        assertEquals("k1", json["client_event_id"]!!.jsonPrimitive.content)
        assertEquals(10, json["alarm_minutes"]!!.jsonPrimitive.content.toInt())
        assertFalse("start_date" in json)
        val dayBody = CalendarDates.draftToCreate(base.copy(allDay = true, endDay = d("2026-10-03"), alarm = -480), "Asia/Tokyo", "k2")
        assertEquals(null, dayBody.channelId)
        assertTrue(dayBody.allDay)
        assertNull(dayBody.startsAt)
        assertEquals("2026-10-01", dayBody.startDate)
        assertEquals("2026-10-03", dayBody.endDate)
        assertEquals(-480, dayBody.alarmMinutes)
        // PATCH writes its nulls: the other pair of times goes, an emptied place is removed.
        val patch = CalendarDates.draftToPatch(base.copy(allDay = true, location = "  ")).toJson()
        assertEquals("true", patch["all_day"]!!.jsonPrimitive.content)
        assertEquals("2026-10-01", patch["start_date"]!!.jsonPrimitive.content)
        assertEquals("2026-10-01", patch["end_date"]!!.jsonPrimitive.content)
        assertEquals(JsonNull, patch["starts_at"])
        assertEquals(JsonNull, patch["location"])
    }

    @Test
    fun anEventReadsBackIntoTheFormInLocalTime() {
        val draft = CalendarDates.draftFromEvent(
            timed("ゼミ", "2026-10-01T05:00:00Z", "2026-10-01T06:30:00Z", channelId = "c1", alarm = CalendarAlarmOut(30, "", "pending")),
        )
        assertEquals(d("2026-10-01"), draft.startDay)
        assertEquals(LocalTime.of(14, 0), draft.startTime)
        assertEquals(LocalTime.of(15, 30), draft.endTime)
        assertEquals("c1", draft.calendar)
        assertEquals(30, draft.alarm)
        assertFalse(draft.allDay)
        val day = CalendarDates.draftFromEvent(allDay("学会", "2026-10-05", "2026-10-07"))
        assertEquals(d("2026-10-05") to d("2026-10-07"), day.startDay to day.endDay)
        assertTrue(day.allDay)
        assertNull(day.calendar)
    }

    @Test
    fun movingTheStartKeepsTheLengthAndSwitchingKindKeepsTheEndAfterTheStart() {
        val moved = CalendarDates.withStart(base.copy(endTime = LocalTime.of(11, 30)), d("2026-10-02"), LocalTime.of(23, 0))
        assertEquals(d("2026-10-02") to LocalTime.of(23, 0), moved.startDay to moved.startTime)
        assertEquals(d("2026-10-03") to LocalTime.of(0, 30), moved.endDay to moved.endTime) // 1.5 hours, past midnight
        val days = CalendarDates.withStart(base.copy(allDay = true, endDay = d("2026-10-03")), d("2026-10-10"))
        assertEquals(d("2026-10-10") to d("2026-10-12"), days.startDay to days.endDay)
        // A timed event ending on an earlier day (not sendable) keeps its start day when it turns all-day.
        val switched = CalendarDates.withAllDay(base.copy(endDay = d("2026-09-30"), alarm = 30), true)
        assertEquals(d("2026-10-01"), switched.endDay)
        assertEquals(-480, switched.alarm)
    }

    @Test
    fun theAlarmsAreTheKindsOwnAndTheDayBeforeSurvivesASwitch() {
        assertEquals(listOf(null, 0, 5, 10, 15, 30, 60, 1440), CalendarDates.alarmChoices(false).map { it.value })
        assertEquals(listOf("なし", "前日 8:00", "当日 8:00"), CalendarDates.alarmChoices(true).map { it.label })
        assertEquals(-480, CalendarDates.remapAlarm(30, true))
        assertEquals(1440, CalendarDates.remapAlarm(1440, true))
        assertEquals(60, CalendarDates.remapAlarm(-480, false))
        assertNull(CalendarDates.remapAlarm(null, true))
        assertEquals("1 時間前", CalendarDates.alarmLabel(60, false))
        assertEquals("なし", CalendarDates.alarmLabel(null, true))
    }

    @Test
    fun anAlarmThatFiresWhileTheAppIsOpenReadsLikeThePush() {
        assertEquals("14:00 ゼミ (#m2-進捗)", CalendarDates.alarmText(timed("ゼミ", "2026-10-01T05:00:00Z", "2026-10-01T06:00:00Z", channelName = "m2-進捗")))
        assertEquals("終日 学会", CalendarDates.alarmText(allDay("学会", "2026-10-05")))
    }

    // --- colours ---

    @Test
    fun eachChannelHasOneFixedColourTheSameAsOnTheDesktopAndMineIsSlate() {
        // The values the desktop's channelColor gives (FNV-1a of the id into the same 9 colours).
        assertEquals(0xFFEA580C, CalendarDates.channelColor("0199a0b0-1111-7000-8000-000000000001"))
        assertEquals(0xFFDC2626, CalendarDates.channelColor("c1"))
        assertEquals(0xFFDB2777, CalendarDates.channelColor("channel-0"))
        assertEquals(0xFF0891B2, CalendarDates.channelColor("channel-7"))
        assertEquals(CalendarDates.OWN_COLOR, CalendarDates.channelColor(null))
        assertTrue((0 until 20).map { CalendarDates.channelColor("channel-$it") }.toSet().size > 4)
    }

    @Test
    fun theCalendarsAreMyPublicAndPrivateChannelsAndTheOnesIMayPostInTakeNewEvents() {
        fun state(id: String, type: String = "public", member: Boolean = true, archived: Boolean = false, policy: String? = null, role: String = "member") =
            jp.chikuwachat.android.sync.ChannelState(
                jp.chikuwachat.android.api.ChannelOut(
                    id = id, type = type, name = id, archived = archived, lastSeq = 0, createdAt = "2026-10-01T00:00:00Z", updatedAt = "2026-10-01T00:00:00Z",
                    postingPolicy = policy, membership = jp.chikuwachat.android.api.MembershipOut(role, "2026-10-01T00:00:00Z"),
                ),
                isMember = member,
            )
        val channels = listOf(
            state("zemi"), state("lab", type = "private"), state("dm1", type = "dm"), state("g1", type = "group_dm"), state("browse", member = false),
            state("old", archived = true), state("news", policy = "owners"), state("ours", policy = "owners", role = "owner"),
        )
        assertEquals(listOf("lab", "news", "old", "ours", "zemi"), jp.chikuwachat.android.ui.CalendarChannels.readable(channels).map { it.id })
        assertEquals(listOf("lab", "ours", "zemi"), jp.chikuwachat.android.ui.CalendarChannels.writable(channels, isAdmin = false).map { it.id })
        assertEquals(listOf("lab", "news", "ours", "zemi"), jp.chikuwachat.android.ui.CalendarChannels.writable(channels, isAdmin = true).map { it.id })
    }

    @Test
    fun theFilterKeepsAllMineOrOneChannel() {
        val events = listOf(timed("mine", "2026-10-01T05:00:00Z", "2026-10-01T06:00:00Z"), timed("lab", "2026-10-01T05:00:00Z", "2026-10-01T06:00:00Z", channelId = "c1"))
        assertEquals(2, CalendarDates.filterEvents(events, CalendarDates.FILTER_ALL).size)
        assertEquals(listOf("mine"), CalendarDates.filterEvents(events, CalendarDates.FILTER_ME).map { it.title })
        assertEquals(listOf("lab"), CalendarDates.filterEvents(events, "c1").map { it.title })
    }
}
