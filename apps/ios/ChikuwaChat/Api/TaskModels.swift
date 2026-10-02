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
}

extension TaskOut: Decodable {
    private enum CodingKeys: String, CodingKey {
        case id, channelId, channelName, ownerId, title, notes, status, position, dueOn, assigneeIds, source, completedAt, completedBy,
             createdAt, updatedAt, canDelete, kind, canvasSource
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

    private enum CodingKeys: String, CodingKey { case id, kind, status, assigneeIds, dueOn, ownerId }

    init(id: String, kind: TaskKind = .task, status: TaskStatus = .todo, assigneeIds: [String] = [], dueOn: String? = nil, ownerId: String = "") {
        self.id = id
        self.kind = kind
        self.status = status
        self.assigneeIds = assigneeIds
        self.dueOn = dueOn
        self.ownerId = ownerId
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        kind = (try? c.decodeIfPresent(TaskKind.self, forKey: .kind)) ?? .task
        status = (try? c.decodeIfPresent(TaskStatus.self, forKey: .status)) ?? .todo
        assigneeIds = (try? c.decodeIfPresent([String].self, forKey: .assigneeIds)) ?? []
        dueOn = try? c.decodeIfPresent(String.self, forKey: .dueOn)
        ownerId = (try? c.decodeIfPresent(String.self, forKey: .ownerId)) ?? ""
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

/// task.due (to me only): one of my open tasks is due today (8:00 in my zone), sent once.
struct TaskDue: Decodable, Equatable {
    let taskId: String
    let channelId: String?
    let channelName: String?
    let title: String
    let dueOn: String?
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

    var isEmpty: Bool { title == nil && notes == nil && status == nil && dueOn == nil && assigneeIds == nil }

    var json: JSONValue {
        var fields: [String: JSONValue] = [:]
        if let title { fields["title"] = .string(title) }
        if let notes { fields["notes"] = notes.map(JSONValue.string) ?? .null }
        if let status { fields["status"] = .string(status.rawValue) }
        if let dueOn { fields["due_on"] = dueOn.map(JSONValue.string) ?? .null }
        if let assigneeIds { fields["assignee_ids"] = .array(assigneeIds.map(JSONValue.string)) }
        if let tz { fields["tz"] = .string(tz) }
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

struct TaskMove: Equatable {
    var status: TaskStatus
    var neighbors: TaskNeighbors

    var json: JSONValue {
        .object(["status": .string(status.rawValue), "after_id": neighbors.afterId.map(JSONValue.string) ?? .null,
                 "before_id": neighbors.beforeId.map(JSONValue.string) ?? .null])
    }
}
