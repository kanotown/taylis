import SwiftUI
import XCTest
@testable import ChikuwaChat

/// The quick status menu (docs/PRESENCE.md §11): the shared rules (apps/shared/presence-rules.json), the store's look
/// and its end by the clock, PUT /users/me/presence, a change from another of my devices, the settings' pause showing
/// 「解除するまで」, and the dot itself (red disc, white bar).
@MainActor
final class PresenceMenuTests: XCTestCase {
    // MARK: the shared rules

    private struct Rules: Decodable {
        struct Choice: Decodable {
            let name: String
            let dndUntil: String?
            let presenceHidden: Bool
            let presenceManual: String?
            let choice: String
        }
        struct Look: Decodable {
            let name: String
            let connection: String
            let dndUntil: String?
            let look: String
        }
        struct Indefinite: Decodable {
            let dndUntil: String?
            let indefinite: Bool
        }
        struct EndLabel: Decodable {
            struct Case: Decodable {
                let dndUntil: String
                let label: String?
                let untilCleared: Bool?
            }
            let tz: String
            let cases: [Case]
        }
        struct Soonest: Decodable {
            let name: String
            let dndUntil: [String?]
            let end: String?
        }
        struct Request: Decodable {
            let status: String
            let duration: String?
            let tz: String?
            let body: [String: JSONValue]
        }
        let now: String
        let myChoice: [Choice]
        let look: [Look]
        let indefinite: [Indefinite]
        let endLabel: EndLabel
        let soonestEnd: [Soonest]
        let request: [Request]
        let durations: [String]
    }

    private func rules() throws -> Rules {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("shared/presence-rules.json")
        return try JSON.snakeDecoder.decode(Rules.self, from: Data(contentsOf: url))
    }

    func testMyChoiceFollowsTheSharedRules() throws {
        let rules = try rules()
        let now = try XCTUnwrap(parseIsoDate(rules.now))
        for row in rules.myChoice {
            let choice = PresenceRules.myChoice(dndUntil: row.dndUntil, presenceHidden: row.presenceHidden, presenceManual: row.presenceManual, now: now)
            XCTAssertEqual(choice.rawValue, row.choice, row.name)
        }
    }

    func testTheLookFollowsTheSharedRules() throws {
        let rules = try rules()
        let now = try XCTUnwrap(parseIsoDate(rules.now))
        for row in rules.look {
            XCTAssertEqual(PresenceRules.look(connection: row.connection, dndUntil: row.dndUntil, now: now), row.look, row.name)
        }
    }

