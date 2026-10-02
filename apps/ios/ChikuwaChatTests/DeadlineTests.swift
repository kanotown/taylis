import XCTest
@testable import ChikuwaChat

/// M86 (docs/DEADLINES.md §8): deadlines on the phone — the pure rules (notice days, the chip, 「締切」's groups), the
/// form's draft and its requests, the hub's deadlines window, decoding and the wire. The desktop's tests/deadlines.test.tsx.
@MainActor
final class DeadlineTests: XCTestCase {
    private typealias F = TaskFixtures
    private let today: DayKey = "2026-10-07"  // a Wednesday
    private let now = ISO8601DateFormatter().date(from: "2026-10-07T03:00:00Z")!  // 12:00 in Tokyo

    override func setUp() { CalendarDates.zoneOverride = TimeZone(identifier: "Asia/Tokyo") }
    override func tearDown() {
        CalendarDates.zoneOverride = nil
        StubProtocol.handler = nil
    }

    private func deadline(_ title: String, _ dueOn: String, id: String? = nil, channelId: String = "c-lab", status: TaskStatus = .todo,
                          dueAt: String? = nil, notice: [Int] = [7, 3, 1, 0], updatedAt: String = "2026-10-01T00:00:00Z") -> TaskOut {
        var out = F.task(title, id: id, channelId: channelId, status: status, dueOn: dueOn, updatedAt: updatedAt, kind: .deadline)
        out.dueAt = dueAt
        out.dueTz = dueAt == nil ? nil : "Asia/Tokyo"
        out.noticeDays = notice
        if status == .done { out.completedAt = "2026-09-29T00:00:00Z" }
        return out
    }

    // MARK: the rules

    func testSaysHowFarADeadlineIs() {
        XCTAssertEqual(DeadlineRules.remainingText(deadline("x", "2026-10-07"), today: today), "今日")
        XCTAssertEqual(DeadlineRules.remainingText(deadline("x", "2026-10-07", dueAt: "2026-10-07T08:00:00Z"), today: today), "今日 17:00")
        XCTAssertEqual(DeadlineRules.remainingText(deadline("x", "2026-10-08"), today: today), "明日")
        XCTAssertEqual(DeadlineRules.remainingText(deadline("x", "2026-10-08", dueAt: "2026-10-08T08:00:00Z"), today: today), "明日 17:00")
        XCTAssertEqual(DeadlineRules.remainingText(deadline("x", "2026-10-10"), today: today), "あと 3 日")
        XCTAssertEqual(DeadlineRules.chipText(deadline("全国大会 原稿", "2026-10-10"), today: today), "全国大会 原稿 あと 3 日")
        XCTAssertEqual(DeadlineRules.when(deadline("x", "2026-10-09"), today: today), "10/9 (金)")
        XCTAssertEqual(DeadlineRules.when(deadline("x", "2026-10-09", dueAt: "2026-10-09T08:00:00Z"), today: today), "10/9 (金) 17:00")
        XCTAssertEqual(DeadlineRules.when(deadline("x", "2026-10-07", dueAt: "2026-10-07T08:00:00Z"), today: today), "今日 17:00")
        XCTAssertEqual(DeadlineRules.when(deadline("x", "2027-01-08"), today: today), "2027/1/8 (金)")
        // The chip's colour: today and tomorrow red, within a week amber, later grey.
        XCTAssertEqual(DeadlineRules.tone(deadline("x", "2026-10-08"), today: today), .soon)
        XCTAssertEqual(DeadlineRules.tone(deadline("x", "2026-10-14"), today: today), .week)
        XCTAssertEqual(DeadlineRules.tone(deadline("x", "2026-10-15"), today: today), .later)
        // The notice days.
        XCTAssertEqual(DeadlineRules.noticeSummary([0, 7, 1, 3]), "7 日前・3 日前・前日・当日")
        XCTAssertEqual(DeadlineRules.noticeSummary([]), "通知しない")
        XCTAssertEqual(DeadlineRules.noticeSummary(nil), "通知しない")
        XCTAssertEqual(DeadlineRules.noticeLabel(14), "14 日前")
        XCTAssertEqual(DeadlineRules.normalize([1, 7, 1, 0]), [7, 1, 0])
        XCTAssertTrue(DeadlineRules.sameNoticeDays([0, 3, 7, 1], [7, 3, 1, 0]))
        XCTAssertFalse(DeadlineRules.sameNoticeDays([1], [7, 3, 1, 0]))
        // The form's checks: the usual five and another day it already has.
        XCTAssertEqual(DeadlineRules.noticeRows([5, 7]), [14, 7, 5, 3, 1, 0])
    }

