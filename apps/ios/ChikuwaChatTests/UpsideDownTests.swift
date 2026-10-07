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

    /// A thread's new reply is animated in only at the newest edge, once placed: animated while older replies were read,
    /// the insertion moved the row being read by the new reply's height (84 pt; 0 pt unanimated).
    func testThreadArrivalIsAnimatedOnlyAtTheNewestEdge() {
        XCTAssertNotNil(UpsideDown.arrivalAnimation(atNewest: true, placed: true))
        XCTAssertNil(UpsideDown.arrivalAnimation(atNewest: false, placed: true))
        XCTAssertNil(UpsideDown.arrivalAnimation(atNewest: true, placed: false))
    }

    /// iOS 17, a thread's marker laid out once: at the newest row while the marker is within nearNewest under the bottom.
    func testMarkerSaysNewestWithinNearNewestOfTheBottom() {
        XCTAssertTrue(UpsideDown.markerNear(markerMinY: 591, viewportHeight: 600)) // at the origin (8 pt padding)
        XCTAssertTrue(UpsideDown.markerNear(markerMinY: 600 + UpsideDown.nearNewest, viewportHeight: 600))
        XCTAssertFalse(UpsideDown.markerNear(markerMinY: 600 + UpsideDown.nearNewest + 1, viewportHeight: 600))
        XCTAssertFalse(UpsideDown.markerNear(markerMinY: 2_000, viewportHeight: 600)) // reading far up
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
