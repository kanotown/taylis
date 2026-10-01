import Foundation
import Observation

/// M66: the AI calls the hub makes (ApiClient and the test fakes; docs/AI.md §5).
@MainActor
protocol AiApi: AnyObject {
    func aiStatus() async throws -> AiStatusOut
    func createSummary(_ request: AiSummaryRequest) async throws -> AiRunOut
    func aiRun(id: String) async throws -> AiRunOut
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
    /// Runs heard of (events) before the POST that made them answered.
    @ObservationIgnored private var early: [String: AiRunOut] = [:]
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
        await refreshStatus()
    }

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

    /// ai.run_updated `{run}`.
    func applyEvent(_ data: JSONValue) {
        struct Payload: Decodable { let run: AiRunOut }
        guard let run = try? data.decode(Payload.self).run, run.kind == "summary" else { return }
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
    static let byCode: [String: String] = [
        "ai_unavailable": "AI は今使えません。管理者が AI を設定していないか、止めています",
        "ai_budget_exceeded": "今月の AI の予算の上限に達しました。来月まで要約は使えません",
        "ai_daily_limit": "今日の AI の利用回数の上限に達しました。明日またお試しください",
        "ai_run_not_found": "要約が見つかりません",
    ]

    static func errorText(_ error: Error) -> String {
        if case ApiError.api(_, let code, _) = error, let text = byCode[code] { return text }
        return ErrorMessages.text(for: error)
    }

    /// A refusal that means the status changed (no AI any more, the month's budget spent).
    static func refreshesStatus(_ error: Error) -> Bool {
        guard case ApiError.api(_, let code, _) = error else { return false }
        return code == "ai_unavailable" || code == "ai_budget_exceeded"
    }

    /// A run that failed on the server: its reason when it gave one.
    static func runFailureText(_ reason: String?) -> String {
        guard let reason = reason?.trimmingCharacters(in: .whitespacesAndNewlines), !reason.isEmpty else { return "要約できませんでした" }
        return "要約できませんでした: \(reason)"
    }

    static func title(_ scope: AiSummaryScope) -> String {
        switch scope {
        case .unread: return "未読の要約"
        case .recent(let days): return "直近 \(days) 日の要約"
        case .thread: return "スレッドの要約"
        }
    }

    static func progressText(running: Bool) -> String { running ? "要約しています…" : "順番を待っています…" }

    static func omittedNote(_ count: Int) -> String? { count > 0 ? "古い \(count) 件は省きました" : nil }

    /// docs/AI.md §4: shown in the channel details while an AI bot is a member.
    static func notice(_ agents: [AiAgentPublic]) -> String? {
        guard !agents.isEmpty else { return nil }
        let names = agents.map(\.name).joined(separator: "・")
        return "AI (\(names)) が参加しています。メンションしたときと要約のときに、会話の一部が Anthropic の API に送られます"
    }
}
