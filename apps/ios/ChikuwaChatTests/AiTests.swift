import XCTest
@testable import ChikuwaChat

/// A fake of the AI calls: the status, the runs POST makes, what GET /ai/runs/{id} answers.
@MainActor
final class FakeAiApi: AiApi {
    var status: Result<AiStatusOut, Error> = .success(.unavailable)
    var createResult: Result<AiRunOut, Error> = .success(AiRunOut(id: "r1", status: "pending", channelId: "c1"))
    var runs: [String: AiRunOut] = [:]
    /// Runs before POST /ai/summaries answers (an event arriving first).
    var beforeCreateAnswers: (() -> Void)?
    private(set) var created: [AiSummaryRequest] = []
    private(set) var statusReads = 0
    private(set) var runReads: [String] = []
    /// GET /ai/summaries/target (default: a server without the route).
    var target: Result<AiSummaryTargetOut, Error> = .failure(ApiError.api(status: 404, code: "http_404", message: ""))
    private(set) var targetReads: [String] = []

    func aiStatus() async throws -> AiStatusOut {
        statusReads += 1
        return try status.get()
    }

    func createSummary(_ request: AiSummaryRequest) async throws -> AiRunOut {
        created.append(request)
        beforeCreateAnswers?()
        return try createResult.get()
    }

    func summaryTarget(channelId: String) async throws -> AiSummaryTargetOut {
        targetReads.append(channelId)
        return try target.get()
    }

    // M71 「AI に聞く」
    var askResult: Result<AiRunOut, Error> = .success(AiRunOut(id: "q1", kind: "ask", status: "pending", channelId: ""))
    var beforeAskAnswers: (() -> Void)?
    private(set) var asked: [AiAskRequest] = []
    var askTargetResult: Result<AiAskTargetOut, Error> = .failure(ApiError.api(status: 404, code: "http_404", message: ""))
    private(set) var askTargetReads: [String] = []
    var history: Result<[AiRunOut], Error> = .success([])
    private(set) var historyReads: [String] = []

    func createAsk(_ request: AiAskRequest) async throws -> AiRunOut {
        asked.append(request)
        beforeAskAnswers?()
        return try askResult.get()
    }

    func askTarget(question: String, channelId: String?) async throws -> AiAskTargetOut {
        askTargetReads.append("\(question)|\(channelId ?? "")")
        return try askTargetResult.get()
    }

    func aiRuns(kind: String) async throws -> [AiRunOut] {
        historyReads.append(kind)
        return try history.get()
    }

    func aiRun(id: String) async throws -> AiRunOut {
        runReads.append(id)
        guard let run = runs[id] else { throw ApiError.api(status: 404, code: "ai_run_not_found", message: "") }
        return run
    }
}

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSON.snakeDecoder.decode(T.self, from: Data(json.utf8))
}

private func runEvent(_ run: AiRunOut) -> JSONValue {
    var fields: [String: JSONValue] = [
        "id": .string(run.id), "kind": .string(run.kind), "status": .string(run.status), "channel_id": .string(run.channelId),
        "omitted_count": .number(Double(run.omittedCount)), "created_at": .string(run.createdAt), "unknown_field": .bool(true),
    ]
    if let output = run.output { fields["output"] = .string(output) }
    if let error = run.error { fields["error"] = .string(error) }
    return .object(["run": .object(fields)])
}

final class AiDecodingTests: XCTestCase {
    func testStatusDecodesAndIgnoresUnknownFields() throws {
        let status = try decode(AiStatusOut.self, """
        {"available": true, "summary_available": false, "future": 1,
         "agents": [{"id": "a1", "bot_user_id": "u-bot", "name": "ちくわ", "model": "claude-opus-5-5", "extra": "x"},
                    {"id": "broken"},
                    {"id": "a2", "bot_user_id": "u-bot2", "name": "はんぺん"}]}
        """)
        XCTAssertTrue(status.available)
        XCTAssertFalse(status.summaryAvailable)
        // The malformed agent is dropped, the others kept; a missing model is fine.
        XCTAssertEqual(status.agents, [AiAgentPublic(id: "a1", botUserId: "u-bot", name: "ちくわ", model: "claude-opus-5-5"),
                                       AiAgentPublic(id: "a2", botUserId: "u-bot2", name: "はんぺん")])
    }

    func testStatusWithMissingFieldsIsUnavailable() throws {
        XCTAssertEqual(try decode(AiStatusOut.self, "{}"), .unavailable)
    }

