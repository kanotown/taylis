import SwiftUI
import UIKit

/// Issue #1 (MOBILE_UI.md §5.1): the phone's horizontal swipe between a conversation and the list, as in Slack.
/// - Back (a right swipe from anywhere on a conversation or a thread) is UIKit's own from iOS 26: the navigation's
///   content swipe (`interactiveContentPopGestureRecognizer`), which follows the finger, fails over a horizontal scroller
///   and slides the keyboard away with the page (KeyboardBehavior.swift). Before iOS 26 only the edge swipe exists.
/// - Forward (a left swipe on a tab's root) brings back the conversation last open on that tab: the conversation's page
///   follows the finger in from the right over the dimmed list, and is pushed without an animation where it lands.
/// Both follow 「スワイプで戻る・進む」 (自分 → 表示, on by default); the edge swipe back always stays.
/// The pure parts (tested in SwipeNavTests): direction, release, where it goes, the remembered conversations.
enum SwipeNav {
    /// `@AppStorage` key of the setting (true by default).
    static let settingKey = "swipeNavigation"

    /// The steepest drag still taken as horizontal: tan 30°.
    static let maxSlope: CGFloat = 0.577
    /// How far (a fraction of the width) a slow drag has to go to complete.
    static let completeFraction: CGFloat = 0.4
    /// A fling at least this fast (pt/s) toward the end completes (away from it: cancels) wherever it is.
    static let flingSpeed: CGFloat = 700
    /// The dim over the list when the incoming page covers it.
    static let maxScrim: Double = 0.18

    enum Decision: Equatable { case undecided, back, forward, reject }

    /// A drag (pt, from where the finger went down): undecided within the slop; vertical or nowhere to go: rejected;
    /// clearly horizontal (≤ 30°): back to the right, forward to the left.
    static func decide(dx: CGFloat, dy: CGFloat, slop: CGFloat = 10, canBack: Bool, canForward: Bool) -> Decision {
        let ax = abs(dx), ay = abs(dy)
        if ax >= slop && ay <= ax * maxSlope {
            if dx > 0 { return canBack ? .back : .reject }
            return canForward ? .forward : .reject
        }
        return ay >= slop ? .reject : .undecided
    }

    /// Whether a released swipe completes: `progress` 0…1 toward the other page, `velocity` (pt/s) toward it.
    static func shouldComplete(progress: CGFloat, velocity: CGFloat, fling: CGFloat = flingSpeed) -> Bool {
        if velocity >= fling { return true }
        if velocity <= -fling { return false }
        return progress >= completeFraction
    }

    /// The incoming page's left edge (a fraction of the width) for a left drag `dx` (negative).
    static func incomingShift(dx: CGFloat, width: CGFloat) -> CGFloat {
        guard width > 0 else { return 1 }
        return min(1, max(0, 1 + dx / width))
    }

    static func scrimOpacity(shift: CGFloat) -> Double { maxScrim * Double(1 - shift) }

    /// What a left swipe brings back: on a tab's root (not 自分), the conversation last open on that tab, if the store
    /// still has it (`known`).
    static func forwardTarget(tab: MainTab, path: [MainRoute], last: [MainTab: String], known: (String) -> Bool) -> String? {
        guard tab != .you, path.isEmpty, let id = last[tab], known(id) else { return nil }
        return id
    }

    /// The conversation a stack shows (the last on it).
    static func conversation(_ path: [MainRoute]) -> String? {
        for route in path.reversed() { if case .channel(let id) = route { return id } }
        return nil
    }

    /// The conversations left on each tab (closed, back to a list): a tab's that closed is its newest.
    static func noteLeft(_ last: [MainTab: String], previous: [MainTab: [MainRoute]], next: [MainTab: [MainRoute]]) -> [MainTab: String] {
        var result = last
        for tab in [MainTab.home, .dms, .activity, .you] {
            guard let was = conversation(previous[tab] ?? []) else { continue }
            if conversation(next[tab] ?? []) == nil { result[tab] = was }
        }
        return result
    }
}

/// Issue #1: a left swipe on a tab's root under way, its conversation coming in from the right.
struct ForwardSwipe: Equatable {
    let tab: MainTab
    let channelId: String
    /// The incoming page's left edge, a fraction of the width (1: off screen, 0: covering the list).
    var shift: CGFloat = 1
}

/// Issue #1: the conversation's page as it comes in (its bar and an empty timeline), over the list until it is pushed.
struct ForwardSwipePage: View {
    let title: String

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Image(systemName: "chevron.left").font(.title3.weight(.semibold)).foregroundStyle(.tint)
                Text(title).font(.headline).lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 16)
            .frame(height: 44)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Color(.systemBackground))
    }
}

