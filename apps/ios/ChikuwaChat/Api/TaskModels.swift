import Foundation

/// Tasks and kanban (docs/TASKS.md; the server and the web in M55, this client in M56): a board per public or private
/// channel and my own list, three fixed columns, several assignees, a due date, optionally the message a task came from.

/// The three columns (TASKS.md §1). An unknown value (a later server's column) reads as 未着手 rather than failing the list.
enum TaskStatus: String, CaseIterable, Codable, Hashable {
    case todo, doing, done

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = TaskStatus(rawValue: raw) ?? .todo
    }

    var label: String {
        switch self {
        case .todo: "未着手"
        case .doing: "進行中"
        case .done: "完了"
        }
    }
}

/// L9 (docs/REVIEWS.md §2.2, §7 3.): what a task made from a message is — 「タスクにする」 (task) or 「レビューを依頼」
/// (review). Only the words change (the chip, the form, the pushes). An unknown value reads as a task.
enum TaskKind: String, Codable, Hashable {
    case task, review

    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = TaskKind(rawValue: raw) ?? .task
    }
}

/// The message a task was made from (§8 1.): `messageId` and `excerpt` become null once that message is deleted.
struct TaskSourceOut: Codable, Equatable, Hashable {
    var messageId: String?
    var channelId: String?
    var excerpt: String?
}

/// M73 (CANVAS.md §18.3, TASKS.md §10): the canvas (and checklist item) a task was made from. `canvasId` is null once
/// the canvas was purged (a canvas in the trash keeps its id); `excerpt` is the item as it was then.
struct TaskCanvasSourceOut: Decodable, Equatable, Hashable {
    var canvasId: String?
    var excerpt: String?

    init(canvasId: String?, excerpt: String?) {
        self.canvasId = canvasId
        self.excerpt = excerpt
    }

    private enum CodingKeys: String, CodingKey { case canvasId, excerpt }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        canvasId = try? c.decodeIfPresent(String.self, forKey: .canvasId)
        excerpt = try? c.decodeIfPresent(String.self, forKey: .excerpt)
    }
}

/// A task as I see it (GET /tasks…, the answers to my changes). task.updated carries the same fields without
/// `can_delete` (it differs per person, §8 4.): it then decodes as false and the hub sets it from `deleter_ids`.
/// Decoding is tolerant: a missing list or flag takes its empty value, so a field added or left out later does not
/// drop a whole board.
struct TaskOut: Identifiable, Equatable, Hashable {
    let id: String
    /// nil: my own list.
    let channelId: String?
    var channelName: String?
    let ownerId: String
    var title: String
    var notes: String?
    var status: TaskStatus
    var position: Double
    /// "YYYY-MM-DD".
    var dueOn: String?
    var assigneeIds: [String]
    var source: TaskSourceOut?
    var completedAt: String?
    var completedBy: String?
    let createdAt: String
    var updatedAt: String
    var canDelete: Bool
    /// L9: absent from a server before M63 (a task).
    var kind: TaskKind = .task
    /// M73: the canvas it was made from (absent from a server before M72, and for every other task).
    var canvasSource: TaskCanvasSourceOut? = nil
    /// M81 (TASKS.md §11.3): the due time (UTC, whole minutes) and the zone its wall-clock time is in; nil: the whole day
    /// of `dueOn` (and always from a server before M81). `dueOn` stays the date, in `dueTz`.
    var dueAt: String? = nil
    var dueTz: String? = nil
    /// M81: the checklist, in its order (empty: none, or a server before M81).
    var subtasks: [SubtaskOut] = []
    /// M81: the repeat rule (the calendar's RRULE subset, CALENDAR.md §10.1); completing makes the next occurrence.
    var rrule: String? = nil
    /// M81: the added column the card is in; nil: the built-in column of its status (and always from before M81).
    var columnId: String? = nil
}

/// M81: an item of a task's checklist.
struct SubtaskOut: Codable, Equatable, Hashable, Identifiable {
    let id: String
    var title: String
    var done: Bool

