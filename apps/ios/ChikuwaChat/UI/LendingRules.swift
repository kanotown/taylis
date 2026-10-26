import SwiftUI

/// A screen of 「備品」 over its list (MainRoute.lending): a loan, an item, the keepers' overdue list, every active loan.
/// A lending notice opens the loan, else the item, else (the keepers' morning summary) the overdue list (§17.3).
enum LendingScreen: Equatable, Hashable {
    case loan(String)
    case item(String)
    case overdue
    case active
}

/// M171 (docs/LENDING.md §12.3): the pure parts of 「備品」 on the phone — the words of the states and the dates, the
/// local filters, the borrow / extend date ranges and where a notice opens (the same rules as the desktop's).
/// A due date is a day of the workspace's zone (`lending_settings.tz`, §8.1), never the phone's.
enum LendingRules {
    // MARK: dates

    /// The Gregorian calendar of the workspace's zone (the phone's when the name is unknown).
    static func calendar(tz: String?) -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = tz.flatMap(TimeZone.init(identifier:)) ?? .current
        return calendar
    }

    /// "YYYY-MM-DD" of `date` in `calendar`'s zone.
    static func day(_ date: Date, calendar: Calendar) -> String {
        let c = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", c.year ?? 0, c.month ?? 0, c.day ?? 0)
    }

    /// The start of a "YYYY-MM-DD" day in `calendar`'s zone (nil when it is not one).
    static func date(_ day: String, calendar: Calendar) -> Date? {
        let parts = day.prefix(10).split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
    }

    static func adding(_ days: Int, to day: String, calendar: Calendar) -> String {
        guard let start = date(day, calendar: calendar), let moved = calendar.date(byAdding: .day, value: days, to: start) else { return day }
        return self.day(moved, calendar: calendar)
    }

    /// Today in the workspace's zone.
    static func today(now: Date = Date(), tz: String?) -> String { day(now, calendar: calendar(tz: tz)) }

    /// 「10/30 (木)」.
    static func shortDay(_ day: String) -> String {
        let parts = day.prefix(10).split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return day }
        let cal = calendar(tz: "UTC")
        let weekday = cal.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2])).map { cal.component(.weekday, from: $0) } ?? 1
        return "\(parts[1])/\(parts[2]) (\(AppDates.weekdaysSundayFirst[(weekday - 1) % 7]))"
    }

    /// How many days `to` is after `from` (both "YYYY-MM-DD").
    static func daysBetween(_ from: String, _ to: String) -> Int {
        let cal = calendar(tz: "UTC")
        guard let a = date(from, calendar: cal), let b = date(to, calendar: cal) else { return 0 }
        return cal.dateComponents([.day], from: a, to: b).day ?? 0
    }

    /// The return dates 「借りる」 offers: today to today + the item's max days (§4.2: the same day is 0 days). The sheet's
    /// default is the latest.
    static func borrowRange(maxDays: Int, now: Date = Date(), tz: String?) -> ClosedRange<String> {
        let first = today(now: now, tz: tz)
        return first...adding(max(0, maxDays), to: first, calendar: calendar(tz: tz))
    }

    /// The new return dates 「延長」 offers the borrower: after the current one (and not before today) up to
    /// `latest_due_on`; nil when there is none.
    static func extendRange(_ loan: LendingLoanOut, now: Date = Date(), tz: String?) -> ClosedRange<String>? {
        let cal = calendar(tz: tz)
        let first = max(adding(1, to: loan.dueOn, calendar: cal), today(now: now, tz: tz))
        guard let latest = loan.latestDueOn, latest >= first else { return nil }
        return first...latest
    }

    /// 「最長 14 日（11/9 まで）」, 「当日中に返す」 for 0 days.
    static func maxText(maxDays: Int, latest: String) -> String {
        maxDays <= 0 ? tr("当日中に返します") : tr("最長 \(maxDays) 日（\(shortDay(latest)) まで）")
    }

    /// The extensions left to the borrower (「あと 1 回延長できます」).
    static func extensionsLeft(_ loan: LendingLoanOut, settings: LendingSettingsOut?) -> Int? {
        settings.map { max(0, $0.maxExtensions - loan.extensionCount) }
    }

    /// A due date as a row says it: 「10/30 (木) まで」, 「今日まで」, 「10/30 (木) まで · 2 日過ぎ」 (overdue, red).
    static func dueText(dueOn: String, overdueDays: Int, today: String) -> String {
        let until = dueOn == today ? tr("今日まで") : tr("\(shortDay(dueOn)) まで")
        return overdueDays > 0 ? tr("\(until) · \(overdueDays) 日過ぎ") : until
    }

    // MARK: states

    static func statusLabel(_ status: String) -> String {
        switch status {
        case "available": tr("貸出可")
        case "on_loan": tr("貸出中")
        case "in_repair": tr("修理中")
        case "retired": tr("廃棄")
        default: status
        }
    }

    /// The state's dot (§12.2: green available, blue on loan, grey in repair); red when overdue.
    static func statusColor(_ status: String, overdue: Bool = false) -> Color {
        if overdue { return .red }
        switch status {
        case "available": return .green
        case "on_loan": return .blue
        default: return .gray
        }
    }

    static func permissionLabel(_ state: String?) -> String? {
        switch state {
        case "claimed": tr("教員の許可を得た（申告）")
        case "confirmed": tr("教員が確認しました")
        case "denied": tr("教員が「許可していない」としました")
        default: nil
        }
    }

    /// 「CAM-02 · カメラ · 301 棚 2」.
    static func subtitle(_ item: LendingItemOut, categories: [LendingCategoryOut]) -> String {
        let category = item.categoryId.flatMap { id in categories.first { $0.id == id }?.name }
        return [item.code, category, item.location].compactMap { $0?.isEmpty == false ? $0 : nil }.joined(separator: " · ")
    }

    /// 「カメラ A（CAM-02）」.
    static func itemTitle(name: String, code: String?) -> String {
        guard let code, !code.isEmpty else { return name }
        return tr("\(name)（\(code)）")
    }

    // MARK: the list

    /// The status filters of the list (§12.3), in order; nil = all.
    static let statusFilters: [String?] = [nil, "available", "on_loan", "in_repair"]

    static func statusFilterLabel(_ status: String?) -> String { status.map(statusLabel) ?? tr("すべての状態") }

    /// The items shown: those of the category (nil = all), in the state (nil = all), whose name, code or place contains
    /// the words (case and width ignored).
    static func filter(_ items: [LendingItemOut], query: String, categoryId: String?, status: String?) -> [LendingItemOut] {
        let words = query.split(whereSeparator: \.isWhitespace).map(String.init)
        return items.filter { item in
            if let categoryId, item.categoryId != categoryId { return false }
            if let status, item.status != status { return false }
            let text = [item.name, item.code ?? "", item.location ?? ""].joined(separator: " ")
            return words.allSatisfy { text.range(of: $0, options: [.caseInsensitive, .widthInsensitive, .diacriticInsensitive]) != nil }
        }
    }

    /// My loans not returned yet, the latest due first … the earliest (the server's order: by due date).
    static func myActive(_ loans: [LendingLoanOut]?) -> [LendingLoanOut] { (loans ?? []).filter(\.isActive) }

    /// The tile's number (§12.1): my overdue loans, and for keepers those needing their attention. Red.
    static func tileCount(myOverdue: Int, keeperAttention: Int, isKeeper: Bool) -> Int {
        myOverdue + (isKeeper ? keeperAttention : 0)
    }

    /// The keepers' attention (the same as bootstrap's `keeper_attention_count`): active loans `keeperOverdueDays` or more
    /// past due, or of someone deactivated.
    static func keeperAttention(_ active: [LendingLoanOut], keeperOverdueDays: Int, deactivated: (String) -> Bool) -> Int {
        active.filter { $0.isActive && ($0.overdueDays >= keeperOverdueDays || deactivated($0.borrowerId)) }.count
    }

    // MARK: what may be pressed

    /// 「借りる」: an available item, for a person (not a guest).
    static func canBorrow(_ item: LendingItemOut, isGuest: Bool) -> Bool { !isGuest && item.status == "available" }

    /// 「返却されたら知らせる」: any item but a retired one, unless I hold it myself.
    static func canWatch(_ item: LendingItemOut, me: String?) -> Bool {
        item.status != "retired" && item.loan?.borrowerId != me
    }

    /// 「返す」 / 「延長」 on the phone: my own active loan (a keeper records others' on the desktop / web, §12.3).
    static func isMine(_ loan: LendingLoanOut, me: String?) -> Bool { loan.isActive && loan.borrowerId == me }

    /// 「許可していない」 / 「確認した」: the teacher named on a loan that needed permission. Which of the two is offered
    /// depends on the state (claimed: both; confirmed: 「許可していない」; denied: 「確認した」, a slip of the finger).
    static func decisions(_ loan: LendingLoanOut, me: String?) -> [String] {
        guard loan.permissionRequired, let me, loan.approverId == me else { return [] }
        switch loan.permissionState {
        case "confirmed": return ["denied"]
        case "denied": return ["confirmed"]
        default: return ["denied", "confirmed"]
        }
    }

    static func decisionLabel(_ decision: String) -> String { decision == "denied" ? tr("許可していない") : tr("確認した") }

    // MARK: borrowing

    /// Whether the sheet may send: a purpose, and when permission is needed (and I am not a teacher myself) the tick
    /// and a teacher.
    static func borrowReady(purpose: String, needsPermission: Bool, selfApproved: Bool, ticked: Bool, approverId: String?) -> Bool {
        let text = purpose.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, text.count <= 200 else { return false }
        guard needsPermission, !selfApproved else { return true }
        return ticked && approverId != nil
    }

    /// The teachers to choose from: my supervisor(s) first, then by name.
    static func approvers(_ out: LendingApproversOut, name: (String) -> String) -> [String] {
        let suggested = out.suggestedIds.filter { out.userIds.contains($0) }
        let rest = out.userIds.filter { !suggested.contains($0) }
            .sorted { name($0).localizedStandardCompare(name($1)) == .orderedAscending }
        return suggested + rest
    }

    /// 「返す」 sends: ok, or issue with its note (required, §6.6).
    static func returnReady(condition: String, note: String) -> Bool {
        let text = note.trimmingCharacters(in: .whitespacesAndNewlines)
        return text.count <= 500 && (condition == "ok" || !text.isEmpty)
    }

    /// What a failed press says: 409 lending_item_unavailable names who has it (§7.1); the rest are the shared texts.
    static func errorText(_ error: Error, me: String?, name: (String) -> String) -> String {
        if let taken = error as? LendingUnavailable {
            if let borrower = taken.borrowerId {
                if borrower == me { return tr("すでに借りています") }
                let until = taken.dueOn.map { tr("（\(shortDay($0)) まで）") } ?? ""
                return tr("\(name(borrower)) さんが先に借りました\(until)")
            }
            if let status = taken.status { return tr("この備品は今は借りられません（\(statusLabel(status))）") }
            return ErrorMessages.byCode["lending_item_unavailable"] ?? ErrorMessages.unknown
        }
        return ErrorMessages.text(for: error)
    }

    // MARK: notices

    /// Where a notice (an activity row, a push) opens.
    static func target(loanId: String?, itemId: String?) -> LendingScreen {
        if let loanId { return .loan(loanId) }
        if let itemId { return .item(itemId) }
        return .overdue
    }

    /// The activity row's headline after the item's name: why it came to me.
    static func roleText(_ role: String) -> String {
        switch role {
        case "approver": tr(" · 許可の確認")
        case "keeper": tr(" · 備品係")
        case "watcher": tr(" · 返却の知らせ")
        default: tr(" · 貸し出し")
        }
    }
}
