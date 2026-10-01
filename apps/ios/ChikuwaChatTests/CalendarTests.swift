import XCTest
@testable import ChikuwaChat

/// M52: calendar events for the tests, shaped like the server's CalendarEventOut (the web's tests/calendarFixtures.ts).
@MainActor
enum CalendarFixtures {
    nonisolated(unsafe) static var n = 0

    static func timed(_ title: String, _ startsAt: String, _ endsAt: String, id: String? = nil, channelId: String? = nil,
                      channelName: String? = nil, ownerId: String = "me", canEdit: Bool = true, alarm: CalendarAlarmOut? = nil,
                      location: String? = nil) -> CalendarEventOut {
        n += 1
        return CalendarEventOut(id: id ?? "e\(n)", channelId: channelId, channelName: channelName ?? channelId, ownerId: ownerId, title: title,
                                allDay: false, startsAt: startsAt, endsAt: endsAt, startDate: nil, endDate: nil, location: location, description: nil,
                                createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", canEdit: canEdit, alarm: alarm)
    }

    static func allDay(_ title: String, _ start: String, _ end: String? = nil, id: String? = nil, channelId: String? = nil,
                       channelName: String? = nil, canEdit: Bool = true) -> CalendarEventOut {
        var event = timed(title, "", "", id: id, channelId: channelId, channelName: channelName, canEdit: canEdit)
        event.allDay = true
        event.startsAt = nil
        event.endsAt = nil
        event.startDate = start
        event.endDate = end ?? start
        return event
    }

    /// The event as calendar.event.updated carries it: no can_edit, no alarm (CALENDAR.md §9 1.).
    static func shared(_ event: CalendarEventOut) -> JSONValue {
        func text(_ value: String?) -> JSONValue { value.map(JSONValue.string) ?? .null }
        return .object([
            "id": .string(event.id), "channel_id": text(event.channelId), "channel_name": text(event.channelName), "owner_id": .string(event.ownerId),
            "title": .string(event.title), "all_day": .bool(event.allDay), "starts_at": text(event.startsAt), "ends_at": text(event.endsAt),
            "start_date": text(event.startDate), "end_date": text(event.endDate), "location": text(event.location),
            "description": text(event.description), "created_at": .string(event.createdAt), "updated_at": .string(event.updatedAt),
        ])
    }

    static func updated(_ event: CalendarEventOut, editors: [String]) -> JSONValue {
        .object(["event": shared(event), "editor_ids": .array(editors.map(JSONValue.string))])
    }

    static func alarm(_ minutes: Int, status: String = "pending") -> CalendarAlarmOut {
        CalendarAlarmOut(minutesBefore: minutes, fireAt: "2026-10-05T04:50:00Z", status: status)
    }

    static func alarmUpdated(_ eventId: String, channelId: String? = nil, _ alarm: CalendarAlarmOut?) -> JSONValue {
        let value: JSONValue = alarm.map { .object(["minutes_before": .number(Double($0.minutesBefore)), "fire_at": .string($0.fireAt),
                                                    "status": .string($0.status)]) } ?? .null
        return .object(["event_id": .string(eventId), "channel_id": channelId.map(JSONValue.string) ?? .null, "alarm": value])
    }
}

/// The calendar calls, over rows the test sets.
@MainActor
final class FakeCalendarApi: CalendarApi {
    var rows: [CalendarEventOut]
    var upcoming: [CalendarEventOut] = []
    var eventsError: Error?
    private(set) var eventsCalls: [(from: Date, to: Date, channelId: String?)] = []
    private(set) var upcomingCalls: [(channelId: String?, days: Int, tz: String)] = []
    private(set) var creates: [CalendarEventCreate] = []
    private(set) var alarmCalls: [(id: String, minutes: Int?, tz: String?)] = []
    private(set) var deletes: [String] = []

    init(_ rows: [CalendarEventOut] = []) { self.rows = rows }

    func calendarEvents(from: Date, to: Date, channelId: String?) async throws -> [CalendarEventOut] {
        eventsCalls.append((from, to, channelId))
        if let eventsError { throw eventsError }
        return rows.filter { channelId == nil || $0.channelId == channelId }
    }

    func calendarUpcoming(channelId: String?, days: Int, tz: String) async throws -> [CalendarEventOut] {
        upcomingCalls.append((channelId, days, tz))
        return upcoming
    }

    func calendarEvent(id: String) async throws -> CalendarEventOut {
        guard let row = rows.first(where: { $0.id == id }) else { throw ApiError.api(status: 404, code: "calendar_event_not_found", message: "") }
        return row
    }

    func createCalendarEvent(_ body: CalendarEventCreate) async throws -> CalendarEventOut {
        creates.append(body)
        let event = CalendarFixtures.timed(body.title, body.timing.startsAt ?? "", body.timing.endsAt ?? "", id: "new", channelId: body.channelId)
        rows.append(event)
        return event
    }

    func updateCalendarEvent(id: String, _ patch: CalendarEventPatch) async throws -> CalendarEventOut {
        guard let index = rows.firstIndex(where: { $0.id == id }) else { throw ApiError.api(status: 404, code: "calendar_event_not_found", message: "") }
        rows[index].title = patch.title
        return rows[index]
    }

    func deleteCalendarEvent(id: String) async throws {
        deletes.append(id)
        rows.removeAll { $0.id == id }
    }

    func setCalendarAlarm(id: String, minutesBefore: Int, tz: String) async throws -> CalendarEventOut {
        alarmCalls.append((id, minutesBefore, tz))
        guard let index = rows.firstIndex(where: { $0.id == id }) else { throw ApiError.api(status: 404, code: "calendar_event_not_found", message: "") }
        rows[index].alarm = CalendarFixtures.alarm(minutesBefore)
        return rows[index]
    }

    func clearCalendarAlarm(id: String) async throws {
        alarmCalls.append((id, nil, nil))
    }
}

/// The date math (UI/CalendarDates.swift), in Tokyo like the lab's devices: the web's tests/calendarDates.test.ts.
@MainActor
final class CalendarDatesTests: XCTestCase {
    override func setUp() { CalendarDates.zoneOverride = TimeZone(identifier: "Asia/Tokyo") }
    override func tearDown() { CalendarDates.zoneOverride = nil }

    private func iso(_ text: String) -> Date { parseIsoDate(text)! }
    private typealias F = CalendarFixtures

