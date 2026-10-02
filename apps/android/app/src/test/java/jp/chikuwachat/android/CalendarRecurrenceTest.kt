package jp.chikuwachat.android

import jp.chikuwachat.android.CalendarFixtures.occurrence
import jp.chikuwachat.android.CalendarFixtures.timed
import jp.chikuwachat.android.api.CalendarAlarmUpdated
import jp.chikuwachat.android.api.CalendarEventOut
import jp.chikuwachat.android.api.CalendarFeedCreated
import jp.chikuwachat.android.api.Codec
import jp.chikuwachat.android.ui.CalendarDates
import jp.chikuwachat.android.ui.CalendarRecurrence
import jp.chikuwachat.android.ui.CalendarRecurrence.describeRrule
import jp.chikuwachat.android.ui.CalendarRecurrence.monthlyChoices
import jp.chikuwachat.android.ui.CalendarRecurrence.noRepeat
import jp.chikuwachat.android.ui.CalendarRecurrence.nthOfMonth
import jp.chikuwachat.android.ui.CalendarRecurrence.repeatProblem
import jp.chikuwachat.android.ui.CalendarRecurrence.repeatToRrule
import jp.chikuwachat.android.ui.CalendarRecurrence.ruleChanged
import jp.chikuwachat.android.ui.CalendarRecurrence.rruleToRepeat
import jp.chikuwachat.android.ui.EventDraftSaver
import jp.chikuwachat.android.ui.MonthlyMode
import jp.chikuwachat.android.ui.OccurrenceScope
import jp.chikuwachat.android.ui.RepeatDraft
import jp.chikuwachat.android.ui.RepeatEnd
import jp.chikuwachat.android.ui.RepeatFreq
import jp.chikuwachat.android.ui.RepeatKind
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import java.time.LocalDate
import java.time.LocalTime

/**
 * M69 (CALENDAR.md §10): 「繰り返し」 on Android — the picker to a rule (normalized as the server stores it), a rule back to
 * the picker and to words (the cases of the desktop's calendarRecurrence.test.ts), what an occurrence's change sends, and
 * the new fields decoded.
 */
class CalendarRecurrenceTest {
    @get:Rule val tokyo = TokyoZone()

    /** The 2nd Tuesday of October 2026. */
    private val tuesday = LocalDate.parse("2026-10-13")
    private fun day(text: String) = LocalDate.parse(text)
    private fun repeat(start: LocalDate = tuesday, patch: (RepeatDraft) -> RepeatDraft) = patch(noRepeat(start))

    @Test
    fun makesThePresets() {
        assertNull(repeatToRrule(repeat { it.copy(kind = RepeatKind.NONE) }, tuesday))
        assertEquals("FREQ=DAILY", repeatToRrule(repeat { it.copy(kind = RepeatKind.DAILY) }, tuesday))
        // 毎週 starts with the start's weekday; the days go Monday first, as the server stores them.
        assertEquals("FREQ=WEEKLY;BYDAY=TU", repeatToRrule(repeat { it.copy(kind = RepeatKind.WEEKLY) }, tuesday))
        assertEquals("FREQ=WEEKLY;BYDAY=TU,TH,SU", repeatToRrule(repeat { it.copy(kind = RepeatKind.WEEKLY, weekdays = listOf(4, 0, 2)) }, tuesday))
        assertEquals("FREQ=MONTHLY;BYMONTHDAY=13", repeatToRrule(repeat { it.copy(kind = RepeatKind.MONTHLY) }, tuesday))
        assertEquals("FREQ=MONTHLY;BYDAY=2TU", repeatToRrule(repeat { it.copy(kind = RepeatKind.MONTHLY, monthly = MonthlyMode.NTH) }, tuesday))
        val friday = day("2026-10-30")
        assertEquals("FREQ=MONTHLY;BYDAY=-1FR", repeatToRrule(repeat(friday) { it.copy(kind = RepeatKind.MONTHLY, monthly = MonthlyMode.LAST) }, friday))
        val lastDay = day("2026-10-31")
        assertEquals("FREQ=MONTHLY;BYMONTHDAY=-1", repeatToRrule(repeat(lastDay) { it.copy(kind = RepeatKind.MONTHLY, monthly = MonthlyMode.MONTH_END) }, lastDay))
        assertEquals("FREQ=YEARLY", repeatToRrule(repeat { it.copy(kind = RepeatKind.YEARLY) }, tuesday))
    }

