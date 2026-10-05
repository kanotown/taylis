import Foundation
import Observation

/// M66: the AI calls the hub makes (ApiClient and the test fakes; docs/AI.md §5).
@MainActor
protocol AiApi: AnyObject {
    func aiStatus() async throws -> AiStatusOut
    func createSummary(_ request: AiSummaryRequest) async throws -> AiRunOut
    func aiRun(id: String) async throws -> AiRunOut
    /// Review v0.1.18 #2: GET /ai/summaries/target (404 on an older server).
    func summaryTarget(channelId: String) async throws -> AiSummaryTargetOut
    /// M71 「AI に聞く」 (docs/AI.md §13.5): POST /ai/ask, GET /ai/ask/target, GET /ai/runs?kind=.
    func createAsk(_ request: AiAskRequest) async throws -> AiRunOut
    func askTarget(question: String, channelId: String?) async throws -> AiAskTargetOut
    func aiRuns(kind: String) async throws -> [AiRunOut]
}

extension AiApi {
    /// A fake without 「AI に聞く」 answers as a server before M70 does (404).
    func createAsk(_ request: AiAskRequest) async throws -> AiRunOut { throw ApiError.api(status: 404, code: "http_404", message: "") }
    func askTarget(question: String, channelId: String?) async throws -> AiAskTargetOut { throw ApiError.api(status: 404, code: "http_404", message: "") }
    func aiRuns(kind: String) async throws -> [AiRunOut] { throw ApiError.api(status: 404, code: "http_404", message: "") }
}

/// The summary sheet's one request and what came of it.
struct AiSummarySession: Equatable {
    enum Phase: Equatable {
        /// POST /ai/summaries is on its way.
        case starting
        /// The run exists and is queued (`running` false) or being written.
        case working(running: Bool)
        case done(output: String, omittedCount: Int)
        /// In Japanese, ready to show.
        case failed(String)
    }

    let request: AiSummaryRequest
    var run: AiRunOut?
    /// The request itself failed (in Japanese).
    var failure: String?

    var phase: Phase {
        if let failure { return .failed(failure) }
        guard let run else { return .starting }
        switch run.status {
        case "done": return .done(output: run.output ?? "", omittedCount: run.omittedCount)
        case "failed": return .failed(AiRules.runFailureText(run.error))
        case "running": return .working(running: true)
        default: return .working(running: false)
        }
    }
}

/// M66 (docs/AI.md §5–§6): whether the server has AI (GET /ai/status on every connection: start and each reconnect),
/// which users are AI bots (their 「AI」 mark), and the summary sheet's run. The run's states arrive as ai.run_updated
/// (to me only); since events can be missed, the open sheet's run is read again (GET /ai/runs/{id}) after reconnecting.
/// A state never goes back (pending → running → done / failed), whichever of the POST answer and an event lands first.
@MainActor
@Observable
final class AiHub {
    /// nil until the server answered: every AI entry point stays hidden until then (and for good after a 404).
    private(set) var status: AiStatusOut?
    private(set) var summary: AiSummarySession?
    /// Review v0.1.18 #2: where a summary of each conversation would go, read where its 「要約」 choices show. Absent:
    /// not known (not read yet, an older server's 404, a failure) — the choices then show as before, with no line.
    private(set) var targets: [String: AiSummaryTargetOut] = [:]
    /// M71: the question followed on the search screen (one at a time, like the summary).
    private(set) var ask: AiAskSession?
    /// M71: bumped when a question was refused for an AI reason, so the 「AI に聞く」 line reads its target again.
    private(set) var askTargetEpoch = 0
    /// Runs heard of (events) before the POST that made them answered.
    @ObservationIgnored private var early: [String: AiRunOut] = [:]
    @ObservationIgnored private var earlyAsk: [String: AiRunOut] = [:]
    @ObservationIgnored private let api: AiApi?

    init(api: AiApi?) {
        self.api = api
    }

    var available: Bool { status?.available == true }
    var summaryAvailable: Bool { status?.summaryAvailable == true }
    var agents: [AiAgentPublic] { status?.agents ?? [] }
    var botUserIds: Set<String> { Set(agents.map(\.botUserId)) }

