import XCTest
@testable import ChikuwaChat

/// M56: tasks for the tests, shaped like the server's TaskOut (the web's tests/taskFixtures.ts).
@MainActor
enum TaskFixtures {
    nonisolated(unsafe) static var n = 0

    static func task(_ title: String, id: String? = nil, channelId: String? = "c-lab", channelName: String? = "lab", ownerId: String = "u-me",
                     notes: String? = nil, status: TaskStatus = .todo, position: Double? = nil, dueOn: String? = nil, assigneeIds: [String] = [],
                     source: TaskSourceOut? = nil, completedAt: String? = nil, updatedAt: String = "2026-10-01T00:00:00Z",
                     canDelete: Bool = true) -> TaskOut {
        n += 1
        return TaskOut(id: id ?? String(format: "t%03d", n), channelId: channelId, channelName: channelId == nil ? nil : channelName, ownerId: ownerId,
                       title: title, notes: notes, status: status, position: position ?? Double(n), dueOn: dueOn, assigneeIds: assigneeIds,
                       source: source, completedAt: completedAt, completedBy: nil, createdAt: "2026-10-01T00:00:00Z", updatedAt: updatedAt,
                       canDelete: canDelete)
    }

    /// The task as task.updated carries it (no can_delete, TASKS.md §8 4.).
    static func data(_ task: TaskOut) -> JSONValue {
        func text(_ value: String?) -> JSONValue { value.map(JSONValue.string) ?? .null }
        let source: JSONValue = task.source.map {
            .object(["message_id": text($0.messageId), "channel_id": text($0.channelId), "excerpt": text($0.excerpt)])
        } ?? .null
        return .object([
            "id": .string(task.id), "channel_id": text(task.channelId), "channel_name": text(task.channelName), "owner_id": .string(task.ownerId),
            "title": .string(task.title), "notes": text(task.notes), "status": .string(task.status.rawValue), "position": .number(task.position),
            "due_on": text(task.dueOn), "assignee_ids": .array(task.assigneeIds.map(JSONValue.string)), "source": source,
            "completed_at": text(task.completedAt), "completed_by": text(task.completedBy), "created_at": .string(task.createdAt),
            "updated_at": .string(task.updatedAt),
        ])
    }

    static func updated(_ task: TaskOut, deleters: [String]) -> JSONValue {
        .object(["task": data(task), "deleter_ids": .array(deleters.map(JSONValue.string))])
    }

    static func deleted(_ id: String, channelId: String? = "c-lab") -> JSONValue {
        .object(["id": .string(id), "channel_id": channelId.map(JSONValue.string) ?? .null])
    }
}

/// The task calls, over rows the test sets.
@MainActor
final class FakeTaskApi: TaskApi {
    var board: [TaskOut]
    var mine: [TaskOut]
    var due: [TaskOut]
    var listError: Error?
    var moveError: Error?
    /// Holds the answer to a move until the test lets it go.
    var moveGate: CheckedContinuation<Void, Never>?
    var holdMoves = false
    private(set) var listCalls: [(channelId: String, includeDone: String)] = []
    private(set) var mineCalls = 0
    private(set) var dueCalls: [(from: String, to: String)] = []
    private(set) var creates: [TaskCreate] = []
    private(set) var patches: [(id: String, patch: TaskPatch)] = []
    private(set) var moves: [(id: String, move: TaskMove)] = []
    private(set) var deletes: [String] = []
    var moveAnswer: ((TaskOut, TaskMove) -> TaskOut)?

    init(board: [TaskOut] = [], mine: [TaskOut] = [], due: [TaskOut] = []) {
        self.board = board
        self.mine = mine
        self.due = due
    }

    func listTasks(channelId: String, includeDone: String) async throws -> [TaskOut] {
        listCalls.append((channelId, includeDone))
        if let listError { throw listError }
        return board.filter { $0.channelId == channelId }
    }

    func myTasks() async throws -> [TaskOut] {
        mineCalls += 1
        return mine
    }

    func dueTasks(from: DayKey, to: DayKey) async throws -> [TaskOut] {
        dueCalls.append((from, to))
        return due.filter { TaskRules.dueInRange($0, from: from, to: to) }
    }

    func task(id: String) async throws -> TaskOut {
        guard let row = (board + mine + due).first(where: { $0.id == id }) else { throw ApiError.api(status: 404, code: "task_not_found", message: "") }
        return row
    }

    func createTask(_ body: TaskCreate) async throws -> TaskOut {
        creates.append(body)
        let task = TaskFixtures.task(body.title, id: "new-\(creates.count)", channelId: body.channelId, status: body.status, dueOn: body.dueOn,
                                     assigneeIds: body.assigneeIds)
        if body.channelId != nil { board.append(task) } else { mine.append(task) }
        return task
    }

    func updateTask(id: String, _ patch: TaskPatch) async throws -> TaskOut {
        patches.append((id, patch))
        var task = try await self.task(id: id)
        if let status = patch.status { task.status = status }
        if let title = patch.title { task.title = title }
        task.updatedAt = "2026-10-01T09:00:00Z"
        return task
    }

    func moveTask(id: String, _ move: TaskMove) async throws -> TaskOut {
        moves.append((id, move))
        if holdMoves { await withCheckedContinuation { moveGate = $0 } }
        if let moveError { throw moveError }
        let task = try await self.task(id: id)
        if let moveAnswer { return moveAnswer(task, move) }
        var moved = task
        moved.status = move.status
        moved.updatedAt = "2026-10-01T05:00:00Z"
        return moved
    }

    func deleteTask(id: String) async throws {
        deletes.append(id)
    }
}

private func ids(_ list: [TaskOut]) -> [String] { list.map(\.id) }

/// The pure rules (UI/TaskRules.swift): the web's tests/tasks.test.ts.
@MainActor
final class TaskRulesTests: XCTestCase {
    private typealias F = TaskFixtures

    func testAColumnsOrderIsTheServersPositionThenId() {
        let a = F.task("a", id: "b-id", position: 2)
        let b = F.task("b", position: 1)
        let c = F.task("c", id: "a-id", position: 2)
        let d = F.task("d", status: .done, position: 0)
        XCTAssertEqual(ids(TaskRules.column([a, b, c, d], .todo)), [b.id, "a-id", "b-id"])
        XCTAssertEqual(ids(TaskRules.column([a, b, c, d], .done)), [d.id])
    }

