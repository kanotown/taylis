import XCTest
@testable import ChikuwaChat

/// 「下書き」 (M11h): the store lists only conversations with unsent text or attachments.
@MainActor
final class DraftsTests: XCTestCase {
    func testListDraftsSkipsEmptyOnes() {
        let store = Store()
        store.setDraft("c1") { $0.text = "hello" }
        store.setDraft("c1", parentId: "m1") { $0.text = "a reply" }
        store.setDraft("c2") { $0.text = "   " }
        XCTAssertEqual(store.listDrafts().map { "\($0.channelId):\($0.parentId ?? "-"):\($0.draft.text)" }, ["c1:-:hello", "c1:m1:a reply"])
        store.setDraft("c1") { $0.text = "" }
        XCTAssertEqual(store.listDrafts().map(\.parentId), ["m1"])
    }
}
