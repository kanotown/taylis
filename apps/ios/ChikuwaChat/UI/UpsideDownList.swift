import SwiftUI

/// Conversations are upside-down lists (M36): the scroll view is flipped and each row flipped back, so the newest row
/// sits at the scroll view's origin, at the bottom of the screen. A scroll view keeps its offset from the origin by
/// itself, which is all a conversation needs: the newest row stays above the input as the keyboard comes and goes, a new
/// row pushes the others up, a short conversation sits at the bottom, and older pages go in at the far end without
/// moving what is on screen. Before, a list read top-down was kept at its bottom by code (anchors, keyboard following,
/// slides, corrections), and each case that code missed jolted the list (iOS builds 21–30).
///
/// In the flipped list, a row's `.top` is the screen's bottom: scroll anchors go through `UpsideDown.anchor`. Row frames are
/// measured in a coordinate space outside the flip (they come out as on screen).
enum UpsideDown {
    /// The anchor a scroll in the flipped list needs to put a row at `screen` (as seen on screen).
    static func anchor(_ screen: UnitPoint) -> UnitPoint { UnitPoint(x: screen.x, y: 1 - screen.y) }

    /// The id of the edge at the newest row (the origin).
    static let newest = "newest"

    /// This close to the origin, the reader is at the newest row.
    static let nearNewest: CGFloat = 40

    /// What a conversation does when a new newest row comes in (UpsideDown.arrival).
    enum Arrival: Equatable {
        /// At the newest edge: the edge's marker becomes the kept row, so the new row shows, moving in with the others.
        case follow
        /// My own post from further up: straight to the newest edge, without scrolling through the rows in between.
        case jump
        /// Someone else's row while the reader is further up: the row being read stays (the jump button counts it).
        case stay
    }

    /// The kept row (`scrollPosition(id:)`) is the row at the newest edge's side of the screen, which is the edge's marker
    /// only within a few points of the origin: a little further up (still `atNewest`, within `nearNewest`) it was the
    /// newest row, and an arrival went in under it, out of sight (iOS build 105). So at the newest edge the marker is made
    /// the kept row as the row comes in. My own post from further up jumps: an animated scroll over a long conversation
    /// spun through every row on the way, and the kept row, still the one I had been reading, could take the list back.
    static func arrival(atNewest: Bool, mine: Bool) -> Arrival {
        if atNewest { return .follow }
        return mine ? .jump : .stay
    }

    /// How a new newest row goes in (a thread): moving up with the others at the newest edge once the list is placed; at
    /// once while older rows are read, where an animated insertion moved the row being read by the new row's height
    /// (`scrollPosition(id:)` in a plain VStack keeps it only unanimated; iOS 26, 2026-10-07).
    static func arrivalAnimation(atNewest: Bool, placed: Bool) -> Animation? {
        atNewest && placed ? .easeOut(duration: 0.25) : nil
    }

    /// iOS 17, a marker laid out once (a plain VStack): whether the newest edge's marker, at `markerMinY` on screen, says
    /// the list is at its newest row (within `nearNewest` under the viewport's bottom, as the scroll geometry on iOS 18).
    static func markerNear(markerMinY: CGFloat, viewportHeight: CGFloat) -> Bool {
        markerMinY <= viewportHeight + nearNewest
    }

