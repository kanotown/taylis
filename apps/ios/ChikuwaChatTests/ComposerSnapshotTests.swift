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

    func testJapaneseMentionCandidatesRender() throws {
        let controller = AppController()
        let store = controller.store
        store.upsertUser(UserPublic(id: "00000000-0000-7000-8000-000000000001", username: "yamada", displayName: "山田 太郎", role: "member", deactivatedAt: nil, createdAt: "", updatedAt: ""))
        let channel = ChannelOut(id: "c1", type: "public", name: "研究室", topic: nil, purpose: nil, archived: false, createdBy: nil, lastSeq: 0,
                                 lastMessageAt: nil, createdAt: "", updatedAt: "", membership: MembershipOut(role: "member", joinedAt: ""), dmUserIds: nil)
        store.upsertChannel(channel, isMember: true)
        store.updateChannel("c1") { $0.hasOlder = false; $0.syncedSeq = 0 }
        store.setDraft("c1") { $0.text = "確認をお願いします @山田" }
        let screen = NavigationStack { ChannelView(controller: controller, channelId: "c1", pendingThreadId: .constant(nil)) }
        let image = try render(screen, size: CGSize(width: 393, height: 760), name: "C6-ios.png")
        XCTAssertGreaterThan(image.size.width, 0)
    }

    /// M187 (MOBILE_UI.md §30): the message editor offers the composer's candidates and メンション / 絵文字 / 書式.
    func testMessageEditorOffersCandidatesAndTools() throws {
        let controller = AppController()
        let store = controller.store
        store.upsertUser(UserPublic(id: "00000000-0000-7000-8000-000000000001", username: "yamada", displayName: "山田 太郎", role: "member", deactivatedAt: nil, createdAt: "", updatedAt: ""))
        let channel = ChannelOut(id: "c1", type: "public", name: "研究室", topic: nil, purpose: nil, archived: false, createdBy: nil, lastSeq: 0,
                                 lastMessageAt: nil, createdAt: "", updatedAt: "", membership: MembershipOut(role: "member", joinedAt: ""), dmUserIds: nil)
        store.upsertChannel(channel, isMember: true)
        let mention = EditMessageView(initial: "確認をお願いします @山田", controller: controller, channelId: "c1") { _, _ in nil }
        _ = try render(mention, size: CGSize(width: 393, height: 760), name: "M187-edit-mention-ios.png")
        let party = CustomEmojiOut(id: "e1", name: "tada_party", contentType: "image/png", width: 32, height: 32, createdBy: "u", createdAt: "",
                                   kind: "text", label: "おめでとう", color: "#d97706")
        store.customEmoji = ["tada_party": party]
        let emoji = EditMessageView(initial: "できました :tad", controller: controller, channelId: "c1") { _, _ in nil }
        _ = try render(emoji, size: CGSize(width: 393, height: 760), name: "M187-edit-emoji-ios.png")
    }

    /// M187: in the editor, `:` typed in the middle of the text offers its candidates (iOS 26 reports the cursor), as on
    /// Android and the desktop. Types through the text view the way the keyboard does (UITextInput.insertText).
    func testMessageEditorOffersCandidatesAtTheCursor() throws {
        let controller = AppController()
        let party = CustomEmojiOut(id: "e1", name: "tada_party", contentType: "image/png", width: 32, height: 32, createdBy: "u", createdAt: "",
                                   kind: "text", label: "おめでとう", color: "#d97706")
        controller.store.customEmoji = ["tada_party": party]
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        let window = scene.map { UIWindow(windowScene: $0) } ?? UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 760))
        window.frame = CGRect(x: 0, y: 0, width: 393, height: 760)
        let host = UIHostingController(rootView: EditMessageView(initial: "了解です 明日伺います", controller: controller, channelId: "c1") { _, _ in nil })
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        RunLoop.current.run(until: Date().addingTimeInterval(0.6))
        func textView(in view: UIView) -> UITextView? {
            if let found = view as? UITextView { return found }
            return view.subviews.lazy.compactMap { textView(in: $0) }.first
        }
        let field = try XCTUnwrap(textView(in: host.view))
        field.becomeFirstResponder()
        field.selectedRange = NSRange(location: 4, length: 0)  // after 「了解です」
        RunLoop.current.run(until: Date().addingTimeInterval(0.3))
        field.insertText(" :tad")
        RunLoop.current.run(until: Date().addingTimeInterval(0.6))
        XCTAssertEqual(field.text, "了解です :tad 明日伺います")
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { context in
            if !window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) { window.layer.render(in: context.cgContext) }
        }
        if let dir = ProcessInfo.processInfo.environment["SNAPSHOT_DIR"], let data = image.pngData() {
            try data.write(to: URL(fileURLWithPath: dir).appendingPathComponent("M187-edit-midtext-ios.png"))
        }
    }

    func testUnavailableThumbnailRenders() throws {
        let controller = AppController()
        let attachment = AttachmentOut(id: "unavailable", filename: "実験結果.png", contentType: "image/png", sizeBytes: 1024, width: 640, height: 480, hasThumbnail: true, status: "attached", createdAt: "")
        let view = VStack(alignment: .leading) {
            Text("山田 太郎").font(.headline)
            Text("実験結果を添付しました")
            AttachmentsView(attachments: [attachment], controller: controller)
            Spacer()
        }.padding()
        _ = try render(view, size: CGSize(width: 393, height: 450), name: "C7-ios.png")
    }

    func testThumbnailFailureAndRetry() async throws {
        let loader = AttachmentImageLoader()
        await loader.load { throw URLError(.notConnectedToInternet) }
        XCTAssertTrue(loader.failed)
        await loader.load { Data("invalid image".utf8) }
        XCTAssertTrue(loader.failed)
        let data = UIGraphicsImageRenderer(size: CGSize(width: 10, height: 10)).image { _ in
            UIColor.blue.setFill()
            UIRectFill(CGRect(x: 0, y: 0, width: 10, height: 10))
        }.pngData()!
        await loader.load { data }
        XCTAssertFalse(loader.failed)
        XCTAssertNotNil(loader.image)
    }

    func testThumbnailIgnoresSupersededRequest() async {
        let loader = AttachmentImageLoader()
        var oldResponse: CheckedContinuation<Data, Error>?
        let old = Task { await loader.load { try await withCheckedThrowingContinuation { oldResponse = $0 } } }
        while oldResponse == nil { await Task.yield() }
        let data = UIGraphicsImageRenderer(size: CGSize(width: 10, height: 10)).image { _ in }.pngData()!
        await loader.load { data }
        oldResponse?.resume(throwing: URLError(.networkConnectionLost))
        await old.value
        XCTAssertFalse(loader.failed)
        XCTAssertNotNil(loader.image)
    }

    func testAvatarCropScreenRenders() throws {  // M16g
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        let photo = UIGraphicsImageRenderer(size: CGSize(width: 1600, height: 1200), format: format).image { context in
            UIColor.systemTeal.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 1600, height: 1200))
            UIColor.systemYellow.setFill()
            context.cgContext.fillEllipse(in: CGRect(x: 500, y: 300, width: 600, height: 600))
        }
        let image = try render(AvatarCropView(image: photo, onCancel: {}, onDone: { _ in }), size: CGSize(width: 393, height: 760), name: "avatar-crop.png")
        XCTAssertGreaterThan(image.size.width, 0)
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
