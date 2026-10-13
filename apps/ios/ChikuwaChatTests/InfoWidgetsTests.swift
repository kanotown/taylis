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

    // MARK: faces

    private func render<V: View>(_ view: V, size: CGSize, style: UIUserInterfaceStyle, name: String) throws {
        let dark = style == .dark
        let framed = view
            .padding(16)
            .frame(width: size.width, height: size.height)
            .background(dark ? Color.black : Color.white, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            .padding(20)
            .background(dark ? Color(white: 0.12) : Color(white: 0.82))
            .environment(\.colorScheme, dark ? .dark : .light)
        let renderer = ImageRenderer(content: framed)
        renderer.scale = 3
        let image = try XCTUnwrap(renderer.uiImage)
        XCTAssertEqual(image.size.width, size.width + 40, accuracy: 1)
        if let dir = ProcessInfo.processInfo.environment["SNAPSHOT_DIR"], let data = image.pngData() {
            let url = URL(fileURLWithPath: dir).appendingPathComponent(name)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: url)
            print("snapshot written: \(url.path)")
        }
    }

    func testFacesRender() throws {
        let small = CGSize(width: 170, height: 170), medium = CGSize(width: 364, height: 170), large = CGSize(width: 364, height: 382)
        let rect = CGSize(width: 172, height: 76), circle = CGSize(width: 76, height: 76), inline = CGSize(width: 260, height: 40)
        let unread = unreadSnapshot([
            conversation("dm", type: "dm", name: nil, unread: 3, dm: ["me", "u2"], last: ("u2", "2026-10-14T03:00:00Z")),
            conversation("group", type: "group_dm", unread: 2, dm: ["me", "u2", "u3"], last: ("u3", "2026-10-14T05:00:00Z")),
            conversation("seminar-m2-progress", unread: 9, mentions: 1, last: ("u2", "2026-10-14T04:00:00Z")),
            conversation("general", unread: 1, mentions: 1, last: ("u3", "2026-10-14T01:00:00Z")),
        ])
        var unreadStale = UnreadWidgetRules.applying(summaryBadge: 12, to: unread)
        unreadStale.problem = .offline
        let unreadNone = unreadSnapshot([])
        let unreadThreads = unreadSnapshot([], others: 4)
        let today = try todaySnapshot()
        var todayEmpty = today
        todayEmpty.events = []
        todayEmpty.tasks = []
        let evening = now.addingTimeInterval(9 * 3600)
        for (style, suffix) in [(UIUserInterfaceStyle.light, "light"), (.dark, "dark")] {
            func u(_ s: UnreadWidgetSnapshot?, _ family: WidgetFamily) -> UnreadWidgetView {
                UnreadWidgetView(entry: UnreadTimelineEntry(date: now, snapshot: s), family: family)
            }
            try render(u(unread, .systemSmall), size: small, style: style, name: "unread-small-\(suffix).png")
            try render(u(unread, .systemMedium), size: medium, style: style, name: "unread-medium-\(suffix).png")
            try render(u(unreadStale, .systemMedium), size: medium, style: style, name: "unread-medium-stale-\(suffix).png")
            try render(u(unreadNone, .systemMedium), size: medium, style: style, name: "unread-medium-none-\(suffix).png")
            try render(u(unreadNone, .systemSmall), size: small, style: style, name: "unread-small-none-\(suffix).png")
            try render(u(unreadThreads, .systemMedium), size: medium, style: style, name: "unread-medium-threads-\(suffix).png")
            try render(u(nil, .systemSmall), size: small, style: style, name: "unread-small-signed-out-\(suffix).png")
            try render(u(unread, .accessoryCircular), size: circle, style: style, name: "unread-lock-circular-\(suffix).png")
            try render(u(unread, .accessoryRectangular), size: rect, style: style, name: "unread-lock-rectangular-\(suffix).png")
            try render(u(unread, .accessoryInline), size: inline, style: style, name: "unread-lock-inline-\(suffix).png")

            func t(_ s: TodayWidgetSnapshot?, _ family: WidgetFamily, at date: Date? = nil) -> TodayWidgetView {
                TodayWidgetView(entry: TodayTimelineEntry(date: date ?? now, snapshot: s), family: family, calendar: tokyo)
            }
            try render(t(today, .systemSmall), size: small, style: style, name: "today-small-\(suffix).png")
            try render(t(today, .systemMedium), size: medium, style: style, name: "today-medium-\(suffix).png")
            try render(t(today, .systemLarge), size: large, style: style, name: "today-large-\(suffix).png")
            try render(t(today, .systemMedium, at: evening), size: medium, style: style, name: "today-medium-evening-\(suffix).png")
            try render(t(todayEmpty, .systemSmall), size: small, style: style, name: "today-small-empty-\(suffix).png")
            try render(t(todayEmpty, .systemMedium), size: medium, style: style, name: "today-medium-empty-\(suffix).png")
            try render(t(nil, .systemMedium), size: medium, style: style, name: "today-medium-signed-out-\(suffix).png")
            try render(t(today, .accessoryRectangular), size: rect, style: style, name: "today-lock-rectangular-\(suffix).png")
            try render(t(today, .accessoryInline), size: inline, style: style, name: "today-lock-inline-\(suffix).png")
        }
    }
}
