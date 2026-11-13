import UIKit
import XCTest
@testable import ChikuwaChat

/// PUSH_NOTIFICATIONS.md §9 「通知タップ」 (2026-11-13): a tap shows what it was about. What is presented over the
/// screens is closed first (a swipe-proof presentation stays, with what is under it), and a tap that launched the app
/// opens the same screen as a tap on a running app (it opened only the conversation: a reply's thread was lost).
@MainActor
final class NotificationTapTests: XCTestCase {
    override func tearDown() {
        let push = PushCenter.shared
        push.pendingChannelId = nil
        push.pendingParentId = nil
        push.pendingCalendar = false
        push.pendingPage = nil
        super.tearDown()
    }

    /// AppController.boot hands the tap that launched the app to this too.
    func testATapOpensItsWholeTarget() async {
        let controller = AppController(defaults: UserDefaults(suiteName: "NotificationTapTests.\(UUID().uuidString)")!)
        let push = PushCenter.shared

        // A thread reply: its conversation and its thread.
        await controller.openNotificationTarget(PushPayload(userInfo: [
            "kind": "message", "channel_id": "c1", "message_id": "m2", "parent_id": "p1",
        ]))
        XCTAssertEqual(push.pendingChannelId, "c1")
        XCTAssertEqual(push.pendingParentId, "p1")

        // A page has no conversation: the page.
        push.pendingChannelId = nil
        push.pendingParentId = nil
        await controller.openNotificationTarget(PushPayload(userInfo: ["kind": "page", "page_id": "pg1"]))
        XCTAssertEqual(push.pendingPage, "pg1")
        XCTAssertNil(push.pendingChannelId)

        // A calendar alarm: the event over the calendar, not its channel's conversation.
        await controller.openNotificationTarget(PushPayload(userInfo: ["kind": "calendar", "event_id": "e1", "channel_id": "c2"]))
        XCTAssertEqual(controller.calendarOpen?.eventId, "e1")
        XCTAssertTrue(push.pendingCalendar)
        XCTAssertNil(push.pendingChannelId)
    }

    func testWhatATapCloses() throws {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        let window = scene.map { UIWindow(windowScene: $0) } ?? UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        let root = UIViewController()
        window.rootViewController = root
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        XCTAssertNil(ScreenCovers.dismissPoint(root)) // nothing over the screens

        // A sheet with a message's menu over it: both go, from the root.
        let sheet = UIViewController()
        root.present(sheet, animated: false)
        settle { sheet.view.window != nil }
        let menu = UIViewController()
        sheet.present(menu, animated: false)
        settle { menu.view.window != nil }
        XCTAssertTrue(ScreenCovers.dismissPoint(root) === root)

        // The sheet is saving (`interactiveDismissDisabled`): only the menu over it goes.
        sheet.isModalInPresentation = true
        XCTAssertTrue(ScreenCovers.dismissPoint(root) === sheet)
        sheet.isModalInPresentation = false
        let refusing = Refusing()
        sheet.presentationController?.delegate = refusing
        XCTAssertTrue(ScreenCovers.dismissPoint(root) === sheet)
        sheet.presentationController?.delegate = nil

        // The top one may not be swiped away: nothing over it, so nothing is closed.
        menu.isModalInPresentation = true
        XCTAssertNil(ScreenCovers.dismissPoint(root))
        menu.isModalInPresentation = false

        ScreenCovers.dismissPoint(root)?.dismiss(animated: false)
        settle { root.presentedViewController == nil }
    }

    /// A sheet whose swipe down is refused (SwiftUI's `interactiveDismissDisabled` may answer through the delegate).
    private final class Refusing: NSObject, UIAdaptivePresentationControllerDelegate {
        func presentationControllerShouldDismiss(_ presentationController: UIPresentationController) -> Bool { false }
    }

    /// Runs the main loop until the presentation has got where `done` says (at most 2 s).
    private func settle(_ done: () -> Bool) {
        let deadline = Date().addingTimeInterval(2)
        while !done() && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.05)) }
        XCTAssertTrue(done())
    }
}
