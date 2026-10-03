import SwiftUI
import XCTest
@testable import ChikuwaChat

/// M69 (CALENDAR.md §10): a recurring event's occurrence, as the server sends it.
@MainActor
enum RecurringFixtures {
    static func occurrence(_ title: String, _ startsAt: String, _ endsAt: String, series: String, key: String? = nil, id: String? = nil,
                           rrule: String = "FREQ=WEEKLY;BYDAY=TU", channelId: String? = nil, channelName: String? = nil,
                           alarm: CalendarAlarmOut? = nil) -> CalendarEventOut {
        var event = CalendarFixtures.timed(title, startsAt, endsAt, id: id ?? (key == nil ? series : "\(series)@\(startsAt)"), channelId: channelId,
                                           channelName: channelName, alarm: alarm)
        event.seriesId = series
        event.occurrenceStart = key ?? startsAt
        event.recurring = true
        event.rrule = rrule
        event.tz = "Asia/Tokyo"
        return event
    }
}

/// The picker to a rule (normalized as the server stores it), a rule back to the picker and to words: the web's
/// tests/calendarRecurrence.test.ts, case for case.
@MainActor
final class CalendarRecurrenceTests: XCTestCase {
    override func setUp() { CalendarDates.zoneOverride = TimeZone(identifier: "Asia/Tokyo") }
    override func tearDown() { CalendarDates.zoneOverride = nil }

    private typealias R = CalendarRecurrence
    private let tuesday: DayKey = "2026-10-13" // the 2nd Tuesday of October 2026

    private func repeatDraft(_ start: DayKey? = nil, _ change: (inout RepeatDraft) -> Void) -> RepeatDraft {
        var draft = R.noRepeat(start ?? tuesday)
        change(&draft)
        return draft
    }

    private func rule(_ start: DayKey? = nil, _ change: (inout RepeatDraft) -> Void) -> String? {
        R.toRrule(repeatDraft(start, change), start: start ?? tuesday)
    }

    func testMakesThePresets() {
        XCTAssertNil(rule { $0.kind = .none })
        XCTAssertEqual(rule { $0.kind = .daily }, "FREQ=DAILY")
        // 毎週 starts with the start's weekday; the days go Monday first, as the server stores them.
        XCTAssertEqual(rule { $0.kind = .weekly }, "FREQ=WEEKLY;BYDAY=TU")
        XCTAssertEqual(rule { $0.kind = .weekly; $0.weekdays = [4, 0, 2] }, "FREQ=WEEKLY;BYDAY=TU,TH,SU")
        XCTAssertEqual(rule { $0.kind = .monthly }, "FREQ=MONTHLY;BYMONTHDAY=13")
        XCTAssertEqual(rule { $0.kind = .monthly; $0.monthly = .nth }, "FREQ=MONTHLY;BYDAY=2TU")
        XCTAssertEqual(rule("2026-10-30") { $0.kind = .monthly; $0.monthly = .last }, "FREQ=MONTHLY;BYDAY=-1FR")
        XCTAssertEqual(rule("2026-10-31") { $0.kind = .monthly; $0.monthly = .monthEnd }, "FREQ=MONTHLY;BYMONTHDAY=-1")
        XCTAssertEqual(rule { $0.kind = .yearly }, "FREQ=YEARLY")
    }

    func testMakesACustomRuleWithAnIntervalAndAnEnd() {
        XCTAssertEqual(rule { $0.kind = .custom; $0.freq = .weekly; $0.interval = 2; $0.weekdays = [1, 3] }, "FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE")
        XCTAssertEqual(rule { $0.kind = .custom; $0.freq = .daily; $0.interval = 3; $0.end = .count; $0.count = 10 }, "FREQ=DAILY;INTERVAL=3;COUNT=10")
        XCTAssertEqual(rule { $0.kind = .daily; $0.end = .until; $0.until = "2026-12-20" }, "FREQ=DAILY;UNTIL=20261220")
        // A preset has no interval of its own.
        XCTAssertEqual(rule { $0.kind = .daily; $0.interval = 5 }, "FREQ=DAILY")
    }

    func testReadsARuleBackIntoThePicker() {
        let weekly = R.toRepeat("FREQ=WEEKLY;BYDAY=TU,TH;UNTIL=20261220", start: tuesday)
        XCTAssertEqual(weekly.kind, .weekly)
        XCTAssertEqual(weekly.weekdays, [2, 4])
        XCTAssertEqual(weekly.end, .until)
        XCTAssertEqual(weekly.until, "2026-12-20")
        let nth = R.toRepeat("FREQ=MONTHLY;BYDAY=2TU;COUNT=5", start: tuesday)
        XCTAssertEqual([nth.kind, nth.monthly, nth.end, nth.count] as [AnyHashable], [RepeatKind.monthly, MonthlyMode.nth, RepeatEnd.count, 5])
        XCTAssertEqual(R.toRepeat("FREQ=MONTHLY;BYDAY=-1FR", start: "2026-10-30").monthly, .last)
        let monthEnd = R.toRepeat("FREQ=MONTHLY;BYMONTHDAY=-1", start: "2026-10-31")
        XCTAssertEqual([monthEnd.kind, monthEnd.monthly] as [AnyHashable], [RepeatKind.monthly, MonthlyMode.monthEnd])
        let custom = R.toRepeat("FREQ=DAILY;INTERVAL=2", start: tuesday)
        XCTAssertEqual([custom.kind, custom.freq, custom.interval] as [AnyHashable], [RepeatKind.custom, RepeatFreq.daily, 2])
        XCTAssertEqual(R.toRepeat(nil, start: tuesday).kind, .none)
        for rule in ["FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE", "FREQ=MONTHLY;BYDAY=2TU;COUNT=5", "FREQ=YEARLY;UNTIL=20301013"] {
            XCTAssertEqual(R.toRrule(R.toRepeat(rule, start: tuesday), start: tuesday), rule)
        }
        // Not a rule this client understands: しない in the picker, 「繰り返し」 in words.
        XCTAssertNil(R.parse("FREQ=HOURLY"))
        XCTAssertNil(R.parse("FREQ=WEEKLY;BYDAY=12TU"))
        XCTAssertNotNil(R.parse("RRULE:FREQ=WEEKLY;BYDAY=+2TU"))
        XCTAssertEqual(R.describe("FREQ=HOURLY", start: tuesday), "繰り返し")
    }

