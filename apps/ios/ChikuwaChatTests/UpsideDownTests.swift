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

    /// The keyboard lets go of any kept row but the newest edge's marker (iOS 18: re-anchored on a row frame by frame, the
    /// list jumped and came to rest with the rows read gone under the keyboard).
    func testKeyboardLetsGoOfARowButNotTheNewestEdge() {
        XCTAssertTrue(UpsideDown.letsGoForKeyboard("row-1"))
        XCTAssertFalse(UpsideDown.letsGoForKeyboard(UpsideDown.newest))
        XCTAssertFalse(UpsideDown.letsGoForKeyboard(nil))
    }

    /// With no kept row, an arrival holds the list at the row wholly on screen nearest the input, with the anchor that
    /// leaves it where it is: its point at the anchor sits at the viewport's same point (in the flipped list's terms).
    func testHoldInPlaceTakesTheRowNearestTheInputWhereItIs() throws {
        let frames: [(id: String, frame: CGRect)] = [
            ("a", CGRect(x: 0, y: -40, width: 390, height: 100)),   // cut by the top: not wholly on screen
            ("b", CGRect(x: 0, y: 60, width: 390, height: 80)),
            ("c", CGRect(x: 0, y: 140, width: 390, height: 100)),   // the lowest wholly on screen
            ("d", CGRect(x: 0, y: 240, width: 390, height: 90)),    // cut by the input (viewport 281)
        ]
        let place = try XCTUnwrap(UpsideDown.keptInPlace(frames, viewportHeight: 281))
        XCTAssertEqual(place.id, "c")
        // On screen the anchor s puts the row's point minY + s·h at s·H; the flipped list's anchor is 1 - s.
        let s = 1 - place.anchor.y
        XCTAssertEqual(140 + s * 100, s * 281, accuracy: 0.001)
        XCTAssertGreaterThanOrEqual(s, 0)
        XCTAssertLessThanOrEqual(s, 1)
    }

    func testHoldInPlaceNeedsARowWhollyOnScreen() {
        XCTAssertNil(UpsideDown.keptInPlace([("tall", CGRect(x: 0, y: -100, width: 390, height: 500))], viewportHeight: 281))
        XCTAssertNil(UpsideDown.keptInPlace([], viewportHeight: 281))
        // A row at the very bottom edge: anchor at the bottom (flipped: top), exactly.
        let edge = UpsideDown.keptInPlace([("e", CGRect(x: 0, y: 181, width: 390, height: 100))], viewportHeight: 281)
        XCTAssertEqual(edge?.anchor.y ?? -1, 0, accuracy: 0.0001)
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
