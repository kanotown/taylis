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
        XCTAssertEqual(SessionList.lastUsed("2026-09-30T04:05:00Z", now: now, calendar: tokyo), "最後に使用: 今日 13:05")
        XCTAssertEqual(SessionList.lastUsed("2026-09-29T00:30:00Z", now: now, calendar: tokyo), "最後に使用: 昨日 9:30")
        XCTAssertEqual(SessionList.lastUsed("2026-09-28T05:05:00Z", now: now, calendar: tokyo), "最後に使用: 9月28日 14:05")
        XCTAssertEqual(SessionList.lastUsed("2025-12-01T00:00:00Z", now: now, calendar: tokyo), "最後に使用: 2025年12月1日 9:00")
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