    func testWeeksStartOnSunday() {
        let weeks = CalendarDates.monthGrid("2026-10-15") // 1 Oct 2026 is a Thursday
        XCTAssertEqual(weeks.count, 5)
        XCTAssertEqual(weeks[0], ["2026-09-27", "2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03"])
        XCTAssertEqual(weeks[4][6], "2026-10-31")
        XCTAssertEqual(CalendarDates.monthGrid("2026-02-01").count, 4) // Feb 2026: Sunday the 1st to Saturday the 28th
        XCTAssertEqual(CalendarDates.monthGrid("2026-08-01").count, 6) // Aug 2026: Saturday the 1st, 31 days
        XCTAssertEqual(CalendarDates.weekStart("2026-10-01"), "2026-09-27")
        XCTAssertEqual(CalendarDates.weekStart("2026-10-04"), "2026-10-04")
        XCTAssertEqual(CalendarDates.weekday("2026-10-01"), 4)
    }

    func testRangesAndLocalMidnights() {
        XCTAssertTrue(CalendarDates.monthRange("2026-10-15") == ("2026-09-27", "2026-11-01"))
        XCTAssertEqual(CalendarDates.addDays("2026-10-01", CalendarDates.listDays), "2026-11-30")
        XCTAssertEqual(CalendarDates.isoLocal(CalendarDates.parseDay("2026-10-01")), "2026-10-01T00:00:00+09:00")
        XCTAssertEqual(CalendarDates.isoLocal(CalendarDates.parseDay("2026-10-02")), "2026-10-02T00:00:00+09:00")
        XCTAssertEqual(CalendarDates.isoLocal(iso("2026-10-01T05:30:00Z")), "2026-10-01T14:30:00+09:00")
        XCTAssertEqual(CalendarDates.daysBetween("2026-10-30", "2026-11-02"), 3)
        XCTAssertEqual(CalendarDates.addDays("2026-12-31", 1), "2027-01-01")
        XCTAssertEqual(CalendarDates.addMonths("2026-12-15", 1), "2027-01-01")
        XCTAssertEqual(CalendarDates.addMonths("2026-01-31", -1), "2025-12-01")
        XCTAssertEqual(CalendarDates.dayKey(iso("2026-09-30T15:00:00Z")), "2026-10-01") // midnight in Tokyo
    }

    func testTimedEventsCoverTheirLocalDaysUpToTheInstantBeforeTheirEnd() {
        // 23:00–01:00 Tokyo crosses midnight; one ending exactly at midnight stays on its day.
        XCTAssertTrue(CalendarDates.eventDays(F.timed("late", "2026-10-01T14:00:00Z", "2026-10-01T16:00:00Z")) == ("2026-10-01", "2026-10-02"))
        XCTAssertTrue(CalendarDates.eventDays(F.timed("to midnight", "2026-10-01T13:00:00Z", "2026-10-01T15:00:00Z")) == ("2026-10-01", "2026-10-01"))
        XCTAssertTrue(CalendarDates.eventDays(F.allDay("学会", "2026-10-05", "2026-10-07")) == ("2026-10-05", "2026-10-07"))
    }

    func testOverlapsARangeLikeTheServer() {
        let from = CalendarDates.parseDay("2026-10-01"), to = CalendarDates.parseDay("2026-10-02")
        let overlaps = { (event: CalendarEventOut) in CalendarDates.overlaps(event, from: from, to: to) }
        XCTAssertFalse(overlaps(F.timed("ends at from", "2026-09-30T14:00:00Z", "2026-09-30T15:00:00Z")))
        XCTAssertFalse(overlaps(F.timed("starts at to", "2026-10-01T15:00:00Z", "2026-10-01T16:00:00Z")))
        XCTAssertTrue(overlaps(F.timed("inside", "2026-10-01T01:00:00Z", "2026-10-01T02:00:00Z")))
        XCTAssertTrue(overlaps(F.timed("around", "2026-09-30T00:00:00Z", "2026-10-03T00:00:00Z")))
        XCTAssertTrue(overlaps(F.allDay("on the day", "2026-10-01")))
        XCTAssertFalse(overlaps(F.allDay("next day", "2026-10-02")))
        XCTAssertFalse(overlaps(F.allDay("day before", "2026-09-30")))
        XCTAssertTrue(overlaps(F.allDay("span", "2026-09-20", "2026-10-10")))
    }

    func testOrdersADaysEventsAndSaysTheirTimes() {
        let events = [
            F.timed("14:00", "2026-10-01T05:00:00Z", "2026-10-01T06:00:00Z"),
            F.timed("9:30", "2026-10-01T00:30:00Z", "2026-10-01T01:00:00Z"),
            F.allDay("学会", "2026-10-01"),
            F.timed("前日から", "2026-09-30T14:00:00Z", "2026-10-01T01:00:00Z"),
            F.allDay("明日", "2026-10-02"),
        ]
        XCTAssertEqual(CalendarDates.eventsOn(events, "2026-10-01").map(\.title), ["前日から", "学会", "9:30", "14:00"])
        let overnight = events[3]
        XCTAssertEqual(CalendarDates.timeOnDay(overnight, "2026-09-30"), "23:00〜")
        XCTAssertEqual(CalendarDates.timeOnDay(overnight, "2026-10-01"), "〜10:00")
        XCTAssertEqual(CalendarDates.timeOnDay(events[0], "2026-10-01"), "14:00〜15:00")
        XCTAssertEqual(CalendarDates.timeOnDay(events[2], "2026-10-01"), "終日")
        XCTAssertEqual(CalendarDates.eventWhen(events[0]), "10月1日 (木) 14:00〜15:00")
        XCTAssertEqual(CalendarDates.eventWhen(F.allDay("学会", "2026-10-05", "2026-10-07")), "10月5日 (月)〜10月7日 (水) 終日")
        XCTAssertEqual(CalendarDates.eventWhen(F.allDay("休み", "2026-10-05")), "10月5日 (月) 終日")
        XCTAssertEqual(CalendarDates.eventWhen(overnight), "9月30日 (水) 23:00〜10月1日 (木) 10:00")
        // All-day first, then by time, then by title.
        XCTAssertEqual(events.sorted(by: CalendarDates.inOrder).map(\.title), ["前日から", "学会", "9:30", "14:00", "明日"])
        // The list: only the days with events, from the first day.
        let agenda = CalendarDates.agenda(events, from: "2026-10-01", to: "2026-10-04")
        XCTAssertEqual(agenda.map(\.day), ["2026-10-01", "2026-10-02"])
        XCTAssertEqual(CalendarDates.monthLabel("2026-10-15"), "2026年10月")
        XCTAssertEqual(CalendarDates.dayLabel("2026-10-04"), "10月4日 (日)")
    }

