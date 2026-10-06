import XCTest
@testable import ChikuwaChat

/// M37 (MOBILE_UI.md §6.1): the home's sections with 「未読をまとめる」, the DM section's limit, and the tiles.
final class HomeTests: XCTestCase {
    private func channel(_ id: String, type: String = "public", unread: Int = 0, mentions: Int = 0, dm: [String]? = nil,
                         last: String? = nil, level: String? = nil, archived: Bool = false) -> ChannelState {
        let out = ChannelOut(id: id, type: type, name: dm == nil ? id : nil, topic: nil, purpose: nil, archived: archived, createdBy: nil, lastSeq: 0,
                             lastMessageAt: last, createdAt: "2026-01-01T00:00:00Z", updatedAt: "", membership: nil, dmUserIds: dm, readState: nil,
                             notification: level.map { NotificationPreferenceOut(channelId: id, level: $0, mutedUntil: nil) })
        return ChannelState(channel: out, isMember: true, syncedSeq: nil, lastSeq: 0, lastReadSeq: 0, unreadCount: unread, mentionCount: mentions, hasOlder: true)
    }

    private func dm(_ id: String, with other: String, day: Int, unread: Int = 0) -> ChannelState {
        channel(id, type: "dm", unread: unread, dm: ["me", other], last: String(format: "2026-09-%02dT00:00:00Z", day))
    }

    private var sample: [ChannelState] {
        [
            channel("general"),
            channel("random", unread: 2),
            channel("starred", unread: 1),
            channel("placed"),
            channel("placed-unread", unread: 3, mentions: 1),
            channel("muted", unread: 9, level: "none"),
            channel("archived", unread: 1, archived: true),
            dm("dm-a", with: "a", day: 20, unread: 1),
            dm("dm-b", with: "b", day: 21),
            channel("notes", type: "dm", dm: ["me"], last: "2026-09-01T00:00:00Z"),
        ]
    }

    private func build(groupUnread: Bool, folded: Set<String> = [], collapsed: Bool = false, channels: [ChannelState]? = nil) -> HomeSections.Layout {
        let section = SidebarSectionOut(id: "s1", name: "研究", position: 0, channelIds: ["placed", "placed-unread"], collapsed: collapsed)
        return HomeSections.build(HomeSections.Input(channels: channels ?? sample, meId: "me", favorites: ["starred"], sections: [section],
                                                     groupUnread: groupUnread, folded: folded))
    }

    func testSectionsWithoutGrouping() {
        let layout = build(groupUnread: false)
        XCTAssertEqual(layout.unread.map(\.id), [])
        XCTAssertEqual(layout.favorites.ids, ["starred"])
        XCTAssertEqual(layout.custom.map(\.rows.ids), [["placed", "placed-unread"]])
        XCTAssertEqual(layout.channels.ids, ["general", "muted", "random"])
        // My DM with myself first, then the newest.
        XCTAssertEqual(layout.dms.ids, ["notes", "dm-b", "dm-a"])
        XCTAssertFalse(layout.moreDms)
        XCTAssertFalse(layout.notesRow)
    }

    func testGroupingGathersEveryUnreadConversationOutOfItsSection() {
        let layout = build(groupUnread: true)
        // Newest first; a muted channel with posts but no mention is not unread, an archived one is not listed.
        XCTAssertEqual(Set(layout.unread.map(\.id)), ["random", "starred", "placed-unread", "dm-a"])
        XCTAssertEqual(layout.unread.first?.id, "dm-a")
        XCTAssertTrue(layout.favorites.isEmpty)
        XCTAssertEqual(layout.custom.map(\.rows.ids), [["placed"]])
        XCTAssertEqual(layout.channels.ids, ["general", "muted"])
        XCTAssertEqual(layout.dms.ids, ["notes", "dm-b"])
    }

    func testFoldedSectionsStillShowUnread() {
        let layout = build(groupUnread: false, folded: ["channels", "dms", "favorites"], collapsed: true)
        XCTAssertEqual(layout.channels.ids, ["random"])
        XCTAssertFalse(layout.channels.isEmpty)
        XCTAssertEqual(layout.favorites.ids, ["starred"])
        XCTAssertEqual(layout.custom.map(\.rows.ids), [["placed-unread"]])
        XCTAssertEqual(layout.dms.ids, ["dm-a"])
        // Folded: no stand-in row, no 「すべての DM」.
        XCTAssertFalse(layout.notesRow)
        XCTAssertFalse(layout.moreDms)
    }

