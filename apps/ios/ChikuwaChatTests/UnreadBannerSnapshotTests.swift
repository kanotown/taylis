import SwiftUI
import UIKit
import XCTest
@testable import ChikuwaChat

/// Renders a conversation whose unread rows are not all loaded (§10.1): the banner sits above the timeline and no
/// divider is drawn. Visual only: the PNGs (written when SNAPSHOT_DIR is set) are for a person to look at, and the test
/// asserts just the banner state it renders. What the view does over time (placing, landing, anchoring, marking) is
/// covered by ReadAnchorTests and the engine by UnreadRangeTests.
@MainActor
final class UnreadBannerSnapshotTests: XCTestCase {
    private func render<V: View>(_ view: V, size: CGSize, name: String) throws -> UIImage {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        let window = scene.map { UIWindow(windowScene: $0) } ?? UIWindow(frame: CGRect(origin: .zero, size: size))
        window.frame = CGRect(origin: .zero, size: size)
        let host = UIHostingController(rootView: view)
        host.view.backgroundColor = .systemBackground
        window.rootViewController = host
        window.makeKeyAndVisible()
        host.view.frame = window.bounds
        host.view.layoutIfNeeded()
        RunLoop.current.run(until: Date().addingTimeInterval(0.6))
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { context in
            if !window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) { window.layer.render(in: context.cgContext) }
        }
        window.isHidden = true
        if let dir = ProcessInfo.processInfo.environment["SNAPSHOT_DIR"], let data = image.pngData() {
            let url = URL(fileURLWithPath: dir).appendingPathComponent(name)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: url)
            print("snapshot written: \(url.path)")
        }
        return image
    }

    private func conversation(unread: Int, lastSeq: Int) -> AppController {
        let controller = AppController()
        let store = controller.store
        store.setMe(UserMe(id: "me", username: "kano", displayName: "Kano", role: "member", deactivatedAt: nil, createdAt: "", updatedAt: "", email: nil, mustChangePassword: false))
        store.upsertUser(UserPublic(id: "u2", username: "toru", displayName: "Toru", role: "member", deactivatedAt: nil, createdAt: "", updatedAt: ""))
        let lastRead = lastSeq - unread
        let formatter = ISO8601DateFormatter()
        let today = Calendar.current.startOfDay(for: Date())
        var general = ChannelOut(id: "c1", type: "public", name: "big", topic: nil, purpose: nil, archived: false, createdBy: "u2", lastSeq: lastSeq,
                                 lastMessageAt: nil, createdAt: "", updatedAt: "", membership: MembershipOut(role: "member", joinedAt: ""), dmUserIds: nil)
        general.readState = ReadStateOut(lastReadSeq: lastRead, unreadCount: unread, mentionCount: 0,
                                         firstUnreadAt: formatter.string(from: today.addingTimeInterval(10 * 3600 + 23 * 60)))
        store.upsertChannel(general, isMember: true)
        store.updateChannel("c1") { $0.syncedSeq = lastSeq; $0.oldestLoadedSeq = lastSeq - 49; $0.hasOlder = true }
        for seq in (lastSeq - 49)...lastSeq {
            _ = store.upsertMessage(MessageOut(id: "m\(seq)", channelId: "c1", senderId: "u2", seq: seq, updatedSeq: seq, clientMsgId: "k\(seq)",
                                               body: "メッセージ \(seq)", createdAt: formatter.string(from: today.addingTimeInterval(14 * 3600 + Double(seq))),
                                               editedAt: nil, deleted: false))
        }
        return controller
    }

    func testBannerRendersAboveTheTimeline() throws {
        let size = CGSize(width: 393, height: 600)
        // V2: 2,000 unread, only 「既読にする」; offline here (no engine), so the button is disabled.
        let v2 = conversation(unread: 2000, lastSeq: 3000)
        XCTAssertEqual(ReadGate.banner(v2.store.channel("c1")!, focused: false, positioned: true, anchored: false, held: false, jumping: false, status: .offline)?.jump, false)
        _ = try render(NavigationStack { ChannelView(controller: v2, channelId: "c1", pendingThreadId: .constant(nil)) }, size: size, name: "unread-banner-2000.png")
        // V4: 300 unread, both buttons.
        let v4 = conversation(unread: 300, lastSeq: 1300)
        XCTAssertEqual(ReadGate.banner(v4.store.channel("c1")!, focused: false, positioned: true, anchored: false, held: false, jumping: false, status: .offline)?.jump, true)
        let image = try render(NavigationStack { ChannelView(controller: v4, channelId: "c1", pendingThreadId: .constant(nil)) }, size: size, name: "unread-banner-300.png")
        XCTAssertGreaterThan(image.size.width, 0)
    }
}