    func testWhereAMovedCardLands() {
        let column = [F.task("1"), F.task("2"), F.task("3")]
        let (one, two, three) = (column[0], column[1], column[2])
        // From another column: top, middle, bottom; an empty column: neither.
        XCTAssertEqual(TaskRules.neighbors(column, moving: "x", to: 0), TaskNeighbors(afterId: nil, beforeId: one.id))
        XCTAssertEqual(TaskRules.neighbors(column, moving: "x", to: 1), TaskNeighbors(afterId: one.id, beforeId: two.id))
        XCTAssertEqual(TaskRules.neighbors(column, moving: "x", to: 3), TaskNeighbors(afterId: three.id, beforeId: nil))
        XCTAssertEqual(TaskRules.neighbors([], moving: "x", to: 0), .none)
        // Within its column: the card itself is not a neighbour.
        XCTAssertEqual(TaskRules.neighbors(column, moving: one.id, to: 2), TaskNeighbors(afterId: two.id, beforeId: three.id))
        XCTAssertEqual(TaskRules.neighbors(column, moving: three.id, to: 0), TaskNeighbors(afterId: nil, beforeId: one.id))
        XCTAssertEqual(TaskRules.neighbors(column, moving: one.id, to: 3), TaskNeighbors(afterId: three.id, beforeId: nil))
        // 上へ / 下へ: one place, nothing past the ends.
        XCTAssertEqual(TaskRules.moveWithin(column, two.id, -1), TaskNeighbors(afterId: nil, beforeId: one.id))
        XCTAssertEqual(TaskRules.moveWithin(column, two.id, 1), TaskNeighbors(afterId: three.id, beforeId: nil))
        XCTAssertEqual(TaskRules.moveWithin(column, one.id, 1), TaskNeighbors(afterId: two.id, beforeId: three.id))
        XCTAssertNil(TaskRules.moveWithin(column, one.id, -1))
        XCTAssertNil(TaskRules.moveWithin(column, three.id, 1))
        XCTAssertNil(TaskRules.moveWithin(column, "gone", 1))
    }

    func testTheOptimisticMoveGuessesAPlaceAndSetsCompletion() {
        let a = F.task("a", position: 1)
        let b = F.task("b", position: 2)
        let c = F.task("c", status: .doing, position: 3)
        let d = F.task("d", status: .done, position: 5)
        let all = [a, b, c, d]
        let between = TaskRules.applyLocalMove(all, c.id, .todo, TaskNeighbors(afterId: a.id, beforeId: b.id))
        XCTAssertEqual(ids(TaskRules.column(between, .todo)), [a.id, c.id, b.id])
        XCTAssertEqual(between.first { $0.id == c.id }?.status, .todo)
        let top = TaskRules.applyLocalMove(all, b.id, .todo, TaskNeighbors(afterId: nil, beforeId: a.id))
        XCTAssertEqual(ids(TaskRules.column(top, .todo)), [b.id, a.id])
        let bottom = TaskRules.applyLocalMove(all, a.id, .doing, .none)
        XCTAssertEqual(ids(TaskRules.column(bottom, .doing)), [c.id, a.id])
        let done = TaskRules.applyLocalMove(all, a.id, .done, .none, now: "2026-10-01T03:00:00Z", me: "u-me")
        XCTAssertEqual(ids(TaskRules.column(done, .done)), [a.id, d.id]) // the newest completed on top
        XCTAssertEqual(done.first { $0.id == a.id }?.completedAt, "2026-10-01T03:00:00Z")
        XCTAssertEqual(done.first { $0.id == a.id }?.completedBy, "u-me")
        let back = TaskRules.applyLocalMove(done, d.id, .todo, TaskNeighbors(afterId: b.id, beforeId: nil))
        XCTAssertEqual(back.first { $0.id == d.id }?.status, .todo)
        XCTAssertNil(back.first { $0.id == d.id }?.completedAt)
        XCTAssertNil(back.first { $0.id == d.id }?.completedBy)
        XCTAssertEqual(ids(TaskRules.column(back, .todo)), [b.id, d.id])
        // Past the one given, with a card after it: between them.
        XCTAssertEqual(TaskRules.guessPosition(all, c.id, .todo, TaskNeighbors(afterId: a.id, beforeId: nil)), 1.5)
        XCTAssertEqual(TaskRules.guessPosition([], "x", .todo, .none), 0)
    }

    func testEventsReplaceAddAndRemoveAndCanDeleteIsDeleterIdsHoldingMe() {
        let a = F.task("a")
        var renamed = a
        renamed.title = "A"
        let list = TaskRules.upsert([a], renamed)
        XCTAssertEqual(list.map(\.title), ["A"])
        XCTAssertEqual(TaskRules.upsert(list, F.task("b")).count, 2)
        XCTAssertEqual(TaskRules.remove(list, a.id), [])
        XCTAssertTrue(TaskRules.fromEvent(F.task("x", canDelete: false), deleterIds: ["u-me"], me: "u-me").canDelete)
        XCTAssertFalse(TaskRules.fromEvent(F.task("x"), deleterIds: ["u-other"], me: "u-me").canDelete)
        XCTAssertFalse(TaskRules.fromEvent(F.task("x"), deleterIds: ["u-me"], me: nil).canDelete)
        // 「自分のタスク」 holds personal ones and those assigned to me.
        XCTAssertTrue(TaskRules.isMine(F.task("p", channelId: nil), me: "u-me"))
        XCTAssertTrue(TaskRules.isMine(F.task("s", assigneeIds: ["u-me"]), me: "u-me"))
        XCTAssertFalse(TaskRules.isMine(F.task("s", assigneeIds: ["u-other"]), me: "u-me"))
    }

    func testDueDates() {
        XCTAssertTrue(TaskRules.isOverdue(F.task("a", dueOn: "2026-09-30"), today: "2026-10-01"))
        XCTAssertFalse(TaskRules.isOverdue(F.task("a", status: .done, dueOn: "2026-09-30"), today: "2026-10-01"))
        XCTAssertFalse(TaskRules.isOverdue(F.task("a", dueOn: "2026-10-01"), today: "2026-10-01"))
        XCTAssertFalse(TaskRules.isOverdue(F.task("a"), today: "2026-10-01"))
        XCTAssertEqual(TaskRules.dueLabel("2026-10-01", today: "2026-10-01"), "今日")
        XCTAssertEqual(TaskRules.dueLabel("2026-10-05", today: "2026-10-01"), "10/5")
        XCTAssertEqual(TaskRules.dueLabel("2027-01-05", today: "2026-10-01"), "2027/1/5")
        XCTAssertEqual(TaskRules.dueText("2026-10-01", today: "2026-10-01"), "2026/10/01 (今日)")
        XCTAssertEqual(TaskRules.dueText(nil, today: "2026-10-01"), "なし")
        // A day's tasks: open ones first, then by title.
        let a = F.task("b-open", dueOn: "2026-10-05")
        let b = F.task("a-done", status: .done, dueOn: "2026-10-05")
        let c = F.task("c", dueOn: "2026-10-06")
        let d = F.task("a-open", dueOn: "2026-10-05")
        XCTAssertEqual(ids(TaskRules.tasksForDay([b, a, c, d], "2026-10-05")), [d.id, a.id, b.id])
        // The calendar's window: [from, to).
        XCTAssertTrue(TaskRules.dueInRange(a, from: "2026-10-05", to: "2026-10-06"))
        XCTAssertFalse(TaskRules.dueInRange(c, from: "2026-10-05", to: "2026-10-06"))
        XCTAssertFalse(TaskRules.dueInRange(F.task("none"), from: "2026-10-01", to: "2026-12-01"))
    }

