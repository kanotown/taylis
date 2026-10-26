import UIKit
import XCTest
@testable import ChikuwaChat

/// The first tap on a conversation with the on-screen keyboard up only closes it (KeyboardBehavior.swift, MOBILE_UI.md);
/// a hardware keyboard's bar is not that keyboard. And the login form's server on a fresh install.
final class KeyboardTapsTests: XCTestCase {
    private let phone = CGRect(x: 0, y: 0, width: 402, height: 874)
    private let pad = CGRect(x: 0, y: 0, width: 1032, height: 1376)

    func testAnOnScreenKeyboardCountsAndAHardwareKeyboardsBarDoesNot() {
        // iPhone 17 Pro's Japanese keyboard with its candidate row; landscape's is lower but still a keyboard.
        XCTAssertTrue(SoftKeyboard.isSoftKeyboard(frame: CGRect(x: 0, y: 874 - 336, width: 402, height: 336), screen: phone))
        XCTAssertTrue(SoftKeyboard.isSoftKeyboard(frame: CGRect(x: 0, y: 402 - 209, width: 874, height: 209),
                                                  screen: CGRect(x: 0, y: 0, width: 874, height: 402)))
        // An iPad's: the full keyboard counts; with a hardware keyboard only the shortcut bar shows (or nothing).
        XCTAssertTrue(SoftKeyboard.isSoftKeyboard(frame: CGRect(x: 0, y: 1376 - 400, width: 1032, height: 400), screen: pad))
        XCTAssertFalse(SoftKeyboard.isSoftKeyboard(frame: CGRect(x: 0, y: 1376 - 69, width: 1032, height: 69), screen: pad))
        // Going: the end frame is below the screen.
        XCTAssertFalse(SoftKeyboard.isSoftKeyboard(frame: CGRect(x: 0, y: 874, width: 402, height: 336), screen: phone))
        XCTAssertEqual(SoftKeyboard.coveredHeight(frame: CGRect(x: 0, y: 800, width: 402, height: 336), screen: phone), 74)
        XCTAssertEqual(SoftKeyboard.coveredHeight(frame: .zero, screen: phone), 0)
    }

    func testUpWhenItComesDownOnlyOnceItHasGone() {
        let keyboard = SoftKeyboard()
        let screen = UIScreen.main.bounds
        let shown = CGRect(x: 0, y: screen.maxY - 336, width: screen.width, height: 336)
        let gone = CGRect(x: 0, y: screen.maxY, width: screen.width, height: 336)
        let bar = CGRect(x: 0, y: screen.maxY - 55, width: screen.width, height: 55)
        func note(_ frame: CGRect) -> Notification {
            Notification(name: UIResponder.keyboardWillChangeFrameNotification, object: nil,
                         userInfo: [UIResponder.keyboardFrameEndUserInfoKey: NSValue(cgRect: frame)])
        }
        keyboard.willChange(to: note(shown))
        XCTAssertTrue(keyboard.onScreen)
        // The tap that closes it ends on the row while it is still going: the row must not act yet.
        keyboard.willChange(to: note(gone))
        XCTAssertTrue(keyboard.onScreen)
        keyboard.didHide()
        XCTAssertFalse(keyboard.onScreen)
        // A hardware keyboard's bar never puts it up; settling small (one connected while it was up) puts it down.
        keyboard.willChange(to: note(bar))
        XCTAssertFalse(keyboard.onScreen)
        keyboard.willChange(to: note(shown))
        keyboard.didChange(to: note(bar))
        XCTAssertFalse(keyboard.onScreen)
    }

    /// A fresh install starts the login form empty, under its placeholder (it had a developer's http://127.0.0.1:8000),
    /// and an empty server is refused with its own message.
    @MainActor
    func testTheLoginFormStartsWithoutAServerOnAFreshInstall() async {
        let name = "keyboard-taps-tests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        let fresh = AppController(defaults: defaults)
        XCTAssertEqual(fresh.loginServer, "")
        let outcome = await fresh.signIn(server: "  ", username: "a", password: "b")
        XCTAssertEqual(outcome, .failed(tr("サーバを入力してください")))

        defaults.set("https://chat.example.com", forKey: Workspaces.legacyServerKey)
        XCTAssertEqual(AppController(defaults: defaults).loginServer, "https://chat.example.com")
    }
}
