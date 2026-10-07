import SwiftUI
import UIKit
import XCTest
@testable import ChikuwaChat

/// The composer's input grows with the lines typed, as far with attachments waiting as without (build 106: with a
/// photo attached it grew ~1.2 lines, the attachment strip took the height the input should have had).
@MainActor
final class ComposerHeightTests: XCTestCase {
    private func inputHeight(attachments: Int, windowHeight: CGFloat) throws -> CGFloat {
        let controller = AppController()
        let store = controller.store
        let channel = ChannelOut(id: "c1", type: "public", name: "研究室", topic: nil, purpose: nil, archived: false, createdBy: nil, lastSeq: 0,
                                 lastMessageAt: nil, createdAt: "", updatedAt: "", membership: MembershipOut(role: "member", joinedAt: ""), dmUserIds: nil)
        store.upsertChannel(channel, isMember: true)
        store.updateChannel("c1") { $0.hasOlder = false; $0.syncedSeq = 0 }
        store.setDraft("c1") { draft in
            draft.text = (1...8).map { "\($0) 行目" }.joined(separator: "\n")
            draft.attachments = (0..<attachments).map {
                AttachmentOut(id: "a\($0)", filename: "photo\($0).jpg", contentType: "image/jpeg", sizeBytes: 1024, width: 640, height: 480,
                              hasThumbnail: false, status: "pending", createdAt: "")
            }
        }
        let screen = NavigationStack { ChannelView(controller: controller, channelId: "c1", pendingThreadId: .constant(nil)) }
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        let size = CGSize(width: 402, height: windowHeight)
        let window = scene.map { UIWindow(windowScene: $0) } ?? UIWindow(frame: CGRect(origin: .zero, size: size))
        window.frame = CGRect(origin: .zero, size: size)
        let host = UIHostingController(rootView: screen)
        window.rootViewController = host
        window.makeKeyAndVisible()
        host.view.frame = window.bounds
        host.view.layoutIfNeeded()
        RunLoop.current.run(until: Date().addingTimeInterval(0.6))
        defer { window.isHidden = true }
        let field = try XCTUnwrap(Self.textInputs(in: host.view).last, "no text input")
        if let dir = ProcessInfo.processInfo.environment["SNAPSHOT_DIR"] {
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in _ = window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) }
            try image.pngData()?.write(to: URL(fileURLWithPath: dir).appendingPathComponent("composer-\(attachments)-\(Int(windowHeight)).png"))
        }
        return field.bounds.height
    }

    private static func textInputs(in view: UIView) -> [UIView] {
        (view is UITextView || view is UITextField ? [view] : []) + view.subviews.flatMap { textInputs(in: $0) }
    }

    /// 470 pt is a phone with the keyboard up: the conversation keeps what is left above.
    func testInputGrowsAsFarWithAttachments() throws {
        let full = try inputHeight(attachments: 0, windowHeight: 760)
        for height in [760.0, 470.0] {
            let without = try inputHeight(attachments: 0, windowHeight: height)
            let with = try inputHeight(attachments: 1, windowHeight: height)
            print("composer input height window=\(height) without=\(without) with=\(with)")
            XCTAssertEqual(without, full, accuracy: 1, "window \(height): the six lines, not a share of the screen")
            XCTAssertEqual(with, without, accuracy: 1, "window \(height): as tall with a photo waiting")
        }
    }
}
