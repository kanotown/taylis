import SwiftUI
import XCTest
@testable import ChikuwaChat

/// MOBILE_UI.md §26 (iPhone Duo): which layout a window gets, and what the open conversation hands over to the other
/// layout's views when it changes (a fold, an unfold, an iPad resized across the split's width).
final class LayoutCarryTests: XCTestCase {
    func testTheSplitNeedsRoomForASidebarAndAConversation() {
        // The Duo's inner display: regular both ways; upright 669 pt wide (the phone's layout), on its side 951 (the split).
        XCTAssertEqual(MainLayout.of(.regular, width: 669), .tabs)
        XCTAssertEqual(MainLayout.of(.regular, width: 951), .split)
        // Its outer display and the iPhones: compact.
        XCTAssertEqual(MainLayout.of(.compact, width: 466), .tabs)
        XCTAssertEqual(MainLayout.of(.compact, width: 678), .tabs)
        // The iPad mini upright keeps the split; an unknown width follows the size class (as before).
        XCTAssertEqual(MainLayout.of(.regular, width: 744), .split)
        XCTAssertEqual(MainLayout.of(.regular, width: MainLayout.splitMinWidth), .split)
        XCTAssertEqual(MainLayout.of(.regular, width: MainLayout.splitMinWidth - 1), .tabs)
        XCTAssertEqual(MainLayout.of(.regular), .split)
        XCTAssertEqual(MainLayout.of(nil, width: 1000), .tabs)
    }

    func testTheFrontConversationAndItsThreadHandOver() {
        let carry = LayoutCarry()
        let now = Date(timeIntervalSince1970: 1_000)
        carry.update("general") { $0.keptRowId = "m-40"; $0.tab = .drive; $0.driveFolderId = "f-2" }
        carry.update("general", thread: "p-1") { $0.keptRowId = "r-3"; $0.composerFocused = true }
        carry.update("random") { $0.keptRowId = "m-9" }
        carry.layoutChanging(channelId: "general", parentId: "p-1", now: now)

        let conversation = carry.take("general", now: now.addingTimeInterval(0.3))
        XCTAssertEqual(conversation?.keptRowId, "m-40")
        XCTAssertEqual(conversation?.tab, .drive)
        XCTAssertEqual(conversation?.driveFolderId, "f-2")
        XCTAssertEqual(carry.take("general", thread: "p-1", now: now)?.composerFocused, true)
        // Another conversation (not on screen) hands nothing over.
        XCTAssertNil(carry.take("random", now: now))
        // Not used up: the new layout may build its view twice as it settles.
        XCTAssertEqual(carry.take("general", now: now.addingTimeInterval(1))?.keptRowId, "m-40")
        // Only shortly after the change.
        XCTAssertNil(carry.take("general", now: now.addingTimeInterval(LayoutCarry.window + 1)))
        // The next change hands over afresh.
        carry.layoutChanging(channelId: "random", parentId: nil, now: now.addingTimeInterval(10))
        XCTAssertNil(carry.take("general", now: now.addingTimeInterval(10)))
        XCTAssertEqual(carry.take("random", now: now.addingTimeInterval(10))?.keptRowId, "m-9")
    }

    func testTheKeyboardTakenByTheChangeItselfStillCounts() {
        let carry = LayoutCarry()
        let now = Date(timeIntervalSince1970: 2_000)
        // The size class changes first and takes the keyboard; the layout follows a moment later.
        carry.update("general") { $0.composerFocused = false; $0.composerBlurredAt = now.addingTimeInterval(-0.4) }
        carry.layoutChanging(channelId: "general", parentId: nil, now: now)
        XCTAssertEqual(carry.take("general", now: now)?.composerFocused, true)
        // Put away by hand well before: not given back.
        carry.update("general") { $0.composerFocused = false; $0.composerBlurredAt = now.addingTimeInterval(-30) }
        carry.layoutChanging(channelId: "general", parentId: nil, now: now)
        XCTAssertEqual(carry.take("general", now: now)?.composerFocused, false)
    }

    func testAViewOpenedAfreshForgetsAnEarlierOne() {
        let carry = LayoutCarry()
        carry.update("general") { $0.keptRowId = "m-40"; $0.showInfo = true }
        carry.reset("general")
        XCTAssertNil(carry.current("general"))
        carry.layoutChanging(channelId: "general", parentId: nil)
        XCTAssertNil(carry.take("general"))
    }

    func testFocusKeysOfAConversationAndAThread() {
        XCTAssertEqual(ConversationCarrier.focusKey("general", thread: nil), "general")
        XCTAssertEqual(ConversationCarrier.focusKey("general", thread: "p-1"), "general/p-1")
    }
}