    private func store() -> Store {
        let store = Store()
        func add(_ id: String, type: String = "public", policy: String? = nil, archived: Bool = false, role: String? = "member", member: Bool = true) {
            var out = ChannelOut(id: id, type: type, name: id, topic: nil, purpose: nil, archived: archived, createdBy: nil, lastSeq: 0, lastMessageAt: nil,
                                 createdAt: "", updatedAt: "", membership: role.map { MembershipOut(role: $0, joinedAt: "") }, dmUserIds: nil)
            out.postingPolicy = policy
            store.upsertChannel(out, isMember: member)
        }
        add("lab")
        add("secret", type: "private")
        add("news", policy: "owners")
        add("own", policy: "owners", role: "owner")
        add("old", archived: true)
        add("dm", type: "dm", role: nil)
        add("group", type: "group_dm", role: nil)
        add("other", role: nil, member: false)
        return store
    }

    func testWhoMayEditABoardIsTheComposersRule() {
        let store = store()
        func can(_ id: String, admin: Bool = false) -> Bool { TaskRules.canEditBoard(store.channel(id), isAdmin: admin) }
        XCTAssertEqual(["lab", "secret", "news", "own", "old", "dm", "group", "other", "gone"].map { can($0) },
                       [true, true, false, true, false, false, false, false, false])
        XCTAssertTrue(can("news", admin: true))
        XCTAssertTrue(TaskRules.canEditTask(F.task("p", channelId: nil), channel: nil, isAdmin: false)) // a personal task is always mine
        XCTAssertFalse(TaskRules.canEditTask(F.task("s", channelId: "news"), channel: store.channel("news"), isAdmin: false))
        // Boards and the 「タスク」 tab: public and private channels only.
        XCTAssertEqual(["lab", "secret", "dm", "group"].map { TaskRules.hasBoard(store.channel($0)!) }, [true, true, false, false])
        XCTAssertEqual(ChannelTab.tabs(for: store.channel("lab")!), [.messages, .canvas, .events, .tasks, .pins, .files])
        XCTAssertEqual(ChannelTab.tabs(for: store.channel("dm")!), [.messages, .canvas, .pins, .files])
        XCTAssertEqual(ChannelTab.tasks.title, "タスク")
        // The banner over a board I may not change, or could not read.
        XCTAssertNil(TaskRules.boardNote(.ready, channel: store.channel("lab")!, canEdit: true))
        XCTAssertEqual(TaskRules.boardNote(.ready, channel: store.channel("news")!, canEdit: false), "このボードを変更できるのは、チャンネルのオーナーと管理者だけです")
        XCTAssertEqual(TaskRules.boardNote(.ready, channel: store.channel("old")!, canEdit: false), "アーカイブされたチャンネルのタスクは変更できません")
        XCTAssertEqual(TaskRules.boardNote(.unsupported, channel: store.channel("lab")!, canEdit: true), "このサーバはタスクに対応していません")
    }

    func testMyTasksGroupsAndOrder() {
        let p1 = F.task("p1", channelId: nil, status: .doing, position: 1)
        let p2 = F.task("p2", channelId: nil, status: .todo, position: 9)
        let p3 = F.task("p3", channelId: nil, status: .done, completedAt: "2026-09-01T00:00:00Z")
        let p4 = F.task("p4", channelId: nil, status: .done, completedAt: "2026-09-20T00:00:00Z")
        let s1 = F.task("s1", channelId: "c-zoo", channelName: "zoo", assigneeIds: ["u-me"])
        let s2 = F.task("s2", channelId: "c-lab", channelName: "lab", assigneeIds: ["u-me", "u-other"])
        let s3 = F.task("s3", channelId: "c-lab", channelName: "lab", assigneeIds: ["u-other"])
        let mine = TaskRules.groupMine([s1, p1, s2, p2, s3, p3, p4], me: "u-me")
        XCTAssertEqual(ids(mine.personal), [p1.id, p2.id, p3.id, p4.id])
        XCTAssertEqual(mine.groups.map(\.channelName), ["lab", "zoo"])
        XCTAssertEqual(mine.groups.map { ids($0.tasks) }, [[s2.id], [s1.id]])
        // The store's name wins over the task's.
        XCTAssertEqual(TaskRules.groupMine([s1], me: "u-me") { $0 == "c-zoo" ? "動物園" : nil }.groups.first?.channelName, "動物園")
        let split = TaskRules.splitOpenDone(mine.personal)
        XCTAssertEqual(ids(split.open), [p2.id, p1.id])
        XCTAssertEqual(ids(split.done), [p4.id, p3.id])
    }

