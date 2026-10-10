import Foundation

// M66 (docs/AI.md §5): the AI types the phones read. Decoded leniently: a field the server adds is ignored, one it
// leaves out takes a harmless default, so a server a little ahead or behind still shows what it can.

/// An AI bot as everyone sees it (`AiAgentPublic`).
struct AiAgentPublic: Decodable, Equatable {
    let id: String
    let botUserId: String
    var name: String
    var model: String?
    /// docs/AI.md §14: its mention replies may search the web (for the notice). False on an older server.
    var webSearch: Bool

    init(id: String, botUserId: String, name: String, model: String? = nil, webSearch: Bool = false) {
        self.id = id
        self.botUserId = botUserId
        self.name = name
        self.model = model
        self.webSearch = webSearch
    }

    enum CodingKeys: String, CodingKey { case id, botUserId, name, model, webSearch }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        botUserId = try c.decode(String.self, forKey: .botUserId)
        name = try c.decodeIfPresent(String.self, forKey: .name) ?? ""
        model = try c.decodeIfPresent(String.self, forKey: .model)
        webSearch = try c.decodeIfPresent(Bool.self, forKey: .webSearch) ?? false
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

/// One AI run (`AiRunOut`): a summary or a question (M71, kind "ask") the phone asked for (a mention's run sends no
/// events to the phones).
struct AiRunOut: Decodable, Equatable {
    let id: String
    var kind: String
    /// "pending" | "running" | "done" | "failed" (an unknown status counts as still working).
    var status: String
    /// "" for a question not narrowed to one conversation (the server sends null).
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
    /// M71 (docs/AI.md §13.5): a question's words (nil for the other kinds, and on an older server).
    var question: String?
    /// M71: the messages a done question's answer cites as [n] (empty otherwise, and on an older server).
    var sources: [AiSourceOut]

    init(id: String, kind: String = "summary", status: String, channelId: String, threadId: String? = nil, scope: String? = nil,
         days: Int? = nil, output: String? = nil, error: String? = nil, omittedCount: Int = 0, createdAt: String = "", finishedAt: String? = nil,
         provider: String? = nil, model: String? = nil, question: String? = nil, sources: [AiSourceOut] = []) {
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
        self.question = question
        self.sources = sources
    }

    enum CodingKeys: String, CodingKey {
        case id, kind, status, channelId, threadId, scope, days, output, error, omittedCount, createdAt, finishedAt, provider, model, question, sources
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
        question = try? c.decodeIfPresent(String.self, forKey: .question)
        // One malformed source does not hide the others.
        sources = (try? c.decodeIfPresent([Lenient<AiSourceOut>].self, forKey: .sources))?.compactMap(\.value) ?? []
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

/// GET /ai/ask/target?q=&channel_id= (M71, docs/AI.md §13.5): the same shape and reasons as the summary's target.
typealias AiAskTargetOut = AiSummaryTargetOut

/// M71 (docs/AI.md §13.3): a message a question's answer cites as [n]. Lenient: only `n` and `message_id` are needed.
struct AiSourceOut: Decodable, Equatable {
    var n: Int
    var messageId: String
    var channelId: String
    var parentId: String?
    var senderId: String
    var createdAt: String
    /// Plain text around the first matching word.
    var excerpt: String

    init(n: Int, messageId: String, channelId: String, parentId: String? = nil, senderId: String = "", createdAt: String = "", excerpt: String = "") {
        self.n = n
        self.messageId = messageId
        self.channelId = channelId
        self.parentId = parentId
        self.senderId = senderId
        self.createdAt = createdAt
        self.excerpt = excerpt
    }

    enum CodingKeys: String, CodingKey { case n, messageId, channelId, parentId, senderId, createdAt, excerpt }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        n = try c.decode(Int.self, forKey: .n)
        messageId = try c.decode(String.self, forKey: .messageId)
        channelId = (try? c.decodeIfPresent(String.self, forKey: .channelId)) ?? ""
        parentId = try? c.decodeIfPresent(String.self, forKey: .parentId)
        senderId = (try? c.decodeIfPresent(String.self, forKey: .senderId)) ?? ""
        createdAt = (try? c.decodeIfPresent(String.self, forKey: .createdAt)) ?? ""
        excerpt = (try? c.decodeIfPresent(String.self, forKey: .excerpt)) ?? ""
    }
}

/// One tap on 「AI に聞く」 (POST /ai/ask): the question with its modifiers, and the conversation the search is narrowed
/// to (each tap a new id, so a retry is a fresh request).
struct AiAskRequest: Identifiable, Equatable {
    let id: String
    let question: String
    let channelId: String?
    /// Minutes east of UTC (search's convention): the days of typed before: / after: and the sources' times.
    var tzOffsetMinutes: Int

    init(question: String, channelId: String? = nil, id: String = UUID().uuidString.lowercased(),
         tzOffsetMinutes: Int = TimeZone.current.secondsFromGMT() / 60) {
        self.id = id
        self.question = question
        self.channelId = channelId
        self.tzOffsetMinutes = tzOffsetMinutes
    }

    var json: JSONValue {
        var fields: [String: JSONValue] = ["q": .string(question), "tz_offset_minutes": .number(Double(tzOffsetMinutes))]
        if let channelId { fields["channel_id"] = .string(channelId) }
        return .object(fields)
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