    @Test
    fun makesACustomRuleWithAnIntervalAndAnEnd() {
        assertEquals(
            "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE",
            repeatToRrule(repeat { it.copy(kind = RepeatKind.CUSTOM, freq = RepeatFreq.WEEKLY, interval = 2, weekdays = listOf(1, 3)) }, tuesday),
        )
        assertEquals(
            "FREQ=DAILY;INTERVAL=3;COUNT=10",
            repeatToRrule(repeat { it.copy(kind = RepeatKind.CUSTOM, freq = RepeatFreq.DAILY, interval = 3, end = RepeatEnd.COUNT, count = 10) }, tuesday),
        )
        assertEquals("FREQ=DAILY;UNTIL=20261220", repeatToRrule(repeat { it.copy(kind = RepeatKind.DAILY, end = RepeatEnd.UNTIL, until = day("2026-12-20")) }, tuesday))
        // A preset has no interval of its own.
        assertEquals("FREQ=DAILY", repeatToRrule(repeat { it.copy(kind = RepeatKind.DAILY, interval = 5) }, tuesday))
    }

    @Test
    fun readsARuleBackIntoThePicker() {
        rruleToRepeat("FREQ=WEEKLY;BYDAY=TU,TH;UNTIL=20261220", tuesday).let {
            assertEquals(RepeatKind.WEEKLY, it.kind)
            assertEquals(listOf(2, 4), it.weekdays)
            assertEquals(RepeatEnd.UNTIL, it.end)
            assertEquals(day("2026-12-20"), it.until)
        }
        rruleToRepeat("FREQ=MONTHLY;BYDAY=2TU;COUNT=5", tuesday).let {
            assertEquals(RepeatKind.MONTHLY, it.kind)
            assertEquals(MonthlyMode.NTH, it.monthly)
            assertEquals(RepeatEnd.COUNT, it.end)
            assertEquals(5, it.count)
        }
        assertEquals(MonthlyMode.LAST, rruleToRepeat("FREQ=MONTHLY;BYDAY=-1FR", day("2026-10-30")).monthly)
        assertEquals(MonthlyMode.MONTH_END, rruleToRepeat("FREQ=MONTHLY;BYMONTHDAY=-1", day("2026-10-31")).monthly)
        rruleToRepeat("FREQ=DAILY;INTERVAL=2", tuesday).let {
            assertEquals(RepeatKind.CUSTOM, it.kind)
            assertEquals(RepeatFreq.DAILY, it.freq)
            assertEquals(2, it.interval)
        }
        assertEquals(RepeatKind.NONE, rruleToRepeat(null, tuesday).kind)
        // One this client cannot read is しない (nothing invented), and its words say only 「繰り返し」.
        assertEquals(RepeatKind.NONE, rruleToRepeat("FREQ=HOURLY", tuesday).kind)
        assertEquals("繰り返し", describeRrule("FREQ=WEEKLY;BYDAY=XX", tuesday))
        for (rule in listOf("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE", "FREQ=MONTHLY;BYDAY=2TU;COUNT=5", "FREQ=YEARLY;UNTIL=20301013")) {
            assertEquals(rule, repeatToRrule(rruleToRepeat(rule, tuesday), tuesday))
        }
    }

    @Test
    fun tellsAChangedRuleFromTheSameOneWrittenDifferently() {
        assertFalse(ruleChanged(rruleToRepeat("FREQ=WEEKLY", tuesday), tuesday, "FREQ=WEEKLY"))
        assertFalse(ruleChanged(repeat { it.copy(kind = RepeatKind.WEEKLY) }, tuesday, "FREQ=WEEKLY;BYDAY=TU"))
        assertTrue(ruleChanged(repeat { it.copy(kind = RepeatKind.WEEKLY, weekdays = listOf(2, 4)) }, tuesday, "FREQ=WEEKLY;BYDAY=TU"))
        assertTrue(ruleChanged(repeat { it.copy(kind = RepeatKind.NONE) }, tuesday, "FREQ=DAILY"))
        assertFalse(ruleChanged(repeat { it.copy(kind = RepeatKind.NONE) }, tuesday, null))
    }

