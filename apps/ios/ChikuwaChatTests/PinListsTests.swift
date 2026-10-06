import XCTest
@testable import ChikuwaChat

/// The 「ピン留め」 tab follows the message rows the app takes (PinLists): a pinned message deleted or unpinned, here or
/// by someone else, leaves it at once; one pinned elsewhere comes in (2026-10-06).
final class PinListsTests: XCTestCase {
    private func message(_ id: String, channel: String = "c1", updatedSeq: Int = 1, pinnedAt: String? = "2026-10-06T10:00:00Z",
                         deleted: Bool = false, body: String = "b") -> MessageOut {
        var out = MessageOut(id: id, channelId: channel, senderId: "u2", seq: 1, updatedSeq: updatedSeq, clientMsgId: nil, body: body,
                             createdAt: "2026-10-06T09:00:00Z", editedAt: nil, deleted: deleted)
        out.pinnedAt = pinnedAt
        out.pinnedBy = pinnedAt == nil ? nil : "u2"
        return out
    }

    private func ids(_ lists: PinLists, _ channel: String = "c1") -> [String]? { lists.pins(channel)?.map(\.id) }

    private func loaded() -> PinLists {
        var lists = PinLists()
        lists.loading("c1")
        lists.loaded("c1", [message("b", updatedSeq: 5, pinnedAt: "2026-10-06T11:00:00Z"), message("a", updatedSeq: 3)])
        return lists
    }

    func testADeletedPinLeavesAtOnce() {
        var lists = loaded()
        // The server's message.updated for a deletion: deleted, its pin cleared.
        XCTAssertTrue(lists.take(message("b", updatedSeq: 9, pinnedAt: nil, deleted: true, body: "")))
        XCTAssertEqual(ids(lists), ["a"])
    }

    func testAnUnpinnedMessageLeaves() {
        var lists = loaded()
        XCTAssertTrue(lists.take(message("a", updatedSeq: 7, pinnedAt: nil)))
        XCTAssertEqual(ids(lists), ["b"])
    }

    func testAnEditKeepsThePinInItsPlace() {
        var lists = loaded()
        XCTAssertTrue(lists.take(message("a", updatedSeq: 8, body: "edited")))
        XCTAssertEqual(ids(lists), ["b", "a"])
        XCTAssertEqual(lists.pins("c1")?.last?.body, "edited")
    }

    func testAPinMadeElsewhereComesInMostRecentFirst() {
        var lists = loaded()
        XCTAssertTrue(lists.take(message("c", updatedSeq: 10, pinnedAt: "2026-10-06T12:00:00Z")))
        XCTAssertTrue(lists.take(message("d", updatedSeq: 11, pinnedAt: "2026-10-06T10:30:00Z")))
        XCTAssertEqual(ids(lists), ["c", "b", "d", "a"])
    }

    func testOlderVersionsUnpinnedRowsAndOtherChannelsChangeNothing() {
        var lists = loaded()
        // My own deletion shown before the server answers (the same version) and older events stay out: the pin goes
        // with the server's answer, and stays if it refuses.
        XCTAssertFalse(lists.take(message("b", updatedSeq: 5, pinnedAt: nil, deleted: true)))
        XCTAssertFalse(lists.take(message("a", updatedSeq: 2, pinnedAt: nil)))
        // Rows of a page going by: not pinned, or of a channel whose pins were never shown.
        XCTAssertFalse(lists.take(message("x", updatedSeq: 20, pinnedAt: nil)))
        XCTAssertFalse(lists.take(message("y", channel: "c2", updatedSeq: 20)))
        XCTAssertEqual(ids(lists), ["b", "a"])
        XCTAssertNil(lists.pins("c2"))
    }

    func testAChangeDuringTheFetchIsAppliedOverItsAnswer() {
        var lists = PinLists()
        lists.loading("c1")
        XCTAssertTrue(lists.take(message("a", updatedSeq: 9, pinnedAt: nil, deleted: true)))
        lists.loaded("c1", [message("a", updatedSeq: 3)]) // the answer was read before the deletion
        XCTAssertEqual(ids(lists), [])
    }
}
