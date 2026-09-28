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
    func keepsBottomOnResize(enabled: Bool, atEnd: Bool, restore: @escaping (_ oldHeight: CGFloat, _ wasAtEnd: Bool) -> Void) -> some View {
        modifier(KeepsBottom(enabled: enabled, atEnd: atEnd, restore: restore))
    }
}

private struct KeepsBottom: ViewModifier {
    let enabled: Bool
    let atEnd: Bool
    let restore: (CGFloat, Bool) -> Void

    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.onScrollGeometryChange(for: ScrollGeometry.self, of: { $0 }) { old, new in
                guard enabled else { return }
                let below = KeyboardBehavior.distanceToEnd(contentHeight: old.contentSize.height, insets: old.contentInsets,
                                                          offset: old.contentOffset.y, containerHeight: old.containerSize.height)
                if abs(old.containerSize.height - new.containerSize.height) > 0.5 {
                    restore(old.containerSize.height, below <= KeyboardBehavior.nearEnd)
                } else if new.contentSize.height > old.contentSize.height + 0.5, below <= KeyboardBehavior.nearEnd {
                    // The content grew at the end (a reaction on the last rows, an image loading): the end stays in view
                    // instead of going under the input.
                    let now = KeyboardBehavior.distanceToEnd(contentHeight: new.contentSize.height, insets: new.contentInsets,
                                                             offset: new.contentOffset.y, containerHeight: new.containerSize.height)
                    if now > below + 0.5 { restore(new.containerSize.height, true) }
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
