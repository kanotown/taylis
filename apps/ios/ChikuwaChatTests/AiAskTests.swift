import XCTest
@testable import ChikuwaChat

// M71 (docs/AI.md §13): 「AI に聞く」 on the phone — the types, the question, the [n] links, the words, the hub's states.

private func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T {
    try JSON.snakeDecoder.decode(T.self, from: Data(json.utf8))
}

private let m1 = "0199a0b0-0000-7000-8000-000000000001"
private let m4 = "0199a0b0-0000-7000-8000-000000000004"

/// ai.run_updated for a question, with a field the phone does not know.
private func askEvent(_ id: String, status: String, output: String? = nil, error: String? = nil, sources: [JSONValue] = []) -> JSONValue {
    var fields: [String: JSONValue] = [
        "id": .string(id), "kind": .string("ask"), "status": .string(status), "channel_id": .null, "omitted_count": .number(0),
        "created_at": .string("2026-10-02T00:00:00Z"), "question": .string("ゼミの日程は?"), "sources": .array(sources), "future": .bool(true),
    ]
    if let output { fields["output"] = .string(output) }
    if let error { fields["error"] = .string(error) }
    return .object(["run": .object(fields)])
}

@MainActor
final class AiAskDecodingTests: XCTestCase {
    func testAskRunDecodesQuestionAndSources() throws {
        let run = try decode(AiRunOut.self, """
        {"id": "q1", "kind": "ask", "status": "done", "channel_id": null, "thread_id": null, "scope": null, "days": null,
         "output": "10/9 です [1]", "error": null, "omitted_count": 2, "created_at": "2026-10-02T00:00:00Z", "finished_at": null,
         "provider": "anthropic", "model": "claude-opus-5-5", "question": "ゼミの日程は? in:#研究室",
         "sources": [{"n": 1, "message_id": "\(m1)", "channel_id": "c1", "parent_id": null, "sender_id": "u1",
                      "created_at": "2026-10-01T03:00:00Z", "excerpt": "ゼミは 10/9 (木)", "extra": 1},
                     {"n": "broken"},
                     {"n": 4, "message_id": "\(m4)", "parent_id": "p1"}]}
        """)
        XCTAssertEqual(run.kind, "ask")
        XCTAssertEqual(run.channelId, "")  // not narrowed to one conversation
        XCTAssertEqual(run.question, "ゼミの日程は? in:#研究室")
        XCTAssertEqual(run.omittedCount, 2)
        // The malformed source is dropped, a sparse one kept with defaults.
        XCTAssertEqual(run.sources, [
            AiSourceOut(n: 1, messageId: m1, channelId: "c1", senderId: "u1", createdAt: "2026-10-01T03:00:00Z", excerpt: "ゼミは 10/9 (木)"),
            AiSourceOut(n: 4, messageId: m4, channelId: "", parentId: "p1"),
        ])
    }

