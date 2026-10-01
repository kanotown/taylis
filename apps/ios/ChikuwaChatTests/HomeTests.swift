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
        // M52: カレンダー after リマインダー; M56: タスク after カレンダー; L8: Times (the feed) after スレッド.
        XCTAssertEqual(tiles.map(\.kind), [.threads, .times, .drafts, .saved, .reminders, .calendar, .tasks, .files])
        XCTAssertEqual(tiles.map(\.count), [3, nil, 0, 5, 2, nil, nil, nil])
        XCTAssertEqual(tiles.map(\.alert), [true, false, false, false, true, false, false, false])
        XCTAssertEqual(tiles.map(\.dimmed), [false, false, true, false, false, false, false, false])
        XCTAssertEqual(tiles[1].title, "Times")
        XCTAssertEqual(tiles[1].selectionId, TimesFeedView.selectionId)
        XCTAssertEqual(tiles[1].accessibilityValue, "")
        XCTAssertEqual(tiles[5].title, "カレンダー")
        XCTAssertEqual(tiles[5].selectionId, CalendarView.selectionId)
        XCTAssertEqual(tiles[6].title, "タスク")
        XCTAssertEqual(tiles[6].icon, "checklist")
        XCTAssertEqual(tiles[6].selectionId, MyTasksView.selectionId)
        let quiet = HomeTile.tiles(threads: ThreadSummary(unreadCount: 2, mentionCount: 0), drafts: 1, saved: 0, firedReminders: 0)
        XCTAssertEqual(quiet.map(\.alert), [false, false, false, false, false, false, false, false])
        XCTAssertEqual(quiet.map(\.dimmed), [false, false, false, true, true, false, false, false])
        XCTAssertEqual(quiet[0].selectionId, ThreadsListView.selectionId)
    }
}
