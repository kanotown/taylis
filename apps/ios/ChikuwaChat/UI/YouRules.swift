import SwiftUI

/// M40 (MOBILE_UI.md §6.5): the look of the app, kept on this device only (not per workspace, not on the server).
enum AppTheme: String, CaseIterable, Identifiable {
    case system, light, dark

    static let storageKey = "chikuwa.theme"
    var id: String { rawValue }

    var label: String {
        switch self {
        case .system: "端末に合わせる"
        case .light: "ライト"
        case .dark: "ダーク"
        }
    }

    /// What `preferredColorScheme` takes: nil follows the device.
    var colorScheme: ColorScheme? {
        switch self {
        case .system: nil
        case .light: .light
        case .dark: .dark
        }
    }
}

extension DND {
    /// The pause row's choices (30 分 / 1 時間 / 2 時間 / 明日 8:00 / 日時を指定 / 再開).
    enum PauseChoice: Equatable {
        case preset(Pause)
        case custom(Date)
        case resume
    }

    /// The `dnd_until` a choice sends: an ISO time, or nil to resume (the server clears a pause with null).
    static func dndUntil(_ choice: PauseChoice, now: Date = Date()) -> String? {
        switch choice {
        case .preset(let pause): return ISO8601DateFormatter().string(from: pause.until(from: now))
        case .custom(let date): return ISO8601DateFormatter().string(from: date)
        case .resume: return nil
        }
    }

    /// Whether a manual pause is running (a past `dnd_until` is none).
    static func paused(_ dndUntil: String?, now: Date = Date()) -> Bool {
        guard let dndUntil, let until = parseIsoDate(dndUntil) else { return false }
        return until > now
    }

    /// The pause row's value: 「オフ」, or when it ends (「15:30 まで」, 「明日 8:00 まで」, 「10月2日 9:00 まで」).
    static func pauseSummary(_ dndUntil: String?, now: Date = Date(), calendar: Calendar = .current) -> String {
        guard paused(dndUntil, now: now), let dndUntil, let until = parseIsoDate(dndUntil) else { return "オフ" }
        let parts = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: until)
        let time = String(format: "%d:%02d", parts.hour ?? 0, parts.minute ?? 0)
        if calendar.isDate(until, inSameDayAs: now) { return "\(time) まで" }
        if let tomorrow = calendar.date(byAdding: .day, value: 1, to: now), calendar.isDate(until, inSameDayAs: tomorrow) {
            return "明日 \(time) まで"
        }
        let year = calendar.component(.year, from: now) == parts.year ? "" : "\(parts.year ?? 0)年"
        return "\(year)\(parts.month ?? 0)月\(parts.day ?? 0)日 \(time) まで"
    }

    /// The quiet-hours row's value: 「22:00〜07:00」 (with the days when not every day), or 「オフ」.
    static func quietSummary(_ hours: QuietHours?) -> String {
        hours.map(label) ?? "オフ"
    }
}

/// M40: the account screen's ログイン中の端末 (GET /auth/sessions).
enum SessionList {
    /// This device first, then the most recently used; the id keeps equal times in a stable order.
    static func ordered(_ sessions: [SessionOut]) -> [SessionOut] {
        sessions.sorted { a, b in
            if a.current != b.current { return a.current }
            let left = parseIsoDate(a.lastUsedAt) ?? .distantPast
            let right = parseIsoDate(b.lastUsedAt) ?? .distantPast
            if left != right { return left > right }
            return a.id < b.id
        }
    }

    /// The device's own name, else what kind of device it is.
    static func name(_ session: SessionOut) -> String {
        if let name = session.device.deviceName?.trimmingCharacters(in: .whitespacesAndNewlines), !name.isEmpty { return name }
        return platformLabel(session.device.platform)
    }

    static func platformLabel(_ platform: String) -> String {
        switch platform {
        case "ios": "iPhone"
        case "android": "Android"
        case "desktop": "デスクトップ"
        case "web": "ブラウザ"
        default: platform
        }
    }

    static func symbol(_ platform: String) -> String {
        switch platform {
        case "ios": "iphone"
        case "android": "candybarphone"
        case "desktop": "desktopcomputer"
        case "web": "globe"
        default: "questionmark.square"
        }
    }

    /// 「最後に使用: 今日 14:05」 / 「昨日 9:30」 / 「9月28日 14:05」 / 「2025年12月1日 8:00」.
    static func lastUsed(_ iso: String, now: Date = Date(), calendar: Calendar = .current) -> String {
        guard let date = parseIsoDate(iso) else { return "" }
        let parts = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: date)
        let time = String(format: "%d:%02d", parts.hour ?? 0, parts.minute ?? 0)
        let when: String
        if calendar.isDate(date, inSameDayAs: now) {
            when = "今日 \(time)"
        } else if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) {
            when = "昨日 \(time)"
        } else if calendar.component(.year, from: now) == parts.year {
            when = "\(parts.month ?? 0)月\(parts.day ?? 0)日 \(time)"
        } else {
            when = "\(parts.year ?? 0)年\(parts.month ?? 0)月\(parts.day ?? 0)日 \(time)"
        }
        return "最後に使用: \(when)"
    }
}
