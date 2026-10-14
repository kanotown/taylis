import SwiftUI
import WidgetKit
import XCTest
@testable import ChikuwaChat

/// The 未読・メンション and 今日の予定・締切 widgets (Widgets/, ChikuwaChat/Widget): their snapshots, the app's rules they
/// restate (the badge rule of apps/shared/unread-rules.json, CalendarDates' order, TaskRules' overdue), the timeline's
/// moments, the links into the app and the calls the extension makes (a stub URLProtocol, no server), and their faces
/// (TEST_RUNNER_SNAPSHOT_DIR=<dir> writes them as PNGs).
@MainActor
final class InfoWidgetsTests: XCTestCase {
    private let workspace = Workspace(serverUrl: "https://lab.example.jp", name: "加納研", username: "kano")

    private func file<S: WidgetAccountSnapshot>(_ type: S.Type) -> WidgetSnapshotFile<S> {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("InfoWidgetsTests-\(UUID().uuidString)/w.json")
        addTeardownBlock { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        return WidgetSnapshotFile<S>(url: url)
    }

    private func stubApi(_ serverUrl: String, _ account: String) -> ShareApi? {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [WidgetStubProtocol.self]
        let api = ShareApi(baseUrl: URL(string: serverUrl)!, account: account, language: "ja", session: URLSession(configuration: configuration))
        api.refreshRetryDelays = []
        api.lockProvider = { nil }
        return api
    }

    private func signedInAccount() -> String {
        let account = "https://widget.test|kano-\(UUID().uuidString)"
        SharedTokens.store(account: account, accessToken: "access", expiresIn: 3600, refreshToken: "refresh")
        addTeardownBlock { Keychain.delete(account: account) }
        return account
    }

    // MARK: 未読・メンション

    private func conversation(_ id: String, type: String = "public", name: String? = nil, unread: Int = 0, mentions: Int = 0,
                              member: Bool = true, archived: Bool = false, dm: [String]? = nil, last: (String, String)? = nil,
                              level: String? = nil, muted: Bool = false, times: String? = nil) -> ChannelState {
        var out = ChannelOut(id: id, type: type, name: name ?? (dm == nil ? id : nil), topic: nil, purpose: nil, archived: archived, createdBy: nil,
                             lastSeq: 10, lastMessageAt: last?.1, createdAt: "", updatedAt: "",
                             membership: member ? MembershipOut(role: "member", joinedAt: "") : nil, dmUserIds: dm)
        out.timesOwnerId = times
        if level != nil || muted {
            out.notification = NotificationPreferenceOut(channelId: id, level: level ?? "mentions", mutedUntil: nil, followsDefault: level == nil, muted: muted)
        }
        if let last {
            out.lastMessage = LastMessageOut(id: "m-\(id)", senderId: last.0, type: "user", seq: 10, excerpt: "本文は使わない", hasAttachments: false,
                                             createdAt: last.1)
        }
        return ChannelState(channel: out, isMember: member, syncedSeq: nil, lastSeq: 10, unreadCount: unread, mentionCount: mentions, hasOlder: false)
    }

    private func user(_ id: String, _ name: String) -> UserPublic {
        UserPublic(id: id, username: id, displayName: name, role: "member", deactivatedAt: nil, createdAt: "", updatedAt: "")
    }

    private func unreadSnapshot(_ channels: [ChannelState], others: Int = 0, stamp: Date = Date(timeIntervalSince1970: 1_800_000_000)) -> UnreadWidgetSnapshot {
        let users = ["me": user("me", "加納"), "u2": user("u2", "花子"), "u3": user("u3", "次郎")]
        return AppController.unreadWidgetSnapshot(channels: channels, users: users, workspace: workspace, meId: "me", others: others,
                                                  title: { $0.channel.isDm ? "DM \($0.id)" : "#\($0.channel.name ?? "")" }, stamp: stamp)
    }

    /// One case of apps/shared/unread-rules.json (as ChannelRulesTests reads it).
    private struct UnreadCase: Decodable {
        struct Expect: Decodable { let badge: Int }
        let name: String
        let type: String
        let times: String?
        let level: String?
        let muted: Bool
        let unread: Int
        let mentions: Int
        let expect: Expect
    }

    func testUnreadCountsEachConversationByTheSharedBadgeRule() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("shared/unread-rules.json")
        struct Vectors: Decodable { let cases: [UnreadCase] }
        let cases = try JSON.snakeDecoder.decode(Vectors.self, from: Data(contentsOf: url)).cases
        let channels = cases.enumerated().map { index, c in
            conversation("c\(index)", type: c.type, unread: c.unread, mentions: c.mentions,
                         dm: c.type == "dm" ? ["me", "u2"] : nil, last: ("u2", String(format: "2026-10-14T0%d:00:00Z", index % 10)),
                         level: c.level, muted: c.muted, times: c.times == "mine" ? "me" : c.times == "others" ? "u3" : nil)
        }
        let s = unreadSnapshot(channels)
        XCTAssertEqual(s.total, cases.reduce(0) { $0 + $1.expect.badge }, "the app icon's and GET /sync/summary's number")
        XCTAssertEqual(Set(s.rows.map(\.id)), Set(cases.enumerated().filter { $0.element.expect.badge > 0 }.map { "c\($0.offset)" }))
        for row in s.rows {
            let index = Int(row.id.dropFirst())!
            XCTAssertEqual(row.count, cases[index].expect.badge, cases[index].name)
        }
        XCTAssertTrue(UnreadWidgetRules.rowsCurrent(s))
    }

