import XCTest
@testable import ChikuwaChat

/// M140 (docs/PRESENCE.md §9): 在室状況 on the phone — the board's groups and order, the buttons, the events, and
/// nothing for guests or while it is off.
@MainActor
final class AttendanceTests: XCTestCase {
    private func state(_ id: String, _ label: String, kind: String, owner: String? = nil, position: Int = 0, archived: Bool = false,
                       emoji: String? = nil, color: String = "gray") -> AttendanceStateOut {
        AttendanceStateOut(id: id, ownerId: owner, label: label, emoji: emoji, color: color, kind: kind, position: position, archived: archived)
    }

    private func user(_ id: String, _ name: String, role: String = "member", deactivated: Bool = false) -> UserPublic {
        UserPublic(id: id, username: id, displayName: name, role: role, deactivatedAt: deactivated ? "2026-10-01T00:00:00Z" : nil,
                   createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z")
    }

    private func entry(_ userId: String, _ stateId: String, since: String = "2026-10-07T09:15:00Z", note: String? = nil) -> AttendanceEntryOut {
        AttendanceEntryOut(userId: userId, stateId: stateId, since: since, note: note, source: "app")
    }

    private var states: [AttendanceStateOut] {
        [
            state("gone", "帰宅", kind: "gone", position: 3),
            state("room", "在室", kind: "in_room", position: 0, emoji: "🟢", color: "green"),
            state("site", "学内", kind: "on_site", position: 1, color: "blue"),
            state("off", "学外", kind: "off_site", position: 2, color: "orange"),
            state("meeting", "会議", kind: "on_site", owner: "u1", position: 0),
            state("trip", "出張", kind: "off_site", owner: "u2", position: 0),
            state("old", "旧", kind: "in_room", owner: "u1", position: 1, archived: true),
        ]
    }

    func testDecodesTheServersBoard() throws {
        let json = """
        {"enabled": true, "can_personalize": true,
         "states": [{"id": "s1", "owner_id": null, "label": "在室", "emoji": "🟢", "color": "green", "kind": "in_room", "position": 0, "archived": false}],
         "entries": [{"user_id": "u1", "state_id": "s1", "since": "2026-10-07T09:15:00.123456Z", "note": null, "source": "integration"}]}
        """
        let board = try JSON.snakeDecoder.decode(AttendanceBoardOut.self, from: Data(json.utf8))
        XCTAssertTrue(board.enabled)
        XCTAssertTrue(board.canPersonalize)
        XCTAssertEqual(board.states.first?.ownerId, nil)
        XCTAssertEqual(board.states.first?.kind, "in_room")
        XCTAssertEqual(board.entries.first?.source, "integration")
        // The bootstrap's field (null for guests and while off).
        let bootstrap = try JSON.snakeDecoder.decode(JSONValue.self, from: Data(json.utf8))
        XCTAssertEqual(try bootstrap.decode(AttendanceBoardOut.self), board)
    }

    func testBoardGroupsInKindOrderWithUnsetLastAndOnlyPeopleOnTheBoard() {
        let users = [
            user("u1", "Alice"), user("u2", "Bob"), user("u3", "Carol"), user("u4", "Dave"), user("u5", "Eve"),
            user("g", "Guest", role: "guest"), user("b", "Bot", role: "bot"), user("x", "Gone", deactivated: true),
        ]
        let board = AttendanceBoardOut(enabled: true, states: states, entries: [
            entry("u3", "room", since: "2026-10-07T10:00:00Z"),
            entry("u1", "room", since: "2026-10-07T09:00:00Z"),
            entry("u2", "trip"),
            entry("u4", "meeting"),
            entry("g", "room"), entry("b", "room"), entry("x", "room"),
        ])
        let groups = AttendanceRules.groups(board, users: users)
        // in_room → on_site (personal 会議; 学内 is empty and left out) → off_site (personal 出張) → 未設定.
        XCTAssertEqual(groups.map(\.id), ["room", "meeting", "trip", "unset"])
        // Who came first first.
        XCTAssertEqual(groups[0].people.map(\.user.id), ["u1", "u3"])
        XCTAssertEqual(groups.last?.people.map(\.user.id), ["u5"])
        XCTAssertNil(groups.last?.state)
        XCTAssertEqual(AttendanceRules.inRoomCount(board, users: users), 2)
    }

    func testWorkspaceStatesComeBeforePersonalOnesOfTheSameKind() {
        let users = [user("u1", "A"), user("u2", "B")]
        let board = AttendanceBoardOut(enabled: true, states: states, entries: [entry("u1", "meeting"), entry("u2", "site")])
        XCTAssertEqual(AttendanceRules.groups(board, users: users).map(\.id), ["site", "meeting"])
    }

    func testAnArchivedStateStillShowsItsPeopleButIsNoButton() {
        let board = AttendanceBoardOut(enabled: true, states: states, entries: [entry("u1", "old")])
        XCTAssertEqual(AttendanceRules.groups(board, users: [user("u1", "A")]).map(\.id), ["old"])
        XCTAssertEqual(AttendanceRules.myChoices(board, me: "u1").map(\.id), ["room", "site", "off", "gone", "meeting"])
        XCTAssertEqual(AttendanceRules.myOwnStates(board, me: "u1").map(\.id), ["meeting"])
        XCTAssertEqual(AttendanceRules.myChoices(board, me: "u2").map(\.id), ["room", "site", "off", "gone", "trip"])
    }

    func testButtonStateAndTheNoteAPressSends() {
        let mine = entry("u1", "room", note: "3 号室")
        let room = states[1], site = states[2]
        XCTAssertTrue(AttendanceRules.isSelected(room, mine: mine))
        XCTAssertFalse(AttendanceRules.isSelected(site, mine: mine))
        XCTAssertFalse(AttendanceRules.isSelected(room, mine: nil))
        XCTAssertEqual(AttendanceRules.noteForChoice(room, mine: mine), "3 号室")  // the same state keeps the note
        XCTAssertNil(AttendanceRules.noteForChoice(site, mine: mine))  // another one starts without one
        XCTAssertNil(AttendanceRules.cleanNote("  \n "))
        XCTAssertEqual(AttendanceRules.cleanNote(" 15 時に戻ります "), "15 時に戻ります")
        XCTAssertEqual(AttendanceRules.cleanNote(String(repeating: "あ", count: 120))?.count, 100)
    }

    func testAnEventReplacesTheRowAndAnUnknownStateAsksForTheBoard() {
        let board = AttendanceBoardOut(enabled: true, states: states, entries: [entry("u1", "room"), entry("u2", "site")])
        let moved = AttendanceRules.applying(entry("u1", "gone", since: "2026-10-07T18:00:00Z"), to: board)
        XCTAssertTrue(moved.known)
        XCTAssertEqual(moved.board.entries.map(\.userId), ["u1", "u2"])
        XCTAssertEqual(moved.board.entries.first?.stateId, "gone")
        let added = AttendanceRules.applying(entry("u3", "new-own"), to: board)
        XCTAssertFalse(added.known)
        XCTAssertEqual(added.board.entries.count, 3)
    }

    func testTheStoreKeepsNothingWhileOff() {
        let store = Store()
        store.setAttendance(AttendanceBoardOut(enabled: false, states: [], entries: []))
        XCTAssertNil(store.attendance)
        XCTAssertTrue(store.applyAttendanceEntry(entry("u1", "room")))  // nothing held: nothing to read
        store.setAttendance(AttendanceBoardOut(enabled: true, states: states, entries: []))
        XCTAssertTrue(store.applyAttendanceEntry(entry("u1", "room")))
        XCTAssertEqual(store.attendance?.entries.count, 1)
        XCTAssertFalse(store.applyAttendanceEntry(entry("u1", "unknown")))
        store.setAttendance(nil)
        XCTAssertNil(store.attendance)
    }

    func testVisibleOnlyForMembersWhileOn() {
        let on = AttendanceBoardOut(enabled: true, states: states, entries: [])
        XCTAssertTrue(AttendanceRules.visible(board: on, role: "member"))
        XCTAssertTrue(AttendanceRules.visible(board: on, role: "admin"))
        XCTAssertFalse(AttendanceRules.visible(board: on, role: "guest"))
        XCTAssertFalse(AttendanceRules.visible(board: on, role: "bot"))
        XCTAssertFalse(AttendanceRules.visible(board: AttendanceBoardOut(enabled: false, states: [], entries: []), role: "member"))
        XCTAssertFalse(AttendanceRules.visible(board: nil, role: "member"))
    }

    func testTheChip() {
        let board = AttendanceBoardOut(enabled: true, states: states, entries: [entry("u1", "room", note: "3 号室")])
        XCTAssertEqual(AttendanceRules.chip(board, "u1")?.state.label, "在室")
        XCTAssertNil(AttendanceRules.chip(board, "u2"))
        XCTAssertNil(AttendanceRules.chip(nil, "u1"))
        XCTAssertEqual(AttendanceRules.stateText(states[1]), "🟢 在室")
        XCTAssertEqual(AttendanceRules.stateText(states[2]), "学内")
    }

    func testSinceLabel() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Tokyo")!
        let now = ISO8601DateFormatter().date(from: "2026-10-07T03:00:00Z")!  // 12:00 in Tokyo
        XCTAssertEqual(AttendanceRules.sinceLabel("2026-10-07T00:15:00Z", now: now, calendar: calendar), "9:15 から")
        XCTAssertEqual(AttendanceRules.sinceLabel("2026-10-06T09:02:00Z", now: now, calendar: calendar), "10/6 18:02 から")
    }