    func testTellsAChangedRuleFromTheSameOneWrittenDifferently() {
        XCTAssertFalse(R.ruleChanged(R.toRepeat("FREQ=WEEKLY", start: tuesday), start: tuesday, rrule: "FREQ=WEEKLY"))
        XCTAssertFalse(R.ruleChanged(repeatDraft { $0.kind = .weekly }, start: tuesday, rrule: "FREQ=WEEKLY;BYDAY=TU"))
        XCTAssertTrue(R.ruleChanged(repeatDraft { $0.kind = .weekly; $0.weekdays = [2, 4] }, start: tuesday, rrule: "FREQ=WEEKLY;BYDAY=TU"))
        XCTAssertTrue(R.ruleChanged(repeatDraft { $0.kind = .none }, start: tuesday, rrule: "FREQ=DAILY"))
        XCTAssertFalse(R.ruleChanged(repeatDraft { $0.kind = .none }, start: tuesday, rrule: nil))
    }

    func testOffersTheMonthsChoicesForTheDay() {
        XCTAssertTrue(R.nthOfMonth(tuesday) == (2, false))
        XCTAssertEqual(R.monthlyChoices(tuesday).map(\.label), ["毎月 13 日", "毎月 第 2 火曜日"])
        XCTAssertEqual(R.monthlyChoices("2026-10-27").map(\.label), ["毎月 27 日", "毎月 第 4 火曜日", "毎月 最終 火曜日"])
        XCTAssertEqual(R.monthlyChoices("2026-10-31").map(\.label), ["毎月 31 日", "毎月 月末", "毎月 最終 土曜日"])
        // A 5th weekday is only 「最終」.
        XCTAssertEqual(R.monthlyChoices("2026-10-29").map(\.value), [.day, .last])
    }

    func testChecksThePicker() {
        XCTAssertEqual(R.problem(repeatDraft { $0.kind = .weekly; $0.weekdays = [] }, start: tuesday), "曜日を選んでください")
        XCTAssertEqual(R.problem(repeatDraft { $0.kind = .custom; $0.interval = 0 }, start: tuesday), "間隔は 1〜99 にしてください")
        XCTAssertEqual(R.problem(repeatDraft { $0.kind = .daily; $0.end = .until; $0.until = "2026-10-01" }, start: tuesday), "終了日は開始日より後にしてください")
        XCTAssertEqual(R.problem(repeatDraft { $0.kind = .daily; $0.end = .count; $0.count = 1000 }, start: tuesday), "回数は 1〜999 にしてください")
        XCTAssertNil(R.problem(repeatDraft { $0.kind = .daily; $0.end = .count; $0.count = 3 }, start: tuesday))
        var draft = EventDraft.new(on: tuesday)
        draft.title = "x"
        draft.repetition = repeatDraft { $0.kind = .weekly; $0.weekdays = [] }
        XCTAssertEqual(draft.problem, "曜日を選んでください")
    }

    func testARuleInWords() {
        let cases: [(String, String)] = [
            ("FREQ=DAILY", "毎日"),
            ("FREQ=DAILY;INTERVAL=3", "3 日ごと"),
            ("FREQ=WEEKLY;BYDAY=TU,TH", "毎週 火・木曜日"),
            ("FREQ=WEEKLY", "毎週 火曜日"),
            ("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO", "2 週間ごと 月曜日"),
            ("FREQ=MONTHLY;BYMONTHDAY=10", "毎月 10 日"),
            ("FREQ=MONTHLY", "毎月 13 日"),
            ("FREQ=MONTHLY;BYMONTHDAY=-1", "毎月 月末"),
            ("FREQ=MONTHLY;BYDAY=2TU", "毎月 第 2 火曜日"),
            ("FREQ=MONTHLY;BYDAY=-1FR", "毎月 最終 金曜日"),
            ("FREQ=YEARLY", "毎年 10月13日"),
            ("FREQ=WEEKLY;BYDAY=TU;UNTIL=20261220", "毎週 火曜日、2026年12月20日まで"),
            ("FREQ=DAILY;COUNT=10", "毎日、10 回"),
        ]
        for (rule, words) in cases {
            XCTAssertEqual(R.describe(rule, start: tuesday), words, rule)
        }
        XCTAssertEqual(R.describe(nil, start: tuesday), "繰り返さない")
    }

    // MARK: the form with a rule

    func testSendsTheRuleWhenMadeAndOnlyWhatChangedForAnOccurrence() {
        var draft = EventDraft.new(on: tuesday)
        draft.title = "ゼミ"
        draft.repetition = repeatDraft { $0.kind = .weekly; $0.weekdays = [2, 4] }
        let create = draft.create(tz: "Asia/Tokyo", clientEventId: "k")
        XCTAssertEqual(create.rrule, "FREQ=WEEKLY;BYDAY=TU,TH")
        XCTAssertEqual(create.json["rrule"], .string("FREQ=WEEKLY;BYDAY=TU,TH"))
        draft.repetition = R.noRepeat(tuesday)
        // A one-off event leaves the field out (a server before M68 knows nothing of it).
        XCTAssertNil(draft.create(tz: "Asia/Tokyo", clientEventId: "k").json["rrule"])

        let event = RecurringFixtures.occurrence("ゼミ", "2026-10-13T05:00:00Z", "2026-10-13T06:00:00Z", series: "s1")
        let opened = EventDraft(event: event)
        XCTAssertEqual(opened.repetition.kind, .weekly)
        XCTAssertEqual(opened.repetition.weekdays, [2])
        XCTAssertEqual(opened.changes(from: opened), [:])
        var renamed = opened
        renamed.title = "輪講"
        XCTAssertEqual(renamed.changes(from: opened), ["title": .string("輪講")])
        var placed = opened
        placed.location = "501"
        XCTAssertEqual(placed.changes(from: opened), ["location": .string("501")])
        var cleared = placed
        cleared.location = " "
        XCTAssertEqual(cleared.changes(from: placed), ["location": .null])
        let moved = opened.movingStart(to: CalendarDates.at(tuesday, hour: 15))
        XCTAssertEqual(moved.changes(from: opened), [
            "all_day": .bool(false), "starts_at": .string("2026-10-13T06:00:00Z"), "ends_at": .string("2026-10-13T07:00:00Z"),
            "start_date": .null, "end_date": .null,
        ])
    }