    func testWordsForTheAlarmAndTheTab() {
        XCTAssertEqual(CalendarDates.alarmText(F.timed("ゼミ", "2026-10-01T05:00:00Z", "2026-10-01T06:00:00Z", channelId: "c1", channelName: "m2-進捗")),
                       "14:00 ゼミ (#m2-進捗)")
        XCTAssertEqual(CalendarDates.alarmText(F.allDay("学会", "2026-10-05")), "終日 学会")
        XCTAssertEqual(CalendarDates.eventsTabLabel(0), "予定")
        XCTAssertEqual(CalendarDates.eventsTabLabel(2), "予定 2")
    }

    func testChannelColoursMatchTheWeb() {
        // The web's channelColor (FNV-1a) for the same ids: every device paints a channel the same.
        XCTAssertEqual(CalendarDates.colorHex("0199a0b0-1111-7000-8000-000000000001"), "#ea580c")
        XCTAssertEqual(CalendarDates.colorHex("0199f000-aaaa-7bbb-8ccc-0123456789ab"), "#a16207")
        XCTAssertEqual(CalendarDates.colorHex("c1"), "#dc2626")
        XCTAssertEqual(CalendarDates.colorHex("c2"), "#db2777")
        XCTAssertEqual(CalendarDates.colorHex(nil), "#64748b")
        XCTAssertGreaterThan(Set((0..<20).map { CalendarDates.colorHex("channel-\($0)") }).count, 4)
    }

    func testFiltersAndChannelTabs() {
        let mine = F.timed("mine", "2026-10-01T05:00:00Z", "2026-10-01T06:00:00Z")
        let lab = F.timed("lab", "2026-10-01T05:00:00Z", "2026-10-01T06:00:00Z", channelId: "c1")
        XCTAssertEqual([mine, lab].filter(CalendarFilter.all.matches).count, 2)
        XCTAssertEqual([mine, lab].filter(CalendarFilter.mine.matches).map(\.title), ["mine"])
        XCTAssertEqual([mine, lab].filter(CalendarFilter.channel("c1").matches).map(\.title), ["lab"])
        let store = Store()
        func state(_ type: String) -> ChannelState {
            store.upsertChannel(ChannelOut(id: type, type: type, name: type, topic: nil, purpose: nil, archived: false, createdBy: nil, lastSeq: 0,
                                           lastMessageAt: nil, createdAt: "", updatedAt: "", membership: nil, dmUserIds: nil), isMember: true)
            return store.channel(type)!
        }
        XCTAssertEqual(ChannelTab.tabs(for: state("public")), [.messages, .canvas, .events, .tasks, .pins, .files]) // M56: タスク
        XCTAssertEqual(ChannelTab.tabs(for: state("private")), [.messages, .canvas, .events, .tasks, .pins, .files])
        XCTAssertEqual(ChannelTab.tabs(for: state("dm")), [.messages, .canvas, .pins, .files]) // no shared calendar in a DM (§9 5.)
        XCTAssertEqual(ChannelTab.tabs(for: state("group_dm")), [.messages, .canvas, .pins, .files])
        XCTAssertEqual(ChannelTab.events.label(upcoming: 3), "予定 3")
    }
}

/// The event form (EventDraft): what stops a save, what goes out, what comes back.
@MainActor
final class CalendarFormTests: XCTestCase {
    override func setUp() { CalendarDates.zoneOverride = TimeZone(identifier: "Asia/Tokyo") }
    override func tearDown() { CalendarDates.zoneOverride = nil }

    private func iso(_ text: String) -> Date { parseIsoDate(text)! }
    private func at(_ day: DayKey, _ hour: Int, _ minute: Int = 0) -> Date { CalendarDates.at(day, hour: hour, minute: minute) }

    private var base: EventDraft {
        var draft = EventDraft.new(on: "2026-10-01", now: iso("2026-09-01T00:00:00Z"))
        draft.title = "ゼミ"
        return draft
    }

    func testANewEventStartsAtTheNextHourTodayElseAtTen() {
        XCTAssertEqual(base.start, at("2026-10-01", 10))
        XCTAssertEqual(base.end, at("2026-10-01", 11))
        let today = EventDraft.new(on: "2026-10-01", channelId: "c1", now: iso("2026-10-01T04:20:00Z")) // 13:20 in Tokyo
        XCTAssertEqual(today.start, at("2026-10-01", 14))
        XCTAssertEqual(today.end, at("2026-10-01", 15))
        XCTAssertEqual(today.channelId, "c1")
        let late = EventDraft.new(on: "2026-10-01", now: iso("2026-10-01T14:30:00Z")) // 23:30
        XCTAssertEqual(late.end, at("2026-10-01", 23, 59))
    }

    func testSaysWhatIsWrongBeforeSending() {
        let base = base
        XCTAssertNil(base.problem)
        var draft = base
        draft.title = "  "
        XCTAssertEqual(draft.problem, "題名を入れてください")
        draft.title = String(repeating: "あ", count: 201)
        XCTAssertEqual(draft.problem, "題名は 200 文字までです")
        draft.title = String(repeating: "あ", count: 200)
        XCTAssertNil(draft.problem)
        draft = base
        draft.location = String(repeating: "x", count: 201)
        XCTAssertEqual(draft.problem, "場所は 200 文字までです")
        draft = base
        draft.description = String(repeating: "x", count: 4001)
        XCTAssertEqual(draft.problem, "説明は 4000 文字までです")
        draft = base
        draft.end = draft.start
        XCTAssertEqual(draft.problem, "終了は開始より後にしてください")
        draft = base
        draft.end = at("2026-10-16", 11)
        XCTAssertEqual(draft.problem, "時刻の予定は 14 日までです")
        draft = base
        draft.allDay = true
        draft.end = at("2026-09-30", 11)
        XCTAssertEqual(draft.problem, "終了日は開始日より後にしてください")
        draft.end = at("2026-11-30", 11)
        XCTAssertEqual(draft.problem, "終日の予定は 60 日までです")
        draft.end = at("2026-11-29", 11)
        XCTAssertNil(draft.problem)
        // An all-day event of one day, its end earlier in that day than its start: fine (only the days count).
        draft.end = at("2026-10-01", 9)
        XCTAssertNil(draft.problem)
    }

