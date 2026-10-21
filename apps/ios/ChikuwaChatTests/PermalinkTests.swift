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

    func testEventLinksOfThisServer() {
        let base = URL(string: "https://chat.example.com")!
        XCTAssertEqual(EventLink.eventId(base: base, url: "https://chat.example.com/e/\(id)"), id)
        XCTAssertEqual(EventLink.eventId(base: URL(string: "https://chat.example.com/")!, url: "HTTPS://CHAT.EXAMPLE.COM/e/\(id.uppercased())?x=1#y"), id)
        XCTAssertEqual(EventLink.eventId(base: base, url: "https://chat.example.com/e/\(id)/extra"), id)
        XCTAssertNil(EventLink.eventId(base: base, url: "https://chat.example.com/e/not-an-id"))
        XCTAssertNil(EventLink.eventId(base: base, url: "https://other.example.com/e/\(id)"))
        XCTAssertNil(EventLink.eventId(base: base, url: "https://chat.example.com/m/\(id)"))
        XCTAssertNil(Permalink.messageId(base: base, url: "https://chat.example.com/e/\(id)"))
        XCTAssertNil(EventLink.eventId(base: nil, url: "https://chat.example.com/e/\(id)"))
        XCTAssertEqual(EventLink.internalLink(eventId: id)?.host, id)
    }

    /// User report 2026-10-21: a link to another message of the open thread scrolls the thread there.
    func testALinkInsideTheOpenThreadStaysInIt() {
        let thread = MessageLinkContext.thread(channelId: "c1", parentId: "p1")
        // an older or newer reply of the same thread
        XCTAssertEqual(PermalinkJump.of(channelId: "c1", messageId: "r9", parentId: "p1", from: thread), .thread(parentId: "p1"))
        // its parent (at the thread's top)
        XCTAssertEqual(PermalinkJump.of(channelId: "c1", messageId: "p1", parentId: nil, from: thread), .thread(parentId: "p1"))
        // a reply of another thread, a top-level message, another conversation: opened as before
        XCTAssertEqual(PermalinkJump.of(channelId: "c1", messageId: "r2", parentId: "p2", from: thread), .open)
        XCTAssertEqual(PermalinkJump.of(channelId: "c1", messageId: "m1", parentId: nil, from: thread), .open)
        XCTAssertEqual(PermalinkJump.of(channelId: "c2", messageId: "r9", parentId: "p1", from: thread), .open)
    }

    func testALinkInsideTheTimelineStaysInIt() {
        let timeline = MessageLinkContext.timeline(channelId: "c1")
        XCTAssertEqual(PermalinkJump.of(channelId: "c1", messageId: "m1", parentId: nil, from: timeline), .timeline)
        // a reply opens its thread; another conversation opens
        XCTAssertEqual(PermalinkJump.of(channelId: "c1", messageId: "r1", parentId: "p1", from: timeline), .open)
        XCTAssertEqual(PermalinkJump.of(channelId: "c2", messageId: "m1", parentId: nil, from: timeline), .open)
        // tapped elsewhere (a canvas, the search): opened
        XCTAssertEqual(PermalinkJump.of(channelId: "c1", messageId: "m1", parentId: nil, from: nil), .open)
    }
}