    func isAiBot(_ userId: String) -> Bool { agents.contains { $0.botUserId == userId } }

    /// The AI bots among these members (the channel details' notice, docs/AI.md §4).
    func agents(among memberIds: some Sequence<String>) -> [AiAgentPublic] {
        let ids = Set(memberIds)
        return agents.filter { ids.contains($0.botUserId) }
    }

    // MARK: status

    /// GET /ai/status. A 404 (a server before M65) hides AI for good; another failure keeps what was known.
    func refreshStatus() async {
        guard let api else { return }
        do {
            status = try await api.aiStatus()
        } catch ApiError.api(404, _, _) {
            status = .unavailable
        } catch {
            print("could not read the AI status: \(error)")
        }
    }

    /// Connected (start or reconnect): the status again, and the open sheet's run if events may have been missed.
    func online() { Task { await resync() } }

    func resync() async {
        if let run = summary?.run, !run.isFinished { await reread(run.id) }
        if let run = ask?.run, !run.isFinished { await rereadAsk(run.id) }
        await refreshStatus()
    }

    // MARK: the summary target

    /// GET /ai/summaries/target for a conversation whose 「要約」 choices are on screen. Any failure (a 404 on a server
    /// without the route included) forgets what was known, so the choices fall back to today's behaviour.
    func loadTarget(_ channelId: String) async {
        guard let api else { return }
        do {
            targets[channelId] = try await api.summaryTarget(channelId: channelId)
        } catch {
            if case ApiError.api(404, _, _) = error {} else { print("could not read the summary target: \(error)") }
            targets[channelId] = nil
        }
    }

    func target(_ channelId: String) -> AiSummaryTargetOut? { targets[channelId] }

    // MARK: the summary sheet

    /// 「要約」: the sheet shows `starting` at once, then the run.
    func startSummary(_ request: AiSummaryRequest) async {
        summary = AiSummarySession(request: request)
        guard let api else {
            summary?.failure = AiRules.errorText(ApiError.api(status: 404, code: "ai_unavailable", message: ""))
            return
        }
        do {
            let run = try await api.createSummary(request)
            guard summary?.request.id == request.id else { return } // closed (or another asked) meanwhile
            summary?.run = Self.newer(run, early.removeValue(forKey: run.id))
            early = [:]
        } catch {
            guard summary?.request.id == request.id else { return }
            summary?.failure = AiRules.errorText(error)
            if AiRules.refreshesStatus(error) { await refreshStatus() } // the menu then hides what cannot work
            if case ApiError.api(_, let code, _) = error, code.hasPrefix("ai_") { await loadTarget(request.channelId) }
        }
    }

    /// 「もう一度」 on a failure.
    func retrySummary() async {
        guard let request = summary?.request else { return }
        await startSummary(AiSummaryRequest(channelId: request.channelId, scope: request.scope, tzOffsetMinutes: request.tzOffsetMinutes))
    }

    func closeSummary() {
        summary = nil
        early = [:]
    }

    /// ai.run_updated `{run}`: a summary's or (M71) a question's state.
    func applyEvent(_ data: JSONValue) {
        struct Payload: Decodable { let run: AiRunOut }
        guard let run = try? data.decode(Payload.self).run else { return }
        if run.kind == "ask" {
            applyAsk(run)
            return
        }
        guard run.kind == "summary" else { return }
        guard var session = summary else { return }
        if let current = session.run {
            guard current.id == run.id else { return }
            session.run = Self.newer(current, run)
            summary = session
        } else if session.failure == nil {
            early[run.id] = Self.newer(run, early[run.id]) // the POST has not answered yet
        }
    }

    private func reread(_ id: String) async {
        guard let api, let run = try? await api.aiRun(id: id) else { return }
        guard let current = summary?.run, current.id == id else { return }
        summary?.run = Self.newer(current, run)
    }

    // MARK: 「AI に聞く」 (M71, docs/AI.md §13)