    func testTheDMSectionShowsMyNotesAndTheFiveNewest() {
        var rows = (1...8).map { dm("dm-\($0)", with: "u\($0)", day: $0) }
        rows.append(channel("notes", type: "dm", dm: ["me"]))
        var layout = build(groupUnread: false, channels: rows)
        XCTAssertEqual(layout.dms.ids, ["notes", "dm-8", "dm-7", "dm-6", "dm-5", "dm-4"])
        XCTAssertTrue(layout.moreDms)
        // An unread one further down is not hidden.
        rows[0].unreadCount = 1
        layout = build(groupUnread: false, channels: rows)
        XCTAssertEqual(layout.dms.ids, ["notes", "dm-8", "dm-7", "dm-6", "dm-5", "dm-4", "dm-1"])
        XCTAssertTrue(layout.moreDms)
        // Five or fewer: no link to the DM tab; no DM with myself yet: its row stands in.
        layout = build(groupUnread: false, channels: Array(rows.prefix(5)))
        XCTAssertFalse(layout.moreDms)
        XCTAssertTrue(layout.notesRow)
    }

    func testTiles() {
        let tiles = HomeTile.tiles(threads: ThreadSummary(unreadCount: 3, mentionCount: 1), drafts: 0, saved: 5, firedReminders: 2)
        // M52: カレンダー after リマインダー; M56: タスク after カレンダー; L8: Times (the feed) after スレッド; M78: キャンバス after ファイル; M86: 締切 after タスク.
        XCTAssertEqual(tiles.map(\.kind), [.threads, .times, .drafts, .saved, .reminders, .calendar, .tasks, .deadlines, .files, .canvases])
        XCTAssertEqual(tiles.map(\.count), [3, nil, 0, 5, 2, nil, nil, nil, nil, nil])
        XCTAssertEqual(tiles.map(\.alert), [true, false, false, false, true, false, false, false, false, false])
        XCTAssertEqual(tiles.map(\.dimmed), [false, false, true, false, false, false, false, false, false, false])
        XCTAssertEqual(tiles[1].title, "Times")
        XCTAssertEqual(tiles[1].selectionId, TimesFeedView.selectionId)
        XCTAssertEqual(tiles[1].accessibilityValue, "")
        XCTAssertEqual(tiles[5].title, "カレンダー")
        XCTAssertEqual(tiles[5].selectionId, CalendarView.selectionId)
        XCTAssertEqual(tiles[6].title, "タスク")
        XCTAssertEqual(tiles[6].icon, "checklist")
        XCTAssertEqual(tiles[6].selectionId, MyTasksView.selectionId)
        XCTAssertEqual(tiles[7].title, "締切")
        XCTAssertEqual(tiles[7].selectionId, DeadlinesView.selectionId)
        let quiet = HomeTile.tiles(threads: ThreadSummary(unreadCount: 2, mentionCount: 0), drafts: 1, saved: 0, firedReminders: 0)
        XCTAssertEqual(quiet.map(\.alert), [false, false, false, false, false, false, false, false, false, false])
        XCTAssertEqual(quiet.map(\.dimmed), [false, false, false, true, true, false, false, false, false, false])
        XCTAssertEqual(quiet[0].selectionId, ThreadsListView.selectionId)
    }
}

/// DATA_MODEL.md sidebar_sections 「セクションの中の並び順」「並べ替え」: the cases the desktop and Android share
/// (apps/shared/sidebar-order.json).
final class SidebarOrderTests: XCTestCase {
    private struct Vectors: Decodable {
        struct Names: Decodable { let name: String; let input: [String]; let sorted: [String] }
        struct Conversation: Decodable {
            let id: String, type: String, name: String?, title: String?, last_message_at: String?, created_at: String
        }
        struct Section: Decodable {
            let name: String; let sort: String?; let manual_order: [String]?; let conversations: [Conversation]; let order: [String]
        }
        let names: [Names]
        let sections: [Section]
    }