/// Issue #1: the left swipe's recognizer on a tab's navigation (and the iOS 26 content swipe back switched with the
/// setting). Placed as the background of the tab's root screen; it attaches to its navigation controller's view, and
/// begins only while the root is the page on screen, for a clearly horizontal left drag that no horizontal scroller
/// under the finger can take (the home's tiles). The list's vertical scroll waits for it to fail, as for UIKit's own
/// content swipe back.
struct ForwardSwipeProbe: UIViewRepresentable {
    /// Whether a left swipe has somewhere to go (the tab's last conversation, nothing presented over the screen).
    let canForward: Bool
    /// The setting: also switches the iOS 26 content swipe back of this navigation.
    let enabled: Bool
    let onChange: (CGFloat) -> Void
    let onEnd: (_ complete: Bool) -> Void

    func makeUIView(context: Context) -> Probe { Probe() }

    func updateUIView(_ view: Probe, context: Context) {
        view.canForward = canForward && enabled
        view.onChange = onChange
        view.onEnd = onEnd
        view.contentPopEnabled = enabled
    }

    static func dismantleUIView(_ view: Probe, coordinator: ()) { view.detach() }

    final class Probe: UIView, UIGestureRecognizerDelegate {
        var canForward = false
        var onChange: (CGFloat) -> Void = { _ in }
        var onEnd: (Bool) -> Void = { _ in }
        var contentPopEnabled = true { didSet { applyContentPop() } }
        private weak var navigation: UINavigationController?
        private var pan: UIPanGestureRecognizer?

        override init(frame: CGRect) {
            super.init(frame: frame)
            isUserInteractionEnabled = false
        }
        required init?(coder: NSCoder) { fatalError("not from a nib") }

        override func didMoveToWindow() {
            super.didMoveToWindow()
            guard window != nil, pan == nil, let navigation = findNavigation() else { return }
            self.navigation = navigation
            let pan = UIPanGestureRecognizer(target: self, action: #selector(panned(_:)))
            pan.delegate = self
            pan.maximumNumberOfTouches = 1
            navigation.view.addGestureRecognizer(pan)
            self.pan = pan
            applyContentPop()
        }

        func detach() {
            if let pan { pan.view?.removeGestureRecognizer(pan) }
            pan = nil
        }

        private func applyContentPop() {
            if #available(iOS 26.0, *) { navigation?.interactiveContentPopGestureRecognizer?.isEnabled = contentPopEnabled }
        }

        private func findNavigation() -> UINavigationController? {
            var responder: UIResponder? = self
            while let current = responder {
                if let controller = current as? UIViewController, let navigation = controller.navigationController { return navigation }
                responder = current.next
            }
            return nil
        }

        override func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool {
            guard recognizer === pan else { return super.gestureRecognizerShouldBegin(recognizer) }
            guard let pan, canForward, let navigation, navigation.viewControllers.count == 1,
                  navigation.presentedViewController == nil else { return false }
            let velocity = pan.velocity(in: navigation.view)
            let translation = pan.translation(in: navigation.view)
            // The direction from the velocity (the translation is only the few points of the recognizer's hysteresis).
            let dx = translation.x == 0 ? velocity.x : translation.x
            let dy = translation.x == 0 ? velocity.y : translation.y
            guard SwipeNav.decide(dx: dx, dy: dy, slop: 0, canBack: false, canForward: true) == .forward else { return false }
            return !horizontalScrollerTakes(at: pan.location(in: navigation.view), in: navigation.view)
        }

        /// A scroll view under the finger that can still scroll its content to the left (the home's tiles row).
        private func horizontalScrollerTakes(at point: CGPoint, in root: UIView) -> Bool {
            var view = root.hitTest(point, with: nil)
            while let current = view, current !== root {
                if let scroll = current as? UIScrollView, scroll.isScrollEnabled,
                   scroll.contentSize.width > scroll.bounds.width + 1,
                   scroll.contentOffset.x < scroll.contentSize.width - scroll.bounds.width + scroll.adjustedContentInset.right - 1 {
                    return true
                }
                view = current.superview
            }
            return false
        }

        /// The list's vertical scroll waits for this swipe to fail (it fails at once for a vertical drag).
        func gestureRecognizer(_ recognizer: UIGestureRecognizer, shouldBeRequiredToFailBy other: UIGestureRecognizer) -> Bool {
            guard let scroll = other.view as? UIScrollView, other === scroll.panGestureRecognizer else { return false }
            return scroll.contentSize.width <= scroll.bounds.width + 1
        }

        @objc private func panned(_ pan: UIPanGestureRecognizer) {
            guard let view = pan.view else { return }
            let width = view.bounds.width
            let dx = min(0, pan.translation(in: view).x)
            switch pan.state {
            case .began, .changed:
                onChange(SwipeNav.incomingShift(dx: dx, width: width))
            case .ended:
                let shift = SwipeNav.incomingShift(dx: dx, width: width)
                onEnd(SwipeNav.shouldComplete(progress: 1 - shift, velocity: -pan.velocity(in: view).x))
            case .cancelled, .failed:
                onEnd(false)
            default:
                break
            }
        }
    }
}
