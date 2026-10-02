import Foundation

/// M86 (docs/DEADLINES.md §8): deadlines — channel tasks of kind `deadline` whose advance notices the server's 「締切」 bot
/// posts in the channel. The pure rules, as the desktop's ui/deadlines.ts: the notice days, when a deadline has passed,
/// the conversation header's chip (the next open deadline: 「全国大会 原稿 あと 3 日」 / 「今日」 / 「明日」), 「締切」's groups
/// (今週 / 今月 / それ以降 / 過ぎたもの) and the hub's window. No store, no views.
enum DeadlineRules {
    /// The server's default (LAB.md §E): a week, three days, the day before and the day itself.
    static let defaultNoticeDays = [7, 3, 1, 0]
    /// What the form offers (the server takes any of 0 to 60, at most 6).
    static let noticeChoices = [14, 7, 3, 1, 0]
    /// GET /tasks/deadlines brings the deadlines due from this many days ago on (the server's rule).
    static let pastDays = 30

    static let botNote = "「締切」のボットがこのチャンネルに、その日の 9:00 に投稿します"
    static let deleteNote = "前もっての通知も止まります"

    static func isDeadline(_ task: TaskOut) -> Bool { task.kind == .deadline }

    /// The window's rule: a live channel deadline due from 30 days ago on (in this device's zone).
    static func inWindow(_ task: TaskOut, now: Date = Date()) -> Bool {
        guard task.kind == .deadline, task.channelId != nil, let dueOn = task.dueOn else { return false }
        return dueOn >= CalendarDates.addDays(CalendarDates.today(now), -pastDays)
    }

    // MARK: the notice days

    /// 「当日」 / 「前日」 / 「3 日前」.
    static func noticeLabel(_ days: Int) -> String {
        switch days {
        case 0: "当日"
        case 1: "前日"
        default: "\(days) 日前"
        }
    }

    /// The days as the server keeps them (distinct, largest first).
    static func normalize(_ days: [Int]) -> [Int] { Array(Set(days)).sorted(by: >) }

    /// 「7 日前・3 日前・前日・当日」, largest first; 「通知しない」 for none.
    static func noticeSummary(_ days: [Int]?) -> String {
        let sorted = normalize(days ?? [])
        return sorted.isEmpty ? "通知しない" : sorted.map(noticeLabel).joined(separator: "・")
    }

    static func sameNoticeDays(_ a: [Int]?, _ b: [Int]?) -> Bool { normalize(a ?? []) == normalize(b ?? []) }

    /// The form's checks: the usual five, and any other day the deadline already has.
    static func noticeRows(_ chosen: [Int]) -> [Int] { normalize(noticeChoices + chosen) }

    // MARK: when

    /// Over: a due time once it has come, a date once its day is over (in this device's zone).
    static func passed(_ task: TaskOut, today: DayKey, now: Date = Date()) -> Bool {
        if let dueAt = task.dueAt, let at = parseIsoDate(dueAt) { return at <= now }
        guard let day = TaskRules.dueDay(task) else { return false }
        return day < today
    }

    /// By date, then a due time (a date alone is the whole day: after the timed ones that day), then id.
    static func inOrder(_ a: TaskOut, _ b: TaskOut) -> Bool {
        let da = TaskRules.dueDay(a) ?? "", db = TaskRules.dueDay(b) ?? ""
        if da != db { return da < db }
        let ta = a.dueAt.flatMap(parseIsoDate)?.timeIntervalSince1970 ?? .infinity
        let tb = b.dueAt.flatMap(parseIsoDate)?.timeIntervalSince1970 ?? .infinity
        if ta != tb { return ta < tb }
        return a.id < b.id
    }

    /// The header's chip: the channel's nearest deadline still open and not over.
    static func next(_ tasks: [TaskOut], channelId: String, today: DayKey, now: Date = Date()) -> TaskOut? {
        tasks.filter { isDeadline($0) && $0.channelId == channelId && $0.status != .done && $0.dueOn != nil && !passed($0, today: today, now: now) }
            .sorted(by: inOrder).first
    }

    /// When, as the chip says it: 「今日」 (「今日 17:00」), 「明日」 (「明日 17:00」), else 「あと N 日」.
    static func remainingText(_ task: TaskOut, today: DayKey) -> String {
        guard let day = TaskRules.dueDay(task) else { return "" }
        let days = CalendarDates.daysBetween(today, day)
        let time = task.dueAt.flatMap { parseIsoDate($0) != nil ? " " + CalendarDates.clock($0) : nil } ?? ""
        if days <= 0 { return "今日" + time }
        if days == 1 { return "明日" + time }
        return "あと \(days) 日"
    }

    /// 「全国大会 原稿 あと 3 日」.
    static func chipText(_ task: TaskOut, today: DayKey) -> String { "\(task.title) \(remainingText(task, today: today))" }

    enum Tone: Equatable {
        /// Today or tomorrow: red.
        case soon
        /// Within a week: amber.
        case week
        /// Later: grey.
        case later
    }

    static func tone(_ task: TaskOut, today: DayKey) -> Tone {
        guard let day = TaskRules.dueDay(task) else { return .later }
        let days = CalendarDates.daysBetween(today, day)
        return days <= 1 ? .soon : days <= 7 ? .week : .later
    }

    /// A row's date: 「10/9 (金)」, 「10/9 (金) 17:00」, 「今日」 / 「今日 17:00」 for today.
    static func when(_ task: TaskOut, today: DayKey) -> String {
        guard let day = TaskRules.dueDay(task) else { return "" }
        let label = day == today ? "今日" : "\(TaskRules.dueLabel(day, today: today)) (\(CalendarDates.weekdays[CalendarDates.weekday(day)]))"
        guard let dueAt = task.dueAt, parseIsoDate(dueAt) != nil else { return label }
        return label + " " + CalendarDates.clock(dueAt)
    }

    // MARK: 「締切」

    enum GroupKey: String, CaseIterable {
        case week, month, later, past

        var label: String {
            switch self {
            case .week: "今週"
            case .month: "今月"
            case .later: "それ以降"
            case .past: "過ぎたもの"
            }
        }
    }

    struct Group: Equatable {
        let key: GroupKey
        var tasks: [TaskOut]
        var label: String { key.label }
    }

    /// 今週 (through this week's Saturday, the calendar's Sunday-first weeks), 今月 (the rest of this month), それ以降, and
    /// 過ぎたもの (over, done or not; the most recent first). Done ones still ahead stay in their group (struck through).
    /// Empty groups are left out.
    static func groups(_ tasks: [TaskOut], today: DayKey, now: Date = Date()) -> [Group] {
        let weekEnd = CalendarDates.addDays(CalendarDates.weekStart(today), 6)
        let monthEnd = CalendarDates.addDays(CalendarDates.addMonths(today, 1), -1)
        var buckets: [GroupKey: [TaskOut]] = [:]
        for task in tasks where isDeadline(task) && task.dueOn != nil {
            let day = TaskRules.dueDay(task) ?? ""
            let key: GroupKey = passed(task, today: today, now: now) ? .past : day <= weekEnd ? .week : day <= monthEnd ? .month : .later
            buckets[key, default: []].append(task)
        }
        return GroupKey.allCases.compactMap { key in
            guard let rows = buckets[key], !rows.isEmpty else { return nil }
            return Group(key: key, tasks: key == .past ? rows.sorted { inOrder($1, $0) } : rows.sorted(by: inOrder))
        }
    }
}
