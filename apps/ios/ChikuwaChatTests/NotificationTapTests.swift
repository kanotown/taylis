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
        push.pendingActivity = false
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

    /// M192 (PUSH_NOTIFICATIONS.md §18): the summary of what a pause held back has no conversation: it opens 「アクティビティ」,
    /// on the phone's tab (at its first screen) or alone in the split's detail column; with the app open it shows.
    func testTheSummaryAfterAPauseOpensTheActivity() async throws {
        let controller = AppController(defaults: UserDefaults(suiteName: "NotificationTapTests.\(UUID().uuidString)")!)
        let push = PushCenter.shared
        let digest = PushPayload(userInfo: ["kind": "digest", "workspace_id": "w", "aps": ["badge": 3]])
        XCTAssertTrue(digest.opensActivity)
        XCTAssertFalse(digest.opensLending || digest.opensReservations || digest.opensMessage)
        XCTAssertFalse(PushPayload(userInfo: ["kind": "message", "channel_id": "c1"]).opensActivity)
        XCTAssertTrue(Workspaces.shouldPresent(digest, target: nil, active: nil, openChannelId: "c1"))

        push.pendingChannelId = "c9"
        await controller.openNotificationTarget(digest)
        XCTAssertTrue(push.pendingActivity)
        XCTAssertNil(push.pendingChannelId)

        var nav = MainNavigation()
        nav.tab = .home
        nav.paths[.activity] = [.channel("c1")]
        nav.landActivity()
        XCTAssertEqual(nav.tab, .activity)
        XCTAssertEqual(nav.paths[.activity], [])
        var split = MainNavigation()
        split.layout = .split
        split.youSheet = true
        split.split = [.channel("c1")]
        split.landActivity()
        XCTAssertEqual(split.split, [.list(MainNavigation.activityId)])
        XCTAssertFalse(split.youSheet)

        // The setting: UserMe carries it from M192 on (the switch is hidden for an older server).
        let base = #""id":"u1","username":"kano","display_name":"Kano","role":"member","deactivated_at":null,"created_at":"","updated_at":"","email":null,"must_change_password":false"#
        XCTAssertNil(try JSON.snakeDecoder.decode(UserMe.self, from: Data("{\(base)}".utf8)).notifyDigest)
        let off = try JSON.snakeDecoder.decode(UserMe.self, from: Data("{\(base),\"notify_digest\":false}".utf8))
        XCTAssertEqual(off.notifyDigest, false)
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