    func testTheFormSendsOnlyWhatChanged() {
        let t = F.task("資料", notes: "メモ", dueOn: "2026-10-05", assigneeIds: ["u-a"])
        let draft = TaskDraft(task: t)
        XCTAssertTrue(draft.patch(from: t, tz: "Asia/Tokyo").isEmpty)
        var edited = draft
        edited.title = "  資料  を\n作る "
        XCTAssertEqual(edited.patch(from: t, tz: "Asia/Tokyo"), TaskPatch(title: "資料 を 作る"))
        edited = draft
        edited.notes = "  "
        XCTAssertEqual(edited.patch(from: t, tz: "Asia/Tokyo"), TaskPatch(notes: .some(nil)))
        edited = draft
        edited.dueOn = ""
        XCTAssertEqual(edited.patch(from: t, tz: "Asia/Tokyo"), TaskPatch(dueOn: .some(nil), tz: "Asia/Tokyo"))
        edited = draft
        edited.status = .done
        edited.assigneeIds = ["u-b", "u-a", "u-b"]
        XCTAssertEqual(edited.patch(from: t, tz: "Asia/Tokyo"), TaskPatch(status: .done, assigneeIds: ["u-a", "u-b"]))
        // A personal task has no assignees to send.
        let p = F.task("p", channelId: nil)
        var personal = TaskDraft(task: p)
        personal.assigneeIds = ["u-a"]
        XCTAssertTrue(personal.patch(from: p, tz: "Asia/Tokyo").isEmpty)
        // What stops a save.
        edited = draft
        edited.title = "   "
        XCTAssertEqual(edited.problem, "題名を入れてください")
        edited.title = String(repeating: "あ", count: 201)
        XCTAssertEqual(edited.problem, "題名は 200 文字までです")
        edited.title = "ok"
        edited.notes = String(repeating: "x", count: 4001)
        XCTAssertEqual(edited.problem, "メモは 4000 文字までです")
        XCTAssertNil(draft.problem)
        // A new one: the title cleaned, empty notes left out, assignees only on a board (once each).
        var new = TaskDraft(title: " 発表  準備 ", channelId: "c-lab")
        new.assigneeIds = ["u-a", "u-a", "u-b"]
        new.dueOn = "2026-10-10"
        let body = new.create(clientTaskId: "k1", tz: "Asia/Tokyo")
        XCTAssertEqual(body.title, "発表 準備")
        XCTAssertNil(body.notes)
        XCTAssertEqual(body.assigneeIds, ["u-a", "u-b"])
        XCTAssertEqual(body.json["assignee_ids"], .array([.string("u-a"), .string("u-b")]))
        XCTAssertEqual(body.json["due_on"], .string("2026-10-10"))
        XCTAssertEqual(body.json["client_task_id"], .string("k1"))
        XCTAssertNil(body.json["notes"])
        new.channelId = nil
        XCTAssertNil(new.create(clientTaskId: "k2", tz: "Asia/Tokyo").json["assignee_ids"])
        XCTAssertNil(new.create(clientTaskId: "k2", tz: "Asia/Tokyo").json["channel_id"])
    }

    func testTheSourceIsALinkWhileTheMessageExists() {
        XCTAssertEqual(TaskRules.sourceState(nil), .none)
        XCTAssertEqual(TaskRules.sourceState(TaskSourceOut(messageId: "m1", channelId: "c-lab", excerpt: "抜粋")), .link(messageId: "m1", excerpt: "抜粋"))
        XCTAssertEqual(TaskRules.sourceState(TaskSourceOut(messageId: "m1", channelId: "c-lab", excerpt: nil)), .link(messageId: "m1", excerpt: nil))
        XCTAssertEqual(TaskRules.sourceState(TaskSourceOut(messageId: nil, channelId: "c-lab", excerpt: nil)), .deleted)
    }

    func testMakingATaskFromAMessage() {
        let store = store()
        let bob = "0b0b0b0b-0000-4000-8000-000000000001"
        let users = [bob: UserPublic(id: bob, username: "bob", displayName: "ボブ", role: "member", deactivatedAt: nil, createdAt: "", updatedAt: "")]
        func message(_ body: String, channel: String, attachments: [AttachmentOut] = []) -> MessageState {
            var message = MessageState(placeholderFor: "x", channelId: channel, senderId: bob, body: body, createdAt: "")
            message.id = "m1"
            message.attachments = attachments
            return message
        }
        // A channel message: its one-line text as the title, its board.
        let lab = TaskRules.messageTaskInit(message("**明日** までに\n<@\(bob)> と資料", channel: "lab"), channel: store.channel("lab"), users: users,
                                            groups: [:], isAdmin: false)
        XCTAssertEqual(lab.title, "明日 までに @ボブ と資料")
        XCTAssertEqual(lab.channelId, "lab")
        XCTAssertEqual(lab.sourceMessageId, "m1")
        XCTAssertEqual(lab.sourceExcerpt, "明日 までに @ボブ と資料")
        XCTAssertEqual(lab.boardChoices, ["lab"])
        // A DM (or a board I may not add to): 「自分のタスク」; a long body is cut to 200.
        let dm = TaskRules.messageTaskInit(message(String(repeating: "あ", count: 300), channel: "dm"), channel: store.channel("dm"), users: users,
                                           groups: [:], isAdmin: false)
        XCTAssertNil(dm.channelId)
        XCTAssertEqual(dm.boardChoices, [])
        XCTAssertEqual(dm.title.count, 200)
        XCTAssertNil(TaskRules.messageTaskInit(message("x", channel: "news"), channel: store.channel("news"), users: users, groups: [:], isAdmin: false).channelId)
        XCTAssertEqual(TaskRules.messageTaskInit(message("x", channel: "news"), channel: store.channel("news"), users: users, groups: [:], isAdmin: true).channelId,
                       "news")
        // No text: what the attachments were.
        let image = AttachmentOut(id: "a1", filename: "p.png", contentType: "image/png", sizeBytes: 1, width: nil, height: nil, hasThumbnail: true,
                                  status: "ready", createdAt: "")
        let picture = TaskRules.messageTaskInit(message("", channel: "dm", attachments: [image]), channel: store.channel("dm"), users: users, groups: [:],
                                                isAdmin: false)
        XCTAssertTrue(picture.title.contains("画像"), picture.title)
    }

    func testTheCalendarsFilter() {
        let p = F.task("p", channelId: nil)
        let a = F.task("a", assigneeIds: ["u-me"])
        let o = F.task("o", channelId: "c-other")
        XCTAssertEqual(TaskRules.filter([p, a, o], .all, me: "u-me").count, 3)
        XCTAssertEqual(ids(TaskRules.filter([p, a, o], .mine, me: "u-me")), [p.id, a.id])
        XCTAssertEqual(ids(TaskRules.filter([p, a, o], .channel("c-other"), me: "u-me")), [o.id])
    }

    func testNoticesAreWordedLikeThePush() {
        let assigned = TaskAssigned(taskId: "t1", channelId: "c-lab", channelName: "lab", title: "資料", byUserId: "u-bob")
        XCTAssertEqual(TaskRules.noticeText(assigned: assigned) { $0 == "u-bob" ? "ボブ" : nil }, "ボブ がタスクを割り当てました: 資料 (#lab)")
        XCTAssertEqual(TaskRules.noticeText(assigned: assigned) { _ in nil }, "メンバー がタスクを割り当てました: 資料 (#lab)")
        XCTAssertEqual(TaskRules.noticeText(due: TaskDue(taskId: "t2", channelId: nil, channelName: nil, title: "買い物", dueOn: "2026-10-01")), "今日が期限: 買い物")
        XCTAssertEqual(TaskRules.noticeText(due: TaskDue(taskId: "t3", channelId: "c-lab", channelName: "lab", title: "発表", dueOn: "2026-10-01")),
                       "今日が期限: 発表 (#lab)")
    }
}

