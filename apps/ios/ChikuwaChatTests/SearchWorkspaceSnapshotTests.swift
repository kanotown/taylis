import SwiftUI
import UIKit
import XCTest
@testable import ChikuwaChat

/// M16b / M16c: the search results and the workspace rows render; writes PNGs when SNAPSHOT_DIR is set.
@MainActor
final class SearchWorkspaceSnapshotTests: XCTestCase {
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

    private func message(_ id: String, body: String, parentId: String? = nil, minute: Int) -> MessageOut {
        var message = MessageOut(id: id, channelId: "c1", senderId: "u2", seq: minute, updatedSeq: minute, clientMsgId: nil, body: body,
                                 createdAt: String(format: "2026-09-27T01:%02d:00Z", minute), editedAt: nil, deleted: false)
        message.parentId = parentId
        return message
    }

    func testSearchResultsAndWorkspaceRowsRender() throws {
        let controller = AppController()
        let store = controller.store
        store.setMe(UserMe(id: "me", username: "kano", displayName: "Kano", role: "member", deactivatedAt: nil, createdAt: "", updatedAt: "", email: nil, mustChangePassword: false))
        store.upsertUser(UserPublic(id: "u2", username: "tanaka", displayName: "田中 太郎", role: "member", deactivatedAt: nil, createdAt: "", updatedAt: ""))
        store.upsertChannel(ChannelOut(id: "c1", type: "public", name: "design", topic: nil, purpose: nil, archived: false, createdBy: "u2", lastSeq: 3,
                                       lastMessageAt: nil, createdAt: "", updatedAt: "", membership: MembershipOut(role: "member", joinedAt: ""), dmUserIds: nil),
                            isMember: true)
        var first = message("m1", body: "設計レビューは **明日 15:00** から。資料を先に見てください", minute: 10)
        first.attachments = [AttachmentOut(id: "a", filename: "設計レビュー資料.pdf", contentType: "application/pdf", sizeBytes: 2048, width: nil, height: nil,
                                           hasThumbnail: false, status: "attached", createdAt: "")]
        let reply = message("m2", body: "設計の変更点はスレッドにまとめました", parentId: "m1", minute: 12)
        let model = SearchModel(params: SearchParams(q: "設計", fromUserId: "u2", has: [.file]),
                                hits: [SearchHit(message: first, score: 2), SearchHit(message: reply, score: 1)], keywords: ["設計"], total: 1234)
        let results = try render(NavigationStack {
            SearchResultsView(controller: controller, model: model, onUpdate: { _ in }, onPick: { _ in }, onOpen: { _, _, _ in })
        }, size: CGSize(width: 393, height: 640), name: "search-results.png")
        XCTAssertGreaterThan(results.size.width, 0)

        let unresolved = SearchModel(params: SearchParams(q: "from:@nobody 設計", has: [.pin]), hits: [], keywords: [], total: 0, unresolved: ["from:@nobody"])
        _ = try render(NavigationStack {
            SearchResultsView(controller: controller, model: unresolved, onUpdate: { _ in }, onPick: { _ in }, onOpen: { _, _, _ in })
        }, size: CGSize(width: 393, height: 520), name: "search-empty.png")

        let rows = try render(List {
            WorkspaceRow(workspace: Workspace(serverUrl: "https://chat.example.com", workspaceId: "w1", name: "開発チーム", username: "kano", badge: 3), active: false)
            WorkspaceRow(workspace: Workspace(serverUrl: "http://127.0.0.1:8001", name: "テストチーム", username: "dtuser1", hasUnread: true), active: false)
            WorkspaceRow(workspace: Workspace(serverUrl: "https://old.example.com", name: "Old Team", username: "kano", signedOut: true), active: false)
            WorkspaceRow(workspace: Workspace(serverUrl: "https://a.example.com", workspaceId: "w2", name: "ChikuwaChat", username: "kano"), active: true)
        }, size: CGSize(width: 393, height: 420), name: "workspace-rows.png")
        XCTAssertGreaterThan(rows.size.width, 0)
    }
}
