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
    /// Typing and caret moves are looked at this often at most (the server relays the same content every 2 s at most).
    static let throttle: TimeInterval = 2
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
        if names.count <= 2 { return names.joined(separator: "、") + " が編集中" }
        return "\(names[0]) ほか \(names.count - 1) 人が編集中"
    }
}

/// The client → server frame.
struct CanvasPresenceOut: Equatable {
    let canvasId: String
    let editing: Bool
    let section: String?

    var json: String { ClientFrame.canvasPresence(canvasId: canvasId, editing: editing, section: section) }
}

/// What this device last said per canvas; decides which frames go out.
struct CanvasPresenceSender {
    private struct Sent {
        var section: String?
        var at: Date
    }

    private var sent: [String: Sent] = [:]

    /// The frame to send for this state now, or nil (nothing new to say).
    mutating func next(_ canvasId: String, editing: Bool, section: String?, now: Date) -> CanvasPresenceOut? {
        let shown = CanvasPresence.shownSection(section)
        if !editing {
            guard sent.removeValue(forKey: canvasId) != nil else { return nil }
            return CanvasPresenceOut(canvasId: canvasId, editing: false, section: nil)
        }
        if let last = sent[canvasId], last.section == shown, now.timeIntervalSince(last.at) < CanvasPresence.refresh { return nil }
        sent[canvasId] = Sent(section: shown, at: now)
        return CanvasPresenceOut(canvasId: canvasId, editing: true, section: shown)
    }

    /// A new connection: the server knows nothing of before, so the next true goes out at once.
    mutating func reset() { sent = [:] }
}

/// Someone editing a canvas, and the heading their caret is under (nil: none).
struct CanvasEditingUser: Equatable {
    let userId: String
    let section: String?
}

/// Who edits which canvas, as the frames said (kept by the store; expired entries are skipped when read).
struct CanvasEditors: Equatable {
    private struct Entry: Equatable {
        var userId: String
        var section: String?
        var until: Date
    }

    /// canvas id → editors in the order they started.
    private var byCanvas: [String: [Entry]] = [:]

    /// A frame from someone else: true (re)starts their entry for the TTL, false ends it.
    mutating func note(_ canvasId: String, userId: String, editing: Bool, section: String?, now: Date) {
        var entries = (byCanvas[canvasId] ?? []).filter { $0.until > now } // keep the map small
        if editing {
            let entry = Entry(userId: userId, section: section, until: now.addingTimeInterval(CanvasPresence.ttl))
            if let index = entries.firstIndex(where: { $0.userId == userId }) { entries[index] = entry } else { entries.append(entry) }
        } else {
            entries.removeAll { $0.userId == userId }
        }
        byCanvas[canvasId] = entries.isEmpty ? nil : entries
    }

    /// Those editing the canvas now, in the order they started.
    func of(_ canvasId: String, now: Date) -> [CanvasEditingUser] {
        (byCanvas[canvasId] ?? []).filter { $0.until > now }.map { CanvasEditingUser(userId: $0.userId, section: $0.section) }
    }

    /// The soonest moment an entry of this canvas expires (to re-render then), or nil.
    func nextExpiry(_ canvasId: String, now: Date) -> Date? {
        (byCanvas[canvasId] ?? []).map(\.until).filter { $0 > now }.min()
    }

    mutating func clear() { byCanvas = [:] }
}
