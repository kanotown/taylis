import XCTest
@testable import ChikuwaChat

/// M84 (TASKS.md §11.8): due times, subtasks, repeats and board columns on the phone — decoding (a server before and after
/// M81), the columns and their fallback, the form's request, the card's words. The desktop's tests/taskExtras.test.ts.
@MainActor
final class TaskExtrasTests: XCTestCase {
    private typealias F = TaskFixtures

    override func setUp() { CalendarDates.zoneOverride = TimeZone(identifier: "Asia/Tokyo") }
    override func tearDown() {
        CalendarDates.zoneOverride = nil
        StubProtocol.handler = nil
    }

    private let columns: [TaskColumnOut] = [
        TaskColumnOut(id: "col-todo", channelId: "c-lab", name: "未着手", status: .todo, builtin: true, position: 1),
        TaskColumnOut(id: "col-doing", channelId: "c-lab", name: "進行中", status: .doing, builtin: true, position: 2),
        TaskColumnOut(id: "col-review", channelId: "c-lab", name: "レビュー待ち", status: .doing, builtin: false, position: 2.5),
        TaskColumnOut(id: "col-done", channelId: "c-lab", name: "完了", status: .done, builtin: true, position: 3),
    ]

    private func task(_ title: String, status: TaskStatus = .todo, position: Double? = nil, dueOn: String? = nil, dueAt: String? = nil,
                      rrule: String? = nil, subtasks: [SubtaskOut] = [], columnId: String? = nil) -> TaskOut {
        var out = F.task(title, status: status, position: position, dueOn: dueOn)
        out.dueAt = dueAt
        out.dueTz = dueAt == nil ? nil : "Asia/Tokyo"
        out.rrule = rrule
        out.subtasks = subtasks
        out.columnId = columnId
        return out
    }

    // MARK: decoding

