import SwiftUI
import UIKit

/// How a conversation (a channel or a thread) lives with the keyboard, as in Slack and Messages:
/// - when the list's height changes (the keyboard coming or going, the input growing to several lines, the typing
///   line, the candidate row of a Japanese keyboard) its bottom edge stays: at the end of the conversation the newest
///   messages stay just above the input instead of going behind it, and higher up the row that was just above the
///   input stays there (`keepsBottomOnResize`); at the end, rows growing (a reaction, an image) keep the end in view;
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

    /// How far the end of the content is below the list's bottom edge, from SwiftUI's scroll geometry: the offset
    /// counts from under the navigation bar (the top inset), the container height leaves that part out.
    static func distanceToEnd(contentHeight: CGFloat, insets: EdgeInsets, offset: CGFloat, containerHeight: CGFloat) -> CGFloat {
        contentHeight + insets.bottom - (offset + insets.top + containerHeight)
    }

    /// The lists end with a few points of padding: this close to the end, the reader is at the end.
    static let nearEnd: CGFloat = 40

    /// Moves the offset to `target` over the keyboard's 0.25 s, easing out, one set per frame (a display link), each
    /// set outright: an animated set is put back by SwiftUI on iOS 26 at its next layout, and a set outright holds.
    static func slide(_ scrollView: UIScrollView, to target: CGFloat, duration: TimeInterval = 0.25) {
        Slide.current?.stop()
        Slide.current = Slide(scrollView: scrollView, from: scrollView.contentOffset.y, to: target, duration: duration)
    }

    /// Slides to the end of the content, the end measured again on every frame: a row that has just come in is laid
    /// out a frame or two after the slide starts (measured once, the end fell short of it and the row stayed under the
    /// input with the keyboard up; 2026-09-29).
    static func slideToEnd(_ scrollView: UIScrollView, duration: TimeInterval = 0.3) {
        Slide.current?.stop()
        Slide.current = Slide(scrollView: scrollView, from: scrollView.contentOffset.y, to: end(of: scrollView), duration: duration,
                              target: { end(of: $0) })
    }

    /// A slide is under way (its end follows the content by itself when slideToEnd started it).
    static var isSliding: Bool { Slide.current != nil }

    /// The offset that shows the end of the content.
    static func end(of scrollView: UIScrollView) -> CGFloat {
        max(-scrollView.adjustedContentInset.top,
            scrollView.contentSize.height - scrollView.bounds.height + scrollView.adjustedContentInset.bottom)
    }

    /// Where the offset is going: a slide's destination while one runs, else the offset itself. A change measured
    /// from the middle of a slide (the tool row's, a frame after the keyboard's) lost the rest of it.
    static func settledOffset(_ scrollView: UIScrollView) -> CGFloat {
        if let slide = Slide.current, slide.scrollView === scrollView { return slide.to }
        return scrollView.contentOffset.y
    }

    private final class Slide {
        static var current: Slide?
        private(set) weak var scrollView: UIScrollView?
        private let from: CGFloat
        private(set) var to: CGFloat
        private let duration: TimeInterval
        /// Where the slide goes, asked again on each frame (slideToEnd); nil keeps `to`.
        private let target: ((UIScrollView) -> CGFloat)?
        /// The slide's own clock: each frame moves it by the time since the last one, two frames' worth at most, so a
        /// stall of the main thread (the send's own work) delays the slide instead of skipping part of it — before the
        /// first frame or after it (a stall mid-slide moved the list 26 pt in one frame, Codex's trace, 2026-09-30).
        private var elapsed: CFTimeInterval = 0
        private var lastTick: CFTimeInterval?
        private var link: CADisplayLink?

        init(scrollView: UIScrollView, from: CGFloat, to: CGFloat, duration: TimeInterval,
             target: ((UIScrollView) -> CGFloat)? = nil) {
            self.scrollView = scrollView
            self.from = from
            self.to = to
            self.duration = duration
            self.target = target
            link = CADisplayLink(target: self, selector: #selector(tick))
            link?.add(to: .main, forMode: .common)
        }

        @objc private func tick() {
            guard let scrollView else { return stop() }
            if let target { to = target(scrollView) }
            let now = CACurrentMediaTime()
            elapsed += lastTick.map { min(now - $0, 1.0 / 30) } ?? 1.0 / 60
            lastTick = now
            let t = min(1, elapsed / duration)
            let eased = 1 - pow(1 - t, 2) // ease out
            scrollView.contentOffset.y = from + (to - from) * eased
            if t >= 1 { stop() }
        }

        func stop() {
            link?.invalidate()
            link = nil
            if Slide.current === self { Slide.current = nil }
        }
    }

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

/// Where the row above the input belongs after KeepsBottom moved the list by the keyboard's height, and putting it back
/// there from its measured frame while the lazy list settles: an offset set once was undone by a content re-estimate
/// on iOS 26.2, and a scroll by the row's id went through the estimate. Measured frames are the truth.
@MainActor
final class KeyboardKept {
    private struct Row {
        let id: String
        let minY: CGFloat
        let from: Date
        let generation: Int
    }

    private var row: Row?
    private var tries = 0
    private var generation = 0
    private var frames: [String: CGRect] = [:]
    /// The list's UIScrollView and whether the reader is moving it, asked when a check runs.
    var scrollView: () -> UIScrollView? = { nil }
    var moving: () -> Bool = { false }

    /// The row's frames' `minY` should be `minY` from now on; `growing` (the keyboard going) is animated, so the checks
    /// wait for the animation. Checks run with each layout and at a few moments after: a re-estimate that undid the
    /// offset lays nothing out afterwards.
    func expect(_ id: String, minY: CGFloat, growing: Bool) {
        generation += 1
        let from = Date().addingTimeInterval(growing ? 0.3 : 0.03)
        row = Row(id: id, minY: minY, from: from, generation: generation)
        tries = 0
        let mine = generation
        for delay in [0.05, 0.12, 0.2, 0.35, 0.55, 0.8] {
            DispatchQueue.main.asyncAfter(deadline: .now() + (growing ? 0.3 : 0.03) + delay) { [weak self] in
                guard let self, self.row?.generation == mine else { return }
                self.check()
            }
        }
    }

    /// The last expectation's row and place, for the next change in the same turn (the tool row, then the keyboard),
    /// when the frames measured before the first change are the ones at hand.
    var expected: (id: String, minY: CGFloat)? { row.map { ($0.id, $0.minY) } }

    func clear() { row = nil }

    /// Each layout's row frames.
    func note(_ frames: [String: CGRect]) {
        self.frames = frames
        check()
    }

    /// Moves the list by the row's error, a few times at most, within a second of the expectation.
    private func check() {
        guard let row, let scrollView = scrollView(), !moving() else { return }
        let now = Date()
        guard now >= row.from else { return }
        guard now < row.from.addingTimeInterval(1), tries < 6, let frame = frames[row.id] else {
            self.row = nil
            return
        }
        let error = frame.minY - row.minY
        guard abs(error) > 1 else { return }
        tries += 1
        scrollView.contentOffset.y += error
    }
}

extension View {
    /// Closes the keyboard on a tap, without taking the tap from the buttons, links and menus inside.
    func dismissesKeyboardOnTap() -> some View {
        simultaneousGesture(TapGesture().onEnded { KeyboardBehavior.dismiss() })
    }

    /// Calls `restore(oldHeight, newHeight, wasAtEnd)` when the list's height changes, for the view to scroll back by a
    /// row's id: to the end when the reader was at the end, else the row last shown in full above the bottom edge
    /// (`rowAtBottomEdge`) to where it stays as far above the new bottom edge (KeyboardKept).
    /// Scrolling by id holds while a lazy list is still settling its rows' heights; moving the offset by the height
    /// difference did not on iOS 26. The scroll geometry from before the change says where the reader was. `atEnd` is
    /// only for iOS 17, which has no scroll geometry (there, the keyboard coming up keeps the end in view).
    /// On iOS 18 the height comes frame by frame while the keyboard moves: there the offset of the scroll view `scroller`
    /// finds follows it in the same frame, and `resizing` reports the while, for the list to suspend its own bottom anchor
    /// meanwhile (TimelineScrollAnchor).
    func keepsBottomOnResize(enabled: Bool, atEnd: Bool, scroller: ScrollViewProbe? = nil, resizing: ((Bool) -> Void)? = nil,
                             restore: @escaping (_ oldHeight: CGFloat, _ newHeight: CGFloat, _ wasAtEnd: Bool) -> Void) -> some View {
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
    let restore: (CGFloat, CGFloat, Bool) -> Void
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
            restore(now.containerHeight, now.containerHeight, true)
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
        restore(height, height, true)
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
                // iOS 27: a sheet presented over a conversation shorter than the screen moved its rows below the screen
                // (SwiftUI took the offset some 390 pt past the top of the content) and they stayed there, the list blank
                // after the sheet closed (a thread opened by a tap, a profile). Nobody can rest there: back to the top.
                if !moving, new.offset < -new.insets.top - 1, let scrollView = scroller?.scrollView {
                    DispatchQueue.main.async {
                        let top = -scrollView.adjustedContentInset.top
                        if scrollView.contentOffset.y < top - 1 && !scrollView.isTracking && !scrollView.isDecelerating {
                            scrollView.contentOffset.y = top
                        }
                    }
                }
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
                    let content = KeyboardBehavior.inPassing(new.below) ? old.contentHeight : new.contentHeight
                    if wasAtEnd {
                        restore(old.containerHeight, new.containerHeight, true)
                        // At the end from here on (the next change in this turn measures from the end, not from the
                        // offset the turn started with: taken for "up in the conversation" after the keyboard came,
                        // the keyboard going moved a list at its end past its end).
                        layouts.turn?.offset = max(-new.insets.top, content + new.insets.bottom - new.insets.top - new.containerHeight)
                        return
                    }
                    // Up in the conversation: the list moves by the height difference, both ways, so the row above the
                    // input stays above it and the keyboard going away puts everything back. Scrolling the last whole
                    // row to the edge moved the list by the cut row's height as the keyboard came, and nothing moved
                    // it back as the keyboard went: three show / hide cycles walked the reader 670 pt up the
                    // conversation (measured on iOS 27, 2026-09-29: 「キーボードを出すとガクッとずれる」). SwiftUI's own
                    // bottom anchor (TimelineScrollAnchor) only holds a list that is at its end, and a scroll by a
                    // row's id goes through LazyVStack's estimated offsets (on iOS 26.2 it landed at the end of the
                    // conversation). The offset, then: from the offset of now, not the turn's (the height changes
                    // twice in a turn, the composer's tool row and then the keyboard). The view puts the row back
                    // from its measured frame while the lazy list settles (KeyboardKept; an offset set once was
                    // undone by a re-estimate on iOS 26.2).
                    guard let scrollView = scroller?.scrollView else { return }
                    let base = KeyboardBehavior.settledOffset(scrollView)
                    let target = KeyboardBehavior.offsetKeepingBottom(oldOffset: base, oldHeight: old.containerHeight,
                                                                      newHeight: new.containerHeight, contentHeight: content, insets: new.insets)
                    if abs(target - base) > 0.5 {
                        if new.containerHeight > old.containerHeight {
                            // Growing (the keyboard going): with the keyboard's own motion, not in one frame before
                            // it (the rows dropped, then the keyboard slid away: 「ガクッ」).
                            if #available(iOS 27.0, *) {
                                UIView.animate(withDuration: 0.25, delay: 0, options: [.curveEaseOut, .beginFromCurrentState]) {
                                    scrollView.contentOffset.y = target
                                }
                            } else {
                                // iOS 26: SwiftUI puts an animated offset back at its next layout (the tool row's, a
                                // frame later), while an offset set outright holds. Set outright, then, frame by
                                // frame along the keyboard's curve.
                                KeyboardBehavior.slide(scrollView, to: target)
                            }
                        } else {
                            scrollView.contentOffset.y = target
                        }
                    }
                    layouts.turn?.offset = target
                    restore(old.containerHeight, new.containerHeight, false)
                }
            }
        } else {
            // iOS 17: the keyboard coming up at least keeps the newest message in view.
            content.onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
                guard enabled, atEnd else { return }
                DispatchQueue.main.async { withAnimation(.easeOut(duration: 0.25)) { restore(0, 0, true) } }
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

