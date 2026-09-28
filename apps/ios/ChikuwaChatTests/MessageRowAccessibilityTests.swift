import SwiftUI
import UIKit
import XCTest
@testable import ChikuwaChat

/// M25: VoiceOver reaches a message's action sheet (it has no long press), and the 「＋」 chip after its reactions.
/// SwiftUI builds its accessibility elements only while assistive technology is on, so the test turns it on the way
/// the accessibility snapshot tools do; it is skipped where that switch is missing.
@MainActor
final class MessageRowAccessibilityTests: XCTestCase {
    private typealias Switch = @convention(c) (Bool) -> Void
    private var accessibility: Switch?
    private var window: UIWindow?

    override func setUpWithError() throws {
        guard let handle = dlopen("/usr/lib/libAccessibility.dylib", RTLD_NOW),
              let symbol = dlsym(handle, "_AXSApplicationAccessibilitySetEnabled") else { throw XCTSkip("no accessibility switch") }
        accessibility = unsafeBitCast(symbol, to: Switch.self)
        accessibility?(true)
    }

    override func tearDown() {
        window?.isHidden = true
        window = nil
        accessibility?(false) // the other tests render without it, as before
    }

    private func controller() -> AppController {
        let controller = AppController()
        controller.store.setMe(UserMe(id: "me", username: "kano", displayName: "Kano", role: "member", deactivatedAt: nil, createdAt: "", updatedAt: "",
                                      email: nil, mustChangePassword: false))
        controller.store.upsertUser(UserPublic(id: "u2", username: "toru", displayName: "Toru", role: "member", deactivatedAt: nil, createdAt: "", updatedAt: ""))
        return controller
    }

    private func message(pending: Bool = false) -> MessageState {
        var message = MessageState(placeholderFor: "k1", channelId: "c1", senderId: pending ? "me" : "u2", body: "見てください https://example.com/page",
                                   createdAt: "2026-09-27T01:10:00Z")
        if !pending {
            message.id = "m1"
            message.seq = 1
            message.updatedSeq = 1
            message.pending = false
            message.reactions = [ReactionOut(emoji: "👍", count: 2, userIds: ["me", "u2"])]
        }
        return message
    }

    /// The row's accessibility elements, rendered in the test host's window.
    private func elements(_ row: MessageRow) -> (host: UIViewController, elements: [NSObject]) {
        let size = CGSize(width: 393, height: 400)
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        let window = scene.map { UIWindow(windowScene: $0) } ?? UIWindow(frame: CGRect(origin: .zero, size: size))
        window.frame = CGRect(origin: .zero, size: size)
        let host = UIHostingController(rootView: VStack { row; Spacer() }.padding())
        window.rootViewController = host
        window.makeKeyAndVisible()
        self.window = window
        host.view.frame = window.bounds
        host.view.layoutIfNeeded()
        RunLoop.current.run(until: Date().addingTimeInterval(0.5))
        var found: [NSObject] = []
        func walk(_ element: NSObject, depth: Int) {
            guard depth < 20 else { return }
            if element.isAccessibilityElement { found.append(element) }
            let count = element.accessibilityElementCount()
            guard count > 0, count != NSNotFound else { return }
            for index in 0..<count { if let child = element.accessibilityElement(at: index) as? NSObject { walk(child, depth: depth + 1) } }
        }
        walk(host.view, depth: 0)
        return (host, found)
    }

    func testEveryElementOfAMessageOffersItsActionsAndKeepsItsOwn() throws {
        let controller = controller()
        let (host, elements) = elements(MessageRow(message: message(), controller: controller))
        let labels = elements.compactMap(\.accessibilityLabel)
        XCTAssertTrue(labels.contains("Toru"), "\(labels)")
        XCTAssertTrue(labels.contains { $0.contains("見てください") }, "\(labels)")
        for element in elements {
            XCTAssertEqual(element.accessibilityCustomActions?.map(\.name), ["メッセージの操作"], element.accessibilityLabel ?? "")
        }
        // The reaction and the 「＋」 chip after it stay buttons of their own.
        let reaction = try XCTUnwrap(elements.first { $0.accessibilityLabel == "👍 2" })
        XCTAssertTrue(reaction.accessibilityTraits.contains(.button))
        let add = try XCTUnwrap(elements.first { $0.accessibilityLabel == "リアクションを追加" })
        XCTAssertTrue(add.accessibilityTraits.contains(.button))

        // The action opens the long-press sheet: the six quick reactions and the list of actions.
        let action = try XCTUnwrap(elements.first?.accessibilityCustomActions?.first)
        XCTAssertTrue(action.actionHandler?(action) ?? false)
        RunLoop.current.run(until: Date().addingTimeInterval(1.0))
        XCTAssertNotNil(host.presentedViewController, "the action sheet")
    }

    func testThePlusChipOpensTheEmojiPicker() throws {
        let (host, elements) = elements(MessageRow(message: message(), controller: controller()))
        let add = try XCTUnwrap(elements.first { $0.accessibilityLabel == "リアクションを追加" })
        XCTAssertTrue(add.accessibilityActivate())
        RunLoop.current.run(until: Date().addingTimeInterval(1.0))
        let presented = try XCTUnwrap(host.presentedViewController, "the emoji picker")
        var labels: [String] = []
        func walk(_ element: NSObject, depth: Int) {
            guard depth < 25, labels.count < 400 else { return }
            if element.isAccessibilityElement, let label = element.accessibilityLabel { labels.append(label) }
            let count = element.accessibilityElementCount()
            guard count > 0, count != NSNotFound else { return }
            for index in 0..<count { if let child = element.accessibilityElement(at: index) as? NSObject { walk(child, depth: depth + 1) } }
        }
        walk(presented.view, depth: 0)
        XCTAssertFalse(labels.contains("スレッドで返信"), "the picker, not the action sheet: \(labels.prefix(20))")
    }

    func testAnUnsentMessageHasNoActions() {
        let (_, elements) = elements(MessageRow(message: message(pending: true), controller: controller()))
        XCTAssertFalse(elements.isEmpty)
        for element in elements { XCTAssertEqual(element.accessibilityCustomActions?.map(\.name) ?? [], [], element.accessibilityLabel ?? "") }
        XCTAssertFalse(elements.contains { $0.accessibilityLabel == "リアクションを追加" })
    }
}
