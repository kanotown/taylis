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