    @Test
    fun offersTheMonthsChoicesForTheDay() {
        assertEquals(2 to false, nthOfMonth(tuesday))
        assertEquals(listOf("毎月 13 日", "毎月 第 2 火曜日"), monthlyChoices(tuesday).map { it.label })
        assertEquals(listOf("毎月 27 日", "毎月 第 4 火曜日", "毎月 最終 火曜日"), monthlyChoices(day("2026-10-27")).map { it.label })
        assertEquals(listOf("毎月 31 日", "毎月 月末", "毎月 最終 土曜日"), monthlyChoices(day("2026-10-31")).map { it.label })
        // A 5th weekday is only 「最終」.
        assertEquals(listOf(MonthlyMode.DAY, MonthlyMode.LAST), monthlyChoices(day("2026-10-29")).map { it.value })
    }

    @Test
    fun checksThePicker() {
        assertEquals("曜日を選んでください", repeatProblem(repeat { it.copy(kind = RepeatKind.WEEKLY, weekdays = emptyList()) }, tuesday))
        assertEquals("間隔は 1〜99 にしてください", repeatProblem(repeat { it.copy(kind = RepeatKind.CUSTOM, interval = 0) }, tuesday))
        assertEquals("終了日は開始日より後にしてください", repeatProblem(repeat { it.copy(kind = RepeatKind.DAILY, end = RepeatEnd.UNTIL, until = day("2026-10-01")) }, tuesday))
        assertEquals("終了日を入れてください", repeatProblem(repeat { it.copy(kind = RepeatKind.DAILY, end = RepeatEnd.UNTIL, until = null) }, tuesday))
        assertEquals("回数は 1〜999 にしてください", repeatProblem(repeat { it.copy(kind = RepeatKind.DAILY, end = RepeatEnd.COUNT, count = 1000) }, tuesday))
        assertNull(repeatProblem(repeat { it.copy(kind = RepeatKind.DAILY, end = RepeatEnd.COUNT, count = 3) }, tuesday))
        val draft = CalendarDates.newDraft(tuesday).copy(title = "x", repeat = repeat { it.copy(kind = RepeatKind.WEEKLY, weekdays = emptyList()) })
        assertEquals("曜日を選んでください", CalendarDates.draftProblem(draft))
    }

    @Test
    fun aRuleInWords() {
        val cases = listOf(
            "FREQ=DAILY" to "毎日",
            "FREQ=DAILY;INTERVAL=3" to "3 日ごと",
            "FREQ=WEEKLY;BYDAY=TU,TH" to "毎週 火・木曜日",
            "FREQ=WEEKLY" to "毎週 火曜日",
            "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO" to "2 週間ごと 月曜日",
            "FREQ=MONTHLY;BYMONTHDAY=10" to "毎月 10 日",
            "FREQ=MONTHLY" to "毎月 13 日",
            "FREQ=MONTHLY;BYMONTHDAY=-1" to "毎月 月末",
            "FREQ=MONTHLY;BYDAY=2TU" to "毎月 第 2 火曜日",
            "FREQ=MONTHLY;BYDAY=-1FR" to "毎月 最終 金曜日",
            "FREQ=YEARLY" to "毎年 10月13日",
            "FREQ=WEEKLY;BYDAY=TU;UNTIL=20261220" to "毎週 火曜日、2026年12月20日まで",
            "FREQ=DAILY;COUNT=10" to "毎日、10 回",
        )
        cases.forEach { (rule, words) -> assertEquals(rule, words, describeRrule(rule, tuesday)) }
        assertEquals("繰り返さない", describeRrule(null, tuesday))
    }

