import Foundation

/// Post templates and /日程 (M30, DATA_MODEL.md message_templates): what a template's placeholders become, the order a
/// conversation lists them in, and the poll /日程 makes. Pure; the rules and their vectors (apps/shared/templates.json)
/// are the same on the web and Android.
enum Templates {
    /// A calendar day, the device's local date (no time zone of its own).
    struct Day: Equatable, Comparable {
        let year: Int
        let month: Int
        let day: Int

        static func today(_ now: Date = Date(), calendar: Calendar = .current) -> Day {
            let parts = calendar.dateComponents([.year, .month, .day], from: now)
            return Day(year: parts.year ?? 2000, month: parts.month ?? 1, day: parts.day ?? 1)
        }

        /// nil when there is no such day (2/30, 13/1).
        static func make(_ year: Int, _ month: Int, _ day: Int) -> Day? {
            guard (1...12).contains(month), day >= 1, let date = Day(year: year, month: month, day: 1).date,
                  let days = gregorian.range(of: .day, in: .month, for: date), days.contains(day) else { return nil }
            return Day(year: year, month: month, day: day)
        }

        private static let gregorian: Calendar = {
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = TimeZone(identifier: "UTC")!
            return calendar
        }()

        private var date: Date? { Day.gregorian.date(from: DateComponents(year: year, month: month, day: day)) }

        func adding(days: Int) -> Day {
            guard let date, let next = Day.gregorian.date(byAdding: .day, value: days, to: date) else { return self }
            return Day.today(next, calendar: Day.gregorian)
        }

        /// Days from `other` to this one.
        func days(since other: Day) -> Int {
            guard let date, let from = other.date else { return 0 }
            return Day.gregorian.dateComponents([.day], from: from, to: date).day ?? 0
        }

        /// 0 = Monday … 6 = Sunday.
        var weekdayIndex: Int {
            guard let date else { return 0 }
            return (Day.gregorian.component(.weekday, from: date) + 5) % 7
        }

        var weekdayName: String { String(Array("月火水木金土日")[weekdayIndex]) }

        /// ISO 8601 week: the ISO year and the week number.
        var isoWeek: (year: Int, week: Int) {
            var calendar = Calendar(identifier: .iso8601)
            calendar.timeZone = TimeZone(identifier: "UTC")!
            guard let date else { return (year, 1) }
            return (calendar.component(.yearForWeekOfYear, from: date), calendar.component(.weekOfYear, from: date))
        }

        static func < (lhs: Day, rhs: Day) -> Bool {
            (lhs.year, lhs.month, lhs.day) < (rhs.year, rhs.month, rhs.day)
        }
    }

    // MARK: placeholders

    /// `{date}` → 2026/09/28 (月), `{weekday}` → 月, `{week}` → 2026-W40; any other `{…}` stays. One pass.
    static func expand(_ body: String, today: Day) -> String {
        let week = today.isoWeek
        let values = [
            "{date}": String(format: "%04d/%02d/%02d (%@)", today.year, today.month, today.day, today.weekdayName),
            "{weekday}": today.weekdayName,
            "{week}": String(format: "%04d-W%02d", week.year, week.week),
        ]
        var result = ""
        var rest = Substring(body)
        while let open = rest.firstIndex(of: "{") {
            result += rest[..<open]
            let tail = rest[open...]
            if let key = values.keys.first(where: { tail.hasPrefix($0) }) {
                result += values[key]!
                rest = tail.dropFirst(key.count)
            } else {
                result += "{"
                rest = tail.dropFirst()
            }
        }
        return result + rest
    }

    /// What the input holds after a template is chosen: the body when it was empty, else after a blank line.
    static func inserted(_ body: String, into text: String) -> String {
        text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? body : text + "\n\n" + body
    }

    // MARK: lists

    /// The picker's order: the workspace's, then mine, by position then name; in a times channel the ones suggested there
    /// come first.
    static func ordered(_ templates: [TemplateOut], inTimes: Bool) -> [TemplateOut] {
        templates.sorted { a, b in
            let keyA = (inTimes && a.suggestIn == "times" ? 0 : 1, a.scope == "workspace" ? 0 : 1, a.position)
            let keyB = (inTimes && b.suggestIn == "times" ? 0 : 1, b.scope == "workspace" ? 0 : 1, b.position)
            if keyA != keyB { return keyA < keyB }
            return a.name.lowercased() < b.name.lowercased()
        }
    }

    /// The template `/name` means (any case); my own wins over the workspace's.
    static func named(_ name: String, in templates: [TemplateOut]) -> TemplateOut? {
        let matches = templates.filter { $0.name.lowercased() == name.lowercased() }
        return matches.first { $0.scope == "user" } ?? matches.first
    }

    /// The templates whose name starts with what follows the `/` (for the command candidates).
    static func candidates(prefix: String, in templates: [TemplateOut], inTimes: Bool) -> [TemplateOut] {
        ordered(templates, inTimes: inTimes).filter { $0.name.lowercased().hasPrefix(prefix.lowercased()) }
    }

    /// The first line with text, for a candidate's description.
    static func summary(_ body: String) -> String {
        body.split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.first { !$0.isEmpty }
            .map { $0.replacingOccurrences(of: "**", with: "") } ?? ""
    }

    // MARK: /日程

    static let scheduleUsage = "/日程 [質問] 日付 … (例: /日程 ゼミ 10/3 10/5-10/7 13:00)"

    struct Schedule: Equatable {
        let question: String
        let options: [String]
    }