    func testTheTileOnlyWhileOnAndInMyOrder() {
        let threads = ThreadSummary(unreadCount: 0, mentionCount: 0)
        let off = HomeTile.tiles(threads: threads, drafts: 0, saved: 0, firedReminders: 0, navItems: nil)
        XCTAssertFalse(off.contains { $0.kind == .attendance })
        let on = HomeTile.tiles(threads: threads, drafts: 0, saved: 0, firedReminders: 0, navItems: nil, attendance: 3)
        XCTAssertEqual(on.last?.kind, .attendance)
        XCTAssertEqual(on.last?.count, 3)
        XCTAssertEqual(on.last?.alert, false)
        XCTAssertEqual(on.last?.selectionId, AttendanceView.selectionId)
        let hidden = HomeTile.tiles(threads: threads, drafts: 0, saved: 0, firedReminders: 0,
                                    navItems: [NavItem(key: "attendance", visible: false)], attendance: 3)
        XCTAssertFalse(hidden.contains { $0.kind == .attendance })
        let first = HomeTile.tiles(threads: threads, drafts: 0, saved: 0, firedReminders: 0,
                                   navItems: [NavItem(key: "attendance", visible: true)], attendance: 0)
        XCTAssertEqual(first.first?.kind, .attendance)
        XCTAssertFalse(NavItems.implemented.contains("attendance"))
        XCTAssertTrue(NavItems.implemented(attendance: true).contains("attendance"))
    }