    func testSendsATimedEventAsUtcInstantsAndAnAllDayOneAsDates() {
        var timed = base
        timed.start = at("2026-10-01", 14)
        timed.end = at("2026-10-01", 15, 30)
        timed.alarm = 10
        timed.channelId = "c1"
        timed.location = " 5 号館 "
        let body = timed.create(tz: "Asia/Tokyo", clientEventId: "k1")
        XCTAssertEqual(body.channelId, "c1")
        XCTAssertEqual(body.title, "ゼミ")
        XCTAssertEqual(body.timing, CalendarTiming(allDay: false, startsAt: "2026-10-01T05:00:00Z", endsAt: "2026-10-01T06:30:00Z"))
        XCTAssertEqual(body.location, "5 号館")
        XCTAssertNil(body.description)
        XCTAssertEqual(body.json["alarm_minutes"], .number(10))
        XCTAssertEqual(body.json["tz"], .string("Asia/Tokyo"))
        XCTAssertEqual(body.json["client_event_id"], .string("k1"))
        XCTAssertEqual(body.json["starts_at"], .string("2026-10-01T05:00:00Z"))
        XCTAssertEqual(body.json["start_date"], .null)
        XCTAssertEqual(body.json["all_day"], .bool(false))

        var day = base
        day.allDay = true
        day.end = at("2026-10-03", 11)
        day.alarm = -480
        let dayBody = day.create(tz: "Asia/Tokyo", clientEventId: "k2")
        XCTAssertNil(dayBody.channelId)
        XCTAssertEqual(dayBody.json["channel_id"], .null)
        XCTAssertEqual(dayBody.timing, CalendarTiming(allDay: true, startDate: "2026-10-01", endDate: "2026-10-03"))
        XCTAssertEqual(dayBody.json["starts_at"], .null)
        XCTAssertEqual(dayBody.json["alarm_minutes"], .number(-480))

        // PATCH: the whole form with the other pair nulled; no calendar, no alarm.
        var patch = base
        patch.allDay = true
        let json = patch.patch.json
        XCTAssertEqual(json["all_day"], .bool(true))
        XCTAssertEqual(json["start_date"], .string("2026-10-01"))
        XCTAssertEqual(json["end_date"], .string("2026-10-01"))
        XCTAssertEqual(json["starts_at"], .null)
        XCTAssertEqual(json["location"], .null)
        XCTAssertNil(json["channel_id"])
        XCTAssertNil(json["alarm_minutes"])
    }

    func testReadsAnEventBackInLocalTime() {
        let event = CalendarFixtures.timed("ゼミ", "2026-10-01T05:00:00Z", "2026-10-01T06:30:00Z", channelId: "c1", alarm: CalendarFixtures.alarm(30))
        let draft = EventDraft(event: event)
        XCTAssertEqual(draft.startDay, "2026-10-01")
        XCTAssertEqual(CalendarDates.clock(draft.start), "14:00")
        XCTAssertEqual(CalendarDates.clock(draft.end), "15:30")
        XCTAssertEqual(draft.channelId, "c1")
        XCTAssertEqual(draft.alarm, 30)
        XCTAssertFalse(draft.allDay)
        let day = EventDraft(event: CalendarFixtures.allDay("学会", "2026-10-05", "2026-10-07"))
        XCTAssertTrue(day.allDay)
        XCTAssertEqual(day.startDay, "2026-10-05")
        XCTAssertEqual(day.endDay, "2026-10-07")
        XCTAssertNil(day.problem)
        // Turned timed: 10:00 on the first day to 11:00 on the last.
        XCTAssertEqual(day.settingAllDay(false).timing.startsAt, "2026-10-05T01:00:00Z")
        XCTAssertEqual(day.settingAllDay(false).timing.endsAt, "2026-10-07T02:00:00Z")
    }

    func testMovingTheStartCarriesTheEnd() {
        let moved = base.movingStart(to: at("2026-10-02", 13))
        XCTAssertEqual(moved.end, at("2026-10-02", 14))
        var day = base
        day.allDay = true
        day.end = at("2026-10-03", 11)
        let movedDay = day.movingStart(to: at("2026-10-05", 10))
        XCTAssertEqual(movedDay.startDay, "2026-10-05")
        XCTAssertEqual(movedDay.endDay, "2026-10-07")
    }

    func testOffersTheAlarmsOfTheEventsKindAndKeepsTheDayBefore() {
        XCTAssertEqual(CalendarDates.alarmChoices(allDay: false).map(\.value), [nil, 0, 5, 10, 15, 30, 60, 1440])
        XCTAssertEqual(CalendarDates.alarmChoices(allDay: true).map(\.label), ["なし", "前日 8:00", "当日 8:00"])
        XCTAssertEqual(CalendarDates.remapAlarm(30, allDay: true), -480)
        XCTAssertEqual(CalendarDates.remapAlarm(1440, allDay: true), 1440)
        XCTAssertEqual(CalendarDates.remapAlarm(-480, allDay: false), 60)
        XCTAssertNil(CalendarDates.remapAlarm(nil, allDay: true))
        XCTAssertEqual(CalendarDates.alarmLabel(-480, allDay: true), "当日 8:00")
        var draft = base
        draft.alarm = 30
        let allDay = draft.settingAllDay(true)
        XCTAssertTrue(allDay.allDay)
        XCTAssertEqual(allDay.alarm, -480)
        XCTAssertEqual(allDay.settingAllDay(false).alarm, 60)
        // An all-day event cannot end before it starts: a timed one ending on an earlier day ends on its start day.
        var backwards = base
        backwards.end = at("2026-09-30", 9)
        XCTAssertEqual(backwards.settingAllDay(true).endDay, "2026-10-01")
    }
}

/// The calendar on this device (Sync/CalendarHub.swift): the web's tests/calendarHub.test.ts.
@MainActor
final class CalendarHubTests: XCTestCase {
    override func setUp() { CalendarDates.zoneOverride = TimeZone(identifier: "Asia/Tokyo") }
    override func tearDown() { CalendarDates.zoneOverride = nil }

