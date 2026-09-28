import SwiftUI
import XCTest
@testable import ChikuwaChat

/// The conversation lists and the keyboard (KeyboardBehavior.swift). Numbers from an iPhone 17 Pro: 116 pt of the list
/// under the navigation bar, 667 pt visible without the keyboard, 365 pt with it.
final class KeyboardBehaviorTests: XCTestCase {
    private let insets = EdgeInsets(top: 116, leading: 0, bottom: 0, trailing: 0)

    func testDistanceToEndCountsTheOffsetFromUnderTheNavigationBar() {
        // At the end, the list's 8 pt of padding below the last row.
        XCTAssertEqual(KeyboardBehavior.distanceToEnd(contentHeight: 4496, insets: insets, offset: 3705, containerHeight: 666.67),
                       8.33, accuracy: 0.01)
        XCTAssertLessThanOrEqual(KeyboardBehavior.distanceToEnd(contentHeight: 4496, insets: insets, offset: 3705, containerHeight: 666.67),
                                 KeyboardBehavior.nearEnd)
        // 300 pt higher up: not at the end.
        XCTAssertGreaterThan(KeyboardBehavior.distanceToEnd(contentHeight: 4496, insets: insets, offset: 3405, containerHeight: 666.67),
                             KeyboardBehavior.nearEnd)
    }

    func testWellPastTheEndIsALayoutInPassing() {
        XCTAssertFalse(KeyboardBehavior.inPassing(8.33)) // at the end
        XCTAssertFalse(KeyboardBehavior.inPassing(-3)) // pulled a little past it
        XCTAssertFalse(KeyboardBehavior.inPassing(300)) // higher up
        // LazyVStack re-estimating its rows reported the content 815 pt shorter for one update (iOS 26, 2026-09-29).
        XCTAssertTrue(KeyboardBehavior.inPassing(KeyboardBehavior.distanceToEnd(contentHeight: 3400, insets: insets, offset: 3431, containerHeight: 666.67)))
    }

    /// iOS 18 reports the keyboard's room frame by frame; each step moves the offset by the height the list lost.
    func testTheOffsetFollowsTheHeightToKeepTheBottomEdge() {
        let insets = EdgeInsets(top: 100.33, leading: 0, bottom: 0, trailing: 0) // iPhone 16 Pro, iOS 18.6
        // At the end, one frame of the keyboard coming up: still at the end.
        let step = KeyboardBehavior.offsetKeepingBottom(oldOffset: 3423.67, oldHeight: 682.33, newHeight: 675, contentHeight: 4215, insets: insets)
        XCTAssertEqual(step, 3431, accuracy: 0.01)
        XCTAssertEqual(KeyboardBehavior.distanceToEnd(contentHeight: 4215, insets: insets, offset: step, containerHeight: 675),
                       KeyboardBehavior.distanceToEnd(contentHeight: 4215, insets: insets, offset: 3423.67, containerHeight: 682.33), accuracy: 0.01)
        // Higher up, the keyboard coming and going: the bottom edge stays on the same content.
        XCTAssertEqual(KeyboardBehavior.offsetKeepingBottom(oldOffset: 3073.67, oldHeight: 682.33, newHeight: 664.07, contentHeight: 4302, insets: insets),
                       3091.93, accuracy: 0.01)
        XCTAssertEqual(KeyboardBehavior.offsetKeepingBottom(oldOffset: 2430, oldHeight: 380.33, newHeight: 391.8, contentHeight: 4215, insets: insets),
                       2418.53, accuracy: 0.01)
        // Never past the end, nor above the top: a short conversation stays where it sits.
        XCTAssertEqual(KeyboardBehavior.offsetKeepingBottom(oldOffset: 3423.67, oldHeight: 682.33, newHeight: 380.33, contentHeight: 4000, insets: insets),
                       4000 - 100.33 - 380.33, accuracy: 0.01)
        XCTAssertEqual(KeyboardBehavior.offsetKeepingBottom(oldOffset: -100.33, oldHeight: 682.33, newHeight: 380.33, contentHeight: 300, insets: insets),
                       -100.33, accuracy: 0.01)
    }

    func testTheRowAtTheBottomEdgeIsTheLastOneShownInFull() {
        let frames: [String: CGRect] = [
            "above": CGRect(x: 0, y: -40, width: 300, height: 90),   // cut at the top
            "a": CGRect(x: 0, y: 50, width: 300, height: 200),
            "b": CGRect(x: 0, y: 250, width: 300, height: 400),      // ends 17 pt above the bottom edge
            "c": CGRect(x: 0, y: 650, width: 300, height: 120),      // cut by the bottom edge
        ]
        XCTAssertEqual(KeyboardBehavior.rowAtBottomEdge(frames, height: 666.67), "b")
        XCTAssertEqual(KeyboardBehavior.rowAtBottomEdge(frames, height: 800), "c")
        XCTAssertNil(KeyboardBehavior.rowAtBottomEdge(["tall": CGRect(x: 0, y: -10, width: 300, height: 900)], height: 666.67))
    }
}
