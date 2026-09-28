import XCTest
@testable import ChikuwaChat

/// Dates from the server, parsed once per string (M20).
final class IsoDatesTests: XCTestCase {
    func testTheServersFormats() {
        let reference = Date(timeIntervalSince1970: 1_790_587_200) // 2026-09-28T09:20:00Z
        XCTAssertEqual(parseIsoDate("2026-09-28T09:20:00.000000Z")!.timeIntervalSince1970, reference.timeIntervalSince1970, accuracy: 0.001)
        XCTAssertEqual(parseIsoDate("2026-09-28T09:20:00.123456Z")!.timeIntervalSince1970, reference.timeIntervalSince1970 + 0.123456, accuracy: 0.001)
        XCTAssertEqual(parseIsoDate("2026-09-28T09:20:00.123Z")!.timeIntervalSince1970, reference.timeIntervalSince1970 + 0.123, accuracy: 0.001)
        XCTAssertEqual(parseIsoDate("2026-09-28T09:20:00Z")!.timeIntervalSince1970, reference.timeIntervalSince1970, accuracy: 0.001)
        XCTAssertEqual(parseIsoDate("2026-09-28T18:20:00+09:00")!.timeIntervalSince1970, reference.timeIntervalSince1970, accuracy: 0.001)
        XCTAssertNil(parseIsoDate("送信中"))
        // The second time comes from the cache, with the same answer.
        XCTAssertEqual(parseIsoDate("2026-09-28T09:20:00.123456Z"), parseIsoDate("2026-09-28T09:20:00.123456Z"))
    }
}
