import SwiftUI
import UIKit
import XCTest
@testable import ChikuwaChat

/// M25: VoiceOver reaches a message's action sheet (it has no long press), and the 「＋」 chip after its reactions.
/// The conversation presents what a row asks for (MessageSheet), also what the action sheet's choice leads to, and the
/// editor waits for its save (C4). SwiftUI builds its accessibility elements only while assistive technology is on, so
/// the test turns it on the way the accessibility snapshot tools do; it is skipped where that switch is missing.
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

    private func message(pending: Bool = false, mine: Bool = false) -> MessageState {
        var message = MessageState(placeholderFor: "k1", channelId: "c1", senderId: pending || mine ? "me" : "u2", body: "見てください https://example.com/page",
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

    /// A row in a conversation that presents what it asks for, as ChannelView and ThreadView do.
    private struct Conversation: View {
        let message: MessageState
        let controller: AppController
        @State private var sheet: MessageSheet?

        var body: some View {
            VStack {
                MessageRow(message: message, controller: controller, highlighted: sheet?.kind == .actions, present: { sheet = $0 })
                Spacer()
            }
            .padding()
            .messageSheets(controller, sheet: $sheet, openThread: { _ in })
        }
    }

    /// `view` rendered in the test host's window.
    private func render(_ view: some View, height: CGFloat = 400) -> UIViewController {
        let size = CGSize(width: 393, height: height)
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        let window = scene.map { UIWindow(windowScene: $0) } ?? UIWindow(frame: CGRect(origin: .zero, size: size))
        window.frame = CGRect(origin: .zero, size: size)
        let host = UIHostingController(rootView: view)
        window.rootViewController = host
        window.makeKeyAndVisible()
        self.window = window
        host.view.frame = window.bounds
        host.view.layoutIfNeeded()
        RunLoop.current.run(until: Date().addingTimeInterval(0.5))
        return host
    }

    /// The accessibility elements under `view` (a sheet's navigation bar is UIKit's: its views are walked too).
    private func accessibilityElements(_ view: UIView, depth limit: Int = 20) -> [NSObject] {
        var found: [NSObject] = []
        func walk(_ element: NSObject, depth: Int) {
            guard depth < limit, found.count < 400 else { return }
            if element.isAccessibilityElement { found.append(element) }
            let count = element.accessibilityElementCount()
            if count > 0, count != NSNotFound {
                for index in 0..<count { if let child = element.accessibilityElement(at: index) as? NSObject { walk(child, depth: depth + 1) } }
            } else if let view = element as? UIView, !element.isAccessibilityElement {
                for child in view.subviews { walk(child, depth: depth + 1) }
            }
        }
        walk(view, depth: 0)
        return found
    }

    /// The row's accessibility elements, rendered in the test host's window.
    private func elements(_ message: MessageState, _ controller: AppController) -> (host: UIViewController, elements: [NSObject]) {
        let host = render(Conversation(message: message, controller: controller))
        return (host, accessibilityElements(host.view))
    }

    func testEveryElementOfAMessageOffersItsActionsAndKeepsItsOwn() throws {
        let controller = controller()
        let (host, elements) = elements(message(), controller)
        let labels = elements.compactMap(\.accessibilityLabel)
        XCTAssertTrue(labels.contains("Toru"), "\(labels)")
        XCTAssertTrue(labels.contains { $0.contains("見てください") }, "\(labels)")
        for element in elements {
            // M28d: the profile too (the avatar and the name take taps VoiceOver cannot make).
            XCTAssertEqual(Set(element.accessibilityCustomActions?.map(\.name) ?? []), ["メッセージの操作", "プロフィール"], element.accessibilityLabel ?? "")
        }
        // The reaction and the 「＋」 chip after it stay buttons of their own. Review v0.1.37: the chip says what it is
        // in the UI language (unit tests run in Japanese), and that it is mine.
        let reaction = try XCTUnwrap(elements.first { $0.accessibilityLabel == "👍、2 人がリアクション" }, "\(labels)")
        XCTAssertTrue(reaction.accessibilityTraits.contains(.button))
        XCTAssertTrue(reaction.accessibilityTraits.contains(.selected)) // "me" is among its people
        let add = try XCTUnwrap(elements.first { $0.accessibilityLabel == "リアクションを追加" })
        XCTAssertTrue(add.accessibilityTraits.contains(.button))

        // The action opens the long-press sheet: the six quick reactions and the list of actions.
        let action = try XCTUnwrap(elements.first?.accessibilityCustomActions?.first { $0.name == "メッセージの操作" })
        XCTAssertTrue(action.actionHandler?(action) ?? false)
        RunLoop.current.run(until: Date().addingTimeInterval(1.0))
        XCTAssertNotNil(host.presentedViewController, "the action sheet")
    }

    func testThePlusChipOpensTheEmojiPicker() throws {
        let (host, elements) = elements(message(), controller())
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

    /// 編集 in the action sheet: the editor comes once the sheet is gone, from the conversation.
    func testEditInTheActionSheetOpensTheEditorOnceTheSheetIsGone() throws {
        let (host, elements) = elements(message(mine: true), controller())
        let action = try XCTUnwrap(elements.first?.accessibilityCustomActions?.first { $0.name == "メッセージの操作" })
        XCTAssertTrue(action.actionHandler?(action) ?? false)
        RunLoop.current.run(until: Date().addingTimeInterval(1.0))
        let sheet = try XCTUnwrap(host.presentedViewController, "the action sheet")
        let inSheet = accessibilityElements(sheet.view, depth: 40)
        let edit = try XCTUnwrap(inSheet.first { $0.accessibilityLabel == "編集" }, "\(inSheet.compactMap(\.accessibilityLabel))")
        XCTAssertTrue(edit.accessibilityActivate())
        RunLoop.current.run(until: Date().addingTimeInterval(2.0))
        let editor = try XCTUnwrap(host.presentedViewController, "the editor")
        XCTAssertFalse(editor === sheet)
        let found = accessibilityElements(editor.view, depth: 40)
        XCTAssertTrue(found.contains { ($0.accessibilityValue ?? "").contains("見てください") }, "\(found.compactMap(\.accessibilityLabel))")
    }

    /// C4: a save that fails keeps the editor, its text and the reason; one that goes through closes it.
    func testTheEditorStaysOpenUntilTheSaveGoesThrough() throws {
        final class Server {
            var answers: [String?] = ["ネットワークに接続できません", nil]
            var saved: [String] = []
        }
        struct Host: View {
            let server: Server
            @State private var editing = true
            var body: some View {
                Color.clear.sheet(isPresented: $editing) {
                    EditMessageView(initial: "直す前の本文") { body in
                        server.saved.append(body)
                        return server.answers.removeFirst()
                    }
                }
            }
        }
        let server = Server()
        let host = render(Host(server: server), height: 800)
        RunLoop.current.run(until: Date().addingTimeInterval(1.0))
        let editor = try XCTUnwrap(host.presentedViewController, "the editor")
        let before = accessibilityElements(editor.view, depth: 40)
        let save = try XCTUnwrap(before.first { $0.accessibilityLabel == "保存" }, "\(before.compactMap(\.accessibilityLabel))")
        XCTAssertTrue(save.accessibilityActivate())
        RunLoop.current.run(until: Date().addingTimeInterval(1.5))
        XCTAssertTrue(host.presentedViewController === editor, "still open after the failure")
        let after = accessibilityElements(editor.view, depth: 40)
        XCTAssertTrue(after.contains { ($0.accessibilityLabel ?? "").contains("ネットワークに接続できません") }, "\(after.compactMap(\.accessibilityLabel))")
        XCTAssertTrue(after.contains { ($0.accessibilityValue ?? "").contains("直す前の本文") }, "the text is kept")

        let again = try XCTUnwrap(after.first { $0.accessibilityLabel == "保存" })
        XCTAssertTrue(again.accessibilityActivate())
        RunLoop.current.run(until: Date().addingTimeInterval(2.0))
        XCTAssertNil(host.presentedViewController, "closed once saved")
        XCTAssertEqual(server.saved, ["直す前の本文", "直す前の本文"])
    }

    func testAnUnsentMessageHasNoActions() {
        let (_, elements) = elements(message(pending: true), controller())
        XCTAssertFalse(elements.isEmpty)
        for element in elements { XCTAssertEqual(element.accessibilityCustomActions?.map(\.name) ?? [], [], element.accessibilityLabel ?? "") }
        XCTAssertFalse(elements.contains { $0.accessibilityLabel == "リアクションを追加" })
    }

    /// docs/EMOJI.md §9.3: the picker is one list; a category's tab jumps to its section (and is the selected one), a
    /// header per section, each emoji by its shortcode.
    func testEmojiPickerTabJumpsToItsSection() throws {
        let host = render(EmojiPickerView { _ in }, height: 852)
        func scrollViews(_ view: UIView) -> [UIScrollView] { ((view as? UIScrollView).map { [$0] } ?? []) + view.subviews.flatMap(scrollViews) }
        let list = try XCTUnwrap(scrollViews(host.view).first { $0.contentSize.height > 2000 }, "the list")
        XCTAssertEqual(list.contentOffset.y, 0, accuracy: 1, "opens at the top")
        var found = accessibilityElements(host.view, depth: 60)
        XCTAssertTrue(found.contains { $0.accessibilityLabel == "顔" && $0.accessibilityTraits.contains(.header) })
        XCTAssertTrue(found.contains { $0.accessibilityLabel == ":grinning:" })
        let food = try XCTUnwrap(found.first { $0.accessibilityLabel == "食べ物" && $0.accessibilityTraits.contains(.button) })
        XCTAssertTrue(food.accessibilityActivate())
        RunLoop.current.run(until: Date().addingTimeInterval(1.0))
        XCTAssertGreaterThan(list.contentOffset.y, 1000)
        found = accessibilityElements(host.view, depth: 60)
        XCTAssertTrue(found.contains { $0.accessibilityLabel == "食べ物" && $0.accessibilityTraits.contains(.header) })
        XCTAssertTrue(found.contains { $0.accessibilityLabel == ":grapes:" })
        let tab = try XCTUnwrap(found.first { $0.accessibilityLabel == "食べ物" && $0.accessibilityTraits.contains(.button) })
        XCTAssertTrue(tab.accessibilityTraits.contains(.selected))
    }
}
