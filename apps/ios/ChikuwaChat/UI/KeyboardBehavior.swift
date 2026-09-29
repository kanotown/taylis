import SwiftUI
import UIKit

/// How a conversation (a channel or a thread) lives with the keyboard, as in Slack and Messages:
/// - when the list's height changes (the keyboard coming or going, the input growing to several lines, the typing
///   line, the candidate row of a Japanese keyboard) its bottom edge stays: at the end of the conversation the newest
///   messages stay just above the input instead of going behind it, and higher up the row that was just above the
///   input stays there (`keepsBottomOnResize`); at the end, rows growing (a reaction, an image) keep the end in view;
/// - a tap on the list closes the keyboard (`dismissesKeyboardOnTap`); dragging the list down closes it too
///   (`.scrollDismissesKeyboard(.interactively)`).
/// A swipe back is left to UIKit, which slides the keyboard away with the screen: closing it as the swipe starts
/// removed the keyboard's room at once while UIKit kept the keyboard on screen, and the input went behind it.
enum KeyboardBehavior {
    static func dismiss() {
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }

    /// How far the end of the content is below the list's bottom edge, from SwiftUI's scroll geometry: the offset
    /// counts from under the navigation bar (the top inset), the container height leaves that part out.
    static func distanceToEnd(contentHeight: CGFloat, insets: EdgeInsets, offset: CGFloat, containerHeight: CGFloat) -> CGFloat {
        contentHeight + insets.bottom - (offset + insets.top + containerHeight)
    }

    /// The lists end with a few points of padding: this close to the end, the reader is at the end.
    static let nearEnd: CGFloat = 40

    /// Away from the end: the row to put back at the bottom edge, the last one shown in full above it (row frames in
    /// the list's visible coordinates, 0 at its top; `height` is the list's height before the change).
    static func rowAtBottomEdge(_ frames: [String: CGRect], height: CGFloat) -> String? {
        frames.filter { $0.value.minY >= 0 && $0.value.maxY <= height + 0.5 }.max { $0.value.maxY < $1.value.maxY }?.key
    }

    /// Well past the end (`distanceToEnd`) is not a place a reader can be but a layout in passing (LazyVStack
    /// re-estimating its rows reports the content hundreds of points shorter than the offset for an update).
    static func inPassing(_ below: CGFloat) -> Bool { below < -nearEnd }

    /// iOS 18: the offset that keeps the list's bottom edge where it was when its height went from `oldHeight` to
    /// `newHeight` (`oldOffset` from before), within the content (`distanceToEnd`'s terms; the scroll view's offset is
    /// the same number).
    static func offsetKeepingBottom(oldOffset: CGFloat, oldHeight: CGFloat, newHeight: CGFloat, contentHeight: CGFloat,
                                    insets: EdgeInsets) -> CGFloat {
        let top = -insets.top
        let end = max(top, contentHeight + insets.bottom - insets.top - newHeight)
        return min(max(oldOffset + oldHeight - newHeight, top), end)
    }
}

extension View {
    /// Closes the keyboard on a tap, without taking the tap from the buttons, links and menus inside.
    func dismissesKeyboardOnTap() -> some View {
        simultaneousGesture(TapGesture().onEnded { KeyboardBehavior.dismiss() })
    }

    /// Calls `restore(oldHeight, wasAtEnd)` when the list's height changes, for the view to scroll back by a row's id:
    /// to the end when the reader was at the end, else to the row that was at the bottom edge (`rowAtBottomEdge`).
    /// Scrolling by id holds while a lazy list is still settling its rows' heights; moving the offset by the height
    /// difference did not on iOS 26. The scroll geometry from before the change says where the reader was. `atEnd` is
    /// only for iOS 17, which has no scroll geometry (there, the keyboard coming up keeps the end in view).
    /// On iOS 18 the height comes frame by frame while the keyboard moves: there the offset of the scroll view `scroller`
    /// finds follows it in the same frame, and `resizing` reports the while, for the list to suspend its own bottom anchor
    /// meanwhile (TimelineScrollAnchor).
    func keepsBottomOnResize(enabled: Bool, atEnd: Bool, scroller: ScrollViewProbe? = nil, resizing: ((Bool) -> Void)? = nil,
                             restore: @escaping (_ oldHeight: CGFloat, _ wasAtEnd: Bool) -> Void) -> some View {
        modifier(KeepsBottom(enabled: enabled, atEnd: atEnd, scroller: scroller, resizing: resizing, restore: restore))
    }
}

/// The UIScrollView behind a SwiftUI ScrollView: the first one above a marker placed in its content.
@MainActor
final class ScrollViewProbe {
    weak var view: UIView?

