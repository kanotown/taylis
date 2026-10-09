import Foundation

/// What I choose in the quick status menu (docs/PRESENCE.md §11.1; the API's `status`).
enum PresenceChoice: String, CaseIterable, Identifiable {
    case auto, away, dnd, invisible
    var id: String { rawValue }

    var label: String {
        switch self {
        case .auto: tr("オンライン（自動）")
        case .away: tr("離席中")
        case .dnd: tr("取り込み中")
        case .invisible: tr("オフライン表示")
        }
    }

    /// The line under the choice in the menu.
    var hint: String {
        switch self {
        case .auto: tr("使っているかどうかで自動で切り替わります")
        case .away: tr("使っていても離席中に見えます")
        case .dnd: tr("通知を止めます")
        case .invisible: tr("ほかの人にはオフラインに見えます")
        }
    }

    /// The dot drawn beside the choice (the look others get).
    var look: String {
        switch self {
        case .auto: "online"
        case .away: "away"
        case .dnd: "dnd"
        case .invisible: "offline"
        }
    }
}

/// 取り込み中's lengths (§11.2), in the menu's order; the server works `today` / `tomorrow` out in the zone sent as `tz`.
enum DndDuration: String, CaseIterable, Identifiable {
    case minutes30 = "30m", hour1 = "1h", hours2 = "2h", hours4 = "4h", today, tomorrow, forever
    var id: String { rawValue }

    var label: String {
        switch self {
        case .minutes30: tr("30 分")
        case .hour1: tr("1 時間")
        case .hours2: tr("2 時間")
        case .hours4: tr("4 時間")
        case .today: tr("今日の終わりまで")
        case .tomorrow: tr("明日まで")
        case .forever: tr("解除するまで")
        }
    }
}

/// The quick status menu's rules (docs/PRESENCE.md §11), the same as Desktop / Web's `ui/presence.ts` and Android's
/// (apps/shared/presence-rules.json). 取り込み中 is `dnd_until` (the M12c pause, public), オフライン表示 is
/// `presence_hidden` (L4), 離席中 is `presence_manual: "away"` (the hub then announces me as away).
enum PresenceRules {
    /// A dnd_until at or after this instant means 「解除するまで」 (the server stores 9999-12-31T00:00:00Z).
    static let indefiniteFrom = Date(timeIntervalSince1970: 253_370_764_800)  // 9999-01-01T00:00:00Z

    static func isIndefinite(_ until: String?) -> Bool {
        guard let until, let at = parseIsoDate(until) else { return false }
        return at >= indefiniteFrom
    }

    /// The manual pause (取り込み中) still running, else nil. Quiet hours are not 取り込み中 (they keep the 🔕 only).
    /// The one test of a running pause: the settings' DND.paused and the in-app notices' DND.isActive read it too.
    static func activeDnd(_ until: String?, now: Date = Date()) -> String? {
        guard let until, let at = parseIsoDate(until), at > now else { return nil }
        return until
    }

    /// What an avatar shows (§11.5): 取り込み中 beats the connection (online, away or offline alike).
    static func look(connection: String, dndUntil: String?, now: Date = Date()) -> String {
        activeDnd(dndUntil, now: now) != nil ? "dnd" : connection
    }

    /// My choice in the menu: 取り込み中 > オフライン表示 > 離席中 > 自動 (§11.1). An unknown `presence_manual` is none.
    static func myChoice(dndUntil: String?, presenceHidden: Bool?, presenceManual: String?, now: Date = Date()) -> PresenceChoice {
        if activeDnd(dndUntil, now: now) != nil { return .dnd }
        if presenceHidden == true { return .invisible }
        if presenceManual == "away" { return .away }
        return .auto
    }

    static func myChoice(_ me: UserMe?, now: Date = Date()) -> PresenceChoice {
        guard let me else { return .auto }
        return myChoice(dndUntil: me.dndUntil, presenceHidden: me.presenceHidden, presenceManual: me.presenceManual, now: now)
    }

