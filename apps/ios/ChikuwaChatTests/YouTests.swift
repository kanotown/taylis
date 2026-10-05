import SwiftUI
import XCTest
@testable import ChikuwaChat

/// M40: the 自分 tab's rules — pause choices → dnd_until, the rows' summaries, the signed-in devices.
final class YouTests: XCTestCase {
    private var tokyo: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Tokyo")!
        return calendar
    }

    private func at(_ iso: String) -> Date { ISO8601DateFormatter().date(from: iso)! }
    private func iso(_ date: Date) -> String { ISO8601DateFormatter().string(from: date) }

    func testPauseChoicesBecomeDndUntil() {
        let now = at("2026-09-30T05:10:00Z")
        XCTAssertEqual(DND.dndUntil(.preset(.halfHour), now: now), "2026-09-30T05:40:00Z")
        XCTAssertEqual(DND.dndUntil(.preset(.hour), now: now), "2026-09-30T06:10:00Z")
        XCTAssertEqual(DND.dndUntil(.preset(.twoHours), now: now), "2026-09-30T07:10:00Z")
        XCTAssertEqual(DND.dndUntil(.custom(at("2026-10-02T00:00:00Z")), now: now), "2026-10-02T00:00:00Z")
        XCTAssertNil(DND.dndUntil(.resume, now: now), "再開 sends null")
        // 明日 8:00 is tomorrow's 8:00 on this device's clock.
        let tomorrow = parseIsoDate(DND.dndUntil(.preset(.tomorrow), now: now)!)!
        let calendar = Calendar.current
        XCTAssertEqual(calendar.component(.hour, from: tomorrow), 8)
        XCTAssertEqual(calendar.component(.minute, from: tomorrow), 0)
        XCTAssertTrue(calendar.isDate(tomorrow, inSameDayAs: calendar.date(byAdding: .day, value: 1, to: now)!))
        XCTAssertEqual(DND.Pause.allCases.map(\.label), ["30 分", "1 時間", "2 時間", "明日 8:00"])
    }

    func testPauseSummary() {
        let now = at("2026-09-30T05:10:00Z") // 14:10 in Tokyo
        XCTAssertEqual(DND.pauseSummary(nil, now: now, calendar: tokyo), "オフ")
        XCTAssertEqual(DND.pauseSummary("2026-09-30T05:00:00Z", now: now, calendar: tokyo), "オフ", "a past pause is off")
        XCTAssertEqual(DND.pauseSummary("2026-09-30T06:30:00Z", now: now, calendar: tokyo), "15:30 まで")
        XCTAssertEqual(DND.pauseSummary("2026-09-30T23:00:00Z", now: now, calendar: tokyo), "明日 8:00 まで")
        XCTAssertEqual(DND.pauseSummary("2026-10-02T00:05:00Z", now: now, calendar: tokyo), "10月2日 9:05 まで")
        XCTAssertEqual(DND.pauseSummary("2027-01-05T00:00:00Z", now: now, calendar: tokyo), "2027年1月5日 9:00 まで")
        XCTAssertTrue(DND.paused("2026-09-30T06:30:00Z", now: now))
        XCTAssertFalse(DND.paused("2026-09-30T05:10:00Z", now: now))
        XCTAssertFalse(DND.paused("not a date", now: now))
    }

    func testQuietHoursSummary() {
        XCTAssertEqual(DND.quietSummary(nil), "オフ")
        XCTAssertEqual(DND.quietSummary(QuietHours(start: "22:00", end: "07:00", days: [], tz: "Asia/Tokyo")), "22:00〜07:00")
        XCTAssertEqual(DND.quietSummary(QuietHours(start: "22:00", end: "07:00", days: Array(0..<7), tz: "Asia/Tokyo")), "22:00〜07:00")
        XCTAssertEqual(DND.quietSummary(QuietHours(start: "23:30", end: "06:00", days: [4, 0, 2], tz: "Asia/Tokyo")), "23:30〜06:00 (月水金)")
    }

    private func session(_ id: String, current: Bool = false, used: String, name: String? = nil, platform: String = "ios") -> SessionOut {
        SessionOut(id: id,
                   device: DeviceOut(id: "d-\(id)", platform: platform, deviceName: name, appVersion: nil, enabled: true,
                                     disabledReason: nil, lastSeenAt: nil, createdAt: used, updatedAt: used),
                   current: current, lastIp: nil, createdAt: used, lastUsedAt: used, expiresAt: used)
    }

    func testSessionsThisDeviceFirstThenMostRecentlyUsed() {
        let list = [
            session("a", used: "2026-09-28T10:00:00Z"),
            session("b", used: "2026-09-30T09:00:00.123456Z"),
            session("me", current: true, used: "2026-09-01T00:00:00Z"),
            session("d", used: "2026-09-30T09:00:00.123456Z"),
            session("c", used: "2026-09-29T10:00:00+09:00"),
        ]
        XCTAssertEqual(SessionList.ordered(list).map(\.id), ["me", "b", "d", "c", "a"])
        XCTAssertEqual(SessionList.ordered([]).map(\.id), [])
    }

    func testSessionNamesAndLastUsed() {
        XCTAssertEqual(SessionList.name(session("x", used: "2026-09-30T00:00:00Z", name: "  研究室の Mac ")), "研究室の Mac")
        XCTAssertEqual(SessionList.name(session("x", used: "2026-09-30T00:00:00Z", name: "", platform: "web")), "ブラウザ")
        XCTAssertEqual(SessionList.name(session("x", used: "2026-09-30T00:00:00Z", platform: "android")), "Android")
        XCTAssertEqual(SessionList.name(session("x", used: "2026-09-30T00:00:00Z", platform: "desktop")), "デスクトップ")

        let now = at("2026-09-30T05:10:00Z") // 14:10 in Tokyo
        XCTAssertEqual(SessionList.lastUsed("2026-09-30T04:05:00Z", now: now, calendar: tokyo), "最後に使用：今日 13:05")
        XCTAssertEqual(SessionList.lastUsed("2026-09-29T00:30:00Z", now: now, calendar: tokyo), "最後に使用：昨日 9:30")
        XCTAssertEqual(SessionList.lastUsed("2026-09-28T05:05:00Z", now: now, calendar: tokyo), "最後に使用：9月28日 14:05")
        XCTAssertEqual(SessionList.lastUsed("2025-12-01T00:00:00Z", now: now, calendar: tokyo), "最後に使用：2025年12月1日 9:00")
        XCTAssertEqual(SessionList.lastUsed("", now: now, calendar: tokyo), "")
    }

    func testSessionDecodesFromTheServer() throws {
        let json = """
        {"id":"8a1d","current":true,"last_ip":"127.0.0.1","created_at":"2026-09-30T02:00:00Z",
         "last_used_at":"2026-09-30T03:00:00.5Z","expires_at":"2026-10-30T02:00:00Z",
         "device":{"id":"d1","platform":"ios","device_name":"iPhone 17","app_version":"0.1.0","enabled":true,
                   "disabled_reason":null,"push_provider":"apns","push_environment":"development","push_registered":true,
                   "last_seen_at":null,"created_at":"2026-09-30T02:00:00Z","updated_at":"2026-09-30T02:00:00Z"}}
        """
        let session = try JSON.snakeDecoder.decode(SessionOut.self, from: Data(json.utf8))
        XCTAssertTrue(session.current)
        XCTAssertEqual(session.device.deviceName, "iPhone 17")
        XCTAssertEqual(session.lastUsedAt, "2026-09-30T03:00:00.5Z")
    }

    func testThemes() {
        XCTAssertEqual(AppTheme.allCases.map(\.label), ["端末に合わせる", "ライト", "ダーク"])
        XCTAssertNil(AppTheme.system.colorScheme)
        XCTAssertEqual(AppTheme.light.colorScheme, .light)
        XCTAssertEqual(AppTheme.dark.colorScheme, .dark)
        XCTAssertEqual(AppTheme(rawValue: "dark"), .dark)
    }
}