    func testBuildsTheScopesRequest() {
        let event = RecurringFixtures.occurrence("ゼミ", "2026-10-20T05:00:00Z", "2026-10-20T06:00:00Z", series: "s1", key: "2026-10-20T05:00:00Z")
        let opened = EventDraft(event: event)
        var draft = opened
        draft.title = "輪講"
        // 「この予定」 sends what changed, never the rule.
        draft.repetition.weekdays = [2, 4]
        let this = CalendarEventForm.occurrenceUpdate(.this, draft: draft, opened: opened, rrule: event.rrule)
        XCTAssertEqual(this.json, .object(["scope": .string("this"), "title": .string("輪講")]))
        let following = CalendarEventForm.occurrenceUpdate(.following, draft: draft, opened: opened, rrule: event.rrule)
        XCTAssertEqual(following.json, .object(["scope": .string("following"), "title": .string("輪講"), "rrule": .string("FREQ=WEEKLY;BYDAY=TU,TH")]))
        // No longer repeating: the rule goes as null.
        draft.repetition.kind = .none
        let all = CalendarEventForm.occurrenceUpdate(.all, draft: draft, opened: opened, rrule: event.rrule)
        XCTAssertEqual(all.changes["rrule"], .null)
        // The same rule written differently is no change.
        let same = CalendarEventForm.occurrenceUpdate(.all, draft: opened, opened: opened, rrule: "FREQ=WEEKLY")
        XCTAssertEqual(same.json, .object(["scope": .string("all")]))

        // The dialog offers 「この予定」 only when the change fits one occurrence.
        XCTAssertEqual(CalendarEventForm.ScopeAsk(action: .save, allowThis: false).scopes, [.following, .all])
        XCTAssertEqual(CalendarEventForm.ScopeAsk(action: .delete, allowThis: true).scopes.map(\.label), ["この予定", "これ以降すべて", "すべての予定"])
        XCTAssertEqual(CalendarEventForm.ScopeAsk(action: .delete, allowThis: true).title, "繰り返しの予定の削除")
    }

    func testMakesAOneOffEventRecurringInTheDevicesZone() {
        var patch = EventDraft.new(on: tuesday).patch
        XCTAssertNil(patch.json["rrule"])
        patch.rrule = "FREQ=DAILY"
        patch.tz = "Asia/Tokyo"
        XCTAssertEqual(patch.json["rrule"], .string("FREQ=DAILY"))
        XCTAssertEqual(patch.json["tz"], .string("Asia/Tokyo"))
    }
}

/// The wire: M68's fields decoded leniently, and the occurrence and feed calls' paths and bodies.
@MainActor
final class CalendarRecurrenceWireTests: XCTestCase {
    override func setUp() { CalendarDates.zoneOverride = TimeZone(identifier: "Asia/Tokyo") }
    override func tearDown() {
        CalendarDates.zoneOverride = nil
        StubProtocol.handler = nil
    }

    static let occurrenceJson = """
    {"id":"0199a0b0-0000-5000-8000-000000000002","channel_id":null,"channel_name":null,"owner_id":"u1","title":"ゼミ","all_day":false,
     "starts_at":"2026-10-20T05:00:00Z","ends_at":"2026-10-20T06:00:00Z","start_date":null,"end_date":null,"location":null,
     "description":null,"created_at":"2026-10-01T00:00:00Z","updated_at":"2026-10-01T00:00:00Z","can_edit":true,
     "alarm":{"minutes_before":10,"fire_at":"2026-10-20T04:50:00Z","status":"pending","occurrence_start":"2026-10-20T05:00:00Z"},
     "series_id":"0199a0b0-0000-7000-8000-000000000001","occurrence_start":"2026-10-20T05:00:00Z","recurring":true,
     "rrule":"FREQ=WEEKLY;BYDAY=TU","tz":"Asia/Tokyo"}
    """

    func testDecodesTheSeriesFieldsAndOlderServersEvents() throws {
        let event = try JSON.snakeDecoder.decode(CalendarEventOut.self, from: Data(Self.occurrenceJson.utf8))
        XCTAssertTrue(event.recurring)
        XCTAssertEqual(event.series, "0199a0b0-0000-7000-8000-000000000001")
        XCTAssertEqual(event.occurrenceKey, "2026-10-20T05:00:00Z")
        XCTAssertEqual(event.rrule, "FREQ=WEEKLY;BYDAY=TU")
        XCTAssertEqual(event.tz, "Asia/Tokyo")
        XCTAssertEqual(event.alarm?.occurrenceStart, "2026-10-20T05:00:00Z")

        // A server before M68: none of them; the event is its own series, keyed by its start.
        let old = try JSON.snakeDecoder.decode(CalendarEventOut.self, from: Data(CalendarWireTests.eventJson.utf8))
        XCTAssertFalse(old.recurring)
        XCTAssertNil(old.rrule)
        XCTAssertEqual(old.series, old.id)
        XCTAssertEqual(old.occurrenceKey, "2026-10-05T05:00:00Z")
        XCTAssertNil(old.alarm?.occurrenceStart)

        // An all-day occurrence's key is its date; a wrong type on a new field does not lose the event.
        let allDay = try JSON.snakeDecoder.decode(CalendarEventOut.self, from: Data("""
        {"id":"e1","channel_id":null,"owner_id":"u1","title":"締切","all_day":true,"start_date":"2026-10-20","end_date":"2026-10-20",
         "created_at":"","updated_at":"","series_id":"s1","occurrence_start":"2026-10-20","recurring":"yes","rrule":"FREQ=MONTHLY"}
        """.utf8))
        XCTAssertEqual(allDay.occurrenceKey, "2026-10-20")
        XCTAssertEqual(allDay.series, "s1")
        XCTAssertFalse(allDay.recurring)
    }

