import Foundation

/// M37 (MOBILE_UI.md §6.1): what the phone's home lists, section by section. Pure over the store's conversations; the
/// unread rule itself is ChannelState.hasUnread.
enum HomeSections {
    /// 「ダイレクトメッセージ」 shows my DM with myself and this many others (the newest); the DM tab has all.
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
        var sections: [SidebarSectionOut] = []
        /// 「未読をまとめる」.
        var groupUnread = false
        /// The default sections folded on this device ("favorites", "channels", "times", "dms"); my own sections fold
        /// by their `collapsed`.
        var folded: Set<String> = []
        /// The name the favorites are ordered by.
        var title: (ChannelState) -> String = { $0.channel.name ?? "" }
        var now = Date()
    }

    static func build(_ input: Input) -> Layout {
        let meId = input.meId, now = input.now
        let unread = { (channel: ChannelState) in channel.hasUnread(meId: meId, now: now) }
        let live = input.channels.filter { $0.isMember && !$0.channel.archived }
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

        layout.favorites = fold(pool.filter(starred).sorted { input.title($0) < input.title($1) }, input.folded.contains("favorites"))
        layout.custom = input.sections.map { section in
            let rows = pool.filter { !starred($0) && section.channelIds.contains($0.id) }
            let named = rows.filter { !$0.channel.isDm }.sorted { ($0.channel.name ?? "") < ($1.channel.name ?? "") }
            let direct = rows.filter(\.channel.isDm).sorted(by: newestFirst)
            return Custom(section: section, rows: fold(named + direct, section.collapsed))
        }
        let sections = ChannelListView.channelSections(pool, meId: meId) { !starred($0) && !placed.contains($0.id) }
        layout.channels = fold(sections.channels, input.folded.contains("channels"))
        layout.times = fold(sections.times, input.folded.contains("times"))

        let dmsFolded = input.folded.contains("dms")
        let dms = pool.filter { $0.channel.isDm && !starred($0) && !placed.contains($0.id) }
        let notes = dms.filter { DMList.isNotesToSelf($0, meId: meId) }
        let others = dms.filter { !DMList.isNotesToSelf($0, meId: meId) }.sorted(by: newestFirst)
        if dmsFolded {
            layout.dms = fold(notes + others, true)
        } else {
            // The newest few, and any unread one further down (an unread conversation never hides).
            let shown = others.enumerated().filter { $0.offset < dmLimit || unread($0.element) }.map(\.element)
            layout.dms = Rows(rows: notes + shown, isEmpty: dms.isEmpty)
            layout.moreDms = shown.count < others.count
            layout.notesRow = DMList.notesMissing(input.channels, meId: meId)
        }
        return layout
    }

    /// The newest message first (a conversation without one by when it was made).
    static func newestFirst(_ a: ChannelState, _ b: ChannelState) -> Bool {
        let lastA = a.channel.lastMessageAt ?? a.channel.createdAt, lastB = b.channel.lastMessageAt ?? b.channel.createdAt
        return lastA != lastB ? lastA > lastB : a.id < b.id
    }
}

/// M37 (MOBILE_UI.md §6.1): the row of tiles over the home's sections. A tile with nothing to count is dimmed but
/// still opens its list.
struct HomeTile: Identifiable, Equatable {
    enum Kind: String, CaseIterable {
        case threads, times, drafts, saved, reminders, calendar, tasks, deadlines, reservations, files, canvases

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
        }
    }

    /// What VoiceOver says after the title.
    var accessibilityValue: String {
        guard let count else { return "" }
        switch kind {
        case .threads: return count == 0 ? tr("未読なし") : alert ? tr("未読 \(count) 件、メンションあり") : tr("未読 \(count) 件")
        case .reminders: return count == 0 ? tr("通知済みなし") : tr("通知済み \(count) 件")
        case .reservations: return count == 0 ? tr("作業なし") : tr("担当者の作業 \(count) 件")
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
    static func tiles(threads: ThreadSummary, drafts: Int, saved: Int, firedReminders: Int, navItems: [NavItem]?,
                      reservations: ReservationTile? = nil) -> [HomeTile] {
        let all = tiles(threads: threads, drafts: drafts, saved: saved, firedReminders: firedReminders, reservations: reservations)
        let byKey = Dictionary(uniqueKeysWithValues: all.map { ($0.kind.navKey, $0) })
        return NavItems.tileKeys(navItems).compactMap { byKey[$0] }
    }

    struct ReservationTile: Equatable {
        let todos: Int
        let operates: Bool
    }

    static func tiles(threads: ThreadSummary, drafts: Int, saved: Int, firedReminders: Int,
                      reservations: ReservationTile? = nil) -> [HomeTile] {
        var row = base(threads: threads, drafts: drafts, saved: saved, firedReminders: firedReminders)
        if let reservations, let at = row.firstIndex(where: { $0.kind == .deadlines }) {
            row.insert(HomeTile(kind: .reservations, count: reservations.operates ? reservations.todos : nil,
                                alert: reservations.todos > 0), at: at + 1)
        }
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
