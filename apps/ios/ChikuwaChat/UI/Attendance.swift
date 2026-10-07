import Foundation

/// M140 (docs/PRESENCE.md): 「在室状況」's rules — the same as the web's ui/attendance.ts.
///
/// The board groups people by state, the states in kind order (in_room → on_site → off_site → gone), the workspace's
/// states before personal ones, each in its order; people without a row are 「未設定」 at the end. 「在室 n 人」 counts the
/// in_room kind.
enum AttendanceRules {
    static let kinds = ["in_room", "on_site", "off_site", "gone"]

    static func kindLabel(_ kind: String) -> String {
        switch kind {
        case "in_room": tr("在室（部屋にいる）")
        case "on_site": tr("敷地内（学内・社内）")
        case "off_site": tr("外出（学外・社外）")
        default: tr("不在（帰宅など）")
        }
    }

    /// Who can be on the board: active people, not guests, not bots (the server's rule).
    static func onBoard(_ user: UserPublic) -> Bool {
        user.deactivatedAt == nil && (user.role == "admin" || user.role == "member")
    }

    /// Whether this person sees 在室状況 at all: never a guest or a bot, and only while the board is on.
    static func visible(board: AttendanceBoardOut?, role: String?) -> Bool {
        board?.enabled == true && (role == "admin" || role == "member")
    }

    /// My buttons: the workspace's states, then mine (deleted ones are not offered), each in its order.
    static func myChoices(_ board: AttendanceBoardOut, me: String?) -> [AttendanceStateOut] {
        let live = board.states.filter { !$0.archived }
        let workspace = live.filter { $0.ownerId == nil }.sorted(by: byPosition)
        let mine = me.map { id in live.filter { $0.ownerId == id }.sorted(by: byPosition) } ?? []
        return workspace + mine
    }

    /// My own states (the editor).
    static func myOwnStates(_ board: AttendanceBoardOut, me: String?) -> [AttendanceStateOut] {
        guard let me else { return [] }
        return board.states.filter { !$0.archived && $0.ownerId == me }.sorted(by: byPosition)
    }

    static func entry(_ board: AttendanceBoardOut?, _ userId: String?) -> AttendanceEntryOut? {
        guard let userId else { return nil }
        return board?.entries.first { $0.userId == userId }
    }

    static func state(_ board: AttendanceBoardOut?, _ stateId: String?) -> AttendanceStateOut? {
        guard let stateId else { return nil }
        return board?.states.first { $0.id == stateId }
    }

    /// The chip next to a name: the person's state and row, nil while the board is off or they have none.
    static func chip(_ board: AttendanceBoardOut?, _ userId: String) -> (state: AttendanceStateOut, entry: AttendanceEntryOut)? {
        guard let entry = entry(board, userId), let state = state(board, entry.stateId) else { return nil }
        return (state, entry)
    }

    /// The button's look: pressed when it is my current state.
    static func isSelected(_ state: AttendanceStateOut, mine: AttendanceEntryOut?) -> Bool { mine?.stateId == state.id }

    /// The note a button press sends: pressing my current state keeps my note, another state starts without one.
    static func noteForChoice(_ state: AttendanceStateOut, mine: AttendanceEntryOut?) -> String? {
        isSelected(state, mine: mine) ? mine?.note : nil
    }

    /// The note field's value to send (blank = none, at most 100 characters).
    static func cleanNote(_ text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : String(trimmed.prefix(100))
    }

    struct Person: Equatable {
        let user: UserPublic
        let entry: AttendanceEntryOut?
    }

    struct Group: Equatable, Identifiable {
        /// nil = 「未設定」.
        let state: AttendanceStateOut?
        var people: [Person]
        var id: String { state?.id ?? "unset" }
    }

    private static func byPosition(_ a: AttendanceStateOut, _ b: AttendanceStateOut) -> Bool {
        a.position != b.position ? a.position < b.position : a.label.compare(b.label, locale: japanese) == .orderedAscending
    }

    private static let japanese = Locale(identifier: "ja")

    static func stateOrder(_ a: AttendanceStateOut, _ b: AttendanceStateOut) -> Bool {
        let ka = kinds.firstIndex(of: a.kind) ?? kinds.count, kb = kinds.firstIndex(of: b.kind) ?? kinds.count
        if ka != kb { return ka < kb }
        if (a.ownerId == nil) != (b.ownerId == nil) { return a.ownerId == nil }
        return byPosition(a, b)
    }

    /// The board's groups: states with people (in kind order; empty states left out), then 「未設定」. People by name;
    /// in a state, who came first first.
    static func groups(_ board: AttendanceBoardOut, users: some Sequence<UserPublic>) -> [Group] {
        let people = users.filter(onBoard).sorted { a, b in
            let order = a.displayName.compare(b.displayName, locale: japanese)
            return order != .orderedSame ? order == .orderedAscending : a.id < b.id
        }
        let byUser = Dictionary(board.entries.map { ($0.userId, $0) }, uniquingKeysWith: { _, last in last })
        var groups: [String: Group] = [:]
        var unset = Group(state: nil, people: [])
        for user in people {
            guard let entry = byUser[user.id], let state = state(board, entry.stateId) else {
                unset.people.append(Person(user: user, entry: nil))
                continue
            }
            groups[state.id, default: Group(state: state, people: [])].people.append(Person(user: user, entry: entry))
        }
        var ordered = groups.values.sorted { stateOrder($0.state!, $1.state!) }
        for index in ordered.indices {
            ordered[index].people = sortedBySince(ordered[index].people)
        }
        return unset.people.isEmpty ? ordered : ordered + [unset]
    }