    private func vectors() throws -> Vectors {
        // The repository's own file (the simulator reads the Mac's disk).
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("shared/sidebar-order.json")
        return try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
    }

    private func row(_ id: String, type: String, name: String?, last: String?, created: String = "2026-01-01T00:00:00Z") -> ChannelState {
        ChannelState(channel: ChannelOut(id: id, type: type, name: name, topic: nil, purpose: nil, archived: false, createdBy: nil, lastSeq: 0,
                                         lastMessageAt: last, createdAt: created, updatedAt: "", membership: nil,
                                         dmUserIds: name == nil ? ["me", id] : nil, readState: nil, notification: nil),
                     isMember: true, syncedSeq: nil, lastSeq: 0, lastReadSeq: 0, unreadCount: 0, mentionCount: 0, hasOlder: true)
    }

    func testSharedCases() throws {
        let v = try vectors()
        XCTAssertGreaterThan(v.names.count + v.sections.count, 15)
        for c in v.names {
            XCTAssertEqual(c.input.sorted(by: SidebarOrder.namesInOrder), c.sorted, c.name)
        }
        for c in v.sections {
            let rows = c.conversations.map { row($0.id, type: $0.type, name: $0.name, last: $0.last_message_at, created: $0.created_at) }
            let titles = Dictionary(uniqueKeysWithValues: c.conversations.map { ($0.id, $0.title ?? $0.name ?? "") })
            let sorted = SidebarOrder.section(rows, sort: c.sort ?? "name", manualOrder: c.manual_order ?? []) { titles[$0.id] ?? "" }
            XCTAssertEqual(sorted.map(\.id), c.order, c.name)
        }
    }

    /// The default sections follow the server's sorts; 「手動」 puts my own DM where I put it.
    func testDefaultSortsAndEditing() {
        let all = [row("c1", type: "public", name: "2026修論指導", last: "2026-10-06T00:00:00Z"), row("c2", type: "public", name: "2026院ゼミ", last: nil),
                   row("d1", type: "dm", name: nil, last: "2026-10-01T00:00:00Z"), row("d2", type: "dm", name: nil, last: "2026-10-05T00:00:00Z")]
        var input = HomeSections.Input(channels: all, meId: "me", folded: ["channels"])
        XCTAssertEqual(HomeSections.build(input).channels.ids, [])  // folded, nothing unread
        input.editing = "channels"
        XCTAssertEqual(HomeSections.build(input).channels.ids, ["c2", "c1"])  // reordering shows every row
        input.folded = []
        XCTAssertEqual(HomeSections.build(input).dms.ids, ["d2", "d1"])
        input.defaults = [SidebarDefaultOut(key: "channels", sort: "recent"), SidebarDefaultOut(key: "dms", sort: "manual", manualOrder: ["d1"])]
        XCTAssertEqual(HomeSections.build(input).channels.ids, ["c1", "c2"])
        XCTAssertEqual(HomeSections.build(input).dms.ids, ["d1", "d2"])
        let section = SidebarSectionOut(id: "s1", name: "研究", position: 0, channelIds: ["c1", "c2"], sort: "manual", manualOrder: ["c1", "c2"])
        input.sections = [section]
        XCTAssertEqual(HomeSections.build(input).custom.first?.rows.ids, ["c1", "c2"])
    }

    /// The home's favorites and my own sections follow it (channels by name, then DMs by their title).
    func testHomeUsesIt() {
        let all = [row("z", type: "public", name: "zeta", last: nil), row("d", type: "dm", name: nil, last: "2026-10-01T00:00:00Z"),
                   row("a", type: "public", name: "Alpha", last: nil), row("k", type: "public", name: "カメラ", last: nil),
                   row("i", type: "public", name: "いぬ", last: nil), row("d2", type: "dm", name: nil, last: "2026-10-02T00:00:00Z")]
        let section = SidebarSectionOut(id: "s1", name: "研究", position: 0, channelIds: ["k", "i", "d"])
        let layout = HomeSections.build(HomeSections.Input(channels: all, meId: "me", favorites: ["z", "a", "d2"], sections: [section]))
        XCTAssertEqual(layout.favorites.ids, ["a", "z", "d2"])
        XCTAssertEqual(layout.custom.first?.rows.ids, ["i", "k", "d"])
    }
}
