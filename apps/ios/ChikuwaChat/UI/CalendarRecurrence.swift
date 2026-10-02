import Foundation

/// M69 (CALENDAR.md §10, the phone side of M68): the 「繰り返し」 picker of an event's form and the words for a rule, as
/// the web's ui/calendarRecurrence.ts. The server stores a subset of RFC 5545's RRULE (FREQ DAILY / WEEKLY / MONTHLY /
/// YEARLY, INTERVAL, BYDAY, BYMONTHDAY, UNTIL as a date or COUNT) and expands it; this only turns the picker into such a
/// rule (normalized as the server stores it) and a rule back into the picker and into Japanese (「毎週 火・木曜日、
/// 2026年12月20日まで」). The device never expands a rule (§10.8). Weekdays are 0 = Sunday … 6 = Saturday.
enum RepeatKind: String, CaseIterable, Hashable {
    case none, daily, weekly, monthly, yearly, custom

    var label: String {
        switch self {
        case .none: "しない"
        case .daily: "毎日"
        case .weekly: "毎週"
        case .monthly: "毎月"
        case .yearly: "毎年"
        case .custom: "カスタム"
        }
    }
}

enum RepeatFreq: String, CaseIterable, Hashable {
    case daily = "DAILY", weekly = "WEEKLY", monthly = "MONTHLY", yearly = "YEARLY"

    /// The unit of カスタム's 「N … ごと」.
    var unit: String {
        switch self {
        case .daily: "日"
        case .weekly: "週"
        case .monthly: "か月"
        case .yearly: "年"
        }
    }
}

/// 毎月: the same date (「13 日」), the month's last day (「月末」), the nth weekday (「第 2 火曜日」) or the last such weekday
/// (「最終 金曜日」).
enum MonthlyMode: String, Hashable {
    case day, monthEnd, nth, last
}

enum RepeatEnd: String, CaseIterable, Hashable {
    case never, until, count

    var label: String {
        switch self {
        case .never: "なし"
        case .until: "日付"
        case .count: "回数"
        }
    }
}

/// What the picker holds.
struct RepeatDraft: Equatable, Hashable {
    var kind: RepeatKind = .none
    /// カスタム: what repeats every `interval`. The presets use their own.
    var freq: RepeatFreq = .weekly
    var interval = 1
    /// 毎週: the weekdays (0 = Sunday).
    var weekdays: [Int] = []
    var monthly: MonthlyMode = .day
    var end: RepeatEnd = .never
    /// The last day (included) when `end` is .until ("" until chosen).
    var until: DayKey = ""
    var count = 10

    /// The rule's frequency (nil: しない).
    var frequency: RepeatFreq? {
        switch kind {
        case .none: nil
        case .daily: .daily
        case .weekly: .weekly
        case .monthly: .monthly
        case .yearly: .yearly
        case .custom: freq
        }
    }
}

/// A rule as the server sends it.
struct ParsedRrule: Equatable {
    struct Day: Equatable {
        /// 2 for 「第 2」, -1 for 「最終」, nil for a plain weekday.
        let n: Int?
        let weekday: Int
    }

    var freq: RepeatFreq
    var interval: Int
    var byday: [Day]
    var bymonthday: Int?
    var until: DayKey?
    var count: Int?
}

enum CalendarRecurrence {
    static let maxInterval = 99
    static let maxCount = 999

    static let codes = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"]
    static let names = CalendarDates.weekdays
    /// The server's order (RFC 5545's default week start): Monday first.
    static let mondayFirst = [1, 2, 3, 4, 5, 6, 0]

    static func noRepeat(_ start: DayKey) -> RepeatDraft {
        RepeatDraft(weekdays: [CalendarDates.weekday(start)])
    }

    private static func daysInMonth(_ day: DayKey) -> Int {
        CalendarDates.dayOfMonth(CalendarDates.addDays(CalendarDates.addMonths(day, 1), -1))
    }

    /// Which week of its month a day is in (1-5), and whether it is that weekday's last in the month.
    static func nthOfMonth(_ day: DayKey) -> (n: Int, last: Bool) {
        let date = CalendarDates.dayOfMonth(day)
        return ((date + 6) / 7, date + 7 > daysInMonth(day))
    }

    private static func clamp(_ value: Int, _ upper: Int) -> Int { min(max(value, 1), upper) }