    private typealias F = CalendarFixtures
    private let from = CalendarDates.parseDay("2026-10-01")
    private let to = CalendarDates.parseDay("2026-11-01")

    private func eventually(_ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
        for _ in 0..<200 where !condition() {
            await Task.yield()
            try? await Task.sleep(nanoseconds: 2_000_000)
        }
        XCTAssertTrue(condition(), file: file, line: line)
    }

    private func titles(_ hub: CalendarHub, _ key: String = "view") -> [String] { hub.window(key)?.events.map(\.title) ?? [] }

    func testReadsAWindowAndKeepsTheEventsThatOverlapItCurrent() async {
        CalendarDates.zoneOverride = TimeZone(identifier: "Asia/Tokyo")
        let zemi = F.timed("ゼミ", "2026-10-05T05:00:00Z", "2026-10-05T06:00:00Z", channelId: "c1", channelName: "lab", ownerId: "bob", canEdit: false,
                           alarm: F.alarm(10))
        let api = FakeCalendarApi([zemi])
        let hub = CalendarHub(api: api, me: { "me" })
        await hub.open("view", from: from, to: to)
        XCTAssertEqual(hub.window("view")?.state, .ready)
        XCTAssertEqual(titles(hub), ["ゼミ"])

        // Changed by someone else: my alarm stays, can_edit follows editor_ids.
        var renamed = zemi
        renamed.title = "ゼミ (変更)"
        hub.applyEvent("calendar.event.updated", F.updated(renamed, editors: ["bob", "me"]))
        let changed = hub.window("view")!.events[0]
        XCTAssertEqual(changed.title, "ゼミ (変更)")
        XCTAssertTrue(changed.canEdit)
        XCTAssertEqual(changed.alarm?.minutesBefore, 10)

        // A new one inside the range comes in, in order; one outside is dropped.
        let early = F.allDay("学会", "2026-10-02", "2026-10-03", channelId: "c2")
        hub.applyEvent("calendar.event.updated", F.updated(early, editors: []))
        hub.applyEvent("calendar.event.updated", F.updated(F.allDay("来月", "2026-11-01"), editors: ["me"]))
        XCTAssertEqual(titles(hub), ["学会", "ゼミ (変更)"])
        XCTAssertFalse(hub.window("view")!.events[0].canEdit)

        // Moved out of the range: it leaves. Deleted: gone.
        var moved = renamed
        moved.startsAt = "2026-11-05T05:00:00Z"
        moved.endsAt = "2026-11-05T06:00:00Z"
        hub.applyEvent("calendar.event.updated", F.updated(moved, editors: []))
        XCTAssertEqual(titles(hub), ["学会"])
        hub.applyEvent("calendar.event.deleted", .object(["id": .string(early.id), "channel_id": .string("c2")]))
        XCTAssertEqual(titles(hub), [])
        // The range went out with the device's offset.
        XCTAssertEqual(api.eventsCalls.first.map { CalendarDates.isoLocal($0.from) }, "2026-10-01T00:00:00+09:00")
    }

    func testKeepsAChannelsWindowToThatChannel() async {
        let api = FakeCalendarApi()
        let hub = CalendarHub(api: api, me: { "me" })
        await hub.open("channel:c1", from: from, to: to, channelId: "c1")
        hub.applyEvent("calendar.event.updated", F.updated(F.timed("other", "2026-10-05T05:00:00Z", "2026-10-05T06:00:00Z", channelId: "c2"), editors: []))
        hub.applyEvent("calendar.event.updated", F.updated(F.timed("mine", "2026-10-05T05:00:00Z", "2026-10-05T06:00:00Z"), editors: ["me"]))
        hub.applyEvent("calendar.event.updated", F.updated(F.timed("lab", "2026-10-05T05:00:00Z", "2026-10-05T06:00:00Z", channelId: "c1"), editors: []))
        XCTAssertEqual(titles(hub, "channel:c1"), ["lab"])
        XCTAssertEqual(api.eventsCalls.last?.channelId, "c1")
    }

    func testAppliesMyAlarmAndSaysSoOnceWhenItFires() async {
        let zemi = F.timed("ゼミ", "2026-10-05T05:00:00Z", "2026-10-05T06:00:00Z")
        let api = FakeCalendarApi([zemi])
        let hub = CalendarHub(api: api, me: { "me" })
        var said: [String] = []
        hub.onAlarm = { said.append($0.title) }
        await hub.open("view", from: from, to: to)
        let alarm = F.alarm(10)
        hub.applyEvent("calendar.alarm.updated", F.alarmUpdated(zemi.id, alarm))
        XCTAssertEqual(hub.find(zemi.id)?.alarm, alarm)
        hub.applyEvent("calendar.alarm.updated", F.alarmUpdated(zemi.id, F.alarm(10, status: "fired")))
        hub.applyEvent("calendar.alarm.updated", F.alarmUpdated(zemi.id, F.alarm(10, status: "fired"))) // a replayed event
        await eventually { said == ["ゼミ"] }
        hub.applyEvent("calendar.alarm.updated", F.alarmUpdated(zemi.id, nil))
        XCTAssertNil(hub.find(zemi.id)?.alarm)

        // An alarm of an event outside every window: the event is read to say it.
        let far = F.timed("来月の予定", "2026-11-20T05:00:00Z", "2026-11-20T06:00:00Z", id: "far")
        let api2 = FakeCalendarApi([far])
        let hub2 = CalendarHub(api: api2, me: { "me" })
        var said2: [String] = []
        hub2.onAlarm = { said2.append($0.title) }
        hub2.applyEvent("calendar.alarm.updated", F.alarmUpdated("far", F.alarm(10, status: "fired")))
        await eventually { said2 == ["来月の予定"] }
    }

