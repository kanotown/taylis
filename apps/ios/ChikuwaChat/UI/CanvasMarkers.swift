import Foundation

/// M83 (CANVAS.md §22, §22.8): the hidden marker ` <!--task:<id>-->` the server puts at the end of a checklist item a task
/// was made from (server/app/modules/canvases/markers.py); with it the box and the task's completion follow each other.
/// The app never shows it (the view, the history, the conflict panels, a copy, the editor) and keeps it through edits.
/// The desktop's rules (apps/desktop/src/ui/canvasMarkers.ts); apps/shared/canvas_task_markers.json holds the shared cases.
///
/// The editor shows each marker as one invisible character, a Unicode tag character (U+E0020 + n, default-ignorable,
/// drawn as nothing), n being its place in the editor's table. Positions are UTF-16 (NSRange): a tag character is a
/// surrogate pair, and it joins the character before it into one grapheme (one Swift `Character`).
enum CanvasMarkers {
    /// One marker with the space before it (taken out with it). Only a lower-case, well-formed id is a marker.
    static let marker = try! NSRegularExpression(pattern: " ?<!--task:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-->")

    /// The text as a reader sees it: without markers.
    static func strip(_ text: String) -> String {
        guard text.contains("<!--task:") else { return text }
        return marker.stringByReplacingMatches(in: text, range: NSRange(location: 0, length: (text as NSString).length), withTemplate: "")
    }

    /// The ids the text's markers name, in order.
    static func ids(_ text: String) -> [String] {
        let ns = text as NSString
        return marker.matches(in: text, range: NSRange(location: 0, length: ns.length)).map { ns.substring(with: $0.range(at: 1)) }
    }

    // MARK: the editor's stand-ins

    static let first: UInt32 = 0xE0020
    static let slots = 95 // U+E0020 … U+E007E
    /// A stand-in in UTF-16: a surrogate pair.
    static let standInLength = 2
    private static let high: unichar = 0xDB40 // U+E0020 … U+E007E all share it
    private static let lowFirst: unichar = 0xDC20

    static func standIn(_ slot: Int) -> String { String(UnicodeScalar(first + UInt32(slot))!) }

    /// Whether the text has one of the stand-ins at UTF-16 offset `index`.
    static func standInAt(_ text: NSString, _ index: Int) -> Bool {
        guard index >= 0, index + standInLength <= text.length, text.character(at: index) == high else { return false }
        let low = text.character(at: index + 1)
        return low >= lowFirst && low < lowFirst + unichar(slots)
    }

    /// The slot of a stand-in scalar, or nil.
    private static func slot(_ scalar: Unicode.Scalar) -> Int? {
        let value = scalar.value
        return value >= first && value < first + UInt32(slots) ? Int(value - first) : nil
    }

    static func hasStandIns(_ text: String) -> Bool { text.unicodeScalars.contains { slot($0) != nil } }

    /// The editor's text without the stand-ins (what a copy puts on the clipboard).
    static func stripStandIns(_ text: String) -> String {
        guard hasStandIns(text) else { return text }
        var scalars = String.UnicodeScalarView()
        scalars.append(contentsOf: text.unicodeScalars.filter { slot($0) == nil })
        return String(scalars)
    }

    /// The editor's table: which task each stand-in is. One per editor; the same id always gets the same character.
    final class Table {
        private(set) var ids: [String] = []

        /// The stored text as the editor shows it: each marker (and the space before it) as its stand-in. Past the
        /// table's 95 a marker stays as text (kept, only visible).
        func hide(_ wire: String) -> String {
            guard wire.contains("<!--task:") else { return wire }
            let ns = wire as NSString
            var out = ""
            var last = 0
            for match in CanvasMarkers.marker.matches(in: wire, range: NSRange(location: 0, length: ns.length)) {
                out += ns.substring(with: NSRange(location: last, length: match.range.location - last))
                let id = ns.substring(with: match.range(at: 1))
                var slot = ids.firstIndex(of: id)
                if slot == nil, ids.count < CanvasMarkers.slots {
                    ids.append(id)
                    slot = ids.count - 1
                }
                out += slot.map { CanvasMarkers.standIn($0) } ?? ns.substring(with: match.range)
                last = NSMaxRange(match.range)
            }
            return out + ns.substring(from: last)
        }

        /// The editor's text as stored: on each line the stand-ins go, and their markers follow at its end (one space
        /// before each).
        func show(_ shown: String) -> String {
            guard CanvasMarkers.hasStandIns(shown) else { return shown }
            return shown.components(separatedBy: "\n").map { line -> String in
                var found: [String] = []
                var bare = String.UnicodeScalarView()
                for scalar in line.unicodeScalars {
                    if let slot = CanvasMarkers.slot(scalar) {
                        if slot < ids.count, !found.contains(ids[slot]) { found.append(ids[slot]) }
                    } else {
                        bare.append(scalar)
                    }
                }
                return found.isEmpty ? String(bare) : String(bare) + " " + found.map { "<!--task:\($0)-->" }.joined(separator: " ")
            }.joined(separator: "\n")
        }
    }

    // MARK: deleting beside a stand-in

    /// Backspace (`backward`) or Delete next to a stand-in with nothing selected (UTF-16 caret): the visible character
    /// beside the caret goes and the stand-ins stay (UIKit would take the grapheme — the character with its stand-ins —
    /// or the stand-in alone). The caret ends after any stand-ins that follow it. nil when no stand-in is involved (the
    /// text view's own deletion is right).
    static func deleteBeside(_ text: String, caret: Int, backward: Bool) -> (text: String, caret: Int)? {
        let ns = text as NSString
        if backward {
            var end = caret
            while end >= standInLength && standInAt(ns, end - standInLength) { end -= standInLength }
            if end == caret && !standInAt(ns, end) { return nil }
            if end == 0 { return (text, caret) }
            let start = end - (end >= 2 && isLowSurrogate(ns.character(at: end - 1)) ? 2 : 1)
            let next = ns.replacingCharacters(in: NSRange(location: start, length: end - start), with: "")
            return settle(next, start + (caret - end))
        }
        var start = caret
        while standInAt(ns, start) { start += standInLength }
        if start >= ns.length { return start == caret ? nil : (text, start) }
        let end = start + (start + 1 < ns.length && isHighSurrogate(ns.character(at: start)) ? 2 : 1)
        if start == caret && !standInAt(ns, end) { return nil }
        return settle(ns.replacingCharacters(in: NSRange(location: start, length: end - start), with: ""), caret)
    }

    private static func settle(_ text: String, _ caret: Int) -> (text: String, caret: Int) {
        let ns = text as NSString
        var at = caret
        while standInAt(ns, at) { at += standInLength }
        return (text, at)
    }

    private static func isHighSurrogate(_ unit: unichar) -> Bool { unit >= 0xD800 && unit <= 0xDBFF }
    private static func isLowSurrogate(_ unit: unichar) -> Bool { unit >= 0xDC00 && unit <= 0xDFFF }
}
