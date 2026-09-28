import UIKit
import XCTest
@testable import ChikuwaChat

/// §10: rows under a presentation (a sheet over the timeline, MainView's search over the conversation behind it) are
/// not looked at, whichever controller presented it; a timeline inside the top sheet is.
@MainActor
final class CoverProbeTests: XCTestCase {
    func testAViewUnderAPresentationIsCovered() throws {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        let window = scene.map { UIWindow(windowScene: $0) } ?? UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        let root = UIViewController()
        window.rootViewController = root
        window.makeKeyAndVisible()
        defer { window.isHidden = true }

        let behind = CoverProbe()
        XCTAssertTrue(behind.covered) // not on screen yet
        let timeline = UIView()
        root.view.addSubview(timeline)
        behind.view = timeline
        XCTAssertFalse(behind.covered)

        let child = UIViewController() // a split view's column presents on behalf of the root
        root.addChild(child)
        root.view.addSubview(child.view)
        child.didMove(toParent: root)
        let sheet = UIViewController()
        child.present(sheet, animated: false)
        XCTAssertTrue(behind.covered) // from the start of the presentation
        settle { sheet.view.window != nil }

        let inSheet = CoverProbe()
        let sheetTimeline = UIView()
        sheet.view.addSubview(sheetTimeline)
        inSheet.view = sheetTimeline
        XCTAssertFalse(inSheet.covered)
        let menuSheet = UIViewController()
        sheet.present(menuSheet, animated: false)
        settle { menuSheet.view.window != nil }
        XCTAssertTrue(inSheet.covered)
        XCTAssertTrue(behind.covered)

        root.dismiss(animated: false) // the whole stack
        settle { root.presentedViewController == nil }
        XCTAssertFalse(behind.covered)
    }

    /// Runs the main loop until the presentation has got where `done` says (at most 2 s).
    private func settle(_ done: () -> Bool) {
        let deadline = Date().addingTimeInterval(2)
        while !done() && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.05)) }
        XCTAssertTrue(done())
    }
}
