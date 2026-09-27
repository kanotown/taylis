import Foundation

/// Rows of a channel timeline: date separators, one 「新着メッセージ」 divider and grouped messages.
enum TimelineItem: Identifiable {
    case date(label: String, key: String)
    case unread
    case message(MessageState, compact: Bool)

    var id: String {
        switch self {
        case .date(_, let key): return key
        case .unread: return "unread"
        case .message(let message, _): return message.id
        }
    }
}

enum Timeline {
    /// One line of plain text for a message (thread lists, "replied to a thread" lines).
    static func excerpt(_ body: String, hasAttachments: Bool, users: [String: UserPublic], groups: [String: GroupOut] = [:]) -> String {
        if body.isEmpty { return hasAttachments ? "(添付ファイル)" : "" }
        var text = Mentions.decode(body, users: users, groups: groups)
        // M15g: a table becomes its cell text (separator rows vanish, pipes become spaces).
        text = text.replacingOccurrences(of: #"(?m)^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$"#, with: "", options: .regularExpression)
        text = text.split(separator: "\n", omittingEmptySubsequences: false).map { line -> String in
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard trimmed.hasPrefix("|"), trimmed.hasSuffix("|") else { return String(line) }
            return BodyTokenizer.splitTableRow(trimmed).joined(separator: " ")
        }.joined(separator: "\n")
        for pattern in ["```[a-zA-Z0-9_+-]*", "^#{1,3}\\s+", "^>\\s?", "^\\s*[-*]\\s+", "^\\s*\\d+\\.\\s+", "\\*\\*", "~~", "`"] {
            text = text.replacingOccurrences(of: pattern, with: "", options: [.regularExpression], range: nil)
        }
        return text.components(separatedBy: .whitespacesAndNewlines).filter { !$0.isEmpty }.joined(separator: " ")
    }

    static let groupWindow: TimeInterval = 5 * 60
    private static let weekdays = ["日", "月", "火", "水", "木", "金", "土"]

    /// 今日 / 昨日 / 9月26日 (金) / 2025年12月31日 (水)
    static func dayLabel(_ date: Date, now: Date = Date(), calendar: Calendar = .current) -> String {
        if calendar.isDate(date, inSameDayAs: now) { return "今日" }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) { return "昨日" }
        let parts = calendar.dateComponents([.year, .month, .day, .weekday], from: date)
        let md = "\(parts.month ?? 0)月\(parts.day ?? 0)日 (\(weekdays[max(0, (parts.weekday ?? 1) - 1) % 7]))"
        return parts.year == calendar.component(.year, from: now) ? md : "\(parts.year ?? 0)年\(md)"
    }

    static func timeLabel(_ iso: String) -> String {
        guard let date = parseIsoDate(iso) else { return "送信中…" }
        return date.formatted(date: .omitted, time: .shortened)
    }

    static func fullLabel(_ iso: String) -> String {
        guard let date = parseIsoDate(iso) else { return "" }
        return date.formatted(date: .long, time: .shortened)
    }

    /// 「Toru Kano」→ TK, 「かのう」→ か.
    static func initials(_ name: String) -> String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let first = trimmed.first else { return "?" }
        let words = trimmed.split(whereSeparator: { $0.isWhitespace })
        if words.count >= 2, let a = words[0].first, let b = words[1].first, a.isASCII, b.isASCII, a.isLetter {
            return String([a, b]).uppercased()
        }
        return String(first).uppercased()
    }

    /// Stable hue in 0..<1 per user id (same colour on every device and client).
    static func hue(_ id: String) -> Double {
        var hash: UInt32 = 0
        for scalar in id.unicodeScalars { hash = hash &* 31 &+ scalar.value }
        return Double(hash % 360) / 360
    }

    static func build(
        _ messages: [MessageState],
        firstUnreadAfterSeq: Int?,
        meId: String?,
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> [TimelineItem] {
        var items: [TimelineItem] = []
        items.reserveCapacity(messages.count + 8)
        var previous: MessageState?
        var previousDay: Date?
        var unreadPlaced = false
        for message in messages {
            let at = parseIsoDate(message.createdAt) ?? now
            let day = calendar.startOfDay(for: at)
            if day != previousDay {
                items.append(.date(label: dayLabel(at, now: now, calendar: calendar), key: "date:\(day.timeIntervalSince1970)"))
                previousDay = day
                previous = nil
            }
            if !unreadPlaced, let after = firstUnreadAfterSeq, let seq = message.seq, seq > after, message.senderId != meId {
                items.append(.unread)
                unreadPlaced = true
                previous = nil
            }
            var compact = false
            // A reply also sent to the channel (M15c) keeps its own header.
            if let previous, previous.senderId == message.senderId, !previous.pending, !message.pending, !previous.isReply, !message.isReply,
               let previousAt = parseIsoDate(previous.createdAt) {
                compact = abs(at.timeIntervalSince(previousAt)) < groupWindow
            }
            items.append(.message(message, compact: compact))
            previous = message
        }
        return items
    }

    /// "HH:mm までミュート" while a mute is active, otherwise nil.
    static func muteLabel(_ mutedUntil: String?, now: Date = Date()) -> String? {
        guard let mutedUntil, let until = parseIsoDate(mutedUntil), until > now else { return nil }
        return until.formatted(date: .omitted, time: .shortened) + " までミュート"
    }
}