    func testUnreadRowsLeaveOutOthersAndAreNewestFirstWithoutMessageText() throws {
        let s = unreadSnapshot([
            conversation("dm", type: "dm", unread: 3, dm: ["me", "u2"], last: ("u2", "2026-10-14T03:00:00Z")),
            conversation("group", type: "group_dm", unread: 2, dm: ["me", "u2", "u3"], last: ("u3", "2026-10-14T05:00:00Z")),
            conversation("seminar", unread: 9, mentions: 1, last: ("u2", "2026-10-14T04:00:00Z")),
            conversation("mine", unread: 1, mentions: 1, last: ("me", "2026-10-14T01:00:00Z")),
            conversation("quietOnly", unread: 9),
            conversation("archived", mentions: 2, archived: true),
            conversation("left", mentions: 2, member: false),
        ])
        XCTAssertEqual(s.rows.map(\.id), ["group", "seminar", "dm", "mine"])
        XCTAssertEqual(s.rows.map(\.count), [2, 1, 3, 1])
        XCTAssertEqual(s.total, 7)
        XCTAssertEqual(UnreadWidgetRules.mentions(s), 2)
        XCTAssertEqual(s.rows[0].lastSender, "次郎", "a group DM says who wrote last")
        XCTAssertNil(s.rows[2].lastSender, "a 1:1 DM's name is the sender already")
        XCTAssertNil(s.rows[3].lastSender, "not my own name")
        XCTAssertEqual(s.rows[1].name, "#seminar")
        XCTAssertTrue(s.rows[2].isDm)
        let encoded = try JSONEncoder().encode(s)
        XCTAssertFalse(String(decoding: encoded, as: UTF8.self).contains("本文は使わない"), "no message text in the App Group")
        XCTAssertEqual(try JSONDecoder().decode(UnreadWidgetSnapshot.self, from: encoded), s)
    }

    func testUnreadServerCountReplacesTheAppsAndZeroClearsTheRows() {
        let s = unreadSnapshot([conversation("dm", type: "dm", unread: 3, dm: ["me", "u2"]), conversation("c", mentions: 1)])
        let now = Date(timeIntervalSince1970: 1_800_001_000)
        let more = UnreadWidgetRules.applying(summaryBadge: 6, to: s, now: now)
        XCTAssertEqual(more.total, 6)
        XCTAssertEqual(more.rows, s.rows, "the app's rows stay")
        XCTAssertFalse(UnreadWidgetRules.rowsCurrent(more))
        XCTAssertEqual(more.updatedAt, now)
        XCTAssertEqual(more.rowsAt, s.rowsAt)
        let read = UnreadWidgetRules.applying(summaryBadge: 0, to: s, now: now)
        XCTAssertEqual(read.total, 0)
        XCTAssertEqual(read.rows, [], "read elsewhere")
        XCTAssertTrue(UnreadWidgetRules.rowsCurrent(read))
        XCTAssertEqual(UnreadWidgetRules.failed(s, .temporary("x")).problem, .offline)
        XCTAssertEqual(UnreadWidgetRules.failed(s, .notSignedIn).problem, .signedOut)
        XCTAssertNil(UnreadWidgetRules.applying(summaryBadge: 1, to: UnreadWidgetRules.failed(s, .temporary("x"))).problem)
        XCTAssertFalse(s.needsRefresh(now: s.updatedAt.addingTimeInterval(60)))
        XCTAssertTrue(s.needsRefresh(now: s.updatedAt.addingTimeInterval(15 * 60)))
        XCTAssertTrue(UnreadWidgetRules.failed(s, .temporary("x")).needsRefresh(now: s.updatedAt))

        // The app icon also counts followed threads' mentions and fired reminders (Store.badgeCount), which the
        // server's summary does not: they are kept on top of its count.
        let withThreads = unreadSnapshot([conversation("c", mentions: 1)], others: 2)
        XCTAssertEqual(withThreads.total, 3)
        XCTAssertTrue(UnreadWidgetRules.rowsCurrent(withThreads))
        XCTAssertEqual(UnreadWidgetRules.applying(summaryBadge: 1, to: withThreads).total, 3)
        XCTAssertTrue(UnreadWidgetRules.rowsCurrent(UnreadWidgetRules.applying(summaryBadge: 1, to: withThreads)))
        XCTAssertEqual(UnreadWidgetRules.applying(summaryBadge: 0, to: withThreads).total, 2)
    }

    func testSnapshotFileKeepsAccountsSaysWhatChangedAndForgets() {
        let store = file(UnreadWidgetSnapshot.self)
        XCTAssertNil(store.current())
        var a = unreadSnapshot([conversation("c", mentions: 1)])
        XCTAssertTrue(store.save(a, active: true))
        a.updatedAt = a.updatedAt.addingTimeInterval(60)
        XCTAssertFalse(store.save(a, active: true), "only the time")
        var b = a
        b.account = "https://other.example.jp|kano"
        b.updatedAt = a.updatedAt.addingTimeInterval(60)
        XCTAssertTrue(store.save(b))
        XCTAssertEqual(store.current()?.account, a.account, "the workspace on screen, not the newest")
        XCTAssertTrue(store.remove(account: a.account))
        XCTAssertEqual(store.current()?.account, b.account, "else the newest")
        XCTAssertFalse(store.remove(account: a.account))
    }