    func testReadsEverythingAgainAfterReconnectingAndDropsAChannelILeft() async {
        let lab = F.timed("lab", "2026-10-05T05:00:00Z", "2026-10-05T06:00:00Z", channelId: "c1")
        let mine = F.timed("mine", "2026-10-06T05:00:00Z", "2026-10-06T06:00:00Z")
        let api = FakeCalendarApi([lab])
        let hub = CalendarHub(api: api, me: { "me" }, tz: { "Asia/Tokyo" })
        await hub.open("view", from: from, to: to)
        await hub.open("channel:c1", from: from, to: to, channelId: "c1")
        api.upcoming = [lab]
        await hub.loadUpcoming("c1")
        XCTAssertEqual(hub.upcomingOf("c1")?.count, 1)
        XCTAssertEqual(api.upcomingCalls.first?.days, 2)
        XCTAssertEqual(api.upcomingCalls.first?.tz, "Asia/Tokyo")
        // Missed while offline: the next read has it.
        api.rows = [lab, mine]
        hub.online()
        await eventually { self.titles(hub) == ["lab", "mine"] }
        await eventually { api.upcomingCalls.count == 2 }
        hub.removeChannel("c1")
        XCTAssertEqual(titles(hub), ["mine"])
        XCTAssertNil(hub.window("channel:c1"))
        XCTAssertNil(hub.upcomingOf("c1"))
    }

    func testReadsTheTabCountAgainWhenOneOfTheChannelsEventsChanges() async {
        let api = FakeCalendarApi()
        let hub = CalendarHub(api: api, me: { "me" })
        await hub.loadUpcoming("c1")
        let lab = F.timed("lab", "2026-10-05T05:00:00Z", "2026-10-05T06:00:00Z", channelId: "c1")
        api.upcoming = [lab]
        hub.applyEvent("calendar.event.updated", F.updated(lab, editors: []))
        await eventually { hub.upcomingOf("c1")?.count == 1 }
        // Another channel's count, never read, is not asked for; a deletion reads it again too.
        hub.applyEvent("calendar.event.updated", F.updated(F.timed("x", "2026-10-05T05:00:00Z", "2026-10-05T06:00:00Z", channelId: "c9"), editors: []))
        api.upcoming = []
        hub.applyEvent("calendar.event.deleted", .object(["id": .string(lab.id), "channel_id": .string("c1")]))
        await eventually { hub.upcomingOf("c1")?.isEmpty == true }
        XCTAssertTrue(api.upcomingCalls.allSatisfy { $0.channelId == "c1" })
    }

    func testPutsWhatIChangeIntoTheWindowsAtOnce() async throws {
        let zemi = F.timed("ゼミ", "2026-10-05T05:00:00Z", "2026-10-05T06:00:00Z")
        let api = FakeCalendarApi([zemi])
        let hub = CalendarHub(api: api, me: { "me" }, tz: { "Asia/Tokyo" })
        await hub.open("view", from: from, to: to)
        try await hub.setAlarm(zemi.id, minutes: 10)
        XCTAssertEqual(api.alarmCalls.last?.minutes, 10)
        XCTAssertEqual(api.alarmCalls.last?.tz, "Asia/Tokyo")
        XCTAssertEqual(hub.find(zemi.id)?.alarm?.minutesBefore, 10)
        try await hub.setAlarm(zemi.id, minutes: nil)
        XCTAssertNil(api.alarmCalls.last?.minutes)
        XCTAssertNil(hub.find(zemi.id)?.alarm)
        var draft = EventDraft.new(on: "2026-10-07", now: parseIsoDate("2026-09-01T00:00:00Z")!)
        draft.title = "新しい予定"
        _ = try await hub.create(draft.create(tz: "Asia/Tokyo", clientEventId: "k"))
        XCTAssertEqual(titles(hub), ["ゼミ", "新しい予定"])
        var edit = EventDraft(event: zemi)
        edit.title = "ゼミ (延長)"
        _ = try await hub.update(zemi.id, edit.patch)
        XCTAssertEqual(titles(hub), ["ゼミ (延長)", "新しい予定"])
        try await hub.remove(zemi.id)
        XCTAssertEqual(titles(hub), ["新しい予定"])
        XCTAssertEqual(api.deletes, [zemi.id])
        // A notification's event: as held, else read.
        let fetched = try await hub.fetch("new")
        XCTAssertEqual(fetched.title, "新しい予定")
    }

    func testSaysWhenTheServerHasNoCalendarAndWhenAReadFailed() async {
        let api = FakeCalendarApi()
        api.eventsError = ApiError.api(status: 404, code: "not_found", message: "Not Found")
        let hub = CalendarHub(api: api, me: { "me" })
        await hub.open("view", from: from, to: to)
        XCTAssertEqual(hub.window("view")?.state, .unsupported)
        api.eventsError = ApiError.network(URLError(.notConnectedToInternet))
        await hub.reload("view")
        XCTAssertEqual(hub.window("view")?.state, .failed)
        api.eventsError = nil
        await hub.reload("view")
        XCTAssertEqual(hub.window("view")?.state, .ready)
        // A window already read is not read again for the same range; another range is.
        let calls = api.eventsCalls.count
        await hub.open("view", from: from, to: to)
        XCTAssertEqual(api.eventsCalls.count, calls)
        await hub.open("view", from: to, to: CalendarDates.parseDay("2026-12-01"))
        XCTAssertEqual(api.eventsCalls.count, calls + 1)
        hub.close("view")
        XCTAssertNil(hub.window("view"))
    }
}

/// The wire: decoding the answers and the events, the calls' URLs and bodies, and a notification's event.
@MainActor
final class CalendarWireTests: XCTestCase {
    override func setUp() { CalendarDates.zoneOverride = TimeZone(identifier: "Asia/Tokyo") }
    override func tearDown() {
        CalendarDates.zoneOverride = nil
        StubProtocol.handler = nil
    }

    static let eventJson = """
    {"id":"0199a0b0-0000-7000-8000-000000000001","channel_id":"0199a0b0-1111-7000-8000-000000000001","channel_name":"m2-進捗",
     "owner_id":"u1","title":"ゼミ","all_day":false,"starts_at":"2026-10-05T05:00:00Z","ends_at":"2026-10-05T06:00:00Z",
     "start_date":null,"end_date":null,"location":"5 号館 501","description":null,"created_at":"2026-10-01T00:00:00Z",
     "updated_at":"2026-10-01T00:00:00Z","can_edit":true,"alarm":{"minutes_before":10,"fire_at":"2026-10-05T04:50:00Z","status":"pending"}}
    """