    /// The rule for the picker (nil: しない), normalized the way the server stores it.
    static func toRrule(_ draft: RepeatDraft, start: DayKey) -> String? {
        guard let freq = draft.frequency else { return nil }
        var parts = ["FREQ=\(freq.rawValue)"]
        let interval = draft.kind == .custom ? clamp(draft.interval, maxInterval) : 1
        if interval != 1 { parts.append("INTERVAL=\(interval)") }
        let weekday = CalendarDates.weekday(start)
        switch freq {
        case .weekly:
            let days = draft.weekdays.isEmpty ? [weekday] : draft.weekdays
            parts.append("BYDAY=" + mondayFirst.filter(days.contains).map { codes[$0] }.joined(separator: ","))
        case .monthly:
            switch draft.monthly {
            case .nth: parts.append("BYDAY=\(nthOfMonth(start).n)\(codes[weekday])")
            case .last: parts.append("BYDAY=-1\(codes[weekday])")
            case .monthEnd: parts.append("BYMONTHDAY=-1")
            case .day: parts.append("BYMONTHDAY=\(CalendarDates.dayOfMonth(start))")
            }
        case .daily, .yearly:
            break
        }
        if draft.end == .until && !draft.until.isEmpty {
            parts.append("UNTIL=" + draft.until.replacingOccurrences(of: "-", with: ""))
        } else if draft.end == .count {
            parts.append("COUNT=\(clamp(draft.count, maxCount))")
        }
        return parts.joined(separator: ";")
    }

    /// A rule as the server sends it (nil when it is not one this client understands).
    static func parse(_ rrule: String) -> ParsedRrule? {
        var text = rrule
        if text.uppercased().hasPrefix("RRULE:") { text = String(text.dropFirst(6)) }
        var fields: [String: String] = [:]
        for part in text.split(separator: ";", omittingEmptySubsequences: false) {
            let pieces = part.split(separator: "=", maxSplits: 1, omittingEmptySubsequences: false)
            guard pieces.count == 2, !pieces[0].isEmpty else { return nil }
            fields[pieces[0].uppercased()] = pieces[1].uppercased()
        }
        guard let freq = fields["FREQ"].flatMap(RepeatFreq.init(rawValue:)) else { return nil }
        var byday: [ParsedRrule.Day] = []
        for item in (fields["BYDAY"] ?? "").split(separator: ",") {
            let code = String(item.suffix(2))
            guard let weekday = codes.firstIndex(of: code) else { return nil }
            let prefix = item.dropLast(2)
            if prefix.isEmpty {
                byday.append(.init(n: nil, weekday: weekday))
            } else {
                // One digit, optionally signed (as the web's /^([+-]?\d)?(SU|…)$/).
                guard prefix.count <= 2, let n = Int(prefix), prefix.last?.isNumber == true, prefix.count == 1 || "+-".contains(prefix.first!) else {
                    return nil
                }
                byday.append(.init(n: n, weekday: weekday))
            }
        }
        var until: DayKey?
        if let value = fields["UNTIL"], value.count == 8, value.allSatisfy(\.isASCII), value.allSatisfy(\.isNumber) {
            let chars = Array(value)
            until = "\(String(chars[0..<4]))-\(String(chars[4..<6]))-\(String(chars[6..<8]))"
        }
        return ParsedRrule(freq: freq, interval: Int(fields["INTERVAL"] ?? "1").flatMap { $0 == 0 ? nil : $0 } ?? 1, byday: byday,
                           bymonthday: fields["BYMONTHDAY"].flatMap { Int($0) }, until: until, count: fields["COUNT"].flatMap { Int($0) })
    }

    /// The picker for an event's rule (nil rule: しない). `start` is the day the picker shows (the opened occurrence's).
    static func toRepeat(_ rrule: String?, start: DayKey) -> RepeatDraft {
        var draft = noRepeat(start)
        guard let rrule, let rule = parse(rrule) else { return draft }
        let kinds: [RepeatFreq: RepeatKind] = [.daily: .daily, .weekly: .weekly, .monthly: .monthly, .yearly: .yearly]
        draft.kind = rule.interval != 1 ? .custom : kinds[rule.freq]!
        draft.freq = rule.freq
        draft.interval = rule.interval
        if rule.freq == .weekly && !rule.byday.isEmpty { draft.weekdays = rule.byday.map(\.weekday) }
        if rule.freq == .monthly {
            if let nth = rule.byday.first?.n {
                draft.monthly = nth < 0 ? .last : .nth
            } else {
                draft.monthly = rule.bymonthday == -1 ? .monthEnd : .day
            }
        }
        if let until = rule.until {
            draft.end = .until
            draft.until = until
        } else if let count = rule.count, count != 0 {
            draft.end = .count
            draft.count = count
        }
        return draft
    }

