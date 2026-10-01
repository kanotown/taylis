import Foundation

/// L6 (M60, RECURRING.md §5): recurring posts and their collections — the summaries, the form's draft and its checks,
/// and the chip under a collecting post. Worded as the web's ui/recurring.ts (its tests are ported in RecurringTests).
/// Dates and times are read in `CalendarDates.zone` (the device's; tests pin Asia/Tokyo).
enum RecurringRules {
    /// 0 = Monday (the server's weekday numbers).
    static let weekdayLabels = ["月", "火", "水", "木", "金", "土", "日"]
    static let maxName = 40
    static let maxBody = 4000
    static let maxAfterDays = 30
    /// A channel holds at most this many (409 too_many_recurring_posts).
    static let maxPerChannel = 20

    /// "HH:MM", 00:00–23:59.
    static func isTime(_ text: String) -> Bool {
        let parts = text.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 2, parts[0].count == 2, parts[1].count == 2, parts.allSatisfy({ $0.allSatisfy(\.isASCII) }),
              let hour = Int(parts[0]), let minute = Int(parts[1]) else { return false }
        return (0...23).contains(hour) && (0...59).contains(minute)
    }

    /// "09:00" → "9:00".
    static func clockLabel(_ time: String) -> String {
        guard isTime(time), let hour = Int(time.prefix(2)) else { return time }
        return "\(hour):\(time.suffix(2))"
    }

    /// 「1 日」, 「30 日 (ない月は末日)」, 「末日」.
    static func dayLabel(_ day: Int) -> String {
        day == 31 ? "末日" : day >= 29 ? "\(day) 日 (ない月は末日)" : "\(day) 日"
    }

    /// 「毎週 月・木 9:00」, 「毎日 9:00」, 「毎月 1 日 9:00」, 「毎月 末日 18:00」; the zone when it is not this device's.
    static func scheduleSummary(_ schedule: RecurringSchedule, tz: String? = nil, localTz: String? = nil) -> String {
        var text: String
        if schedule.kind == "monthly" {
            text = "毎月 \(dayLabel(schedule.day ?? 1)) \(clockLabel(schedule.time))"
        } else if schedule.kind != "weekly" {
            text = clockLabel(schedule.time) // a later server's kind: at least the time
        } else {
            let days = schedule.weekdays.sorted()
            text = Set(days).count == 7
                ? "毎日 \(clockLabel(schedule.time))"
                : "毎週 \(days.compactMap { weekdayLabels.indices.contains($0) ? weekdayLabels[$0] : nil }.joined(separator: "・")) \(clockLabel(schedule.time))"
        }
        if let tz, let localTz, !tz.isEmpty, tz != localTz { text += " (\(tz))" }
        return text
    }

    /// 「当日 18:00 締切」 / 「3 日後 18:00 締切」.
    static func dueSummary(_ due: CollectDue) -> String {
        "\(due.afterDays == 0 ? "当日" : "\(due.afterDays) 日後") \(clockLabel(due.time)) 締切"
    }

    /// 「10/9 (金) 18:00」 on this device's calendar; the text itself when it is not a date.
    static func shortDateTime(_ iso: String) -> String {
        guard let date = parseIsoDate(iso) else { return iso }
        let p = CalendarDates.local.dateComponents([.month, .day, .weekday, .hour, .minute], from: date)
        return "\(p.month!)/\(p.day!) (\(CalendarDates.weekdays[p.weekday! - 1])) \(p.hour!):\(String(format: "%02d", p.minute!))"
    }

    /// Whom it collects from, as one line (names from the caller).
    static func targetsSummary(_ spec: CollectSpec, groupName: (String) -> String?, userName: (String) -> String?) -> String {
        if spec.targets.allMembers { return "チャンネルの全員" }
        let names = spec.targets.groupIds.map { "@" + (groupName($0) ?? "グループ") } + spec.targets.userIds.map { userName($0) ?? "?" }
        return names.count > 4 ? names.prefix(4).joined(separator: "、") + " ほか \(names.count - 4)" : names.joined(separator: "、")
    }