    @Test
    fun theFormSendsTheRuleWhenMadeAndOnlyWhatChangedForAnOccurrence() {
        val draft = CalendarDates.newDraft(tuesday).copy(title = "ゼミ", repeat = repeat { it.copy(kind = RepeatKind.WEEKLY, weekdays = listOf(2, 4)) })
        assertEquals("FREQ=WEEKLY;BYDAY=TU,TH", CalendarDates.draftToCreate(draft, "Asia/Tokyo", "k").rrule)
        val oneOff = CalendarDates.draftToCreate(draft.copy(repeat = noRepeat(tuesday)), "Asia/Tokyo", "k")
        assertNull(oneOff.rrule)
        // Left out of the body (an older server sees the request it knew).
        assertFalse("rrule" in Codec.snake.encodeToJsonElement(jp.chikuwachat.android.api.CalendarEventCreate.serializer(), oneOff).jsonObject)

        val event = occurrence("ゼミ", "2026-10-13T05:00:00Z", "2026-10-13T06:00:00Z", series = "s1", rrule = "FREQ=WEEKLY;BYDAY=TU")
        val opened = CalendarDates.draftFromEvent(event)
        assertEquals(RepeatKind.WEEKLY, opened.repeat.kind)
        assertEquals(listOf(2), opened.repeat.weekdays)
        assertEquals(JsonObject(emptyMap()), CalendarDates.draftChanges(opened, opened))
        assertEquals("""{"title":"輪講"}""", CalendarDates.draftChanges(opened.copy(title = "輪講"), opened).toString())
        assertEquals("""{"location":"501"}""", CalendarDates.draftChanges(opened.copy(location = "501"), opened).toString())
        assertEquals("""{"location":null}""", CalendarDates.draftChanges(opened.copy(location = " "), opened.copy(location = "501")).toString())
        assertEquals(
            """{"all_day":false,"starts_at":"2026-10-13T06:00:00Z","ends_at":"2026-10-13T07:00:00Z","start_date":null,"end_date":null}""",
            CalendarDates.draftChanges(opened.copy(startTime = LocalTime.of(15, 0), endTime = LocalTime.of(16, 0)), opened).toString(),
        )
        assertFalse(CalendarDates.occurrenceChanged(opened.copy(alarm = 10), opened, event.rrule))
        assertTrue(CalendarDates.occurrenceChanged(opened.copy(title = "輪講"), opened, event.rrule))
        assertTrue(CalendarDates.occurrenceChanged(opened.copy(repeat = opened.repeat.copy(weekdays = listOf(2, 4))), opened, event.rrule))
    }

    @Test
    fun theScopeRequestCarriesTheScopeTheChangesAndARuleOnlyBeyondThisOne() {
        val event = occurrence("ゼミ", "2026-10-13T05:00:00Z", "2026-10-13T06:00:00Z", series = "s1", rrule = "FREQ=WEEKLY;BYDAY=TU")
        val opened = CalendarDates.draftFromEvent(event)
        val retitled = opened.copy(title = "輪講")
        assertEquals("""{"scope":"this","title":"輪講"}""", CalendarDates.occurrenceUpdate(OccurrenceScope.THIS, retitled, opened, event.rrule).toString())
        assertEquals("""{"scope":"all","title":"輪講"}""", CalendarDates.occurrenceUpdate(OccurrenceScope.ALL, retitled, opened, event.rrule).toString())
        val twice = opened.copy(repeat = opened.repeat.copy(weekdays = listOf(2, 4)))
        assertEquals("""{"scope":"following","rrule":"FREQ=WEEKLY;BYDAY=TU,TH"}""", CalendarDates.occurrenceUpdate(OccurrenceScope.FOLLOWING, twice, opened, event.rrule).toString())
        // No longer repeating, from here on: the rule goes as null.
        val stop = opened.copy(repeat = opened.repeat.copy(kind = RepeatKind.NONE))
        assertEquals("""{"scope":"following","rrule":null}""", CalendarDates.occurrenceUpdate(OccurrenceScope.FOLLOWING, stop, opened, event.rrule).toString())
        // 「この予定」 is not offered for a rule changed, or for all-day ↔ timed; deleting offers all three.
        assertEquals(OccurrenceScope.entries, CalendarDates.scopesFor(false, retitled, event))
        assertEquals(listOf(OccurrenceScope.FOLLOWING, OccurrenceScope.ALL), CalendarDates.scopesFor(false, twice, event))
        assertEquals(listOf(OccurrenceScope.FOLLOWING, OccurrenceScope.ALL), CalendarDates.scopesFor(false, CalendarDates.withAllDay(opened, true), event))
        assertEquals(OccurrenceScope.entries, CalendarDates.scopesFor(true, twice, event))
        assertEquals(listOf("この予定", "これ以降すべて", "すべての予定"), OccurrenceScope.entries.map { it.label })
        // The path: the key escaped (its colons), the scope in DELETE's query.
        assertEquals("/api/v1/calendar/events/s1/occurrences/2026-10-13T05%3A00%3A00Z", CalendarRecurrence.occurrencePath("s1", event.occurrenceKey))
        assertEquals("/api/v1/calendar/events/s1/occurrences/2026-10-13?scope=following", CalendarRecurrence.occurrencePath("s1", "2026-10-13", OccurrenceScope.FOLLOWING))
    }