    init(id: String, title: String, done: Bool = false) {
        self.id = id
        self.title = title
        self.done = done
    }

    private enum CodingKeys: String, CodingKey { case id, title, done }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = (try? c.decodeIfPresent(String.self, forKey: .title)) ?? ""
        done = (try? c.decodeIfPresent(Bool.self, forKey: .done)) ?? false
    }

    /// The list as a task carries it: missing or unreadable is none, an odd item is left out.
    static func list<K: CodingKey>(_ c: KeyedDecodingContainer<K>, forKey key: K) -> [SubtaskOut] {
        ((try? c.decodeIfPresent([Lenient].self, forKey: key)) ?? []).compactMap(\.value)
    }

    private struct Lenient: Decodable {
        let value: SubtaskOut?
        init(from decoder: Decoder) throws { value = try? SubtaskOut(from: decoder) }
    }
}

/// M81 (TASKS.md §11.2): a column of a channel's board (GET /tasks/columns, task.columns.updated). Every column belongs to
/// one of the three statuses (a card in a 完了 column is done); the three built-in ones cannot be deleted.
struct TaskColumnOut: Decodable, Equatable, Hashable, Identifiable {
    let id: String
    var channelId: String = ""
    var name: String
    var status: TaskStatus
    var builtin: Bool
    var position: Double

    init(id: String, channelId: String = "", name: String, status: TaskStatus, builtin: Bool, position: Double) {
        self.id = id
        self.channelId = channelId
        self.name = name
        self.status = status
        self.builtin = builtin
        self.position = position
    }

    private enum CodingKeys: String, CodingKey { case id, channelId, name, status, builtin, position }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        channelId = (try? c.decodeIfPresent(String.self, forKey: .channelId)) ?? ""
        name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? ""
        status = (try? c.decodeIfPresent(TaskStatus.self, forKey: .status)) ?? .todo
        builtin = (try? c.decodeIfPresent(Bool.self, forKey: .builtin)) ?? false
        position = (try? c.decodeIfPresent(Double.self, forKey: .position)) ?? 0
    }
}

/// task.columns.updated (M81): a board's columns, all of them.
struct TaskColumnsUpdated: Decodable {
    let channelId: String
    let columns: [TaskColumnOut]

    private enum CodingKeys: String, CodingKey { case channelId, columns }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        channelId = try c.decode(String.self, forKey: .channelId)
        columns = try c.decodeIfPresent([TaskColumnOut].self, forKey: .columns) ?? []
    }
}

/// POST /tasks/columns.
struct TaskColumnCreate: Equatable {
    var channelId: String
    var name: String
    var status: TaskStatus
    /// nil: the right end.
    var afterId: String? = nil

    var json: JSONValue {
        var fields: [String: JSONValue] = ["channel_id": .string(channelId), "name": .string(name), "status": .string(status.rawValue)]
        if let afterId { fields["after_id"] = .string(afterId) }
        return .object(fields)
    }
}

/// PATCH /tasks/columns/{id}: a new name, or a place (`afterId` `.some(nil)`: the left end).
struct TaskColumnUpdate: Equatable {
    var name: String? = nil
    var afterId: String?? = nil

    var json: JSONValue {
        var fields: [String: JSONValue] = [:]
        if let name { fields["name"] = .string(name) }
        if let afterId { fields["after_id"] = afterId.map(JSONValue.string) ?? .null }
        return .object(fields)
    }
}

/// M81: an item as the form sends it (POST / PATCH `subtasks`, the whole list): a known id keeps its item.
struct SubtaskIn: Equatable {
    var id: String?
    var title: String
    var done: Bool

    var json: JSONValue {
        var fields: [String: JSONValue] = ["title": .string(title), "done": .bool(done)]
        if let id { fields["id"] = .string(id) }
        return .object(fields)
    }
}

