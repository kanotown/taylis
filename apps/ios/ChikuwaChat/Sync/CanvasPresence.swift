import Foundation

/// M73 (CANVAS.md §18.2 / §18.5): 「編集中」 on a canvas — the volatile `canvas_presence` frames, as the desktop's
/// sync/canvasPresence.ts. Pure, so the tests read them.
///
/// Sending: `editing: true` while the editor has the focus and is used, again at once when the caret's heading changes,
/// else every `refresh`; `editing: false` when it stops (blur, close, background) — only after a true went out.
/// Receiving: an editor shows until `ttl` passes without a refresh (or a false arrives).
enum CanvasPresence {
    static let refresh: TimeInterval = 20
    static let ttl: TimeInterval = 45
    /// CANVAS.md §25: typing and caret moves are looked at this often at most — once this long after the first of a
    /// burst, with the caret as it is then (so the last position always goes out).
    static let caretInterval: TimeInterval = 0.3
    /// Below this the sender holds a moved caret back whoever asks (timers fire a little early or late).
    static let caretMinGap: TimeInterval = 0.25
    /// The server keeps 120 characters of the heading.
    static let maxSection = 120

    /// The heading as it is sent: one line, 120 characters at most; nil when blank.
    static func shownSection(_ section: String?) -> String? {
        guard let section else { return nil }
        let line = section.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).joined(separator: " ")
        return line.isEmpty ? nil : String(line.prefix(maxSection))
    }

    /// 「〇〇 が編集中」, 「〇〇、△△ が編集中」, 「〇〇 ほか N 人が編集中」.
    static func editingLabel(_ names: [String]) -> String {
        if names.isEmpty { return "" }
        if names.count <= 2 { return names.joined(separator: tr("、")) + tr(" が編集中") }
        return tr("\(names[0]) ほか \(names.count - 1) 人が編集中")
    }

    // MARK: carets (CANVAS.md §25)

    /// Readable on the light and the dark canvas; a person keeps theirs (by their id). The desktop's palette and hash.
    static let caretColors: [UInt32] = [0xE5484D, 0x0090FF, 0x30A46C, 0xF76B15, 0x8E4EC6, 0xD6409F, 0x12A594, 0xAD7F58]

    /// The colour (0xRRGGBB) of a person's caret: the same on every client.
    static func caretColor(_ userId: String) -> UInt32 {
        var hash: UInt32 = 0
        for unit in userId.utf16 { hash = hash &* 31 &+ UInt32(unit) }
        return caretColors[Int(hash % UInt32(caretColors.count))]
    }

    /// My caret (`offset`, UTF-16, into the text as shown) in the stored body's terms. `lineOffset`: the stored line the
    /// shown text starts on (a section); `encodeLine` writes the start of a shown line as stored (mentions as `<@uuid>`).
    static func storedCaret(shown: String, offset: Int, lineOffset: Int = 0, encodeLine: (String) -> String) -> CanvasCaret {
        let ns = shown as NSString
        let at = max(0, min(offset, ns.length))
        let start = CanvasText.lineStartOffset(ns, at)
        let line = ns.substring(to: start).components(separatedBy: "\n").count - 1
        return CanvasCaret(line: lineOffset + line, column: (encodeLine(ns.substring(with: NSRange(location: start, length: at - start))) as NSString).length)
    }

    /// Someone's caret (stored terms) as a UTF-16 offset into the text as shown here; nil when their line is not shown
    /// (another section, or not here yet). `stored` is the body the shown text stands for; `decodeLine` turns the start of
    /// a stored line into what it looks like here. The column is clamped to the shown line (approximate on purpose).
    static func shownOffset(stored: String, shown: String, caret: CanvasCaret, lineOffset: Int = 0, decodeLine: (String) -> String) -> Int? {
        let storedLines = stored.components(separatedBy: "\n")
        let shownLines = shown.components(separatedBy: "\n")
        let local = caret.line - lineOffset
        guard caret.line >= 0, local >= 0, caret.line < storedLines.count, local < shownLines.count else { return nil }
        let storedLine = storedLines[caret.line] as NSString
        let prefix = storedLine.substring(to: max(0, min(caret.column, storedLine.length)))
        let column = min((decodeLine(prefix) as NSString).length, (shownLines[local] as NSString).length)
        var offset = 0
        for k in 0..<local { offset += (shownLines[k] as NSString).length + 1 }
        return offset + column
    }
}

