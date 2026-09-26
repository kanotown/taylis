import XCTest
@testable import ChikuwaChat

final class BodyTokenizerTests: XCTestCase {
    func testInlineSubsetMentionsLinksAndNewlines() {
        let body = "hi *bold* and _it_ `code` <@00000000-0000-7000-8000-000000000001> <!channel>\nhttps://example.com/x?y=1 done"
        XCTAssertEqual(BodyTokenizer.tokenize(body), [
            .text("hi "), .bold("bold"), .text(" and "), .italic("it"), .text(" "), .code("code"), .text(" "),
            .mention("00000000-0000-7000-8000-000000000001"), .text(" "), .mentionAll("channel"), .newline,
            .link("https://example.com/x?y=1"), .text(" done"),
        ])
    }

    func testCodeBlocksAndUnmatchedMarkers() {
        XCTAssertEqual(BodyTokenizer.tokenize("```\nlet *x* = 1\n```"), [.codeBlock("let *x* = 1")])
        XCTAssertEqual(BodyTokenizer.tokenize("<script>alert(1)</script>"), [.text("<script>alert(1)</script>")])
    }

    func testIsoDatesWithMicroseconds() {
        XCTAssertNotNil(parseIsoDate("2026-09-25T13:00:00.123456Z"))
        XCTAssertNotNil(parseIsoDate("2026-09-25T13:00:00Z"))
        XCTAssertNotNil(parseIsoDate("2026-09-25T13:00:00.5+00:00"))
    }
}