    /// Owners and the administrators among the members of a channel (not a DM) manage its recurring posts.
    static func canManage(_ channel: ChannelState?, isAdmin: Bool) -> Bool {
        guard let channel, channel.isMember, channel.channel.type == "public" || channel.channel.type == "private" else { return false }
        return isAdmin || channel.channel.membership?.role == "owner"
    }

    /// The body's placeholders as they would read today (the form's hint).
    static func placeholderHint(today: Date = Date()) -> String {
        let p = CalendarDates.local.dateComponents([.year, .month, .day, .weekday], from: today)
        let weekday = CalendarDates.weekdays[p.weekday! - 1]
        let date = String(format: "%04d/%02d/%02d", p.year!, p.month!, p.day!)
        return "{date} → \(date) (\(weekday))、{weekday} → \(weekday)、{week} → 週番号 (例 \(isoWeek(year: p.year!, month: p.month!, day: p.day!)))。投稿した日に置き換わります"
    }

    /// "2026-W40": the ISO week of a calendar day.
    static func isoWeek(year: Int, month: Int, day: Int) -> String {
        var calendar = Calendar(identifier: .iso8601)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let date = calendar.date(from: DateComponents(year: year, month: month, day: day))!
        let p = calendar.dateComponents([.yearForWeekOfYear, .weekOfYear], from: date)
        return String(format: "%04d-W%02d", p.yearForWeekOfYear!, p.weekOfYear!)
    }

    // MARK: the chip under a collecting post

    struct Chip: Equatable {
        enum Mine: Equatable { case pending, submitted }
        /// 「提出 7/10 · 締切 10/9 (金) 18:00」
        let label: String
        /// Me as a target: whether I have replied; nil when I am not one.
        let mine: Mine?
        let overdue: Bool
        /// Everyone has submitted.
        let complete: Bool

        /// VoiceOver: the label and where I stand.
        var accessibilityLabel: String {
            switch mine {
            case .pending?: label + (overdue ? " (未提出、締切を過ぎています)" : " (未提出)")
            case .submitted?: label + " (提出済み)"
            case nil: label
            }
        }
    }

    static func chip(_ collection: CollectionOut, meId: String?, now: Date = Date()) -> Chip {
        let submitted = collection.submittedUserIds.count
        let isTarget = meId.map { collection.targetUserIds.contains($0) } ?? false
        let due = parseIsoDate(collection.dueAt)
        return Chip(label: "提出 \(submitted)/\(collection.targetCount) · 締切 \(shortDateTime(collection.dueAt))",
                    mine: isTarget ? (collection.submittedUserIds.contains(meId!) ? .submitted : .pending) : nil,
                    overdue: due.map { $0 <= now } ?? false,
                    complete: collection.targetCount > 0 && submitted >= collection.targetCount)
    }

    /// The status sheet's two lists: 提出済み and 未提出, each in the targets' order.
    static func lists(_ collection: CollectionOut) -> (submitted: [String], missing: [String]) {
        let done = Set(collection.submittedUserIds)
        return (collection.targetUserIds.filter { done.contains($0) }, collection.targetUserIds.filter { !done.contains($0) })
    }
}

/// The form's draft (RECURRING.md §5): what the web's dialog edits.
struct RecurringDraft: Equatable {
    enum Kind: String, CaseIterable { case weekly, monthly }

    var name = ""
    var body = ""
    var kind: Kind = .weekly
    /// 0 = Monday.
    var weekdays: [Int] = []
    var day = 1
    var time = "09:00"
    var collect = false
    var allMembers = false
    var groupIds: [String] = []
    var userIds: [String] = []
    var afterDays = 3
    var dueTime = "18:00"

    /// Today's weekday (Monday = 0), 9:00; collecting off, due three days later at 18:00 when turned on.
    static func empty(now: Date = Date()) -> RecurringDraft {
        let weekday = CalendarDates.local.component(.weekday, from: now) // 1 = Sunday
        return RecurringDraft(weekdays: [(weekday + 5) % 7])
    }