    /// Scrolls to a row at once, letting go of the kept row: kept, `scrollPosition(id:)` took the list back to it right
    /// after a scroll that ended at the newest edge (the first of a few new rows, which cannot go up to the screen's top).
    @MainActor
    static func scroll(to id: String, anchor: UnitPoint, _ kept: Binding<String?>, _ proxy: ScrollViewProxy) {
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            kept.wrappedValue = nil
            proxy.scrollTo(id, anchor: anchor)
        }
    }

    /// Whether the kept row is let go as the keyboard starts to move (keptRowPosition): any row but the newest
    /// edge's marker, whose offset of 0 no resize moves.
    static func letsGoForKeyboard(_ kept: String?) -> Bool {
        guard let kept else { return false }
        return kept != newest
    }

    /// The row to hold the list at (holdInPlace), and the anchor that scrolls to it without moving anything: the row
    /// wholly on screen nearest the newest edge (the input), at the place it is. `frames` are the rows' on-screen frames in
    /// the viewport (0 at its top, as `RowFrames`), by the id a scroll goes to; only rows whose frame is the whole scroll
    /// target (no day separator or divider drawn over it). Nil when no such row is wholly on screen.
    static func keptInPlace(_ frames: [(id: String, frame: CGRect)], viewportHeight: CGFloat) -> (id: String, anchor: UnitPoint)? {
        let inside = frames.filter { $0.frame.height > 0 && $0.frame.minY >= 0 && $0.frame.maxY <= viewportHeight && $0.frame.height < viewportHeight }
        guard let row = inside.max(by: { $0.frame.maxY < $1.frame.maxY }) else { return nil }
        // scrollTo lines the row's anchor point up with the viewport's: on screen, minY + s·h = s·H.
        let screen = row.frame.minY / (viewportHeight - row.frame.height)
        return (row.id, anchor(UnitPoint(x: 0.5, y: screen)))
    }

    /// Keeps the rows where they are through a change of the list's content while no row is kept (the keyboard let it
    /// go: keptRowPosition): scrolls to the row nearest the input, at the place it is now (keptInPlace),
    /// leaving the kept row unset. A scroll asked for in the same update as the change is done on the layout with it.
    /// iOS 17 and 18 only, as the letting go (iOS 26 is left as it was).
    @MainActor
    static func holdInPlace(_ frames: [(id: String, frame: CGRect)], viewportHeight: CGFloat, _ proxy: ScrollViewProxy) {
        if #available(iOS 26.0, *) { return }
        guard let place = keptInPlace(frames, viewportHeight: viewportHeight) else { return }
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) { proxy.scrollTo(place.id, anchor: place.anchor) }
    }

    /// Takes the list to its newest edge at once (my post, the jump button) and keeps it there: the kept row becomes the
    /// edge's marker. A `scrollTo` alone left the kept row where the reader had been.
    @MainActor
    static func jumpToNewest(_ kept: Binding<String?>, _ proxy: ScrollViewProxy) {
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            kept.wrappedValue = newest
            proxy.scrollTo(newest, anchor: anchor(.bottom))
        }
    }
}

/// 「新着 N 件」 / ↓ at the bottom right of a conversation (a channel, a thread) while it is not at its newest row.
struct JumpToNewestButton: View {
    let unseen: Int
    /// What VoiceOver says when there is nothing new: 「最新のメッセージへ」, 「最新の返信へ」.
    let latestLabel: LocalizedStringKey
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            if unseen > 0 {
                Label("新着 \(unseen) 件", systemImage: "arrow.down")
                    .font(.footnote.bold())
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(Color.accentColor, in: Capsule())
                    .foregroundStyle(.white)
            } else {
                Image(systemName: "arrow.down").padding(10).background(.thinMaterial, in: Circle())
            }
        }
        .accessibilityLabel(unseen > 0 ? Text("新着 \(unseen) 件へ") : Text(latestLabel))
        .padding(12)
    }
}

extension View {
    /// Turned upside down (the list), or back the right way up (a row in it).
    func upsideDown() -> some View { scaleEffect(x: 1, y: -1, anchor: .center) }

    /// Whether the flipped list is at its newest row: from the scroll geometry on iOS 18 (the offset from the origin),
    /// from the edge's marker on iOS 17 (LazyVStack lays it out a little before it is on screen).
    func onNewestEdge(_ action: @escaping (Bool) -> Void) -> some View { modifier(NewestEdgeDetector(action: action)) }
}

private struct NewestEdgeDetector: ViewModifier {
    let action: (Bool) -> Void

    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.onScrollGeometryChange(for: Bool.self, of: { geometry in
                geometry.contentOffset.y + geometry.contentInsets.top <= UpsideDown.nearNewest
            }, action: { _, atNewest in action(atNewest) })
        } else {
            content
        }
    }
}

/// The marker at the newest edge; on iOS 17 its appearing is what says the list is there (a LazyVStack makes it only
/// near the screen). A plain VStack (a thread's rows) makes it once, on screen or not: there `placed` gives the coordinate
/// space outside the flip and the viewport's height, and on iOS 17 it says so from where it is on screen.
///
/// Its id (`UpsideDown.newest`) goes on the marker where the stack holds it (`NewestEdgeMarker { … }.id(UpsideDown.newest)`),
/// not inside its body: a LazyVStack sees only its children's own ids until it has made them, so with the marker far off
/// screen `scrollTo` and `scrollPosition(id:)` found no such row and the jump button did nothing (testers, build 110).
struct NewestEdgeMarker: View {
    var placed: (space: String, viewportHeight: CGFloat)?
    let action: (Bool) -> Void

    var body: some View {
        Color.clear.frame(height: 1)
            .onAppear { if #unavailable(iOS 18.0), placed == nil { action(true) } }
            .onDisappear { if #unavailable(iOS 18.0) { action(false) } }
            .onGeometryChange(for: Bool.self) { geometry in
                guard let placed else { return false }
                return UpsideDown.markerNear(markerMinY: geometry.frame(in: .named(placed.space)).minY, viewportHeight: placed.viewportHeight)
            } action: { near in
                if #unavailable(iOS 18.0), placed != nil { action(near) }
            }
    }
}
