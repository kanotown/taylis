import Foundation
import Observation

/// M56: the task calls the hub makes (ApiClient and the test fakes).
@MainActor
protocol TaskApi: AnyObject {
    func listTasks(channelId: String, includeDone: String) async throws -> [TaskOut]
    func myTasks() async throws -> [TaskOut]
    func dueTasks(from: DayKey, to: DayKey) async throws -> [TaskOut]
    func task(id: String) async throws -> TaskOut
    func createTask(_ body: TaskCreate) async throws -> TaskOut
    func updateTask(id: String, _ patch: TaskPatch) async throws -> TaskOut
    func moveTask(id: String, _ move: TaskMove) async throws -> TaskOut
    func deleteTask(id: String) async throws
}

/// One screen's tasks: a channel's board, 「自分のタスク」, a calendar range.
struct TaskList: Equatable {
    enum State: Equatable {
        case loading, ready, failed
        /// The server has no tasks (a server from before M55 says 404 not_found).
        case unsupported
    }

    var state: State
    /// Unordered: the screens sort (TaskRules.column, splitOpenDone, tasksForDay).
    var tasks: [TaskOut]
    /// A board: every completed card (「完了をすべて表示」), not only the latest 100.
    var allDone = false
    /// A calendar range: dates [from, to).
    var from: DayKey = ""
    var to: DayKey = ""
}

/// What task.assigned / task.due say to me (the app says them while it is open; the push covers the background).
enum TaskNotice: Equatable {
    case assigned(TaskAssigned)
    case due(TaskDue)
}

/// M56: the tasks on this device (TASKS.md §4, SYNC_PROTOCOL.md §16), as the web's TaskHub (apps/desktop/src/sync/tasks.ts).
/// Nothing is kept for long: each screen that shows tasks opens a window — a channel's board, 「自分のタスク」, a calendar
/// range — read from the server, and task.* events update the windows they concern (the rest are dropped: the next read
/// has them). After reconnecting every open window is read again, which fills whatever events were missed. Columns are
/// ordered by the server's `position` (a renumbered column arrives card by card), never by a local index. A move shows
/// at once at a guessed place and goes back when the server refuses it.
@MainActor
@Observable
final class TaskHub {
    private(set) var boards: [String: TaskList] = [:]
    private(set) var mine: TaskList?
    private(set) var due: [String: TaskList] = [:]
    /// A read in flight per window: an older answer never replaces a newer one.
    @ObservationIgnored private var reads: [String: Int] = [:]
    @ObservationIgnored private let api: TaskApi?
    @ObservationIgnored private let me: () -> String?
    @ObservationIgnored private let now: () -> String
    /// task.assigned / task.due (said in the app while it is open).
    @ObservationIgnored var onNotice: ((TaskNotice) -> Void)?

    init(api: TaskApi?, me: @escaping () -> String?, now: @escaping () -> String = TaskRules.isoNow) {
        self.api = api
        self.me = me
        self.now = now
    }

    var available: Bool { api != nil }

    func board(_ channelId: String) -> TaskList? { boards[channelId] }
    func dueWindow(_ key: String) -> TaskList? { due[key] }

    // MARK: windows

    /// A channel's 「タスク」 tab is on screen: read its board (again with every completed card when `allDone`).
    func openBoard(_ channelId: String, allDone: Bool = false) async {
        let current = boards[channelId]
        if let current, current.state == .ready, current.allDone == allDone { return }
        boards[channelId] = TaskList(state: .loading, tasks: current?.tasks ?? [], allDone: allDone)
        await readBoard(channelId)
    }

    func closeBoard(_ channelId: String) {
        boards[channelId] = nil
        reads["board:\(channelId)"] = nil
    }

    func openMine() async {
        if mine?.state == .ready { return }
        mine = TaskList(state: .loading, tasks: mine?.tasks ?? [])
        await readMine()
    }

    func closeMine() {
        mine = nil
        reads["mine"] = nil
    }

    /// A calendar shows the dates [from, to): the tasks due then.
    func openDue(_ key: String, from: DayKey, to: DayKey) async {
        let current = due[key]
        let same = current.map { $0.from == from && $0.to == to } ?? false
        if same, current?.state == .ready { return }
        due[key] = TaskList(state: .loading, tasks: same ? current?.tasks ?? [] : [], from: from, to: to)
        await readDue(key)
    }

