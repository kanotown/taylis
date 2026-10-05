import Foundation

/// M71 (docs/AI.md §13): the question followed on the search screen and what came of it.
struct AiAskSession: Equatable {
    enum Phase: Equatable {
        /// POST /ai/ask is on its way.
        case starting
        /// The run exists and is looking for messages (`running` false) or writing the answer.
        case working(running: Bool)
        case done(output: String, omittedCount: Int, sources: [AiSourceOut])
        /// In Japanese, ready to show.
        case failed(String)
    }

    let request: AiAskRequest
    var run: AiRunOut?
    /// The request itself failed (in Japanese).
    var failure: String?

    init(request: AiAskRequest, run: AiRunOut? = nil, failure: String? = nil) {
        self.request = request
        self.run = run
        self.failure = failure
    }

    /// The question as the server kept it (a past one), else as it was sent.
    var question: String {
        if let asked = run?.question, !asked.isEmpty { return asked }
        return request.question
    }

    var phase: Phase {
        if let failure { return .failed(failure) }
        guard let run else { return .starting }
        switch run.status {
        case "done": return .done(output: run.output ?? "", omittedCount: run.omittedCount, sources: run.sources)
        case "failed": return .failed(AskRules.runFailureText(run.error))
        case "running": return .working(running: true)
        default: return .working(running: false)
        }
    }
}

/// M71: the words and small rules of 「AI に聞く」 (as apps/desktop/src/api/ai.ts and ui/search.ts; tested on their own).
enum AskRules {
    /// docs/AI.md §13.1: the question is the words as typed plus the filters picked from the chips as the modifiers the
    /// server reads (`from:@name`, `after:` / `before:` in the viewer's days, `has:`, `is:thread`, `is:times`). The
    /// conversation goes apart, as `channel_id`.
    static func question(_ params: SearchParams, usernameOf: (String) -> String?, now: Date = Date(), calendar: Calendar = .current) -> String {
        var parts = [params.words]
        if let id = params.fromUserId, let username = usernameOf(id), !username.isEmpty { parts.append("from:@\(username)") }
        // `after:D` is from the day after D, `before:D` until D (exclusive), as in the search box.
        let range = SearchLogic.dateRange(params.date, now: now, calendar: calendar)
        if let after = range.after, let day = calendar.date(byAdding: .day, value: -1, to: after) {
            parts.append("after:\(SearchLogic.dayString(day, calendar: calendar))")
        }
        if let before = range.before { parts.append("before:\(SearchLogic.dayString(before, calendar: calendar))") }
        parts += params.has.map { "has:\($0.rawValue)" }
        if params.isThread { parts.append("is:thread") }
        if params.isTimes { parts.append("is:times") }
        return parts.filter { !$0.isEmpty }.joined(separator: " ")
    }

    /// An answer's citations: [3], [1][4], [1, 4], [1、4].
    private static let citation = try! NSRegularExpression(pattern: #"\[(\d+(?:\s*[,、]\s*\d+)*)\]"#)  // i18n-ignore

    /// docs/AI.md §13.3: the answer's citations as message links on this server (`<base>/m/<id>`, labelled with the
    /// number), one link per number. A group with a number that is not among the sources stays as it was.
    static func linkCitations(_ output: String, sources: [AiSourceOut], base: URL?) -> String {
        guard let base, !sources.isEmpty else { return output }
        var byNumber: [Int: AiSourceOut] = [:]
        for source in sources where byNumber[source.n] == nil { byNumber[source.n] = source }
        let ns = output as NSString
        var result = ""
        var last = 0
        for match in citation.matches(in: output, range: NSRange(location: 0, length: ns.length)) {
            let group = ns.substring(with: match.range(at: 1))
            let numbers = group.components(separatedBy: CharacterSet(charactersIn: ",、")).map { Int($0.trimmingCharacters(in: .whitespaces)) }  // i18n-ignore
            guard numbers.allSatisfy({ $0.flatMap { byNumber[$0] } != nil }) else { continue }
            result += ns.substring(with: NSRange(location: last, length: match.range.location - last))
            result += numbers.compactMap { $0 }.map { "[\($0)](\(Permalink.url(base: base, messageId: byNumber[$0]!.messageId)))" }.joined(separator: " ")
            last = match.range.location + match.range.length
        }
        return result + ns.substring(from: last)
    }

    /// The source a tapped in-app link points at (nil: not one of this answer's).
    static func source(messageId: String, in sources: [AiSourceOut]) -> AiSourceOut? {
        sources.first { $0.messageId.lowercased() == messageId.lowercased() }
    }

    /// Whether 「AI に聞く」 can be tapped: the server said where the question would go.
    static func canAsk(_ target: AiAskTargetOut?) -> Bool { target?.available == true }

    /// The line beside 「AI に聞く」: where the question goes, or why it cannot be asked (nil: nothing to say).
    static func targetLine(_ target: AiAskTargetOut) -> String? {
        if !target.available {
            switch target.reason ?? "" {
            case "ai_private_not_allowed": return tr("この会話のボットは非公開の会話を読めないため、ここでは聞けません")
            case "ai_budget_exceeded": return tr("今月の AI の利用上限に達しました")
            default: return target.reason.flatMap { ErrorMessages.byCode[$0] ?? AiRules.byCode[$0] } ?? tr("今は AI に聞けません")
            }
        }
        guard let provider = target.provider, !provider.isEmpty else { return nil }
        let label = AiRules.providerLabel(provider)
        let destination = target.agentName.flatMap { $0.isEmpty ? nil : "\($0) (\(label))" } ?? label
        return tr("質問と見つかったメッセージは \(destination) に送られます")
    }

    /// An error of the AI routes: the shared table first, then the AI texts, else as every other error.
    static func errorText(_ error: Error) -> String {
        if case ApiError.api(_, let code, _) = error {
            if let text = ErrorMessages.byCode[code] { return text }
            if let text = AiRules.byCode[code] { return text }
        }
        return ErrorMessages.text(for: error)
    }

    /// A question that failed on the server: its reason when it gave one.
    static func runFailureText(_ reason: String?) -> String {
        guard let reason = reason?.trimmingCharacters(in: .whitespacesAndNewlines), !reason.isEmpty else { return tr("答えられませんでした") }
        return tr("答えられませんでした：\(reason)")
    }

    static var startingText: String { tr("質問を送っています…") }

    static func progressText(running: Bool) -> String { running ? tr("答えを書いています…") : tr("メッセージを探しています…") }

    /// docs/AI.md §13.2 5: the hits in conversations the bot may not read.
    static func omittedNote(_ count: Int) -> String? { count > 0 ? tr("非公開の会話の \(count) 件は、このボットに送れないため除きました") : nil }

    static var footer: String { tr("この答えはあなたにだけ表示されます。AI が書いた答えです。間違いがあるかもしれません。") }
}