/// PATCH /tasks/{id}/subtasks/{sid}: one item (its checkbox) without touching the rest of the list.
struct SubtaskUpdate: Equatable {
    var title: String? = nil
    var done: Bool? = nil

    var json: JSONValue {
        var fields: [String: JSONValue] = [:]
        if let title { fields["title"] = .string(title) }
        if let done { fields["done"] = .bool(done) }
        return .object(fields)
    }
}

extension TaskOut: Decodable {
    private enum CodingKeys: String, CodingKey {
        case id, channelId, channelName, ownerId, title, notes, status, position, dueOn, assigneeIds, source, completedAt, completedBy,
             createdAt, updatedAt, canDelete, kind, canvasSource, dueAt, dueTz, subtasks, rrule, columnId
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        channelId = try c.decodeIfPresent(String.self, forKey: .channelId)
        channelName = try c.decodeIfPresent(String.self, forKey: .channelName)
        ownerId = try c.decodeIfPresent(String.self, forKey: .ownerId) ?? ""
        title = try c.decodeIfPresent(String.self, forKey: .title) ?? ""
        notes = try c.decodeIfPresent(String.self, forKey: .notes)
        status = try c.decodeIfPresent(TaskStatus.self, forKey: .status) ?? .todo
        position = try c.decodeIfPresent(Double.self, forKey: .position) ?? 0
        dueOn = try c.decodeIfPresent(String.self, forKey: .dueOn)
        assigneeIds = try c.decodeIfPresent([String].self, forKey: .assigneeIds) ?? []
        source = try? c.decodeIfPresent(TaskSourceOut.self, forKey: .source)
        completedAt = try c.decodeIfPresent(String.self, forKey: .completedAt)
        completedBy = try c.decodeIfPresent(String.self, forKey: .completedBy)
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt) ?? ""
        updatedAt = try c.decodeIfPresent(String.self, forKey: .updatedAt) ?? ""
        canDelete = try c.decodeIfPresent(Bool.self, forKey: .canDelete) ?? false
        kind = (try? c.decodeIfPresent(TaskKind.self, forKey: .kind)) ?? .task
        canvasSource = (try? c.decodeIfPresent(TaskCanvasSourceOut.self, forKey: .canvasSource))
        // M81: all optional (a server before M81 sends none of them).
        dueAt = (try? c.decodeIfPresent(String.self, forKey: .dueAt)) ?? nil
        dueTz = (try? c.decodeIfPresent(String.self, forKey: .dueTz)) ?? nil
        subtasks = SubtaskOut.list(c, forKey: .subtasks)
        rrule = (try? c.decodeIfPresent(String.self, forKey: .rrule)) ?? nil
        columnId = (try? c.decodeIfPresent(String.self, forKey: .columnId)) ?? nil
    }
}

/// task.updated (§4, §8 4.): the task as everyone who sees it sees it, and who may delete it.
struct TaskUpdated: Decodable {
    let task: TaskOut
    let deleterIds: [String]

    private enum CodingKeys: String, CodingKey { case task, deleterIds }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        task = try c.decode(TaskOut.self, forKey: .task)
        deleterIds = try c.decodeIfPresent([String].self, forKey: .deleterIds) ?? []
    }
}

/// task.deleted.
struct TaskDeleted: Decodable {
    let id: String
    let channelId: String?
}

/// task.assigned (to me only, §8 3.): someone else added me to a shared task's assignees.
struct TaskAssigned: Decodable, Equatable {
    let taskId: String
    let channelId: String
    let channelName: String
    let title: String
    let byUserId: String
    /// L9: "review" — the words say a review was requested (nil from a server before M63).
    var kind: TaskKind? = nil
}

/// task.review_done (to the requester only, L9 REVIEWS.md §4): an assignee completed my review request. A DM's
/// `channel_name` is empty.
struct TaskReviewDone: Decodable, Equatable {
    let taskId: String
    let channelId: String
    let channelName: String
    let title: String
    let byUserId: String
}