/// The hub (Sync/TaskHub.swift): the web's tests/taskHub.test.ts.
@MainActor
final class TaskHubTests: XCTestCase {
    private typealias F = TaskFixtures

    private func titles(_ list: [TaskOut]?) -> [String] { (list ?? []).map(\.title) }

    func testReadsABoardAndAppliesTaskEvents() async {
        let a = F.task("a", position: 1)
        let api = FakeTaskApi(board: [a])
        let hub = TaskHub(api: api, me: { "u-me" })
        await hub.openBoard("c-lab")
        XCTAssertEqual(api.listCalls.first?.channelId, "c-lab")
        XCTAssertEqual(api.listCalls.first?.includeDone, "recent")
        XCTAssertEqual(hub.board("c-lab")?.state, .ready)
        let b = F.task("b", position: 2)
        hub.applyEvent("task.updated", F.updated(b, deleters: ["u-other"]))
        XCTAssertEqual(titles(TaskRules.column(hub.board("c-lab")?.tasks ?? [], .todo)), ["a", "b"])
        XCTAssertEqual(hub.find(b.id)?.canDelete, false)
        var renamed = a
        renamed.title = "A"
        renamed.updatedAt = "2026-10-01T01:00:00Z"
        hub.applyEvent("task.updated", F.updated(renamed, deleters: ["u-me"]))
        XCTAssertEqual(hub.find(a.id)?.title, "A")
        XCTAssertEqual(hub.find(a.id)?.canDelete, true)
        hub.applyEvent("task.deleted", F.deleted(a.id))
        XCTAssertEqual(titles(hub.board("c-lab")?.tasks), ["b"])
        // Another channel's task: not on this board. A frame that does not decode changes nothing.
        hub.applyEvent("task.updated", F.updated(F.task("x", channelId: "c-other"), deleters: []))
        hub.applyEvent("task.updated", .object(["task": .string("?")]))
        XCTAssertEqual(hub.board("c-lab")?.tasks.count, 1)
        hub.closeBoard("c-lab")
        XCTAssertNil(hub.board("c-lab"))
    }

    func testARenumberedColumnArrivesCardByCardAndAnOlderCopyNeverWins() async {
        let a = F.task("a", position: 1), b = F.task("b", position: 1.0000001), c = F.task("c", position: 1.0000002)
        let hub = TaskHub(api: FakeTaskApi(board: [a, b, c]), me: { "u-me" })
        await hub.openBoard("c-lab")
        for (task, position) in [(c, 1024.0), (a, 2048.0), (b, 3072.0)] {
            var moved = task
            moved.position = position
            moved.updatedAt = "2026-10-01T02:00:00Z"
            hub.applyEvent("task.updated", F.updated(moved, deleters: []))
        }
        XCTAssertEqual(titles(TaskRules.column(hub.board("c-lab")!.tasks, .todo)), ["c", "a", "b"])
        var stale = a
        stale.position = 0
        hub.put(stale)
        XCTAssertEqual(titles(TaskRules.column(hub.board("c-lab")!.tasks, .todo)), ["c", "a", "b"])
    }

    func testAllDoneAndReadingEveryWindowAgainAfterReconnecting() async {
        let api = FakeTaskApi()
        let hub = TaskHub(api: api, me: { "u-me" })
        await hub.openBoard("c-lab")
        await hub.openBoard("c-lab") // ready: not read twice
        XCTAssertEqual(api.listCalls.count, 1)
        await hub.openBoard("c-lab", allDone: true)
        XCTAssertEqual(api.listCalls.last?.includeDone, "all")
        await hub.openMine()
        await hub.openDue("calendar", from: "2026-09-27", to: "2026-11-01")
        hub.online()
        for _ in 0..<50 where api.listCalls.count < 3 || api.mineCalls < 2 || api.dueCalls.count < 2 { await Task.yield() }
        XCTAssertEqual(api.listCalls.last?.includeDone, "all")
        XCTAssertEqual(api.mineCalls, 2)
        XCTAssertEqual(api.dueCalls.last?.from, "2026-09-27")
        XCTAssertEqual(api.dueCalls.last?.to, "2026-11-01")
    }

    func testAServerWithoutTasksAndAFailedRead() async {
        let api = FakeTaskApi()
        api.listError = ApiError.api(status: 404, code: "not_found", message: "Not Found")
        let hub = TaskHub(api: api, me: { "u-me" })
        await hub.openBoard("c-lab")
        XCTAssertEqual(hub.board("c-lab")?.state, .unsupported)
        api.listError = ApiError.api(status: 403, code: "not_a_member", message: "")
        await hub.openBoard("c-two")
        XCTAssertEqual(hub.board("c-two")?.state, .failed)
        let none = TaskHub(api: nil, me: { "u-me" })
        XCTAssertFalse(none.available)
        do {
            _ = try await none.create(TaskCreate(title: "x", clientTaskId: "k", tz: "Asia/Tokyo"))
            XCTFail("no api")
        } catch {}
    }

    func testAMoveShowsAtOnceThenTheServersPlace() async throws {
        let a = F.task("a", position: 1), b = F.task("b", position: 2)
        let api = FakeTaskApi(board: [a, b])
        api.holdMoves = true
        api.moveAnswer = { task, move in
            var moved = task
            moved.status = move.status
            moved.position = 0.5
            moved.updatedAt = "2026-10-01T05:00:00Z"
            return moved
        }
        let hub = TaskHub(api: api, me: { "u-me" })
        await hub.openBoard("c-lab")
        let moving = Task { try await hub.move(b.id, to: .todo, TaskNeighbors(afterId: nil, beforeId: a.id)) }
        for _ in 0..<50 where api.moveGate == nil { await Task.yield() }
        XCTAssertEqual(api.moves.first?.move, TaskMove(status: .todo, neighbors: TaskNeighbors(afterId: nil, beforeId: a.id)))
        XCTAssertEqual(titles(TaskRules.column(hub.board("c-lab")!.tasks, .todo)), ["b", "a"]) // at once
        api.moveGate?.resume()
        _ = try await moving.value
        XCTAssertEqual(hub.find(b.id)?.position, 0.5)
    }

