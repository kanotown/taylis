import SwiftUI
import UIKit
import XCTest
@testable import ChikuwaChat

@MainActor
@Observable
private final class ScrollProbeModel {
    var rows = [29, 30]
    var target: Int?
    var userScrolls = 0
}

/// A list like ThreadView's: rows at the bottom, `onUserScroll` counting what it reports.
private struct ScrollProbe: View {
    let model: ScrollProbeModel

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 12) {
                    ForEach(model.rows, id: \.self) { row in
                        Text("reply \(row)").frame(maxWidth: .infinity, minHeight: 90).id(row)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
            }
            .onUserScroll { model.userScrolls += 1 }
            .defaultScrollAnchor(.bottom)
            .onChange(of: model.target) { _, target in
                if let target { withAnimation { proxy.scrollTo(target, anchor: .top) } }
            }
        }
    }
}

/// V50 / §10.2: "the reader scrolled" is the reader's input only. The list moving by itself (replies inserted above,
/// the placement's own scroll, the viewport shrinking for the keyboard, a programmatic offset) is not, or a thread would
/// skip its one-time placement at the first unread reply and never mark read.
@MainActor
final class UserScrollTests: XCTestCase {
    private func spin(_ seconds: TimeInterval) { RunLoop.current.run(until: Date().addingTimeInterval(seconds)) }

    private func scrollView(in view: UIView) -> UIScrollView? {
        if let scroll = view as? UIScrollView { return scroll }
        for child in view.subviews { if let found = scrollView(in: child) { return found } }
        return nil
    }

    func testTheListMovingByItselfIsNotTheReaderScrolling() throws {
        let model = ScrollProbeModel()
        let size = CGSize(width: 393, height: 700)
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        let window = scene.map { UIWindow(windowScene: $0) } ?? UIWindow(frame: CGRect(origin: .zero, size: size))
        window.frame = CGRect(origin: .zero, size: size)
        let host = UIHostingController(rootView: ScrollProbe(model: model))
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        host.view.frame = window.bounds
        host.view.layoutIfNeeded()
        spin(0.3)

        model.rows = Array(1...30) // the other 28 replies arrive above the live ones
        spin(0.3)
        model.target = 11 // the placement scrolls the first unread reply to the top
        spin(0.6)
        window.frame = CGRect(origin: .zero, size: CGSize(width: size.width, height: 360)) // the keyboard
        host.view.frame = window.bounds
        host.view.layoutIfNeeded()
        spin(0.3)
        let scroll = try XCTUnwrap(scrollView(in: host.view))
        let before = scroll.contentOffset.y
        scroll.setContentOffset(.zero, animated: true) // UIKit-driven motion, animated and not
        spin(0.6)
        scroll.setContentOffset(.zero, animated: false)
        spin(0.3)
        XCTAssertLessThan(scroll.contentOffset.y, before - 100) // it did move (LazyVStack re-estimates heights on the way)
        XCTAssertEqual(model.userScrolls, 0)
    }
}