    func testUnreadRefreshAsksTheSummary() async throws {
        let store = file(UnreadWidgetSnapshot.self)
        let account = signedInAccount()
        var s = unreadSnapshot([conversation("c", mentions: 2)])
        s.serverUrl = "https://widget.test"
        s.account = account
        store.save(s, active: true)
        WidgetStubProtocol.reset { _ in (200, #"{"badge": 0, "has_unread": true}"#) }
        let read = await UnreadWidgetActions.refresh(account: account, file: store, makeApi: stubApi)
        XCTAssertEqual(read?.total, 0)
        XCTAssertEqual(read?.rows, [])
        XCTAssertEqual(WidgetStubProtocol.requests.first?.url?.path, "/api/v1/sync/summary")
        XCTAssertEqual(WidgetStubProtocol.requests.first?.value(forHTTPHeaderField: "Authorization"), "Bearer access")
        WidgetStubProtocol.reset { _ in nil }
        let offline = await UnreadWidgetActions.refresh(account: account, file: store, makeApi: stubApi)
        XCTAssertEqual(offline?.problem, .offline)
        XCTAssertEqual(store.snapshot(account: account)?.problem, .offline)
    }

    // MARK: 今日の予定・締切

    private let tokyo: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Tokyo")!
        return calendar
    }()

    /// 2026-10-14 10:00 in Tokyo.
    private let now = Date(timeIntervalSince1970: 1_791_939_600)

    private let eventsJson = """
    [
      {"id": "e-late", "title": "輪講", "all_day": false, "starts_at": "2026-10-14T07:30:00Z", "ends_at": "2026-10-14T08:30:00Z", "start_date": null, "end_date": null, "channel_id": "c2", "channel_name": "reading", "owner_id": "me", "created_at": "", "updated_at": ""},
      {"id": "e-early", "title": "朝会", "all_day": false, "starts_at": "2026-10-13T23:30:00Z", "ends_at": "2026-10-14T00:00:00Z", "start_date": null, "end_date": null, "channel_id": "c1", "channel_name": "lab", "owner_id": "me", "created_at": "", "updated_at": ""},
      {"id": "e-allday", "title": "学会", "all_day": true, "starts_at": null, "ends_at": null, "start_date": "2026-10-13", "end_date": "2026-10-15", "channel_id": null, "channel_name": null, "owner_id": "me", "created_at": "", "updated_at": ""},
      {"id": "e-overnight", "title": "観測", "all_day": false, "starts_at": "2026-10-13T12:00:00Z", "ends_at": "2026-10-14T03:00:00Z", "start_date": null, "end_date": null, "channel_id": "c1", "channel_name": "lab", "owner_id": "me", "created_at": "", "updated_at": ""},
      {"id": "e-noon", "title": "ゼミ", "all_day": false, "starts_at": "2026-10-14T04:00:00Z", "ends_at": "2026-10-14T06:00:00Z", "start_date": null, "end_date": null, "channel_id": "c1", "channel_name": "lab", "owner_id": "me", "created_at": "", "updated_at": ""},
      {"id": "e-tomorrow", "title": "面談", "all_day": false, "starts_at": "2026-10-15T01:00:00Z", "ends_at": "2026-10-15T01:30:00Z", "start_date": null, "end_date": null, "channel_id": null, "channel_name": null, "owner_id": "me", "created_at": "", "updated_at": ""}
    ]
    """

    private let tasksJson = """
    [
      {"id": "t-today", "title": "発表資料", "status": "todo", "channel_id": "c1", "channel_name": "lab", "due_on": "2026-10-14", "due_at": null, "assignee_ids": ["me"], "owner_id": "u2", "position": 1, "created_at": "", "updated_at": "", "can_delete": false, "notes": null, "source": null, "completed_at": null, "completed_by": null},
      {"id": "t-old", "title": "報告書", "status": "doing", "channel_id": null, "channel_name": null, "due_on": "2026-10-10", "due_at": null, "assignee_ids": [], "owner_id": "me", "position": 2, "created_at": "", "updated_at": "", "can_delete": true, "notes": null, "source": null, "completed_at": null, "completed_by": null},
      {"id": "t-passed", "title": "提出", "status": "todo", "channel_id": null, "channel_name": null, "due_on": "2026-10-14", "due_at": "2026-10-14T00:00:00Z", "assignee_ids": [], "owner_id": "me", "position": 3, "created_at": "", "updated_at": "", "can_delete": true, "notes": null, "source": null, "completed_at": null, "completed_by": null},
      {"id": "t-at5", "title": "申請", "status": "todo", "channel_id": null, "channel_name": null, "due_on": "2026-10-14", "due_at": "2026-10-14T08:00:00Z", "assignee_ids": [], "owner_id": "me", "position": 4, "created_at": "", "updated_at": "", "can_delete": true, "notes": null, "source": null, "completed_at": null, "completed_by": null},
      {"id": "t-tomorrow", "title": "予約", "status": "todo", "channel_id": null, "channel_name": null, "due_on": "2026-10-15", "due_at": null, "assignee_ids": [], "owner_id": "me", "position": 5, "created_at": "", "updated_at": "", "can_delete": true, "notes": null, "source": null, "completed_at": null, "completed_by": null},
      {"id": "t-later", "title": "論文", "status": "todo", "channel_id": null, "channel_name": null, "due_on": "2026-10-20", "due_at": null, "assignee_ids": [], "owner_id": "me", "position": 6, "created_at": "", "updated_at": "", "can_delete": true, "notes": null, "source": null, "completed_at": null, "completed_by": null},
      {"id": "t-done", "title": "済んだ", "status": "done", "channel_id": null, "channel_name": null, "due_on": "2026-10-13", "due_at": null, "assignee_ids": [], "owner_id": "me", "position": 7, "created_at": "", "updated_at": "", "can_delete": true, "notes": null, "source": null, "completed_at": "2026-10-13T00:00:00Z", "completed_by": "me"},
      {"id": "t-others", "title": "他の人の", "status": "todo", "channel_id": "c1", "channel_name": "lab", "due_on": "2026-10-14", "due_at": null, "assignee_ids": ["u2"], "owner_id": "me", "position": 8, "created_at": "", "updated_at": "", "can_delete": true, "notes": null, "source": null, "completed_at": null, "completed_by": null},
      {"id": "t-none", "title": "期限なし", "status": "todo", "channel_id": null, "channel_name": null, "due_on": null, "due_at": null, "assignee_ids": [], "owner_id": "me", "position": 9, "created_at": "", "updated_at": "", "can_delete": true, "notes": null, "source": null, "completed_at": null, "completed_by": null}
    ]
    """

    private func todaySnapshot() throws -> TodayWidgetSnapshot {
        let events = try JSON.snakeDecoder.decode([TodayWidgetRules.ServerEvent].self, from: Data(eventsJson.utf8))
        let tasks = try JSON.snakeDecoder.decode([TodayWidgetRules.ServerTask].self, from: Data(tasksJson.utf8))
        let empty = AppController.todayWidgetSnapshot(stored: nil, workspace: workspace, meId: "me", now: now)
        return TodayWidgetRules.applying(events: events, tasks: tasks, from: "2026-10-14", to: empty, now: now, tokyo)
    }

    func testTodaysEventsAreInTheCalendarsOrder() throws {
        let s = try todaySnapshot()
        let ids = TodayWidgetRules.events(on: "2026-10-14", s.events, tokyo).map(\.id)
        XCTAssertEqual(ids, ["e-allday", "e-overnight", "e-early", "e-noon", "e-late"], "all-day and begun-earlier first, then by time")
        // The app's own rule on the same answer.
        CalendarDates.zoneOverride = tokyo.timeZone
        defer { CalendarDates.zoneOverride = nil }
        let app = try JSON.snakeDecoder.decode([CalendarEventOut].self, from: Data(eventsJson.utf8))
        XCTAssertEqual(CalendarDates.eventsOn(app, "2026-10-14").map(\.id), ids)
        XCTAssertEqual(CalendarDates.eventsOn(app, "2026-10-15").map(\.id), TodayWidgetRules.events(on: "2026-10-15", s.events, tokyo).map(\.id))
        for event in app { XCTAssertEqual(TodayWidgetRules.color(event.channelId), UInt32(CalendarDates.colorHex(event.channelId).dropFirst(), radix: 16)) }
        // 10:00: the morning meeting is over, the overnight one under way (till 12:00); then the seminar (13:00); the
        // all-day one only when nothing timed is left.
        XCTAssertEqual(TodayWidgetRules.nextEvent(s.events, now: now, tokyo)?.id, "e-overnight")
        XCTAssertEqual(TodayWidgetRules.nextEvent(s.events, now: now.addingTimeInterval(4 * 3600), tokyo)?.id, "e-noon", "under way at 14:00")
        XCTAssertEqual(TodayWidgetRules.nextEvent(s.events, now: now.addingTimeInterval(8 * 3600), tokyo)?.id, "e-allday")
        let four = TodayWidgetRules.visible(TodayWidgetRules.events(on: "2026-10-14", s.events, tokyo), now: now, limit: 4)
        XCTAssertEqual(four.map(\.id), ["e-allday", "e-overnight", "e-noon", "e-late"], "what is over leaves first")
    }

    func testTasksAreMineOpenDueTodayOrOverdue() throws {
        let s = try todaySnapshot()
        XCTAssertEqual(Set(s.tasks.map(\.id)), ["t-today", "t-old", "t-passed", "t-at5", "t-tomorrow"], "open, mine, due by tomorrow")
        let listed = TodayWidgetRules.tasks(s.tasks, now: now, tokyo)
        XCTAssertEqual(listed.map(\.id), ["t-old", "t-passed", "t-today", "t-at5"], "overdue first (oldest first), then today's, untimed first")
        XCTAssertEqual(TodayWidgetRules.overdueCount(s.tasks, now: now, tokyo), 2)
        // TaskRules (the app's 「期限切れ」) on the same tasks.
        CalendarDates.zoneOverride = tokyo.timeZone
        defer { CalendarDates.zoneOverride = nil }
        let app = try JSON.snakeDecoder.decode([TaskOut].self, from: Data(tasksJson.utf8))
        for task in app where s.tasks.contains(where: { $0.id == task.id }) {
            let widget = try XCTUnwrap(s.tasks.first { $0.id == task.id })
            XCTAssertEqual(TodayWidgetRules.isOverdue(widget, today: "2026-10-14", now: now), TaskRules.isOverdue(task, today: "2026-10-14", now: now), task.id)
            XCTAssertEqual(TodayWidgetRules.dueDay(widget, tokyo), TaskRules.dueDay(task), task.id)
            XCTAssertTrue(TaskRules.isMine(task, me: "me"))
        }
        // After midnight tomorrow's task is today's and today's untimed one is overdue.
        let tomorrow = now.addingTimeInterval(16 * 3600)
        XCTAssertEqual(TodayWidgetRules.tasks(s.tasks, now: tomorrow, tokyo).map(\.id), ["t-old", "t-today", "t-passed", "t-at5", "t-tomorrow"])
        XCTAssertEqual(TodayWidgetRules.overdueCount(s.tasks, now: tomorrow, tokyo), 4)
        let decoded = try JSONDecoder().decode(TodayWidgetSnapshot.self, from: JSONEncoder().encode(s))
        XCTAssertEqual(decoded, s)
    }

    func testTimelineMovesAtStartsEndsDueTimesAndMidnight() throws {
        let s = try todaySnapshot()
        let dates = TodayWidgetRules.entryDates(s, now: now, tokyo)
        XCTAssertEqual(dates.first, now)
        XCTAssertEqual(dates, dates.sorted())
        let iso = Date.ISO8601FormatStyle()
        func at(_ text: String) -> Date { try! iso.parse(text) }
        let expected = [
            at("2026-10-14T03:00:00Z"),  // the overnight one ends (12:00)
            at("2026-10-14T04:00:00Z"), at("2026-10-14T06:00:00Z"),  // the seminar
            at("2026-10-14T07:30:00Z"), at("2026-10-14T08:30:00Z"),  // 輪講
            at("2026-10-14T08:00:00Z"),  // 申請 is due
            at("2026-10-14T15:00:00Z"),  // midnight in Tokyo: tomorrow's list
            at("2026-10-15T01:00:00Z"), at("2026-10-15T01:30:00Z"),  // tomorrow's 面談
            at("2026-10-15T15:00:00Z"),  // the next midnight (the end of what was read)
        ]
        for date in expected { XCTAssertTrue(dates.contains(date), "\(date)") }
        XCTAssertFalse(dates.contains(at("2026-10-13T23:30:00Z")), "nothing in the past")
        XCTAssertEqual(dates.count, expected.count + 1)
        // Before the first read: now and the coming midnight.
        XCTAssertEqual(TodayWidgetRules.entryDates(nil, now: now, tokyo), [now, at("2026-10-14T15:00:00Z")])
        // The day the entry is drawn for.
        XCTAssertEqual(TodayWidgetModel(entry: TodayTimelineEntry(date: at("2026-10-14T15:00:00Z"), snapshot: s), calendar: tokyo).today, "2026-10-15")
    }

    func testTodayNeedsReadingWhenStaleOldFailedOrAnotherDay() throws {
        let s = try todaySnapshot()
        XCTAssertFalse(TodayWidgetRules.needsRefresh(s, now: now.addingTimeInterval(60), tokyo))
        XCTAssertTrue(TodayWidgetRules.needsRefresh(s, now: now.addingTimeInterval(15 * 60), tokyo))
        XCTAssertTrue(TodayWidgetRules.needsRefresh(s, now: now.addingTimeInterval(14 * 3600 + 60), tokyo), "after midnight")
        XCTAssertTrue(TodayWidgetRules.needsRefresh(TodayWidgetRules.failed(s, .temporary("x")), now: now, tokyo))
        // The app saw a change: stale, what was read stays shown.
        let marked = AppController.todayWidgetSnapshot(stored: s, workspace: workspace, meId: "me", now: now)
        XCTAssertNotNil(marked.staleSince)
        XCTAssertEqual(marked.events, s.events)
        XCTAssertTrue(TodayWidgetRules.needsRefresh(marked, now: now, tokyo))
        // Another account signed in on the same server: nothing of the previous one.
        let other = AppController.todayWidgetSnapshot(stored: s, workspace: workspace, meId: "someone", now: now)
        XCTAssertEqual(other.events, [])
        XCTAssertNil(other.from)
    }

    func testTodayRefreshReadsTwoDaysAndMyTasks() async throws {
        let store = file(TodayWidgetSnapshot.self)
        let account = signedInAccount()
        // Marked by the app a minute ago (before the read starts: the read clears it; a later mark would stay).
        var s = AppController.todayWidgetSnapshot(stored: nil, workspace: workspace, meId: "me", now: Date().addingTimeInterval(-60))
        s.serverUrl = "https://widget.test"
        s.account = account
        store.save(s, active: true)
        let events = eventsJson, tasks = tasksJson
        WidgetStubProtocol.reset { request in
            request.url?.path == "/api/v1/calendar/events" ? (200, events) : (200, tasks)
        }
        let read = await TodayWidgetActions.refresh(account: account, now: now, calendar: tokyo, file: store, makeApi: stubApi)
        XCTAssertEqual(read?.from, "2026-10-14")
        XCTAssertNil(read?.staleSince)
        XCTAssertEqual(read?.events.count, 6)
        XCTAssertEqual(read?.tasks.count, 5)
        let calendarRequest = try XCTUnwrap(WidgetStubProtocol.requests.first { $0.url?.path == "/api/v1/calendar/events" })
        let query = try XCTUnwrap(calendarRequest.url?.query)
        let from = try XCTUnwrap(URLComponents(string: "x:?" + query)?.queryItems?.first { $0.name == "from" }?.value)
        let to = try XCTUnwrap(URLComponents(string: "x:?" + query)?.queryItems?.first { $0.name == "to" }?.value)
        XCTAssertEqual(try Date.ISO8601FormatStyle().parse(from), tokyo.startOfDay(for: now), "the local midnight (its offset escaped: \(query))")
        XCTAssertEqual(try Date.ISO8601FormatStyle().parse(to), tokyo.startOfDay(for: now).addingTimeInterval(2 * 86_400))
        XCTAssertFalse(query.contains("+"), "a + in a query is a space")
        XCTAssertTrue(WidgetStubProtocol.requests.contains { $0.url?.path == "/api/v1/tasks/mine" })

        // A server without a calendar (404) still lists the tasks.
        WidgetStubProtocol.reset { request in
            request.url?.path == "/api/v1/calendar/events" ? (404, #"{"error": {"code": "not_found", "message": "", "details": {}}}"#) : (200, tasks)
        }
        let noCalendar = await TodayWidgetActions.refresh(account: account, now: now, calendar: tokyo, file: store, makeApi: stubApi)
        XCTAssertEqual(noCalendar?.events, [])
        XCTAssertEqual(noCalendar?.tasks.count, 5)
        XCTAssertNil(noCalendar?.problem)

        WidgetStubProtocol.reset { _ in nil }
        let offline = await TodayWidgetActions.refresh(account: account, now: now, calendar: tokyo, file: store, makeApi: stubApi)
        XCTAssertEqual(offline?.problem, .offline)
        XCTAssertEqual(offline?.tasks.count, 5, "what was read stays")
    }

    // MARK: links into the app

    func testLinksNameTheirWorkspaceAndTarget() throws {
        let server = "https://lab.example.jp:8443/chat"
        let links: [WidgetLink] = [
            .attendance(server: server), .open(server: server), .calendar(server: server), .tasks(server: server),
            .channel(id: "4b1c6a0e-0000-4000-8000-000000000001", server: server),
            .event(id: "e1", channelId: "c1", server: server), .event(id: "e2", channelId: nil, server: server),
            .task(id: "t1", channelId: "c1", server: server), .task(id: "t2", channelId: nil, server: nil), .open(server: nil),
        ]
        for link in links {
            XCTAssertEqual(link.url.scheme, "chikuwachat")
            XCTAssertEqual(WidgetLink.parse(link.url), link, link.url.absoluteString)
        }
        XCTAssertEqual(WidgetLink.channel(id: "abc", server: server).url.absoluteString,
                       "chikuwachat://channel/abc?server=https://lab.example.jp:8443/chat")
        XCTAssertEqual(WidgetLink.event(id: "e1", channelId: "c1", server: nil).url.absoluteString, "chikuwachat://event/e1?channel=c1")
        XCTAssertNil(WidgetLink.parse(URL(string: "chikuwachat://sso?ticket=x")!))
        XCTAssertNil(WidgetLink.parse(URL(string: "chikuwachat://channel")!), "no id")
        XCTAssertNil(WidgetLink.parse(URL(string: "https://channel/abc")!))
        // The attendance widget's own links keep working.
        XCTAssertEqual(WidgetLink.parse(AttendanceWidgetLink.url(serverUrl: server)), .attendance(server: server))
        // A row opens what a notification would: a DM task (review request) goes to 「自分のタスク」 in the app.
        let task = TodayWidgetTask(id: "t1", title: "x", channelId: "c1", channelName: "lab", dueOn: "2026-10-14")
        XCTAssertEqual(TodayWidgetRules.link(task, server: server), .task(id: "t1", channelId: "c1", server: server))
    }

    func testTappedLinksWaitForStartup() async {
        let controller = AppController(defaults: UserDefaults(suiteName: "InfoWidgetsTests.\(UUID().uuidString)")!)
        XCTAssertTrue(controller.openWidgetLink(WidgetLink.event(id: "e1", channelId: nil, server: "https://lab.example.jp").url))
        XCTAssertFalse(controller.openWidgetLink(URL(string: "chikuwachat://nothing")!))
        await Task.yield()
        try? await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(controller.pendingWidgetLink, .event(id: "e1", channelId: nil, server: "https://lab.example.jp"))
    }

    // MARK: the workspace each widget shows

    private func indexFile() -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("InfoWidgetsTests-\(UUID().uuidString)/workspaces.json")
        addTeardownBlock { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        return url
    }

    private let lab = Workspace(serverUrl: "https://lab.example.jp", workspaceId: "w1", name: "加納研", username: "kano", userId: "me")
    private let local = Workspace(serverUrl: "http://127.0.0.1:8000", workspaceId: "w2", name: "開発", username: "android1", userId: "u9")
    private let gone = Workspace(serverUrl: "https://old.example.jp", name: "旧研究室", username: "kano", signedOut: true)

    func testChoicesAreFollowTheAppThenTheSignedInWorkspaces() async throws {
        let file = indexFile()
        XCTAssertNil(WidgetWorkspaces.read(file))
        XCTAssertTrue(WidgetWorkspaces.save(WidgetWorkspaceIndex(active: lab.account, workspaces: [lab, gone, local]), to: file))
        let choices = WidgetWorkspaceEntity.all(file, snapshots: { [] })
        XCTAssertEqual(choices.map(\.id), [WidgetWorkspaceEntity.followAppId, lab.account, local.account], "signed out ones are not offered")
        XCTAssertEqual(choices[1].name, "加納研")
        XCTAssertEqual(choices[2].detail, "android1 @ 127.0.0.1:8000")
        let defaultChoice = await WidgetWorkspaceQuery().defaultResult()
        XCTAssertEqual(defaultChoice?.id, WidgetWorkspaceEntity.followAppId)

        // A saved choice keeps its workspace when it signs out or leaves (the widget then asks to sign in).
        let resolved = WidgetWorkspaceEntity.resolve([local.account, gone.account, "https://x.example|y", WidgetWorkspaceEntity.followAppId], file,
                                                     snapshots: { [] })
        XCTAssertEqual(resolved.map(\.id), [local.account, gone.account, "https://x.example|y", WidgetWorkspaceEntity.followAppId])
        XCTAssertEqual(resolved[1].name, "旧研究室")

        // Only what a widget shows reloads them: not the unread counts the list also carries.
        var counted = lab
        counted.badge = 4
        XCTAssertFalse(WidgetWorkspaces.save(WidgetWorkspaceIndex(active: lab.account, workspaces: [counted, gone, local]), to: file))
        XCTAssertEqual(WidgetWorkspaces.read(file)?.workspaces.first?.badge, 4, "written all the same")
        var renamed = lab
        renamed.name = "加納研究室"
        XCTAssertTrue(WidgetWorkspaces.save(WidgetWorkspaceIndex(active: lab.account, workspaces: [renamed, gone, local]), to: file))
        XCTAssertNil(WidgetWorkspaces.workspace(account: gone.account, file), "signed out")
        XCTAssertEqual(WidgetWorkspaces.header(.account(gone.account), account: nil, file)?.name, "旧研究室", "its name over the sign-in face")
    }

    func testBeforeTheAppWroteItsListTheSnapshotsNameTheWorkspaces() {
        let file = indexFile()
        let fromSnapshots = [lab]
        XCTAssertEqual(WidgetWorkspaceEntity.all(file, snapshots: { fromSnapshots }).map(\.id), [WidgetWorkspaceEntity.followAppId, lab.account])
        XCTAssertEqual(WidgetWorkspaces.workspace(account: lab.account, file, snapshots: { fromSnapshots })?.name, "加納研")
    }

    func testAWidgetPlacedBeforeTheChoiceFollowsTheApp() {
        // Placed before the update: no configuration, the parameter is nil.
        XCTAssertEqual(WidgetWorkspaceIntent().selection, .followApp)
        XCTAssertEqual(WidgetWorkspaceIntent(workspace: .followApp).selection, .followApp)
        XCTAssertEqual(WidgetWorkspaceIntent(workspace: WidgetWorkspaceEntity(local)).selection, .account(local.account))
    }

    func testEachWidgetDrawsItsChosenWorkspace() {
        let store = file(UnreadWidgetSnapshot.self)
        var onScreen = unreadSnapshot([conversation("c", mentions: 1)])
        onScreen.account = lab.account
        store.save(onScreen, active: true)
        var other = onScreen
        other.account = "https://other.example.jp|kano"
        other.serverUrl = "https://other.example.jp"
        other.total = 9
        store.save(other)
        let rows: [String: Workspace] = [lab.account: lab, local.account: local,
                                         other.account: Workspace(serverUrl: other.serverUrl, name: "他", username: "kano")]
        func resolve(_ selection: WidgetWorkspaceSelection) -> UnreadWidgetSnapshot? {
            store.resolve(selection, workspace: { rows[$0] }, seed: UnreadWidgetRules.seed)
        }
        XCTAssertEqual(resolve(.followApp)?.account, lab.account, "the app's")
        XCTAssertEqual(resolve(.account(other.account))?.total, 9, "the chosen one's, not the one on screen")
        XCTAssertNil(resolve(.account(gone.account)), "signed out or removed: the sign-in face")

        // A workspace the app has written nothing for yet starts from its row and is read at once.
        var withBadge = local
        withBadge.badge = 3
        let seeded = store.resolve(.account(local.account), workspace: { $0 == local.account ? withBadge : nil }, seed: UnreadWidgetRules.seed)
        XCTAssertEqual(seeded?.serverUrl, local.serverUrl)
        XCTAssertEqual(seeded?.userId, "u9")
        XCTAssertEqual(seeded?.total, 3, "the switcher's last count until the server answers")
        XCTAssertTrue(seeded?.needsRefresh() ?? false)
        XCTAssertFalse(seeded.map(UnreadWidgetRules.hasRows) ?? true)
        XCTAssertEqual(store.snapshot(account: local.account), seeded, "kept for the refresh")
        XCTAssertEqual(store.current()?.account, lab.account, "the app's choice is untouched")

        let today = file(TodayWidgetSnapshot.self)
        let seededDay = today.resolve(.account(local.account), workspace: { rows[$0] }, seed: TodayWidgetSnapshot.seed)
        XCTAssertNil(seededDay?.from)
        XCTAssertTrue(seededDay.map { TodayWidgetRules.needsRefresh($0) } ?? false)
    }

    func testAChosenAttendanceWorkspaceStartsFromTheAppsTables() {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("InfoWidgetsTests-\(UUID().uuidString)/attendance.json")
        addTeardownBlock { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        var known = AttendanceWidgetSamples.snapshot
        known.account = lab.account
        known.serverUrl = lab.serverUrl
        AttendanceWidgetStore.save(known, active: true, to: url)
        let rows = [lab.account: lab, local.account: local]
        XCTAssertEqual(AttendanceWidgetStore.resolve(.followApp, url, workspace: { rows[$0] })?.account, lab.account)
        let seeded = AttendanceWidgetStore.resolve(.account(local.account), url, workspace: { rows[$0] })
        XCTAssertEqual(seeded?.account, local.account)
        XCTAssertEqual(seeded?.userId, "u9")
        XCTAssertEqual(seeded?.symbols, known.symbols, "the app's icon table")
        XCTAssertTrue(seeded.map(AttendanceWidgetRules.isLoading) ?? false)
        XCTAssertTrue(seeded?.needsRefresh() ?? false)
        XCTAssertNil(AttendanceWidgetStore.resolve(.account(gone.account), url, workspace: { rows[$0] }))
        XCTAssertEqual(AttendanceWidgetStore.current(url)?.account, lab.account, "the app's choice is untouched")
    }

    func testAChosenWorkspaceIsReadWithItsOwnAccount() async throws {
        let store = file(UnreadWidgetSnapshot.self)
        let account = signedInAccount()
        let row = Workspace(serverUrl: "https://widget.test", name: "テスト", username: String(account.dropFirst("https://widget.test|".count)), userId: "me")
        XCTAssertEqual(row.account, account)
        let seeded = try XCTUnwrap(store.resolve(.account(account), workspace: { $0 == account ? row : nil }, seed: UnreadWidgetRules.seed))
        WidgetStubProtocol.reset { _ in (200, #"{"badge": 4, "has_unread": true}"#) }
        let read = await UnreadWidgetActions.refresh(account: seeded.account, file: store, makeApi: stubApi)
        XCTAssertEqual(read?.total, 4)
        XCTAssertEqual(WidgetStubProtocol.requests.first?.url?.host, "widget.test")
    }

    func testUnreadBreakdownAndThePeopleInTheRoom() {
        let s = unreadSnapshot([
            conversation("dm", type: "dm", unread: 3, dm: ["me", "u2"], last: ("u2", "2026-10-14T03:00:00Z")),
            conversation("group", type: "group_dm", unread: 2, dm: ["me", "u2", "u3"], last: ("u3", "2026-10-14T05:00:00Z")),
            conversation("seminar", unread: 9, mentions: 1, last: ("u2", "2026-10-14T04:00:00Z")),
        ], others: 2)
        XCTAssertEqual(UnreadWidgetRules.breakdown(s), UnreadWidgetRules.Breakdown(mentions: 1, dms: 5, others: 2))
        XCTAssertNil(UnreadWidgetRules.breakdown(UnreadWidgetRules.applying(summaryBadge: 9, to: s)), "the rows no longer add up")
        let dm = s.rows.first { $0.id == "dm" }
        XCTAssertEqual(dm?.avatar?.name, "花子", "a 1:1 DM shows the other person")
        XCTAssertEqual(dm?.avatar?.initials, "花")
        XCTAssertEqual(dm?.group, false)
        XCTAssertNil(s.rows.first { $0.id == "group" }?.avatar)
        XCTAssertEqual(s.rows.first { $0.id == "group" }?.group, true)
        XCTAssertNil(s.rows.first { $0.id == "seminar" }?.group)
    }

    func testLargeTodayListsShareTheirRows() {
        XCTAssertEqual(TodayWidgetRules.largeLimits(events: 5, tasks: 4).events, 4)
        XCTAssertEqual(TodayWidgetRules.largeLimits(events: 5, tasks: 4).tasks, 4)
        XCTAssertEqual(TodayWidgetRules.largeLimits(events: 12, tasks: 2).events, 6)
        XCTAssertEqual(TodayWidgetRules.largeLimits(events: 2, tasks: 12).tasks, 6)
        XCTAssertEqual(TodayWidgetRules.largeLimits(events: 0, tasks: 12).tasks, 8)
        XCTAssertEqual(TodayWidgetRules.largeLimits(events: 3, tasks: 0).events, 3)
    }

    // MARK: faces

    func testFacesRender() throws {
        let small = WidgetFaceRenderer.small, medium = WidgetFaceRenderer.medium, large = WidgetFaceRenderer.large
        let rect = WidgetFaceRenderer.rectangular, circle = WidgetFaceRenderer.circular, inline = WidgetFaceRenderer.inline
        let unread = unreadSnapshot([
            conversation("dm", type: "dm", name: nil, unread: 3, dm: ["me", "u2"], last: ("u2", "2026-10-14T03:00:00Z")),
            conversation("group", type: "group_dm", unread: 2, dm: ["me", "u2", "u3"], last: ("u3", "2026-10-14T05:00:00Z")),
            conversation("seminar-m2-progress", unread: 9, mentions: 1, last: ("u2", "2026-10-14T04:00:00Z")),
            conversation("general", unread: 1, mentions: 1, last: ("u3", "2026-10-14T01:00:00Z")),
        ], others: 1)
        var unreadStale = UnreadWidgetRules.applying(summaryBadge: 12, to: unread)
        unreadStale.problem = .offline
        let unreadNone = unreadSnapshot([])
        let unreadThreads = unreadSnapshot([], others: 4)
        let unreadSeed = UnreadWidgetRules.applying(summaryBadge: 5, to: UnreadWidgetRules.seed(workspace))
        let today = try todaySnapshot()
        var todayEmpty = today
        todayEmpty.events = []
        todayEmpty.tasks = []
        let evening = now.addingTimeInterval(9 * 3600)
        let header = Workspace(serverUrl: workspace.serverUrl, workspaceId: "lab-1", name: workspace.name, username: "kano")
        func u(_ s: UnreadWidgetSnapshot?, _ family: WidgetFamily) -> UnreadWidgetView {
            UnreadWidgetView(entry: UnreadTimelineEntry(date: now, snapshot: s, workspace: s == nil ? nil : header), family: family)
        }
        func t(_ s: TodayWidgetSnapshot?, _ family: WidgetFamily, at date: Date? = nil) -> TodayWidgetView {
            TodayWidgetView(entry: TodayTimelineEntry(date: date ?? now, snapshot: s, workspace: s == nil ? nil : header), family: family, calendar: tokyo)
        }
        for look in WidgetFaceRenderer.Look.allCases {
            if look == .lock {
                try WidgetFaceRenderer.render(u(unread, .accessoryCircular), size: circle, look: look, name: "unread-lock-circular")
                try WidgetFaceRenderer.render(u(unread, .accessoryRectangular), size: rect, look: look, name: "unread-lock-rectangular")
                try WidgetFaceRenderer.render(u(unread, .accessoryInline), size: inline, look: look, name: "unread-lock-inline")
                try WidgetFaceRenderer.render(t(today, .accessoryRectangular), size: rect, look: look, name: "today-lock-rectangular")
                try WidgetFaceRenderer.render(t(today, .accessoryInline), size: inline, look: look, name: "today-lock-inline")
                continue
            }
            try WidgetFaceRenderer.render(u(unread, .systemSmall), size: small, look: look, name: "unread-small")
            try WidgetFaceRenderer.render(u(unreadNone, .systemSmall), size: small, look: look, name: "unread-small-none")
            try WidgetFaceRenderer.render(u(nil, .systemSmall), size: small, look: look, name: "unread-small-signed-out")
            try WidgetFaceRenderer.render(u(unread, .systemMedium), size: medium, look: look, name: "unread-medium")
            try WidgetFaceRenderer.render(u(unreadStale, .systemMedium), size: medium, look: look, name: "unread-medium-stale")
            try WidgetFaceRenderer.render(u(unreadNone, .systemMedium), size: medium, look: look, name: "unread-medium-none")
            try WidgetFaceRenderer.render(u(unreadThreads, .systemMedium), size: medium, look: look, name: "unread-medium-threads")
            try WidgetFaceRenderer.render(u(unreadSeed, .systemMedium), size: medium, look: look, name: "unread-medium-not-opened")

            try WidgetFaceRenderer.render(t(today, .systemSmall), size: small, look: look, name: "today-small")
            try WidgetFaceRenderer.render(t(todayEmpty, .systemSmall), size: small, look: look, name: "today-small-empty")
            try WidgetFaceRenderer.render(t(today, .systemMedium), size: medium, look: look, name: "today-medium")
            try WidgetFaceRenderer.render(t(today, .systemMedium, at: evening), size: medium, look: look, name: "today-medium-evening")
            try WidgetFaceRenderer.render(t(todayEmpty, .systemMedium), size: medium, look: look, name: "today-medium-empty")
            try WidgetFaceRenderer.render(t(nil, .systemMedium), size: medium, look: look, name: "today-medium-signed-out")
            try WidgetFaceRenderer.render(t(today, .systemLarge), size: large, look: look, name: "today-large")
        }
        // One size larger text than the default (the widgets cap it at xLarge).
        try WidgetFaceRenderer.render(u(unread, .systemSmall), size: small, look: .light, name: "unread-small", textSize: .xLarge)
        try WidgetFaceRenderer.render(u(unread, .systemMedium), size: medium, look: .light, name: "unread-medium", textSize: .xLarge)
        try WidgetFaceRenderer.render(t(today, .systemSmall), size: small, look: .light, name: "today-small", textSize: .xLarge)
        try WidgetFaceRenderer.render(t(today, .systemMedium), size: medium, look: .light, name: "today-medium", textSize: .xLarge)
        try WidgetFaceRenderer.render(t(today, .systemLarge), size: large, look: .light, name: "today-large", textSize: .xLarge)
    }
}