/// CANVAS.md §25: a caret in the stored body — a 0-based line and a UTF-16 column of that line.
struct CanvasCaret: Codable, Equatable {
    let line: Int
    let column: Int
}

/// The client → server frame.
struct CanvasPresenceOut: Equatable {
    let canvasId: String
    let editing: Bool
    let section: String?
    var caret: CanvasCaret? = nil

    var json: String { ClientFrame.canvasPresence(canvasId: canvasId, editing: editing, section: section, caret: caret) }
}

/// What this device last said per canvas; decides which frames go out.
struct CanvasPresenceSender {
    private struct Sent {
        var section: String?
        var caret: CanvasCaret?
        var at: Date
    }

    private var sent: [String: Sent] = [:]

    /// The frame to send for this state now, or nil (nothing new to say). A heading that changed goes out at once; a
    /// caret that only moved once `caretMinGap` passed since the last frame (the editor asks again, every
    /// `caretInterval`, with the caret as it is by then); the same state again only after `refresh`.
    mutating func next(_ canvasId: String, editing: Bool, section: String?, caret: CanvasCaret? = nil, now: Date) -> CanvasPresenceOut? {
        let shown = CanvasPresence.shownSection(section)
        if !editing {
            guard sent.removeValue(forKey: canvasId) != nil else { return nil }
            return CanvasPresenceOut(canvasId: canvasId, editing: false, section: nil)
        }
        if let last = sent[canvasId], last.section == shown {
            if last.caret == caret {
                if now.timeIntervalSince(last.at) < CanvasPresence.refresh { return nil }
            } else if now.timeIntervalSince(last.at) < CanvasPresence.caretMinGap {
                return nil
            }
        }
        sent[canvasId] = Sent(section: shown, caret: caret, at: now)
        return CanvasPresenceOut(canvasId: canvasId, editing: true, section: shown, caret: caret)
    }

    /// A new connection: the server knows nothing of before, so the next true goes out at once.
    mutating func reset() { sent = [:] }
}

/// Someone editing a canvas, and the heading their caret is under (nil: none).
struct CanvasEditingUser: Equatable {
    let userId: String
    let section: String?
    /// CANVAS.md §25: where their caret is (stored terms), when they said.
    var caret: CanvasCaret? = nil
}

/// Who edits which canvas, as the frames said (kept by the store; expired entries are skipped when read).
struct CanvasEditors: Equatable {
    private struct Entry: Equatable {
        var userId: String
        var section: String?
        var caret: CanvasCaret?
        var until: Date
    }

    /// canvas id → editors in the order they started.
    private var byCanvas: [String: [Entry]] = [:]

    /// A frame from someone else: true (re)starts their entry for the TTL, false ends it.
    mutating func note(_ canvasId: String, userId: String, editing: Bool, section: String?, caret: CanvasCaret? = nil, now: Date) {
        var entries = (byCanvas[canvasId] ?? []).filter { $0.until > now } // keep the map small
        if editing {
            let entry = Entry(userId: userId, section: section, caret: caret, until: now.addingTimeInterval(CanvasPresence.ttl))
            if let index = entries.firstIndex(where: { $0.userId == userId }) { entries[index] = entry } else { entries.append(entry) }
        } else {
            entries.removeAll { $0.userId == userId }
        }
        byCanvas[canvasId] = entries.isEmpty ? nil : entries
    }

    /// Those editing the canvas now, in the order they started.
    func of(_ canvasId: String, now: Date) -> [CanvasEditingUser] {
        (byCanvas[canvasId] ?? []).filter { $0.until > now }.map { CanvasEditingUser(userId: $0.userId, section: $0.section, caret: $0.caret) }
    }

    /// The soonest moment an entry of this canvas expires (to re-render then), or nil.
    func nextExpiry(_ canvasId: String, now: Date) -> Date? {
        (byCanvas[canvasId] ?? []).map(\.until).filter { $0 > now }.min()
    }

    mutating func clear() { byCanvas = [:] }
}
