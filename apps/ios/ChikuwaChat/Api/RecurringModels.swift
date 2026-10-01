import Foundation

/// L6 (docs/RECURRING.md; the server and the web in M59, this client in M60): a channel's recurring posts — a bot posts
/// a template on a weekly or monthly schedule — and, under a post that collects, who has replied (submitted).
/// Decoding is tolerant: a missing list or flag takes its empty value, so a field added later does not drop the list.

/// `{"kind": "weekly", "weekdays": [0, 3], "time": "09:00"}` (0 = Monday) or `{"kind": "monthly", "day": 1, "time": "09:00"}`
/// (a month without that day runs on its last). Kept flat so a later server's kind still decodes.
struct RecurringSchedule: Codable, Equatable, Hashable {
    var kind: String
    var weekdays: [Int] = []
    var day: Int? = nil
    var time: String

    static func weekly(_ weekdays: [Int], time: String) -> RecurringSchedule { RecurringSchedule(kind: "weekly", weekdays: weekdays, time: time) }
    static func monthly(_ day: Int, time: String) -> RecurringSchedule { RecurringSchedule(kind: "monthly", day: day, time: time) }

    enum CodingKeys: String, CodingKey { case kind, weekdays, day, time }

    init(kind: String, weekdays: [Int] = [], day: Int? = nil, time: String) {
        self.kind = kind
        self.weekdays = weekdays
        self.day = day
        self.time = time
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? "weekly"
        weekdays = try c.decodeIfPresent([Int].self, forKey: .weekdays) ?? []
        day = try c.decodeIfPresent(Int.self, forKey: .day)
        time = try c.decodeIfPresent(String.self, forKey: .time) ?? ""
    }

    /// The request's shape: a weekly schedule sends its weekdays, a monthly one its day.
    var json: JSONValue {
        if kind == "monthly" {
            return .object(["kind": .string(kind), "day": .number(Double(day ?? 1)), "time": .string(time)])
        }
        return .object(["kind": .string(kind), "weekdays": .array(weekdays.map { .number(Double($0)) }), "time": .string(time)])
    }
}

/// Whom a post collects from: the union of the groups' members and the people, or (`allMembers`) the whole channel —
/// the channel's members (not bots) when each post goes out.
struct CollectTargets: Codable, Equatable, Hashable {
    var allMembers: Bool = false
    var groupIds: [String] = []
    var userIds: [String] = []

    enum CodingKeys: String, CodingKey { case allMembers, groupIds, userIds }

    init(allMembers: Bool = false, groupIds: [String] = [], userIds: [String] = []) {
        self.allMembers = allMembers
        self.groupIds = groupIds
        self.userIds = userIds
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        allMembers = try c.decodeIfPresent(Bool.self, forKey: .allMembers) ?? false
        groupIds = try c.decodeIfPresent([String].self, forKey: .groupIds) ?? []
        userIds = try c.decodeIfPresent([String].self, forKey: .userIds) ?? []
    }
}

/// Due `afterDays` days after the posting day (0–30) at `time`, in the post's zone.
struct CollectDue: Codable, Equatable, Hashable {
    var afterDays: Int
    var time: String
}

struct CollectSpec: Codable, Equatable, Hashable {
    var targets: CollectTargets
    var due: CollectDue

    var json: JSONValue {
        .object([
            "targets": .object([
                "all_members": .bool(targets.allMembers),
                "group_ids": .array(targets.groupIds.map(JSONValue.string)),
                "user_ids": .array(targets.userIds.map(JSONValue.string)),
            ]),
            "due": .object(["after_days": .number(Double(due.afterDays)), "time": .string(due.time)]),
        ])
    }
}

/// GET /channels/{id}/recurring-posts (anyone who reads the channel), and the answers to the changes.
struct RecurringPostOut: Identifiable, Equatable, Hashable {
    let id: String
    let channelId: String
    var botUserId: String
    var createdBy: String
    var name: String
    var body: String
    var schedule: RecurringSchedule
    var tz: String
    var collect: CollectSpec?
    var enabled: Bool
    var nextRunAt: String
    var lastRunAt: String?
    var createdAt: String
    var updatedAt: String
}