    func testDecodesTheServersShapes() throws {
        let event = try JSON.snakeDecoder.decode(CalendarEventOut.self, from: Data(Self.eventJson.utf8))
        XCTAssertEqual(event.title, "ゼミ")
        XCTAssertEqual(event.channelName, "m2-進捗")
        XCTAssertTrue(event.canEdit)
        XCTAssertEqual(event.alarm, CalendarAlarmOut(minutesBefore: 10, fireAt: "2026-10-05T04:50:00Z", status: "pending"))
        XCTAssertEqual(event.location, "5 号館 501")
        XCTAssertNil(event.description)

        // calendar.event.updated: no can_edit, no alarm (they are per person).
        let frame = try JSONDecoder().decode(JSONValue.self, from: Data("""
        {"event":{"id":"e1","channel_id":null,"channel_name":null,"owner_id":"u1","title":"学会","all_day":true,"starts_at":null,
         "ends_at":null,"start_date":"2026-10-05","end_date":"2026-10-07","location":null,"description":"発表","created_at":"",
         "updated_at":""},"editor_ids":["u1"]}
        """.utf8))
        let updated = try frame.decode(CalendarEventUpdated.self)
        XCTAssertEqual(updated.editorIds, ["u1"])
        XCTAssertTrue(updated.event.allDay)
        XCTAssertEqual(updated.event.endDate, "2026-10-07")
        XCTAssertFalse(updated.event.canEdit)
        XCTAssertNil(updated.event.alarm)
        XCTAssertNil(updated.event.channelId)

        let alarm = try CalendarFixtures.alarmUpdated("e1", channelId: "c1", CalendarFixtures.alarm(1440, status: "fired")).decode(CalendarAlarmUpdated.self)
        XCTAssertEqual(alarm.eventId, "e1")
        XCTAssertEqual(alarm.alarm?.status, "fired")
        let removed = try CalendarFixtures.alarmUpdated("e1", nil).decode(CalendarAlarmUpdated.self)
        XCTAssertNil(removed.alarm)
        let deleted = try JSONValue.object(["id": .string("e1"), "channel_id": .null]).decode(CalendarEventDeleted.self)
        XCTAssertNil(deleted.channelId)
    }

    private func makeClient() -> ApiClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        let client = ApiClient(baseUrl: URL(string: "http://server")!, session: URLSession(configuration: configuration))
        client.accessToken = "t"
        return client
    }

    func testTheCallsSendTheRangeWithItsOffsetAndTheBodiesTheServerReads() async throws {
        var requests: [URLRequest] = []
        var bodies: [JSONValue] = []
        StubProtocol.handler = { request in
            requests.append(request)
            if let stream = request.httpBodyStream {
                stream.open()
                var data = Data()
                var buffer = [UInt8](repeating: 0, count: 4096)
                while stream.hasBytesAvailable {
                    let read = stream.read(&buffer, maxLength: buffer.count)
                    if read <= 0 { break }
                    data.append(buffer, count: read)
                }
                stream.close()
                if let body = try? JSONDecoder().decode(JSONValue.self, from: data) { bodies.append(body) }
            }
            if request.httpMethod == "DELETE" { return (204, Data()) }
            if request.url!.path.hasSuffix("/events") && request.httpMethod == "GET" || request.url!.path.hasSuffix("/upcoming") {
                return (200, Data("[\(Self.eventJson)]".utf8))
            }
            return (200, Data(Self.eventJson.utf8))
        }
        let client = makeClient()
        let rows = try await client.calendarEvents(from: CalendarDates.parseDay("2026-10-01"), to: CalendarDates.parseDay("2026-11-01"), channelId: "c1")
        XCTAssertEqual(rows.count, 1)
        let url = try XCTUnwrap(requests.last?.url)
        XCTAssertEqual(url.path, "/api/v1/calendar/events")
        // "+09:00" must not become a space.
        XCTAssertTrue(url.absoluteString.contains("from=2026-10-01T00:00:00%2B09:00"), url.absoluteString)
        XCTAssertTrue(url.absoluteString.contains("to=2026-11-01T00:00:00%2B09:00"), url.absoluteString)
        XCTAssertTrue(url.absoluteString.contains("channel_id=c1"))

        _ = try await client.calendarUpcoming(channelId: "c1", days: 2, tz: "Asia/Tokyo")
        let upcoming = try XCTUnwrap(requests.last?.url?.absoluteString)
        XCTAssertTrue(upcoming.contains("/api/v1/calendar/upcoming?"))
        XCTAssertTrue(upcoming.contains("days=2") && upcoming.contains("tz=Asia/Tokyo") && upcoming.contains("channel_id=c1"), upcoming)

        var draft = EventDraft.new(on: "2026-10-05", now: parseIsoDate("2026-09-01T00:00:00Z")!)
        draft.title = "ゼミ"
        draft.alarm = 10
        _ = try await client.createCalendarEvent(draft.create(tz: "Asia/Tokyo", clientEventId: "k1"))
        XCTAssertEqual(requests.last?.httpMethod, "POST")
        _ = try await client.updateCalendarEvent(id: "e1", draft.patch)
        XCTAssertEqual(requests.last?.httpMethod, "PATCH")
        XCTAssertEqual(requests.last?.url?.path, "/api/v1/calendar/events/e1")
        _ = try await client.setCalendarAlarm(id: "e1", minutesBefore: -480, tz: "Asia/Tokyo")
        XCTAssertEqual(requests.last?.httpMethod, "PUT")
        XCTAssertEqual(requests.last?.url?.path, "/api/v1/calendar/events/e1/alarm")
        try await client.clearCalendarAlarm(id: "e1")
        XCTAssertEqual(requests.last?.httpMethod, "DELETE")
        try await client.deleteCalendarEvent(id: "e1")
        XCTAssertEqual(requests.last?.url?.path, "/api/v1/calendar/events/e1")
        _ = try await client.calendarEvent(id: "e1")
        XCTAssertEqual(requests.last?.httpMethod, "GET")

        // The bodies (URLProtocol sees them as streams).
        XCTAssertEqual(bodies.count, 3)
        if bodies.count == 3 {
            XCTAssertEqual(bodies[0]["client_event_id"], .string("k1"))
            XCTAssertEqual(bodies[0]["starts_at"], .string("2026-10-05T01:00:00Z"))
            XCTAssertEqual(bodies[0]["alarm_minutes"], .number(10))
            XCTAssertEqual(bodies[1]["title"], .string("ゼミ"))
            XCTAssertEqual(bodies[2]["minutes_before"], .number(-480))
            XCTAssertEqual(bodies[2]["tz"], .string("Asia/Tokyo"))
        }
    }

