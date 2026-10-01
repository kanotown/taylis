import SwiftUI
import UIKit
import XCTest
@testable import ChikuwaChat

/// L8: renders the Times feed (rows with their times' name, the new dot, a reply count) and the home list with its
/// 「Times」 tile and the section's 「フィード」; writes PNGs when SNAPSHOT_DIR is set.
@MainActor
final class TimesFeedSnapshotTests: XCTestCase {
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

    private func user(_ id: String, _ name: String) -> UserPublic {
        UserPublic(id: id, username: id, displayName: name, role: "member", deactivatedAt: nil, createdAt: "", updatedAt: "")
    }

    private func times(_ id: String, owner: String, lastRead: Int) -> ChannelOut {
        var out = ChannelOut(id: id, type: "public", name: "times-\(owner)", topic: nil, purpose: nil, archived: false, createdBy: owner, lastSeq: 9,
                             lastMessageAt: nil, createdAt: "", updatedAt: "", membership: MembershipOut(role: "member", joinedAt: ""), dmUserIds: nil)
        out.timesOwnerId = owner
        out.readState = ReadStateOut(lastReadSeq: lastRead, unreadCount: 0, mentionCount: 0)
        return out
    }

    func testTheFeedAndItsWaysInRender() async throws {
        let controller = AppController()
        let store = controller.store
        store.setMe(UserMe(id: "me", username: "me", displayName: "Kano", role: "member", deactivatedAt: nil, createdAt: "", updatedAt: "", email: nil,
                           mustChangePassword: false))
        for person in [user("me", "Kano"), user("sato", "佐藤"), user("ebi", "Ebi")] { store.upsertUser(person) }
        store.upsertChannel(times("t1", owner: "sato", lastRead: 1), isMember: true)
        store.upsertChannel(times("t2", owner: "ebi", lastRead: 9), isMember: true)
        func post(_ id: String, _ channel: String, _ sender: String, _ body: String, seq: Int, minute: Int, replies: Int = 0) -> MessageOut {
            var out = MessageOut(id: id, channelId: channel, senderId: sender, seq: seq, updatedSeq: seq, clientMsgId: nil, body: body,
                                 createdAt: String(format: "2026-10-02T01:%02d:00Z", minute), editedAt: nil, deleted: false)
            out.replyCount = replies
            out.replyUserIds = replies > 0 ? ["me"] : []
            out.lastReplyAt = replies > 0 ? String(format: "2026-10-02T01:%02d:00Z", minute + 3) : nil
            return out
        }
        let page = TimesFeedOut(items: [
            post("m3", "t1", "sato", "今日の作業ログ: 試料の前処理が終わった。**明日は測定**。", seq: 3, minute: 40, replies: 2),
            post("m2", "t2", "ebi", "論文の 3 章を読んだ。メモは共有フォルダに。", seq: 9, minute: 30),
            post("m1", "t1", "sato", "装置の予約をした (木曜 10:00〜)", seq: 2, minute: 10),
        ], nextCursor: nil)
        await controller.timesFeed.refresh(fetch: { _ in page }, channel: { store.channel($0) })

        let feed = try render(NavigationStack { TimesFeedView(controller: controller, onOpen: { _ in }, onOpenChannel: { _ in }) },
                              size: CGSize(width: 393, height: 640), name: "times-feed.png")
        XCTAssertGreaterThan(feed.size.width, 0)
        let empty = AppController()
        await empty.timesFeed.refresh(fetch: { _ in TimesFeedOut(items: [], nextCursor: nil) }, channel: { _ in nil })
        _ = try render(NavigationStack { TimesFeedView(controller: empty, onOpen: { _ in }, onOpenChannel: { _ in }) },
                       size: CGSize(width: 393, height: 500), name: "times-feed-empty.png")
        _ = try render(NavigationStack { ChannelListView(controller: controller, selection: .constant(nil)) },
                       size: CGSize(width: 393, height: 520), name: "times-home.png")
    }
}