    func testARefusedMovePutsTheCardBack() async {
        let a = F.task("a", position: 1)
        let api = FakeTaskApi(board: [a])
        api.moveError = ApiError.api(status: 403, code: "posting_restricted", message: "no")
        let hub = TaskHub(api: api, me: { "u-me" })
        await hub.openBoard("c-lab")
        do {
            try await hub.move(a.id, to: .doing, .none)
            XCTFail("refused")
        } catch {}
        XCTAssertEqual(hub.find(a.id)?.status, .todo)
        XCTAssertEqual(hub.find(a.id)?.position, 1)
    }

    func testMyTasksKeepsWhatIsPersonalOrAssignedToMe() async {
        let mine = F.task("mine", assigneeIds: ["u-me"])
        let hub = TaskHub(api: FakeTaskApi(mine: [mine]), me: { "u-me" })
        await hub.openMine()
        var reassigned = mine
        reassigned.assigneeIds = ["u-other"]
        reassigned.updatedAt = "2026-10-02T00:00:00Z"
        hub.applyEvent("task.updated", F.updated(reassigned, deleters: []))
        XCTAssertEqual(hub.mine?.tasks, [])
        hub.applyEvent("task.updated", F.updated(F.task("p", channelId: nil), deleters: ["u-me"]))
        hub.applyEvent("task.updated", F.updated(F.task("theirs", assigneeIds: ["u-other"]), deleters: []))
        XCTAssertEqual(titles(hub.mine?.tasks), ["p"])
        hub.closeMine()
        XCTAssertNil(hub.mine)
    }

    func testACalendarRangeHoldsTheTasksDueInIt() async {
        let t = F.task("t", dueOn: "2026-10-05")
        let hub = TaskHub(api: FakeTaskApi(due: [t]), me: { "u-me" })
        await hub.openDue("calendar", from: "2026-10-01", to: "2026-10-08")
        XCTAssertEqual(titles(hub.dueWindow("calendar")?.tasks), ["t"])
        var later = t
        later.dueOn = "2026-10-08" // the end is not in the range
        later.updatedAt = "2026-10-02T00:00:00Z"
        hub.applyEvent("task.updated", F.updated(later, deleters: []))
        XCTAssertEqual(hub.dueWindow("calendar")?.tasks, [])
        hub.applyEvent("task.updated", F.updated(F.task("n", dueOn: "2026-10-07"), deleters: []))
        hub.applyEvent("task.updated", F.updated(F.task("none"), deleters: []))
        XCTAssertEqual(titles(hub.dueWindow("calendar")?.tasks), ["n"])
    }

    func testMyChangesGoInAtOnceAndLeavingAChannelDropsItsTasks() async throws {
        let personal = F.task("p", channelId: nil)
        let api = FakeTaskApi(board: [F.task("a")], mine: [F.task("m", assigneeIds: ["u-me"]), personal])
        let hub = TaskHub(api: api, me: { "u-me" })
        await hub.openBoard("c-lab")
        await hub.openMine()
        let made = try await hub.create(TaskCreate(channelId: "c-lab", title: "新しい", clientTaskId: "k1", tz: "Asia/Tokyo"))
        XCTAssertNotNil(hub.board("c-lab")?.tasks.first { $0.id == made.id })
        XCTAssertEqual(api.creates.first?.clientTaskId, "k1")
        _ = try await hub.update(personal.id, TaskPatch(status: .done))
        XCTAssertEqual(hub.find(personal.id)?.status, .done)
        XCTAssertEqual(api.patches.first?.patch, TaskPatch(status: .done))
        let known = try await hub.load(personal.id)
        XCTAssertEqual(known.status, .done) // as held, not read again
        try await hub.remove(made.id)
        XCTAssertNil(hub.find(made.id))
        XCTAssertEqual(api.deletes, [made.id])
        hub.removeChannel("c-lab")
        XCTAssertNil(hub.board("c-lab"))
        XCTAssertEqual(titles(hub.mine?.tasks), ["p"])
        hub.stop()
        XCTAssertNil(hub.mine)
    }

    func testAssignedAndDueAreSaidByTheApp() {
        let hub = TaskHub(api: FakeTaskApi(), me: { "u-me" })
        var notices: [TaskNotice] = []
        hub.onNotice = { notices.append($0) }
        hub.applyEvent("task.assigned", .object(["task_id": .string("t1"), "channel_id": .string("c-lab"), "channel_name": .string("lab"),
                                                 "title": .string("資料"), "by_user_id": .string("u-bob")]))
        hub.applyEvent("task.due", .object(["task_id": .string("t2"), "channel_id": .null, "channel_name": .null, "title": .string("買い物"),
                                            "due_on": .string("2026-10-01")]))
        XCTAssertEqual(notices, [.assigned(TaskAssigned(taskId: "t1", channelId: "c-lab", channelName: "lab", title: "資料", byUserId: "u-bob")),
                                 .due(TaskDue(taskId: "t2", channelId: nil, channelName: nil, title: "買い物", dueOn: "2026-10-01"))])
    }
}

/// Decoding the server's shapes (tolerantly), the calls' paths and bodies, the notification payload, and the in-app notice.
@MainActor
final class TaskWireTests: XCTestCase {
    override func tearDown() { StubProtocol.handler = nil }

    static let taskJson = """
    {"id":"0199a0b0-0000-7000-8000-0000000000t1","channel_id":"0199a0b0-1111-7000-8000-000000000001","channel_name":"m2-進捗",
     "owner_id":"u1","title":"資料をまとめる","notes":"**先行研究** 3 本","status":"doing","position":2048.5,"due_on":"2026-10-05",
     "assignee_ids":["u1","u2"],"source":{"message_id":"m1","channel_id":"0199a0b0-1111-7000-8000-000000000001","excerpt":"資料 お願いします"},
     "completed_at":null,"completed_by":null,"created_at":"2026-10-01T00:00:00Z","updated_at":"2026-10-01T01:00:00Z","can_delete":true}
    """