    private func makeClient() -> ApiClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        let client = ApiClient(baseUrl: URL(string: "http://server")!, session: URLSession(configuration: configuration))
        client.accessToken = "t"
        return client
    }

    private static func body(_ request: URLRequest) -> JSONValue? {
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            if read <= 0 { break }
            data.append(buffer, count: read)
        }
        return try? JSONDecoder().decode(JSONValue.self, from: data)
    }

    func testTheOccurrenceAndFeedCalls() async throws {
        var requests: [(request: URLRequest, body: JSONValue?)] = []
        StubProtocol.handler = { request in
            requests.append((request, Self.body(request)))
            if request.httpMethod == "DELETE" { return (204, Data()) }
            if request.url!.path.hasSuffix("/ical-feeds") {
                if request.httpMethod == "POST" {
                    return (201, Data("""
                    {"feed":{"id":"f1","scope":"personal","created_at":"2026-10-02T00:00:00Z","last_used_at":null},
                     "url":"https://chat.example/api/v1/calendar/ical/abc.ics"}
                    """.utf8))
                }
                return (200, Data(#"[{"id":"f1","scope":"all","created_at":"2026-10-02T00:00:00Z","last_used_at":"2026-10-02T03:00:00Z"}]"#.utf8))
            }
            return (200, Data(Self.occurrenceJson.utf8))
        }
        let client = makeClient()
        let body = CalendarOccurrenceUpdate(scope: .following, changes: ["title": .string("輪講")])
        let event = try await client.updateCalendarOccurrence(seriesId: "s1", occurrenceStart: "2026-10-20T05:00:00Z", body)
        XCTAssertTrue(event.recurring)
        XCTAssertEqual(requests.last?.request.httpMethod, "PATCH")
        XCTAssertEqual(requests.last?.request.url?.absoluteString, "http://server/api/v1/calendar/events/s1/occurrences/2026-10-20T05%3A00%3A00Z")
        XCTAssertEqual(requests.last?.body, .object(["scope": .string("following"), "title": .string("輪講")]))

        try await client.deleteCalendarOccurrence(seriesId: "s1", occurrenceStart: "2026-10-20", scope: .this)
        XCTAssertEqual(requests.last?.request.httpMethod, "DELETE")
        XCTAssertEqual(requests.last?.request.url?.absoluteString, "http://server/api/v1/calendar/events/s1/occurrences/2026-10-20?scope=this")

        let feeds = try await client.calendarFeeds()
        XCTAssertEqual(feeds, [CalendarFeedOut(id: "f1", scope: "all", createdAt: "2026-10-02T00:00:00Z", lastUsedAt: "2026-10-02T03:00:00Z")])
        let created = try await client.createCalendarFeed(scope: "personal")
        XCTAssertEqual(created.url, "https://chat.example/api/v1/calendar/ical/abc.ics")
        XCTAssertNil(created.feed.lastUsedAt)
        XCTAssertEqual(requests.last?.body, .object(["scope": .string("personal")]))
        try await client.deleteCalendarFeed(id: "f1")
        XCTAssertEqual(requests.last?.request.url?.path, "/api/v1/calendar/ical-feeds/f1")
        XCTAssertEqual(requests.last?.request.httpMethod, "DELETE")
    }

    func testTheNewErrorsHaveWords() {
        for code in ["calendar_invalid_rrule", "calendar_not_recurring", "calendar_occurrence_not_found", "calendar_feed_limit", "calendar_feed_not_found"] {
            let text = ErrorMessages.text(for: ApiError.api(status: 400, code: code, message: "raw"))
            XCTAssertNotEqual(text, "raw", code)
            XCTAssertFalse(text.isEmpty)
        }
    }
}

/// The hub with series: reads again instead of expanding, drops a series whole, one alarm for every occurrence.
@MainActor
final class CalendarRecurrenceHubTests: XCTestCase {
    override func setUp() { CalendarDates.zoneOverride = TimeZone(identifier: "Asia/Tokyo") }
    override func tearDown() { CalendarDates.zoneOverride = nil }

    private typealias O = RecurringFixtures

    private func eventually(_ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
        for _ in 0..<200 where !condition() { await Task.yield() }
        XCTAssertTrue(condition(), file: file, line: line)
    }

    private func weekly() -> [CalendarEventOut] {
        [
            O.occurrence("ゼミ", "2026-10-06T05:00:00Z", "2026-10-06T06:00:00Z", series: "s1"),
            O.occurrence("ゼミ", "2026-10-13T05:00:00Z", "2026-10-13T06:00:00Z", series: "s1", key: "2026-10-13T05:00:00Z"),
            O.occurrence("ゼミ", "2026-10-20T05:00:00Z", "2026-10-20T06:00:00Z", series: "s1", key: "2026-10-20T05:00:00Z"),
        ]
    }

    private func openHub(_ api: FakeCalendarApi) async -> CalendarHub {
        let hub = CalendarHub(api: api, me: { "me" })
        await hub.open("view", from: CalendarDates.parseDay("2026-10-01"), to: CalendarDates.parseDay("2026-11-01"))
        return hub
    }

    func testASeriesChangeReadsTheWindowsAgain() async throws {
        let api = FakeCalendarApi(weekly())
        let hub = await openHub(api)
        XCTAssertEqual(hub.window("view")?.events.count, 3)
        XCTAssertEqual(api.eventsCalls.count, 1)

        // calendar.event.updated of a series (the parent's content): the server's expansion is read, not patched in.
        var renamed = api.rows
        for index in renamed.indices { renamed[index].title = "輪講" }
        api.rows = renamed
        var parent = renamed[0]
        parent.title = "輪講"
        var frame = CalendarFixtures.updated(parent, editors: ["me"])
        if case .object(var outer) = frame, case .object(var event)? = outer["event"] {
            event["series_id"] = .string("s1")
            event["occurrence_start"] = .string("2026-10-06T05:00:00Z")
            event["recurring"] = .bool(true)
            event["rrule"] = .string("FREQ=WEEKLY;BYDAY=TU")
            outer["event"] = .object(event)
            frame = .object(outer)
        }
        hub.applyEvent("calendar.event.updated", frame)
        await eventually { api.eventsCalls.count == 2 && hub.window("view")?.events.allSatisfy { $0.title == "輪講" } == true }

        // My own change of an occurrence: answered, then read again.
        let result = try await hub.updateOccurrence("s1", occurrenceStart: "2026-10-13T05:00:00Z", CalendarOccurrenceUpdate(scope: .this))
        XCTAssertEqual(result.series, "s1")
        XCTAssertEqual(api.occurrenceUpdates.first?.occurrenceStart, "2026-10-13T05:00:00Z")
        await eventually { api.eventsCalls.count == 3 }

        // A series deleted (calendar.event.deleted with the parent's id): every occurrence leaves.
        for _ in 0..<50 { await Task.yield() }
        XCTAssertEqual(hub.window("view")?.events.count, 3)
        hub.applyEvent("calendar.event.deleted", .object(["id": .string("s1"), "channel_id": .null]))
        XCTAssertEqual(hub.window("view")?.events ?? [], [])
    }

    func testDeletingThisOrTheFollowingOccurrences() async throws {
        let api = FakeCalendarApi(weekly())
        let hub = await openHub(api)
        try await hub.removeOccurrence("s1", occurrenceStart: "2026-10-13T05:00:00Z", scope: .this)
        XCTAssertEqual(hub.window("view")?.events.map(\.occurrenceKey), ["2026-10-06T05:00:00Z", "2026-10-20T05:00:00Z"])
        // The windows are read again to confirm.
        await eventually { api.eventsCalls.count == 2 }
        try await hub.removeOccurrence("s1", occurrenceStart: "2026-10-20T05:00:00Z", scope: .following)
        XCTAssertEqual(hub.window("view")?.events.map(\.occurrenceKey), ["2026-10-06T05:00:00Z"])
        await eventually { api.eventsCalls.count == 3 }
        try await hub.removeOccurrence("s1", occurrenceStart: "2026-10-06T05:00:00Z", scope: .all)
        XCTAssertEqual(hub.window("view")?.events ?? [], [])
        XCTAssertEqual(api.occurrenceDeletes.map(\.scope), [.this, .following, .all])
        for _ in 0..<50 { await Task.yield() }
        XCTAssertEqual(hub.window("view")?.events ?? [], [])
    }

    func testOneAlarmForEveryOccurrenceSaidPerOccurrence() async {
        let api = FakeCalendarApi(weekly())
        let hub = await openHub(api)
        var said: [String] = []
        hub.onAlarm = { event, _ in said.append(event?.occurrenceKey ?? "-") }
        func alarm(_ status: String, _ key: String) -> JSONValue {
            .object(["event_id": .string("s1"), "channel_id": .null, "alarm": .object([
                "minutes_before": .number(10), "fire_at": .string("2026-10-06T04:50:00Z"), "status": .string(status),
                "occurrence_start": .string(key),
            ])])
        }
        hub.applyEvent("calendar.alarm.updated", alarm("pending", "2026-10-06T05:00:00Z"))
        XCTAssertEqual(hub.window("view")?.events.map { $0.alarm?.status }, ["pending", "pending", "pending"])
        hub.applyEvent("calendar.alarm.updated", alarm("fired", "2026-10-13T05:00:00Z"))
        await eventually { said == ["2026-10-13T05:00:00Z"] }
        // The same firing again says nothing; the next occurrence's does.
        hub.applyEvent("calendar.alarm.updated", alarm("fired", "2026-10-13T05:00:00Z"))
        hub.applyEvent("calendar.alarm.updated", alarm("fired", "2026-10-20T05:00:00Z"))
        await eventually { said == ["2026-10-13T05:00:00Z", "2026-10-20T05:00:00Z"] }
        hub.applyEvent("calendar.alarm.updated", .object(["event_id": .string("s1"), "channel_id": .null, "alarm": .null]))
        XCTAssertEqual(hub.window("view")?.events.compactMap(\.alarm).count, 0)
    }

    func testASeriesMadeOneOffReplacesItsOccurrences() async {
        let api = FakeCalendarApi(weekly())
        let hub = await openHub(api)
        var single = CalendarFixtures.timed("ゼミ", "2026-10-06T05:00:00Z", "2026-10-06T06:00:00Z", id: "s1")
        single.seriesId = "s1"
        hub.applyEvent("calendar.event.updated", CalendarFixtures.updated(single, editors: ["me"]))
        XCTAssertEqual(hub.window("view")?.events.map(\.id), ["s1"])
        XCTAssertEqual(hub.window("view")?.events.first?.recurring, false)
    }
}

/// The feeds screen's state: read, made (the URL once), copied, deleted, and the errors in words.
@MainActor
final class CalendarFeedsModelTests: XCTestCase {
    override func setUp() { CalendarDates.zoneOverride = TimeZone(identifier: "Asia/Tokyo") }
    override func tearDown() { CalendarDates.zoneOverride = nil }

    final class FakeFeeds: CalendarFeedApi {
        var feeds: [CalendarFeedOut] = []
        var error: Error?
        private(set) var made: [String] = []

        func calendarFeeds() async throws -> [CalendarFeedOut] {
            if let error { throw error }
            return feeds
        }

        func createCalendarFeed(scope: String) async throws -> CalendarFeedCreated {
            if let error { throw error }
            made.append(scope)
            let feed = CalendarFeedOut(id: "f\(made.count)", scope: scope, createdAt: "2026-10-02T00:00:00Z", lastUsedAt: nil)
            feeds.append(feed)
            return CalendarFeedCreated(feed: feed, url: "https://chat.example/api/v1/calendar/ical/t\(made.count).ics")
        }

        func deleteCalendarFeed(id: String) async throws {
            if let error { throw error }
            feeds.removeAll { $0.id == id }
        }
    }

    func testMakesCopiesListsAndDeletes() async {
        let api = FakeFeeds()
        api.feeds = [CalendarFeedOut(id: "f0", scope: "all", createdAt: "2026-09-30T15:30:00Z", lastUsedAt: "2026-10-01T23:00:00Z")]
        let model = CalendarFeedsModel(api: api)
        XCTAssertNil(model.feeds)
        await model.load()
        XCTAssertEqual(model.feeds?.map(\.id), ["f0"])
        XCTAssertEqual(CalendarFeedsModel.detail(model.feeds![0]), "2026/10/1 に作成 ・ 2026/10/2 に読まれました")

        model.scope = .personal
        await model.create()
        XCTAssertEqual(api.made, ["personal"])
        XCTAssertEqual(model.madeUrl, "https://chat.example/api/v1/calendar/ical/t1.ics")
        XCTAssertEqual(model.feeds?.map(\.id), ["f0", "f1"])
        XCTAssertEqual(CalendarFeedsModel.scopeLabel("personal"), "自分のカレンダーだけ")
        XCTAssertEqual(CalendarFeedsModel.detail(model.feeds![1]), "2026/10/2 に作成 ・ まだ読まれていません")
        XCTAssertEqual(CalendarFeedsModel.webcal(model.madeUrl!)?.absoluteString, "webcal://chat.example/api/v1/calendar/ical/t1.ics")

        let pasteboard = UIPasteboard.withUniqueName()
        model.copy(to: pasteboard)
        XCTAssertTrue(model.copied)
        XCTAssertEqual(pasteboard.string, "https://chat.example/api/v1/calendar/ical/t1.ics")
        UIPasteboard.remove(withName: pasteboard.name)

        await model.remove(model.feeds![0])
        XCTAssertEqual(model.feeds?.map(\.id), ["f1"])
        XCTAssertNil(model.error)
    }

    func testSaysWhatWentWrong() async {
        let api = FakeFeeds()
        api.error = ApiError.api(status: 409, code: "calendar_feed_limit", message: "limit")
        let model = CalendarFeedsModel(api: api)
        await model.create()
        XCTAssertEqual(model.error, "購読 URL は 5 個までです。使っていないものを削除してください")
        XCTAssertNil(model.madeUrl)
        XCTAssertFalse(model.busy)
        XCTAssertFalse(CalendarFeedsModel(api: nil).available)
    }
}

/// M69, light and dark: the form with the repeat picker (a new weekly event, an occurrence of a monthly series), the list
/// with 🔁 rows and the feeds screen. Run with SNAPSHOT_DIR=<dir> to look at them.
@MainActor
final class CalendarRecurrenceSnapshotTests: XCTestCase {
    override func setUp() { CalendarDates.zoneOverride = TimeZone(identifier: "Asia/Tokyo") }
    override func tearDown() {
        CalendarDates.zoneOverride = nil
        UserDefaults.standard.removeObject(forKey: CalendarView.modeKey)
    }

    private func render<V: View>(_ view: V, style: UIUserInterfaceStyle, name: String) throws -> UIImage {
        let size = CGSize(width: 393, height: 852)
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        let window = scene.map { UIWindow(windowScene: $0) } ?? UIWindow(frame: CGRect(origin: .zero, size: size))
        window.frame = CGRect(origin: .zero, size: size)
        window.overrideUserInterfaceStyle = style
        let host = UIHostingController(rootView: view)
        host.view.backgroundColor = .systemBackground
        window.rootViewController = host
        window.makeKeyAndVisible()
        host.view.frame = window.bounds
        host.view.layoutIfNeeded()
        RunLoop.current.run(until: Date().addingTimeInterval(0.8))
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { context in
            if !window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) { window.layer.render(in: context.cgContext) }
        }
        window.isHidden = true
        if let dir = ProcessInfo.processInfo.environment["SNAPSHOT_DIR"], let data = image.pngData() {
            let url = URL(fileURLWithPath: dir).appendingPathComponent(name)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: url)
            print("snapshot written: \(url.path)")
        }
        return image
    }

    private func controller() -> AppController {
        let controller = AppController()
        controller.store.setMe(UserMe(id: "me", username: "kano", displayName: "Kano", role: "member", deactivatedAt: nil, createdAt: "",
                                      updatedAt: "", email: nil, mustChangePassword: false))
        return controller
    }

    func testFormsWithThePicker() throws {
        for style in [UIUserInterfaceStyle.light, .dark] {
            let suffix = style == .dark ? "dark" : "light"
            let controller = controller()
            let api = FakeCalendarApi()
            let hub = CalendarHub(api: api, me: { "me" })
            var draft = EventDraft.new(on: "2026-10-13", now: parseIsoDate("2026-09-01T00:00:00Z")!)
            draft.title = "ゼミ"
            draft.repetition.kind = .weekly
            draft.repetition.weekdays = [2, 4]
            draft.repetition.end = .until
            draft.repetition.until = "2026-12-20"
            let form = try render(CalendarEventForm(controller: controller, hub: hub, target: .new(draft)), style: style,
                                  name: "calendar-repeat-new-\(suffix).png")
            XCTAssertGreaterThan(form.size.width, 0)
            let monthly = RecurringFixtures.occurrence("進捗報告", "2026-10-30T04:00:00Z", "2026-10-30T05:00:00Z", series: "s2",
                                                       key: "2026-10-30T04:00:00Z", rrule: "FREQ=MONTHLY;BYDAY=-1FR;COUNT=12")
            _ = try render(CalendarEventForm(controller: controller, hub: hub, target: .event(monthly)), style: style,
                           name: "calendar-repeat-occurrence-\(suffix).png")
        }
    }

    func testListWithRecurringRowsAndTheFeedsScreen() async throws {
        for style in [UIUserInterfaceStyle.light, .dark] {
            let suffix = style == .dark ? "dark" : "light"
            let controller = controller()
            let api = FakeCalendarApi([
                RecurringFixtures.occurrence("ゼミ", "2026-10-06T05:00:00Z", "2026-10-06T06:00:00Z", series: "s1", rrule: "FREQ=WEEKLY;BYDAY=TU,TH"),
                RecurringFixtures.occurrence("ゼミ", "2026-10-08T05:00:00Z", "2026-10-08T06:00:00Z", series: "s1", key: "2026-10-08T05:00:00Z",
                                             rrule: "FREQ=WEEKLY;BYDAY=TU,TH"),
                CalendarFixtures.timed("歯医者", "2026-10-02T00:30:00Z", "2026-10-02T01:30:00Z"),
            ])
            UserDefaults.standard.set(CalendarView.Mode.list.rawValue, forKey: CalendarView.modeKey)
            _ = try render(NavigationStack { CalendarView(controller: controller, hub: CalendarHub(api: api, me: { "me" }), today: "2026-10-01") },
                           style: style, name: "calendar-repeat-list-\(suffix).png")

            let feeds = CalendarFeedsModelTests.FakeFeeds()
            feeds.feeds = [CalendarFeedOut(id: "f0", scope: "all", createdAt: "2026-09-30T15:30:00Z", lastUsedAt: "2026-10-01T23:00:00Z")]
            let model = CalendarFeedsModel(api: feeds)
            await model.load()
            await model.create()
            _ = try render(CalendarFeedsView(model: model), style: style, name: "calendar-feeds-\(suffix).png")
        }
    }
}