    var scrollView: UIScrollView? {
        var next = view?.superview
        while let current = next {
            if let scrollView = current as? UIScrollView { return scrollView }
            next = current.superview
        }
        return nil
    }

    /// Placed behind the scroll view's content.
    struct Marker: UIViewRepresentable {
        let probe: ScrollViewProbe
        func makeUIView(context: Context) -> UIView {
            let view = UIView()
            view.isUserInteractionEnabled = false
            probe.view = view
            return view
        }
        func updateUIView(_ view: UIView, context: Context) { probe.view = view }
    }
}

/// What KeepsBottom measures a change from.
private struct ListLayout {
    var offset: CGFloat
    var contentHeight: CGFloat
    var containerHeight: CGFloat
    var insets: EdgeInsets
    var below: CGFloat {
        KeyboardBehavior.distanceToEnd(contentHeight: contentHeight, insets: insets, offset: offset, containerHeight: containerHeight)
    }
}

private struct KeepsBottom: ViewModifier {
    let enabled: Bool
    let atEnd: Bool
    let scroller: ScrollViewProbe?
    let resizing: ((Bool) -> Void)?
    let restore: (CGFloat, Bool) -> Void
    /// The reader's finger is on the list, or it is still gliding: nothing scrolls it then (testers felt it catch).
    @State private var moving = false
    /// The list as it stood at the end of the last main-queue turn: a change is measured from it. Within a turn
    /// LazyVStack reports layouts in passing, its rows re-estimated (the content hundreds of points shorter or longer
    /// for one report); measured from those, the list was taken for at the end and jumped there from the middle of the
    /// conversation as the keyboard came up (iOS 18 and 26). Kept by reference: it changes on every frame of a scroll
    /// and nothing is drawn from it.
    @State private var layouts = Layouts()

    private final class Layouts {
        var turn: ListLayout?
        var latest: ListLayout?
        var ending = false
        /// When the list's height last moved: LazyVStack goes on re-estimating its rows from turn to turn meanwhile.
        var resizedAt = Date.distantPast
        /// iOS 18: the list's height is moving, and the reader was at the end when it started (the scroll back to it
        /// waits until it has settled).
        var following = false
        var endAfterResize = false
    }

    /// The end of a turn: the content grew at the end (a reaction on the last rows, an image loading) while the reader
    /// was there, and the end stays in view instead of going under the input. Not while the list's height moves.
    private func endOfTurn() {
        layouts.ending = false
        guard let now = layouts.latest, !KeyboardBehavior.inPassing(now.below) else { return }
        let before = layouts.turn
        layouts.turn = now
        guard enabled, !moving, let before, Date().timeIntervalSince(layouts.resizedAt) > 0.3,
              abs(before.containerHeight - now.containerHeight) <= 0.5 else { return }
        if now.contentHeight > before.contentHeight + 0.5, before.below <= KeyboardBehavior.nearEnd, now.below > before.below + 0.5 {
            restore(now.containerHeight, true)
        }
    }