/// M50: the long-press quick reactions I choose (`UserMe.quick_reactions`), the row they make and saving the choice.
@MainActor
final class QuickReactionsTests: XCTestCase {
    private func me(_ extra: String = "") -> String {
        #"{"id": "u1", "username": "kano", "display_name": "加納", "role": "member", "deactivated_at": null, "created_at": "", "updated_at": "", "email": null, "must_change_password": false"#
            + extra + "}"
    }

    private func decode(_ json: String) throws -> UserMe { try JSON.snakeDecoder.decode(UserMe.self, from: Data(json.utf8)) }

    func testDecodesAbsentNullAndAListApart() throws {
        // A server before M50 leaves the key out: the setting is hidden.
        let older = try decode(me())
        XCTAssertEqual(older.quickReactions, .unsupported)
        XCTAssertFalse(older.quickReactions.isSupported)
        XCTAssertNil(older.quickReactions.chosen)
        // null: known but not chosen (the recent-first rule).
        let unset = try decode(me(#", "quick_reactions": null"#))
        XCTAssertEqual(unset.quickReactions, .unset)
        XCTAssertTrue(unset.quickReactions.isSupported)
        XCTAssertNil(unset.quickReactions.chosen)
        let chosen = try decode(me(#", "quick_reactions": ["🙏", "👍", "🍤"]"#))
        XCTAssertEqual(chosen.quickReactions.chosen, ["🙏", "👍", "🍤"])
        // In a bootstrap as well.
        let bootstrap = try JSON.snakeDecoder.decode(BootstrapOut.self, from: Data("""
        {"server_time": "2026-10-01T00:00:00Z", "me": \(me(#", "quick_reactions": ["🎉"]"#)), "users": [], "channels": [],
         "limits": {"max_message_length": 20000, "max_attachment_bytes": 1, "max_attachments_per_message": 10}}
        """.utf8))
        XCTAssertEqual(bootstrap.me.quickReactions, .chosen(["🎉"]))
    }

    func testTheCachedMeKeepsTheThreeStates() throws {
        // The store keeps `me` with the plain coder (Store.setMe); each state comes back as it was.
        for user in [try decode(me()), try decode(me(#", "quick_reactions": null"#)), try decode(me(#", "quick_reactions": ["👀", "✅"]"#))] {
            let data = try JSON.plainEncoder.encode(user)
            XCTAssertEqual(try JSON.plainDecoder.decode(UserMe.self, from: data), user)
        }
        let text = String(data: try JSON.plainEncoder.encode(try decode(me())), encoding: .utf8) ?? ""
        XCTAssertFalse(text.contains("quickReactions"), "unsupported is left out, not null")
    }

    func testAChoiceWinsElseRecentFirst() {
        // Chosen: exactly those, in that order (fewer than six too), whatever was used lately.
        XCTAssertEqual(QuickReactions.row(chosen: ["🍤", "🙏", "👍"], recent: "😂 🎉"), ["🍤", "🙏", "👍"])
        XCTAssertEqual(QuickReactions.row(chosen: ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣"], recent: ""), ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣"])
        // Not chosen: the recents (standard emoji only) first, then the palette, six without repeats.
        XCTAssertEqual(QuickReactions.row(chosen: nil, recent: ""), reactionPalette)
        XCTAssertEqual(QuickReactions.row(chosen: nil, recent: "🍤 :party: 👀 🙏"), ["🍤", "👀", "🙏", "👍", "❤️", "😂"])
        XCTAssertEqual(QuickReactions.row(chosen: [], recent: "🍤"), ["🍤", "👍", "❤️", "😂", "🎉", "👀"], "an empty list is no choice")
    }

    func testReplacingASlot() {
        let row = ["👍", "❤️", "😂", "🎉", "👀", "✅"]
        XCTAssertEqual(QuickReactions.replacing(row, slot: 2, with: "🍤"), ["👍", "❤️", "🍤", "🎉", "👀", "✅"])
        // Already in another slot: the two trade places.
        XCTAssertEqual(QuickReactions.replacing(row, slot: 0, with: "✅"), ["✅", "❤️", "😂", "🎉", "👀", "👍"])
        XCTAssertEqual(QuickReactions.replacing(row, slot: 3, with: "🎉"), row)
        // An empty slot past the end adds it (once).
        XCTAssertEqual(QuickReactions.replacing(["👍"], slot: 4, with: "🍤"), ["👍", "🍤"])
        XCTAssertEqual(QuickReactions.replacing(["👍", "🍤"], slot: 5, with: "👍"), ["👍", "🍤"])
        XCTAssertEqual(QuickReactions.replacing(row, slot: 6, with: "🍤"), row)
    }

    private func controller(answer: @escaping (URLRequest) -> (Int, Data)) throws -> AppController {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        let client = ApiClient(baseUrl: URL(string: "http://server")!, session: URLSession(configuration: configuration))
        client.accessToken = "access"
        StubProtocol.handler = answer
        let controller = AppController()
        controller.api = client
        controller.store.setMe(try decode(me(#", "quick_reactions": null"#)))
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

    func testSavingPatchesTheListAndResetSendsNull() async throws {
        var sent: [[String: JSONValue]] = []
        let controller = try controller { [self] request in
            XCTAssertEqual(request.httpMethod, "PATCH")
            XCTAssertEqual(request.url?.path, "/api/v1/users/me")
            let body = Self.body(request)
            sent.append(body)
            var value = "null"
            if case .array(let list)? = body["quick_reactions"] {
                value = "[" + list.compactMap { item -> String? in if case .string(let s) = item { return "\"\(s)\"" } else { return nil } }
                    .joined(separator: ",") + "]"
            }
            return (200, Data(me(#", "quick_reactions": "# + value).utf8))
        }
        let saved = await controller.setQuickReactions(["🍤", "🙏"])
        XCTAssertTrue(saved)
        XCTAssertEqual(sent.last, ["quick_reactions": .array([.string("🍤"), .string("🙏")])], "only the one field")
        XCTAssertEqual(controller.store.me?.quickReactions, .chosen(["🍤", "🙏"]))
        let reset = await controller.setQuickReactions(nil)
        XCTAssertTrue(reset)
        XCTAssertEqual(sent.last, ["quick_reactions": .null])
        XCTAssertEqual(controller.store.me?.quickReactions, .unset)
    }

    func testARefusedChoiceIsTakenBack() async throws {
        let controller = try controller { _ in
            (422, Data(#"{"error": {"code": "validation_error", "message": "invalid", "details": {}}}"#.utf8))
        }
        let saved = await controller.setQuickReactions(["🍤"])
        XCTAssertFalse(saved)
        XCTAssertEqual(controller.store.me?.quickReactions, .unset, "back to what the server has")
        XCTAssertNotNil(controller.error, "the reason is shown")
    }
}
