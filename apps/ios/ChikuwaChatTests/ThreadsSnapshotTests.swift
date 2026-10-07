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
        let m2 = message("m2", channel: "c1", sender: "me", body: "了解です。バックアップは `infra/backup.sh` で大丈夫ですか？", seq: 2, minute: 12, parentId: "m1")
        let m3 = message("m3", channel: "c1", sender: "u2", body: "<@me> はい、それで。終わったらここに書いてください。\n- 手順書\n- 確認\n- 連絡\n- 片付け", seq: 3, minute: 15, parentId: "m1")
        _ = store.upsertMessage(m2)
        _ = store.upsertMessage(m3)
        store.setThreadPage(filter: "all", items: [
            // THREADS.md §5: the newest replies under the parent (three in all: 「他 1 件の返信」), the unread one marked.
            ThreadItem(parent: topic, state: ThreadState(parentId: "m1", channelId: "c1", following: true, lastReadSeq: 2, unreadCount: 1, mentionCount: 1,
                                                          replyCount: 3, lastReplyAt: topic.lastReplyAt, participantIds: ["u2", "me"]),
                       latestReplies: [m2, m3]),
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

/// 仕上げ C (MOBILE_POLISH.md C3, D1, C10, C7), light and dark: the thread line under a parent, the channel details'
/// header, the emoji picker's 「よく使う」 and a short thread at the top. Run with TEST_RUNNER_SNAPSHOT_DIR=<dir> to look.
@MainActor
final class PolishCSnapshotTests: XCTestCase {
    private func render<V: View>(_ view: V, size: CGSize, style: UIUserInterfaceStyle, name: String, settle: TimeInterval = 0.8) throws -> UIImage {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        let window = scene.map { UIWindow(windowScene: $0) } ?? UIWindow(frame: CGRect(origin: .zero, size: size))
        window.frame = CGRect(origin: .zero, size: size)
        window.overrideUserInterfaceStyle = style
        let host = UIHostingController(rootView: view)
        host.view.backgroundColor = .systemBackground
        window.rootViewController = host
        window.makeKeyAndVisible()
        host.view.frame = window.bounds
        host.view.layoutIfNeeded()
        RunLoop.current.run(until: Date().addingTimeInterval(settle))
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

    private func iso(_ date: Date) -> String { ISO8601DateFormatter().string(from: date) }

    private func message(_ id: String, sender: String, body: String, seq: Int, at: Date, parentId: String? = nil) -> MessageOut {
        MessageOut(id: id, channelId: "c1", senderId: sender, seq: seq, updatedSeq: seq, clientMsgId: nil, body: body, createdAt: iso(at),
                   editedAt: nil, deleted: false, parentId: parentId)
    }

    private func setUp(_ controller: AppController, topic: String? = "スマホ UI の監査用 (テスト投稿)") {
        let store = controller.store
        store.setMe(UserMe(id: "me", username: "kano", displayName: "Kano", role: "member", deactivatedAt: nil, createdAt: "", updatedAt: "",
                           email: nil, mustChangePassword: false))
        for (id, name) in [("me", "Kano"), ("u2", "Toru Yamada"), ("u3", "佐藤"), ("u4", "Android android1")] { store.upsertUser(user(id, name)) }
        let channel = ChannelOut(id: "c1", type: "public", name: "audit-test", topic: topic, purpose: nil, archived: false, createdBy: "me", lastSeq: 9,
                                 lastMessageAt: nil, createdAt: "", updatedAt: "", membership: MembershipOut(role: "owner", joinedAt: ""), dmUserIds: nil,
                                 notification: NotificationPreferenceOut(channelId: "c1", level: "mentions", mutedUntil: nil, followsDefault: true))
        store.upsertChannel(channel, isMember: true)
        store.updateChannel("c1") { $0.hasOlder = false; $0.syncedSeq = 9; $0.lastReadSeq = 9 }
    }

    /// C3: three faces (the latest replier first), 「N 件の返信」 and 「最終返信 …」; a parent from an older server
    /// (no repliers) shows the bubble instead.
    func testThreadLine() throws {
        let controller = AppController()
        setUp(controller)
        let store = controller.store
        let now = Date()
        var parent = message("p1", sender: "u2", body: "来週の発表順について相談させてください。候補を 3 つ考えました。", seq: 1, at: now.addingTimeInterval(-3 * 3600))
        parent.replyCount = 4
        parent.lastReplyAt = iso(now.addingTimeInterval(-600))
        parent.replyUserIds = ["u4", "me", "u3", "u2"]
        _ = store.upsertMessage(parent)
        var older = message("p2", sender: "u3", body: "昨日の議事メモです。", seq: 6, at: now.addingTimeInterval(-3000))
        older.replyCount = 1
        older.lastReplyAt = iso(now.addingTimeInterval(-26 * 3600))
        _ = store.upsertMessage(older)
        _ = store.upsertMessage(message("m7", sender: "me", body: "了解です", seq: 7, at: now.addingTimeInterval(-60)))
        for style in [UIUserInterfaceStyle.light, .dark] {
            let view = NavigationStack { ChannelView(controller: controller, channelId: "c1", pendingThreadId: .constant(nil)) }
            let image = try render(view, size: CGSize(width: 393, height: 700), style: style, name: "thread-line-\(style == .dark ? "dark" : "light").png")
            XCTAssertGreaterThan(image.size.width, 0)
        }
    }

    /// D1: the name, topic and round buttons on top; the notifications one row (its page too).
    func testChannelDetails() throws {
        let controller = AppController()
        setUp(controller)
        controller.store.favorites = ["c1"]
        for style in [UIUserInterfaceStyle.light, .dark] {
            let suffix = style == .dark ? "dark" : "light"
            let details = NavigationStack { ChannelInfoView(controller: controller, channelId: "c1") }
            let image = try render(details, size: CGSize(width: 393, height: 1100), style: style, name: "channel-details-\(suffix).png")
            XCTAssertGreaterThan(image.size.width, 0)
            _ = try render(NavigationStack { ChannelNotificationsView(controller: controller, channelId: "c1") },
                           size: CGSize(width: 393, height: 700), style: style, name: "channel-notifications-\(suffix).png")
        }
    }

    /// C10: 「よく使う」 heads the picker, the category under it.
    func testEmojiPickerFrequent() throws {
        let defaults = UserDefaults.standard
        let saved = (defaults.string(forKey: EmojiUsage.key), defaults.string(forKey: EmojiUsage.recentKey))
        defer {
            defaults.set(saved.0, forKey: EmojiUsage.key)
            defaults.set(saved.1, forKey: EmojiUsage.recentKey)
        }
        var usage = EmojiUsage()
        for glyph in ["👍", "🎉", "👍", "🙏", "😂", "👍", "🎉", "✅", "👀", "❤️", "🙇"] { usage.record(glyph) }
        defaults.set(usage.encoded, forKey: EmojiUsage.key)
        for style in [UIUserInterfaceStyle.light, .dark] {
            let view = Color(.systemBackground).sheet(isPresented: .constant(true)) { EmojiPickerView { _ in }.presentationDetents([.large]) }
            let image = try render(view, size: CGSize(width: 393, height: 852), style: style, name: "emoji-picker-\(style == .dark ? "dark" : "light").png", settle: 1.2)
            XCTAssertGreaterThan(image.size.width, 0)
        }
    }

    /// C7: a short thread starts under the bar (the parent, then the replies), not at the bottom under a gap; a long one
    /// still ends at its newest reply above the input.
    func testShortThreadSitsAtTheTop() throws {
        let controller = AppController()
        setUp(controller)
        let store = controller.store
        let now = Date()
        var parent = message("p1", sender: "u2", body: "来週の発表順について相談させてください。", seq: 1, at: now.addingTimeInterval(-3600))
        parent.replyCount = 2
        parent.replyUserIds = ["u2", "u4"]
        parent.lastReplyAt = iso(now.addingTimeInterval(-60))
        _ = store.upsertMessage(parent)
        _ = store.upsertMessage(message("r1", sender: "u4", body: "案 2 が良いと思います", seq: 2, at: now.addingTimeInterval(-120), parentId: "p1"))
        _ = store.upsertMessage(message("r2", sender: "u2", body: "ありがとうございます。では案 2 で進めます", seq: 3, at: now.addingTimeInterval(-60), parentId: "p1"))
        for style in [UIUserInterfaceStyle.light, .dark] {
            let view = NavigationStack { ThreadView(controller: controller, channelId: "c1", parentId: "p1") }
            let image = try render(view, size: CGSize(width: 393, height: 852), style: style, name: "thread-short-\(style == .dark ? "dark" : "light").png")
            XCTAssertGreaterThan(image.size.width, 0)
        }
        for index in 0..<14 {
            _ = store.upsertMessage(message("x\(index)", sender: index % 2 == 0 ? "u3" : "me", body: "返信 \(index + 1)", seq: 10 + index,
                                            at: now.addingTimeInterval(Double(index)), parentId: "p1"))
        }
        let view = NavigationStack { ThreadView(controller: controller, channelId: "c1", parentId: "p1") }
        _ = try render(view, size: CGSize(width: 393, height: 852), style: .light, name: "thread-long-light.png")
    }
}
