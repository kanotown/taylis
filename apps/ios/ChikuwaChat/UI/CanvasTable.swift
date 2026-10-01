import Foundation

/// M57: the canvas table editor's rules (CANVAS.md §17), a port of apps/shared/gen_canvas_table.py — reading a Markdown
/// table into rows and columns, writing it back, finding the table at the caret, inserting a new one, and the edits.
/// Tested against apps/shared/canvas_table.json, like the desktop and Android.
enum CanvasTable {
    enum Align: String, CaseIterable, Equatable {
        case left, center, right
    }

    struct Table: Equatable {
        var align: [Align?]
        var header: [String]
        var rows: [[String]]

        var columnCount: Int { header.count }
    }

    // MARK: reading

    private static let separator = try! NSRegularExpression(pattern: #"^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$"#)
    private static let lineBreak = try! NSRegularExpression(pattern: #"\s*\r?\n\s*"#)

    private static func trim(_ s: String) -> String { s.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// Cells of one row: outer pipes dropped, split on unescaped pipes, `\|` read as `|`, each trimmed.
    static func splitRow(_ line: String) -> [String] {
        var s = trim(line)
        if s.hasPrefix("|") { s.removeFirst() }
        if s.hasSuffix("|") && !s.hasSuffix("\\|") { s.removeLast() }
        let scalars = Array(s.unicodeScalars)
        var cells: [String] = []
        var cur = String.UnicodeScalarView()
        var i = 0
        while i < scalars.count {
            if scalars[i] == "\\" && i + 1 < scalars.count && scalars[i + 1] == "|" {
                cur.append("|")
                i += 2
                continue
            }
            if scalars[i] == "|" {
                cells.append(trim(String(cur)))
                cur = String.UnicodeScalarView()
            } else {
                cur.append(scalars[i])
            }
            i += 1
        }
        cells.append(trim(String(cur)))
        return cells
    }

    static func alignOf(_ cell: String) -> Align? {
        let c = trim(cell)
        switch (c.hasPrefix(":"), c.hasSuffix(":")) {
        case (true, true): return .center
        case (true, false): return .left
        case (false, true): return .right
        default: return nil
        }
    }

    /// A table block (header, separator, body rows); body rows padded or cut to the header's column count.
    static func parse(_ lines: [String]) -> Table {
        let header = splitRow(lines[0])
        let n = header.count
        let seps = lines.count > 1 ? splitRow(lines[1]) : []
        let align = (0..<n).map { $0 < seps.count ? alignOf(seps[$0]) : nil }
        let rows = lines.dropFirst(2).map { line -> [String] in
            let cells = splitRow(line)
            return Array((cells + Array(repeating: "", count: n)).prefix(n))
        }
        return Table(align: align, header: header, rows: rows)
    }

    // MARK: writing

    /// A cell as written: one line (line breaks become spaces), `|` escaped, trimmed.
    static func cellText(_ text: String) -> String {
        let ns = text as NSString
        let flat = lineBreak.stringByReplacingMatches(in: text, range: NSRange(location: 0, length: ns.length), withTemplate: " ")
        return trim(flat).replacingOccurrences(of: "|", with: "\\|")
    }

    static func serialize(_ table: Table) -> [String] {
        func row(_ cells: [String]) -> String { "| " + cells.map(cellText).joined(separator: " | ") + " |" }
        func mark(_ align: Align?) -> String {
            switch align {
            case nil: return "---"
            case .left: return ":---"
            case .center: return ":---:"
            case .right: return "---:"
            }
        }
        let sep = "| " + table.align.map(mark).joined(separator: " | ") + " |"
        return [row(table.header), sep] + table.rows.map(row)
    }

    // MARK: finding and inserting

    static func isRow(_ line: String) -> Bool {
        String(line.unicodeScalars.drop { CharacterSet.whitespacesAndNewlines.contains($0) }).hasPrefix("|")
    }

    static func isSeparator(_ line: String) -> Bool {
        separator.firstMatch(in: line, range: NSRange(location: 0, length: (line as NSString).length)) != nil
    }

    /// The [first, last] lines of the table holding `caretLine`: consecutive lines starting with `|` whose second line
    /// is a separator. nil when the caret is not in a table.
    static func findTable(_ text: String, caretLine: Int) -> ClosedRange<Int>? {
        findTable(lines: text.components(separatedBy: "\n"), caretLine: caretLine)
    }

    static func findTable(lines: [String], caretLine: Int) -> ClosedRange<Int>? {
        guard caretLine >= 0, caretLine < lines.count, isRow(lines[caretLine]) else { return nil }
        var start = caretLine
        while start > 0 && isRow(lines[start - 1]) { start -= 1 }
        var end = caretLine
        while end + 1 < lines.count && isRow(lines[end + 1]) { end += 1 }
        guard end - start >= 1, isSeparator(lines[start + 1]) else { return nil }
        return start...end
    }

    static let newTable = Table(align: [nil, nil, nil], header: ["列1", "列2", "列3"], rows: [["", "", ""], ["", "", ""]])

    /// `table` (a new 3 × 2 one by default) after the caret's line (at the start when the text is empty), with a blank
    /// line between it and any text before or after. The new text and the table's [first, last] line.
    static func insertTable(_ text: String, caretLine: Int, table: Table = newTable) -> (text: String, range: ClosedRange<Int>) {
        let lines = text.isEmpty ? [] : text.components(separatedBy: "\n")
        let at = lines.isEmpty ? 0 : max(0, min(caretLine + 1, lines.count))
        let block = serialize(table)
        var before = Array(lines[..<at])
        var after = Array(lines[at...])
        if let last = before.last, !trim(last).isEmpty { before.append("") }
        if let first = after.first, !trim(first).isEmpty { after.insert("", at: 0) }
        let first = before.count
        return ((before + block + after).joined(separator: "\n"), first...(first + block.count - 1))
    }

    // MARK: edits (each leaves the table as it was when it does not apply)

    /// A blank body row at `index` (0...rows.count).
    static func addRow(_ t: Table, at index: Int) -> Table {
        var t = t
        t.rows.insert(Array(repeating: "", count: t.columnCount), at: max(0, min(index, t.rows.count)))
        return t
    }

    static func deleteRow(_ t: Table, at index: Int) -> Table {
        guard t.rows.indices.contains(index) else { return t }
        var t = t
        t.rows.remove(at: index)
        return t
    }

    static func moveRow(_ t: Table, from: Int, to: Int) -> Table {
        guard t.rows.indices.contains(from) else { return t }
        var t = t
        let row = t.rows.remove(at: from)
        t.rows.insert(row, at: max(0, min(to, t.rows.count)))
        return t
    }

    /// A blank column at `index` (0...columnCount), its header 「列N」 with N the new count.
    static func addColumn(_ t: Table, at index: Int) -> Table {
        var t = t
        let i = max(0, min(index, t.columnCount))
        t.header.insert("列\(t.columnCount + 1)", at: i)
        t.align.insert(nil, at: i)
        for r in t.rows.indices { t.rows[r].insert("", at: min(i, t.rows[r].count)) }
        return t
    }

    /// Refused (unchanged) for the last column.
    static func deleteColumn(_ t: Table, at index: Int) -> Table {
        guard t.columnCount > 1, t.header.indices.contains(index) else { return t }
        var t = t
        t.header.remove(at: index)
        t.align.remove(at: index)
        for r in t.rows.indices where t.rows[r].indices.contains(index) { t.rows[r].remove(at: index) }
        return t
    }

    static func setAlign(_ t: Table, column: Int, _ align: Align?) -> Table {
        guard t.align.indices.contains(column) else { return t }
        var t = t
        t.align[column] = align
        return t
    }

    // MARK: the editing session (iOS: open from the caret, write back at 完了)

    /// What 「表」 opened: an existing table (its lines and where they were) or a new one to go after the caret's line.
    /// The text is what the editor showed then, so the write-back can tell whether it changed meanwhile.
    struct Target: Identifiable, Equatable {
        let id = UUID()
        let text: String
        /// The table's lines in `text`; nil: a new table, inserted only at 完了 (キャンセル leaves the text untouched).
        let range: ClosedRange<Int>?
        /// The caret's line (a new table goes after it).
        let caretLine: Int
        let table: Table

        var isNew: Bool { range == nil }

        var block: [String] {
            guard let range else { return [] }
            return Array(text.components(separatedBy: "\n")[range])
        }
    }

    static func open(_ text: String, caretLine: Int) -> Target {
        let lines = text.components(separatedBy: "\n")
        if let range = findTable(lines: lines, caretLine: caretLine) {
            return Target(text: text, range: range, caretLine: caretLine, table: parse(Array(lines[range])))
        }
        return Target(text: text, range: nil, caretLine: caretLine, table: newTable)
    }

    enum WriteBack: Equatable {
        /// The table's lines replaced where they are now.
        case replaced(ClosedRange<Int>)
        /// Inserted as a new block: a new table, or an existing one someone else changed meanwhile (theirs is kept).
        case inserted(ClosedRange<Int>)
    }

    /// The text with the edited table written back into `current` (the editor's text now; it may have taken in someone
    /// else's merged edits since `target` was opened); nil when there is nothing to write (an existing table left as
    /// it was). An existing table is looked for at its original lines, then (moved by edits above it) as the same lines
    /// nearest to where they would have moved; when it is no longer there as it was, the edited table goes in as a new
    /// block after the table now at that place (or at that place) — never over someone else's edit.
    static func writeBack(_ target: Target, table: Table, into current: String) -> (text: String, result: WriteBack)? {
        let anchorLine = movedLine(target, in: current)
        guard target.range != nil else {
            let out = insertTable(current, caretLine: anchorLine, table: table)
            return (out.text, .inserted(out.range))
        }
        let block = target.block
        if table == parse(block) { return nil }
        var lines = current.components(separatedBy: "\n")
        let range = target.range!
        var found: ClosedRange<Int>?
        if range.upperBound < lines.count && Array(lines[range]) == block {
            found = range
        } else if lines.count >= block.count {
            for start in 0...(lines.count - block.count) where Array(lines[start..<(start + block.count)]) == block {
                let candidate = start...(start + block.count - 1)
                if found.map({ abs(start - anchorLine) < abs($0.lowerBound - anchorLine) }) ?? true { found = candidate }
            }
        }
        if let found, findTable(lines: lines, caretLine: found.lowerBound) == found {
            let written = serialize(table)
            lines.replaceSubrange(found, with: written)
            return (lines.joined(separator: "\n"), .replaced(found.lowerBound...(found.lowerBound + written.count - 1)))
        }
        // Changed meanwhile: after the table now there (theirs stays as they left it), else where it was.
        let after = findTable(lines: lines, caretLine: anchorLine)?.upperBound ?? (anchorLine - 1)
        let out = insertTable(current, caretLine: after, table: table)
        return (out.text, .inserted(out.range))
    }

    /// Where the target's line (the table's first line, or the caret's line for a new table) is in `current`.
    private static func movedLine(_ target: Target, in current: String) -> Int {
        let line = target.range?.lowerBound ?? target.caretLine
        let lines = target.text.components(separatedBy: "\n")
        let offset = lines.prefix(max(0, min(line, lines.count))).reduce(0) { $0 + ($1 as NSString).length + 1 }
        let moved = CanvasText.preserveCaret(target.text, current, min(offset, (target.text as NSString).length))
        let ns = current as NSString
        return ns.substring(to: min(moved, ns.length)).components(separatedBy: "\n").count - 1
    }

    /// The 0-based line of a UTF-16 offset.
    static func line(of offset: Int, in text: String) -> Int {
        let ns = text as NSString
        return ns.substring(to: max(0, min(offset, ns.length))).components(separatedBy: "\n").count - 1
    }

    /// The UTF-16 offset where `line` starts.
    static func offset(ofLine line: Int, in text: String) -> Int {
        let lines = text.components(separatedBy: "\n")
        return min(lines.prefix(max(0, line)).reduce(0) { $0 + ($1 as NSString).length + 1 }, (text as NSString).length)
    }
}