/// Review v0.1.22 #9 (CALENDAR.md §10.11): a fired alarm of one occurrence of a series says that occurrence, never another
/// (the web's tests/calendarHub.test.ts 「an alarm for an occurrence of a series」, case for case).
@MainActor
final class CalendarAlarmOccurrenceTests: XCTestCase {
    override func setUp() { CalendarDates.zoneOverride = TimeZone(identifier: "Asia/Tokyo") }
    override func tearDown() { CalendarDates.zoneOverride = nil }

    private typealias O = RecurringFixtures

    // Daily at 9:00 JST from Oct 1 in #lab; the occurrence of Oct 20 alone renamed and moved to 11:00.
    private func series(_ key: String, title: String = "朝会", startsAt: String? = nil, endsAt: String? = nil) -> CalendarEventOut {
        O.occurrence(title, startsAt ?? key, endsAt ?? key.replacingOccurrences(of: ":00:00Z", with: ":15:00Z"), series: "s1", key: key,
                     id: key == "2026-10-01T00:00:00Z" ? "s1" : "s1:\(key)", rrule: "FREQ=DAILY", channelId: "c1", channelName: "lab")
    }

    private var first: CalendarEventOut { series("2026-10-01T00:00:00Z") }
    private var changed: CalendarEventOut {
        series("2026-10-20T00:00:00Z", title: "臨時の朝会", startsAt: "2026-10-20T02:00:00Z", endsAt: "2026-10-20T02:30:00Z")
    }
    private let fired = CalendarAlarmOut(minutesBefore: 10, fireAt: "2026-10-20T01:50:00Z", status: "fired", occurrenceStart: "2026-10-20T00:00:00Z")