/// L9 (REVIEWS.md §2.2): `MessageOut.tasks` — a shared task made from the message, for its chip (personal ones are never
/// listed). Persisted with the message (MessageState).
struct MessageTaskOut: Codable, Equatable, Hashable, Identifiable {
    let id: String
    var kind: TaskKind = .task
    var status: TaskStatus = .todo
    var assigneeIds: [String] = []
    /// "YYYY-MM-DD".
    var dueOn: String? = nil
    var ownerId: String = ""
    /// M81: the due time (nil: the whole day, or a server before M81).
    var dueAt: String? = nil

    private enum CodingKeys: String, CodingKey { case id, kind, status, assigneeIds, dueOn, ownerId, dueAt }

    init(id: String, kind: TaskKind = .task, status: TaskStatus = .todo, assigneeIds: [String] = [], dueOn: String? = nil, ownerId: String = "",
         dueAt: String? = nil) {
        self.id = id
        self.kind = kind
        self.status = status
        self.assigneeIds = assigneeIds
        self.dueOn = dueOn
        self.ownerId = ownerId
        self.dueAt = dueAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        kind = (try? c.decodeIfPresent(TaskKind.self, forKey: .kind)) ?? .task
        status = (try? c.decodeIfPresent(TaskStatus.self, forKey: .status)) ?? .todo
        assigneeIds = (try? c.decodeIfPresent([String].self, forKey: .assigneeIds)) ?? []
        dueOn = try? c.decodeIfPresent(String.self, forKey: .dueOn)
        ownerId = (try? c.decodeIfPresent(String.self, forKey: .ownerId)) ?? ""
        dueAt = (try? c.decodeIfPresent(String.self, forKey: .dueAt)) ?? nil
    }

    /// The list as a message carries it: missing (a server before M63, a row persisted earlier) or unreadable is none,
    /// and an odd entry is left out rather than the whole message failing.
    static func list<K: CodingKey>(_ c: KeyedDecodingContainer<K>, forKey key: K) -> [MessageTaskOut] {
        ((try? c.decodeIfPresent([Lenient].self, forKey: key)) ?? []).compactMap(\.value)
    }

    private struct Lenient: Decodable {
        let value: MessageTaskOut?
        init(from decoder: Decoder) throws { value = try? MessageTaskOut(from: decoder) }
    }
}

/// task.due (to me only): one of my open tasks is due today (8:00 in my zone), sent once; M81: a task with a due time
/// at that time (`dueAt`, read in `tz`).
struct TaskDue: Decodable, Equatable {
    let taskId: String
    let channelId: String?
    let channelName: String?
    let title: String
    let dueOn: String?
    var dueAt: String? = nil
    var tz: String? = nil
}

/// POST /tasks (§3). `clientTaskId` makes a retry return the same task (200 instead of 201); `tz` is the zone the due
/// date's 8:00 notification is read in (§8 2.).
struct TaskCreate: Equatable {
    var channelId: String?
    var title: String
    var notes: String?
    var status: TaskStatus = .todo
    var dueOn: String?
    var assigneeIds: [String] = []
    var sourceMessageId: String?
    var clientTaskId: String
    var tz: String
    /// L9: a review request (sent only then: a server before M63 knows no kind).
    var kind: TaskKind = .task
    /// M73 (TASKS.md §10): a canvas's checklist item — the canvas and the line as it is in its body (both or neither).
    var sourceCanvasId: String? = nil
    var sourceCanvasLine: String? = nil
    /// M81 (TASKS.md §11.3): a due time with the device's offset (the server takes `due_on` from it), a repeat rule, a
    /// checklist (each sent only when set: a server before M81 knows none of them).
    var dueAt: String? = nil
    var rrule: String? = nil
    var subtasks: [SubtaskIn] = []