    /// Whether the picker says something other than the event's rule (a change for 「これ以降」 / 「すべて」 only). The
    /// event's rule is read through the picker first, so the defaults a rule may leave out compare alike.
    static func ruleChanged(_ draft: RepeatDraft, start: DayKey, rrule: String?) -> Bool {
        let before = rrule.flatMap { toRrule(toRepeat($0, start: start), start: start) }
        return toRrule(draft, start: start) != before
    }

    private static func weekdayList(_ days: [Int]) -> String {
        mondayFirst.filter(days.contains).map { names[$0] }.joined(separator: "・")
    }

    private static func longDay(_ day: DayKey) -> String {
        let p = day.split(separator: "-").compactMap { Int($0) }
        guard p.count == 3 else { return day }
        return "\(p[0])年\(p[1])月\(p[2])日"
    }

    /// A rule in words: 「毎日」「3 日ごと」「毎週 火・木曜日」「2 週間ごと 月曜日」「毎月 10 日」「毎月 月末」「毎月 第 2 火曜日」
    /// 「毎月 最終 金曜日」「毎年 10月13日」, then 「、2026年12月20日まで」 or 「、10 回」. `start` gives the date and the weekday
    /// a rule may leave out.
    static func describe(_ rrule: String?, start: DayKey) -> String {
        guard let rrule else { return "繰り返さない" }
        guard let rule = parse(rrule) else { return "繰り返し" }
        func every(_ unit: String, _ one: String) -> String { rule.interval == 1 ? one : "\(rule.interval) \(unit)ごと" }
        var text: String
        switch rule.freq {
        case .daily:
            text = every("日", "毎日")
        case .weekly:
            let days = rule.byday.isEmpty ? [CalendarDates.weekday(start)] : rule.byday.map(\.weekday)
            text = "\(every("週間", "毎週")) \(weekdayList(days))曜日"
        case .monthly:
            let which: String
            if let first = rule.byday.first, let n = first.n {
                which = "\(n < 0 ? "最終" : "第 \(n)") \(names[first.weekday])曜日"
            } else if rule.bymonthday == -1 {
                which = "月末"
            } else {
                which = "\(rule.bymonthday ?? CalendarDates.dayOfMonth(start)) 日"
            }
            text = "\(every("か月", "毎月")) \(which)"
        case .yearly:
            let p = start.split(separator: "-").compactMap { Int($0) }
            text = "\(every("年", "毎年")) \(p.count == 3 ? "\(p[1])月\(p[2])日" : start)"
        }
        if let until = rule.until {
            text += "、\(longDay(until))まで"
        } else if let count = rule.count, count != 0 {
            text += "、\(count) 回"
        }
        return text
    }

    struct MonthlyChoice: Equatable, Hashable {
        let value: MonthlyMode
        let label: String
    }

    /// The picker's choices for 毎月 on a day: 「毎月 13 日」, 「毎月 月末」 on a month's last day, 「毎月 第 2 火曜日」 (not a
    /// 5th weekday) and, in a month's last week, 「毎月 最終 火曜日」.
    static func monthlyChoices(_ start: DayKey) -> [MonthlyChoice] {
        let date = CalendarDates.dayOfMonth(start)
        let (n, last) = nthOfMonth(start)
        let weekday = names[CalendarDates.weekday(start)]
        var choices = [MonthlyChoice(value: .day, label: "毎月 \(date) 日")]
        if daysInMonth(start) == date { choices.append(.init(value: .monthEnd, label: "毎月 月末")) }
        if n <= 4 { choices.append(.init(value: .nth, label: "毎月 第 \(n) \(weekday)曜日")) }
        if last { choices.append(.init(value: .last, label: "毎月 最終 \(weekday)曜日")) }
        return choices
    }

    /// What stops the picker from being saved, or nil.
    static func problem(_ draft: RepeatDraft, start: DayKey) -> String? {
        if draft.kind == .none { return nil }
        if draft.kind == .custom && !(1...maxInterval).contains(draft.interval) { return "間隔は 1〜\(maxInterval) にしてください" }
        if draft.frequency == .weekly && draft.weekdays.isEmpty { return "曜日を選んでください" }
        if draft.end == .until {
            if draft.until.isEmpty { return "終了日を入れてください" }
            if draft.until < start { return "終了日は開始日より後にしてください" }
        }
        if draft.end == .count && !(1...maxCount).contains(draft.count) { return "回数は 1〜\(maxCount) にしてください" }
        return nil
    }
}
