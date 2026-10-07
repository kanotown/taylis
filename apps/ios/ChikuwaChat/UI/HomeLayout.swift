import Foundation

/// M37 (MOBILE_UI.md §6.1): what the phone's home lists, section by section. Pure over the store's conversations; the
/// unread rule itself is ChannelState.hasUnread.
enum HomeSections {
    /// 「ダイレクトメッセージ」 shows my DM with myself and this many others (the first in its sort); the DM tab has all.
    static let dmLimit = 5

    /// A section's rows after folding, and whether it has any at all (its hint and its trailing rows show only then).
    struct Rows: Equatable {
        var rows: [ChannelState] = []
        var isEmpty = true
        var ids: [String] { rows.map(\.id) }
    }

    struct Custom: Equatable {
        let section: SidebarSectionOut
        let rows: Rows
    }

    struct Layout: Equatable {
        /// 「未読」: only while 「未読をまとめる」 is on; these rows are out of their own sections.
        var unread: [ChannelState] = []
        var favorites = Rows()
        var custom: [Custom] = []
        var channels = Rows()
        var times = Rows()
        var dms = Rows()
        /// More DMs than the home shows: 「すべての DM」 leads to the DM tab.
        var moreDms = false
        /// My DM with myself does not exist yet: a row stands in for it (made on the first tap).
        var notesRow = false
    }

    struct Input {
        var channels: [ChannelState]
        var meId: String?
        var favorites: Set<String> = []
        /// M118: the pinned DMs, oldest pin first; first in every section they are in.
        var dmPins: [String] = []
        /// M141 (SYNC_PROTOCOL.md §7.9): the closed DMs, in no section at all (favorites and my own sections included).
        var closedDms: Set<String> = []
        var sections: [SidebarSectionOut] = []
        /// 「未読をまとめる」.
        var groupUnread = false
        /// The default sections folded on this device ("favorites", "channels", "times", "dms"); my own sections fold
        /// by their `collapsed`.
        var folded: Set<String> = []
        var now = Date()
        /// DATA_MODEL.md 「並べ替え」: the default sections' sorts (missing ones: SidebarOrder.defaultSorts).
        var defaults: [SidebarDefaultOut] = []
        /// A DM's display title, for 「名前順」.
        var title: (ChannelState) -> String = { $0.channel.name ?? "" }
        /// The section being reordered by hand ("favorites", "channels", "dms", "custom:<id>"): all its rows, unfolded,
        /// without the DM limit.
        var editing: String? = nil

        func sort(_ key: String) -> (sort: String, manualOrder: [String]) {
            if let row = defaults.first(where: { $0.key == key }) { return (row.sort, row.manualOrder) }
            return (SidebarOrder.defaultSorts[key] ?? "name", [])
        }
    }

