import XCTest
@testable import ChikuwaChat

final class ScheduleTests: XCTestCase {
    private var calendar: Calendar {
        var c = Calendar(identifier: .gregorian)
        c.timeZone = TimeZone(identifier: "Asia/Tokyo")!
        return c
    }
    private func local(_ y: Int, _ m: Int, _ d: Int, _ h: Int, _ min: Int = 0) -> Date {
        calendar.date(from: DateComponents(year: y, month: m, day: d, hour: h, minute: min))!
    }

    func testPresetsAreInTheFutureAndNextMondayIsNeverToday() {
        let friday = local(2026, 10, 2, 19, 30)
        let presets = Schedule.presets(now: friday, calendar: calendar)
        XCTAssertEqual(presets.map(\.key), ["1h", "tomorrow9", "monday9"]) // 18:00 already passed
        XCTAssertEqual(presets[0].at, local(2026, 10, 2, 20, 30))
        XCTAssertEqual(presets[2].at, local(2026, 10, 5, 9))
        let monday = local(2026, 10, 5, 8)
        let mondayPresets = Schedule.presets(now: monday, calendar: calendar)
        XCTAssertEqual(mondayPresets.map(\.key), ["1h", "today18", "tomorrow9", "monday9"])
        XCTAssertEqual(mondayPresets[3].at, local(2026, 10, 12, 9))
    }

    func testLabelsAreRelativeToToday() {
        let now = local(2026, 10, 2, 10)
        XCTAssertEqual(Schedule.label(local(2026, 10, 2, 18), now: now, calendar: calendar), "今日 18:00")
        XCTAssertEqual(Schedule.label(local(2026, 10, 3, 9, 5), now: now, calendar: calendar), "明日 9:05")
        XCTAssertEqual(Schedule.label(local(2026, 10, 5, 9), now: now, calendar: calendar), "10月5日(月) 9:00")
        XCTAssertEqual(Schedule.label(local(2027, 1, 4, 9), now: now, calendar: calendar), "2027年1月4日(月) 9:00")
    }
}