    private struct Invalid: Error {}

    private static let datePattern = try! NSRegularExpression(pattern: #"^(?:(\d{4})/)?(\d{1,2})/(\d{1,2})$"#)
    private static let timePattern = try! NSRegularExpression(pattern: #"^(\d{1,2}):(\d{2})(?:[-〜~](\d{1,2}):(\d{2}))?$"#)

    private static func groups(_ pattern: NSRegularExpression, _ text: String) -> [String?]? {
        let ns = text as NSString
        guard let match = pattern.firstMatch(in: text, range: NSRange(location: 0, length: ns.length)) else { return nil }
        return (1..<match.numberOfRanges).map { match.range(at: $0).location == NSNotFound ? nil : ns.substring(with: match.range(at: $0)) }
    }

    /// A date without a year is this year's, or next year's when that is more than 30 days ago.
    private static func day(_ year: Int?, _ month: Int, _ day: Int, today: Day) throws -> Day {
        if let year {
            guard let result = Day.make(year, month, day) else { throw Invalid() }
            return result
        }
        guard let this = Day.make(today.year, month, day) else { throw Invalid() }
        if today.days(since: this) > 30 {
            guard let next = Day.make(today.year + 1, month, day) else { throw Invalid() }
            return next
        }
        return this
    }

    /// `M/D` or `YYYY/M/D`; nil when the text is not written like a date.
    private static func date(_ text: String, today: Day) throws -> (Day, hasYear: Bool)? {
        guard let parts = groups(datePattern, text) else { return nil }
        let year = parts[0].flatMap { Int($0) }
        return (try day(year, Int(parts[1]!)!, Int(parts[2]!)!, today: today), year != nil)
    }

    /// The days a token names (a date or a range); nil when it is not a date expression at all.
    private static func dateExpression(_ token: String, today: Day) throws -> [Day]? {
        let pieces = token.split(omittingEmptySubsequences: false) { $0 == "-" || $0 == "〜" || $0 == "~" }.map(String.init)
        if pieces.count == 1 { return try date(token, today: today).map { [$0.0] } }
        guard pieces.count == 2, let (start, _) = try date(pieces[0], today: today) else { return nil }
        var end: Day
        if pieces[1].allSatisfy(\.isASCII), let only = Int(pieces[1]), pieces[1].count <= 2 {
            guard let same = Day.make(start.year, start.month, only) else { throw Invalid() }
            end = same
        } else {
            guard let (parsed, hasYear) = try date(pieces[1], today: today) else { throw Invalid() }
            end = parsed
            if !hasYear && end < start { // 12/28-1/3: the end in the next year
                guard let next = Day.make(start.year + 1, end.month, end.day) else { throw Invalid() }
                end = next
            }
        }
        let length = end.days(since: start)
        guard length >= 0, length <= 13 else { throw Invalid() }
        return (0...length).map { start.adding(days: $0) }
    }

    /// `13:00` or `13:00-14:30`; nil when not a time, and an error when a time that does not work.
    private static func time(_ token: String) throws -> String? {
        guard let parts = groups(timePattern, token) else { return nil }
        let h1 = Int(parts[0]!)!, m1 = Int(parts[1]!)!
        guard h1 <= 23, m1 <= 59 else { throw Invalid() }
        var label = String(format: "%d:%02d", h1, m1)
        if let end = parts[2], let endMinutes = parts[3] {
            let h2 = Int(end)!, m2 = Int(endMinutes)!
            guard h2 <= 23, m2 <= 59, (h2, m2) > (h1, m1) else { throw Invalid() }
            label += String(format: "〜%d:%02d", h2, m2)
        }
        return label
    }

    /// `10/3 (土)`, `2027/1/8 (金)` outside this year, with ` 13:00` / ` 13:00〜14:30`.
    static func label(_ day: Day, today: Day, time: String? = nil) -> String {
        (day.year != today.year ? "\(day.year)/" : "") + "\(day.month)/\(day.day) (\(day.weekdayName))" + (time.map { " " + $0 } ?? "")
    }

    /// `/日程 ゼミ 10/3 10/4 10/6` → the question and 2-10 options; nil when the words do not make one.
    static func parseSchedule(_ args: String, today: Day) -> Schedule? {
        let tokens = args.split(whereSeparator: \.isWhitespace).map(String.init)
        do {
            var index = 0
            var question: [String] = []
            while index < tokens.count, try dateExpression(tokens[index], today: today) == nil {
                question.append(tokens[index])
                index += 1
            }
            var options: [String] = []
            while index < tokens.count {
                guard let days = try dateExpression(tokens[index], today: today) else { return nil }
                index += 1
                var at: String?
                if index < tokens.count, let parsed = try time(tokens[index]) {
                    at = parsed
                    index += 1
                }
                for day in days {
                    let text = label(day, today: today, time: at)
                    if !options.contains(text) { options.append(text) }
                }
            }
            guard (2...10).contains(options.count) else { return nil }
            return Schedule(question: question.isEmpty ? "日程調整" : question.joined(separator: " "), options: options)
        } catch {
            return nil
        }
    }

    /// `/日程` alone: the next `count` weekdays after today.
    static func nextWeekdays(after today: Day, count: Int = 5) -> [String] {
        var result: [String] = []
        var day = today
        while result.count < count {
            day = day.adding(days: 1)
            if day.weekdayIndex < 5 { result.append(label(day, today: today)) }
        }
        return result
    }
}
