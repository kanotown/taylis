import XCTest
@testable import ChikuwaChat

final class ShareTests: XCTestCase {
    private let link = "https://chat.example.com/m/01a0df3f-14b2-7d1a-8759-53c8a8d8a198"

    func testQuotesTheOriginalUnderTheCommentAndEndsWithThePermalink() {
        XCTAssertEqual(Share.body(original: "first line\nsecond", permalink: link, comment: "見てください"), "見てください\n> first line\n> second\n\(link)")
        XCTAssertEqual(Share.body(original: "plain", permalink: link, comment: ""), "> plain\n\(link)")
    }

    func testClipsLongBodiesAndStandsInForAttachmentOnlyMessages() {
        let long = String(repeating: "あ", count: 400)
        XCTAssertEqual(Share.body(original: long, permalink: link, comment: ""), "> " + String(repeating: "あ", count: 300) + "…\n\(link)")
        XCTAssertEqual(Share.body(original: "   ", permalink: link, comment: "資料です"), "資料です\n> （添付ファイル）\n\(link)")
    }
}
