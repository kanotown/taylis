import SwiftUI
import UIKit

/// How a conversation (a channel or a thread) lives with the keyboard, as in Slack and Messages:
/// - the list's bottom edge stays as its height changes (the keyboard, the input growing, the typing line, a Japanese
///   keyboard's candidate row) because the list is upside down (UpsideDownList.swift, M36): nothing here moves it;
/// - a tap on the list closes the keyboard (`dismissesKeyboardOnTap`), and does nothing else: not on a message (which a
///   tap otherwise opens the thread of), nor on its avatar, name, reactions, links or attachments (`TapsWaitForKeyboard`);
///   a long press still opens the message's actions. Dragging the list closes it too (`conversationDismissesKeyboard`).
/// A swipe back is left to UIKit, which slides the keyboard away with the screen: closing it as the swipe starts
/// removed the keyboard's room at once while UIKit kept the keyboard on screen, and the input went behind it.
enum KeyboardBehavior {
    static func dismiss() {
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }

    /// Whether the keyboard is up (a hardware keyboard's bar included), from its coming until it has gone: the swipe
    /// back keeps its room meanwhile (`keepsKeyboardRoomWhileSwipingBack`). The rows' taps follow `SoftKeyboard`.
    private(set) static var isUp = false
    private static var observers: [NSObjectProtocol] = []

    /// Follows the keyboard from the app's start (`isUp`, `SoftKeyboard`).
    static func watch() {
        guard observers.isEmpty else { return }
        let center = NotificationCenter.default
        let soft = SoftKeyboard.shared
        observers = [
            center.addObserver(forName: UIResponder.keyboardWillShowNotification, object: nil, queue: .main) { note in
                isUp = true
                soft.willChange(to: note)
            },
            center.addObserver(forName: UIResponder.keyboardWillChangeFrameNotification, object: nil, queue: .main) { soft.willChange(to: $0) },
            center.addObserver(forName: UIResponder.keyboardDidChangeFrameNotification, object: nil, queue: .main) { soft.didChange(to: $0) },
            center.addObserver(forName: UIResponder.keyboardDidHideNotification, object: nil, queue: .main) { _ in
                isUp = false
                soft.didHide()
            },
        ]
    }
}

/// Whether the on-screen keyboard is up, from its coming until it has gone, for the views that redraw with it
/// (`TapsWaitForKeyboard`). Unlike `KeyboardBehavior.isUp` it stays false with a hardware keyboard: an iPad's keyboard
/// shows only its shortcut bar then (some 55–70 pt), and a tap on the list has no keyboard to close first, so it acts.
@Observable
final class SoftKeyboard {
    static let shared = SoftKeyboard()
    private(set) var onScreen = false

    /// Taller than an iPad's shortcut bar or the candidate bar of a hardware keyboard; lower than any on-screen keyboard
    /// (an iPhone's is 216 pt and up, landscape included).
    static let minimumHeight: CGFloat = 120

    /// How much of the screen the keyboard's frame covers, from the bottom; 0 off screen (going, or a hardware keyboard).
    static func coveredHeight(frame: CGRect, screen: CGRect) -> CGFloat {
        guard !frame.isEmpty, !screen.isEmpty else { return 0 }
        return max(0, screen.intersection(frame).height)
    }

    static func isSoftKeyboard(frame: CGRect, screen: CGRect) -> Bool { coveredHeight(frame: frame, screen: screen) >= minimumHeight }

    /// Up as soon as an on-screen keyboard is on its way (before the tap that may close it).
    func willChange(to note: Notification) {
        if let up = Self.isSoftKeyboard(note), up, !onScreen { onScreen = true }
    }

    /// Down only once it has gone: the list's tap closes it as the same tap ends on the row, which must not act then.
    /// A frame that settles small (a hardware keyboard connected while it was up) puts it down too.
    func didChange(to note: Notification) {
        if let up = Self.isSoftKeyboard(note), up != onScreen { onScreen = up }
    }

    func didHide() { if onScreen { onScreen = false } }

    private static func isSoftKeyboard(_ note: Notification) -> Bool? {
        guard let frame = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue else { return nil }
        // The notification's object is the screen the keyboard is on (iOS 16+); its frame is in that screen's space.
        let screen = (note.object as? UIScreen)?.bounds ?? UIScreen.main.bounds
        return isSoftKeyboard(frame: frame, screen: screen)
    }
}

/// The row's own controls (avatar, name, reactions, links, attachments, cards, buttons) take no touch while the on-screen
/// keyboard is up: the first tap on the list only closes the keyboard (user report 2026-10-26: a tap on an avatar closed
/// the keyboard and opened the profile). Put inside the row's gestures: the row keeps its long press (the actions) and its
/// tap, which `tapped()` ignores meanwhile, and the scroll view keeps its drag and its tap that closes the keyboard. Its own
/// small view, so only it redraws when the keyboard comes and goes, not the rows' bodies.
struct TapsWaitForKeyboard: ViewModifier {
    private var keyboard = SoftKeyboard.shared

    func body(content: Content) -> some View {
        content.allowsHitTesting(!keyboard.onScreen)
    }
}

extension View {
    /// `TapsWaitForKeyboard`: no taps on what is inside while the on-screen keyboard is up.
    func tapsWaitForKeyboard() -> some View { modifier(TapsWaitForKeyboard()) }
}

