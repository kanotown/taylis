import XCTest
@testable import ChikuwaChat

final class PermalinkTests: XCTestCase {
    private let id = "01a0df3f-14b2-7d1a-8759-53c8a8d8a198"

    func testBuildsWithoutDoublingSlashes() {
        XCTAssertEqual(Permalink.url(base: URL(string: "https://chat.example.com/")!, messageId: id), "https://chat.example.com/m/\(id)")
        XCTAssertEqual(Permalink.url(base: URL(string: "http://127.0.0.1:8000")!, messageId: id), "http://127.0.0.1:8000/m/\(id)")
    }

    func testRecognisesOnlyOurServerAndWellFormedIds() {
        let base = URL(string: "https://chat.example.com")!
        XCTAssertEqual(Permalink.messageId(base: base, url: "https://chat.example.com/m/\(id)"), id)
        XCTAssertEqual(Permalink.messageId(base: URL(string: "https://chat.example.com/")!, url: "HTTPS://CHAT.EXAMPLE.COM/m/\(id.uppercased())?x=1#y"), id)
        XCTAssertEqual(Permalink.messageId(base: base, url: "https://chat.example.com/m/\(id)/extra"), id)
        XCTAssertNil(Permalink.messageId(base: base, url: "https://chat.example.com/m/not-an-id"))
        XCTAssertNil(Permalink.messageId(base: base, url: "https://other.example.com/m/\(id)"))
        XCTAssertNil(Permalink.messageId(base: base, url: "https://chat.example.com/files/\(id)"))
        XCTAssertNil(Permalink.messageId(base: nil, url: "https://chat.example.com/m/\(id)"))
    }
}