    func closeDue(_ key: String) {
        due[key] = nil
        reads["due:\(key)"] = nil
    }

    /// 下に引いて読み直す.
    func reloadBoard(_ channelId: String) async {
        guard boards[channelId] != nil else { return }
        await readBoard(channelId)
    }

    func reloadMine() async {
        guard mine != nil else { return }
        await readMine()
    }

    private func ticket(_ key: String) -> Int {
        let ticket = (reads[key] ?? 0) + 1
        reads[key] = ticket
        return ticket
    }

    /// A server from before M55 has no such route (404 not_found).
    static func unsupported(_ error: Error) -> Bool {
        if case ApiError.api(404, "not_found", _) = error { return true }
        return false
    }

    private func failure(_ error: Error) -> TaskList.State {
        print("could not read the tasks: \(error)")
        return Self.unsupported(error) ? .unsupported : .failed
    }

    private func readBoard(_ channelId: String) async {
        guard let api, let board = boards[channelId] else { return }
        let key = "board:\(channelId)"
        let ticket = ticket(key)
        do {
            let tasks = try await api.listTasks(channelId: channelId, includeDone: board.allDone ? "all" : "recent")
            guard reads[key] == ticket, boards[channelId] != nil else { return }
            boards[channelId]?.state = .ready
            boards[channelId]?.tasks = tasks
        } catch {
            guard reads[key] == ticket, boards[channelId] != nil else { return }
            boards[channelId]?.state = failure(error)
        }
    }

    private func readMine() async {
        guard let api, mine != nil else { return }
        let ticket = ticket("mine")
        do {
            let tasks = try await api.myTasks()
            guard reads["mine"] == ticket, mine != nil else { return }
            mine = TaskList(state: .ready, tasks: tasks)
        } catch {
            guard reads["mine"] == ticket, mine != nil else { return }
            mine?.state = failure(error)
        }
    }

    private func readDue(_ key: String) async {
        guard let api, let window = due[key] else { return }
        let ticket = ticket("due:\(key)")
        do {
            let tasks = try await api.dueTasks(from: window.from, to: window.to)
            guard reads["due:\(key)"] == ticket, let now = due[key], now.from == window.from, now.to == window.to else { return }
            due[key]?.state = .ready
            due[key]?.tasks = tasks
        } catch {
            guard reads["due:\(key)"] == ticket, due[key] != nil else { return }
            due[key]?.state = failure(error)
        }
    }

    // MARK: changes made here

    func create(_ body: TaskCreate) async throws -> TaskOut {
        let task = try await requireApi().createTask(body)
        put(task)
        return task
    }

    func update(_ taskId: String, _ patch: TaskPatch) async throws -> TaskOut {
        let task = try await requireApi().updateTask(id: taskId, patch)
        put(task)
        return task
    }

    /// Into `status` between `neighbors`: shown at once at a guessed place, then where the server put it. A refusal puts
    /// the card back and throws (the screen says why).
    @discardableResult
    func move(_ taskId: String, to status: TaskStatus, _ neighbors: TaskNeighbors) async throws -> TaskOut {
        let api = try requireApi()
        let before = find(taskId)
        if let before { putLocalMove(before, status, neighbors) }
        do {
            let task = try await api.moveTask(id: taskId, TaskMove(status: status, neighbors: neighbors))
            put(task)
            return task
        } catch {
            if let before { put(before) } // unless a newer copy came meanwhile
            throw error
        }
    }

    private func putLocalMove(_ task: TaskOut, _ status: TaskStatus, _ neighbors: TaskNeighbors) {
        // The guess is made among the cards of the window that holds the task (its board, else 「自分のタスク」).
        var pool = task.channelId.flatMap { boards[$0]?.tasks } ?? mine?.tasks ?? [task]
        if !pool.contains(where: { $0.id == task.id }) { pool.append(task) }
        let moved = TaskRules.applyLocalMove(pool, task.id, status, neighbors, now: now(), me: me())
        if let local = moved.first(where: { $0.id == task.id }) { put(local) }
    }

    func remove(_ taskId: String) async throws {
        try await requireApi().deleteTask(id: taskId)
        drop(taskId)
    }