    /// iOS 18: the list's height has not moved since `at`; a reader who was at the end is scrolled to it.
    private func resizeSettled(_ at: Date) {
        guard layouts.resizedAt == at, layouts.following else { return }
        layouts.following = false
        resizing?(false)
        let toEnd = layouts.endAfterResize
        layouts.endAfterResize = false
        guard toEnd, enabled, !moving, let height = layouts.latest?.containerHeight else { return }
        restore(height, true)
    }

    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content
            .onScrollPhaseChange { _, phase in moving = phase == .interacting || phase == .decelerating || phase == .tracking }
            .onScrollGeometryChange(for: ScrollGeometry.self, of: { $0 }) { _, geometry in
                let new = ListLayout(offset: geometry.contentOffset.y, contentHeight: geometry.contentSize.height,
                                     containerHeight: geometry.containerSize.height, insets: geometry.contentInsets)
                if let latest = layouts.latest, abs(latest.containerHeight - new.containerHeight) > 0.05 {
                    let now = Date()
                    layouts.resizedAt = now
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { resizeSettled(now) }
                }
                layouts.latest = new
                if !layouts.ending {
                    layouts.ending = true
                    DispatchQueue.main.async { endOfTurn() }
                }
                // The list's height (the keyboard, the input growing, the typing line) is followed at once.
                guard enabled, !moving, let old = layouts.turn, abs(old.containerHeight - new.containerHeight) > 0.5 else { return }
                let wasAtEnd = old.below <= KeyboardBehavior.nearEnd
                if #unavailable(iOS 26.0), let scrollView = scroller?.scrollView {
                    // iOS 18 animates the keyboard's room frame by frame, each height a change of its own here. A scroll
                    // by id on each went through LazyVStack's estimated offsets first, and the list flickered between
                    // older rows and the end while the keyboard moved (testers, 2026-09-29; smooth on iOS 27). The offset
                    // moves with the height in the same frame instead, and a reader at the end is scrolled to it once the
                    // height has settled (LazyVStack may have let go of the end's marker meanwhile). iOS 26 reports the
                    // change once and keeps the scroll by id.
                    let content = KeyboardBehavior.inPassing(new.below) ? old.contentHeight : new.contentHeight
                    let target = KeyboardBehavior.offsetKeepingBottom(oldOffset: old.offset, oldHeight: old.containerHeight,
                                                                      newHeight: new.containerHeight, contentHeight: content, insets: new.insets)
                    if abs(target - scrollView.contentOffset.y) > 0.5 { scrollView.contentOffset.y = target }
                    if !layouts.following {
                        // SwiftUI's own bottom anchor took LazyVStack's re-estimates meanwhile for the list reaching its
                        // end, and pulled it there from the middle of the conversation.
                        layouts.following = true
                        layouts.endAfterResize = wasAtEnd
                        resizing?(true)
                    }
                } else {
                    // Measured from here on: the restore's own scroll comes back as a change of offset only. Measured from
                    // the turn's start instead, a list shorter than the screen scrolled to its end, reported the height
                    // again, scrolled again… in one turn, for ever: the app froze (a channel of a few posts, the keyboard
                    // going away as a hardware keyboard took over; 2026-09-29).
                    layouts.turn?.containerHeight = new.containerHeight
                    // A list that fits has no end to keep: the bottom anchor sets it (the larger content: a layout in
                    // passing reports it shorter).
                    guard max(old.contentHeight, new.contentHeight) + new.insets.top + new.insets.bottom > new.containerHeight else { return }
                    // Growing (the keyboard going away) with the reader up in the conversation: the rows stay where they
                    // are and more of them show below. Keeping the row at the bottom edge moved every row down by the
                    // keyboard's height in one frame while the input slid down with the keyboard (testers,
                    // 2026-09-29: 「縦方向にガクッとずれる」).
                    if new.containerHeight > old.containerHeight && !wasAtEnd { return }
                    restore(old.containerHeight, wasAtEnd)
                }
            }
        } else {
            // iOS 17: the keyboard coming up at least keeps the newest message in view.
            content.onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
                guard enabled, atEnd else { return }
                DispatchQueue.main.async { withAnimation(.easeOut(duration: 0.25)) { restore(0, true) } }
            }
        }
    }
}

extension View {
    /// Swiping back from a conversation with the keyboard up (testers, 2026-09-29): while the pop followed the finger the
    /// conversation lost the keyboard's room, so the input went under the keyboard and the messages slid down with the
    /// finger, and a swipe let go half way put them back in one frame. Until the swipe has settled, the conversation
    /// keeps its bottom edge where it was (the keyboard's top); the keyboard itself stays, as UIKit leaves it.
    func keepsKeyboardRoomWhileSwipingBack() -> some View { modifier(KeyboardRoomDuringBackSwipe()) }
}

private struct KeyboardRoomDuringBackSwipe: ViewModifier {
    /// The distance from the screen's bottom to the conversation's while a swipe back is under way.
    @State private var held: CGFloat?

    func body(content: Content) -> some View {
        content
            .background(BackSwipeWatcher { held = $0 })
            .padding(.bottom, held ?? 0)
            // The same modifiers either way, so the conversation keeps its identity (and its scroll position).
            .ignoresSafeArea(held == nil ? [] : .all, edges: .bottom)
    }
}

/// Watches the navigation's swipe-back gestures (the edge, and from iOS 26 the content) from a view laid out like the
/// conversation. It reports how far the conversation's bottom is from the screen's as a swipe starts with the keyboard up,
/// and nil once the swipe has settled either way.
private struct BackSwipeWatcher: UIViewRepresentable {
    let onChange: (CGFloat?) -> Void

    func makeUIView(context: Context) -> Probe { Probe() }
    func updateUIView(_ view: Probe, context: Context) { view.onChange = onChange }
    static func dismantleUIView(_ view: Probe, coordinator: ()) { view.detach() }

    final class Probe: UIView {
        var onChange: (CGFloat?) -> Void = { _ in }
        private var recognizers: [UIGestureRecognizer] = []
        private var holding = false

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