    /// The occurrence as the event carries it (calendar.event.updated's shape: no can_edit, no alarm).
    private func wire(_ event: CalendarEventOut) -> JSONValue {
        guard case .object(var fields) = CalendarFixtures.shared(event) else { return .null }
        fields["series_id"] = .string(event.series)
        fields["occurrence_start"] = .string(event.occurrenceKey)
        fields["recurring"] = .bool(event.recurring)
        fields["rrule"] = event.rrule.map(JSONValue.string) ?? .null
        fields["tz"] = event.tz.map(JSONValue.string) ?? .null
        return .object(fields)
    }

    private func fire(_ hub: CalendarHub, _ seriesId: String = "s1", channelId: String? = "c1", alarm: CalendarAlarmOut? = nil,
                      occurrence: CalendarEventOut? = nil) {
        let alarm = alarm ?? fired
        var fields: [String: JSONValue] = [
            "event_id": .string(seriesId), "channel_id": channelId.map(JSONValue.string) ?? .null,
            "alarm": .object(["minutes_before": .number(Double(alarm.minutesBefore)), "fire_at": .string(alarm.fireAt),
                              "status": .string(alarm.status), "occurrence_start": alarm.occurrenceStart.map(JSONValue.string) ?? .null]),
        ]
        if let occurrence { fields["occurrence"] = wire(occurrence) }
        hub.applyEvent("calendar.alarm.updated", .object(fields))
    }

