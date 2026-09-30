import SwiftUI
import UIKit
import XCTest
@testable import ChikuwaChat

/// Renders the threads list and a thread with follow / unread state; writes PNGs when SNAPSHOT_DIR is set.
@MainActor
final class ThreadsSnapshotTests: XCTestCase {
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

    private func message(_ id: String, channel: String, sender: String, body: String, seq: Int, minute: Int, parentId: String? = nil, replyCount: Int = 0) -> MessageOut {
        MessageOut(id: id, channelId: channel, senderId: sender, seq: seq, updatedSeq: seq, clientMsgId: nil, body: body,
                   createdAt: String(format: "2026-09-27T01:%02d:00Z", minute), editedAt: nil, deleted: false,
                   mentionedUserIds: body.contains("<@me>") ? ["me"] : [], mentionAll: false, parentId: parentId,
                   replyCount: replyCount, lastReplyAt: replyCount > 0 ? String(format: "2026-09-27T01:%02d:00Z", minute + 5) : nil)
    }

    func testThreadsListAndThreadRender() throws {
        let controller = AppController()
        let store = controller.store
        store.setMe(UserMe(id: "me", username: "kano", displayName: "Kano", role: "member", deactivatedAt: nil, createdAt: "", updatedAt: "", email: nil, mustChangePassword: false))
        store.upsertUser(UserPublic(id: "me", username: "kano", displayName: "Kano", role: "member", deactivatedAt: nil, createdAt: "", updatedAt: ""))
        store.upsertUser(UserPublic(id: "u2", username: "toru", displayName: "Toru", role: "member", deactivatedAt: nil, createdAt: "", updatedAt: ""))
        let general = ChannelOut(id: "c1", type: "public", name: "general", topic: nil, purpose: nil, archived: false, createdBy: "me", lastSeq: 9,
                                 lastMessageAt: nil, createdAt: "", updatedAt: "", membership: MembershipOut(role: "member", joinedAt: ""), dmUserIds: nil)
        let dev = ChannelOut(id: "c2", type: "private", name: "dev", topic: nil, purpose: nil, archived: false, createdBy: "me", lastSeq: 4,
                             lastMessageAt: nil, createdAt: "", updatedAt: "", membership: MembershipOut(role: "member", joinedAt: ""), dmUserIds: nil)
        store.upsertChannel(general, isMember: true)
        store.upsertChannel(dev, isMember: true)
        let topic = message("m1", channel: "c1", sender: "u2", body: "来週のリリース手順、**ここで**まとめます。\n1. DB バックアップ\n2. compose up --build", seq: 1, minute: 10, replyCount: 2)
        let question = message("m5", channel: "c2", sender: "me", body: "検索の日本語トークンについて質問があります", seq: 2, minute: 20, replyCount: 1)
        _ = store.upsertMessage(topic)
        _ = store.upsertMessage(message("m2", channel: "c1", sender: "me", body: "了解です。バックアップは `infra/backup.sh` で大丈夫ですか？", seq: 2, minute: 12, parentId: "m1"))
        _ = store.upsertMessage(message("m3", channel: "c1", sender: "u2", body: "<@me> はい、それで。終わったらここに書いてください。", seq: 3, minute: 15, parentId: "m1"))
        store.setThreadPage(filter: "all", items: [
            ThreadItem(parent: topic, state: ThreadState(parentId: "m1", channelId: "c1", following: true, lastReadSeq: 2, unreadCount: 1, mentionCount: 1,
                                                          replyCount: 2, lastReplyAt: topic.lastReplyAt, participantIds: ["u2", "me"])),
            ThreadItem(parent: question, state: ThreadState(parentId: "m5", channelId: "c2", following: true, lastReadSeq: 4, unreadCount: 0, mentionCount: 0,
                                                             replyCount: 1, lastReplyAt: question.lastReplyAt, participantIds: ["me", "u2"])),
        ], cursor: nil, append: false, pageSize: 50)
        store.setThreadSummary(ThreadSummary(unreadCount: 1, mentionCount: 1))

        let list = NavigationStack { ThreadsListView(controller: controller) }
        let image = try render(list, size: CGSize(width: 393, height: 760), name: "threads-list.png")
        XCTAssertGreaterThan(image.size.width, 0)
        _ = try render(NavigationStack { ChannelListView(controller: controller, selection: .constant(nil)) }, size: CGSize(width: 393, height: 500), name: "threads-sidebar.png")
        _ = try render(NavigationStack { ThreadView(controller: controller, channelId: "c1", parentId: "m1") }, size: CGSize(width: 393, height: 760), name: "thread-open.png")

        // Presence + typing (M11b): a 1:1 DM header shows the other person's status; the typing line sits above the composer.
        let dm = ChannelOut(id: "d1", type: "dm", name: nil, topic: nil, purpose: nil, archived: false, createdBy: "me", lastSeq: 1,
                            lastMessageAt: nil, createdAt: "", updatedAt: "", membership: MembershipOut(role: "member", joinedAt: ""), dmUserIds: ["me", "u2"])
        store.upsertChannel(dm, isMember: true)
        store.updateChannel("d1") { $0.hasOlder = false; $0.syncedSeq = 1 }
        _ = store.upsertMessage(message("d1m1", channel: "d1", sender: "u2", body: "今いい？", seq: 1, minute: 30))
        store.setPresence("u2", status: "online")
        store.noteTyping("d1", parentId: nil, userId: "u2", until: Date().addingTimeInterval(60))
        _ = try render(NavigationStack { ChannelView(controller: controller, channelId: "d1", pendingThreadId: .constant(nil)) }, size: CGSize(width: 393, height: 500), name: "dm-presence-typing.png")
        _ = try render(NavigationStack { ChannelListView(controller: controller, selection: .constant(nil)) }, size: CGSize(width: 393, height: 600), name: "sidebar-presence.png")
    }
}
