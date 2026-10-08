import Foundation

/// Pure text helpers of the canvas (CANVAS.md §4.4 / §5), the same as the desktop's (apps/desktop/src/ui/canvasText.ts
/// and composerEdit.ts): ticking a task line, keeping the caret where it was when the body is replaced by the server's
/// merged one, the outline, the editor's toolbar edits, and one heading's section (the phone's section editing).
/// apps/shared/canvas_markdown.json holds the cases the three clients share. Offsets are UTF-16 (NSString, UITextView
/// and JavaScript count the same way).
enum CanvasText {
    /// A task line, as the server counts it (server/app/modules/canvases/service.py TASK_LINE).
    static let taskLine = try! NSRegularExpression(pattern: #"^([ \t]*)[-*] \[([ xX])\](?: (.*))?$"#)

    /// The text and a selection in it (UTF-16 offsets).
    struct EditState: Equatable {
        var text: String
        var start: Int
        var end: Int
    }

    // MARK: ticks

    /// The body with the task on `line` (0-based) ticked or unticked (`done` nil: flipped); nil when that line is not a
    /// task (any more). Only the box changes, so a member who may only tick (§4.7) sends a body the server accepts.
    static func toggleTaskLine(_ body: String, line: Int, done: Bool? = nil) -> String? {
        var lines = body.components(separatedBy: "\n")
        guard line >= 0, line < lines.count else { return nil }
        let current = lines[line] as NSString
        guard let match = taskLine.firstMatch(in: current as String, range: NSRange(location: 0, length: current.length)) else { return nil }
        let indent = match.range(at: 1).length
        let wasDone = current.substring(with: match.range(at: 2)) != " "
        let next = done ?? !wasDone
        if next == wasDone { return body }
        let box = indent + 3 // "- [" then the mark
        lines[line] = current.replacingCharacters(in: NSRange(location: box, length: 1), with: next ? "x" : " ")
        return lines.joined(separator: "\n")
    }

    /// Task counts as the server makes them for a list (the 「3/8」 beside a canvas).
    static func taskProgress(total: Int, done: Int) -> String? { total > 0 ? "\(done)/\(total)" : nil }

    // MARK: images (M58, §4.10)

    /// The server binds at most this many attachments to one canvas (too_many_canvas_images).
    static let maxImages = 100

    private static let attachmentRef = try! NSRegularExpression(
        pattern: #"\(attachment:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\)"#)

    /// The distinct attachments a body names (`attachment:<id>`, as the server counts them when it binds).
    static func attachmentRefs(_ body: String) -> Set<String> {
        let ns = body as NSString
        return Set(attachmentRef.matches(in: body, range: NSRange(location: 0, length: ns.length)).map { ns.substring(with: $0.range(at: 1)).lowercased() })
    }

    /// An image `![alt](attachment:<id>)` on a line of its own at the caret (replacing a selection); the caret goes on the
    /// line below it (the desktop's insertImageLine).
    static func insertImageLine(_ state: EditState, attachmentId: String, alt: String = "") -> EditState {
        let ns = state.text as NSString
        let start = min(max(state.start, 0), ns.length)
        let end = min(max(state.end, start), ns.length)
        let before = ns.substring(to: start)
        let after = ns.substring(from: end)
        let lead = before.isEmpty || before.hasSuffix("\n") ? "" : "\n"
        let trail = after.hasPrefix("\n") ? "" : "\n"
        let cleanAlt = alt.replacingOccurrences(of: "]", with: " ").replacingOccurrences(of: "\n", with: " ")
        let line = "![\(cleanAlt)](attachment:\(attachmentId))"
        let caret = (before as NSString).length + (lead as NSString).length + (line as NSString).length + 1
        return EditState(text: before + lead + line + trail + after, start: caret, end: caret)
    }

    // MARK: the caret

    /// Where the caret goes when the editor's text changes from `before` to `after` under it (a merge brought someone
    /// else's edits): before the first difference it stays; after the last one it keeps its distance from the end;
    /// inside the changed stretch it follows its own line when that line is still there (the nearest copy of it), else
    /// it goes to the end of the change.
    static func preserveCaret(_ before: String, _ after: String, _ caret: Int) -> Int {
        let a = before as NSString, b = after as NSString
        if before == after { return min(caret, b.length) }
        let maxCommon = min(a.length, b.length)
        var prefix = 0
        while prefix < maxCommon && a.character(at: prefix) == b.character(at: prefix) { prefix += 1 }
        var suffix = 0
        while suffix < maxCommon - prefix && a.character(at: a.length - 1 - suffix) == b.character(at: b.length - 1 - suffix) { suffix += 1 }
        if caret <= prefix { return caret }
        if caret >= a.length - suffix { return max(0, b.length - (a.length - caret)) }
        // Inside the changed stretch: find the caret's line in the new text, nearest to where it would have moved.
        let lineStart = lineStartOffset(a, caret)
        let lineEnd = lineEndOffset(a, caret)
        let lineText = a.substring(with: NSRange(location: lineStart, length: lineEnd - lineStart))
        let column = caret - lineStart
        let beforeLines = before.components(separatedBy: "\n")
        let afterLines = after.components(separatedBy: "\n")
        let lineIndex = a.substring(to: lineStart).components(separatedBy: "\n").count - 1
        let expected = lineIndex + (afterLines.count - beforeLines.count)
        var best = -1
        if !lineText.trimmingCharacters(in: .whitespaces).isEmpty {
            for (k, line) in afterLines.enumerated() where line == lineText {
                if best == -1 || abs(k - expected) < abs(best - expected)
                    || (abs(k - expected) == abs(best - expected) && abs(k - lineIndex) < abs(best - lineIndex)) { best = k }
            }
        }
        if best != -1 {
            let offset = afterLines[..<best].reduce(0) { $0 + ($1 as NSString).length + 1 }
            return offset + column
        }
        return max(prefix, b.length - suffix)
    }

    // MARK: the outline

    struct OutlineEntry: Equatable, Identifiable {
        let level: Int
        let text: String
        let line: Int
        var id: Int { line }
    }

    private static let headingLine = try! NSRegularExpression(pattern: #"^(#{1,3})\s+(\S.*)$"#)

    /// The headings of a body (outside code fences), for the outline of a long canvas.
    static func outline(_ body: String) -> [OutlineEntry] {
        var entries: [OutlineEntry] = []
        var fenced = false
        for (index, line) in body.components(separatedBy: "\n").enumerated() {
            if line.hasPrefix("```") {
                fenced.toggle()
                continue
            }
            if fenced { continue }
            let ns = line as NSString
            if let match = headingLine.firstMatch(in: line, range: NSRange(location: 0, length: ns.length)) {
                let text = CanvasMarkers.stripStandIns(CanvasMarkers.strip(ns.substring(with: match.range(at: 2)))).replacingOccurrences(of: #"[*_~`]"#, with: "", options: .regularExpression)
                entries.append(OutlineEntry(level: match.range(at: 1).length, text: text.trimmingCharacters(in: .whitespaces), line: index))
            }
        }
        return entries
    }

    /// The line holding UTF-16 offset `offset` (0-based).
    static func lineIndex(_ text: String, at offset: Int) -> Int {
        let ns = text as NSString
        let end = max(0, min(offset, ns.length))
        return ns.substring(to: end).components(separatedBy: "\n").count - 1
    }

    /// M73 (§18.2): the heading the caret (a UTF-16 offset) is under — the `section` of `canvas_presence`; nil above the
    /// first heading.
    static func sectionAt(_ text: String, caret: Int) -> String? {
        let line = lineIndex(text, at: caret)
        return outline(text).last { $0.line <= line }?.text
    }

    // MARK: sections (§5 「見出しごとの「このセクションを編集」」)

    /// The section of the heading on `headingLine`: from that line up to the next heading of the same or a higher level
    /// (outside code fences), without the newline before it. nil when the line is not a heading.
    static func section(_ body: String, headingLine line: Int) -> NSRange? {
        let heads = outline(body)
        guard let head = heads.first(where: { $0.line == line }) else { return nil }
        let next = heads.first { $0.line > line && $0.level <= head.level }
        let lines = body.components(separatedBy: "\n")
        let start = lineOffset(lines, line)
        let end = next.map { lineOffset(lines, $0.line) - 1 } ?? (body as NSString).length
        return NSRange(location: start, length: max(0, end - start))
    }

    /// Where a section went when the body changed under it (someone else's edits merged in): its heading line found
    /// again (the copy nearest to where it would have moved), up to the line that followed it before (the next heading),
    /// so lines others added at its end belong to it; failing that, both ends move as a caret would.
    static func relocateSection(_ before: String, _ after: String, _ range: NSRange) -> NSRange {
        if before == after { return range }
        let a = before as NSString, b = after as NSString
        let beforeLines = before.components(separatedBy: "\n")
        let afterLines = after.components(separatedBy: "\n")
        let startLine = a.substring(to: min(range.location, a.length)).components(separatedBy: "\n").count - 1
        let heading = beforeLines[min(startLine, beforeLines.count - 1)]
        let endOffset = min(range.location + range.length, a.length)
        let followingLine: String? = endOffset < a.length ? beforeLines[a.substring(to: endOffset + 1).components(separatedBy: "\n").count - 1] : nil
        // The heading line again, nearest to where it would have moved.
        let moved = preserveCaret(before, after, range.location)
        let movedLine = b.substring(to: min(moved, b.length)).components(separatedBy: "\n").count - 1
        var newStartLine = -1
        for (k, line) in afterLines.enumerated() where line == heading {
            if newStartLine == -1 || abs(k - movedLine) < abs(newStartLine - movedLine) { newStartLine = k }
        }
        if newStartLine == -1 { newStartLine = movedLine }
        let start = lineOffset(afterLines, newStartLine)
        var end: Int
        if let followingLine {
            if let k = afterLines.indices.first(where: { $0 > newStartLine && afterLines[$0] == followingLine }) {
                end = lineOffset(afterLines, k) - 1
            } else {
                end = preserveCaret(before, after, endOffset)
            }
        } else {
            end = b.length
        }
        end = min(max(end, start), b.length)
        return NSRange(location: start, length: end - start)
    }

    /// `body` with `range` replaced by `text`.
    static func replacing(_ body: String, _ range: NSRange, with text: String) -> String {
        (body as NSString).replacingCharacters(in: range, with: text)
    }

    static func slice(_ body: String, _ range: NSRange) -> String {
        let ns = body as NSString
        let location = min(range.location, ns.length)
        return ns.substring(with: NSRange(location: location, length: min(range.length, ns.length - location)))
    }

    // MARK: the editor's toolbar

    /// The caret's line (or the selected lines) as a heading of `level`; the same level again makes it text.
    static func setHeading(_ state: EditState, level: Int) -> EditState {
        let ns = state.text as NSString
        let (lineStart, lineEnd) = selectedLines(ns, state.start, state.end)
        let lines = ns.substring(with: NSRange(location: lineStart, length: lineEnd - lineStart)).components(separatedBy: "\n")
        let marker = String(repeating: "#", count: level) + " "
        let same = lines.allSatisfy { $0.hasPrefix(marker) }
        let next = lines.map { line -> String in
            let bare = line.replacingOccurrences(of: #"^#{1,3}\s+"#, with: "", options: .regularExpression)
            return same ? bare : marker + bare
        }
        let joined = next.joined(separator: "\n")
        let firstDelta = (next[0] as NSString).length - (lines[0] as NSString).length
        let text = ns.replacingCharacters(in: NSRange(location: lineStart, length: lineEnd - lineStart), with: joined)
        return EditState(text: text, start: max(lineStart, state.start + firstDelta),
                         end: state.end + (joined as NSString).length - (lineEnd - lineStart))
    }

    /// The selected lines as tasks ("- [ ] "; a bullet becomes one), or back to text when they all are tasks already.
    static func toggleTasks(_ state: EditState) -> EditState {
        let ns = state.text as NSString
        let (lineStart, lineEnd) = selectedLines(ns, state.start, state.end)
        let lines = ns.substring(with: NSRange(location: lineStart, length: lineEnd - lineStart)).components(separatedBy: "\n")
        let all = lines.allSatisfy { isTask($0) }
        let next = lines.map { line -> String in
            if all { return line.replacingOccurrences(of: #"^(\s*)[-*] \[[ xX]\] ?"#, with: "$1", options: .regularExpression) }
            if isTask(line) { return line }
            let bare = line as NSString
            let indent = line.prefix { $0 == " " || $0 == "\t" }
            var rest = bare.substring(from: (String(indent) as NSString).length)
            if let bullet = rest.range(of: #"^[-*•]\s+"#, options: .regularExpression) { rest.removeSubrange(bullet) }
            return "\(indent)- [ ] \(rest)"
        }
        let joined = next.joined(separator: "\n")
        let firstDelta = (next[0] as NSString).length - (lines[0] as NSString).length
        let text = ns.replacingCharacters(in: NSRange(location: lineStart, length: lineEnd - lineStart), with: joined)
        return EditState(text: text, start: max(lineStart, state.start + firstDelta),
                         end: max(lineStart, state.end + (joined as NSString).length - (lineEnd - lineStart)))
    }

    /// Every selected line (or the caret's) prefixed with `marker`; if all have it already, it comes off.
    static func toggleLinePrefix(_ state: EditState, marker: String) -> EditState {
        let ns = state.text as NSString
        let (lineStart, lineEnd) = selectedLines(ns, state.start, state.end)
        let lines = ns.substring(with: NSRange(location: lineStart, length: lineEnd - lineStart)).components(separatedBy: "\n")
        let allHave = lines.allSatisfy { $0.hasPrefix(marker) }
        let length = (marker as NSString).length
        let next = lines.map { allHave ? ($0 as NSString).substring(from: length) : marker + $0 }.joined(separator: "\n")
        let delta = (next as NSString).length - (lineEnd - lineStart)
        let text = ns.replacingCharacters(in: NSRange(location: lineStart, length: lineEnd - lineStart), with: next)
        return EditState(text: text, start: max(lineStart, state.start + (allHave ? -length : length)), end: state.end + delta)
    }

    /// Wrap the selection with markers, or unwrap it when it is wrapped already; no selection puts an empty pair.
    static func toggleWrap(_ state: EditState, _ mark: String) -> EditState {
        let ns = state.text as NSString
        let length = (mark as NSString).length
        let selected = ns.substring(with: NSRange(location: state.start, length: state.end - state.start))
        let before = ns.substring(to: state.start), after = ns.substring(from: state.end)
        if before.hasSuffix(mark) && after.hasPrefix(mark) {
            let text = (before as NSString).substring(to: (before as NSString).length - length) + selected + (after as NSString).substring(from: length)
            return EditState(text: text, start: state.start - length, end: state.end - length)
        }
        if selected.hasPrefix(mark) && selected.hasSuffix(mark) && (selected as NSString).length >= 2 * length {
            let inner = (selected as NSString).substring(with: NSRange(location: length, length: (selected as NSString).length - 2 * length))
            return EditState(text: before + inner + after, start: state.start, end: state.start + (inner as NSString).length)
        }
        return EditState(text: before + mark + selected + mark + after, start: state.start + length, end: state.end + length)
    }

    /// A Markdown link around the selection (or 「リンク」), with its URL part selected.
    static func insertLink(_ state: EditState, url: String = "https://") -> EditState {
        let ns = state.text as NSString
        var selected = ns.substring(with: NSRange(location: state.start, length: state.end - state.start))
        if selected.isEmpty { selected = tr("リンク") }
        let inserted = "[\(selected)](\(url))"
        let urlStart = state.start + (selected as NSString).length + 3
        let text = ns.replacingCharacters(in: NSRange(location: state.start, length: state.end - state.start), with: inserted)
        return EditState(text: text, start: urlStart, end: urlStart + (url as NSString).length)
    }

    /// 「@」 at the caret (after a space when it follows a word), for the mention candidates to take over.
    static func insertMentionMark(_ state: EditState) -> EditState {
        let ns = state.text as NSString
        let previous = state.start > 0 ? ns.substring(with: NSRange(location: state.start - 1, length: 1)) : ""
        let lead = previous.isEmpty || previous.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "@" : " @"
        let text = ns.replacingCharacters(in: NSRange(location: state.start, length: state.end - state.start), with: lead)
        let caret = state.start + (lead as NSString).length
        return EditState(text: text, start: caret, end: caret)
    }

    /// A rule ("---") on a line of its own between blank lines, after the caret's line; the caret goes below it.
    static func insertRule(_ state: EditState) -> EditState {
        let ns = state.text as NSString
        let newline = ns.range(of: "\n", range: NSRange(location: state.end, length: ns.length - state.end))
        let at = newline.location == NSNotFound ? ns.length : newline.location
        let before = ns.substring(to: at), after = ns.substring(from: at)
        let lead = before.isEmpty ? "" : before.hasSuffix("\n\n") ? "" : before.hasSuffix("\n") ? "\n" : "\n\n"
        let inserted = lead + "---\n\n"
        let rest = after.hasPrefix("\n") ? String(after.dropFirst()) : after
        let caret = (before as NSString).length + (inserted as NSString).length
        return EditState(text: before + inserted + rest, start: caret, end: caret)
    }

    /// M149 (WIKI.md §22.5 / §22.7): a callout on lines of its own — `::: callout 💡`, the selected lines (or an empty
    /// line), `:::` — with the caret at the end of its inside.
    static func insertCallout(_ state: EditState, icon: String = "💡") -> EditState {
        insertContainer(state, opener: "::: callout \(icon)", caretOnOpener: false)
    }

    /// M149: a toggle on lines of its own — `::: toggle `, the selected lines (or an empty line), `:::` — with the caret
    /// after 「toggle 」 for its title.
    static func insertToggle(_ state: EditState) -> EditState {
        insertContainer(state, opener: "::: toggle ", caretOnOpener: true)
    }

    /// The selected lines put inside a container; without a selection an empty one replaces the caret's blank line or
    /// goes below the caret's line.
    private static func insertContainer(_ state: EditState, opener: String, caretOnOpener: Bool) -> EditState {
        let ns = state.text as NSString
        let start = min(max(state.start, 0), ns.length)
        let end = min(max(state.end, start), ns.length)
        var before: String, inner: String, after: String
        if start != end {
            let (lineStart, lineEnd) = selectedLines(ns, start, end)
            before = ns.substring(to: lineStart)
            inner = ns.substring(with: NSRange(location: lineStart, length: lineEnd - lineStart))
            after = ns.substring(from: lineEnd)
        } else {
            let lineStart = lineStartOffset(ns, start), lineEnd = lineEndOffset(ns, start)
            let current = ns.substring(with: NSRange(location: lineStart, length: lineEnd - lineStart))
            inner = ""
            after = ns.substring(from: lineEnd)
            before = current.trimmingCharacters(in: .whitespaces).isEmpty ? ns.substring(to: lineStart) : ns.substring(to: lineEnd) + "\n"
        }
        let head = (before as NSString).length + (opener as NSString).length
        let caret = caretOnOpener ? head : head + 1 + (inner as NSString).length
        return EditState(text: before + opener + "\n" + inner + "\n:::" + after, start: caret, end: caret)
    }

    private static let listLine = try! NSRegularExpression(pattern: #"^(\s*)(?:([-*•])|(\d{1,3})\.)\s(.*)$"#)
    private static let taskItem = try! NSRegularExpression(pattern: #"^(\s*)([-*]) \[[ xX]\](?: (.*))?$"#)
    private static let quoteLine = try! NSRegularExpression(pattern: #"^(>\s?)(.*)$"#)

    /// Return inside a task, list or quote: it goes on on the next line (a task with a new open box, a numbered list
    /// counting up); Return on an empty item ends it instead. nil: Return behaves as usual.
    static func continueStructure(_ state: EditState) -> EditState? {
        let ns = state.text as NSString
        let lineStart = lineStartOffset(ns, state.start)
        let line = ns.substring(with: NSRange(location: lineStart, length: state.start - lineStart))
        let lineNs = line as NSString
        let whole = NSRange(location: 0, length: lineNs.length)
        func group(_ match: NSTextCheckingResult, _ index: Int) -> String? {
            let range = match.range(at: index)
            return range.location == NSNotFound ? nil : lineNs.substring(with: range)
        }
        func endItem() -> EditState {
            EditState(text: ns.replacingCharacters(in: NSRange(location: lineStart, length: state.start - lineStart), with: ""), start: lineStart, end: lineStart)
        }
        func insert(_ inserted: String) -> EditState {
            let caret = state.start + (inserted as NSString).length
            return EditState(text: ns.replacingCharacters(in: NSRange(location: state.start, length: 0), with: inserted), start: caret, end: caret)
        }
        if let task = taskItem.firstMatch(in: line, range: whole) {
            if (group(task, 3) ?? "").trimmingCharacters(in: .whitespaces).isEmpty { return endItem() }
            return insert("\n\(group(task, 1) ?? "")\(group(task, 2) ?? "-") [ ] ")
        }
        if let list = listLine.firstMatch(in: line, range: whole) {
            if (group(list, 4) ?? "").trimmingCharacters(in: .whitespaces).isEmpty { return endItem() }
            let indent = group(list, 1) ?? ""
            if let bullet = group(list, 2) { return insert("\n\(indent)\(bullet) ") }
            return insert("\n\(indent)\((Int(group(list, 3) ?? "0") ?? 0) + 1). ")
        }
        if let quote = quoteLine.firstMatch(in: line, range: whole) {
            if (group(quote, 2) ?? "").trimmingCharacters(in: .whitespaces).isEmpty { return endItem() }
            return insert("\n" + (group(quote, 1) ?? "> "))
        }
        return nil
    }

    // MARK: helpers

    static func isTask(_ line: String) -> Bool {
        taskLine.firstMatch(in: line, range: NSRange(location: 0, length: (line as NSString).length)) != nil
    }

    /// The start of the line holding `offset`.
    static func lineStartOffset(_ text: NSString, _ offset: Int) -> Int {
        guard offset > 0 else { return 0 }
        let found = text.range(of: "\n", options: .backwards, range: NSRange(location: 0, length: min(offset, text.length)))
        return found.location == NSNotFound ? 0 : found.location + 1
    }

    /// The end of the line holding `offset` (its newline, or the end of the text).
    static func lineEndOffset(_ text: NSString, _ offset: Int) -> Int {
        let from = min(max(offset, 0), text.length)
        let found = text.range(of: "\n", range: NSRange(location: from, length: text.length - from))
        return found.location == NSNotFound ? text.length : found.location
    }

    /// The lines a selection touches (a selection ending just after a newline leaves the next line out).
    private static func selectedLines(_ text: NSString, _ start: Int, _ end: Int) -> (Int, Int) {
        (lineStartOffset(text, start), lineEndOffset(text, max(end - 1, start)))
    }

    /// The offset of line `index` (0-based) in `lines` joined with newlines.
    private static func lineOffset(_ lines: [String], _ index: Int) -> Int {
        lines[..<min(index, lines.count)].reduce(0) { $0 + ($1 as NSString).length + 1 }
    }
}