    private final class Said {
        var calls: [(event: CalendarEventOut?, channelId: String?)] = []
    }

    private func setup(_ rows: [CalendarEventOut]) -> (FakeCalendarApi, CalendarHub, Said) {
        let api = FakeCalendarApi(rows)
        // GET /calendar/events/{series_id}: the series' first occurrence, as the server answers.
        api.eventAnswers["s1"] = first
        let hub = CalendarHub(api: api, me: { "me" })
        let said = Said()
        hub.onAlarm = { event, channelId in said.calls.append((event, channelId)) }
        return (api, hub, said)
    }

    private func eventually(_ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
        for _ in 0..<200 where !condition() { await Task.yield() }
        XCTAssertTrue(condition(), file: file, line: line)
    }

    private func openOctober(_ hub: CalendarHub) async {
        await hub.open("view", from: CalendarDates.parseDay("2026-10-01"), to: CalendarDates.parseDay("2026-11-01"))
    }

    private func openNovember(_ hub: CalendarHub) async {
        await hub.open("view", from: CalendarDates.parseDay("2026-11-01"), to: CalendarDates.parseDay("2026-12-01"))
    }

    func testTheEventsOccurrenceDecodesAndIsAbsentFromAnOlderServer() throws {
        let with = JSONValue.object(["event_id": .string("s1"), "channel_id": .string("c1"), "alarm": .null, "occurrence": wire(changed)])
        let decoded = try with.decode(CalendarAlarmUpdated.self)
        XCTAssertEqual(decoded.occurrence?.title, "臨時の朝会")
        XCTAssertEqual(decoded.occurrence?.occurrenceStart, "2026-10-20T00:00:00Z")
        XCTAssertEqual(decoded.occurrence?.series, "s1")
        XCTAssertNil(try CalendarFixtures.alarmUpdated("s1", nil).decode(CalendarAlarmUpdated.self).occurrence)
        let null = JSONValue.object(["event_id": .string("s1"), "channel_id": .null, "alarm": .null, "occurrence": .null])
        XCTAssertNil(try null.decode(CalendarAlarmUpdated.self).occurrence)
    }