    static func build(_ input: Input) -> Layout {
        let meId = input.meId, now = input.now
        let unread = { (channel: ChannelState) in channel.hasUnread(meId: meId, now: now) }
        let live = input.channels.filter { $0.isMember && !$0.channel.archived && !input.closedDms.contains($0.id) }
        var layout = Layout()
        var pool = live
        if input.groupUnread {
            layout.unread = live.filter(unread).sorted(by: newestFirst)
            pool = live.filter { !unread($0) }
        }
        let starred = { (channel: ChannelState) in input.favorites.contains(channel.id) }
        let placed = Set(input.sections.flatMap(\.channelIds))
        // A folded section still shows what is unread (M26, as in Slack).
        let fold = { (rows: [ChannelState], folded: Bool) in
            Rows(rows: folded ? rows.filter(unread) : rows, isEmpty: rows.isEmpty)
        }

        let editing = input.editing
        let ordered = { (rows: [ChannelState], key: String) in
            let sort = input.sort(key)
            return SidebarOrder.section(rows, sort: sort.sort, manualOrder: sort.manualOrder, title: input.title)
        }
        // M118 (DATA_MODEL.md 「DM の固定」): pinned DMs first in whichever section they are, in pin order.
        let pins = input.dmPins
        layout.favorites = fold(SidebarOrder.pinnedFirst(ordered(pool.filter(starred), "favorites"), pins: pins),
                                input.folded.contains("favorites") && editing != "favorites")
        layout.custom = input.sections.map { section in
            let rows = pool.filter { !starred($0) && section.channelIds.contains($0.id) }
            let sorted = SidebarOrder.pinnedFirst(SidebarOrder.section(rows, sort: section.sort, manualOrder: section.manualOrder, title: input.title),
                                                  pins: pins)
            return Custom(section: section, rows: fold(sorted, section.collapsed && editing != "custom:\(section.id)"))
        }
        let sections = ChannelListView.channelSections(pool, meId: meId) { !starred($0) && !placed.contains($0.id) }
        layout.channels = fold(ordered(sections.channels, "channels"), input.folded.contains("channels") && editing != "channels")
        layout.times = fold(sections.times, input.folded.contains("times"))

        let dmsFolded = input.folded.contains("dms") && editing != "dms"
        let dms = pool.filter { $0.channel.isDm && !starred($0) && !placed.contains($0.id) }
        // M118: the pinned ones first, in pin order, always shown; then my DM with myself, unless the section is in my
        // own order; then the rest in the section's sort.
        let pinned = SidebarOrder.pinned(dms, pins: pins)
        let pinnedIds = Set(pinned.map(\.id))
        let rest = dms.filter { !pinnedIds.contains($0.id) }
        let manual = input.sort("dms").sort == "manual"
        let head = pinned + (manual ? [] : rest.filter { DMList.isNotesToSelf($0, meId: meId) })
        let others = ordered(rest.filter { manual || !DMList.isNotesToSelf($0, meId: meId) }, "dms")
        if editing == "dms" {
            layout.dms = Rows(rows: head + others, isEmpty: dms.isEmpty)
        } else if dmsFolded {
            layout.dms = fold(head + others, true)
        } else {
            // The newest few, and any unread one further down (an unread conversation never hides).
            let shown = others.enumerated().filter { $0.offset < dmLimit || unread($0.element) }.map(\.element)
            layout.dms = Rows(rows: head + shown, isEmpty: dms.isEmpty)
            layout.moreDms = shown.count < others.count
            layout.notesRow = DMList.notesMissing(input.channels, meId: meId)
        }
        return layout
    }

    /// The newest message first (a conversation without one by when it was made).
    static func newestFirst(_ a: ChannelState, _ b: ChannelState) -> Bool { SidebarOrder.newestFirst(a, b) }
}

/// DATA_MODEL.md sidebar_sections 「セクションの中の並び順」「並べ替え」: the order inside a section, the same as the
/// desktop's and Android's (apps/shared/sidebar-order.json). The server keeps each section's sort; the clients sort.
/// No platform collator: ICU's ties and the JVM's java.text.Collator differ.
enum SidebarOrder {
    /// The default sections' sorts when I chose none (or the server is older).
    static let defaultSorts = ["favorites": "name", "channels": "name", "dms": "recent"]

    /// The level-2 key: the name after NFKC, A-Z lower-cased and katakana folded to hiragana, as UTF-16 code units.
    /// NFKC as NFKD then NFC: Foundation's precomposedStringWithCompatibilityMapping leaves 「ﾌﾟﾛ」 as フ + U+309A.
    static func key(_ name: String) -> [UInt16] {
        name.decomposedStringWithCompatibilityMapping.precomposedStringWithCanonicalMapping.utf16.map { unit in
            switch unit {
            case 0x41...0x5A: unit + 0x20
            case 0x30A1...0x30F6: unit - 0x60
            default: unit
            }
        }
    }

    /// One level-1 element: its class, its weight, and a run of digits (compared by length, then digit by digit).
    struct Element: Equatable {
        let rank: Int
        let weight: Int
        var digits = ""
    }

    private static let largeKana: [UInt32: UInt32] = [
        0x3041: 0x3042, 0x3043: 0x3044, 0x3045: 0x3046, 0x3047: 0x3048, 0x3049: 0x304A, 0x3063: 0x3064,
        0x3083: 0x3084, 0x3085: 0x3086, 0x3087: 0x3088, 0x308E: 0x308F, 0x3095: 0x304B, 0x3096: 0x3051,
    ]

    /// JIS X 0208 kanji → their place in JIS order (apps/shared/gen_jis_kanji.py).
    private static let jisRank: [UInt32: Int] = {
        var ranks = [UInt32: Int](minimumCapacity: 6400)
        for (rank, scalar) in JISKanji.order.unicodeScalars.enumerated() { ranks[scalar.value] = rank }
        return ranks
    }()

    private static func isIdeograph(_ c: UInt32) -> Bool {
        (0x3400...0x4DBF).contains(c) || (0x4E00...0x9FFF).contains(c) || (0xF900...0xFAFF).contains(c) || (0x20000...0x3FFFF).contains(c)
    }