    func testKnowsWhenItHasPassedAndPicksTheChannelsNextOpenOne() {
        XCTAssertTrue(DeadlineRules.passed(deadline("x", "2026-10-06"), today: today, now: now))
        XCTAssertFalse(DeadlineRules.passed(deadline("x", "2026-10-07"), today: today, now: now))
        XCTAssertTrue(DeadlineRules.passed(deadline("x", "2026-10-07", dueAt: "2026-10-07T02:00:00Z"), today: today, now: now))  // 11:00
        XCTAssertFalse(DeadlineRules.passed(deadline("x", "2026-10-07", dueAt: "2026-10-07T08:00:00Z"), today: today, now: now))
        let past = deadline("過ぎた", "2026-10-06")
        let done = deadline("済み", "2026-10-08", status: .done)
        let later = deadline("後", "2026-10-20")
        let soon = deadline("次", "2026-10-09")
        let elsewhere = deadline("他", "2026-10-08", channelId: "c-other")
        let plain = F.task("ただのタスク", dueOn: "2026-10-08")
        XCTAssertEqual(DeadlineRules.next([past, done, later, soon, elsewhere, plain], channelId: "c-lab", today: today, now: now)?.title, "次")
        XCTAssertNil(DeadlineRules.next([past, done], channelId: "c-lab", today: today, now: now))
        // The same day: a timed one first (a date alone is the whole day), then by id.
        let whole = deadline("終日", "2026-10-09", id: "a")
        let timed = deadline("17 時", "2026-10-09", id: "z", dueAt: "2026-10-09T08:00:00Z")
        XCTAssertEqual(DeadlineRules.next([whole, timed], channelId: "c-lab", today: today, now: now)?.title, "17 時")
    }

    func testGroupsThisWeekThisMonthLaterAndPast() {
        let rows = [
            deadline("土曜", "2026-10-10"),
            deadline("今日", "2026-10-07"),
            deadline("日曜", "2026-10-11"),
            deadline("月末", "2026-10-31"),
            deadline("来月", "2026-11-02"),
            deadline("昨日", "2026-10-06"),
            deadline("先週", "2026-09-30", status: .done),
            deadline("今朝", "2026-10-07", dueAt: "2026-10-07T00:00:00Z"),  // 9:00, over
            F.task("タスク", dueOn: "2026-10-08"),
        ]
        let groups = DeadlineRules.groups(rows, today: today, now: now)
        XCTAssertEqual(groups.map(\.label), ["今週", "今月", "それ以降", "過ぎたもの"])
        XCTAssertEqual(groups.map { $0.tasks.map(\.title) }, [["今日", "土曜"], ["日曜", "月末"], ["来月"], ["今朝", "昨日", "先週"]])
        // An empty group is left out.
        XCTAssertEqual(DeadlineRules.groups([deadline("先", "2026-12-01"), deadline("近い", "2026-10-09")], today: today, now: now).map(\.key),
                       [.week, .later])
        XCTAssertEqual(DeadlineRules.groups([], today: today, now: now), [])
    }

    // MARK: the form