    func testDecodesTheNewFieldsAndAnOlderServersTask() throws {
        let newer = try JSON.snakeDecoder.decode(TaskOut.self, from: Data("""
        {"id":"t1","channel_id":"c-lab","owner_id":"u1","title":"週報","status":"doing","position":1,"due_on":"2030-01-10",
         "due_at":"2030-01-10T05:00:00Z","due_tz":"Asia/Tokyo","rrule":"FREQ=WEEKLY;BYDAY=TH","column_id":"col-review",
         "subtasks":[{"id":"s1","title":"まとめる","done":true},{"id":"s2","title":"送る","done":false},{"title":"id がない"}],
         "created_at":"","updated_at":""}
        """.utf8))
        XCTAssertEqual(newer.dueAt, "2030-01-10T05:00:00Z")
        XCTAssertEqual(newer.dueTz, "Asia/Tokyo")
        XCTAssertEqual(newer.rrule, "FREQ=WEEKLY;BYDAY=TH")
        XCTAssertEqual(newer.columnId, "col-review")
        XCTAssertEqual(newer.subtasks, [SubtaskOut(id: "s1", title: "まとめる", done: true), SubtaskOut(id: "s2", title: "送る")])  // the odd one left out
        XCTAssertEqual(newer.status, .doing)

        // A server before M81: none of them, and the task reads as before.
        let older = try JSON.snakeDecoder.decode(TaskOut.self, from: Data(TaskWireTests.taskJson.utf8))
        XCTAssertNil(older.dueAt)
        XCTAssertNil(older.dueTz)
        XCTAssertNil(older.rrule)
        XCTAssertNil(older.columnId)
        XCTAssertEqual(older.subtasks, [])
        XCTAssertEqual(older.dueOn, "2026-10-05")
        // A broken list is no list.
        let odd = try JSON.snakeDecoder.decode(TaskOut.self, from: Data(#"{"id":"t3","title":"x","subtasks":"nope","due_at":5}"#.utf8))
        XCTAssertEqual(odd.subtasks, [])
        XCTAssertNil(odd.dueAt)

        // The chip's task, persisted with the message and read back.
        let chip = try JSON.snakeDecoder.decode(MessageTaskOut.self, from: Data(#"{"id":"k1","kind":"task","status":"todo","assignee_ids":[],"due_on":"2030-01-10","due_at":"2030-01-10T05:00:00Z","owner_id":"u1"}"#.utf8))
        XCTAssertEqual(chip.dueAt, "2030-01-10T05:00:00Z")
        let again = try JSONDecoder().decode(MessageTaskOut.self, from: JSONEncoder().encode(chip))
        XCTAssertEqual(again, chip)
        XCTAssertNil(try JSON.snakeDecoder.decode(MessageTaskOut.self, from: Data(#"{"id":"k2","status":"todo"}"#.utf8)).dueAt)

        // task.due with and without a time; task.columns.updated.
        let due = try JSONDecoder().decode(JSONValue.self, from: Data(#"{"task_id":"t1","channel_id":null,"channel_name":null,"title":"会議","due_on":"2030-01-10","due_at":"2030-01-10T05:00:00Z","tz":"Asia/Tokyo"}"#.utf8)).decode(TaskDue.self)
        XCTAssertEqual(due.dueAt, "2030-01-10T05:00:00Z")
        XCTAssertEqual(due.tz, "Asia/Tokyo")
        let plain = try JSONDecoder().decode(JSONValue.self, from: Data(#"{"task_id":"t1","channel_id":null,"channel_name":null,"title":"会議","due_on":"2030-01-10"}"#.utf8)).decode(TaskDue.self)
        XCTAssertNil(plain.dueAt)
        let event = try JSONDecoder().decode(JSONValue.self, from: Data("""
        {"channel_id":"c-lab","columns":[{"id":"a","channel_id":"c-lab","name":"未着手","status":"todo","builtin":true,"position":1},
         {"id":"b","channel_id":"c-lab","name":"見送り","status":"done","builtin":false,"position":4}]}
        """.utf8)).decode(TaskColumnsUpdated.self)
        XCTAssertEqual(event.columns.map(\.name), ["未着手", "見送り"])
        XCTAssertEqual(event.columns[1].status, .done)
    }

    // MARK: columns

    func testCardsGoByColumnAndAnUnknownColumnShowsInItsStatussBuiltInOne() {
        let a = task("a", status: .doing)
        let b = task("b", status: .doing, columnId: "col-review")
        let c = task("c", status: .doing, columnId: "col-gone")  // a column deleted meanwhile
        XCTAssertEqual(TaskRules.columnOf(a, columns)?.id, "col-doing")
        XCTAssertEqual(TaskRules.columnOf(b, columns)?.id, "col-review")
        XCTAssertEqual(TaskRules.columnOf(c, columns)?.id, "col-doing")
        XCTAssertEqual(TaskRules.boardColumn([a, b, c], columns[1], columns).map(\.title), ["a", "c"])
        XCTAssertEqual(TaskRules.boardColumn([a, b, c], columns[2], columns).map(\.title), ["b"])
        // Before the server's answer (or from a server before M81) the three built-in ones, ids = statuses.
        XCTAssertTrue(TaskRules.isFallback(TaskRules.fallbackColumns))
        XCTAssertEqual(TaskRules.fallbackColumns.map(\.name), ["未着手", "進行中", "完了"])
        XCTAssertFalse(TaskRules.isFallback(columns))
        XCTAssertEqual(TaskRules.columnOf(b, TaskRules.fallbackColumns)?.id, "doing")
        // The switch: the column chosen, else a status's built-in one, else the first.
        XCTAssertEqual(TaskRules.chosenColumn(columns, "col-review")?.id, "col-review")
        XCTAssertEqual(TaskRules.chosenColumn(columns, "done")?.id, "col-done")
        XCTAssertEqual(TaskRules.chosenColumn(columns, "col-gone")?.id, "col-todo")
        XCTAssertEqual(TaskRules.columnTitle(columns[2], count: 1), "レビュー待ち 1")
        XCTAssertEqual(TaskRules.columnTitle(columns[3], count: 4), "完了")
        XCTAssertEqual(TaskRules.sortColumns(columns.reversed()).map(\.id), columns.map(\.id))
        XCTAssertEqual(TaskRules.deleteColumnMessage(columns, columns[2]), "カードは『進行中』へ移ります")
        XCTAssertEqual(TaskRules.columnNameProblem("  "), "列の名前を入れてください")
        XCTAssertEqual(TaskRules.columnNameProblem(String(repeating: "あ", count: 51)), "列の名前は 50 文字までです")
        XCTAssertNil(TaskRules.columnNameProblem(" レビュー  待ち "))
    }

    func testLeftAndRightNameTheColumnToGoRightOf() {
        XCTAssertEqual(TaskRules.columnMoveTarget(columns, "col-review", -1), .some("col-todo"))
        XCTAssertEqual(TaskRules.columnMoveTarget(columns, "col-review", 1), .some("col-done"))
        XCTAssertEqual(TaskRules.columnMoveTarget(columns, "col-doing", -1), .some(nil))  // the left end
        XCTAssertNil(TaskRules.columnMoveTarget(columns, "col-todo", -1))
        XCTAssertNil(TaskRules.columnMoveTarget(columns, "col-done", 1))
        XCTAssertNil(TaskRules.columnMoveTarget(columns, "col-gone", 1))
        XCTAssertEqual(TaskColumnUpdate(afterId: .some(nil)).json, .object(["after_id": .null]))
        XCTAssertEqual(TaskColumnUpdate(name: "x").json, .object(["name": .string("x")]))
    }

    func testTheOptimisticMoveKeepsTheColumnWhileTheStatusStays() {
        let a = task("a", status: .doing, position: 1, columnId: "col-review")
        let b = task("b", status: .doing, position: 5)
        let same = TaskRules.applyLocalMove([a, b], a.id, .doing, .none)
        XCTAssertEqual(same.first { $0.id == a.id }?.columnId, "col-review")
        let done = TaskRules.applyLocalMove([a, b], a.id, .done, .none)
        XCTAssertNil(done.first { $0.id == a.id }?.columnId)
        let into = TaskRules.applyLocalMove([a, b], b.id, .doing, TaskNeighbors(afterId: a.id, beforeId: nil), columnId: .some("col-review"))
        let moved = into.first { $0.id == b.id }
        XCTAssertEqual(moved?.columnId, "col-review")
        XCTAssertGreaterThan(moved?.position ?? 0, 1)
    }

    // MARK: the hub

    func testABoardReadsItsColumnsAndTheEventReplacesThem() async {
        let api = FakeTaskApi(board: [task("a")])
        api.columns = columns
        let hub = TaskHub(api: api, me: { "u-me" })
        await hub.openBoard("c-lab")
        XCTAssertEqual(hub.board("c-lab")?.columns.map(\.id), ["col-todo", "col-doing", "col-review", "col-done"])
        XCTAssertEqual(hub.board("c-lab")?.columnsSupported, true)
        hub.applyEvent("task.columns.updated", .object(["channel_id": .string("c-lab"), "columns": .array([
            .object(["id": .string("col-done"), "channel_id": .string("c-lab"), "name": .string("済み"), "status": .string("done"),
                     "builtin": .bool(true), "position": .number(3)]),
            .object(["id": .string("col-todo"), "channel_id": .string("c-lab"), "name": .string("未着手"), "status": .string("todo"),
                     "builtin": .bool(true), "position": .number(1)]),
        ])]))
        XCTAssertEqual(hub.board("c-lab")?.columns.map(\.name), ["未着手", "済み"])
        // Another board's event is not this one's.
        hub.applyEvent("task.columns.updated", .object(["channel_id": .string("c-other"), "columns": .array([])]))
        XCTAssertEqual(hub.board("c-lab")?.columns.count, 2)
        // A reconnect reads them again with the cards.
        hub.online()
        for _ in 0..<50 where api.columnCalls.count < 2 { await Task.yield() }
        XCTAssertEqual(api.columnCalls, ["list c-lab", "list c-lab"])
    }

    func testAServerBeforeM81LeavesTheThreeBuiltInColumns() async {
        for error in [ApiError.api(status: 404, code: "not_found", message: "x"), ApiError.api(status: 422, code: "validation_error", message: "x")] {
            let api = FakeTaskApi(board: [task("a")])
            api.columnsError = error
            let hub = TaskHub(api: api, me: { "u-me" })
            await hub.openBoard("c-lab")
            XCTAssertEqual(hub.board("c-lab")?.state, .ready)
            XCTAssertEqual(hub.board("c-lab")?.columnsSupported, false)
            XCTAssertEqual(hub.board("c-lab")?.columns.map(\.id), ["todo", "doing", "done"])
            XCTAssertEqual(hub.board("c-lab")?.tasks.count, 1)
        }
        // Any other failure is the board's.
        let api = FakeTaskApi(board: [task("a")])
        api.columnsError = ApiError.api(status: 503, code: "http_503", message: "")
        let hub = TaskHub(api: api, me: { "u-me" })
        await hub.openBoard("c-lab")
        XCTAssertEqual(hub.board("c-lab")?.state, .failed)
    }

    func testAMoveIntoAColumnSendsItsIdAndAFallbackColumnTheStatus() async throws {
        let a = task("a")
        let api = FakeTaskApi(board: [a])
        let hub = TaskHub(api: api, me: { "u-me" })
        await hub.openBoard("c-lab")
        try await hub.move(a.id, to: .doing, .none, column: columns[2])
        XCTAssertEqual(api.moves.last?.move.json, .object(["column_id": .string("col-review"), "after_id": .null, "before_id": .null]))
        try await hub.move(a.id, to: .done, .none, column: TaskRules.fallbackColumns[2])
        XCTAssertEqual(api.moves.last?.move.json, .object(["status": .string("done"), "after_id": .null, "before_id": .null]))
        // A built-in column the server named: its id (the server takes it too).
        try await hub.move(a.id, to: .todo, .none, column: columns[0])
        XCTAssertEqual(api.moves.last?.move.json, .object(["column_id": .string("col-todo"), "after_id": .null, "before_id": .null]))
    }

    func testAChecklistTickShowsAtOnceAndGoesBackWhenRefused() async throws {
        let a = task("a", subtasks: [SubtaskOut(id: "s1", title: "x")])
        let api = FakeTaskApi(board: [a])
        let hub = TaskHub(api: api, me: { "u-me" })
        await hub.openBoard("c-lab")
        let answer = try await hub.toggleSubtask(a.id, "s1", done: true)
        XCTAssertEqual(answer.subtasks.first?.done, true)
        XCTAssertEqual(hub.find(a.id)?.subtasks.first?.done, true)
        XCTAssertEqual(api.subtaskCalls.last?.patch.json, .object(["done": .bool(true)]))

        api.subtaskError = ApiError.api(status: 409, code: "channel_archived", message: "")
        api.holdMoves = false
        let pending = Task { try await hub.toggleSubtask(a.id, "s1", done: false) }
        await Task.yield()
        do {
            _ = try await pending.value
            XCTFail("refused")
        } catch {}
        XCTAssertEqual(hub.find(a.id)?.subtasks.first?.done, true)  // put back
    }

    func testAddingRenamingAndDeletingAColumnReadTheColumnsAgain() async throws {
        let api = FakeTaskApi()
        api.columns = columns
        let hub = TaskHub(api: api, me: { "u-me" })
        await hub.openBoard("c-lab")
        _ = try await hub.addColumn(TaskColumnCreate(channelId: "c-lab", name: "見送り", status: .done))
        XCTAssertEqual(hub.board("c-lab")?.columns.last?.name, "見送り")
        XCTAssertEqual(api.columnCreates.last?.json, .object(["channel_id": .string("c-lab"), "name": .string("見送り"), "status": .string("done")]))
        try await hub.changeColumn("c-lab", "col-review", TaskColumnUpdate(name: "確認待ち"))
        XCTAssertTrue(hub.board("c-lab")?.columns.contains { $0.name == "確認待ち" } == true)
        try await hub.removeColumn("c-lab", "col-review")
        XCTAssertFalse(hub.board("c-lab")?.columns.contains { $0.id == "col-review" } == true)
        XCTAssertEqual(api.columnCalls.filter { $0.hasPrefix("list") }.count, 4)
    }

    // MARK: the form → the request

    func testTheFormSendsADueTimeWithTheDevicesOffsetDropsItOrMovesTheDate() {
        let plain = task("a", dueOn: "2030-01-10")
        var draft = TaskDraft(task: plain)
        XCTAssertEqual(draft.dueTime, "")
        draft.dueTime = "14:30"
        XCTAssertEqual(draft.patch(from: plain, tz: "Asia/Tokyo"), TaskPatch(tz: "Asia/Tokyo", dueAt: .some("2030-01-10T14:30:00+09:00")))
        XCTAssertEqual(draft.patch(from: plain, tz: "Asia/Tokyo").json, .object(["due_at": .string("2030-01-10T14:30:00+09:00"), "tz": .string("Asia/Tokyo")]))

        let timed = task("b", dueOn: "2030-01-10", dueAt: "2030-01-10T05:30:00Z")
        let same = TaskDraft(task: timed)
        XCTAssertEqual(same.dueOn, "2030-01-10")
        XCTAssertEqual(same.dueTime, "14:30")
        XCTAssertTrue(same.patch(from: timed, tz: "Asia/Tokyo").isEmpty)
        var noTime = same
        noTime.dueTime = ""
        XCTAssertEqual(noTime.patch(from: timed, tz: "Asia/Tokyo").json, .object(["due_at": .null]))
        var moved = same
        moved.dueOn = "2030-01-11"
        XCTAssertEqual(moved.patch(from: timed, tz: "Asia/Tokyo").json, .object(["due_at": .string("2030-01-11T14:30:00+09:00"), "tz": .string("Asia/Tokyo")]))
        var cleared = same
        cleared.clearDue()
        XCTAssertEqual(cleared.patch(from: timed, tz: "Asia/Tokyo").json, .object(["due_on": .null, "tz": .string("Asia/Tokyo")]))
    }

    func testCreatingSendsTheRuleTheTimeAndTheChecklist() {
        var draft = TaskDraft(title: "週報", channelId: "c-lab")
        draft.dueOn = "2030-01-07"
        draft.dueTime = "09:00"
        draft.repetition = CalendarRecurrence.noRepeat("2030-01-07")
        draft.repetition.kind = .weekly
        draft.subtasks = [SubtaskDraft(title: " まとめる "), SubtaskDraft(title: "  ")]
        let body = draft.create(clientTaskId: "k", tz: "Asia/Tokyo")
        XCTAssertEqual(body.dueOn, "2030-01-07")
        XCTAssertEqual(body.dueAt, "2030-01-07T09:00:00+09:00")
        XCTAssertEqual(body.rrule, "FREQ=WEEKLY;BYDAY=MO")
        XCTAssertEqual(body.subtasks, [SubtaskIn(id: nil, title: "まとめる", done: false)])  // blank ones left out
        guard case .object(let fields) = body.json else { return XCTFail("an object") }
        XCTAssertEqual(fields["due_at"], .string("2030-01-07T09:00:00+09:00"))
        XCTAssertEqual(fields["rrule"], .string("FREQ=WEEKLY;BYDAY=MO"))
        XCTAssertEqual(fields["subtasks"], .array([.object(["title": .string("まとめる"), "done": .bool(false)])]))
        // Nothing new: nothing new sent (a server before M81 reads the body as before).
        guard case .object(let bare) = TaskDraft(title: "x").create(clientTaskId: "k", tz: "Asia/Tokyo").json else { return XCTFail("an object") }
        XCTAssertNil(bare["due_at"])
        XCTAssertNil(bare["rrule"])
        XCTAssertNil(bare["subtasks"])
        // A repeat needs a due date; a review request never repeats.
        var noDue = draft
        noDue.dueOn = ""
        XCTAssertEqual(noDue.problem, "繰り返すには期限を入れてください")
        var review = draft
        review.kind = .review
        XCTAssertNil(review.create(clientTaskId: "k", tz: "Asia/Tokyo").rrule)
        var many = TaskDraft(title: "x")
        many.subtasks = (0...TaskRules.maxSubtasks).map { SubtaskDraft(title: "\($0)") }
        XCTAssertEqual(many.problem, "サブタスクは 50 個までです")
    }

    func testTheRuleAndTheChecklistArePatchedOnlyWhenTheyChanged() {
        let t = task("a", dueOn: "2030-01-07", rrule: "FREQ=WEEKLY", subtasks: [SubtaskOut(id: "s1", title: "x")])
        let draft = TaskDraft(task: t)
        XCTAssertTrue(draft.patch(from: t, tz: "Asia/Tokyo").isEmpty)  // FREQ=WEEKLY reads as BYDAY=MO and compares alike
        var stop = draft
        stop.repetition.kind = .none
        XCTAssertEqual(stop.patch(from: t, tz: "Asia/Tokyo").json, .object(["rrule": .null]))
        var daily = draft
        daily.repetition.kind = .daily
        XCTAssertEqual(daily.patch(from: t, tz: "Asia/Tokyo").json, .object(["rrule": .string("FREQ=DAILY")]))
        var more = draft
        more.subtasks.append(SubtaskDraft(title: "y", done: true))
        XCTAssertEqual(more.patch(from: t, tz: "Asia/Tokyo").json, .object(["subtasks": .array([
            .object(["id": .string("s1"), "title": .string("x"), "done": .bool(false)]),
            .object(["title": .string("y"), "done": .bool(true)]),
        ])]))
        var reordered = more
        reordered.subtasks.swapAt(0, 1)
        XCTAssertEqual(reordered.patch(from: t, tz: "Asia/Tokyo").subtasks?.map(\.title), ["y", "x"])
        var none = draft
        none.subtasks = []
        XCTAssertEqual(none.patch(from: t, tz: "Asia/Tokyo").json, .object(["subtasks": .array([])]))
        // Dropping the due date of a repeating task stops it too (the server refuses a rule without a date).
        var dropped = draft
        dropped.clearDue()
        XCTAssertEqual(dropped.patch(from: t, tz: "Asia/Tokyo").json, .object(["due_on": .null, "tz": .string("Asia/Tokyo"), "rrule": .null]))
        // The one-item PATCH's body.
        XCTAssertEqual(SubtaskUpdate(done: false).json, .object(["done": .bool(false)]))
    }

    // MARK: the card's words

    func testTheCardTheChipTheCalendarAndTheNoticeShowTheTime() {
        let timed = task("会議", dueOn: "2030-01-10", dueAt: "2030-01-10T05:00:00Z")
        XCTAssertEqual(TaskRules.dueLabel(timed, today: "2030-01-10"), "今日 14:00")
        XCTAssertEqual(TaskRules.dueLabel(timed, today: "2030-01-01"), "1/10 14:00")
        XCTAssertEqual(TaskRules.dueLabel(timed, today: "2029-12-01"), "2030/1/10 14:00")
        XCTAssertEqual(TaskRules.dueLabel(task("x", dueOn: "2030-01-10"), today: "2030-01-01"), "1/10")
        XCTAssertNil(TaskRules.dueLabel(task("x"), today: "2030-01-01"))
        XCTAssertEqual(TaskRules.dueText(timed.dueOn, today: "2030-01-10", dueAt: timed.dueAt), "2030/01/10 14:00（今日）")
        // Late once the time has passed (a date only once its day is over).
        let iso = ISO8601DateFormatter()
        XCTAssertFalse(TaskRules.isOverdue(timed, today: "2030-01-10", now: iso.date(from: "2030-01-10T04:59:00Z")!))
        XCTAssertTrue(TaskRules.isOverdue(timed, today: "2030-01-10", now: iso.date(from: "2030-01-10T05:01:00Z")!))
        XCTAssertFalse(TaskRules.isOverdue(task("提出", dueOn: "2030-01-10"), today: "2030-01-10", now: iso.date(from: "2030-01-10T14:00:00Z")!))
        // The calendar's day: the whole-day ones first, then by time; 「☐ 14:00 題名」.
        let day = task("提出", dueOn: "2030-01-10")
        let early = task("朝会", dueOn: "2030-01-10", dueAt: "2030-01-10T00:30:00Z")
        XCTAssertEqual(TaskRules.tasksForDay([timed, day, early], "2030-01-10").map(\.title), ["提出", "朝会", "会議"])
        XCTAssertEqual(CalendarTaskRow.time(timed), "14:00 ")
        XCTAssertEqual(CalendarTaskRow.time(day), "")
        // The chip under a message.
        let chip = TaskRules.chip(MessageTaskOut(id: "k", status: .todo, dueOn: "2030-01-10", ownerId: "u", dueAt: timed.dueAt), names: [], today: "2030-01-01",
                                  now: iso.date(from: "2030-01-01T00:00:00Z")!)
        XCTAssertEqual(chip, TaskRules.Chip(text: "タスク · 未着手 · 1/10 14:00 まで", tone: .open))
        let late = TaskRules.chip(MessageTaskOut(id: "k", status: .todo, dueOn: "2030-01-10", ownerId: "u", dueAt: timed.dueAt), names: [], today: "2030-01-10",
                                  now: iso.date(from: "2030-01-10T06:00:00Z")!)
        XCTAssertEqual(late, TaskRules.Chip(text: "タスク · 未着手 · 今日 14:00 まで", tone: .overdue))
        XCTAssertEqual(TaskRules.chip(MessageTaskOut(id: "k", dueOn: "2030-01-10"), names: [], today: "2030-01-10").text, "タスク · 未着手 · 今日まで")
        // The open app's notice.
        XCTAssertEqual(TaskRules.noticeText(due: TaskDue(taskId: "t", channelId: nil, channelName: nil, title: "会議", dueOn: "2030-01-10",
                                                         dueAt: "2030-01-10T05:00:00Z", tz: "Asia/Tokyo")), "14:00 が期限：会議")
        XCTAssertEqual(TaskRules.noticeText(due: TaskDue(taskId: "t", channelId: "c", channelName: "lab", title: "会議", dueOn: "2030-01-10")),
                       "今日が期限：会議 (#lab)")
    }

    func testTheChecklistsProgress() {
        let t = task("a", subtasks: [SubtaskOut(id: "s1", title: "x", done: true), SubtaskOut(id: "s2", title: "y")])
        XCTAssertEqual(TaskRules.subtaskText(t), "☑ 1/2")
        XCTAssertEqual(TaskRules.subtaskProgress(t)?.done, 1)
        XCTAssertNil(TaskRules.subtaskText(task("none")))
        XCTAssertEqual(TaskRules.subtaskText(TaskRules.withSubtask(t, "s2", done: true)), "☑ 2/2")
    }

    // MARK: the wire and the words of the new errors

    func testTheNewCallsPathsAndBodies() async throws {
        var requests: [(method: String, path: String, query: String?, body: JSONValue?)] = []
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
            requests.append((request.httpMethod ?? "", request.url!.path, request.url!.query, body))
            if request.httpMethod == "DELETE" { return (204, Data()) }
            let column = #"{"id":"col-1","channel_id":"c1","name":"レビュー待ち","status":"doing","builtin":false,"position":2.5}"#
            if request.url!.path == "/api/v1/tasks/columns" && request.httpMethod == "GET" { return (200, Data("[\(column)]".utf8)) }
            if request.url!.path.hasPrefix("/api/v1/tasks/columns") { return (200, Data(column.utf8)) }
            return (200, Data(TaskWireTests.taskJson.utf8))
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        let client = ApiClient(baseUrl: URL(string: "http://server")!, session: URLSession(configuration: configuration))
        client.accessToken = "t"

        let read = try await client.listTaskColumns(channelId: "c1")
        XCTAssertEqual(read.map(\.name), ["レビュー待ち"])
        XCTAssertEqual(requests.last?.path, "/api/v1/tasks/columns")
        XCTAssertEqual(requests.last?.query, "channel_id=c1")
        _ = try await client.createTaskColumn(TaskColumnCreate(channelId: "c1", name: "見送り", status: .done, afterId: "col-1"))
        XCTAssertEqual(requests.last?.method, "POST")
        XCTAssertEqual(requests.last?.body, .object(["channel_id": .string("c1"), "name": .string("見送り"), "status": .string("done"), "after_id": .string("col-1")]))
        _ = try await client.updateTaskColumn(id: "col-1", TaskColumnUpdate(afterId: .some(nil)))
        XCTAssertEqual(requests.last?.method, "PATCH")
        XCTAssertEqual(requests.last?.path, "/api/v1/tasks/columns/col-1")
        XCTAssertEqual(requests.last?.body, .object(["after_id": .null]))
        try await client.deleteTaskColumn(id: "col-1")
        XCTAssertEqual(requests.last?.method, "DELETE")
        XCTAssertEqual(requests.last?.path, "/api/v1/tasks/columns/col-1")
        _ = try await client.updateSubtask(taskId: "t1", subtaskId: "s1", SubtaskUpdate(done: true))
        XCTAssertEqual(requests.last?.method, "PATCH")
        XCTAssertEqual(requests.last?.path, "/api/v1/tasks/t1/subtasks/s1")
        XCTAssertEqual(requests.last?.body, .object(["done": .bool(true)]))
        _ = try await client.moveTask(id: "t1", TaskMove(status: nil, neighbors: .none, columnId: "col-1"))
        XCTAssertEqual(requests.last?.body, .object(["column_id": .string("col-1"), "after_id": .null, "before_id": .null]))
    }

    func testTheNewErrorCodesHaveWords() {
        for code in ["task_invalid_rrule", "task_invalid_column", "task_subtask_not_found", "task_column_not_found", "task_column_builtin", "task_column_limit"] {
            let text = ErrorMessages.text(for: ApiError.api(status: 400, code: code, message: "English"))
            XCTAssertEqual(text, ErrorMessages.byCode[code], code)
            XCTAssertNotEqual(text, "English", code)
        }
        XCTAssertEqual(ErrorMessages.text(for: ApiError.api(status: 409, code: "task_column_builtin", message: "")),
                       "最初からある 3 つの列（未着手・進行中・完了）は削除できません")
    }
}