    /// The level-1 elements: NFKD, combining and voicing marks dropped, then classified (see the shared JSON's comment).
    static func elements(_ name: String) -> [Element] {
        let codes = name.decomposedStringWithCompatibilityMapping.unicodeScalars.map(\.value)
        var out: [Element] = []
        var i = 0
        while i < codes.count {
            let c = codes[i]
            if (0x300...0x36F).contains(c) || c == 0x3099 || c == 0x309A { i += 1; continue }
            if (0x30...0x39).contains(c) {
                var j = i
                while j < codes.count, (0x30...0x39).contains(codes[j]) { j += 1 }
                let run = String(codes[i..<j].map { Character(Unicode.Scalar(UInt8($0))) }).drop { $0 == "0" }
                let digits = run.isEmpty ? "0" : String(run)
                out.append(Element(rank: 1, weight: digits.count, digits: digits))
                i = j
                continue
            }
            if (0x41...0x5A).contains(c) {
                out.append(Element(rank: 2, weight: Int(c) + 0x20))
            } else if (0x61...0x7A).contains(c) {
                out.append(Element(rank: 2, weight: Int(c)))
            } else if (0x3041...0x3096).contains(c) || (0x30A1...0x30F6).contains(c) {
                let hiragana = c >= 0x30A1 ? c - 0x60 : c
                out.append(Element(rank: 3, weight: Int(largeKana[hiragana] ?? hiragana)))
            } else if let rank = jisRank[c] {
                out.append(Element(rank: 4, weight: rank))
            } else if isIdeograph(c) {
                out.append(Element(rank: 4, weight: 10000 + Int(c)))
            } else if c < 0x3040 || (0x309B...0x30A0).contains(c) || (0x30FB...0x30FF).contains(c) || (0xFF00...0xFFEF).contains(c) {
                out.append(Element(rank: 0, weight: Int(c)))
            } else {
                out.append(Element(rank: 5, weight: Int(c)))
            }
            i += 1
        }
        return out
    }

    private static func compare(_ a: [Element], _ b: [Element]) -> Int {
        for (x, y) in zip(a, b) {
            if x.rank != y.rank { return x.rank < y.rank ? -1 : 1 }
            if x.weight != y.weight { return x.weight < y.weight ? -1 : 1 }
            if x.digits != y.digits { return precedes(x.digits, y.digits) ? -1 : 1 }
        }
        return a.count == b.count ? 0 : (a.count < b.count ? -1 : 1)
    }

    private static func precedes(_ a: String, _ b: String) -> Bool { a.utf16.lexicographicallyPrecedes(b.utf16) }

    /// A name with its keys worked out once (a sort compares each name many times).
    struct Collated {
        let name: String
        let elements: [Element]
        let key: [UInt16]
        init(_ name: String) {
            self.name = name
            elements = SidebarOrder.elements(name)
            key = SidebarOrder.key(name)
        }
    }

    /// Level 1 the elements (kana by gojūon, kanji in JIS X 0208 order, numbers as numbers, case and voicing ignored),
    /// level 2 [key], level 3 the raw names by UTF-16 code unit; -1, 0 or 1.
    static func compare(_ a: Collated, _ b: Collated) -> Int {
        let first = compare(a.elements, b.elements)
        if first != 0 { return first }
        if a.key != b.key { return a.key.lexicographicallyPrecedes(b.key) ? -1 : 1 }
        if a.name.utf16.elementsEqual(b.name.utf16) { return 0 }
        return precedes(a.name, b.name) ? -1 : 1
    }

    /// Two names in the sidebar's Japanese order.
    static func namesInOrder(_ a: String, _ b: String) -> Bool { compare(Collated(a), Collated(b)) < 0 }

    /// Channels by name, then by id.
    static func byName(_ a: ChannelState, _ b: ChannelState) -> Bool {
        let order = compare(Collated(a.channel.name ?? ""), Collated(b.channel.name ?? ""))
        return order != 0 ? order < 0 : precedes(a.id, b.id)
    }

    /// Rows by a name (`name`), equal names by id; each name collated once.
    static func sorted(_ rows: [ChannelState], by name: (ChannelState) -> String) -> [ChannelState] {
        rows.map { (row: $0, name: Collated(name($0))) }
            .sorted { a, b in
                let order = compare(a.name, b.name)
                return order != 0 ? order < 0 : precedes(a.row.id, b.row.id)
            }
            .map(\.row)
    }

