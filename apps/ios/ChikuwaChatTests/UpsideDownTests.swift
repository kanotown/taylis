import XCTest
@testable import ChikuwaChat

/// What a conversation (a channel, a thread) does when a new newest row comes in (UpsideDown.arrival, MOBILE_UI.md).
final class UpsideDownTests: XCTestCase {
    func testAtTheNewestEdgeEveryNewRowIsFollowed() {
        // Within nearNewest of the origin the kept row was the newest row, and a row arriving went in under it (build 105):
        // the edge's marker is made the kept row instead, for my rows and everyone else's.
        XCTAssertEqual(UpsideDown.arrival(atNewest: true, mine: false), .follow)
        XCTAssertEqual(UpsideDown.arrival(atNewest: true, mine: true), .follow)
    }

    func testMyPostFromFurtherUpJumps() {
        XCTAssertEqual(UpsideDown.arrival(atNewest: false, mine: true), .jump)
    }

    func testSomeoneElsesRowLeavesTheReaderWhereTheyAre() {
        XCTAssertEqual(UpsideDown.arrival(atNewest: false, mine: false), .stay)
    }

    /// The thread's jump button counts like the channel's: replies from others after the newest one seen at the edge.
    func testThreadJumpButtonCountsRepliesFromOthersBelow() {
        func reply(_ seq: Int, _ sender: String) -> MessageState {
            var message = MessageState(placeholderFor: "cmid-\(seq)", channelId: "c", senderId: sender, body: "r\(seq)",
                                       createdAt: "2026-10-07T01:00:00Z", parentId: "p")
            message.id = "id-\(seq)"
            message.seq = seq
            message.pending = false
            return message
        }
        var replies = [reply(10, "alice"), reply(11, "me")]
        let seen = ReadGate.seenAtBottom(nil, rows: replies, placed: true)
        XCTAssertEqual(seen, 11)
        // Reading older replies: one from alice and one of mine (from another device) arrive below.
        replies += [reply(12, "alice"), reply(13, "me")]
        XCTAssertEqual(ReadGate.newBelow(replies, seenSeq: seen, meId: "me"), 1)
        // Back at the edge: seen.
        XCTAssertEqual(ReadGate.newBelow(replies, seenSeq: ReadGate.seenAtBottom(seen, rows: replies, placed: true), meId: "me"), 0)
    }
}