    func testRunDecodesNullsAndDefaults() throws {
        let run = try decode(AiRunOut.self, """
        {"id": "r1", "kind": "summary", "status": "done", "channel_id": "c1", "thread_id": null, "scope": "recent", "days": 7,
         "output": "## まとめ\\n- 決定", "error": null, "omitted_count": 12, "created_at": "2026-10-02T00:00:00Z",
         "finished_at": "2026-10-02T00:00:09Z", "cost_usd": 0.01}
        """)
        XCTAssertEqual(run.status, "done")
        XCTAssertEqual(run.days, 7)
        XCTAssertEqual(run.omittedCount, 12)
        XCTAssertEqual(run.output, "## まとめ\n- 決定")
        XCTAssertNil(run.threadId)
        XCTAssertTrue(run.isFinished)
        let bare = try decode(AiRunOut.self, #"{"id": "r2"}"#)
        XCTAssertEqual(bare.status, "pending")
        XCTAssertEqual(bare.omittedCount, 0)
        XCTAssertFalse(bare.isFinished)
    }

    func testRunProviderAndModelAreLenient() throws {
        let run = try decode(AiRunOut.self, #"{"id": "r1", "status": "done", "provider": "openai", "model": "gpt-6.1-sol"}"#)
        XCTAssertEqual(run.provider, "openai")
        XCTAssertEqual(run.model, "gpt-6.1-sol")
        let old = try decode(AiRunOut.self, #"{"id": "r2", "provider": null}"#)
        XCTAssertNil(old.provider)
        XCTAssertNil(old.model)
    }

    func testSummaryTargetDecodesLeniently() throws {
        let target = try decode(AiSummaryTargetOut.self, #"{"available": false, "provider": "anthropic", "model": "claude-opus-5-5", "agent_name": "ちくわ", "reason": "ai_private_not_allowed", "extra": 1}"#)
        XCTAssertEqual(target, AiSummaryTargetOut(available: false, provider: "anthropic", model: "claude-opus-5-5", agentName: "ちくわ",
                                                  reason: "ai_private_not_allowed"))
        XCTAssertEqual(try decode(AiSummaryTargetOut.self, "{}"), AiSummaryTargetOut(available: true))
    }

    func testRequestBodies() {
        let unread = AiSummaryRequest(channelId: "c1", scope: .unread, id: "x", tzOffsetMinutes: 540)
        XCTAssertEqual(unread.json, .object(["channel_id": .string("c1"), "scope": .string("unread"), "tz_offset_minutes": .number(540)]))
        let recent = AiSummaryRequest(channelId: "c1", scope: .recent(days: 7), id: "x", tzOffsetMinutes: 0)
        XCTAssertEqual(recent.json["scope"], .string("recent"))
        XCTAssertEqual(recent.json["days"], .number(7))
        XCTAssertNil(recent.json["thread_id"])
        let thread = AiSummaryRequest(channelId: "c1", scope: .thread(parentId: "p1"), id: "x", tzOffsetMinutes: -300)
        XCTAssertEqual(thread.json["scope"], .string("thread"))
        XCTAssertEqual(thread.json["thread_id"], .string("p1"))
        XCTAssertEqual(thread.json["tz_offset_minutes"], .number(-300))
        XCTAssertNil(thread.json["days"])
    }
}

final class AiRulesTests: XCTestCase {
    func testErrorTexts() {
        XCTAssertEqual(AiRules.errorText(ApiError.api(status: 409, code: "ai_unavailable", message: "")), AiRules.byCode["ai_unavailable"])
        XCTAssertEqual(AiRules.errorText(ApiError.api(status: 429, code: "ai_budget_exceeded", message: "")), "今月の AI の予算の上限に達しました。来月まで要約は使えません")
        XCTAssertEqual(AiRules.errorText(ApiError.api(status: 429, code: "ai_daily_limit", message: "")), "今日の AI の利用回数の上限に達しました。明日またお試しください")
        XCTAssertEqual(AiRules.errorText(ApiError.network(URLError(.notConnectedToInternet))), ErrorMessages.network)
        // Anything else is worded as every other error (never the server's English).
        XCTAssertEqual(AiRules.errorText(ApiError.api(status: 404, code: "channel_not_found", message: "Channel not found")),
                       ErrorMessages.text(for: ApiError.api(status: 404, code: "channel_not_found", message: "")))
        XCTAssertTrue(AiRules.refreshesStatus(ApiError.api(status: 409, code: "ai_unavailable", message: "")))
        XCTAssertTrue(AiRules.refreshesStatus(ApiError.api(status: 429, code: "ai_budget_exceeded", message: "")))
        XCTAssertFalse(AiRules.refreshesStatus(ApiError.api(status: 429, code: "ai_daily_limit", message: "")))
    }

    func testWords() {
        XCTAssertEqual(AiRules.title(.unread), "未読の要約")
        XCTAssertEqual(AiRules.title(.recent(days: 1)), "直近 1 日の要約")
        XCTAssertEqual(AiRules.title(.recent(days: 7)), "直近 7 日の要約")
        XCTAssertEqual(AiRules.title(.thread(parentId: "p")), "スレッドの要約")
        XCTAssertNil(AiRules.omittedNote(0))
        XCTAssertEqual(AiRules.omittedNote(3), "古い 3 件は省きました")
        XCTAssertEqual(AiRules.runFailureText(nil), "要約できませんでした")
        XCTAssertEqual(AiRules.runFailureText(" 断られました "), "要約できませんでした：断られました")
        XCTAssertNil(AiRules.notice([]))
        XCTAssertEqual(AiRules.notice([AiAgentPublic(id: "a", botUserId: "b", name: "ちくわ"), AiAgentPublic(id: "c", botUserId: "d", name: "はんぺん")]),
                       "AI（ちくわ・はんぺん）が参加しています。メンションしたときと要約のときに、会話の一部が Anthropic の API に送られます")
        XCTAssertEqual(AiRules.notice([AiAgentPublic(id: "a", botUserId: "b", name: "そる", model: "gpt-6.1-sol")]),
                       "AI（そる）が参加しています。メンションしたときと要約のときに、会話の一部が OpenAI の API に送られます")
        XCTAssertTrue(AiRules.notice([AiAgentPublic(id: "a", botUserId: "b", name: "ちくわ", model: "claude-opus-5-5"),
                                      AiAgentPublic(id: "c", botUserId: "d", name: "そる", model: "gpt-6.1-sol")])!.contains("Anthropic と OpenAI の API"))
    }

    func testSummaryTargetLine() {
        XCTAssertEqual(AiRules.targetLine(AiSummaryTargetOut(available: true, provider: "anthropic", model: "claude-opus-5-5", agentName: "ちくわ")),
                       "要約は ちくわ（Anthropic）に送られます")
        XCTAssertEqual(AiRules.targetLine(AiSummaryTargetOut(available: true, provider: "openai", model: "gpt-6.1-sol", agentName: "そる")),
                       "要約は そる（OpenAI）に送られます")
        XCTAssertEqual(AiRules.targetLine(AiSummaryTargetOut(available: true, provider: "openai")), "要約は OpenAI に送られます")
        XCTAssertNil(AiRules.targetLine(AiSummaryTargetOut(available: true)))
        XCTAssertFalse(AiRules.choicesDisabled(AiSummaryTargetOut(available: true, provider: "openai")))
        XCTAssertFalse(AiRules.choicesDisabled(nil))  // an older server: as before
    }

    func testUnavailableTargetsDisableTheChoicesWithTheReason() {
        for reason in ["ai_unavailable", "ai_budget_exceeded", "ai_private_not_allowed"] {
            let target = AiSummaryTargetOut(available: false, provider: reason == "ai_unavailable" ? nil : "anthropic", reason: reason)
            XCTAssertTrue(AiRules.choicesDisabled(target), reason)
            XCTAssertEqual(AiRules.targetLine(target), ErrorMessages.byCode[reason], reason)
            XCTAssertNotNil(ErrorMessages.byCode[reason], reason)
        }
        XCTAssertEqual(AiRules.targetLine(AiSummaryTargetOut(available: false, reason: "new_reason")), "今は要約できません")
    }

    func testRunCaption() {
        XCTAssertEqual(AiRules.runCaption(AiRunOut(id: "r", status: "done", channelId: "c", provider: "openai", model: "gpt-6.1-sol")), "OpenAI · gpt-6.1-sol")
        XCTAssertEqual(AiRules.runCaption(AiRunOut(id: "r", status: "done", channelId: "c", provider: "anthropic", model: "claude-haiku-4-5")),
                       "Anthropic · claude-haiku-4-5")
        XCTAssertNil(AiRules.runCaption(AiRunOut(id: "r", status: "done", channelId: "c")))  // an older server
    }

    func testMentionCandidatesMarkAiBots() {
        let bot = UserPublic(id: "u-bot", username: "ai-chikuwa", displayName: "ちくわ", role: "bot", deactivatedAt: nil, createdAt: "", updatedAt: "")
        let hook = UserPublic(id: "u-hook", username: "ai-hook", displayName: "Webhook", role: "bot", deactivatedAt: nil, createdAt: "", updatedAt: "")
        let found = Mentions.candidates("ai", users: [bot, hook], aiBotIds: ["u-bot"])
        XCTAssertEqual(found.map(\.kind), ["ai", "user"])
        XCTAssertEqual(Mentions.candidates("ai", users: [bot]).map(\.kind), ["user"])
    }
}

@MainActor
final class AiHubTests: XCTestCase {
    private let agent = AiAgentPublic(id: "a1", botUserId: "u-bot", name: "ちくわ")

    func testStatusAvailableUnavailableAndOldServer() async {
        let api = FakeAiApi()
        let hub = AiHub(api: api)
        XCTAssertNil(hub.status)
        XCTAssertFalse(hub.available)
        api.status = .success(AiStatusOut(available: true, summaryAvailable: true, agents: [agent]))
        await hub.refreshStatus()
        XCTAssertTrue(hub.available)
        XCTAssertTrue(hub.summaryAvailable)
        XCTAssertTrue(hub.isAiBot("u-bot"))
        XCTAssertFalse(hub.isAiBot("u-other"))
        XCTAssertEqual(hub.agents(among: ["u-x", "u-bot"]), [agent])
        // A failure on the way keeps what was known.
        api.status = .failure(ApiError.network(URLError(.timedOut)))
        await hub.refreshStatus()
        XCTAssertTrue(hub.available)
        // A server before M65: 404, every entry point hidden.
        api.status = .failure(ApiError.api(status: 404, code: "not_found", message: ""))
        await hub.refreshStatus()
        XCTAssertEqual(hub.status, .unavailable)
        XCTAssertFalse(hub.isAiBot("u-bot"))
        // No AI API at all (a test fake engine): nothing, quietly.
        let none = AiHub(api: nil)
        await none.refreshStatus()
        XCTAssertNil(none.status)
    }

    func testASummaryGoesPendingRunningDoneAndNeverBack() async {
        let api = FakeAiApi()
        let hub = AiHub(api: api)
        let request = AiSummaryRequest(channelId: "c1", scope: .recent(days: 1))
        await hub.startSummary(request)
        XCTAssertEqual(api.created, [request])
        XCTAssertEqual(hub.summary?.phase, .working(running: false))
        hub.applyEvent(runEvent(AiRunOut(id: "r1", status: "running", channelId: "c1")))
        XCTAssertEqual(hub.summary?.phase, .working(running: true))
        hub.applyEvent(runEvent(AiRunOut(id: "other", status: "done", channelId: "c1", output: "別")))  // not this sheet's
        XCTAssertEqual(hub.summary?.phase, .working(running: true))
        hub.applyEvent(runEvent(AiRunOut(id: "r1", status: "done", channelId: "c1", output: "## 要約", omittedCount: 4)))
        XCTAssertEqual(hub.summary?.phase, .done(output: "## 要約", omittedCount: 4))
        hub.applyEvent(runEvent(AiRunOut(id: "r1", status: "running", channelId: "c1")))  // late, out of order
        XCTAssertEqual(hub.summary?.phase, .done(output: "## 要約", omittedCount: 4))
        hub.closeSummary()
        XCTAssertNil(hub.summary)
    }

    func testAnEventBeforeThePostAnswersIsKept() async {
        let api = FakeAiApi()
        let hub = AiHub(api: api)
        api.beforeCreateAnswers = { hub.applyEvent(runEvent(AiRunOut(id: "r1", status: "running", channelId: "c1"))) }
        await hub.startSummary(AiSummaryRequest(channelId: "c1", scope: .unread))
        XCTAssertEqual(hub.summary?.phase, .working(running: true))
    }

    func testAFailedRunShowsItsReason() async {
        let api = FakeAiApi()
        let hub = AiHub(api: api)
        await hub.startSummary(AiSummaryRequest(channelId: "c1", scope: .unread))
        hub.applyEvent(runEvent(AiRunOut(id: "r1", status: "failed", channelId: "c1", error: "API のエラーが続きました")))
        XCTAssertEqual(hub.summary?.phase, .failed("要約できませんでした：API のエラーが続きました"))
    }

    func testRefusalsAreWordedAndRefreshTheStatus() async {
        let api = FakeAiApi()
        api.status = .success(AiStatusOut(available: true, summaryAvailable: true, agents: [agent]))
        let hub = AiHub(api: api)
        await hub.refreshStatus()
        api.status = .success(AiStatusOut(available: true, summaryAvailable: false, agents: [agent]))
        api.createResult = .failure(ApiError.api(status: 429, code: "ai_budget_exceeded", message: "budget"))
        await hub.startSummary(AiSummaryRequest(channelId: "c1", scope: .unread))
        XCTAssertEqual(hub.summary?.phase, .failed(AiRules.byCode["ai_budget_exceeded"]!))
        XCTAssertEqual(api.statusReads, 2)
        XCTAssertFalse(hub.summaryAvailable)  // the menus hide 「要約」 now

        api.createResult = .failure(ApiError.api(status: 429, code: "ai_daily_limit", message: ""))
        await hub.retrySummary()
        XCTAssertEqual(hub.summary?.phase, .failed(AiRules.byCode["ai_daily_limit"]!))
        XCTAssertEqual(api.statusReads, 2)  // a daily limit changes nothing for the others

        api.createResult = .failure(ApiError.network(URLError(.notConnectedToInternet)))
        await hub.retrySummary()
        XCTAssertEqual(hub.summary?.phase, .failed(ErrorMessages.network))

        // 「もう一度」 that works: the same choice, a fresh request.
        api.createResult = .success(AiRunOut(id: "r2", status: "pending", channelId: "c1"))
        await hub.retrySummary()
        XCTAssertEqual(hub.summary?.phase, .working(running: false))
        XCTAssertEqual(api.created.count, 4)
        XCTAssertEqual(Set(api.created.map(\.id)).count, 4)
        XCTAssertEqual(api.created.last?.scope, .unread)
    }

    func testClosingWhileThePostIsOnItsWayDropsTheAnswer() async {
        let api = FakeAiApi()
        let hub = AiHub(api: api)
        api.beforeCreateAnswers = { hub.closeSummary() }
        await hub.startSummary(AiSummaryRequest(channelId: "c1", scope: .unread))
        XCTAssertNil(hub.summary)
    }

    func testReconnectingReadsTheOpenRunAgain() async {
        let api = FakeAiApi()
        let hub = AiHub(api: api)
        await hub.startSummary(AiSummaryRequest(channelId: "c1", scope: .thread(parentId: "p1")))
        // The done event was missed while offline; after reconnecting the run is read again.
        api.runs["r1"] = AiRunOut(id: "r1", status: "done", channelId: "c1", output: "まとめ")
        await hub.resync()
        XCTAssertEqual(api.runReads, ["r1"])
        XCTAssertEqual(hub.summary?.phase, .done(output: "まとめ", omittedCount: 0))
        // A finished run is not read again.
        await hub.resync()
        XCTAssertEqual(api.runReads, ["r1"])
        // No sheet open: only the status.
        hub.closeSummary()
        await hub.resync()
        XCTAssertEqual(api.runReads, ["r1"])
        XCTAssertEqual(api.statusReads, 3)
    }

    func testSummaryTargetIsReadAndFallsBackOnAnOlderServer() async {
        let api = FakeAiApi()
        let hub = AiHub(api: api)
        await hub.loadTarget("c1")
        XCTAssertNil(hub.target("c1"))  // 404: no line, the choices as before
        let openai = AiSummaryTargetOut(available: true, provider: "openai", model: "gpt-6.1-sol", agentName: "そる")
        api.target = .success(openai)
        await hub.loadTarget("c1")
        XCTAssertEqual(hub.target("c1"), openai)
        XCTAssertNil(hub.target("c2"))
        // A failure forgets it (not a stale line).
        api.target = .failure(ApiError.network(URLError(.timedOut)))
        await hub.loadTarget("c1")
        XCTAssertNil(hub.target("c1"))
        // A refused summary reads the target again (the reason then shows under the choices).
        api.target = .success(AiSummaryTargetOut(available: false, provider: "anthropic", reason: "ai_private_not_allowed"))
        api.createResult = .failure(ApiError.api(status: 409, code: "ai_private_not_allowed", message: ""))
        await hub.startSummary(AiSummaryRequest(channelId: "c1", scope: .unread))
        XCTAssertEqual(api.targetReads, ["c1", "c1", "c1", "c1"])
        XCTAssertTrue(AiRules.choicesDisabled(hub.target("c1")))
        XCTAssertEqual(hub.summary?.phase, .failed(ErrorMessages.byCode["ai_private_not_allowed"]!))
    }

    func testMentionRunsAndUnreadablePayloadsAreIgnored() async {
        let api = FakeAiApi()
        let hub = AiHub(api: api)
        await hub.startSummary(AiSummaryRequest(channelId: "c1", scope: .unread))
        hub.applyEvent(runEvent(AiRunOut(id: "r1", kind: "mention", status: "done", channelId: "c1", output: "x")))
        hub.applyEvent(.object(["run": .string("nonsense")]))
        XCTAssertEqual(hub.summary?.phase, .working(running: false))
    }
}