    /// Stable: people who began at the same moment keep their name order.
    private static func sortedBySince(_ people: [Person]) -> [Person] {
        people.enumerated().sorted { a, b in
            let sa = a.element.entry?.since ?? "", sb = b.element.entry?.since ?? ""
            let da = parseIsoDate(sa), db = parseIsoDate(sb)
            if let da, let db, da != db { return da < db }
            if da == nil || db == nil, sa != sb { return sa < sb }
            return a.offset < b.offset
        }.map(\.element)
    }

    /// 「在室 n 人」: people on the board whose state is of the in_room kind.
    static func inRoomCount(_ board: AttendanceBoardOut, users: some Sequence<UserPublic>) -> Int {
        let present = Set(users.filter(onBoard).map(\.id))
        return board.entries.filter { present.contains($0.userId) && state(board, $0.stateId)?.kind == "in_room" }.count
    }

    /// 「9:15 から」 today, 「10/6 18:02 から」 earlier (the device's time zone).
    static func sinceLabel(_ since: String, now: Date = Date(), calendar: Calendar = .current) -> String {
        guard let at = parseIsoDate(since) else { return "" }
        let parts = calendar.dateComponents([.month, .day, .hour, .minute], from: at)
        let time = "\(parts.hour ?? 0):" + String(format: "%02d", parts.minute ?? 0)
        let when = calendar.isDate(at, inSameDayAs: now) ? time : "\(parts.month ?? 0)/\(parts.day ?? 0) \(time)"
        return tr("\(when) から")
    }

    /// A state as plain text: its name, with the emoji in front (「🟢 在室」) only when it has no icon this app draws
    /// (PRESENCE.md §2.1); where a picture can be drawn, AttendanceGlyph / AttendanceChip draw it.
    static func stateText(_ state: AttendanceStateOut) -> String {
        guard AttendanceIcons.symbol(state.icon) == nil, let emoji = state.emoji, !emoji.isEmpty else { return state.label }
        return "\(emoji) \(state.label)"
    }

    /// A new state's icon until one is picked: its kind's default state's (PRESENCE.md §2.1).
    static func defaultIcon(kind: String) -> String? { AttendanceIcons.defaults[kind] }

    /// The icon the own-state form sends: the picked one (`.some(nil)` = 「なし」), else (not picked) the kind's default.
    static func formIcon(picked: String??, kind: String) -> String? {
        if let picked { return picked }
        return defaultIcon(kind: kind)
    }

    // MARK: the quick switch (PRESENCE.md §7.1, §9.1)

    /// My state now (nil: none, or the board is off).
    static func myState(_ board: AttendanceBoardOut?, _ meId: String?) -> AttendanceStateOut? {
        state(board, entry(board, meId)?.stateId)
    }

    /// Whether the pill shows: while the board is on, never for a guest or a bot.
    static func pillVisible(board: AttendanceBoardOut?, role: String?) -> Bool { visible(board: board, role: role) }

    /// The pill's name: about 8 characters, cut with 「…」.
    static func pillText(_ label: String) -> String {
        label.count > 8 ? String(label.prefix(7)) + "…" : label
    }

    /// 「在室状況：学外」, or 「在室状況」 while I have no state.
    static func pillAccessibilityLabel(_ state: AttendanceStateOut?) -> String {
        guard let state else { return tr("在室状況") }
        return tr("在室状況：\(state.label)")
    }

    enum PillMode: Equatable { case full, icon, hidden }

    /// The workspace's name keeps at least this many characters before the pill gives way.
    static let nameMinCharacters = 4
    /// The icon-only pill's width and the space between the name and the pill (pt).
    static let pillIconWidth: CGFloat = 28
    static let pillGap: CGFloat = 6

    /// The home header title's room in a bar `barWidth` wide: the bar less the picture (left) and ⋯ (right) on both
    /// sides, as the title is centred. 0 = not measured yet.
    static func headerRoom(barWidth: CGFloat) -> CGFloat {
        barWidth > 0 ? max(0, barWidth - 2 * 68) : 0
    }

    /// How the pill fits beside the workspace's name in `room` (pt): whole while both fit, else only its icon (the name
    /// cut down to `nameMin` at most), else not at all. `room` 0 = not laid out yet: whole.
    static func pillMode(room: CGFloat, nameNatural: CGFloat, nameMin: CGFloat, full: CGFloat) -> PillMode {
        if room <= 0 { return .full }
        if room - nameNatural - pillGap >= full { return .full }
        if room - min(nameNatural, nameMin) - pillGap >= pillIconWidth { return .icon }
        return .hidden
    }

    /// attendance.updated (or my own change answered): the person's row replaced. `known` is false when its state is not
    /// on this board (someone's new own state): read the board again.
    static func applying(_ entry: AttendanceEntryOut, to board: AttendanceBoardOut) -> (board: AttendanceBoardOut, known: Bool) {
        var next = board
        if let index = next.entries.firstIndex(where: { $0.userId == entry.userId }) {
            next.entries[index] = entry
        } else {
            next.entries.append(entry)
        }
        return (next, board.states.contains { $0.id == entry.stateId })
    }
}
