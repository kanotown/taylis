import XCTest
@testable import ChikuwaChat

final class LinksTests: XCTestCase {
    func testFirstLinkOutsideCodeWithTrailingPunctuationTrimmed() {
        XCTAssertEqual(Links.first(in: "see https://example.com/a?b=1, then https://other.test"), "https://example.com/a?b=1")
        XCTAssertEqual(Links.first(in: "日本語の文 https://example.com/x。"), "https://example.com/x")
        XCTAssertEqual(Links.first(in: "(https://example.com/paren)"), "https://example.com/paren")
        XCTAssertNil(Links.first(in: "`https://code.example.com` and ```\nhttps://fenced.example.com\n``` none"))
        XCTAssertNil(Links.first(in: "no links here"))
        XCTAssertEqual(Links.first(in: "[label](https://example.com/md)"), "https://example.com/md")
    }
}