    func testANotificationOpensItsEvent() {
        let payload = PushPayload(userInfo: ["kind": "calendar", "event_id": "e1", "channel_id": "c1", "workspace_id": "w"])
        XCTAssertEqual(payload.eventId, "e1")
        XCTAssertTrue(payload.opensEvent)
        XCTAssertFalse(payload.opensMessage)
        let personal = PushPayload(userInfo: ["kind": "calendar", "event_id": "e2"])
        XCTAssertTrue(personal.opensEvent)
        XCTAssertNil(personal.channelId)
        XCTAssertFalse(PushPayload(userInfo: ["kind": "message", "channel_id": "c1"]).opensEvent)
        // An alarm shows even with its channel open (the conversation says nothing of it).
        let workspace = Workspace(serverUrl: "https://a", username: "a")
        XCTAssertTrue(Workspaces.shouldPresent(payload, target: workspace, active: "https://a", openChannelId: "c1"))
        XCTAssertFalse(Workspaces.shouldPresent(PushPayload(channelId: "c1", kind: "message"), target: workspace, active: "https://a", openChannelId: "c1"))
    }
}

/// The engine routes calendar.* to the hub, reads the tab count when a channel opens, and reads again after reconnecting.
@MainActor
final class CalendarEngineTests: XCTestCase {
    override func setUp() { CalendarDates.zoneOverride = TimeZone(identifier: "Asia/Tokyo") }
    override func tearDown() { CalendarDates.zoneOverride = nil }

    private func settle(_ engine: SyncEngine) async {
        for _ in 0..<50 {
            await engine.idle()
            await Task.yield()
        }
    }

    func testEventsReachTheHubAndAReconnectReadsAgain() async throws {
        let server = FakeServer()
        let alice = server.addUser("alice")
        let bob = server.addUser("bob")
        let lab = server.createChannel("lab", ownerId: alice.id)
        server.join(lab.id, bob.id)
        let zemi = CalendarFixtures.timed("ゼミ", "2026-10-05T05:00:00Z", "2026-10-05T06:00:00Z", channelId: lab.id, channelName: "lab", ownerId: alice.id)
        server.calendarRows = [zemi]
        let store = Store()
        var options = EngineOptions()
        options.sleep = { _ in }
        let engine = SyncEngine(api: server.api(for: bob.id), connect: server.connector(for: bob.id), wsUrl: URL(string: "ws://fake")!, store: store,
                                getAccessToken: { "t" }, options: options)
        var said: [String] = []
        engine.onCalendarAlarm = { said.append(CalendarDates.alarmText($0)) }
        await engine.start()
        await settle(engine)
        let hub = try XCTUnwrap(engine.calendar)
        XCTAssertTrue(hub.available)
        await hub.open("view", from: CalendarDates.parseDay("2026-10-01"), to: CalendarDates.parseDay("2026-11-01"))
        XCTAssertEqual(hub.window("view")?.events.map(\.title), ["ゼミ"])

        // Opening the channel reads its 「予定」 count.
        await engine.openChannel(lab.id)
        await settle(engine)
        XCTAssertEqual(hub.upcomingOf(lab.id)?.count, 1)

        var renamed = zemi
        renamed.title = "ゼミ (教室変更)"
        server.emitEvent([alice.id, bob.id], "calendar.event.updated", channelId: lab.id, data: CalendarFixtures.updated(renamed, editors: [alice.id]))
        server.emitEvent([bob.id], "calendar.alarm.updated", channelId: lab.id, data: CalendarFixtures.alarmUpdated(zemi.id, channelId: lab.id,
                                                                                                                  CalendarFixtures.alarm(10, status: "fired")))
        await settle(engine)
        XCTAssertEqual(hub.window("view")?.events.first?.title, "ゼミ (教室変更)")
        XCTAssertEqual(hub.window("view")?.events.first?.canEdit, false)
        for _ in 0..<20 where said.isEmpty { await settle(engine) }
        XCTAssertEqual(said, ["14:00 ゼミ (教室変更) (#lab)"])

        // Missed while disconnected: the reconnect reads the range again.
        let later = CalendarFixtures.allDay("学会", "2026-10-20", channelId: lab.id, channelName: "lab")
        server.calendarRows = [renamed, later]
        server.disconnect(bob.id)
        for _ in 0..<50 where engine.status != .online || hub.window("view")?.events.count != 2 { await settle(engine) }
        XCTAssertEqual(hub.window("view")?.events.map(\.title), ["ゼミ (教室変更)", "学会"])

        // Leaving the channel drops its events.
        server.removeMember(lab.id, bob.id)
        await settle(engine)
        XCTAssertEqual(hub.window("view")?.events ?? [], [])
        engine.stop()
    }
}

extension FakeServer.Api: CalendarApi {
    func calendarEvents(from: Date, to: Date, channelId: String?) async throws -> [CalendarEventOut] {
        server.calendarRows.filter { (channelId == nil || $0.channelId == channelId) && CalendarDates.overlaps($0, from: from, to: to) }
    }

    func calendarUpcoming(channelId: String?, days: Int, tz: String) async throws -> [CalendarEventOut] {
        server.calendarRows.filter { channelId == nil || $0.channelId == channelId }
    }

    func calendarEvent(id: String) async throws -> CalendarEventOut {
        guard let row = server.calendarRows.first(where: { $0.id == id }) else { throw ApiError.api(status: 404, code: "calendar_event_not_found", message: "") }
        return row
    }

    func createCalendarEvent(_ body: CalendarEventCreate) async throws -> CalendarEventOut { throw ApiError.api(status: 501, code: "unused", message: "") }
    func updateCalendarEvent(id: String, _ patch: CalendarEventPatch) async throws -> CalendarEventOut { throw ApiError.api(status: 501, code: "unused", message: "") }
    func deleteCalendarEvent(id: String) async throws {}
    func setCalendarAlarm(id: String, minutesBefore: Int, tz: String) async throws -> CalendarEventOut { try await calendarEvent(id: id) }
    func clearCalendarAlarm(id: String) async throws {}
}