    init(name: String = "", body: String = "", kind: Kind = .weekly, weekdays: [Int] = [], day: Int = 1, time: String = "09:00",
         collect: Bool = false, allMembers: Bool = false, groupIds: [String] = [], userIds: [String] = [], afterDays: Int = 3,
         dueTime: String = "18:00") {
        self.name = name
        self.body = body
        self.kind = kind
        self.weekdays = weekdays
        self.day = day
        self.time = time
        self.collect = collect
        self.allMembers = allMembers
        self.groupIds = groupIds
        self.userIds = userIds
        self.afterDays = afterDays
        self.dueTime = dueTime
    }

    init(post: RecurringPostOut, now: Date = Date()) {
        let base = RecurringDraft.empty(now: now)
        self = base
        name = post.name
        body = post.body
        kind = post.schedule.kind == "monthly" ? .monthly : .weekly
        weekdays = kind == .weekly ? post.schedule.weekdays : base.weekdays
        day = kind == .monthly ? (post.schedule.day ?? 1) : base.day
        time = post.schedule.time
        collect = post.collect != nil
        allMembers = post.collect?.targets.allMembers ?? false
        groupIds = post.collect?.targets.groupIds ?? []
        userIds = post.collect?.targets.userIds ?? []
        afterDays = post.collect?.due.afterDays ?? base.afterDays
        dueTime = post.collect?.due.time ?? base.dueTime
    }

    /// What keeps the draft from being saved, in words; nil when it can be. The server checks the same.
    var problem: String? {
        let folded = name.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        if folded.isEmpty { return "名前を入力してください" }
        if folded.unicodeScalars.count > RecurringRules.maxName { return "名前は \(RecurringRules.maxName) 文字までです" }
        if body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "本文を入力してください" }
        if body.unicodeScalars.count > RecurringRules.maxBody { return "本文は \(RecurringRules.maxBody) 文字までです" }
        if kind == .weekly && weekdays.isEmpty { return "曜日を 1 つ以上選んでください" }
        if kind == .monthly && !(1...31).contains(day) { return "日は 1〜31 で選んでください" }
        if !RecurringRules.isTime(time) { return "時刻を選んでください" }
        if collect {
            if !allMembers && groupIds.isEmpty && userIds.isEmpty { return "提出する人を選んでください" }
            if !(0...RecurringRules.maxAfterDays).contains(afterDays) { return "締切は 0〜\(RecurringRules.maxAfterDays) 日後で選んでください" }
            if !RecurringRules.isTime(dueTime) { return "締切の時刻を選んでください" }
        }
        return nil
    }

    var schedule: RecurringSchedule {
        kind == .weekly ? .weekly(Array(Set(weekdays)).sorted(), time: time) : .monthly(day, time: time)
    }

    var collectSpec: CollectSpec? {
        guard collect else { return nil }
        let targets = allMembers ? CollectTargets(allMembers: true) : CollectTargets(allMembers: false, groupIds: groupIds, userIds: userIds)
        return CollectSpec(targets: targets, due: CollectDue(afterDays: afterDays, time: dueTime))
    }

    /// POST body; `tz` is this device's zone (the schedule's and the due time's).
    func create(tz: String) -> RecurringPostCreate {
        RecurringPostCreate(name: name.trimmingCharacters(in: .whitespacesAndNewlines), body: body, schedule: schedule, tz: tz,
                            collect: collectSpec, enabled: true)
    }

    /// PATCH body: everything the form shows (the zone stays the post's).
    var update: RecurringPostPatch {
        RecurringPostPatch(name: name.trimmingCharacters(in: .whitespacesAndNewlines), body: body, schedule: schedule, collect: .some(collectSpec))
    }

    func toggledWeekday(_ day: Int) -> [Int] {
        weekdays.contains(day) ? weekdays.filter { $0 != day } : (weekdays + [day]).sorted()
    }
}