    func testIndefiniteSoonestEndAndLabelsFollowTheSharedRules() throws {
        let rules = try rules()
        let now = try XCTUnwrap(parseIsoDate(rules.now))
        for row in rules.indefinite {
            XCTAssertEqual(PresenceRules.isIndefinite(row.dndUntil), row.indefinite, row.dndUntil ?? "null")
        }
        for row in rules.soonestEnd {
            XCTAssertEqual(PresenceRules.soonestEnd(row.dndUntil, now: now), row.end.flatMap(parseIsoDate), row.name)
        }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(identifier: rules.endLabel.tz))
        for row in rules.endLabel.cases {
            let label = PresenceRules.endLabel(row.dndUntil, now: now, calendar: calendar)
            if row.untilCleared == true {
                XCTAssertEqual(label, tr("解除するまで"), row.dndUntil)
            } else {
                XCTAssertEqual(label, row.label, row.dndUntil)
            }
        }
        XCTAssertEqual(DndDuration.allCases.map(\.rawValue), rules.durations)
    }

    func testTheRequestBodyFollowsTheSharedRules() throws {
        for row in try rules().request {
            let choice = try XCTUnwrap(PresenceChoice(rawValue: row.status))
            let body = PresenceRules.requestBody(choice, duration: row.duration.flatMap(DndDuration.init(rawValue:)), tz: row.tz ?? "UTC")
            XCTAssertEqual(body, row.body, row.status)
        }
    }

    func testTheHeaderLine() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(identifier: "Asia/Tokyo"))
        let now = try XCTUnwrap(parseIsoDate("2026-10-09T01:00:00Z"))
        XCTAssertEqual(PresenceRules.myLine(me(dndUntil: "2026-10-09T06:30:00Z"), now: now, calendar: calendar), "取り込み中（〜15:30）")
        XCTAssertEqual(PresenceRules.myLine(me(dndUntil: "9999-12-31T00:00:00Z"), now: now, calendar: calendar), "取り込み中（解除するまで）")
        XCTAssertEqual(PresenceRules.myLine(me(hidden: true), now: now, calendar: calendar), "オフライン表示")
        XCTAssertEqual(PresenceRules.myLine(me(manual: "away"), now: now, calendar: calendar), "離席中")
        XCTAssertEqual(PresenceRules.myLine(me(), now: now, calendar: calendar), "オンライン（自動）")
    }

    /// §11.5: someone's look in words, the pause with its end (the profile card, and a 1:1 DM's header, which said
    /// 「取り込み中」 alone); the settings' pause test is the same one.
    func testTheLookLabelAndTheDmHeaderSayWhenThePauseEnds() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(identifier: "Asia/Tokyo"))
        let now = try XCTUnwrap(parseIsoDate("2026-10-09T01:00:00Z"))
        XCTAssertEqual(PresenceRules.lookLabel("dnd", dndUntil: "2026-10-09T06:30:00Z", now: now, calendar: calendar), "取り込み中（〜15:30）")
        XCTAssertEqual(PresenceRules.lookLabel("dnd", dndUntil: "9999-12-31T00:00:00Z", now: now, calendar: calendar), "取り込み中（解除するまで）")
        XCTAssertEqual(PresenceRules.lookLabel("dnd", dndUntil: nil, now: now, calendar: calendar), "取り込み中") // an older device's look, no end known
        XCTAssertEqual(PresenceRules.lookLabel("online", dndUntil: nil, now: now, calendar: calendar), "オンライン")
        XCTAssertEqual(PresenceRules.lookLabel("away", dndUntil: "2026-10-09T00:30:00Z", now: now, calendar: calendar), "離席中") // the pause is over
        XCTAssertEqual(PresenceRules.dmSubtitle(look: "dnd", dndUntil: "2026-10-09T06:30:00Z", status: (emoji: "🍤", text: "昼休み"), now: now, calendar: calendar),
                       "取り込み中（〜15:30） · 🍤 昼休み")
        XCTAssertEqual(PresenceRules.dmSubtitle(look: "offline", dndUntil: nil, status: nil, now: now, calendar: calendar), "オフライン")
        XCTAssertTrue(DND.paused("2026-10-09T06:30:00Z", now: now))
        XCTAssertFalse(DND.paused("2026-10-09T00:30:00Z", now: now))
        XCTAssertFalse(DND.paused(nil, now: now))
    }

    // MARK: the store

    private func me(dndUntil: String? = nil, hidden: Bool = false, manual: String? = nil, updatedAt: String = "2026-10-01T00:00:00Z") -> UserMe {
        var me = UserMe(id: "me", username: "me", displayName: "わたし", role: "member", deactivatedAt: nil, createdAt: "2026-10-01T00:00:00Z",
                        updatedAt: updatedAt, email: nil, mustChangePassword: false)
        me.dndUntil = dndUntil
        me.presenceHidden = hidden
        me.presenceManual = manual
        return me
    }

    private func user(_ id: String, dndUntil: String?, updatedAt: String = "2026-10-01T00:00:00Z") -> UserPublic {
        UserPublic(id: id, username: id, displayName: id, role: "member", deactivatedAt: nil, createdAt: "2026-10-01T00:00:00Z",
                   updatedAt: updatedAt, dndUntil: dndUntil)
    }

    private func iso(_ date: Date) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.string(from: date)
    }

    func testTheStoreShowsDndOverTheConnectionAndSortsByTheConnection() {
        let store = Store()
        store.setPresence("alice", status: "away")
        XCTAssertEqual(store.presenceOf("alice"), "away")
        store.upsertUser(user("alice", dndUntil: iso(Date().addingTimeInterval(1800))))
        XCTAssertEqual(store.presenceOf("alice"), "dnd")
        XCTAssertEqual(store.connectionOf("alice"), "away")
        // Disconnected and paused: still the red dot.
        store.setPresence("alice", status: "offline")
        XCTAssertEqual(store.presenceOf("alice"), "dnd")
        // The indefinite pause.
        store.upsertUser(user("alice", dndUntil: "9999-12-31T00:00:00Z"))
        XCTAssertEqual(store.presenceOf("alice"), "dnd")
        XCTAssertEqual(presenceLabel(store.presenceOf("alice")), "取り込み中")
    }

    func testThePauseEndsByTheClockWithOneTimer() async throws {
        let store = Store()
        store.setPresence("alice", status: "online")
        store.upsertUser(user("alice", dndUntil: iso(Date().addingTimeInterval(0.4))))
        store.upsertUser(user("carol", dndUntil: "9999-12-31T00:00:00Z"))  // arms nothing
        XCTAssertEqual(store.presenceOf("alice"), "dnd")
        let before = store.dndClock
        // Observation: the dot redraws when the pause ends, without any event.
        let redrawn = expectation(description: "redraw")
        withObservationTracking { _ = store.presenceOf("alice") } onChange: { redrawn.fulfill() }
        await fulfillment(of: [redrawn], timeout: 3)
        try await Task.sleep(for: .milliseconds(20))
        XCTAssertGreaterThan(store.dndClock, before)
        XCTAssertEqual(store.presenceOf("alice"), "online")
        XCTAssertEqual(store.presenceOf("carol"), "dnd")
    }

    func testCurrentMeTakesTheNewerPublicCopy() {
        let store = Store()
        store.setMe(me(manual: "away", updatedAt: "2026-10-09T00:00:00Z"))
        // user.updated from another of my devices (newer) before GET /users/me answers: its dnd_until counts.
        let until = iso(Date().addingTimeInterval(3600))
        store.upsertUser(user("me", dndUntil: until, updatedAt: "2026-10-09T00:05:00Z"))
        XCTAssertEqual(store.currentMe?.dndUntil, until)
        XCTAssertEqual(store.currentMe?.presenceManual, "away", "my own fields stay")
        XCTAssertEqual(PresenceRules.myChoice(store.currentMe), .dnd)
        XCTAssertEqual(store.presenceOf("me"), "dnd")
        // An older copy does not win.
        store.upsertUser(user("me", dndUntil: nil, updatedAt: "2026-10-08T00:00:00Z"))
        XCTAssertNil(store.currentMe?.dndUntil)
        XCTAssertEqual(PresenceRules.myChoice(store.currentMe), .away)
    }

    func testUserMeReadsPresenceManual() throws {
        let json = #"{"id": "u1", "username": "kano", "display_name": "加納", "role": "member", "deactivated_at": null, "created_at": "", "updated_at": "", "email": null, "must_change_password": false, "presence_hidden": false, "presence_manual": "away", "dnd_until": "9999-12-31T00:00:00Z"}"#
        let me = try JSON.snakeDecoder.decode(UserMe.self, from: Data(json.utf8))
        XCTAssertEqual(me.presenceManual, "away")
        XCTAssertEqual(PresenceRules.myChoice(me), .dnd)
        XCTAssertTrue(PresenceRules.isIndefinite(me.dndUntil))
        // Kept in the cache as it came.
        XCTAssertEqual(try JSON.plainDecoder.decode(UserMe.self, from: JSON.plainEncoder.encode(me)), me)
    }

    // MARK: the settings' pause mirrors it

    func testThePauseRowSaysUntilCleared() throws {
        XCTAssertEqual(DND.pauseSummary("9999-12-31T00:00:00Z"), "解除するまで")
        XCTAssertEqual(DND.pauseSummary(nil), "オフ")
    }

    // MARK: PUT /users/me/presence

    private func controller(answer: @escaping (URLRequest) -> (Int, Data)) -> AppController {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        let client = ApiClient(baseUrl: URL(string: "http://server")!, session: URLSession(configuration: configuration))
        client.accessToken = "access"
        StubProtocol.handler = answer
        let controller = AppController()
        controller.api = client
        controller.store.setMe(me())
        controller.store.upsertUser(me().asPublic)
        return controller
    }

    private static func body(_ request: URLRequest) -> [String: JSONValue] {
        var data = request.httpBody ?? Data()
        if data.isEmpty, let stream = request.httpBodyStream {
            stream.open()
            defer { stream.close() }
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable {
                let read = stream.read(&buffer, maxLength: buffer.count)
                if read <= 0 { break }
                data.append(buffer, count: read)
            }
        }
        if case .object(let object)? = try? JSON.plainDecoder.decode(JSONValue.self, from: data) { return object }
        return [:]
    }

    func testChoosingSendsTheChoiceAndTakesTheAnswer() async throws {
        var sent: [(String, String, [String: JSONValue])] = []
        let controller = controller { request in
            sent.append((request.httpMethod ?? "", request.url?.path ?? "", Self.body(request)))
            let json = #"{"id": "me", "username": "me", "display_name": "わたし", "role": "member", "deactivated_at": null, "created_at": "2026-10-01T00:00:00Z", "updated_at": "2026-10-09T00:00:00Z", "email": null, "must_change_password": false, "presence_hidden": false, "presence_manual": null, "dnd_until": "9999-12-31T00:00:00Z"}"#
            return (200, Data(json.utf8))
        }
        let ok = await controller.setMyPresence(.dnd, duration: .forever)
        XCTAssertTrue(ok)
        XCTAssertEqual(sent.first?.0, "PUT")
        XCTAssertEqual(sent.first?.1, "/api/v1/users/me/presence")
        XCTAssertEqual(sent.first?.2, ["status": .string("dnd"), "duration": .string("forever"), "tz": .string(TimeZone.current.identifier)])
        XCTAssertEqual(PresenceRules.myChoice(controller.store.currentMe), .dnd)
        XCTAssertEqual(controller.store.presenceOf("me"), "dnd")
        XCTAssertEqual(PresenceRules.myLine(controller.store.currentMe), "取り込み中（解除するまで）")
        // The in-app notices hold back while it runs (the M12c check reads the same dnd_until).
        XCTAssertTrue(DND.isActive(controller.currentMe?.asPublic))
    }

    func testAnOlderServerShowsTheReasonAndChangesNothing() async {
        let controller = controller { _ in (404, Data(#"{"error": {"code": "not_found", "message": "Not Found", "details": {}}}"#.utf8)) }
        let ok = await controller.setMyPresence(.away)
        XCTAssertFalse(ok)
        XCTAssertNotNil(controller.error)
        XCTAssertEqual(PresenceRules.myChoice(controller.store.currentMe), .auto)
        // The sheet takes the reason for its own line (the toast is behind the sheet) and leaves the toast nothing.
        let reason = controller.takeError()
        XCTAssertNotNil(reason)
        XCTAssertNil(controller.error)
        XCTAssertNil(controller.takeError())
    }

    /// 「解除」 ends the pause alone (the settings' 「通知を再開」: PATCH /users/me {dnd_until: null}, §11.1); `status: auto`
    /// would also clear 離席中 and 「在席を隠す」 chosen in the settings.
    func testClearingEndsThePauseAlone() async throws {
        var sent: [(String, String, [String: JSONValue])] = []
        let controller = controller { request in
            sent.append((request.httpMethod ?? "", request.url?.path ?? "", Self.body(request)))
            let json = #"{"id": "me", "username": "me", "display_name": "わたし", "role": "member", "deactivated_at": null, "created_at": "2026-10-01T00:00:00Z", "updated_at": "2026-10-09T00:00:00Z", "email": null, "must_change_password": false, "presence_hidden": false, "presence_manual": "away", "dnd_until": null}"#
            return (200, Data(json.utf8))
        }
        controller.store.setMe(me(dndUntil: "9999-12-31T00:00:00Z", manual: "away"))
        XCTAssertEqual(PresenceRules.myChoice(controller.store.currentMe), .dnd)
        let ok = await controller.endMyPause()
        XCTAssertTrue(ok)
        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(sent.first?.0, "PATCH")
        XCTAssertEqual(sent.first?.1, "/api/v1/users/me")
        XCTAssertEqual(sent.first?.2, ["dnd_until": .null], "only the pause")
        XCTAssertEqual(PresenceRules.myChoice(controller.store.currentMe), .away, "離席中 from the settings stays")
    }

    // MARK: user.updated from another of my devices

    func testAChangeOnAnotherDeviceShowsAtOnceThenReadsMeAgain() async throws {
        let server = FakeServer()
        let alice = server.addUser("alice")
        let bob = server.addUser("bob")
        let channel = server.createChannel("general", ownerId: alice.id)
        server.join(channel.id, bob.id)
        let store = Store()
        var options = EngineOptions()
        options.reconnectMin = 0
        options.sleep = { _ in }
        let engine = SyncEngine(api: server.api(for: bob.id), connect: server.connector(for: bob.id), wsUrl: URL(string: "ws://fake")!,
                                store: store, getAccessToken: { "token" }, options: options)
        engine.isActive = { false }
        await engine.start()
        func settle() async {
            for _ in 0..<50 {
                await engine.idle()
                await Task.yield()
            }
        }
        await settle()
        let held = try XCTUnwrap(store.me)
        XCTAssertEqual(PresenceRules.myChoice(store.currentMe), .auto)

        // Another of my devices chose 取り込み中 for 1 hour and 離席中 was cleared: the event carries UserPublic only.
        let later = iso(Date().addingTimeInterval(60))
        let until = iso(Date().addingTimeInterval(3600))
        var fresh = UserMe(id: held.id, username: held.username, displayName: held.displayName, role: held.role, deactivatedAt: nil,
                       createdAt: held.createdAt, updatedAt: later, email: nil, mustChangePassword: false)
        fresh.dndUntil = until
        fresh.presenceManual = nil
        server.meAnswers[bob.id] = fresh
        let shared = UserPublic(id: bob.id, username: bob.username, displayName: bob.displayName, role: bob.role, deactivatedAt: nil,
                            createdAt: bob.createdAt, updatedAt: later, dndUntil: until)
        let data = try JSON.plainDecoder.decode(JSONValue.self, from: JSON.snakeEncoder.encode(["user": shared]))
        server.emitEvent([bob.id], "user.updated", channelId: nil, data: data)
        await settle()
        XCTAssertEqual(store.presenceOf(bob.id), "dnd")
        XCTAssertEqual(PresenceRules.myChoice(store.currentMe), .dnd)
        // GET /users/me came back with my own fields.
        XCTAssertEqual(store.me?.updatedAt, later)
        XCTAssertEqual(store.me?.dndUntil, until)
        engine.stop()
    }

    // MARK: the dot

    /// 取り込み中 is a red disc with a white bar across its middle (the same shape as Desktop / Web).
    func testTheDndDotIsARedDiscWithAWhiteBar() throws {
        XCTAssertEqual(PresenceDot.Style(look: "dnd"), .dnd)
        XCTAssertEqual(PresenceDot.Style(look: "online"), .online)
        XCTAssertEqual(PresenceDot.Style(look: "away"), .away)
        XCTAssertNil(PresenceDot.Style(look: "offline"), "offline draws nothing")
        XCTAssertNil(PresenceDot.Style(look: nil))
        XCTAssertEqual(PresenceDot.Style(look: "offline", showOffline: true), .offline, "my own picture: the grey ring")

        let renderer = ImageRenderer(content: PresenceDot(style: .dnd, side: 40).environment(\.colorScheme, .light))
        renderer.scale = 1
        let image = try XCTUnwrap(renderer.cgImage)
        let centre = try pixel(image, x: 20, y: 20)
        XCTAssertGreaterThan(centre.r, 0.9); XCTAssertGreaterThan(centre.g, 0.9); XCTAssertGreaterThan(centre.b, 0.9)  // the bar
        let above = try pixel(image, x: 20, y: 9)
        XCTAssertGreaterThan(above.r, 0.8); XCTAssertLessThan(above.g, 0.4); XCTAssertLessThan(above.b, 0.4)  // red
        let corner = try pixel(image, x: 1, y: 1)
        XCTAssertLessThan(corner.a, 0.1, "a disc")
    }

    private func pixel(_ image: CGImage, x: Int, y: Int) throws -> (r: Double, g: Double, b: Double, a: Double) {
        var bytes = [UInt8](repeating: 0, count: 4)
        let context = try XCTUnwrap(CGContext(data: &bytes, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
                                              space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.draw(image, in: CGRect(x: -x, y: -(image.height - 1 - y), width: image.width, height: image.height))
        let a = Double(bytes[3]) / 255
        guard a > 0 else { return (0, 0, 0, 0) }
        return (Double(bytes[0]) / 255 / a, Double(bytes[1]) / 255 / a, Double(bytes[2]) / 255 / a, a)
    }
}