    /// M118 (DATA_MODEL.md conversation_pins): the pinned DMs among `rows`, oldest pin first (bootstrap's `dm_pins`).
    static func pinned(_ rows: [ChannelState], pins: [String]) -> [ChannelState] {
        guard !pins.isEmpty else { return [] }
        let dms = Dictionary(rows.filter(\.channel.isDm).map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        var seen: Set<String> = []
        return pins.compactMap { id in seen.insert(id).inserted ? dms[id] : nil }
    }

    /// M118: a section's rows with its pinned DMs first (in pin order), the rest in the order they had.
    static func pinnedFirst(_ rows: [ChannelState], pins: [String]) -> [ChannelState] {
        let head = pinned(rows, pins: pins)
        guard !head.isEmpty else { return rows }
        let ids = Set(head.map(\.id))
        return head + rows.filter { !ids.contains($0.id) }
    }

    /// Newest first: the last message, else when the conversation was made (the server's text), then by id.
    static func newestFirst(_ a: ChannelState, _ b: ChannelState) -> Bool {
        let lastA = a.channel.lastMessageAt ?? a.channel.createdAt, lastB = b.channel.lastMessageAt ?? b.channel.createdAt
        return lastA.utf16.elementsEqual(lastB.utf16) ? precedes(a.id, b.id) : precedes(lastB, lastA)
    }

    /// The rows of a section in its sort: "name" = channels by name, then DMs by their title (`title`, the display
    /// title); "recent" = all newest first; "manual" = `manualOrder` first, the rest after it by name.
    static func section(_ rows: [ChannelState], sort: String = "name", manualOrder: [String] = [],
                        title: (ChannelState) -> String = { $0.channel.name ?? "" }) -> [ChannelState] {
        switch sort {
        case "recent":
            return rows.sorted(by: newestFirst)
        case "manual":
            var place: [String: Int] = [:]
            for (index, id) in manualOrder.enumerated() where place[id] == nil { place[id] = index }
            let placed = rows.filter { place[$0.id] != nil }.sorted { place[$0.id]! < place[$1.id]! }
            return placed + section(rows.filter { place[$0.id] == nil }, title: title)
        default:
            return sorted(rows.filter { !$0.channel.isDm }) { $0.channel.name ?? "" } + sorted(rows.filter(\.channel.isDm), by: title)
        }
    }
}

/// M37 (MOBILE_UI.md §6.1): the row of tiles over the home's sections. A tile with nothing to count is dimmed but
/// still opens its list.
struct HomeTile: Identifiable, Equatable {
    enum Kind: String, CaseIterable {
        case threads, times, drafts, saved, reminders, calendar, tasks, deadlines, reservations, files, canvases, docs, attendance

        /// M111: the key in apps/shared/nav-items.json (UserMe.nav_items).
        var navKey: String { self == .times ? "times-feed" : rawValue }
    }

    let kind: Kind
    /// nil: the tile shows no number (files).
    let count: Int?
    /// The number is red (a mention in a followed thread; reminders that fired).
    let alert: Bool

    var id: String { kind.rawValue }
    var dimmed: Bool { count == 0 }

    var title: String {
        switch kind {
        case .threads: tr("スレッド")
        case .times: "Times"
        case .drafts: tr("下書き")
        case .saved: tr("保存")
        case .reminders: tr("リマインダー")
        case .calendar: tr("カレンダー")
        case .tasks: tr("タスク")
        case .deadlines: tr("締切")
        case .reservations: tr("予約")
        case .files: tr("ファイル")
        case .canvases: tr("キャンバス")
        case .docs: tr("ドキュメント")
        case .attendance: tr("在室状況")
        }
    }

    var icon: String {
        switch kind {
        case .threads: "bubble.left.and.text.bubble.right"
        case .times: "newspaper"
        case .drafts: "square.and.pencil"
        case .saved: "bookmark"
        case .reminders: "alarm"
        case .calendar: "calendar"
        case .tasks: "checklist"
        case .deadlines: "calendar.badge.exclamationmark"
        case .reservations: "ticket"
        case .files: "doc.on.doc"
        case .canvases: "doc.text"
        case .docs: "book.closed"
        case .attendance: "door.left.hand.open"
        }
    }

    /// The list the tile opens (MainView's routes).
    var selectionId: String {
        switch kind {
        case .threads: ThreadsListView.selectionId
        case .times: TimesFeedView.selectionId
        case .drafts: DraftsView.selectionId
        case .saved: SavedView.selectionId
        case .reminders: RemindersView.selectionId
        case .calendar: CalendarView.selectionId
        case .tasks: MyTasksView.selectionId
        case .deadlines: DeadlinesView.selectionId
        case .reservations: ReservationsView.selectionId
        case .files: FilesView.selectionId
        case .canvases: CanvasesView.selectionId
        case .docs: DocsView.selectionId
        case .attendance: AttendanceView.selectionId
        }
    }