    /// GET /ai/ask/target for the question on screen. nil when it cannot be told: a server without 「AI に聞く」 (404,
    /// the entry then stays hidden), a failure.
    func loadAskTarget(question: String, channelId: String?) async -> AiAskTargetOut? {
        guard let api else { return nil }
        do {
            return try await api.askTarget(question: question, channelId: channelId)
        } catch {
            if case ApiError.api(let status, _, _) = error, status == 404 || status == 422 {} else { print("could not read the ask target: \(error)") }
            return nil
        }
    }

    /// My recent questions (GET /ai/runs?kind=ask), newest first; nil when they cannot be read.
    func askHistory() async -> [AiRunOut]? {
        guard let api else { return nil }
        do {
            return try await api.aiRuns(kind: "ask").filter { $0.kind == "ask" }
        } catch {
            print("could not read the questions: \(error)")
            return nil
        }
    }

    /// 「AI に聞く」: replaces the question followed before; the sheet shows `starting` at once, then the run.
    func startAsk(_ request: AiAskRequest) async {
        ask = AiAskSession(request: request)
        earlyAsk = [:]
        guard let api else {
            ask?.failure = AskRules.errorText(ApiError.api(status: 409, code: "ai_unavailable", message: ""))
            return
        }
        do {
            let run = try await api.createAsk(request)
            guard ask?.request.id == request.id else { return } // closed (or another asked) meanwhile
            ask?.run = Self.newer(run, earlyAsk.removeValue(forKey: run.id))
            earlyAsk = [:]
        } catch {
            guard ask?.request.id == request.id else { return }
            ask?.failure = AskRules.errorText(error)
            if AiRules.refreshesStatus(error) { await refreshStatus() } // the entry then hides
            if case ApiError.api(_, let code, _) = error, code.hasPrefix("ai_") { askTargetEpoch += 1 }
        }
    }

    /// 「もう一度」: the same question, a fresh request.
    func retryAsk() async {
        guard let request = ask?.request else { return }
        await startAsk(AiAskRequest(question: request.question, channelId: request.channelId, tzOffsetMinutes: request.tzOffsetMinutes))
    }

    /// A past question from the history: shown, and followed while it is not finished.
    func showAskRun(_ run: AiRunOut) {
        let request = AiAskRequest(question: run.question ?? "", channelId: run.channelId.isEmpty ? nil : run.channelId, id: "run:\(run.id)")
        ask = AiAskSession(request: request, run: run)
        earlyAsk = [:]
        if !run.isFinished { Task { await rereadAsk(run.id) } }
    }

    /// The answer forgotten (the 「AI に聞く」 row's ×, the search screen closed); a late answer is dropped.
    func closeAsk() {
        ask = nil
        earlyAsk = [:]
    }

    private func applyAsk(_ run: AiRunOut) {
        guard var session = ask else { return }
        if let current = session.run {
            guard current.id == run.id else { return }
            session.run = Self.newer(current, run)
            ask = session
        } else if session.failure == nil {
            earlyAsk[run.id] = Self.newer(run, earlyAsk[run.id]) // the POST has not answered yet
        }
    }

    private func rereadAsk(_ id: String) async {
        guard let api, let run = try? await api.aiRun(id: id) else { return }
        guard let current = ask?.run, current.id == id else { return }
        ask?.run = Self.newer(current, run)
    }

    /// The later of two copies of one run: a state never goes back.
    static func newer(_ a: AiRunOut, _ b: AiRunOut?) -> AiRunOut {
        guard let b, b.id == a.id else { return a }
        return AiRules.rank(b.status) >= AiRules.rank(a.status) ? b : a
    }
}

/// M66: the AI words and small rules (tested on their own).
enum AiRules {
    /// pending → running → done / failed.
    static func rank(_ status: String) -> Int {
        switch status {
        case "pending": return 0
        case "running": return 1
        case "done", "failed": return 2
        default: return 0
        }
    }

    /// The AI codes are worded here (docs/AI.md §5) so the sheet says what to do; anything else as every other error.
    static var byCode: [String: String] { [
        "ai_unavailable": tr("AI は今使えません。管理者が AI を設定していないか、止めています"),
        "ai_budget_exceeded": tr("今月の AI の予算の上限に達しました。来月まで要約は使えません"),
        "ai_daily_limit": tr("今日の AI の利用回数の上限に達しました。明日またお試しください"),
        "ai_run_not_found": tr("要約が見つかりません"),
    ] }