    func testDecodesTheServersShapesTolerantly() throws {
        let task = try JSON.snakeDecoder.decode(TaskOut.self, from: Data(Self.taskJson.utf8))
        XCTAssertEqual(task.title, "資料をまとめる")
        XCTAssertEqual(task.status, .doing)
        XCTAssertEqual(task.position, 2048.5)
        XCTAssertEqual(task.dueOn, "2026-10-05")
        XCTAssertEqual(task.assigneeIds, ["u1", "u2"])
        XCTAssertEqual(task.source, TaskSourceOut(messageId: "m1", channelId: "0199a0b0-1111-7000-8000-000000000001", excerpt: "資料 お願いします"))
        XCTAssertTrue(task.canDelete)

        // Fields left out, an unknown column, an odd source: the task still reads.
        let sparse = try JSON.snakeDecoder.decode(TaskOut.self, from: Data("""
        {"id":"t2","channel_id":null,"owner_id":"u1","title":"買い物","status":"blocked","position":1,"source":{"message_id":3},
         "created_at":"","updated_at":"","future_field":{"x":1}}
        """.utf8))
        XCTAssertEqual(sparse.status, .todo)
        XCTAssertEqual(sparse.assigneeIds, [])
        XCTAssertNil(sparse.source)
        XCTAssertFalse(sparse.canDelete)
        XCTAssertNil(sparse.channelId)

        // task.updated: no can_delete (per person), deleter_ids beside it.
        let frame = try JSONDecoder().decode(JSONValue.self, from: Data("{\"task\":\(Self.taskJson),\"deleter_ids\":[\"u1\"]}".utf8))
        let updated = try frame.decode(TaskUpdated.self)
        XCTAssertEqual(updated.deleterIds, ["u1"])
        XCTAssertEqual(updated.task.title, "資料をまとめる")
        let deleted = try TaskFixtures.deleted("t1", channelId: nil).decode(TaskDeleted.self)
        XCTAssertNil(deleted.channelId)
        // The deleted message's source.
        let gone = try JSON.snakeDecoder.decode(TaskSourceOut.self, from: Data(#"{"message_id":null,"channel_id":"c1","excerpt":null}"#.utf8))
        XCTAssertEqual(TaskRules.sourceState(gone), .deleted)
    }

    func testUserMeCarriesNotifyTasksFromM55On() throws {
        let base = #""id":"u1","username":"kano","display_name":"Kano","role":"member","deactivated_at":null,"created_at":"","updated_at":"","email":null,"must_change_password":false"#
        let older = try JSON.snakeDecoder.decode(UserMe.self, from: Data("{\(base)}".utf8))
        XCTAssertNil(older.notifyTasks)
        XCTAssertTrue(older.taskNotices)
        let off = try JSON.snakeDecoder.decode(UserMe.self, from: Data("{\(base),\"notify_tasks\":false}".utf8))
        XCTAssertEqual(off.notifyTasks, false)
        XCTAssertFalse(off.taskNotices)
    }

    private func makeClient() -> ApiClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        let client = ApiClient(baseUrl: URL(string: "http://server")!, session: URLSession(configuration: configuration))
        client.accessToken = "t"
        return client
    }

    func testTheCallsAndTheBodiesTheServerReads() async throws {
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
            if request.httpMethod == "GET" && ["/api/v1/tasks", "/api/v1/tasks/mine", "/api/v1/tasks/due"].contains(request.url!.path) {
                return (200, Data("[\(Self.taskJson)]".utf8))
            }
            return (200, Data(Self.taskJson.utf8))
        }
        let client = makeClient()
        let board = try await client.listTasks(channelId: "c1", includeDone: "recent")
        XCTAssertEqual(board.count, 1)
        XCTAssertEqual(requests.last?.url?.path, "/api/v1/tasks")
        XCTAssertTrue(requests.last?.url?.query?.contains("channel_id=c1") == true)
        XCTAssertTrue(requests.last?.url?.query?.contains("include_done=recent") == true)
        _ = try await client.myTasks()
        XCTAssertEqual(requests.last?.url?.path, "/api/v1/tasks/mine")
        _ = try await client.dueTasks(from: "2026-10-01", to: "2026-11-01")
        XCTAssertEqual(requests.last?.url?.path, "/api/v1/tasks/due")
        XCTAssertEqual(requests.last?.url?.query, "from=2026-10-01&to=2026-11-01")
        let one = try await client.task(id: "0199a0b0-0000-7000-8000-0000000000t1")
        XCTAssertEqual(one.status, .doing)
        XCTAssertEqual(requests.last?.url?.path, "/api/v1/tasks/0199a0b0-0000-7000-8000-0000000000t1")

        var draft = TaskDraft(title: "資料", channelId: "c1")
        draft.assigneeIds = ["u2"]
        draft.sourceMessageId = "m1"
        _ = try await client.createTask(draft.create(clientTaskId: "k1", tz: "Asia/Tokyo"))
        XCTAssertEqual(requests.last?.httpMethod, "POST")
        XCTAssertEqual(requests.last?.url?.path, "/api/v1/tasks")
        _ = try await client.updateTask(id: "t1", TaskPatch(notes: .some(nil), dueOn: .some("2026-10-09"), tz: "Asia/Tokyo"))
        XCTAssertEqual(requests.last?.httpMethod, "PATCH")
        XCTAssertEqual(requests.last?.url?.path, "/api/v1/tasks/t1")
        _ = try await client.moveTask(id: "t1", TaskMove(status: .done, neighbors: TaskNeighbors(afterId: nil, beforeId: "t9")))
        XCTAssertEqual(requests.last?.httpMethod, "POST")
        XCTAssertEqual(requests.last?.url?.path, "/api/v1/tasks/t1/move")
        try await client.deleteTask(id: "t1")
        XCTAssertEqual(requests.last?.httpMethod, "DELETE")
        XCTAssertEqual(requests.last?.url?.path, "/api/v1/tasks/t1")

        XCTAssertEqual(bodies.count, 3)
        if bodies.count == 3 {
            XCTAssertEqual(bodies[0], .object(["title": .string("資料"), "status": .string("todo"), "client_task_id": .string("k1"),
                                               "tz": .string("Asia/Tokyo"), "channel_id": .string("c1"), "assignee_ids": .array([.string("u2")]),
                                               "source_message_id": .string("m1")]))
            // A cleared field is null; a field not changed is absent.
            XCTAssertEqual(bodies[1], .object(["notes": .null, "due_on": .string("2026-10-09"), "tz": .string("Asia/Tokyo")]))
            XCTAssertEqual(bodies[2], .object(["status": .string("done"), "after_id": .null, "before_id": .string("t9")]))
        }
    }

    func testANotificationOpensItsTask() {
        let payload = PushPayload(userInfo: ["kind": "task", "task_id": "t1", "channel_id": "c1", "workspace_id": "w"])
        XCTAssertEqual(payload.taskId, "t1")
        XCTAssertTrue(payload.opensTask)
        XCTAssertFalse(payload.opensEvent)
        XCTAssertFalse(payload.opensMessage)
        let personal = PushPayload(userInfo: ["kind": "task", "task_id": "t2"])
        XCTAssertTrue(personal.opensTask)
        XCTAssertNil(personal.channelId)
        XCTAssertFalse(PushPayload(userInfo: ["kind": "message", "channel_id": "c1", "task_id": "t3"]).opensTask)
        // It shows even with its channel open (the conversation says nothing of it).
        let workspace = Workspace(serverUrl: "https://a", username: "a")
        XCTAssertTrue(Workspaces.shouldPresent(payload, target: workspace, active: "https://a", openChannelId: "c1"))
    }