    func testTheDraftNeedsADateAndSendsItsNotices() throws {
        var draft = TaskDraft.newDeadline(boards: ["c-lab", "c-m2"])
        XCTAssertEqual(draft.kind, .deadline)
        XCTAssertEqual(draft.channelId, "c-lab")
        XCTAssertEqual(draft.noticeDays, [7, 3, 1, 0])
        draft.title = "原稿"
        draft.noticeDays = [1, 7]
        XCTAssertEqual(draft.problem, "締切の日付を入れてください")
        var task = draft
        task.setKind(.task)
        XCTAssertNil(task.problem)
        draft.dueOn = "2026-10-20"
        XCTAssertNil(draft.problem)
        let body = draft.create(clientTaskId: "k1", tz: "Asia/Tokyo")
        XCTAssertEqual(body.kind, .deadline)
        XCTAssertEqual(body.channelId, "c-lab")
        XCTAssertEqual(body.noticeDays, [7, 1])
        XCTAssertNil(body.rrule)
        guard case .object(let fields) = body.json else { return XCTFail("an object") }
        XCTAssertEqual(fields["kind"], .string("deadline"))
        XCTAssertEqual(fields["channel_id"], .string("c-lab"))
        XCTAssertEqual(fields["due_on"], .string("2026-10-20"))
        XCTAssertEqual(fields["notice_days"], .array([.number(7), .number(1)]))
        XCTAssertNil(fields["rrule"])
        // With a time: due_at with the device's offset.
        draft.dueTime = "17:00"
        XCTAssertEqual(draft.create(clientTaskId: "k1", tz: "Asia/Tokyo").dueAt, "2026-10-20T17:00:00+09:00")
        // None checked: an empty set (the bot says nothing).
        draft.noticeDays = []
        guard case .object(let quiet) = draft.create(clientTaskId: "k1", tz: "Asia/Tokyo").json else { return XCTFail("an object") }
        XCTAssertEqual(quiet["notice_days"], .array([]))
        // A plain task sends neither the kind nor the days.
        guard case .object(let plain) = TaskDraft(title: "x", channelId: "c-lab").create(clientTaskId: "k", tz: "Asia/Tokyo").json else {
            return XCTFail("an object")
        }
        XCTAssertNil(plain["kind"])
        XCTAssertNil(plain["notice_days"])
    }

    func testTheSwitchTurnsANewBoardTaskIntoADeadlineWithoutARepeat() {
        var draft = TaskDraft(title: "週報", channelId: "c-lab")
        draft.dueOn = "2026-10-12"
        draft.repetition = CalendarRecurrence.noRepeat("2026-10-12")
        draft.repetition.kind = .weekly
        XCTAssertEqual(draft.create(clientTaskId: "k", tz: "Asia/Tokyo").rrule, "FREQ=WEEKLY;BYDAY=MO")
        draft.setKind(.deadline)
        XCTAssertEqual(draft.repetition.kind, .none)
        XCTAssertNil(draft.rrule)
        XCTAssertNil(draft.problem)
        XCTAssertNil(draft.create(clientTaskId: "k", tz: "Asia/Tokyo").rrule)
        // Even a rule left in the draft is not sent for a deadline.
        draft.repetition.kind = .daily
        XCTAssertNil(draft.create(clientTaskId: "k", tz: "Asia/Tokyo").rrule)
        XCTAssertNil(draft.problem)
    }