    func testTheCalendarNeverOpenedSaysTheOccurrenceInTheEvent() async {
        let (api, hub, said) = setup([])
        fire(hub, occurrence: changed)
        await eventually { said.calls.count == 1 }
        let event = said.calls.first?.event
        XCTAssertEqual(event?.title, "臨時の朝会")
        XCTAssertEqual(event?.startsAt, "2026-10-20T02:00:00Z")
        XCTAssertEqual(event?.occurrenceStart, "2026-10-20T00:00:00Z")
        XCTAssertEqual(event?.alarm, fired)
        XCTAssertEqual(said.calls.first?.channelId, "c1")
        XCTAssertEqual(CalendarDates.alarmText(event), "11:00 臨時の朝会 (#lab)")
        XCTAssertEqual(api.eventCalls, [])
    }

    func testAnotherMonthLoadedSaysTheEventsOccurrenceNotALoadedOne() async {
        let (api, hub, said) = setup([])
        api.rows = [series("2026-11-02T00:00:00Z"), series("2026-11-03T00:00:00Z")]
        await openNovember(hub)
        fire(hub, occurrence: changed)
        await eventually { said.calls.count == 1 }
        XCTAssertEqual(said.calls.first?.event?.title, "臨時の朝会")
        XCTAssertEqual(said.calls.first?.event?.startsAt, "2026-10-20T02:00:00Z")
        // The alarm went onto the loaded occurrences of the series too.
        XCTAssertEqual(hub.window("view")?.events.map { $0.alarm?.status }, ["fired", "fired"])
    }

    func testTheServersOccurrenceWinsOverAStaleCopyHeldHere() async {
        let (_, hub, said) = setup([series("2026-10-20T00:00:00Z")]) // read before the change
        await openOctober(hub)
        fire(hub, occurrence: changed)
        await eventually { said.calls.count == 1 }
        XCTAssertEqual(said.calls.first?.event?.title, "臨時の朝会")
        XCTAssertEqual(said.calls.first?.event?.startsAt, "2026-10-20T02:00:00Z")
        XCTAssertEqual(said.calls.first?.event?.canEdit, true) // the copy held here says I may edit it
    }

    func testAnAllDayOccurrenceMovedToAnotherDay() async {
        let (_, hub, said) = setup([])
        var day = CalendarFixtures.allDay("代理", "2026-10-21", "2026-10-21", id: "d1:2026-10-20")
        day.seriesId = "d1"
        day.occurrenceStart = "2026-10-20"
        day.recurring = true
        day.rrule = "FREQ=WEEKLY"
        day.tz = "Asia/Tokyo"
        let alarm = CalendarAlarmOut(minutesBefore: -480, fireAt: "2026-10-20T23:00:00Z", status: "fired", occurrenceStart: "2026-10-20")
        fire(hub, "d1", channelId: nil, alarm: alarm, occurrence: day)
        await eventually { said.calls.count == 1 }
        let event = said.calls.first?.event
        XCTAssertEqual(event?.title, "代理")
        XCTAssertEqual(event?.startDate, "2026-10-21")
        XCTAssertEqual(event?.allDay, true)
        XCTAssertEqual(CalendarDates.alarmText(event), "終日 代理")
    }

    // MARK: from a server before it (no occurrence in the event)

    func testOlderServerNeverOpenedSaysANeutralLineNotTheFirstOccurrence() async {
        let (api, hub, said) = setup([])
        fire(hub)
        await eventually { said.calls.count == 1 }
        XCTAssertEqual(api.eventCalls, ["s1"])
        XCTAssertNil(said.calls.first?.event)
        XCTAssertEqual(said.calls.first?.channelId, "c1")
        XCTAssertEqual(CalendarDates.alarmText(said.calls.first?.event, channelName: "lab"), "予定の通知があります (#lab)")
        XCTAssertEqual(CalendarDates.alarmText(nil), "予定の通知があります") // my own calendar: no channel
    }

    func testOlderServerAnotherMonthLoadedLetsNoneOfItsOccurrencesStandIn() async {
        let (api, hub, said) = setup([])
        api.rows = [series("2026-11-02T00:00:00Z")]
        await openNovember(hub)
        fire(hub)
        await eventually { said.calls.count == 1 }
        XCTAssertNil(said.calls.first?.event)
    }

    func testOlderServerSaysTheOccurrenceHeldHere() async {
        let (api, hub, said) = setup([first, changed])
        await openOctober(hub)
        fire(hub)
        await eventually { said.calls.count == 1 }
        XCTAssertEqual(said.calls.first?.event?.title, "臨時の朝会")
        XCTAssertEqual(said.calls.first?.event?.startsAt, "2026-10-20T02:00:00Z")
        XCTAssertEqual(api.eventCalls, [])
    }

    func testOlderServerTheFirstOccurrenceItselfUsesTheSeriesRead() async {
        let (_, hub, said) = setup([])
        fire(hub, alarm: CalendarAlarmOut(minutesBefore: 10, fireAt: "2026-09-30T23:50:00Z", status: "fired", occurrenceStart: "2026-10-01T00:00:00Z"))
        await eventually { said.calls.count == 1 }
        XCTAssertEqual(said.calls.first?.event?.title, "朝会")
        XCTAssertEqual(said.calls.first?.event?.occurrenceStart, "2026-10-01T00:00:00Z")
        XCTAssertEqual(CalendarDates.alarmText(said.calls.first?.event), "9:00 朝会 (#lab)")
    }
}
