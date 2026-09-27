import SwiftUI
import UIKit
import XCTest
@testable import ChikuwaChat

/// Renders screens in the test host's window scene and writes PNGs when SNAPSHOT_DIR is set
/// (`TEST_RUNNER_SNAPSHOT_DIR=/path xcodebuild test …`); otherwise it only checks that rendering works.
@MainActor
final class ComposerSnapshotTests: XCTestCase {
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

    private func message(_ id: String, channel: String, sender: String, body: String, seq: Int, minute: Int) -> MessageState {
        var m = MessageState(placeholderFor: id, channelId: channel, senderId: sender, body: body, createdAt: String(format: "2026-09-27T01:%02d:00Z", minute))
        m.id = id
        m.seq = seq
        m.updatedSeq = seq
        m.pending = false
        m.clientMsgId = nil
        return m
    }

    func testTableBodyRenders() throws {  // M15g
        let body = "リリース前の担当表です\n| 項目 | 担当 | 状態 | 期限 |\n| :--- | :-: | :-: | ---: |\n| API の移行 | 田中 | ✅ 完了 | 9/30 |\n| **UI** の最終確認 | 鈴木 | 🚧 作業中 | 10/1 |\n| ドキュメント (`README`) | 佐藤 | 未着手 | 10/2 |\n質問があればスレッドへ"
        let view = VStack(alignment: .leading) {
            PriorityLabelView(priority: "important")
            MessageBodyView(text: body, users: [:])
            Spacer()
        }.padding()
        let image = try render(view, size: CGSize(width: 390, height: 320), name: "table-body.png")
        XCTAssertGreaterThan(image.size.width, 0)
    }

    func testChannelScreenWithComposerRenders() throws {
        let controller = AppController()
        let store = controller.store
        let me = UserMe(id: "me", username: "kano", displayName: "Kano", role: "member", deactivatedAt: nil, createdAt: "", updatedAt: "", email: nil, mustChangePassword: false)
        store.setMe(me)
        store.upsertUser(UserPublic(id: "me", username: "kano", displayName: "Kano", role: "member", deactivatedAt: nil, createdAt: "", updatedAt: ""))
        store.upsertUser(UserPublic(id: "u2", username: "toru", displayName: "Toru", role: "member", deactivatedAt: nil, createdAt: "", updatedAt: ""))
        let channel = ChannelOut(id: "c1", type: "public", name: "general", topic: "週次の進捗共有", purpose: nil, archived: false, createdBy: "me", lastSeq: 3,
                                 lastMessageAt: nil, createdAt: "", updatedAt: "", membership: MembershipOut(role: "member", joinedAt: ""), dmUserIds: nil)
        store.upsertChannel(channel, isMember: true)
        store.updateChannel("c1") { $0.hasOlder = false; $0.syncedSeq = 3 }
        _ = store.upsertMessage(message("m1", channel: "c1", sender: "u2", body: "# 今日の予定\n- API の**残件**を片付ける\n- 15:00 レビュー", seq: 1, minute: 10))
        _ = store.upsertMessage(message("m2", channel: "c1", sender: "me", body: "了解です。`deploy.sh` を直しておきます", seq: 2, minute: 12))
        _ = store.upsertMessage(message("m3", channel: "c1", sender: "u2", body: "> 15:00 レビュー\nありがとう！", seq: 3, minute: 13))
        store.setDraft("c1") { $0.text = "今から確認します @to" }
        let attachment = AttachmentOut(id: "a", filename: "IMG_0001.jpg", contentType: "image/jpeg", sizeBytes: 12_000, width: 100, height: 100, hasThumbnail: true, status: "pending", createdAt: "")
        store.setDraft("c1") { $0.attachments = [attachment] }

        let screen = NavigationStack { ChannelView(controller: controller, channelId: "c1", pendingThreadId: .constant(nil)) }
        let image = try render(screen, size: CGSize(width: 393, height: 760), name: "channel-composer.png")
        XCTAssertGreaterThan(image.size.width, 0)

        store.setDraft("c1") { $0 = Draft() }
        _ = try render(NavigationStack { ChannelView(controller: controller, channelId: "c1", pendingThreadId: .constant(nil)) }, size: CGSize(width: 393, height: 760), name: "channel-empty-composer.png")
    }
}