extension View {
    /// Closes the keyboard on a tap, without taking the tap from the buttons, links and menus inside.
    func dismissesKeyboardOnTap() -> some View {
        simultaneousGesture(TapGesture().onEnded { KeyboardBehavior.dismiss() })
    }

    /// Dragging a conversation's list closes the keyboard: following the finger from iOS 26, as the drag starts before.
    /// On iOS 18 the interactive dismissal took the keyboard away but left the composer where it had been, floating
    /// over the empty space (a tester, iOS 18, builds 109–110, 2026-10-09); a tap, which closes the keyboard the
    /// ordinary way, brought it down every time. `.immediately` closes it that same way as the drag starts, so iOS 17
    /// and 18 never go through the interactive path. (Not reproduced: Xcode 27 has no iOS 18 simulator, and iOS 26.5
    /// and 27 bring the composer back after an interactive dismissal.)
    @ViewBuilder
    func conversationDismissesKeyboard() -> some View {
        if #available(iOS 26.0, *) {
            scrollDismissesKeyboard(.interactively)
        } else {
            scrollDismissesKeyboard(.immediately)
        }
    }

    /// The conversation's `scrollPosition(id: kept, anchor: .top)`, let go while the keyboard comes or goes. The flipped
    /// list keeps its offset from the newest edge by itself as it gets shorter or taller (UpsideDownList.swift), so the rows
    /// above the input move with it. With a kept row, SwiftUI re-anchored the list on that row at every layout of the
    /// keyboard's animation instead (iOS 18 lays the conversation out frame by frame), from the LazyVStack's estimated
    /// heights: read further up, the rows jumped by up to 1,000 pt one way and back while the keyboard moved, and came to
    /// rest with the conversation's top kept, so the rows the reader had above the input went under the keyboard, and hiding
    /// it threw them further down (iOS 18.6 simulator, 2026-10-11). Let go, the list does not move against the input at all.
    ///
    /// As the keyboard starts to move the kept row is cleared (not the newest edge's marker: its offset is 0, which no
    /// resize moves, and it is what shows arrivals there), and until the keyboard has arrived or gone the scroll view is
    /// given a position of its own, so a row SwiftUI takes from a scroll meanwhile (the drag that closes the keyboard) is
    /// not kept either; written into the conversation's state on every frame of that drag, it also ran the whole view's
    /// body each time. The row is not taken again afterwards: a kept row set from code is lined up with the anchor's edge
    /// on the next layout (a jump), while one SwiftUI takes from a scroll keeps where it is. The reader's next scroll takes
    /// one; until then an arrival keeps the rows in place by scrolling (UpsideDown.holdInPlace).
    func keptRowPosition(_ kept: Binding<String?>) -> some View { modifier(KeptRowThroughKeyboard(kept: kept)) }
}

private struct KeptRowThroughKeyboard: ViewModifier {
    @Binding var kept: String?
    /// The keyboard is on its way: from its will-change until its did-show / did-hide, a second at most (a change that
    /// posts neither).
    @State private var moving = false
    /// What the scroll view keeps while the keyboard moves, apart from the conversation's kept row.
    @State private var detached: String?

    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            // iOS 26 lays the conversation out once for the keyboard, before the notification reaches this view: letting
            // go here came after the re-anchoring and only lost the row (measured on the 26.5 simulator). Left as it was.
            content.scrollPosition(id: $kept, anchor: .top)
        } else {
            content
                .scrollPosition(id: moving ? $detached : $kept, anchor: .top)
                .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillChangeFrameNotification)) { _ in
                    if UpsideDown.letsGoForKeyboard(kept) {
                        kept = nil
                    }
                    // At the newest edge the marker stays kept, and so does the binding.
                    guard kept == nil else { return }
                    detached = nil
                    moving = true
                }
                .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardDidShowNotification)) { _ in moving = false }
                .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardDidHideNotification)) { _ in moving = false }
                .task(id: moving) {
                    guard moving else { return }
                    try? await Task.sleep(for: .seconds(1))
                    if !Task.isCancelled { moving = false }
                }
        }
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
            NotificationCenter.default.addObserver(self, selector: #selector(keyboardWillHide), name: UIResponder.keyboardWillHideNotification, object: nil)
            noteArrival(navigation)
        }

        /// The keyboard going because this page is leaving (another pushed over it from the conversation with the keyboard
        /// up: the channel's details, a thread from its reply count; or the back button): the page keeps its bottom edge
        /// where it was until it is gone. Its room went at once, not with the keyboard's motion, and the rows dropped by the
        /// keyboard's height in one frame as the page started to slide away (iOS 18.6 simulator, 2026-10-11: 302 pt).
        @objc private func keyboardWillHide() {
            if #available(iOS 26.0, *) { return } // the page leaving kept its rows there (26.5 simulator): left as it was
            guard !holding, let window, let navigation = navigationController, let coordinator = navigation.transitionCoordinator,
                  !coordinator.isInteractive, let page = page(in: navigation), coordinator.viewController(forKey: .from) === page
            else { return }
            let below = window.bounds.maxY - convert(bounds, to: window).maxY
            guard below > 100 else { return }
            holding = true
            onChange(below)
            coordinator.animate(alongsideTransition: nil) { [weak self] _ in
                DispatchQueue.main.async {
                    guard let self, self.holding else { return }
                    self.holding = false
                    self.onChange(nil)
                }
            }
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
            NotificationCenter.default.removeObserver(self, name: UIResponder.keyboardWillHideNotification, object: nil)
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

