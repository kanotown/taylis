import SwiftUI
import UIKit
import XCTest
@testable import ChikuwaChat

/// Renders the M11h screens (channel browser, channel intro, mentions, drafts); writes PNGs when SNAPSHOT_DIR is set.
@MainActor
final class BrowserSnapshotTests: XCTestCase {
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

    private func channel(_ id: String, name: String, type: String = "public", purpose: String? = nil, members: Int, mine: Bool) -> ChannelOut {
        ChannelOut(id: id, type: type, name: name, topic: nil, purpose: purpose, archived: false, createdBy: "u2", lastSeq: 3, lastMessageAt: nil,
                   createdAt: "2026-09-27T01:00:00Z", updatedAt: "", membership: mine ? MembershipOut(role: "member", joinedAt: "") : nil,
                   dmUserIds: nil, memberCount: members)
    }

    private func message(_ id: String, channel: String, body: String, seq: Int, minute: Int) -> MessageOut {
        MessageOut(id: id, channelId: channel, senderId: "u2", seq: seq, updatedSeq: seq, clientMsgId: nil, body: body,
                   createdAt: String(format: "2026-09-27T01:%02d:00Z", minute), editedAt: nil, deleted: false,
                   mentionedUserIds: ["me"], mentionAll: body.contains("<!channel>"), parentId: nil, replyCount: 0, lastReplyAt: nil)
    }

    func testBrowserIntroMentionsAndDraftsRender() throws {
        let controller = AppController()
        let store = controller.store
        store.setMe(UserMe(id: "me", username: "kano", displayName: "Kano", role: "member", deactivatedAt: nil, createdAt: "", updatedAt: "", email: nil, mustChangePassword: false))
        store.upsertUser(UserPublic(id: "me", username: "kano", displayName: "Kano", role: "member", deactivatedAt: nil, createdAt: "", updatedAt: ""))
        store.upsertUser(UserPublic(id: "u2", username: "toru", displayName: "Toru", role: "admin", deactivatedAt: nil, createdAt: "", updatedAt: ""))
        let general = channel("c1", name: "general", members: 5, mine: true)
        let design = channel("c2", name: "design-review", purpose: "デザインレビューの依頼と結果を共有するチャンネル", members: 2, mine: false)
        let ops = channel("c3", name: "ops", type: "private", purpose: "運用当番の連絡", members: 3, mine: true)
        store.upsertChannel(general, isMember: true)
        store.upsertChannel(ops, isMember: true)

        let browser = try render(ChannelBrowserView(controller: controller, onOpen: { _ in }, initial: [general, design, ops]),
                                 size: CGSize(width: 390, height: 600), name: "browser.png")
        XCTAssertGreaterThan(browser.size.width, 0)

        let intro = try render(VStack { ChannelIntroView(controller: controller, channel: store.channel("c3")!); Spacer() },
                               size: CGSize(width: 390, height: 240), name: "intro.png")
        XCTAssertGreaterThan(intro.size.width, 0)

        let mentions = [message("m1", channel: "c1", body: "<@me> 明日のリリース手順、確認お願いします", seq: 3, minute: 30),
                        message("m2", channel: "c1", body: "<!channel> 今週のふりかえりは金曜 16:00 からです", seq: 2, minute: 20)]
        let list = try render(NavigationStack { MentionsView(controller: controller, onOpen: { _ in }, initial: mentions) },
                              size: CGSize(width: 390, height: 500), name: "mentions.png")
        XCTAssertGreaterThan(list.size.width, 0)

        let files = [
            FileItem(attachment: AttachmentOut(id: "a1", filename: "logo-draft.png", contentType: "image/png", sizeBytes: 48_213, width: 640, height: 400, hasThumbnail: true, status: "attached", createdAt: "2026-09-27T01:30:00Z"),
                     messageId: "m1", channelId: "c1", parentId: nil, uploaderId: "u2", attachedAt: "2026-09-27T01:30:00Z"),
            FileItem(attachment: AttachmentOut(id: "a2", filename: "release-notes-v0.9.md", contentType: "text/markdown", sizeBytes: 812, width: nil, height: nil, hasThumbnail: false, status: "attached", createdAt: "2026-09-27T01:20:00Z"),
                     messageId: "m2", channelId: "c3", parentId: "m1", uploaderId: "me", attachedAt: "2026-09-27T01:20:00Z"),
        ]
        let filesImage = try render(NavigationStack { FilesView(controller: controller, onOpen: { _, _, _ in }, initial: files) },
                                    size: CGSize(width: 390, height: 500), name: "files.png")
        XCTAssertGreaterThan(filesImage.size.width, 0)

        store.setDraft("c1") { $0.text = "リリースノートの下書き: 今回の変更点はスレッドのフォローとリンクプレビューです" }
        store.setDraft("c3", parentId: "m9") { $0.text = "当番表を更新しました" }
        XCTAssertEqual(store.listDrafts().count, 2)
        let drafts = try render(NavigationStack { DraftsView(controller: controller, onOpen: { _, _ in }) },
                                size: CGSize(width: 390, height: 400), name: "drafts.png")
        XCTAssertGreaterThan(drafts.size.width, 0)
    }
}