    func testEditingPatchesTheNoticeDaysAloneWhenTheyChanged() {
        let saved = deadline("原稿", "2026-10-20", notice: [7, 3, 1, 0])
        let draft = TaskDraft(task: saved)
        XCTAssertEqual(draft.kind, .deadline)
        XCTAssertEqual(draft.noticeDays, [7, 3, 1, 0])
        XCTAssertTrue(draft.patch(from: saved, tz: "Asia/Tokyo").isEmpty)
        var same = draft
        same.noticeDays = [0, 3, 7, 1]
        XCTAssertTrue(same.patch(from: saved, tz: "Asia/Tokyo").isEmpty)
        var fewer = draft
        fewer.noticeDays = [1]
        XCTAssertEqual(fewer.patch(from: saved, tz: "Asia/Tokyo"), TaskPatch(noticeDays: [1]))
        XCTAssertEqual(fewer.patch(from: saved, tz: "Asia/Tokyo").json, .object(["notice_days": .array([.number(1)])]))
        var more = draft
        more.noticeDays = [0, 14, 7, 3, 1]
        XCTAssertEqual(more.patch(from: saved, tz: "Asia/Tokyo").noticeDays, [14, 7, 3, 1, 0])  // largest first
        var none = draft
        none.noticeDays = []
        XCTAssertEqual(none.patch(from: saved, tz: "Asia/Tokyo").json, .object(["notice_days": .array([])]))
        // Moving the date keeps the days; a task that is not a deadline never sends them.
        var moved = draft
        moved.dueOn = "2026-10-21"
        XCTAssertEqual(moved.patch(from: saved, tz: "Asia/Tokyo").json, .object(["due_on": .string("2026-10-21"), "tz": .string("Asia/Tokyo")]))
        let plain = F.task("x", dueOn: "2026-10-20")
        var other = TaskDraft(task: plain)
        other.noticeDays = [1]
        XCTAssertNil(other.patch(from: plain, tz: "Asia/Tokyo").noticeDays)
        // A deadline from a server that left the days out (null) reads as none and patches nothing.
        var bare = saved
        bare.noticeDays = nil
        XCTAssertTrue(TaskDraft(task: bare).patch(from: bare, tz: "Asia/Tokyo").isEmpty)
        // The words.
        XCTAssertEqual(TaskRules.kindLabel(.deadline), "締切")
    }

    // MARK: the hub's window

    func testTheWindowIsReadOnceAndKeptByTheEvents() async {
        let soon = deadline("原稿", "2099-01-10")
        let api = FakeTaskApi()
        api.deadlines = [soon]
        let hub = TaskHub(api: api, me: { "u-me" }, now: { "2026-10-07T03:00:00Z" })
        await hub.openDeadlines()
        await hub.openDeadlines()
        XCTAssertEqual(api.deadlineCalls, 1)
        XCTAssertEqual(hub.deadlines?.state, .ready)
        XCTAssertEqual(hub.deadlines?.tasks.map(\.title), ["原稿"])
        XCTAssertEqual(hub.find(soon.id)?.title, "原稿")
        // A new deadline comes in, a plain task does not; one due before the 30 days does not either.
        let next = deadline("奨学金", "2099-02-01")
        hub.applyEvent("task.updated", F.updated(next, deleters: []))
        hub.applyEvent("task.updated", F.updated(F.task("ただのタスク", dueOn: "2099-01-01"), deleters: []))
        hub.applyEvent("task.updated", F.updated(deadline("昔", "2026-09-01"), deleters: []))
        XCTAssertEqual(hub.deadlines?.tasks.map(\.title).sorted(), ["原稿", "奨学金"])
        // A deadline that stops being one (or is moved before the window) leaves.
        var turned = next
        turned.kind = .task
        turned.updatedAt = "2026-10-02T00:00:00Z"
        hub.applyEvent("task.updated", F.updated(turned, deleters: []))
        XCTAssertEqual(hub.deadlines?.tasks.map(\.title), ["原稿"])
        // The days come with the event.
        var changed = soon
        changed.noticeDays = [1]
        changed.updatedAt = "2026-10-02T00:00:00Z"
        hub.applyEvent("task.updated", .object(["task": Self.data(changed), "deleter_ids": .array([])]))
        XCTAssertEqual(hub.deadlines?.tasks.first?.noticeDays, [1])
        // My own new deadline joins at once.
        _ = try? await hub.create(TaskDraft.newDeadline(boards: ["c-lab"]).withDue("2099-03-01").create(clientTaskId: "k", tz: "Asia/Tokyo"))
        XCTAssertEqual(hub.deadlines?.tasks.count, 2)
        // Deleted, or the channel left: gone.
        hub.applyEvent("task.deleted", F.deleted(soon.id))
        XCTAssertEqual(hub.deadlines?.tasks.count, 1)
        hub.removeChannel("c-lab")
        XCTAssertEqual(hub.deadlines?.tasks, [])
        XCTAssertFalse(DeadlineRules.inWindow(deadline("x", "2000-01-01")))
        XCTAssertTrue(DeadlineRules.inWindow(deadline("x", "2026-09-07"), now: now))  // 30 days ago
        XCTAssertFalse(DeadlineRules.inWindow(deadline("x", "2026-09-06"), now: now))
        hub.stop()
        XCTAssertNil(hub.deadlines)
    }