    func testAnOlderServerHasNoQuestionNorSources() throws {
        let run = try decode(AiRunOut.self, #"{"id": "r1", "kind": "summary", "status": "done", "channel_id": "c1"}"#)
        XCTAssertNil(run.question)
        XCTAssertEqual(run.sources, [])
        let odd = try decode(AiRunOut.self, #"{"id": "r2", "question": 3, "sources": "x"}"#)
        XCTAssertNil(odd.question)
        XCTAssertEqual(odd.sources, [])
    }

    func testAskTargetAndRequestBody() throws {
        let target = try decode(AiAskTargetOut.self, #"{"available": true, "provider": "openai", "model": "gpt-6.1-sol", "agent_name": "そる", "reason": null}"#)
        XCTAssertEqual(target, AiAskTargetOut(available: true, provider: "openai", model: "gpt-6.1-sol", agentName: "そる"))
        let narrowed = AiAskRequest(question: "日程 from:@kano", channelId: "c1", id: "x", tzOffsetMinutes: 540)
        XCTAssertEqual(narrowed.json, .object(["q": .string("日程 from:@kano"), "channel_id": .string("c1"), "tz_offset_minutes": .number(540)]))
        let everywhere = AiAskRequest(question: "日程", id: "x", tzOffsetMinutes: -300)
        XCTAssertNil(everywhere.json["channel_id"])
        XCTAssertEqual(everywhere.json["tz_offset_minutes"], .number(-300))
    }

    func testThePathsCarryTheQuestion() {
        let path = ApiClient.pathWithQuery("/api/v1/ai/ask/target", [URLQueryItem(name: "q", value: "C++ の 日程"), URLQueryItem(name: "channel_id", value: "c1")])
        XCTAssertEqual(path, "/api/v1/ai/ask/target?q=C%2B%2B%20%E3%81%AE%20%E6%97%A5%E7%A8%8B&channel_id=c1")
    }
}

final class AskRulesTests: XCTestCase {
    private let base = URL(string: "https://chat.example.jp/")!
    private let sources = [AiSourceOut(n: 1, messageId: m1, channelId: "c1"), AiSourceOut(n: 4, messageId: m4, channelId: "c2", parentId: "p")]

    /// Asked and not answered: the bar spins and 「AI に聞く」 waits (2026-10-06).
    func testAQuestionIsInProgressUntilItIsAnsweredOrFails() {
        XCTAssertTrue(AiAskSession.Phase.starting.inProgress)
        XCTAssertTrue(AiAskSession.Phase.working(running: false).inProgress)
        XCTAssertTrue(AiAskSession.Phase.working(running: true).inProgress)
        XCTAssertFalse(AiAskSession.Phase.done(output: "a", omittedCount: 0, sources: []).inProgress)
        XCTAssertFalse(AiAskSession.Phase.failed("x").inProgress)
    }

    func testCitationsBecomeMessageLinks() {
        let link1 = "[1](https://chat.example.jp/m/\(m1))"
        let link4 = "[4](https://chat.example.jp/m/\(m4))"
        XCTAssertEqual(AskRules.linkCitations("決まりました [1]。", sources: sources, base: base), "決まりました \(link1)。")
        XCTAssertEqual(AskRules.linkCitations("[1][4]", sources: sources, base: base), "\(link1)\(link4)")
        XCTAssertEqual(AskRules.linkCitations("A [1, 4] B [1、4]", sources: sources, base: base), "A \(link1) \(link4) B \(link1) \(link4)")
        // A group with a number that is not a source stays as it was; so does a text with no sources or no server.
        XCTAssertEqual(AskRules.linkCitations("[2] と [1, 2] と [x]", sources: sources, base: base), "[2] と [1, 2] と [x]")
        XCTAssertEqual(AskRules.linkCitations("[1]", sources: [], base: base), "[1]")
        XCTAssertEqual(AskRules.linkCitations("[1]", sources: sources, base: nil), "[1]")
        // The links are this server's permalinks, read back as in-app links, and drawn as 「[n]」.
        let tokens = BodyTokenizer.tokenizeInline(AskRules.linkCitations("答え [4]", sources: sources, base: base))
        XCTAssertEqual(tokens, [.text("答え "), .link("https://chat.example.jp/m/\(m4)", label: "4")])
        XCTAssertEqual(Permalink.messageId(base: base, url: "https://chat.example.jp/m/\(m4)"), m4)
        XCTAssertEqual(AskRules.source(messageId: m4.uppercased(), in: sources)?.n, 4)
        XCTAssertNil(AskRules.source(messageId: "other", in: sources))
    }

    func testTheQuestionCarriesTheChipsAsModifiers() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Tokyo")!
        let now = calendar.date(from: DateComponents(year: 2026, month: 10, day: 2, hour: 15))!
        let users = ["u1": "kano"]
        let usernameOf: (String) -> String? = { users[$0] }
        XCTAssertEqual(AskRules.question(SearchParams(q: "  ゼミの日程は?  "), usernameOf: usernameOf, now: now, calendar: calendar), "ゼミの日程は?")
        // The conversation is not in the words (it goes as channel_id); an unknown sender is left out.
        let all = SearchParams(q: "日程", fromUserId: "u1", channelId: "c1", date: .range(from: "2026-09-01", to: "2026-09-30"),
                               has: [.file, .link], isThread: true, isTimes: true)
        XCTAssertEqual(AskRules.question(all, usernameOf: usernameOf, now: now, calendar: calendar),
                       "日程 from:@kano after:2026-08-31 before:2026-10-01 has:file has:link is:thread is:times")
        XCTAssertEqual(AskRules.question(SearchParams(q: "日程", fromUserId: "u9"), usernameOf: usernameOf, now: now, calendar: calendar), "日程")
        XCTAssertEqual(AskRules.question(SearchParams(q: "x", date: .preset(.yesterday)), usernameOf: usernameOf, now: now, calendar: calendar),
                       "x after:2026-09-30 before:2026-10-02")
        XCTAssertEqual(AskRules.question(SearchParams(q: "x", date: .preset(.week)), usernameOf: usernameOf, now: now, calendar: calendar),
                       "x after:2026-09-25")
        // Filters alone still make a question (the words may be empty); a conversation alone does not.
        XCTAssertEqual(AskRules.question(SearchParams(isThread: true), usernameOf: usernameOf, now: now, calendar: calendar), "is:thread")
        XCTAssertEqual(AskRules.question(SearchParams(channelId: "c1"), usernameOf: usernameOf, now: now, calendar: calendar), "")
    }

    func testTargetLine() {
        XCTAssertEqual(AskRules.targetLine(AiAskTargetOut(available: true, provider: "anthropic", model: "claude-opus-5-5", agentName: "ちくわ")),
                       "質問と見つかったメッセージは ちくわ (Anthropic) に送られます")
        XCTAssertEqual(AskRules.targetLine(AiAskTargetOut(available: true, provider: "openai")), "質問と見つかったメッセージは OpenAI に送られます")
        XCTAssertNil(AskRules.targetLine(AiAskTargetOut(available: true)))
        XCTAssertEqual(AskRules.targetLine(AiAskTargetOut(available: false, provider: "anthropic", reason: "ai_private_not_allowed")),
                       "この会話のボットは非公開の会話を読めないため、ここでは聞けません")
        XCTAssertEqual(AskRules.targetLine(AiAskTargetOut(available: false, reason: "ai_budget_exceeded")), "今月の AI の利用上限に達しました")
        XCTAssertEqual(AskRules.targetLine(AiAskTargetOut(available: false, reason: "ai_unavailable")), ErrorMessages.byCode["ai_unavailable"])
        XCTAssertEqual(AskRules.targetLine(AiAskTargetOut(available: false, reason: "new_reason")), "今は AI に聞けません")
        XCTAssertTrue(AskRules.canAsk(AiAskTargetOut(available: true, provider: "openai")))
        XCTAssertFalse(AskRules.canAsk(AiAskTargetOut(available: false)))
        XCTAssertFalse(AskRules.canAsk(nil))
    }

    func testWords() {
        XCTAssertEqual(AskRules.errorText(ApiError.api(status: 429, code: "ai_daily_limit", message: "")), ErrorMessages.byCode["ai_daily_limit"])
        XCTAssertEqual(AskRules.errorText(ApiError.api(status: 503, code: "search_busy", message: "busy")), ErrorMessages.byCode["search_busy"])
        XCTAssertEqual(AskRules.errorText(ApiError.network(URLError(.notConnectedToInternet))), ErrorMessages.network)
        XCTAssertEqual(AskRules.runFailureText(nil), "答えられませんでした")
        XCTAssertEqual(AskRules.runFailureText(" ボットが無効になりました "), "答えられませんでした：ボットが無効になりました")
        XCTAssertNil(AskRules.omittedNote(0))
        XCTAssertEqual(AskRules.omittedNote(3), "非公開の会話の 3 件は、このボットに送れないため除きました")
        XCTAssertEqual(AskRules.progressText(running: false), "メッセージを探しています…")
        XCTAssertEqual(AskRules.progressText(running: true), "答えを書いています…")
    }
}

@MainActor
final class AiAskHubTests: XCTestCase {
    private let source: JSONValue = .object(["n": .number(1), "message_id": .string(m1), "channel_id": .string("c1"), "parent_id": .null,
                                             "sender_id": .string("u1"), "created_at": .string("2026-10-01T03:00:00Z"), "excerpt": .string("10/9")])

    func testAQuestionGoesPendingRunningDoneAndNeverBack() async {
        let api = FakeAiApi()
        let hub = AiHub(api: api)
        let request = AiAskRequest(question: "ゼミの日程は?", channelId: "c1")
        await hub.startAsk(request)
        XCTAssertEqual(api.asked, [request])
        XCTAssertEqual(hub.ask?.phase, .working(running: false))
        hub.applyEvent(askEvent("q1", status: "running"))
        XCTAssertEqual(hub.ask?.phase, .working(running: true))
        hub.applyEvent(askEvent("other", status: "done", output: "別"))  // not this question
        XCTAssertEqual(hub.ask?.phase, .working(running: true))
        hub.applyEvent(askEvent("q1", status: "done", output: "10/9 です [1]", sources: [source]))
        guard case .done(let output, 0, let sources) = hub.ask?.phase else { return XCTFail("\(String(describing: hub.ask?.phase))") }
        XCTAssertEqual(output, "10/9 です [1]")
        XCTAssertEqual(sources.map(\.messageId), [m1])
        hub.applyEvent(askEvent("q1", status: "running"))  // late, out of order
        XCTAssertEqual(hub.ask?.run?.status, "done")
        // A summary's events do not touch the question, nor the question's the summary.
        XCTAssertNil(hub.summary)
        hub.closeAsk()
        XCTAssertNil(hub.ask)
    }

    func testAnEventBeforeThePostAnswersIsKept() async {
        let api = FakeAiApi()
        let hub = AiHub(api: api)
        api.beforeAskAnswers = { hub.applyEvent(askEvent("q1", status: "running")) }
        await hub.startAsk(AiAskRequest(question: "日程"))
        XCTAssertEqual(hub.ask?.phase, .working(running: true))
    }

    func testClosingWhileThePostIsOnItsWayDropsTheAnswer() async {
        let api = FakeAiApi()
        let hub = AiHub(api: api)
        api.beforeAskAnswers = { hub.closeAsk() }
        await hub.startAsk(AiAskRequest(question: "日程"))
        XCTAssertNil(hub.ask)
    }

    func testAFailedRunShowsItsReason() async {
        let api = FakeAiApi()
        let hub = AiHub(api: api)
        await hub.startAsk(AiAskRequest(question: "日程"))
        hub.applyEvent(askEvent("q1", status: "failed", error: "質問に使うボットが無効になりました"))
        XCTAssertEqual(hub.ask?.phase, .failed("答えられませんでした：質問に使うボットが無効になりました"))
    }

    func testRefusalsAreWordedRefreshTheStatusAndTheTarget() async {
        let api = FakeAiApi()
        api.status = .success(AiStatusOut(available: true, summaryAvailable: true, agents: []))
        let hub = AiHub(api: api)
        await hub.refreshStatus()
        api.status = .success(AiStatusOut(available: true, summaryAvailable: false, agents: []))
        api.askResult = .failure(ApiError.api(status: 429, code: "ai_budget_exceeded", message: ""))
        await hub.startAsk(AiAskRequest(question: "日程"))
        XCTAssertEqual(hub.ask?.phase, .failed(ErrorMessages.byCode["ai_budget_exceeded"]!))
        XCTAssertFalse(hub.summaryAvailable)  // the entry hides
        XCTAssertEqual(hub.askTargetEpoch, 1)  // the line is read again

        api.askResult = .failure(ApiError.api(status: 503, code: "search_busy", message: ""))
        await hub.retryAsk()
        XCTAssertEqual(hub.ask?.phase, .failed(ErrorMessages.byCode["search_busy"]!))
        XCTAssertEqual(hub.askTargetEpoch, 1)

        // 「もう一度」 that works: the same question, a fresh request.
        api.askResult = .success(AiRunOut(id: "q2", kind: "ask", status: "pending", channelId: ""))
        await hub.retryAsk()
        XCTAssertEqual(hub.ask?.phase, .working(running: false))
        XCTAssertEqual(api.asked.map(\.question), ["日程", "日程", "日程"])
        XCTAssertEqual(Set(api.asked.map(\.id)).count, 3)
    }

    func testReconnectingReadsTheOpenQuestionAgain() async {
        let api = FakeAiApi()
        let hub = AiHub(api: api)
        await hub.startAsk(AiAskRequest(question: "日程"))
        api.runs["q1"] = AiRunOut(id: "q1", kind: "ask", status: "done", channelId: "", output: "答え", question: "日程")
        await hub.resync()
        XCTAssertEqual(api.runReads, ["q1"])
        XCTAssertEqual(hub.ask?.phase, .done(output: "答え", omittedCount: 0, sources: []))
        await hub.resync()
        XCTAssertEqual(api.runReads, ["q1"])  // finished: not read again
    }

    func testTargetAndHistory() async {
        let api = FakeAiApi()
        let hub = AiHub(api: api)
        // An older server (404): nothing known, the entry hidden.
        let none = await hub.loadAskTarget(question: "日程", channelId: nil)
        XCTAssertNil(none)
        let target = AiAskTargetOut(available: true, provider: "anthropic", model: "claude-opus-5-5", agentName: "ちくわ")
        api.askTargetResult = .success(target)
        let read = await hub.loadAskTarget(question: "日程", channelId: "c1")
        XCTAssertEqual(read, target)
        XCTAssertEqual(api.askTargetReads, ["日程|", "日程|c1"])

        let past = AiRunOut(id: "q9", kind: "ask", status: "done", channelId: "c1", output: "前の答え", question: "前の質問")
        api.history = .success([past, AiRunOut(id: "s1", kind: "summary", status: "done", channelId: "c1")])
        let runs = await hub.askHistory()
        XCTAssertEqual(runs, [past])
        XCTAssertEqual(api.historyReads, ["ask"])
        api.history = .failure(ApiError.network(URLError(.timedOut)))
        let failed = await hub.askHistory()
        XCTAssertNil(failed)

        // A past question opens as it is (no POST); a running one is read again.
        hub.showAskRun(past)
        XCTAssertEqual(hub.ask?.question, "前の質問")
        XCTAssertEqual(hub.ask?.request.channelId, "c1")
        XCTAssertEqual(hub.ask?.phase, .done(output: "前の答え", omittedCount: 0, sources: []))
        XCTAssertEqual(api.asked, [])
        XCTAssertEqual(api.runReads, [])
    }
}
