import Foundation

// M66 (docs/AI.md §5): the AI types the phones read. Decoded leniently: a field the server adds is ignored, one it
// leaves out takes a harmless default, so a server a little ahead or behind still shows what it can.

/// An AI bot as everyone sees it (`AiAgentPublic`).
struct AiAgentPublic: Decodable, Equatable {
    let id: String
    let botUserId: String
    var name: String
    var model: String?

    init(id: String, botUserId: String, name: String, model: String? = nil) {
        self.id = id
        self.botUserId = botUserId
        self.name = name
        self.model = model
    }

    enum CodingKeys: String, CodingKey { case id, botUserId, name, model }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        botUserId = try c.decode(String.self, forKey: .botUserId)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        model = try c.decodeIfPresent(String.self, forKey: .model)
    }
}

/// GET /ai/status. `available`: a key and at least one enabled bot; `summaryAvailable`: that and budget left this month.
struct AiStatusOut: Decodable, Equatable {
    var available: Bool
    var summaryAvailable: Bool
    var agents: [AiAgentPublic]

    init(available: Bool, summaryAvailable: Bool, agents: [AiAgentPublic]) {
        self.available = available
        self.summaryAvailable = summaryAvailable
        self.agents = agents
    }

    /// A server without AI (GET /ai/status 404) or one that said no: every AI entry point hidden.
    static let unavailable = AiStatusOut(available: false, summaryAvailable: false, agents: [])

    enum CodingKeys: String, CodingKey { case available, summaryAvailable, agents }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        available = try c.decodeIfPresent(Bool.self, forKey: .available) ?? false
        summaryAvailable = try c.decodeIfPresent(Bool.self, forKey: .summaryAvailable) ?? false
        // One malformed agent does not hide the others.
        agents = (try? c.decodeIfPresent([Lenient<AiAgentPublic>].self, forKey: .agents))?.compactMap(\.value) ?? []
    }
}

/// An element that may fail to decode on its own.
private struct Lenient<T: Decodable>: Decodable {
    let value: T?
    init(from decoder: Decoder) throws { value = try? T(from: decoder) }
}

/// One AI run (`AiRunOut`): a summary the phone asked for (a mention's run sends no events to the phones).
struct AiRunOut: Decodable, Equatable {
    let id: String
    var kind: String
    /// "pending" | "running" | "done" | "failed" (an unknown status counts as still working).
    var status: String
    var channelId: String
    var threadId: String?
    var scope: String?
    var days: Int?
    /// Markdown, once done.
    var output: String?
    var error: String?
    var omittedCount: Int
    var createdAt: String
    var finishedAt: String?
    /// Review v0.1.18 #2: where the run is sent ("anthropic" | "openai"), fixed when it was asked for. nil on an older server.
    var provider: String?
    var model: String?

    init(id: String, kind: String = "summary", status: String, channelId: String, threadId: String? = nil, scope: String? = nil,
         days: Int? = nil, output: String? = nil, error: String? = nil, omittedCount: Int = 0, createdAt: String = "", finishedAt: String? = nil,
         provider: String? = nil, model: String? = nil) {
        self.id = id
        self.kind = kind
        self.status = status
        self.channelId = channelId
        self.threadId = threadId
        self.scope = scope
        self.days = days
        self.output = output
        self.error = error
        self.omittedCount = omittedCount
        self.createdAt = createdAt
        self.finishedAt = finishedAt
        self.provider = provider
        self.model = model
    }

    enum CodingKeys: String, CodingKey {
        case id, kind, status, channelId, threadId, scope, days, output, error, omittedCount, createdAt, finishedAt, provider, model
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? "summary"
        status = try c.decodeIfPresent(String.self, forKey: .status) ?? "pending"
        channelId = try c.decodeIfPresent(String.self, forKey: .channelId) ?? ""
        threadId = try c.decodeIfPresent(String.self, forKey: .threadId)
        scope = try c.decodeIfPresent(String.self, forKey: .scope)
        days = try c.decodeIfPresent(Int.self, forKey: .days)
        output = try c.decodeIfPresent(String.self, forKey: .output)
        error = try c.decodeIfPresent(String.self, forKey: .error)
        omittedCount = (try? c.decodeIfPresent(Int.self, forKey: .omittedCount)) ?? 0
        createdAt = try c.decodeIfPresent(String.self, forKey: .createdAt) ?? ""
        finishedAt = try c.decodeIfPresent(String.self, forKey: .finishedAt)
        provider = try? c.decodeIfPresent(String.self, forKey: .provider)
        model = try? c.decodeIfPresent(String.self, forKey: .model)
    }

    var isFinished: Bool { status == "done" || status == "failed" }
}

/// GET /ai/summaries/target?channel_id= (review v0.1.18 #2, docs/AI.md §5): where a summary of this conversation would
/// go, shown under the 「要約」 choices. `reason` (ai_unavailable / ai_private_not_allowed / ai_budget_exceeded) when it
/// cannot be asked for now. Lenient: a missing field is nil (and `available` true, so nothing is disabled by mistake).
struct AiSummaryTargetOut: Decodable, Equatable {
    var available: Bool
    var provider: String?
    var model: String?
    var agentName: String?
    var reason: String?

    init(available: Bool, provider: String? = nil, model: String? = nil, agentName: String? = nil, reason: String? = nil) {
        self.available = available
        self.provider = provider
        self.model = model
        self.agentName = agentName
        self.reason = reason
    }

    enum CodingKeys: String, CodingKey { case available, provider, model, agentName, reason }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        available = (try? c.decodeIfPresent(Bool.self, forKey: .available)) ?? true
        provider = try? c.decodeIfPresent(String.self, forKey: .provider)
        model = try? c.decodeIfPresent(String.self, forKey: .model)
        agentName = try? c.decodeIfPresent(String.self, forKey: .agentName)
        reason = try? c.decodeIfPresent(String.self, forKey: .reason)
    }
}

/// What to summarize (POST /ai/summaries).
enum AiSummaryScope: Equatable {
    /// After my read position (the server takes the last day when there is none).
    case unread
    /// The last `days` days (1–7).
    case recent(days: Int)
    /// One whole thread (its parent's id).
    case thread(parentId: String)
}

/// One tap on 「要約」: the sheet's item (each tap a new id, so the same choice twice opens a fresh sheet).
struct AiSummaryRequest: Identifiable, Equatable {
    let id: String
    let channelId: String
    let scope: AiSummaryScope
    /// Minutes east of UTC (search's convention): where 「直近 1 日」 and the unread fallback start.
    var tzOffsetMinutes: Int

    init(channelId: String, scope: AiSummaryScope, id: String = UUID().uuidString.lowercased(),
         tzOffsetMinutes: Int = TimeZone.current.secondsFromGMT() / 60) {
        self.id = id
        self.channelId = channelId
        self.scope = scope
        self.tzOffsetMinutes = tzOffsetMinutes
    }

    var json: JSONValue {
        var fields: [String: JSONValue] = ["channel_id": .string(channelId), "tz_offset_minutes": .number(Double(tzOffsetMinutes))]
        switch scope {
        case .unread:
            fields["scope"] = .string("unread")
        case .recent(let days):
            fields["scope"] = .string("recent")
            fields["days"] = .number(Double(days))
        case .thread(let parentId):
            fields["scope"] = .string("thread")
            fields["thread_id"] = .string(parentId)
        }
        return .object(fields)
    }
}