    /// Me as the menu reads it: my own fields from `me`, the public ones from the directory when that copy is newer
    /// (user.updated from another of my devices arrives before GET /users/me answers, §11.6).
    static func currentMe(_ me: UserMe?, shared: UserPublic?) -> UserMe? {
        guard var me else { return nil }
        guard let shared, shared.id == me.id, let theirs = parseIsoDate(shared.updatedAt),
              theirs > (parseIsoDate(me.updatedAt) ?? .distantPast) else { return me }
        me.dndUntil = shared.dndUntil
        me.quietHours = shared.quietHours
        me.statusText = shared.statusText
        me.statusEmoji = shared.statusEmoji
        me.statusExpiresAt = shared.statusExpiresAt
        me.title = shared.title
        return me
    }

    /// When the soonest pause among `untils` ends (the one redraw timer, §11.3); the indefinite ones and those over
    /// are left out.
    static func soonestEnd(_ untils: some Sequence<String?>, now: Date = Date()) -> Date? {
        untils.compactMap { until -> Date? in
            guard let until, !isIndefinite(until), let at = parseIsoDate(until), at > now else { return nil }
            return at
        }.min()
    }

    /// 「15:30」 today, 「10/10 23:59」 on another day, 「解除するまで」 for the indefinite pause (device's zone).
    static func endLabel(_ until: String, now: Date = Date(), calendar: Calendar = .current) -> String {
        if isIndefinite(until) { return tr("解除するまで") }
        guard let at = parseIsoDate(until) else { return "" }
        let parts = calendar.dateComponents([.month, .day, .hour, .minute], from: at)
        let time = String(format: "%02d:%02d", parts.hour ?? 0, parts.minute ?? 0)
        return calendar.isDate(at, inSameDayAs: now) ? time : "\(parts.month ?? 0)/\(parts.day ?? 0) \(time)"
    }

    /// 「取り込み中（〜15:30）」 / 「取り込み中（解除するまで）」 (my menu, anyone's profile card).
    static func dndLine(_ until: String, now: Date = Date(), calendar: Calendar = .current) -> String {
        if isIndefinite(until) { return tr("取り込み中（解除するまで）") }
        return tr("取り込み中（〜\(endLabel(until, now: now, calendar: calendar))）")
    }

    /// The menu header's line: 「取り込み中（〜15:30）」, 「離席中」, 「オフライン表示」…
    static func myLine(_ me: UserMe?, now: Date = Date(), calendar: Calendar = .current) -> String {
        let choice = myChoice(me, now: now)
        guard choice == .dnd, let until = activeDnd(me?.dndUntil, now: now) else { return choice.label }
        return dndLine(until, now: now, calendar: calendar)
    }

    /// The words for someone's look (§11.5): 「取り込み中（〜15:30）」 / 「取り込み中（解除するまで）」 while their pause
    /// runs, else 「オンライン」 / 「離席中」 / 「オフライン」 (the profile card, a 1:1 DM's header; Android's lookLabel).
    static func lookLabel(_ look: String, dndUntil: String?, now: Date = Date(), calendar: Calendar = .current) -> String {
        if look == "dnd", let until = activeDnd(dndUntil, now: now) { return dndLine(until, now: now, calendar: calendar) }
        return presenceLabel(look)
    }

    /// A 1:1 DM's header line: the other person's look, then their custom status (M11d) when they have one.
    static func dmSubtitle(look: String, dndUntil: String?, status: (emoji: String, text: String)?, now: Date = Date(),
                           calendar: Calendar = .current) -> String {
        let presence = lookLabel(look, dndUntil: dndUntil, now: now, calendar: calendar)
        guard let status else { return presence }
        return "\(presence) · \(status.emoji) \(status.text)".trimmingCharacters(in: .whitespaces)
    }

    /// The body of `PUT /users/me/presence` (§11.4): 取り込み中 with its length and the device's zone, the others alone.
    static func requestBody(_ choice: PresenceChoice, duration: DndDuration? = nil, tz: String = TimeZone.current.identifier) -> [String: JSONValue] {
        var body: [String: JSONValue] = ["status": .string(choice.rawValue)]
        if choice == .dnd {
            body["duration"] = .string((duration ?? .hour1).rawValue)
            body["tz"] = .string(tz)
        }
        return body
    }
}