    @Test
    fun aOneOffEventMadeRecurringSendsItsRuleAndZone() {
        val draft = CalendarDates.newDraft(tuesday).copy(title = "ゼミ")
        assertFalse("rrule" in CalendarDates.draftToPatch(draft, "Asia/Tokyo").toJson())
        val weekly = CalendarDates.draftToPatch(draft.copy(repeat = draft.repeat.copy(kind = RepeatKind.WEEKLY)), "Asia/Tokyo").toJson()
        assertEquals("\"FREQ=WEEKLY;BYDAY=TU\"", weekly["rrule"].toString())
        assertEquals("\"Asia/Tokyo\"", weekly["tz"].toString())
    }

    @Test
    fun beforeARuleIsChosenTheWeekdayFollowsTheStart() {
        val draft = CalendarDates.newDraft(tuesday)
        val moved = CalendarDates.withStart(draft, day("2026-10-15"))
        assertEquals(listOf(4), moved.repeat.weekdays)
        // A rule chosen keeps its days.
        val chosen = draft.copy(repeat = draft.repeat.copy(kind = RepeatKind.WEEKLY, weekdays = listOf(2, 4)))
        assertEquals(listOf(2, 4), CalendarDates.withStart(chosen, day("2026-10-16")).repeat.weekdays)
    }

    @Test
    fun theRepeatLineAndThePickerAcrossARotation() {
        val event = occurrence("ゼミ", "2026-10-20T05:00:00Z", "2026-10-20T06:00:00Z", series = "s1", rrule = "FREQ=WEEKLY;BYDAY=TU,TH;COUNT=8")
        assertEquals("🔁 毎週 火・木曜日、8 回", CalendarDates.repeatLine(event))
        assertNull(CalendarDates.repeatLine(timed("単発", "2026-10-20T05:00:00Z", "2026-10-20T06:00:00Z")))
        val draft = CalendarDates.draftFromEvent(event).copy(repeat = RepeatDraft(RepeatKind.CUSTOM, RepeatFreq.MONTHLY, 3, listOf(1, 5), MonthlyMode.LAST, RepeatEnd.UNTIL, day("2027-03-01"), 4))
        val saved = with(EventDraftSaver) { androidx.compose.runtime.saveable.SaverScope { true }.save(draft) }!!
        assertEquals(draft, EventDraftSaver.restore(saved))
        // A form saved before M69 (ten fields) comes back without a rule.
        assertEquals(RepeatKind.NONE, EventDraftSaver.restore((saved as List<*>).take(10))!!.repeat.kind)
    }

    @Test
    fun theNewFieldsAreDecodedAndAnOlderServersShapeStillIs() {
        val event = Codec.snake.decodeFromString(
            CalendarEventOut.serializer(),
            """{"id": "o2", "title": "ゼミ", "all_day": false, "starts_at": "2026-10-20T05:00:00Z", "ends_at": "2026-10-20T06:00:00Z",
               "series_id": "s1", "occurrence_start": "2026-10-20T05:00:00Z", "recurring": true, "rrule": "FREQ=WEEKLY;BYDAY=TU", "tz": "Asia/Tokyo",
               "can_edit": true, "alarm": {"minutes_before": 10, "fire_at": "2026-10-20T04:50:00Z", "status": "pending", "occurrence_start": "2026-10-20T05:00:00Z"},
               "something_new": 1}""",
        )
        assertEquals("s1", event.series)
        assertTrue(event.recurring)
        assertEquals("2026-10-20T05:00:00Z", event.occurrenceKey)
        assertEquals("2026-10-20T05:00:00Z", event.alarm?.occurrenceStart)
        val old = Codec.snake.decodeFromString(CalendarEventOut.serializer(), """{"id": "e1", "title": "単発", "all_day": true, "start_date": "2026-10-20", "end_date": "2026-10-20"}""")
        assertEquals("e1", old.series)
        assertFalse(old.recurring)
        assertNull(old.rrule)
        assertEquals("2026-10-20", old.occurrenceKey)
        val alarm = Codec.snake.decodeFromString(CalendarAlarmUpdated.serializer(), """{"event_id": "e1", "alarm": {"minutes_before": 0, "fire_at": "x", "status": "fired", "occurrence_start": null}}""")
        assertNull(alarm.alarm?.occurrenceStart)
        val created = Codec.snake.decodeFromString(
            CalendarFeedCreated.serializer(),
            """{"feed": {"id": "f1", "scope": "personal", "created_at": "2026-10-02T03:00:00Z", "last_used_at": null}, "url": "https://x/api/v1/calendar/ical/t.ics"}""",
        )
        assertEquals("personal", created.feed.scope)
        assertNull(created.feed.lastUsedAt)
    }
}
