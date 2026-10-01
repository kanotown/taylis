import SwiftUI
import UIKit

/// How a conversation (a channel or a thread) lives with the keyboard, as in Slack and Messages:
/// - the list's bottom edge stays as its height changes (the keyboard, the input growing, the typing line, a Japanese
///   keyboard's candidate row) because the list is upside down (UpsideDownList.swift, M36): nothing here moves it;
/// - a tap on the list closes the keyboard (`dismissesKeyboardOnTap`), and does nothing else on a message (which a tap
///   otherwise opens the thread of); dragging the list down closes it too (`.scrollDismissesKeyboard(.interactively)`).
/// A swipe back is left to UIKit, which slides the keyboard away with the screen: closing it as the swipe starts
/// removed the keyboard's room at once while UIKit kept the keyboard on screen, and the input went behind it.
enum KeyboardBehavior {
    static func dismiss() {
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }

    /// Whether the keyboard is up, from its coming until it has gone: a tap on a message while it is only closes it
    /// (`dismissesKeyboardOnTap`). Until it has gone, not until it starts going: the list's tap may close it before the
    /// row sees the same tap.
    private(set) static var isUp = false
    private static var observers: [NSObjectProtocol] = []

    /// Follows the keyboard from the app's start (`isUp`).
    static func watch() {
        guard observers.isEmpty else { return }
        let center = NotificationCenter.default
        observers = [
            center.addObserver(forName: UIResponder.keyboardWillShowNotification, object: nil, queue: .main) { _ in isUp = true },
            center.addObserver(forName: UIResponder.keyboardDidHideNotification, object: nil, queue: .main) { _ in isUp = false },
        ]
    }
}

extension View {
    /// Closes the keyboard on a tap, without taking the tap from the buttons, links and menus inside.
    func dismissesKeyboardOnTap() -> some View {
        simultaneousGesture(TapGesture().onEnded { KeyboardBehavior.dismiss() })
    }
}

extension View {
    /// Swiping back from a conversation with the keyboard up (testers, 2026-09-29): while the pop followed the finger the
    /// conversation lost the keyboard's room, so the input went under the keyboard and the messages slid down with the
    /// finger, and a swipe let go half way put them back in one frame. Until the swipe has settled, the conversation
    /// keeps its bottom edge where it was (the keyboard's top); the keyboard itself stays, as UIKit leaves it.
    ///
    /// The conversation the swipe goes back to (a channel under its thread) is laid out without the keyboard meanwhile:
    /// the keyboard belongs to the page leaving, and slides out with it. The channel followed the keyboard's frame
    /// instead — its input and newest messages slid down with the finger from the keyboard's top, and the rest of the
    /// way in one frame as the swipe ended (2026-10-02).
    func keepsKeyboardRoomWhileSwipingBack() -> some View { modifier(KeyboardRoomDuringBackSwipe()) }
}

private struct KeyboardRoomDuringBackSwipe: ViewModifier {
    /// The distance from the screen's bottom to the conversation's while a swipe back from it is under way.
    @State private var held: CGFloat?
    /// A swipe back to this conversation is under way, the keyboard sliding out with the page that leaves.
    @State private var arriving = false

    func body(content: Content) -> some View {
        content
            .background(BackSwipeWatcher(onChange: { held = $0 }, onArriving: { arriving = $0 }))
            .padding(.bottom, held ?? 0)
            // The same modifiers either way, so the conversation keeps its identity (and its scroll position).
            .ignoresSafeArea(held != nil ? .all : arriving ? .keyboard : [], edges: .bottom)
    }
}

/// Watches the navigation's swipe-back gestures (the edge, and from iOS 26 the content) from a view laid out like the
/// conversation. It reports how far the conversation's bottom is from the screen's as a swipe starts with the keyboard up,
/// and nil once the swipe has settled either way; and, on the conversation a swipe goes back to, whether that swipe is
/// under way with the keyboard up (`onArriving`), until it has settled and the keyboard has gone.
private struct BackSwipeWatcher: UIViewRepresentable {
    let onChange: (CGFloat?) -> Void
    let onArriving: (Bool) -> Void

    func makeUIView(context: Context) -> Probe { Probe() }
    func updateUIView(_ view: Probe, context: Context) {
        view.onChange = onChange
        view.onArriving = onArriving
    }
    static func dismantleUIView(_ view: Probe, coordinator: ()) { view.detach() }