    func testTheInAppNoticeFollowsNotifyTasksAndDnd() {
        let controller = AppController()
        var me = UserMe(id: "me", username: "kano", displayName: "Kano", role: "member", deactivatedAt: nil, createdAt: "", updatedAt: "", email: nil,
                        mustChangePassword: false)
        me.notifyTasks = true
        controller.store.setMe(me)
        controller.store.upsertUser(UserPublic(id: "u-bob", username: "bob", displayName: "ボブ", role: "member", deactivatedAt: nil, createdAt: "", updatedAt: ""))
        let assigned = TaskNotice.assigned(TaskAssigned(taskId: "t1", channelId: "c1", channelName: "lab", title: "資料", byUserId: "u-bob"))
        controller.sayTaskNotice(assigned)
        XCTAssertEqual(controller.notice, "☑️ ボブ がタスクを割り当てました: 資料 (#lab)")
        controller.notice = nil
        me.notifyTasks = false
        controller.store.setMe(me)
        controller.sayTaskNotice(assigned)
        XCTAssertNil(controller.notice)
        me.notifyTasks = true
        me.dndUntil = ISO8601DateFormatter().string(from: Date().addingTimeInterval(3600))
        controller.store.setMe(me)
        controller.sayTaskNotice(.due(TaskDue(taskId: "t2", channelId: nil, channelName: nil, title: "買い物", dueOn: nil)))
        XCTAssertNil(controller.notice)
        me.dndUntil = nil
        controller.store.setMe(me)
        controller.sayTaskNotice(.due(TaskDue(taskId: "t2", channelId: nil, channelName: nil, title: "買い物", dueOn: nil)))
        XCTAssertEqual(controller.notice, "☑️ 今日が期限: 買い物")
    }
}

/// The engine routes task.* to the hub, reads every window again after reconnecting, and drops a channel I left.
@MainActor
final class TaskEngineTests: XCTestCase {
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
        let slides = TaskFixtures.task("スライド", channelId: lab.id, ownerId: alice.id, dueOn: "2026-10-05", assigneeIds: [bob.id])
        server.taskRows = [slides]
        let store = Store()
        var options = EngineOptions()
        options.sleep = { _ in }
        let engine = SyncEngine(api: server.api(for: bob.id), connect: server.connector(for: bob.id), wsUrl: URL(string: "ws://fake")!, store: store,
                                getAccessToken: { "t" }, options: options)
        var notices: [TaskNotice] = []
        engine.onTaskNotice = { notices.append($0) }
        await engine.start()
        await settle(engine)
        let hub = try XCTUnwrap(engine.tasks)
        XCTAssertTrue(hub.available)
        await hub.openBoard(lab.id)
        await hub.openMine()
        await hub.openDue("calendar", from: "2026-10-01", to: "2026-11-01")
        XCTAssertEqual(hub.board(lab.id)?.tasks.map(\.title), ["スライド"])
        XCTAssertEqual(hub.mine?.tasks.map(\.title), ["スライド"])

        var renamed = slides
        renamed.title = "スライド (第 2 版)"
        renamed.updatedAt = "2026-10-01T03:00:00Z"
        server.emitEvent([alice.id, bob.id], "task.updated", channelId: lab.id, data: TaskFixtures.updated(renamed, deleters: [alice.id, bob.id]))
        server.emitEvent([bob.id], "task.assigned", channelId: lab.id, data: .object([
            "task_id": .string(slides.id), "channel_id": .string(lab.id), "channel_name": .string("lab"), "title": .string(renamed.title),
            "by_user_id": .string(alice.id),
        ]))
        await settle(engine)
        XCTAssertEqual(hub.find(slides.id)?.title, "スライド (第 2 版)")
        XCTAssertEqual(hub.find(slides.id)?.canDelete, true)
        XCTAssertEqual(hub.dueWindow("calendar")?.tasks.map(\.title), ["スライド (第 2 版)"])
        XCTAssertEqual(notices.count, 1)

        // Missed while disconnected: the reconnect reads every window again.
        let more = TaskFixtures.task("実験計画", channelId: lab.id, ownerId: alice.id)
        server.taskRows = [renamed, more]
        server.disconnect(bob.id)
        for _ in 0..<50 where engine.status != .online || hub.board(lab.id)?.tasks.count != 2 { await settle(engine) }
        XCTAssertEqual(Set(hub.board(lab.id)?.tasks.map(\.title) ?? []), ["スライド (第 2 版)", "実験計画"])

        // Deleted elsewhere; then leaving the channel drops its tasks everywhere.
        server.emitEvent([bob.id], "task.deleted", channelId: lab.id, data: TaskFixtures.deleted(more.id, channelId: lab.id))
        await settle(engine)
        XCTAssertNil(hub.find(more.id))
        server.removeMember(lab.id, bob.id)
        await settle(engine)
        XCTAssertNil(hub.board(lab.id))
        XCTAssertEqual(hub.mine?.tasks ?? [], [])
        XCTAssertEqual(hub.dueWindow("calendar")?.tasks ?? [], [])
        engine.stop()
    }
}

extension FakeServer.Api: TaskApi {
    func listTasks(channelId: String, includeDone: String) async throws -> [TaskOut] { server.taskRows.filter { $0.channelId == channelId } }
    func myTasks() async throws -> [TaskOut] { server.taskRows.filter { $0.channelId == nil || $0.assigneeIds.contains(userId) } }
    func dueTasks(from: DayKey, to: DayKey) async throws -> [TaskOut] { server.taskRows.filter { TaskRules.dueInRange($0, from: from, to: to) } }

    func task(id: String) async throws -> TaskOut {
        guard let row = server.taskRows.first(where: { $0.id == id }) else { throw ApiError.api(status: 404, code: "task_not_found", message: "") }
        return row
    }

    func createTask(_ body: TaskCreate) async throws -> TaskOut { throw ApiError.api(status: 501, code: "unused", message: "") }
    func updateTask(id: String, _ patch: TaskPatch) async throws -> TaskOut { throw ApiError.api(status: 501, code: "unused", message: "") }
    func moveTask(id: String, _ move: TaskMove) async throws -> TaskOut { throw ApiError.api(status: 501, code: "unused", message: "") }
    func deleteTask(id: String) async throws {}
}