extension RecurringPostOut: Decodable {
    private enum CodingKeys: String, CodingKey {
        case id, channelId, botUserId, createdBy, name, body, schedule, tz, collect, enabled, nextRunAt, lastRunAt, createdAt, updatedAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        channelId = try c.decodeIfPresent(String.self, forKey: .channelId) ?? ""
        botUserId = try c.decodeIfPresent(String.self, forKey: .botUserId) ?? ""
        createdBy = try c.decodeIfPresent(String.self, forKey: .createdBy) ?? ""
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        body = try c.decodeIfPresent(String.self, forKey: .body) ?? ""
        schedule = try c.decodeIfPresent(RecurringSchedule.self, forKey: .schedule) ?? RecurringSchedule(kind: "weekly", time: "")
        tz = try c.decodeIfPresent(String.self, forKey: .tz) ?? ""
        collect = try? c.decodeIfPresent(CollectSpec.self, forKey: .collect)
        enabled = try c.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
        nextRunAt = try c.decodeIfPresent(String.self, forKey: .nextRunAt) ?? ""
        lastRunAt = try c.decodeIfPresent(String.self, forKey: .lastRunAt)
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt) ?? ""
        updatedAt = try c.decodeIfPresent(String.self, forKey: .updatedAt) ?? ""
    }
}

/// POST /channels/{id}/recurring-posts.
struct RecurringPostCreate: Equatable {
    var name: String
    var body: String
    var schedule: RecurringSchedule
    var tz: String
    var collect: CollectSpec?
    var enabled = true

    var json: JSONValue {
        .object(["name": .string(name), "body": .string(body), "schedule": schedule.json, "tz": .string(tz),
                 "collect": collect?.json ?? .null, "enabled": .bool(enabled)])
    }
}

/// PATCH /recurring-posts/{id}: fields left out stay. `collect` is a double optional: `.some(nil)` turns collecting off
/// (null), nil leaves it out.
struct RecurringPostPatch: Equatable {
    var name: String?
    var body: String?
    var schedule: RecurringSchedule?
    var tz: String?
    var collect: CollectSpec??
    var enabled: Bool?

    var json: JSONValue {
        var fields: [String: JSONValue] = [:]
        if let name { fields["name"] = .string(name) }
        if let body { fields["body"] = .string(body) }
        if let schedule { fields["schedule"] = schedule.json }
        if let tz { fields["tz"] = .string(tz) }
        if let collect { fields["collect"] = collect?.json ?? .null }
        if let enabled { fields["enabled"] = .bool(enabled) }
        return .object(fields)
    }
}

/// The calls the 「定期投稿」 screens make (ApiClient and the test fakes).
@MainActor
protocol RecurringApi: AnyObject {
    func recurringPosts(channelId: String) async throws -> [RecurringPostOut]
    func createRecurringPost(channelId: String, _ body: RecurringPostCreate) async throws -> RecurringPostOut
    func updateRecurringPost(id: String, _ patch: RecurringPostPatch) async throws -> RecurringPostOut
    func deleteRecurringPost(id: String) async throws
    func runRecurringPost(id: String) async throws -> RecurringRunOut
    /// The form's 「提出する人」 are the channel's members.
    func members(channelId: String) async throws -> [MemberOut]
}

/// POST /recurring-posts/{id}/run: the message just posted.
struct RecurringRunOut: Codable, Equatable {
    let messageId: String
}

/// `MessageOut.collection` (only on a post that collects; nil from a server before M59): the targets fixed when it went
/// out, who of them has a live reply in the thread, the due time and when the nudges went out.
struct CollectionOut: Codable, Equatable, Hashable {
    var dueAt: String
    var targetUserIds: [String]
    var targetCount: Int
    var submittedUserIds: [String]
    var remindedAt: String?

    enum CodingKeys: String, CodingKey { case dueAt, targetUserIds, targetCount, submittedUserIds, remindedAt }

    init(dueAt: String, targetUserIds: [String], targetCount: Int? = nil, submittedUserIds: [String], remindedAt: String? = nil) {
        self.dueAt = dueAt
        self.targetUserIds = targetUserIds
        self.targetCount = targetCount ?? targetUserIds.count
        self.submittedUserIds = submittedUserIds
        self.remindedAt = remindedAt
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        dueAt = try c.decodeIfPresent(String.self, forKey: .dueAt) ?? ""
        targetUserIds = try c.decodeIfPresent([String].self, forKey: .targetUserIds) ?? []
        targetCount = try c.decodeIfPresent(Int.self, forKey: .targetCount) ?? targetUserIds.count
        submittedUserIds = try c.decodeIfPresent([String].self, forKey: .submittedUserIds) ?? []
        remindedAt = try c.decodeIfPresent(String.self, forKey: .remindedAt)
    }
}