    final class Probe: UIView {
        var onChange: (CGFloat?) -> Void = { _ in }
        var onArriving: (Bool) -> Void = { _ in }
        private var recognizers: [UIGestureRecognizer] = []
        private var holding = false
        private var arriving = false

        override init(frame: CGRect) {
            super.init(frame: frame)
            isUserInteractionEnabled = false
        }
        required init?(coder: NSCoder) { fatalError("not from a nib") }

        override func didMoveToWindow() {
            super.didMoveToWindow()
            detach()
            guard window != nil, let navigation = navigationController else { return }
            var found = [navigation.interactivePopGestureRecognizer].compactMap { $0 }
            if #available(iOS 26.0, *), let content = navigation.interactiveContentPopGestureRecognizer { found.append(content) }
            found.forEach { $0.addTarget(self, action: #selector(swiped(_:))) }
            recognizers = found
            noteArrival(navigation)
        }

        /// Back in the window because a swipe back to this page has started (the navigation puts the page under the
        /// leaving one as the pop begins): with the keyboard up, the page is laid out without it until the swipe has
        /// settled. Let go half way, the page goes again at once; carried through, it waits for the keyboard to have gone
        /// (its text field left with the other page), so the keyboard's room does not come back for a moment.
        private func noteArrival(_ navigation: UINavigationController) {
            guard !arriving, KeyboardBehavior.isUp, let coordinator = navigation.transitionCoordinator, coordinator.isInteractive,
                  let page = page(in: navigation), coordinator.viewController(forKey: .to) === page else { return }
            arriving = true
            onArriving(true)
            coordinator.animate(alongsideTransition: nil) { [weak self] context in
                let completed = !context.isCancelled // the context is not to be kept past this call
                DispatchQueue.main.async { self?.endArrival(waitForKeyboard: completed, tries: 12) }
            }
        }

        private func endArrival(waitForKeyboard: Bool, tries: Int) {
            guard arriving else { return }
            if waitForKeyboard && KeyboardBehavior.isUp && tries > 0 {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in self?.endArrival(waitForKeyboard: true, tries: tries - 1) }
                return
            }
            arriving = false
            onArriving(false)
        }

        /// The navigation's page this view is on (the hosting controller among its view controllers).
        private func page(in navigation: UINavigationController) -> UIViewController? {
            var responder: UIResponder? = self
            while let current = responder {
                if let controller = current as? UIViewController, controller.parent === navigation { return controller }
                responder = current.next
            }
            return nil
        }

        func detach() {
            recognizers.forEach { $0.removeTarget(self, action: #selector(swiped(_:))) }
            recognizers = []
        }

        @objc private func swiped(_ recognizer: UIGestureRecognizer) {
            switch recognizer.state {
            case .began:
                // Only for a pop under way (a swipe the navigation did not take held the list for nothing), and only
                // with the keyboard up (the home indicator alone is some 34 pt).
                guard let window, navigationController?.transitionCoordinator != nil else { return }
                let below = window.bounds.maxY - convert(bounds, to: window).maxY
                guard below > 100 else { return }
                holding = true
                onChange(below)
            case .ended, .cancelled, .failed:
                guard holding else { return }
                let release = { [weak self] in
                    guard let self, self.holding else { return }
                    self.holding = false
                    self.onChange(nil)
                }
                if let coordinator = navigationController?.transitionCoordinator {
                    coordinator.animate(alongsideTransition: nil) { _ in DispatchQueue.main.async(execute: release) }
                } else {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5, execute: release)
                }
            default:
                break
            }
        }

        private var navigationController: UINavigationController? {
            var responder: UIResponder? = self
            while let current = responder {
                if let controller = current as? UIViewController, let navigation = controller.navigationController { return navigation }
                responder = current.next
            }
            return nil
        }
    }
}

/// A tap on the status bar leaves a conversation where it is (testers, 2026-09-29): in a long channel it climbed to
/// the top of what was loaded, loaded older pages one after another, and the list could end up shifted. The header
/// opens the channel's details instead, as in Slack. Placed inside the scroll view's content.
struct StatusBarTapStays: UIViewRepresentable {
    func makeUIView(context: Context) -> Marker { Marker() }
    func updateUIView(_ view: Marker, context: Context) {}

    final class Marker: UIView {
        override func didMoveToWindow() {
            super.didMoveToWindow()
            isUserInteractionEnabled = false
            var next = superview
            while let current = next {
                if let scrollView = current as? UIScrollView { scrollView.scrollsToTop = false; return }
                next = current.superview
            }
        }
    }
}

