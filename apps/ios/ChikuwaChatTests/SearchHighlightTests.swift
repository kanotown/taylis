import XCTest
@testable import ChikuwaChat

final class SearchHighlightTests: XCTestCase {
    func testFindsEveryOccurrenceCaseInsensitivelyAndMergesOverlaps() {
        XCTAssertEqual(SearchHighlighter.ranges(in: "Tokyo rain, tokyo sun", keywords: ["tokyo"]), [0..<5, 12..<17])
        XCTAssertEqual(SearchHighlighter.ranges(in: "東京の天気", keywords: ["東京", "の天", "天気"]), [0..<5])
        XCTAssertEqual(SearchHighlighter.ranges(in: "nothing", keywords: ["", "zzz"]), [])
    }
}