    /// The task as held here, else read (a notification, a calendar row outside every window).
    func load(_ taskId: String) async throws -> TaskOut {
        if let known = find(taskId) { return known }
        return try await requireApi().task(id: taskId)
    }

    private func requireApi() throws -> TaskApi {
        guard let api else { throw ApiError.api(status: 404, code: "not_found", message: "Tasks are not available") }
        return api
    }

    // MARK: events (§4)

    func applyEvent(_ event: String, _ data: JSONValue) {
        switch event {
        case "task.updated":
            guard let payload = try? data.decode(TaskUpdated.self) else { return }
            put(TaskRules.fromEvent(payload.task, deleterIds: payload.deleterIds, me: me()))
        case "task.deleted":
            guard let payload = try? data.decode(TaskDeleted.self) else { return }
            drop(payload.id)
        case "task.assigned":
            guard let payload = try? data.decode(TaskAssigned.self) else { return }
            onNotice?(.assigned(payload))
        case "task.due":
            guard let payload = try? data.decode(TaskDue.self) else { return }
            onNotice?(.due(payload))
        default:
            break
        }
    }

    /// A task as it is now, into every window it belongs to (out of those it left): its board, 「自分のタスク」 when
    /// personal or assigned to me, a calendar range holding its due date. An older copy (updated_at) never replaces a
    /// newer one (the optimistic copy keeps the held updated_at, so the server's answer or a refusal's undo replaces it).
    func put(_ task: TaskOut) {
        func newer(_ list: [TaskOut]) -> Bool {
            guard let held = list.first(where: { $0.id == task.id }) else { return true }
            return held.updatedAt <= task.updatedAt
        }
        if let channelId = task.channelId, let board = boards[channelId], newer(board.tasks) {
            boards[channelId]?.tasks = TaskRules.upsert(board.tasks, task)
        }
        if let list = mine, newer(list.tasks) {
            mine?.tasks = TaskRules.isMine(task, me: me()) ? TaskRules.upsert(list.tasks, task) : TaskRules.remove(list.tasks, task.id)
        }
        for (key, window) in due where newer(window.tasks) {
            let fits = TaskRules.dueInRange(task, from: window.from, to: window.to)
            let held = window.tasks.contains { $0.id == task.id }
            if !fits && !held { continue }
            due[key]?.tasks = fits ? TaskRules.upsert(window.tasks, task) : TaskRules.remove(window.tasks, task.id)
        }
    }

    private func drop(_ taskId: String) {
        for (channelId, board) in boards where board.tasks.contains(where: { $0.id == taskId }) {
            boards[channelId]?.tasks = TaskRules.remove(board.tasks, taskId)
        }
        if let list = mine, list.tasks.contains(where: { $0.id == taskId }) { mine?.tasks = TaskRules.remove(list.tasks, taskId) }
        for (key, window) in due where window.tasks.contains(where: { $0.id == taskId }) {
            due[key]?.tasks = TaskRules.remove(window.tasks, taskId)
        }
    }

    func find(_ taskId: String) -> TaskOut? {
        for board in boards.values {
            if let task = board.tasks.first(where: { $0.id == taskId }) { return task }
        }
        if let task = mine?.tasks.first(where: { $0.id == taskId }) { return task }
        for window in due.values {
            if let task = window.tasks.first(where: { $0.id == taskId }) { return task }
        }
        return nil
    }

    // MARK: lifecycle

    /// After (re)connecting: every open window is read again (events missed while away, §4).
    func online() {
        for channelId in boards.keys { Task { await readBoard(channelId) } }
        if mine != nil { Task { await readMine() } }
        for key in due.keys { Task { await readDue(key) } }
    }

    /// I left the channel (or was removed): its board closes and its tasks leave the other windows.
    func removeChannel(_ channelId: String) {
        closeBoard(channelId)
        if let list = mine, list.tasks.contains(where: { $0.channelId == channelId }) {
            mine?.tasks = list.tasks.filter { $0.channelId != channelId }
        }
        for (key, window) in due where window.tasks.contains(where: { $0.channelId == channelId }) {
            due[key]?.tasks = window.tasks.filter { $0.channelId != channelId }
        }
    }

    func stop() {
        boards = [:]
        mine = nil
        due = [:]
        reads = [:]
    }
}