    func testAReconnectReadsTheWindowAgain() async {
        let api = FakeTaskApi()
        api.deadlines = [deadline("原稿", "2099-01-10")]
        let hub = TaskHub(api: api, me: { "u-me" })
        hub.online()  // not open: nothing read
        for _ in 0..<10 { await Task.yield() }
        XCTAssertEqual(api.deadlineCalls, 0)
        await hub.openDeadlines()
        api.deadlines = [deadline("原稿", "2099-01-10"), deadline("学振", "2099-04-01")]
        hub.online()
        for _ in 0..<50 where api.deadlineCalls < 2 { await Task.yield() }
        for _ in 0..<10 { await Task.yield() }
        XCTAssertEqual(api.deadlineCalls, 2)
        XCTAssertEqual(hub.deadlines?.tasks.count, 2)
        await hub.reloadDeadlines()
        XCTAssertEqual(api.deadlineCalls, 3)
    }

    func testAnOlderServerLeavesItUnsupportedAndAFailureIsReadAgain() async {
        for status in [404, 422] {
            let api = FakeTaskApi()
            api.deadlinesError = ApiError.api(status: status, code: status == 404 ? "not_found" : "validation_error", message: "x")
            let hub = TaskHub(api: api, me: { "u-me" })
            await hub.openDeadlines()
            XCTAssertEqual(hub.deadlines?.state, .unsupported, "\(status)")
            await hub.openDeadlines()  // kept: not asked again
            XCTAssertEqual(api.deadlineCalls, 1)
        }
        // The default (an api without the call) says 404 too.
        let bare = TaskHub(api: BareTaskApi(), me: { nil })
        await bare.openDeadlines()
        XCTAssertEqual(bare.deadlines?.state, .unsupported)
        // Another failure: failed, and the next screen asks again.
        let api = FakeTaskApi()
        api.deadlinesError = ApiError.api(status: 503, code: "http_503", message: "")
        let hub = TaskHub(api: api, me: { "u-me" })
        await hub.openDeadlines()
        XCTAssertEqual(hub.deadlines?.state, .failed)
        api.deadlinesError = nil
        api.deadlines = [deadline("原稿", "2099-01-10")]
        await hub.openDeadlines()
        XCTAssertEqual(hub.deadlines?.state, .ready)
        XCTAssertEqual(api.deadlineCalls, 2)
    }

    // MARK: decoding, the wire and the error