    static func errorText(_ error: Error) -> String {
        if case ApiError.api(_, let code, _) = error, let text = byCode[code] { return text }
        return ErrorMessages.text(for: error)
    }

    /// A refusal that means the status changed (no AI any more, the month's budget spent).
    static func refreshesStatus(_ error: Error) -> Bool {
        guard case ApiError.api(_, let code, _) = error else { return false }
        return code == "ai_unavailable" || code == "ai_budget_exceeded"
    }

    /// "openai" → OpenAI, "anthropic" → Anthropic (another name as it is).
    static func providerLabel(_ provider: String) -> String {
        switch provider {
        case "openai": return "OpenAI"
        case "anthropic": return "Anthropic"
        default: return provider
        }
    }

    /// Review v0.1.18 #2: the 「要約」 choices are disabled while the server says a summary cannot be asked for (an
    /// unknown target — an older server — leaves them as before).
    static func choicesDisabled(_ target: AiSummaryTargetOut?) -> Bool { target.map { !$0.available } ?? false }

    /// Review v0.1.18 #2: the line under the 「要約」 choices — 「要約は <bot> (<provider>) に送られます」, or the reason
    /// it cannot be asked for now (the shared error texts). nil: nothing to say.
    static func targetLine(_ target: AiSummaryTargetOut) -> String? {
        if !target.available {
            return target.reason.flatMap { ErrorMessages.byCode[$0] } ?? tr("今は要約できません")
        }
        guard let provider = target.provider, !provider.isEmpty else { return nil }
        if let name = target.agentName, !name.isEmpty { return tr("要約は \(name)（\(providerLabel(provider))）に送られます") }
        return tr("要約は \(providerLabel(provider)) に送られます")
    }

    /// The summary sheet's caption: the provider and model the run actually used, e.g. 「OpenAI · gpt-6.1-sol」.
    static func runCaption(_ run: AiRunOut) -> String? {
        let model = run.model.flatMap { $0.isEmpty ? nil : $0 }
        let provider = run.provider.flatMap { $0.isEmpty ? nil : $0 } ?? model.map { $0.hasPrefix("gpt-") ? "openai" : "anthropic" }
        guard let provider else { return nil }
        return model.map { "\(providerLabel(provider)) · \($0)" } ?? providerLabel(provider)
    }

    /// A run that failed on the server: its reason when it gave one.
    static func runFailureText(_ reason: String?) -> String {
        guard let reason = reason?.trimmingCharacters(in: .whitespacesAndNewlines), !reason.isEmpty else { return tr("要約できませんでした") }
        return tr("要約できませんでした：\(reason)")
    }

    static func title(_ scope: AiSummaryScope) -> String {
        switch scope {
        case .unread: return tr("未読の要約")
        case .recent(let days): return tr("直近 \(days) 日の要約")
        case .thread: return tr("スレッドの要約")
        }
    }

    static func progressText(running: Bool) -> String { running ? tr("要約しています…") : tr("順番を待っています…") }

    static func omittedNote(_ count: Int) -> String? { count > 0 ? tr("古い \(count) 件は省きました") : nil }

    /// docs/AI.md §4: shown in the channel details while an AI bot is a member.
    static func notice(_ agents: [AiAgentPublic]) -> String? {
        guard !agents.isEmpty else { return nil }
        let names = agents.map(\.name).joined(separator: tr("・"))
        return tr("AI（\(names)）が参加しています。メンションしたときと要約のときに、会話の一部が \(providers(agents)) の API に送られます")
    }

    /// §12: each bot's model decides where its part goes (Anthropic, OpenAI or both), as on the web.
    static func providers(_ agents: [AiAgentPublic]) -> String {
        let openai = agents.contains { ($0.model ?? "").hasPrefix("gpt-") }
        let anthropic = agents.contains { !($0.model ?? "").hasPrefix("gpt-") }
        return [anthropic ? "Anthropic" : nil, openai ? "OpenAI" : nil].compactMap { $0 }.joined(separator: tr(" と "))
    }
}
