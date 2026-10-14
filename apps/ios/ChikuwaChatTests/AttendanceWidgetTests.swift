import SwiftUI
import WidgetKit
import XCTest
@testable import ChikuwaChat

/// The 在室状況 widget (Widgets/, ChikuwaChat/Widget): the snapshot the app writes and the extension reads, the buttons
/// it offers, its 「在室 n 人」 (the app's rule), the requests its intent sends (no network: a stub URLProtocol), the
/// link into the app, and its faces (TEST_RUNNER_SNAPSHOT_DIR=<dir> writes them as PNGs).
@MainActor
final class AttendanceWidgetTests: XCTestCase {
    private func state(_ id: String, _ label: String, kind: String, owner: String? = nil, position: Int = 0, archived: Bool = false,
                       icon: String? = nil, emoji: String? = nil, color: String = "gray") -> AttendanceStateOut {
        AttendanceStateOut(id: id, ownerId: owner, label: label, emoji: emoji, icon: icon, color: color, kind: kind, position: position,
                           archived: archived)
    }

    private func user(_ id: String, _ name: String? = nil, role: String = "member", deactivated: Bool = false) -> UserPublic {
        UserPublic(id: id, username: id, displayName: name ?? id, role: role, deactivatedAt: deactivated ? "2026-10-01T00:00:00Z" : nil,
                   createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z")
    }

    private func entry(_ userId: String, _ stateId: String, note: String? = nil, since: String = "2026-10-13T09:15:00Z") -> AttendanceEntryOut {
        AttendanceEntryOut(userId: userId, stateId: stateId, since: since, note: note, source: "app")
    }

    /// The default four (out of order), my own two (one deleted), someone else's own one.
    private var states: [AttendanceStateOut] {
        [
            state("gone", "帰宅", kind: "gone", position: 3, icon: "gone", emoji: "🏠", color: "red"),
            state("room", "在室", kind: "in_room", position: 0, icon: "in_room", emoji: "🟢", color: "green"),
            state("site", "学内", kind: "on_site", position: 1, icon: "on_site", color: "blue"),
            state("off", "学外", kind: "off_site", position: 2, icon: "off_site", color: "purple"),
            state("meeting", "会議", kind: "in_room", owner: "me", position: 0, emoji: "🗣️", color: "orange"),
            state("old", "旧", kind: "in_room", owner: "me", position: 1, archived: true),
            state("trip", "出張", kind: "off_site", owner: "u2", position: 0),
        ]
    }

    private var users: [UserPublic] {
        [user("me", "加納 徹"), user("u2", "花子"), user("u3", "次郎"), user("u4", "Taro Yamada"), user("u5", "美咲"), user("u6", "Ken Sato"),
         user("g", role: "guest"), user("b", role: "bot"), user("x", deactivated: true)]
    }

    private let workspace = Workspace(serverUrl: "https://lab.example.jp", name: "加納研", username: "kano")

    private func board(_ entries: [AttendanceEntryOut]) -> AttendanceBoardOut {
        AttendanceBoardOut(enabled: true, states: states, entries: entries)
    }

    private func snapshot(_ entries: [AttendanceEntryOut], now: Date = Date(timeIntervalSince1970: 1_800_000_000)) -> AttendanceWidgetSnapshot {
        AppController.attendanceWidgetSnapshot(board: board(entries), users: users, workspace: workspace, meId: "me", now: now)
    }

    private func storeFile() -> URL {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("AttendanceWidgetTests-\(UUID().uuidString)/attendance.json")
        addTeardownBlock { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
        return file
    }

    // MARK: the snapshot

    func testSnapshotKeepsTheBoardAndTheAppsTablesAndSurvivesEncoding() throws {
        let s = snapshot([entry("me", "room", note: "3 号室"), entry("u2", "site")])
        XCTAssertEqual(s.serverUrl, "https://lab.example.jp")
        XCTAssertEqual(s.account, "https://lab.example.jp|kano")
        XCTAssertEqual(s.workspaceName, "加納研")
        XCTAssertTrue(s.available)
        XCTAssertEqual(s.states.count, states.count)
        XCTAssertEqual(s.symbols["in_room"], AttendanceIcons.symbol("in_room"))
        XCTAssertEqual(s.symbols.count, AttendanceIcons.catalogue.count)
        XCTAssertEqual(s.colors, AttendancePalette.badgeColors)
        let decoded = try JSONDecoder().decode(AttendanceWidgetSnapshot.self, from: JSONEncoder().encode(s))
        XCTAssertEqual(decoded, s)
        XCTAssertEqual(AttendanceWidgetRules.myEntry(decoded)?.note, "3 号室")
    }

    func testBoardOffOrGuestIsNotAvailable() {
        let off = AppController.attendanceWidgetSnapshot(board: nil, users: users, workspace: workspace, meId: "me")
        XCTAssertFalse(off.available)
        XCTAssertEqual(AttendanceWidgetRules.mediumButtons(off), [])
        XCTAssertNil(AttendanceWidgetRules.toggleTarget(off))
    }

    func testDecodesTheServersBoardAndEntry() throws {
        let json = """
        {"enabled": true, "can_personalize": false,
         "states": [{"id": "s1", "owner_id": null, "label": "在室", "icon": "in_room", "emoji": "🟢", "color": "green", "kind": "in_room",
                     "position": 0, "archived": false},
                    {"id": "s2", "owner_id": "me", "label": "会議", "emoji": null, "color": "orange", "kind": "in_room", "position": 0}],
         "entries": [{"user_id": "me", "state_id": "s1", "since": "2026-10-13T09:15:00.123456Z", "note": null, "source": "app"}]}
        """
        let board = try JSON.snakeDecoder.decode(AttendanceWidgetBoard.self, from: Data(json.utf8))
        XCTAssertTrue(board.enabled)
        XCTAssertEqual(board.states.map(\.id), ["s1", "s2"])
        XCTAssertNil(board.states[1].icon)
        XCTAssertFalse(board.states[1].archived)  // missing = not deleted
        XCTAssertEqual(board.entries.first?.stateId, "s1")
        let off = try JSON.snakeDecoder.decode(AttendanceWidgetBoard.self, from: Data(#"{"enabled": false, "states": [], "entries": [], "can_personalize": false}"#.utf8))
        XCTAssertFalse(off.enabled)
        let mine = try JSON.snakeDecoder.decode(AttendanceWidgetEntry.self, from: Data(
            #"{"user_id": "me", "state_id": "s2", "since": "2026-10-13T09:15:00Z", "note": "A 会議室", "source": "app"}"#.utf8))
        XCTAssertEqual(mine, AttendanceWidgetEntry(userId: "me", stateId: "s2", since: "2026-10-13T09:15:00Z", note: "A 会議室"))
    }

    func testStoreSavesPerAccountSaysWhenSomethingChangedAndForgets() {
        let file = storeFile()
        let first = snapshot([entry("me", "room")])
        XCTAssertTrue(AttendanceWidgetStore.save(first, active: true, to: file))
        var later = first
        later.updatedAt = first.updatedAt.addingTimeInterval(60)
        XCTAssertFalse(AttendanceWidgetStore.save(later, active: true, to: file), "only the time changed: no reload")
        XCTAssertEqual(AttendanceWidgetStore.snapshot(account: first.account, file)?.updatedAt, later.updatedAt)
        let moved = snapshot([entry("me", "gone")])
        XCTAssertTrue(AttendanceWidgetStore.save(moved, active: true, to: file))
        XCTAssertEqual(AttendanceWidgetStore.current(file).flatMap(AttendanceWidgetRules.myState)?.id, "gone")
        AttendanceWidgetStore.remove(account: first.account, file)
        XCTAssertNil(AttendanceWidgetStore.current(file))
        XCTAssertNil(AttendanceWidgetStore.active(file))
    }

    func testTheActiveWorkspaceWinsWhileItHasTheBoardElseTheLastOneSeen() {
        var a = snapshot([entry("me", "room")])
        a.account = "a"
        var b = a
        b.account = "b"
        b.updatedAt = a.updatedAt.addingTimeInterval(10)
        var off = a
        off.account = "off"
        off.available = false
        XCTAssertEqual(AttendanceWidgetRules.select(["a": a, "b": b], active: "a")?.account, "a")
        XCTAssertEqual(AttendanceWidgetRules.select(["a": a, "b": b, "off": off], active: "off")?.account, "b")
        XCTAssertEqual(AttendanceWidgetRules.select(["off": off], active: "off")?.account, "off")
        XCTAssertNil(AttendanceWidgetRules.select([:], active: "a"))
    }

    func testNeedsRefreshWhenOldOrAfterAFailure() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        var s = snapshot([], now: now)
        XCTAssertFalse(s.needsRefresh(now: now.addingTimeInterval(60)))
        XCTAssertTrue(s.needsRefresh(now: now.addingTimeInterval(AttendanceWidgetSnapshot.freshFor)))
        s.problem = .offline
        XCTAssertTrue(s.needsRefresh(now: now))
    }

    // MARK: buttons and the count

    func testButtonsAreTheAppsInItsOrderAndMediumShowsTheFirstFour() {
        let s = snapshot([entry("me", "room")])
        let app = AttendanceRules.myChoices(board([]), me: "me").map(\.id)
        XCTAssertEqual(AttendanceWidgetRules.choices(s).map(\.id), app)
        XCTAssertEqual(app, ["room", "site", "off", "gone", "meeting"])  // not the deleted one, not someone else's
        XCTAssertEqual(AttendanceWidgetRules.mediumButtons(s).map(\.id), ["room", "site", "off", "gone"])
    }

    func testSmallButtonTogglesBetweenInTheRoomAndGoneHome() {
        XCTAssertEqual(AttendanceWidgetRules.toggleTarget(snapshot([entry("me", "room")]))?.id, "gone")
        XCTAssertEqual(AttendanceWidgetRules.toggleTarget(snapshot([entry("me", "meeting")]))?.id, "gone", "my own in_room state is in the room")
        XCTAssertEqual(AttendanceWidgetRules.toggleTarget(snapshot([entry("me", "site")]))?.id, "room")
        XCTAssertEqual(AttendanceWidgetRules.toggleTarget(snapshot([entry("me", "gone")]))?.id, "room")
        XCTAssertEqual(AttendanceWidgetRules.toggleTarget(snapshot([]))?.id, "room", "no state yet: arrive")
        XCTAssertTrue(AttendanceWidgetRules.isInRoom(snapshot([entry("me", "meeting")])))
        XCTAssertFalse(AttendanceWidgetRules.isInRoom(snapshot([entry("me", "off")])))
        // A board without a gone-kind state has nothing to leave to.
        var s = snapshot([entry("me", "room")])
        s.states.removeAll { $0.kind == "gone" }
        XCTAssertNil(AttendanceWidgetRules.toggleTarget(s))
    }

    func testCountIsTheHeaderChipsCount() {
        let entries = [entry("me", "room"), entry("u2", "meeting"), entry("u3", "site"), entry("u4", "room"),
                       entry("g", "room"), entry("b", "room"), entry("x", "room")]
        let s = snapshot(entries)
        XCTAssertEqual(AttendanceWidgetRules.inRoomCount(s), AttendanceRules.inRoomCount(board(entries), users: users))
        XCTAssertEqual(AttendanceWidgetRules.inRoomCount(s), 3)  // not the guest, the bot or the deactivated one
    }

    func testNoteIsKeptOnlyForMyCurrentState() {
        let s = snapshot([entry("me", "room", note: "3 号室")])
        XCTAssertEqual(AttendanceWidgetRules.noteForChoice(s, stateId: "room"), "3 号室")
        XCTAssertNil(AttendanceWidgetRules.noteForChoice(s, stateId: "gone"))
        XCTAssertNil(AttendanceWidgetRules.noteForChoice(snapshot([]), stateId: "room"))
    }

    func testGlyphIsTheIconElseAUnicodeEmojiElseNothing() {
        let s = snapshot([])
        func glyph(_ id: String) -> AttendanceWidgetRules.Glyph { AttendanceWidgetRules.glyph(AttendanceWidgetRules.state(s, id)!, symbols: s.symbols) }
        XCTAssertEqual(glyph("room"), .symbol("door.left.hand.open"))
        XCTAssertEqual(glyph("meeting"), .emoji("🗣️"))
        XCTAssertEqual(glyph("trip"), AttendanceWidgetRules.Glyph.none)
        let custom = AttendanceWidgetState(id: "c", ownerId: nil, label: "c", icon: "unknown", emoji: ":party:", color: "teal", kind: "on_site", position: 9)
        XCTAssertEqual(AttendanceWidgetRules.glyph(custom, symbols: s.symbols), AttendanceWidgetRules.Glyph.none)
        XCTAssertEqual(AttendanceWidgetRules.color(custom, colors: s.colors), 0x4B5563)
        XCTAssertEqual(AttendanceWidgetRules.color(AttendanceWidgetRules.state(s, "room")!, colors: s.colors), 0x15803D)
    }

    // MARK: the server's answers

    func testAnswersAndFailures() {
        let s = snapshot([entry("me", "room"), entry("u2", "room")])
        let (moved, known) = AttendanceWidgetRules.applying(AttendanceWidgetEntry(userId: "me", stateId: "gone"), to: s)
        XCTAssertTrue(known)
        XCTAssertEqual(AttendanceWidgetRules.myState(moved)?.id, "gone")
        XCTAssertEqual(AttendanceWidgetRules.inRoomCount(moved), 1)
        XCTAssertFalse(AttendanceWidgetRules.applying(AttendanceWidgetEntry(userId: "me", stateId: "new"), to: s).1)

        XCTAssertEqual(AttendanceWidgetRules.failed(s, .temporary("network_error")).problem, .offline)
        XCTAssertEqual(AttendanceWidgetRules.failed(s, .notSignedIn).problem, .signedOut)
        XCTAssertEqual(AttendanceWidgetRules.failed(s, .refused(status: 422, code: "attendance_state_invalid")).problem, .refused)
        let turnedOff = AttendanceWidgetRules.failed(s, .refused(status: 409, code: "attendance_disabled"))
        XCTAssertFalse(turnedOff.available)
        XCTAssertNil(turnedOff.problem)
        // What was shown stays after a failure.
        XCTAssertEqual(AttendanceWidgetRules.myState(AttendanceWidgetRules.failed(s, .temporary("x")))?.id, "room")

        let off = AttendanceWidgetRules.applying(AttendanceWidgetBoard(enabled: false), to: AttendanceWidgetRules.failed(s, .temporary("x")))
        XCTAssertFalse(off.available)
        XCTAssertNil(off.problem)
    }

    // MARK: the intent's request

    func testSetRequestIsAPutOfTheStateAndTheKeptNote() throws {
        let body = AttendanceWidgetRules.setBody(stateId: "room", note: nil)
        let request = try ShareApi.request(baseUrl: URL(string: "https://lab.example.jp")!, path: ShareApi.setAttendancePath, method: "PUT",
                                           json: body, token: "tok", language: "en", timeout: 20)
        XCTAssertEqual(request.httpMethod, "PUT")
        XCTAssertEqual(request.url?.absoluteString, "https://lab.example.jp/api/v1/attendance/me")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer tok")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Accept-Language"), "en")
        let sent = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(request.httpBody)) as? [String: Any])
        XCTAssertEqual(sent["state_id"] as? String, "room")
        XCTAssertTrue(sent["note"] is NSNull, "note null = none (the field is sent, PRESENCE.md §3.1)")
        XCTAssertEqual(Set(sent.keys), ["state_id", "note"])
        let kept = AttendanceWidgetRules.setBody(stateId: "room", note: "3 号室")
        XCTAssertEqual(kept["note"] as? String, "3 号室")
    }

    /// The whole button press without a server: the stub answers PUT /attendance/me, then fails, then refuses the token.
    func testButtonPressUpdatesTheSnapshotOrKeepsItWithTheProblem() async throws {
        let file = storeFile()
        let account = "https://widget.test|kano-\(UUID().uuidString)"
        SharedTokens.store(account: account, accessToken: "access", expiresIn: 3600, refreshToken: "refresh")
        addTeardownBlock { Keychain.delete(account: account) }
        var s = snapshot([entry("me", "room", note: "3 号室"), entry("u2", "room")])
        s.serverUrl = "https://widget.test"
        s.account = account
        AttendanceWidgetStore.save(s, active: true, to: file)
        let make: (AttendanceWidgetSnapshot) -> ShareApi? = { snapshot in
            let configuration = URLSessionConfiguration.ephemeral
            configuration.protocolClasses = [WidgetStubProtocol.self]
            let api = ShareApi(baseUrl: URL(string: snapshot.serverUrl)!, account: snapshot.account, language: "ja",
                               session: URLSession(configuration: configuration))
            api.refreshRetryDelays = []
            api.lockProvider = { nil }
            return api
        }

        WidgetStubProtocol.reset { request in
            (200, #"{"user_id": "me", "state_id": "gone", "since": "2026-10-13T18:00:00Z", "note": null, "source": "app"}"#)
        }
        let moved = await AttendanceWidgetActions.setState("gone", account: account, file: file, makeApi: make)
        XCTAssertEqual(moved.flatMap(AttendanceWidgetRules.myState)?.id, "gone")
        XCTAssertEqual(moved.map(AttendanceWidgetRules.inRoomCount), 1)
        let request = try XCTUnwrap(WidgetStubProtocol.requests.first)
        XCTAssertEqual(request.httpMethod, "PUT")
        XCTAssertEqual(request.url?.path, "/api/v1/attendance/me")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer access")
        let sent = try XCTUnwrap(JSONSerialization.jsonObject(with: XCTUnwrap(WidgetStubProtocol.bodies.first)) as? [String: Any])
        XCTAssertEqual(sent["state_id"] as? String, "gone")
        XCTAssertTrue(sent["note"] is NSNull, "another state starts without the note")
        XCTAssertEqual(AttendanceWidgetStore.snapshot(account: account, file)?.entries.first { $0.userId == "me" }?.stateId, "gone")

        WidgetStubProtocol.reset { _ in nil }  // no answer
        let offline = await AttendanceWidgetActions.setState("room", account: account, file: file, makeApi: make)
        XCTAssertEqual(offline?.problem, .offline)
        XCTAssertEqual(offline.flatMap(AttendanceWidgetRules.myState)?.id, "gone", "the last known state stays")

        WidgetStubProtocol.reset { _ in (401, #"{"error": {"code": "invalid_token", "message": "", "details": {}}}"#) }
        let signedOut = await AttendanceWidgetActions.setState("room", account: account, file: file, makeApi: make)
        XCTAssertEqual(signedOut?.problem, .signedOut)

        WidgetStubProtocol.reset { _ in
            (200, #"{"enabled": true, "can_personalize": false, "states": [{"id": "room", "owner_id": null, "label": "在室", "color": "green", "kind": "in_room", "position": 0}], "entries": [{"user_id": "me", "state_id": "room", "since": "2026-10-13T19:00:00Z", "note": null, "source": "app"}]}"#)
        }
        let refreshed = await AttendanceWidgetActions.refresh(account: account, file: file, makeApi: make)
        XCTAssertNil(refreshed?.problem)
        XCTAssertEqual(refreshed?.states.map(\.id), ["room"])
        XCTAssertEqual(WidgetStubProtocol.requests.first?.httpMethod, "GET")
        XCTAssertEqual(WidgetStubProtocol.requests.first?.url?.path, "/api/v1/attendance")
    }

    // MARK: the link into the app

    func testLinkCarriesTheWorkspace() {
        let url = AttendanceWidgetLink.url(serverUrl: "https://lab.example.jp:8443/chat")
        XCTAssertEqual(url.scheme, "chikuwachat")
        XCTAssertEqual(AttendanceWidgetLink.parse(url), .some("https://lab.example.jp:8443/chat"))
        XCTAssertEqual(AttendanceWidgetLink.parse(AttendanceWidgetLink.url(serverUrl: nil)), .some(nil))
        XCTAssertNil(AttendanceWidgetLink.parse(URL(string: "chikuwachat://sso?ticket=x")!))
        XCTAssertNil(AttendanceWidgetLink.parse(URL(string: "https://attendance")!))
    }

    func testTappedWidgetOpensTheBoardOnceStarted() async {
        let controller = AppController(defaults: UserDefaults(suiteName: "AttendanceWidgetTests.\(UUID().uuidString)")!)
        XCTAssertTrue(controller.openWidgetLink(AttendanceWidgetLink.url(serverUrl: "https://lab.example.jp")))
        XCTAssertFalse(controller.openWidgetLink(URL(string: "https://example.com")!))
        await Task.yield()
        try? await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(controller.pendingWidgetLink, .attendance(server: "https://lab.example.jp"), "kept until startup ends")
    }

    func testThePileIsWhoIsInTheRoomMeFirstThenByArrival() {
        let entries = [entry("u2", "room", since: "2026-10-13T10:00:00Z"), entry("u3", "meeting", since: "2026-10-13T08:00:00Z"),
                       entry("u4", "gone"), entry("me", "room")]
        let s = snapshot(entries)
        let pile = AttendanceWidgetRules.inRoomPeople(s)
        XCTAssertEqual(pile.map(\.id), ["me", "u3", "u2"], "me, then who came first; not who went home")
        XCTAssertEqual(pile.map(\.person.name), ["加納 徹", "次郎", "花子"])
        XCTAssertEqual(pile.first?.person.initials, "加")
        XCTAssertEqual(pile.count, AttendanceWidgetRules.inRoomCount(s))
        XCTAssertNil(s.people?.first { $0.id == "g" }, "not the guest")
        // Someone the app has not named (the widget's own read): a grey 「?」.
        var unnamed = s
        unnamed.entries.append(AttendanceWidgetEntry(userId: "new", stateId: "room", since: "2026-10-13T11:00:00Z"))
        XCTAssertEqual(AttendanceWidgetRules.inRoomPeople(unnamed).last?.person.initials, "?")
        // A snapshot written before the people were kept still reads.
        var old = s
        old.people = nil
        let data = try! JSONEncoder().encode(old)
        XCTAssertEqual(try? JSONDecoder().decode(AttendanceWidgetSnapshot.self, from: data), old)
    }

    // MARK: faces

    func testFacesRender() throws {
        let small = WidgetFaceRenderer.small, medium = WidgetFaceRenderer.medium
        // The test's short ids hash to near colours; real ids (UUIDs) spread over the wheel as these do.
        func spread(_ s: AttendanceWidgetSnapshot) -> AttendanceWidgetSnapshot {
            var s = s
            s.people = s.people?.map { p in
                WidgetPerson(id: p.id, name: p.name, initials: p.initials, color: AppController.widgetPerson(user("\(p.id)-0192f3a1-\(p.name.count * 7)", p.name)).color)
            }
            return s
        }
        let inRoom = snapshot([entry("me", "room"), entry("u2", "room"), entry("u3", "meeting"), entry("u4", "gone"), entry("u5", "room"),
                               entry("u6", "room")])
        let site = snapshot([entry("me", "site"), entry("u2", "room")])
        let alone = snapshot([entry("me", "gone")])
        var failed = inRoom
        failed.problem = .offline
        var signedOut = site
        signedOut.problem = .signedOut
        var off = inRoom
        off.available = false
        let loading = AttendanceWidgetRules.seed(workspace, tables: inRoom)
        let header = Workspace(serverUrl: workspace.serverUrl, workspaceId: "lab-1", name: workspace.name, username: "kano")
        for look in WidgetFaceRenderer.Look.allCases {
            func face(_ s: AttendanceWidgetSnapshot?, _ family: WidgetFamily) -> AttendanceWidgetView {
                AttendanceWidgetView(entry: AttendanceTimelineEntry(date: Date(), snapshot: s.map(spread), workspace: s == nil ? nil : header), family: family)
            }
            if look != .lock {
                try WidgetFaceRenderer.render(face(inRoom, .systemSmall), size: small, look: look, name: "attendance-small-in-room")
                try WidgetFaceRenderer.render(face(site, .systemSmall), size: small, look: look, name: "attendance-small-on-site")
                try WidgetFaceRenderer.render(face(alone, .systemSmall), size: small, look: look, name: "attendance-small-gone-alone")
                try WidgetFaceRenderer.render(face(failed, .systemSmall), size: small, look: look, name: "attendance-small-offline")
                try WidgetFaceRenderer.render(face(nil, .systemSmall), size: small, look: look, name: "attendance-small-signed-out")
                try WidgetFaceRenderer.render(face(inRoom, .systemMedium), size: medium, look: look, name: "attendance-medium-in-room")
                try WidgetFaceRenderer.render(face(site, .systemMedium), size: medium, look: look, name: "attendance-medium-on-site")
                try WidgetFaceRenderer.render(face(signedOut, .systemMedium), size: medium, look: look, name: "attendance-medium-session-ended")
                try WidgetFaceRenderer.render(face(off, .systemMedium), size: medium, look: look, name: "attendance-medium-off")
                try WidgetFaceRenderer.render(face(loading, .systemMedium), size: medium, look: look, name: "attendance-medium-loading")
            } else {
                try WidgetFaceRenderer.render(face(inRoom, .accessoryRectangular), size: WidgetFaceRenderer.rectangular, look: look, name: "attendance-lock-rectangular")
                try WidgetFaceRenderer.render(face(inRoom, .accessoryCircular), size: WidgetFaceRenderer.circular, look: look, name: "attendance-lock-circular")
                try WidgetFaceRenderer.render(face(inRoom, .accessoryInline), size: WidgetFaceRenderer.inline, look: look, name: "attendance-lock-inline")
            }
        }
        // One size larger text than the default (the widgets cap it at xLarge).
        for (family, size, name) in [(WidgetFamily.systemSmall, small, "attendance-small-in-room"), (.systemMedium, medium, "attendance-medium-in-room")] {
            try WidgetFaceRenderer.render(AttendanceWidgetView(entry: AttendanceTimelineEntry(date: Date(), snapshot: inRoom, workspace: header), family: family),
                                          size: size, look: .light, name: name, textSize: .xLarge)
        }
    }
}

/// Draws a widget face to a PNG (SNAPSHOT_DIR=<dir>; TEST_RUNNER_SNAPSHOT_DIR when run by xcodebuild) at the widget's
/// size, with the system's 16 pt margins on the home screen (none on the lock screen), on a wallpaper-like ground:
/// light, dark, the tinted home screen (iOS 18: the face drawn in the accented mode, then washed into one tint as the
/// system does — an approximation: the system tints the accented parts apart) and the lock screen (vibrant, monochrome).
@MainActor
enum WidgetFaceRenderer {
    static let small = CGSize(width: 170, height: 170)
    static let medium = CGSize(width: 364, height: 170)
    static let large = CGSize(width: 364, height: 382)
    static let rectangular = CGSize(width: 172, height: 76)
    static let circular = CGSize(width: 76, height: 76)
    static let inline = CGSize(width: 260, height: 26)

    enum Look: String, CaseIterable {
        case light, dark, tinted, lock
    }

    static func render<V: View>(_ view: V, size: CGSize, look: Look, name: String, textSize: DynamicTypeSize = .large) throws {
        let accessory = size.height <= 76
        let dark = look != .light
        let shape = RoundedRectangle(cornerRadius: accessory ? 0 : 22, style: .continuous)
        let inner = view
            .padding(accessory ? 0 : 16)
            .frame(width: size.width, height: size.height)
            .environment(\.colorScheme, dark ? .dark : .light)
            .environment(\.dynamicTypeSize, textSize)
            .environment(\.widgetModeOverride, look == .tinted ? .accented : look == .lock ? .vibrant : nil)
        let washed = inner.grayscale(1).colorMultiply(Color(red: 0.86, green: 0.93, blue: 1))
        let framed = ZStack {
            switch look {
            case .light: inner.background(Color.white, in: shape)
            case .dark: inner.background(Color.black, in: shape)
            case .tinted: washed.background(Color(red: 0.16, green: 0.24, blue: 0.34).opacity(0.9), in: shape)
            case .lock: inner.grayscale(1)
            }
        }
        .padding(20)
        .background(look == .light ? Color(white: 0.82) : look == .dark ? Color(white: 0.12) : Color(red: 0.07, green: 0.11, blue: 0.19))
        let renderer = ImageRenderer(content: framed)
        renderer.scale = 3
        let image = try XCTUnwrap(renderer.uiImage)
        XCTAssertEqual(image.size.width, size.width + 40, accuracy: 1)
        let suffix = textSize == .large ? look.rawValue : "\(look.rawValue)-xl"
        let env = ProcessInfo.processInfo.environment
        if let dir = env["SNAPSHOT_DIR"] ?? env["TEST_RUNNER_SNAPSHOT_DIR"], let data = image.pngData() {
            let url = URL(fileURLWithPath: dir).appendingPathComponent("\(name)-\(suffix).png")
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: url)
        }
    }
}

/// Answers the widget's requests in the tests: (status, body), or nil for no answer (offline).
final class WidgetStubProtocol: URLProtocol {
    nonisolated(unsafe) static var answer: (URLRequest) -> (Int, String)? = { _ in nil }
    nonisolated(unsafe) static var requests: [URLRequest] = []
    nonisolated(unsafe) static var bodies: [Data] = []

    static func reset(_ answer: @escaping (URLRequest) -> (Int, String)?) {
        self.answer = answer
        requests = []
        bodies = []
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.requests.append(request)
        if let stream = request.httpBodyStream {
            stream.open()
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let read = stream.read(&buffer, maxLength: buffer.count)
                if read <= 0 { break }
                data.append(buffer, count: read)
            }
            stream.close()
            Self.bodies.append(data)
        } else if let body = request.httpBody {
            Self.bodies.append(body)
        }
        guard let (status, body) = Self.answer(request) else {
            client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
            return
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
                                       headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