    func testDecodesTheKindAndTheDaysAndAnOlderServersTask() throws {
        let newer = try JSON.snakeDecoder.decode(TaskOut.self, from: Data("""
        {"id":"t1","channel_id":"c-lab","owner_id":"u1","title":"全国大会 原稿","status":"todo","position":1,"due_on":"2026-10-10",
         "kind":"deadline","notice_days":[7,3,1,0],"created_at":"","updated_at":""}
        """.utf8))
        XCTAssertEqual(newer.kind, .deadline)
        XCTAssertEqual(newer.noticeDays, [7, 3, 1, 0])
        let task = try JSON.snakeDecoder.decode(TaskOut.self, from: Data(#"{"id":"t2","title":"x","kind":"task","notice_days":null}"#.utf8))
        XCTAssertEqual(task.kind, .task)
        XCTAssertNil(task.noticeDays)
        let older = try JSON.snakeDecoder.decode(TaskOut.self, from: Data(TaskWireTests.taskJson.utf8))
        XCTAssertNil(older.noticeDays)
        let odd = try JSON.snakeDecoder.decode(TaskOut.self, from: Data(#"{"id":"t3","title":"x","kind":"later_kind","notice_days":"soon"}"#.utf8))
        XCTAssertEqual(odd.kind, .task)  // an unknown kind still reads as a task (DEADLINES.md §7)
        XCTAssertNil(odd.noticeDays)
        let chip = try JSON.snakeDecoder.decode(MessageTaskOut.self, from: Data(#"{"id":"k1","kind":"deadline","status":"todo"}"#.utf8))
        XCTAssertEqual(chip.kind, .deadline)
    }

    func testTheCallsPathAndBodies() async throws {
        var requests: [(method: String, path: String, body: JSONValue?)] = []
        StubProtocol.handler = { request in
            var body: JSONValue?
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
                body = try? JSONDecoder().decode(JSONValue.self, from: data)
            }
            requests.append((request.httpMethod ?? "", request.url!.path, body))
            if request.url!.path == "/api/v1/tasks/deadlines" { return (200, Data("[\(TaskWireTests.taskJson)]".utf8)) }
            return (200, Data(TaskWireTests.taskJson.utf8))
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        let client = ApiClient(baseUrl: URL(string: "http://server")!, session: URLSession(configuration: configuration))
        client.accessToken = "t"

        let read = try await client.deadlineTasks()
        XCTAssertEqual(read.count, 1)
        XCTAssertEqual(requests.last?.method, "GET")
        XCTAssertEqual(requests.last?.path, "/api/v1/tasks/deadlines")
        var draft = TaskDraft.newDeadline(boards: ["c1"])
        draft.title = "原稿"
        draft.dueOn = "2026-10-20"
        _ = try await client.createTask(draft.create(clientTaskId: "k", tz: "Asia/Tokyo"))
        XCTAssertEqual(requests.last?.body, .object(["title": .string("原稿"), "status": .string("todo"), "client_task_id": .string("k"),
                                                     "tz": .string("Asia/Tokyo"), "channel_id": .string("c1"), "due_on": .string("2026-10-20"),
                                                     "kind": .string("deadline"),
                                                     "notice_days": .array([.number(7), .number(3), .number(1), .number(0)])]))
        _ = try await client.updateTask(id: "t1", TaskPatch(noticeDays: [3, 0]))
        XCTAssertEqual(requests.last?.method, "PATCH")
        XCTAssertEqual(requests.last?.body, .object(["notice_days": .array([.number(3), .number(0)])]))
    }

    func testTheNewErrorCodeHasWords() {
        let text = ErrorMessages.text(for: ApiError.api(status: 400, code: "task_invalid_deadline", message: "English"))
        XCTAssertEqual(text, ErrorMessages.byCode["task_invalid_deadline"])
        XCTAssertNotEqual(text, "English")
    }

    /// task.updated's task with `notice_days` (TaskFixtures.data predates them).
    private static func data(_ task: TaskOut) -> JSONValue {
        guard case .object(var fields) = F.data(task) else { return F.data(task) }
        fields["notice_days"] = task.noticeDays.map { .array($0.map { .number(Double($0)) }) } ?? .null
        return .object(fields)
    }
}

/// An api with only the calls every fake must have: the deadlines call falls back to the protocol's 404.
@MainActor
private final class BareTaskApi: TaskApi {
    private var none: ApiError { ApiError.api(status: 404, code: "not_found", message: "") }
    func listTasks(channelId: String, includeDone: String) async throws -> [TaskOut] { [] }
    func myTasks() async throws -> [TaskOut] { [] }
    func requestedTasks() async throws -> [TaskOut] { [] }
    func dueTasks(from: DayKey, to: DayKey) async throws -> [TaskOut] { [] }
    func task(id: String) async throws -> TaskOut { throw none }
    func createTask(_ body: TaskCreate) async throws -> TaskOut { throw none }
    func updateTask(id: String, _ patch: TaskPatch) async throws -> TaskOut { throw none }
    func moveTask(id: String, _ move: TaskMove) async throws -> TaskOut { throw none }
    func deleteTask(id: String) async throws {}
}

private extension TaskDraft {
    func withDue(_ day: DayKey) -> TaskDraft {
        var out = self
        out.title = "学会"
        out.dueOn = day
        return out
    }
}
