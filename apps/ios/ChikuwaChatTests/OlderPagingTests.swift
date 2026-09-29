import SwiftUI
import UIKit
import XCTest
@testable import ChikuwaChat

/// M25: older pages load by themselves at the top of a conversation (OlderPaging). The reader's place is kept by the
/// upside-down list itself (M36): the page goes in at its far end.
@MainActor
final class OlderPagingTests: XCTestCase {
    /// A confirmed row as the server sends it: its rowKey (client_msg_id) is not its id (§10.3).
    private func row(_ seq: Int) -> MessageState {
        var message = MessageState(placeholderFor: "cmid-\(seq)", channelId: "c", senderId: "alice", body: "m\(seq)", createdAt: "2026-09-28T01:00:00Z")
        message.id = "id-\(seq)"
        message.seq = seq
        message.updatedSeq = seq
        message.pending = false
        return message
    }

    private func channel(hasOlder: Bool = true, synced: Int? = 120) -> ChannelState {
        let out = ChannelOut(id: "c", type: "public", name: "general", topic: nil, purpose: nil, archived: false, createdBy: nil, lastSeq: 120,
                             lastMessageAt: nil, createdAt: "", updatedAt: "", membership: nil, dmUserIds: nil)
        return ChannelState(channel: out, isMember: true, syncedSeq: synced, lastSeq: 120, hasOlder: hasOlder, oldestLoadedSeq: hasOlder ? 71 : 0)
    }

    private let top = CGRect(x: 0, y: 8, width: 369, height: 36) // the progress row, at rest at the top
    private let height: CGFloat = 638

    private func loads(_ channel: ChannelState? = nil, topRow: CGRect?? = nil, status: EngineStatus? = .online, focused: Bool = false,
                       placed: Bool = true, landing: Bool = false, busy: Bool = false, moving: Bool = false) -> Bool {
        OlderPaging.shouldLoad(channel ?? self.channel(), topRow: topRow ?? top, viewportHeight: height, status: status, focused: focused,
                               placed: placed, landing: landing, busy: busy, moving: moving)
    }

    func testTheTopRowOnScreenLoadsTheOlderPage() {
        XCTAssertTrue(loads())
        XCTAssertTrue(loads(topRow: CGRect(x: 0, y: -30, width: 369, height: 36))) // a few points of it are enough
    }

    func testNothingLoadsUntilTheTopRowIsReallyOnScreen() {
        // A list opened at the bottom of a full window: LazyVStack has not built the row, or built it above the screen.
        XCTAssertFalse(loads(topRow: .some(nil)))
        XCTAssertFalse(loads(topRow: CGRect(x: 0, y: -240, width: 369, height: 36)))
        XCTAssertFalse(loads(topRow: CGRect(x: 0, y: 700, width: 369, height: 36)))
        XCTAssertFalse(OlderPaging.shouldLoad(channel(), topRow: top, viewportHeight: 0, status: .online, focused: false, placed: true,
                                              landing: false, busy: false, moving: false)) // no layout yet
    }

    func testNotUnderTheReadersFingerNorWhileLandingOrBeforeThePlacement() {
        XCTAssertFalse(loads(moving: true))  // dragging or gliding: once it rests
        XCTAssertFalse(loads(landing: true)) // §10.1 4./6.: the landing on the first unread row goes first
        XCTAssertFalse(loads(placed: false)) // §10.1 4.: the placement may still be waiting for a catch-up
        XCTAssertFalse(loads(busy: true))    // a load (or 「最初の未読へ」) on its way, or the last one brought nothing
    }

    func testOnlyForTheNormalConversationWithAnOlderPageToRead() {
        XCTAssertFalse(loads(focused: true)) // the search context has its own rows
        XCTAssertFalse(loads(channel(hasOlder: false)))
        XCTAssertFalse(loads(channel(synced: nil))) // the window's newest page has not been read (§7.3)
        XCTAssertFalse(loads(status: .offline))
        XCTAssertFalse(loads(status: .connecting))
        XCTAssertFalse(OlderPaging.shouldLoad(nil, topRow: top, viewportHeight: height, status: .online, focused: false, placed: true,
                                              landing: false, busy: false, moving: false))
    }
}