    // MARK: the engine

    private func engine(_ server: FakeServer, _ userId: String, _ store: Store) -> SyncEngine {
        var options = EngineOptions()
        options.sleep = { _ in }
        return SyncEngine(api: server.api(for: userId), connect: server.connector(for: userId), wsUrl: URL(string: "ws://fake")!, store: store,
                          getAccessToken: { "t" }, options: options)
    }

    func testBootstrapEventsAndReadsAgain() async throws {
        let server = FakeServer()
        let alice = server.addUser("alice")
        let bob = server.addUser("bob")
        server.attendance = AttendanceBoardOut(enabled: true, states: Array(states.prefix(4)), entries: [], canPersonalize: true)
        let store = Store()
        let engine = engine(server, bob.id, store)
        await engine.start()
        await engine.idle()
        XCTAssertEqual(store.attendance?.states.count, 4)
        XCTAssertEqual(store.attendance?.canPersonalize, true)

        // attendance.updated replaces the row, no read.
        let reads = server.attendanceReads
        server.setAttendance(entry(alice.id, "room", note: "3 号室"))
        await engine.idle()
        XCTAssertEqual(AttendanceRules.entry(store.attendance, alice.id)?.note, "3 号室")
        server.setAttendance(entry(alice.id, "site"))
        await engine.idle()
        XCTAssertEqual(store.attendance?.entries.count, 1)
        XCTAssertEqual(AttendanceRules.entry(store.attendance, alice.id)?.stateId, "site")
        XCTAssertEqual(server.attendanceReads, reads)

        // Someone's new own state: the board is read again.
        var board = server.attendance!
        board.states.append(state("own", "会議", kind: "on_site", owner: alice.id))
        server.attendance = board
        server.setAttendance(entry(alice.id, "own"))
        await engine.idle()
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(server.attendanceReads, reads + 1)
        XCTAssertEqual(AttendanceRules.chip(store.attendance, alice.id)?.state.label, "会議")

        // A burst of attendance.config_updated: one read; turned off: gone.
        server.setAttendanceConfig(AttendanceBoardOut(enabled: true, states: Array(states.prefix(2)), entries: []))
        server.setAttendanceConfig(AttendanceBoardOut(enabled: false, states: [], entries: []))
        await engine.idle()
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(server.attendanceReads, reads + 2)
        XCTAssertNil(store.attendance)

        // On again.
        server.setAttendanceConfig(AttendanceBoardOut(enabled: true, states: Array(states.prefix(4)), entries: []))
        await engine.idle()
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(store.attendance?.states.count, 4)
        engine.stop()
    }

    func testAGuestNeverHasTheBoard() async throws {
        let server = FakeServer()
        let guest = server.addUser("guest", role: "guest")
        server.attendance = AttendanceBoardOut(enabled: true, states: states, entries: [])
        let store = Store()
        let engine = engine(server, guest.id, store)
        await engine.start()
        await engine.idle()
        XCTAssertNil(store.attendance)
        await engine.loadAttendance()
        XCTAssertEqual(server.attendanceReads, 0)  // not even asked
        XCTAssertNil(store.attendance)
        engine.stop()
    }
}
