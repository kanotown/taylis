import XCTest
@testable import ChikuwaChat

final class DNDTests: XCTestCase {
    private func at(_ iso: String) -> Date { ISO8601DateFormatter().date(from: iso)! }

    func testQuietHoursUseTheUsersZoneWithAnExclusiveEnd() {
        let lunch = QuietHours(start: "12:00", end: "13:00", days: [], tz: "Asia/Tokyo")
        XCTAssertTrue(DND.inQuietHours(lunch, now: at("2026-09-28T12:30:00+09:00")))
        XCTAssertFalse(DND.inQuietHours(lunch, now: at("2026-09-28T13:00:00+09:00")))
        XCTAssertFalse(DND.inQuietHours(lunch, now: at("2026-09-28T12:30:00Z"))) // 21:30 in Tokyo
        XCTAssertFalse(DND.inQuietHours(QuietHours(start: "12:00", end: "13:00", days: [], tz: "Mars/Olympus"), now: at("2026-09-28T12:30:00+09:00")))
    }

    func testOvernightWindowBelongsToTheDayItStartsOn() {
        let fridayNight = QuietHours(start: "22:00", end: "07:00", days: [4], tz: "Asia/Tokyo")
        XCTAssertTrue(DND.inQuietHours(fridayNight, now: at("2026-10-02T23:00:00+09:00")))
        XCTAssertTrue(DND.inQuietHours(fridayNight, now: at("2026-10-03T06:30:00+09:00")))
        XCTAssertFalse(DND.inQuietHours(fridayNight, now: at("2026-10-03T23:00:00+09:00")))
        XCTAssertTrue(DND.inQuietHours(QuietHours(start: "22:00", end: "07:00", days: [], tz: "Asia/Tokyo"), now: at("2026-09-28T02:00:00+09:00")))
    }

    func testManualPauseAndLabels() {
        var user = UserPublic(id: "u", username: "u", displayName: "U", role: "member", deactivatedAt: nil, createdAt: "", updatedAt: "")
        XCTAssertFalse(DND.isActive(user, now: at("2026-09-28T03:00:00Z")))
        user.dndUntil = "2026-09-28T03:30:00Z"
        XCTAssertTrue(DND.isActive(user, now: at("2026-09-28T03:00:00Z")))
        XCTAssertFalse(DND.isActive(user, now: at("2026-09-28T03:31:00Z")))
        XCTAssertEqual(DND.label(QuietHours(start: "22:00", end: "07:00", days: [0, 1, 2, 3, 4], tz: "Asia/Tokyo")), "22:00〜07:00 (月火水木金)")
        XCTAssertEqual(DND.label(QuietHours(start: "22:00", end: "07:00", days: [], tz: "Asia/Tokyo")), "22:00〜07:00")
        let tomorrow = DND.Pause.tomorrow.until(from: at("2026-09-28T06:00:00Z"))
        XCTAssertEqual(Calendar.current.component(.hour, from: tomorrow), 8)
    }
}