    /// What VoiceOver says after the title.
    var accessibilityValue: String {
        guard let count else { return "" }
        switch kind {
        case .threads: return count == 0 ? tr("未読なし") : alert ? tr("未読 \(count) 件、メンションあり") : tr("未読 \(count) 件")
        case .reminders: return count == 0 ? tr("通知済みなし") : tr("通知済み \(count) 件")
        case .reservations: return count == 0 ? tr("作業なし") : tr("担当者の作業 \(count) 件")
        case .attendance: return tr("在室 \(count) 人")
        default: return tr("\(count) 件")
        }
    }

    /// スレッド: followed threads with unread replies, red with a mention; 下書き: drafts and scheduled messages; 保存: saved
    /// messages; リマインダー: the reminders that fired, red; カレンダー (M52, CALENDAR.md §7): no number; タスク (M56,
    /// TASKS.md §6): no number; 締切 (M86, DEADLINES.md §8 3.: after タスク): no number; ファイル: no number; Times (L8, TIMES_FEED.md §7: the feed, after スレッド): no number;
    /// キャンバス (M78, CANVAS.md §21.1: after ファイル, as in the desktop's sidebar): no number.
    /// M111: in my order without the ones I hid (UserMe.nav_items, NavItems); nil = the defaults (this order, all).
    /// M112: 予約 (key "reservations", after 締切) once the server answered the pools (`reservations` non-nil); its
    /// number is the to-dos due in the pools I operate (red), none for the others.
    /// M122: ドキュメント (key "docs", after キャンバス) while the server has the wiki (`docs`): no number.
    /// M140 (docs/PRESENCE.md §9): 在室状況 (key "attendance", last) only while the board is on for me (`attendance`, the
    /// 「在室 n 人」 number, never red; nil = off, a guest, an older server).
    static func tiles(threads: ThreadSummary, drafts: Int, saved: Int, firedReminders: Int, navItems: [NavItem]?,
                      reservations: ReservationTile? = nil, docs: Bool = false, attendance: Int? = nil) -> [HomeTile] {
        let all = tiles(threads: threads, drafts: drafts, saved: saved, firedReminders: firedReminders, reservations: reservations, docs: docs,
                        attendance: attendance)
        let byKey = Dictionary(uniqueKeysWithValues: all.map { ($0.kind.navKey, $0) })
        return NavItems.tileKeys(navItems, implemented: NavItems.implemented(attendance: attendance != nil)).compactMap { byKey[$0] }
    }

    struct ReservationTile: Equatable {
        let todos: Int
        let operates: Bool
    }

    static func tiles(threads: ThreadSummary, drafts: Int, saved: Int, firedReminders: Int,
                      reservations: ReservationTile? = nil, docs: Bool = false, attendance: Int? = nil) -> [HomeTile] {
        var row = base(threads: threads, drafts: drafts, saved: saved, firedReminders: firedReminders)
        if docs, let at = row.firstIndex(where: { $0.kind == .canvases }) {
            row.insert(HomeTile(kind: .docs, count: nil, alert: false), at: at + 1)
        }
        if let reservations, let at = row.firstIndex(where: { $0.kind == .deadlines }) {
            row.insert(HomeTile(kind: .reservations, count: reservations.operates ? reservations.todos : nil,
                                alert: reservations.todos > 0), at: at + 1)
        }
        if let attendance { row.append(HomeTile(kind: .attendance, count: attendance, alert: false)) }
        return row
    }

    private static func base(threads: ThreadSummary, drafts: Int, saved: Int, firedReminders: Int) -> [HomeTile] {
        [
            HomeTile(kind: .threads, count: threads.unreadCount, alert: threads.mentionCount > 0),
            HomeTile(kind: .times, count: nil, alert: false),
            HomeTile(kind: .drafts, count: drafts, alert: false),
            HomeTile(kind: .saved, count: saved, alert: false),
            HomeTile(kind: .reminders, count: firedReminders, alert: firedReminders > 0),
            HomeTile(kind: .calendar, count: nil, alert: false),
            HomeTile(kind: .tasks, count: nil, alert: false),
            HomeTile(kind: .deadlines, count: nil, alert: false),
            HomeTile(kind: .files, count: nil, alert: false),
            HomeTile(kind: .canvases, count: nil, alert: false),
        ]
    }
}
