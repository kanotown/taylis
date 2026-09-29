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

/// The marker at the newest edge; on iOS 17 its appearing is what says the list is there.
struct NewestEdgeMarker: View {
    let action: (Bool) -> Void

    var body: some View {
        Color.clear.frame(height: 1).id(UpsideDown.newest)
            .onAppear { if #unavailable(iOS 18.0) { action(true) } }
            .onDisappear { if #unavailable(iOS 18.0) { action(false) } }
    }
}