    /// Only what is set (the web's body: absent rather than null).
    var json: JSONValue {
        var fields: [String: JSONValue] = ["title": .string(title), "status": .string(status.rawValue), "client_task_id": .string(clientTaskId),
                                           "tz": .string(tz)]
        if let channelId { fields["channel_id"] = .string(channelId) }
        if let notes { fields["notes"] = .string(notes) }
        if let dueOn { fields["due_on"] = .string(dueOn) }
        if channelId != nil && !assigneeIds.isEmpty { fields["assignee_ids"] = .array(assigneeIds.map(JSONValue.string)) }
        if let sourceMessageId { fields["source_message_id"] = .string(sourceMessageId) }
        if kind == .review { fields["kind"] = .string(kind.rawValue) }
        if let sourceCanvasId, let sourceCanvasLine {
            fields["source_canvas_id"] = .string(sourceCanvasId)
            fields["source_canvas_line"] = .string(sourceCanvasLine)
        }
        if let dueAt { fields["due_at"] = .string(dueAt) }
        if let rrule { fields["rrule"] = .string(rrule) }
        if !subtasks.isEmpty { fields["subtasks"] = .array(subtasks.map(\.json)) }
        return .object(fields)
    }
}

/// PATCH /tasks/{id}: only the fields that changed (`assigneeIds` replaces the whole list). `notes` and `dueOn` are
/// double optionals: `.some(nil)` clears them (null), nil leaves them out.
struct TaskPatch: Equatable {
    var title: String?
    var notes: String??
    var status: TaskStatus?
    var dueOn: String??
    var assigneeIds: [String]?
    var tz: String?
    /// M81: the due time (`.some(nil)`: back to the whole day), the repeat rule (`.some(nil)`: no longer repeats), the
    /// whole checklist.
    var dueAt: String?? = nil
    var rrule: String?? = nil
    var subtasks: [SubtaskIn]? = nil

    var isEmpty: Bool {
        title == nil && notes == nil && status == nil && dueOn == nil && assigneeIds == nil && dueAt == nil && rrule == nil && subtasks == nil
    }

    var json: JSONValue {
        var fields: [String: JSONValue] = [:]
        if let title { fields["title"] = .string(title) }
        if let notes { fields["notes"] = notes.map(JSONValue.string) ?? .null }
        if let status { fields["status"] = .string(status.rawValue) }
        if let dueOn { fields["due_on"] = dueOn.map(JSONValue.string) ?? .null }
        if let assigneeIds { fields["assignee_ids"] = .array(assigneeIds.map(JSONValue.string)) }
        if let tz { fields["tz"] = .string(tz) }
        if let dueAt { fields["due_at"] = dueAt.map(JSONValue.string) ?? .null }
        if let rrule { fields["rrule"] = rrule.map(JSONValue.string) ?? .null }
        if let subtasks { fields["subtasks"] = .array(subtasks.map(\.json)) }
        return .object(fields)
    }
}

/// Where a moved card lands (POST /tasks/{id}/move, SYNC_PROTOCOL.md §16): `afterId` is the card that ends up just
/// above it, `beforeId` the one just below; neither: the bottom of 未着手 / 進行中, the top of 完了.
struct TaskNeighbors: Equatable {
    var afterId: String?
    var beforeId: String?

    static let none = TaskNeighbors(afterId: nil, beforeId: nil)
}

/// POST /tasks/{id}/move: into a status (its built-in column, or the card's own column while the status stays) or, M81,
/// into a column (`columnId`, sent without the status: the column says it).
struct TaskMove: Equatable {
    var status: TaskStatus?
    var neighbors: TaskNeighbors
    var columnId: String? = nil

    var json: JSONValue {
        var fields: [String: JSONValue] = ["after_id": neighbors.afterId.map(JSONValue.string) ?? .null,
                                           "before_id": neighbors.beforeId.map(JSONValue.string) ?? .null]
        if let columnId {
            fields["column_id"] = .string(columnId)
        } else if let status {
            fields["status"] = .string(status.rawValue)
        }
        return .object(fields)
    }
}
