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

    /// 2026-10-09: 削除 from the list — text and attachments go, and the engine is told (it deletes it on the server).
    func testDiscardDraftEmptiesItAndTellsTheEngine() {
        let store = Store()
        var told: [String] = []
        store.onDraftEdited = { channelId, parentId in told.append("\(channelId):\(parentId ?? "-")") }
        store.setDraft("c1", parentId: "m1") { $0.text = "a reply" }
        store.setDraft("c2") { $0.attachments = [AttachmentOut(id: "a1", filename: "x.png", contentType: "image/png", sizeBytes: 1, width: nil, height: nil,
                                                                hasThumbnail: false, status: "pending", createdAt: "")] }
        told = []
        store.discardDraft("c1", parentId: "m1")
        store.discardDraft("c2")
        XCTAssertEqual(store.listDrafts().count, 0)
        XCTAssertEqual(store.draft("c1", parentId: "m1").text, "")
        XCTAssertTrue(store.draft("c1", parentId: "m1").isDirty)  // the delete is still to be saved
        XCTAssertEqual(told, ["c1:m1"])  // an attachment-only draft has nothing on the server
    }
}
