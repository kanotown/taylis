import XCTest
@testable import ChikuwaChat

/// Issue #1 (MOBILE_UI.md §5.1): the horizontal swipe between a conversation and the list (SwipeNav).
final class SwipeNavTests: XCTestCase {
    func testWithinTheSlopNothingIsDecided() {
        XCTAssertEqual(SwipeNav.decide(dx: 6, dy: 3, canBack: true, canForward: true), .undecided)
    }

    func testAClearlyHorizontalDragGoesBackRightAndForwardLeft() {
        XCTAssertEqual(SwipeNav.decide(dx: 20, dy: 5, canBack: true, canForward: true), .back)
        XCTAssertEqual(SwipeNav.decide(dx: -20, dy: -5, canBack: true, canForward: true), .forward)
    }

    func testAVerticalOrSteepDragIsTheListsScroll() {
        XCTAssertEqual(SwipeNav.decide(dx: 2, dy: 12, canBack: true, canForward: true), .reject)
        XCTAssertEqual(SwipeNav.decide(dx: 15, dy: 15, canBack: true, canForward: true), .reject)
        XCTAssertEqual(SwipeNav.decide(dx: 12, dy: 9, canBack: true, canForward: true), .undecided)
        // 30° is still horizontal.
        XCTAssertEqual(SwipeNav.decide(dx: -20, dy: 11.5, canBack: false, canForward: true), .forward)
        XCTAssertEqual(SwipeNav.decide(dx: -20, dy: 12, canBack: false, canForward: true), .reject)
    }

    func testADirectionWithNowhereToGoIsNotTaken() {
        XCTAssertEqual(SwipeNav.decide(dx: -20, dy: 0, canBack: true, canForward: false), .reject)
        XCTAssertEqual(SwipeNav.decide(dx: 20, dy: 0, canBack: false, canForward: true), .reject)
    }

    func testReleaseCompletesPast40PercentOrWithAFling() {
        XCTAssertFalse(SwipeNav.shouldComplete(progress: 0.39, velocity: 0))
        XCTAssertTrue(SwipeNav.shouldComplete(progress: 0.4, velocity: 0))
        XCTAssertTrue(SwipeNav.shouldComplete(progress: 0.1, velocity: 900))
        XCTAssertFalse(SwipeNav.shouldComplete(progress: 0.9, velocity: -900))
    }

    func testTheIncomingPageFollowsTheFinger() {
        XCTAssertEqual(SwipeNav.incomingShift(dx: -100, width: 400), 0.75, accuracy: 0.001)
        XCTAssertEqual(SwipeNav.incomingShift(dx: 30, width: 400), 1, accuracy: 0.001)
        XCTAssertEqual(SwipeNav.incomingShift(dx: -500, width: 400), 0, accuracy: 0.001)
        XCTAssertEqual(SwipeNav.scrimOpacity(shift: 1), 0, accuracy: 0.001)
    }

    func testForwardFromATabsRootIsTheConversationItLeftLast() {
        let last: [MainTab: String] = [.home: "a", .dms: "d"]
        XCTAssertEqual(SwipeNav.forwardTarget(tab: .home, path: [], last: last) { _ in true }, "a")
        XCTAssertEqual(SwipeNav.forwardTarget(tab: .dms, path: [], last: last) { _ in true }, "d")
    }

    func testNoForwardWithoutAConversationOneGoneOffTheRootOrOnYou() {
        XCTAssertNil(SwipeNav.forwardTarget(tab: .activity, path: [], last: [.home: "a"]) { _ in true })
        XCTAssertNil(SwipeNav.forwardTarget(tab: .home, path: [], last: [.home: "a"]) { _ in false })
        XCTAssertNil(SwipeNav.forwardTarget(tab: .home, path: [.list("threads")], last: [.home: "a"]) { _ in true })
        XCTAssertNil(SwipeNav.forwardTarget(tab: .you, path: [], last: [.you: "a"]) { _ in true })
    }

    func testLeavingAConversationRemembersItForItsTab() {
        let left = SwipeNav.noteLeft([:], previous: [.home: [.channel("a")]], next: [.home: []])
        XCTAssertEqual(left, [.home: "a"])
        // Back to a list it was opened from counts too; the other tabs keep theirs.
        let fromList = SwipeNav.noteLeft([.dms: "d"], previous: [.home: [.list("threads"), .channel("b")]], next: [.home: [.list("threads")]])
        XCTAssertEqual(fromList, [.home: "b", .dms: "d"])
    }

    func testReplacingOrKeepingTheConversationRemembersNothing() {
        XCTAssertEqual(SwipeNav.noteLeft([:], previous: [.home: [.channel("a")]], next: [.home: [.channel("b")]]), [:])
        // A tab switch leaves the stacks as they are.
        XCTAssertEqual(SwipeNav.noteLeft([:], previous: [.home: [.channel("a")]], next: [.home: [.channel("a")], .dms: []]), [:])
    }
}
