import SwiftUI

/// Message body format (DATA_MODEL.md "本文の形式"): plain text plus a light markdown subset shared with the other clients.
enum BodyToken: Equatable {
    case text(String)
    case bold(String)
    case italic(String)
    case strike(String)
    case code(String)
    case codeBlock(String, lang: String? = nil)
    case link(String, label: String? = nil)
    case mention(String)
    case mentionGroup(String)
    case mentionAll(String)
    /// TeX math (apps/shared/math.json): the formula as written; `display` for `$$…$$` within a line.
    case math(String, display: Bool = false)
    case newline
}

/// One list item (apps/shared/lists.json): its level (0–2), its kind, its number (0 for a bullet) and the marker drawn.
struct BodyListItem: Equatable {
    let level: Int
    var ordered: Bool = false
    var number: Int = 0
    var marker: String = "•"
    let tokens: [BodyToken]
}

/// A task of the canvas dialect (CANVAS.md §4.2); `line` is its line in the body (0-based), which a tick changes.
struct BodyTaskItem: Equatable {
    let level: Int
    let done: Bool
    let tokens: [BodyToken]
    let line: Int
}

enum BodyBlock: Equatable {
    case heading(Int, [BodyToken])
    case paragraph([[BodyToken]])
    /// Quoted lines (">" and one space stripped) as paragraphs and lists (apps/shared/lists.json `quoted`).
    case quote([BodyBlock])
    case list(ordered: Bool, start: Int, items: [BodyListItem])
    case codeBlock(String, lang: String?)
    /// Display math: `$$…$$` on a line (or lines) of its own (apps/shared/math.json).
    case math(String)
    /// M15g: a GFM table; rows have exactly as many cells as the header.
    case table(align: [BodyTableAlign], header: [[BodyToken]], rows: [[[BodyToken]]])
    // The canvas dialect (CANVAS.md §4.2, `canvas: true`; messages keep these as text).
    case task([BodyTaskItem])
    /// `![alt](attachment:<uuid>)` on a line of its own: an image of the canvas (other image URLs stay text).
    case image(alt: String, attachmentId: String, line: Int)
    /// `---` between blank lines.
    case rule
    // M149 (WIKI.md §22.5, apps/shared/canvas_markdown.json `containers`): the containers and the embedded database.
    /// `::: callout [icon]` … `:::`: its blocks (each with its line in the whole body) in a tinted box.
    case callout(icon: String?, tone: CalloutTone, blocks: [BodyLinedBlock])
    /// `::: toggle [title]` … `:::`: a title that opens and closes its blocks (the state is the device's).
    case toggle(title: [BodyToken], blocks: [BodyLinedBlock])
    /// `![label](page:<uuid>#view=<id>)` on a line of its own: a database (its view, nil: the first one); the id lower case.
    case embed(label: String, pageId: String, viewId: String?, line: Int)
}

/// A block with the line it starts on in the whole body (0-based): a container's blocks keep their lines (tasks tick
/// them, headings are the outline's anchors).
struct BodyLinedBlock: Equatable {
    let block: BodyBlock
    let line: Int
}

/// M149: a callout's tint, from its icon (apps/shared/canvas_markdown.json `containers.tones`): the icon without U+FE0F
/// looked up; anything else, a custom `:name:` and no icon are gray.
enum CalloutTone: String, Equatable, CaseIterable {
    case gray, yellow, red, green, blue

    static let icons: [CalloutTone: [String]] = [
        .yellow: ["💡", "⚠", "⭐", "🔔", "✨"],
        .red: ["❗", "‼", "🚨", "❌", "⛔", "🚫", "🔥"],
        .green: ["✅", "✔", "🌱", "👍", "🎉", "⭕"],
        .blue: ["ℹ", "📝", "💬", "📌", "❓", "🔍", "📘"],
    ]

    private static let byIcon: [String: CalloutTone] = {
        var out: [String: CalloutTone] = [:]
        for (tone, list) in icons { for icon in list { out[icon] = tone } }
        return out
    }()

    static func of(_ icon: String?) -> CalloutTone {
        guard let icon else { return .gray }
        var scalars = String.UnicodeScalarView()
        scalars.append(contentsOf: icon.unicodeScalars.filter { $0 != "\u{FE0F}" })
        return byIcon[String(scalars)] ?? .gray
    }
}

/// M15g: a column's alignment from its separator cell (":--" left, ":-:" center, "--:" right).
enum BodyTableAlign: Equatable {
    case none, left, center, right
}

enum BodyTokenizer {
    // M107 (apps/shared/inline-format.json): `_` emphasis follows CommonMark's word rule: the opening `_` is not preceded and
    // the closing one not followed by a letter, digit or `_`, so snake_case and e-mail addresses stay as they are.
    // `\_` `\*` `\~` `\`` are the literal character (also inside emphasis). E-mail addresses (and the shrug, which keeps its
    // backslash) are text tokens of their own, so emphasis and escapes are never read inside them.
    private static let inline = #"(\*\*((?:\\.|[^*\n\\])+?)\*\*)|(``(?!`)(?:[^`\n]|`(?!`))+?``(?!`)|`([^`\n]+)`)|(\*((?:\\.|[^*\n\\])+)\*)|((?<![\p{L}\p{N}_])_(?![\s\u3000_])((?:\\.|[^\n\\])*?(?:\\.|[^\s\u3000_\\]))_(?![\p{L}\p{N}_]))|(~~((?:\\.|[^~\n\\])+)~~)|(\[([^\]\n]+)\]\((https?://[^\s)]+|(?:page|attachment):[0-9a-fA-F-]{36})\))|(<@group:([0-9a-f-]{36})>)|(<@([0-9a-f-]{36})>)|(<!(channel|here)>)|(https?://[^\s<>]+)|(\\([_*~`$]))|([A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,8}|¯\\_\(ツ\)_/¯)|(\$\$((?:\\.|[^$\n\\])+?)\$\$)|(\$(?![\s$])((?:\\.|[^$\n\\])*?(?:\\.|[^\s$\\]))\$(?![0-9A-Za-z]))"#
    private static let escaped = try! NSRegularExpression(pattern: #"\\([_*~`$])"#)

    /// TeX math (apps/shared/math.json, markdown.ts MATH_MAX_LENGTH): inline `$…$` as Pandoc reads it (the opening `$`
    /// before a non-space, the closing one after a non-space and not before a digit or an ASCII letter), `$$…$$` within a
    /// line, and display blocks (`mathBlock`). A formula longer than this stays text.
    static let mathMaxLength = 2000
    private static let inlinePattern = try! NSRegularExpression(pattern: inline)
    private static let fullPattern = try! NSRegularExpression(pattern: #"(```([\s\S]*?)```)|"# + inline + #"|(\n)"#)
    private static let fenceOpen = try! NSRegularExpression(pattern: #"^```([A-Za-z0-9_+#.-]{0,20})\s*$"#)
    private static let fenceClose = try! NSRegularExpression(pattern: #"^```\s*$"#)
    private static let bullet = try! NSRegularExpression(pattern: #"^(\s*)[-*•]\s+(.*)$"#)
    private static let numbered = try! NSRegularExpression(pattern: #"^(\s*)(\d{1,3})\.\s+(.*)$"#)
    private static let quote = try! NSRegularExpression(pattern: #"^>\s?(.*)$"#)
    private static let heading = try! NSRegularExpression(pattern: #"^(#{1,3})\s+(\S.*)$"#)
    private static let tableSeparator = try! NSRegularExpression(pattern: #"^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$"#)
    // The canvas dialect (CANVAS.md §4.2), as markdown.ts: tasks as the server counts them, images of the canvas, rules.
    private static let imageLine = try! NSRegularExpression(pattern: #"^!\[([^\]\n]*)\]\(attachment:([0-9a-f-]{36})\)\s*$"#)
    private static let ruleLine = try! NSRegularExpression(pattern: #"^-{3,}\s*$"#)
    // M149 (apps/shared/canvas_markdown.json `containers`): callouts and toggles (two deep at most), embedded databases.
    private static let containerOpen = try! NSRegularExpression(pattern: #"^:::[ \t]*(callout|toggle)(?:[ \t]+(.*?))?[ \t]*$"#)
    private static let containerClose = try! NSRegularExpression(pattern: #"^:::[ \t]*$"#)
    private static let embedLine = try! NSRegularExpression(
        pattern: #"^!\[([^\]\n]*)\]\(page:([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(?:#view=([A-Za-z0-9_-]{1,40}))?\)\s*$"#)
    /// Containers nest this deep at most (a toggle in a callout); inside the deepest an opener and its close are text.
    static let containerDepth = 2

    /// M15g: the cells of a table row; "\|" is a literal pipe, outer pipes are optional.
    static func splitTableRow(_ line: String) -> [String] {
        var text = line.trimmingCharacters(in: .whitespaces)
        if text.hasPrefix("|") { text.removeFirst() }
        if text.hasSuffix("|") && !text.hasSuffix("\\|") { text.removeLast() }
        var cells: [String] = []
        var current = ""
        let chars = Array(text)
        var index = 0
        while index < chars.count {
            let ch = chars[index]
            if ch == "\\", index + 1 < chars.count, chars[index + 1] == "|" {
                current.append("|")
                index += 2
                continue
            }
            if ch == "|" {
                cells.append(current.trimmingCharacters(in: .whitespaces))
                current = ""
            } else {
                current.append(ch)
            }
            index += 1
        }
        cells.append(current.trimmingCharacters(in: .whitespaces))
        return cells
    }

    private static func tableAlign(_ cell: String) -> BodyTableAlign {
        let left = cell.hasPrefix(":"), right = cell.hasSuffix(":")
        return left && right ? .center : right ? .right : left ? .left : .none
    }

    /// Whole-body tokens (inline markup, fenced code and newlines); kept for the search highlighter and tests.
    static func tokenize(_ body: String) -> [BodyToken] { scan(body, pattern: fullPattern, withBlocks: true) }

    /// Inline tokens of a single line.
    static func tokenizeInline(_ line: String) -> [BodyToken] { scan(line, pattern: inlinePattern, withBlocks: false) }

    private static func scan(_ body: String, pattern: NSRegularExpression, withBlocks: Bool) -> [BodyToken] {
        var tokens: [BodyToken] = []
        let ns = body as NSString
        var last = 0
        func text(_ value: String) {
            guard !value.isEmpty else { return }
            if case .text(let previous)? = tokens.last { tokens[tokens.count - 1] = .text(previous + value) } else { tokens.append(.text(value)) }
        }
        func unescape(_ value: String) -> String {
            escaped.stringByReplacingMatches(in: value, range: NSRange(location: 0, length: (value as NSString).length), withTemplate: "$1")
        }
        for match in pattern.matches(in: body, range: NSRange(location: 0, length: ns.length)) {
            text(ns.substring(with: NSRange(location: last, length: match.range.location - last)))
            func group(_ index: Int) -> String? {
                let shifted = withBlocks ? index + 2 : index
                let range = match.range(at: shifted)
                return range.location == NSNotFound ? nil : ns.substring(with: range)
            }
            func raw(_ index: Int) -> String? {
                let range = match.range(at: index)
                return range.location == NSNotFound ? nil : ns.substring(with: range)
            }
            if withBlocks, raw(1) != nil {
                let (text, lang) = splitFence(raw(2) ?? "")
                tokens.append(.codeBlock(text, lang: lang))
            } else if group(1) != nil { tokens.append(.bold(unescape(group(2) ?? ""))) }
            else if let whole = group(3) { tokens.append(.code(codeSpan(whole, single: group(4)))) }
            else if group(5) != nil { tokens.append(.bold(unescape(group(6) ?? ""))) }
            else if group(7) != nil { tokens.append(.italic(unescape(group(8) ?? ""))) }
            else if group(9) != nil { tokens.append(.strike(unescape(group(10) ?? ""))) }
            else if group(11) != nil { tokens.append(.link(group(13) ?? "", label: group(12))) }
            else if group(14) != nil { tokens.append(.mentionGroup(group(15) ?? "")) }
            else if group(16) != nil { tokens.append(.mention(group(17) ?? "")) }
            else if group(18) != nil { tokens.append(.mentionAll(group(19) ?? "")) }
            else if let url = group(20) { tokens.append(.link(url)) }
            else if group(21) != nil { text(group(22) ?? "") }
            else if let literal = group(23) { text(literal) }
            else if group(24) != nil || group(26) != nil {
                // TeX math: too long or blank, it stays the text it was.
                let display = group(24) != nil
                let tex = (display ? group(25) : group(27)) ?? ""
                if tex.count > mathMaxLength || tex.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    text(ns.substring(with: match.range))
                } else {
                    tokens.append(.math(tex, display: display))
                }
            }
            else { tokens.append(.newline) }
            last = match.range.location + match.range.length
        }
        if last < ns.length { text(ns.substring(from: last)) }
        return tokens
    }

    /// What a reader sees of an inline token as text; mention tokens stay as they are (callers name them first).
    static func inlineText(_ token: BodyToken) -> String {
        switch token {
        case .text(let text), .bold(let text), .italic(let text), .strike(let text), .code(let text): return text
        case .codeBlock(let text, _): return text
        case .link(let url, let label): return label ?? url
        case .mention(let id): return "<@\(id)>"
        case .mentionGroup(let id): return "<@group:\(id)>"
        case .mentionAll(let target): return "<!\(target)>"
        case .math(let tex, let display): return display ? "$$\(tex)$$" : "$\(tex)$" // the source as written
        case .newline: return "\n"
        }
    }

    /// Display math starting at `lines[index]` (apps/shared/math.json, markdown.ts mathBlockAt): its formula and its last
    /// line. `$$` starts the line (spaces around are ignored) and a later line ends with `$$`, no blank line and no other
    /// `$$` between; one line `$$tex$$` is a block too.
    /// `limit`: the search stops before this line (a container's close; nil: the end of the body).
    static func mathBlock(_ lines: [String], at index: Int, limit: Int? = nil) -> (tex: String, end: Int)? {
        let first = lines[index].trimmingCharacters(in: .whitespaces)
        guard first.hasPrefix("$$") else { return nil }
        func done(_ tex: String, _ end: Int) -> (tex: String, end: Int)? {
            let trimmed = tex.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty || trimmed.count > mathMaxLength ? nil : (trimmed, end)
        }
        if first.count >= 4, first.hasSuffix("$$") {
            let tex = String(first.dropFirst(2).dropLast(2))
            return tex.contains("$$") ? nil : done(tex, index)
        }
        let head = String(first.dropFirst(2))
        if head.contains("$$") { return nil }
        var k = index + 1
        while k < min(limit ?? lines.count, lines.count) {
            let trimmed = lines[k].trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty { return nil } // a blank line ends the search: the $$ was not math
            if trimmed.contains("$$") {
                let tail = String(trimmed.dropLast(2))
                if !trimmed.hasSuffix("$$") || tail.contains("$$") { return nil }
                return done(([head] + lines[(index + 1)..<k] + [tail]).joined(separator: "\n"), k)
            }
            k += 1
        }
        return nil
    }

    private static func splitFence(_ raw: String) -> (String, String?) {
        let lines = raw.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        if lines.count > 1, let first = lines.first, !first.isEmpty, first.range(of: #"^[A-Za-z0-9_+#.-]{1,20}$"#, options: .regularExpression) != nil {
            var rest = lines.dropFirst().joined(separator: "\n")
            if rest.hasSuffix("\n") { rest.removeLast() }
            return (straightQuotes(rest), first.lowercased())
        }
        var text = raw
        if text.hasPrefix("\n") { text.removeFirst() }
        if text.hasSuffix("\n") { text.removeLast() }
        return (straightQuotes(text), nil)
    }

    /// The text of an inline code span (apps/shared/inline-format.json, markdown.ts codeSpan): `single` is the text
    /// between single backticks; otherwise `whole` is a ``double`` span, which may hold a backtick and loses one space at
    /// each end when it has one at both ("`` ` ``" is a backtick).
    static func codeSpan(_ whole: String, single: String?) -> String {
        if let single { return straightQuotes(single) }
        var inner = String(whole.dropFirst(2).dropLast(2))
        if inner.count >= 2, inner.hasPrefix(" "), inner.hasSuffix(" "), !inner.trimmingCharacters(in: .whitespaces).isEmpty {
            inner = String(inner.dropFirst().dropLast())
        }
        return straightQuotes(inner)
    }

    /// Code shows the quotes a keyboard curled back straight (2026-10-06): the composer's smart punctuation and the
    /// Japanese keyboards turn ' and " into ‘ ’ “ ”, so `it's` arrived as `it’s`.
    static func straightQuotes(_ text: String) -> String {
        guard text.contains(where: { "‘’“”".contains($0) }) else { return text }
        return String(text.map { $0 == "‘" || $0 == "’" ? "'" : $0 == "“" || $0 == "”" ? "\"" : $0 })
    }

    /// The composer's text before it is sent or saved (2026-10-06): the TextField's smart punctuation (which cannot be
    /// turned off) curls ' and " into ‘ ’ “ ” and turns -- into — (and - into –). Inside code — inline spans and fenced
    /// blocks, found as parseBlocks and the inline pattern find them — those go back to what was typed; the rest of the
    /// text stays as it is. An unclosed backtick or fence is not code, so nothing changes there.
    static func straightenCode(_ body: String) -> String {
        guard body.contains(where: { "‘’“”—–".contains($0) }) else { return body }
        let lines = body.components(separatedBy: "\n")
        var out: [String] = []
        var i = 0
        while i < lines.count {
            if firstMatch(fenceOpen, lines[i]) != nil,
               let close = ((i + 1)..<lines.count).first(where: { firstMatch(fenceClose, lines[$0]) != nil }) {
                out.append(lines[i])
                out += lines[(i + 1)..<close].map(straightPunctuation)
                out.append(lines[close])
                i = close + 1
                continue
            }
            let line = NSMutableString(string: lines[i])
            for match in inlinePattern.matches(in: lines[i], range: NSRange(location: 0, length: line.length)).reversed() {
                let code = match.range(at: 3)
                guard code.location != NSNotFound else { continue }
                line.replaceCharacters(in: code, with: straightPunctuation(line.substring(with: code)))
            }
            out.append(line as String)
            i += 1
        }
        return out.joined(separator: "\n")
    }

    /// ‘ ’ “ ” — – as the keyboard had them before smart punctuation: ' " -- -.
    static func straightPunctuation(_ text: String) -> String {
        var out = ""
        for ch in text {
            switch ch {
            case "‘", "’": out.append("'")
            case "“", "”": out.append("\"")
            case "—": out.append("--")
            case "–": out.append("-")
            default: out.append(ch)
            }
        }
        return out
    }

    /// List lines as list blocks (`from`: the row of its first item): a top-level item of the other kind starts a new
    /// list (as in CommonMark).
    static func listBlocks(_ rows: [ListLine]) -> [(block: BodyBlock, from: Int)] {
        let items = listItems(rows)
        var out: [(block: BodyBlock, from: Int)] = []
        var from = 0
        for k in 1...max(items.count, 1) where !items.isEmpty {
            if k < items.count, !(items[k].level == 0 && items[k].ordered != items[from].ordered) { continue }
            let run = Array(items[from..<k])
            out.append((.list(ordered: run[0].ordered, start: run[0].ordered ? run[0].number : 1, items: run), from))
            from = k
        }
        return out
    }

    /// A quote's lines (its ">" and one space stripped) as paragraphs and lists, read as at the top level: a run of list
    /// lines is a list (nested by indent, numbered, the other kind a new list); any other line, a blank one too, is a
    /// paragraph line (apps/shared/lists.json `quoted`, as markdown.ts quoteBlocks).
    static func quoteBlocks(_ quoted: [String]) -> [BodyBlock] {
        var out: [BodyBlock] = []
        var i = 0
        while i < quoted.count {
            var rows: [ListLine] = []
            while i < quoted.count, let row = listLine(quoted[i]) {
                rows.append(row)
                i += 1
            }
            if !rows.isEmpty {
                out += listBlocks(rows).map(\.block)
                continue
            }
            var paragraph: [[BodyToken]] = []
            while i < quoted.count, paragraph.isEmpty || listLine(quoted[i]) == nil {
                paragraph.append(tokenizeInline(quoted[i]))
                i += 1
            }
            out.append(.paragraph(paragraph))
        }
        return out
    }

    /// A list line: its indent (a tab is 4 columns), its kind, the number written ("3." → 3) and its text.
    struct ListLine {
        let indent: Int
        let ordered: Bool
        let written: Int
        let text: String
    }

    static func listLine(_ line: String) -> ListLine? {
        func width(_ indent: String) -> Int { indent.replacingOccurrences(of: "\t", with: "    ").count }
        if let m = firstMatch(numbered, line) {
            return ListLine(indent: width(group(m, 1, in: line)), ordered: true, written: Int(group(m, 2, in: line)) ?? 1, text: group(m, 3, in: line))
        }
        if let m = firstMatch(bullet, line) {
            return ListLine(indent: width(group(m, 1, in: line)), ordered: false, written: 0, text: group(m, 2, in: line))
        }
        return nil
    }

    static let listLevels = 3

    /// Levels, numbers and markers of consecutive list lines (apps/shared/lists.json, as markdown.ts listItems): an item
    /// indented 2 or more columns past the one before nests one level deeper (2–4 spaces or a tab, three levels at most);
    /// a smaller indent goes back to the level it matches. Each run of items of one kind at one level under one parent
    /// is a list of its own: it starts at the number its first item is written with and counts on by one; a nested
    /// list starts again under every parent item. Numbers are 1. / a. / i. by level, bullets • / ◦ / ▪.
    static func listItems(_ rows: [ListLine]) -> [BodyListItem] {
        var indents: [Int] = []
        var counters: [(ordered: Bool, next: Int)?] = []
        return rows.map { row in
            if indents.isEmpty {
                indents.append(row.indent)
            } else {
                while indents.count > 1, row.indent < indents[indents.count - 1] { indents.removeLast() }
                if row.indent >= indents[indents.count - 1] + 2, indents.count < listLevels { indents.append(row.indent) }
            }
            let level = indents.count - 1
            if counters.count > level + 1 { counters.removeLast(counters.count - level - 1) } // deeper lists end here
            while counters.count < level + 1 { counters.append(nil) }
            let number: Int
            if !row.ordered { number = 0 } else if let counter = counters[level], counter.ordered { number = counter.next } else { number = row.written }
            counters[level] = (row.ordered, number + 1)
            return BodyListItem(level: level, ordered: row.ordered, number: number, marker: listMarker(ordered: row.ordered, level: level, number: number),
                                tokens: tokenizeInline(row.text))
        }
    }

    /// "1." / "a." / "i." by level (a number below 1 stays decimal), "•" / "◦" / "▪" for bullets.
    static func listMarker(ordered: Bool, level: Int, number: Int) -> String {
        if !ordered { return ["•", "◦", "▪"][min(level, 2)] }
        if level == 1, number >= 1 {
            var out = ""
            var k = number
            while k > 0 {
                out = String(UnicodeScalar(UInt8(97 + (k - 1) % 26))) + out
                k = (k - 1) / 26
            }
            return out + "."
        }
        if level >= 2, number >= 1, number < 4000 {
            let table: [(Int, String)] = [(1000, "m"), (900, "cm"), (500, "d"), (400, "cd"), (100, "c"), (90, "xc"), (50, "l"), (40, "xl"), (10, "x"), (9, "ix"), (5, "v"), (4, "iv"), (1, "i")]
            var out = ""
            var k = number
            for (value, letters) in table { while k >= value { out += letters; k -= value } }
            return out + "."
        }
        return "\(number)."
    }

    private static func firstMatch(_ regex: NSRegularExpression, _ line: String) -> NSTextCheckingResult? {
        regex.firstMatch(in: line, range: NSRange(location: 0, length: (line as NSString).length))
    }

    private static func group(_ match: NSTextCheckingResult, _ index: Int, in line: String) -> String {
        let range = match.range(at: index)
        return range.location == NSNotFound ? "" : (line as NSString).substring(with: range)
    }

    /// Block structure for rendering: paragraphs, quotes, lists and fenced code, in order. `canvas`: the canvas dialect
    /// (tasks, images, rules, callouts, toggles and embedded databases; apps/shared/canvas_markdown.json).
    static func parseBlocks(_ body: String, canvas: Bool = false) -> [BodyBlock] {
        parseLinedBlocks(body, canvas: canvas).map(\.block)
    }

    /// The blocks with the line each starts on (0-based): a canvas's outline and section editing find its headings.
    static func parseLinedBlocks(_ body: String, canvas: Bool = false) -> [(block: BodyBlock, line: Int)] {
        let split = body.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n").components(separatedBy: "\n")
        // M83 (CANVAS.md §22): a canvas's task markers are never shown; the lines stay where they are (a tick still
        // changes its line of the stored body, the marker with it).
        let lines = canvas ? split.map(CanvasMarkers.strip) : split
        return linedBlocks(lines, from: 0, to: lines.count, canvas: canvas, depth: 0)
    }

    /// The blocks of `lines[from..<to]`, read as a body of their own (a container's inside is read as the top level) with
    /// the lines of the whole body; `depth`: the containers around them.
    private static func linedBlocks(_ lines: [String], from lo: Int, to hi: Int, canvas: Bool, depth: Int) -> [(block: BodyBlock, line: Int)] {
        func blank(_ index: Int) -> Bool { index < 0 || index >= hi || lines[index].trimmingCharacters(in: .whitespaces).isEmpty }
        func isTask(_ index: Int) -> Bool { canvas && index < hi && firstMatch(CanvasText.taskLine, lines[index]) != nil }
        func isImage(_ index: Int) -> Bool { canvas && firstMatch(imageLine, lines[index]) != nil }
        func isEmbed(_ index: Int) -> Bool { canvas && firstMatch(embedLine, lines[index]) != nil }
        func isRule(_ index: Int) -> Bool { canvas && firstMatch(ruleLine, lines[index]) != nil && blank(index - 1) && blank(index + 1) }
        func fenceCloseAfter(_ index: Int) -> Int? {
            ((index + 1)..<max(index + 1, hi)).first { firstMatch(fenceClose, lines[$0]) != nil }
        }
        func opensFence(_ index: Int) -> Bool { firstMatch(fenceOpen, lines[index]) != nil && fenceCloseAfter(index) != nil }
        // M15g: a header row with a pipe, directly followed by a separator with as many cells.
        func opensTable(_ index: Int) -> Bool {
            guard index + 1 < hi, lines[index].contains("|"), firstMatch(tableSeparator, lines[index + 1]) != nil else { return false }
            return splitTableRow(lines[index]).count == splitTableRow(lines[index + 1]).count
        }
        // M149: the close of a container opened on `index`: scanning down counting openers and closes, fenced code
        // skipped; nil (the opener is a text line) without one, in a message, or inside the deepest container.
        func containerEnd(_ index: Int) -> Int? {
            guard canvas, depth < containerDepth, firstMatch(containerOpen, lines[index]) != nil else { return nil }
            var open = 1
            var k = index + 1
            while k < hi {
                if firstMatch(fenceOpen, lines[k]) != nil, let close = fenceCloseAfter(k) {
                    k = close + 1
                    continue
                }
                if firstMatch(containerOpen, lines[k]) != nil {
                    open += 1
                } else if firstMatch(containerClose, lines[k]) != nil {
                    open -= 1
                    if open == 0 { return k }
                }
                k += 1
            }
            return nil
        }
        var lined: [(block: BodyBlock, line: Int)] = []
        var i = lo
        while i < hi {
            let line = lines[i]
            let first = i
            func append(_ block: BodyBlock) { lined.append((block, first)) }
            if opensFence(i), let open = firstMatch(fenceOpen, line), let close = fenceCloseAfter(i) {
                let lang = group(open, 1, in: line)
                append(.codeBlock(straightQuotes(lines[(i + 1)..<close].joined(separator: "\n")), lang:lang.isEmpty ? nil : lang.lowercased()))
                i = close + 1
                continue
            }
            if let close = containerEnd(i), let open = firstMatch(containerOpen, line) {
                let rest = group(open, 2, in: line).trimmingCharacters(in: .whitespaces)
                let inner = linedBlocks(lines, from: i + 1, to: close, canvas: canvas, depth: depth + 1).map { BodyLinedBlock(block: $0.block, line: $0.line) }
                if group(open, 1, in: line) == "callout" {
                    append(.callout(icon: rest.isEmpty ? nil : rest, tone: CalloutTone.of(rest.isEmpty ? nil : rest), blocks: inner))
                } else {
                    append(.toggle(title: tokenizeInline(rest), blocks: inner))
                }
                i = close + 1
                continue
            }
            if isEmbed(i), let m = firstMatch(embedLine, line) {
                let view = group(m, 3, in: line)
                append(.embed(label: group(m, 1, in: line), pageId: group(m, 2, in: line).lowercased(), viewId: view.isEmpty ? nil : view, line: i))
                i += 1
                continue
            }
            if let math = mathBlock(lines, at: i, limit: hi) {
                append(.math(math.tex))
                i = math.end + 1
                continue
            }
            if let h = firstMatch(heading, line) {
                append(.heading(group(h, 1, in: line).count, tokenizeInline(group(h, 2, in: line))))
                i += 1
                continue
            }
            if isTask(i) {
                var items: [BodyTaskItem] = []
                while i < hi, let m = firstMatch(CanvasText.taskLine, lines[i]) {
                    let indent = group(m, 1, in: lines[i]).replacingOccurrences(of: "\t", with: "  ").count
                    items.append(BodyTaskItem(level: indent >= 2 ? 1 : 0, done: group(m, 2, in: lines[i]) != " ",
                                              tokens: tokenizeInline(group(m, 3, in: lines[i])), line: i))
                    i += 1
                }
                append(.task(items))
                continue
            }
            if isImage(i), let m = firstMatch(imageLine, line) {
                append(.image(alt: group(m, 1, in: line), attachmentId: group(m, 2, in: line), line: i))
                i += 1
                continue
            }
            if isRule(i) {
                append(.rule)
                i += 1
                continue
            }
            if firstMatch(quote, line) != nil {
                var quoted: [String] = []
                // A line without ">" ends the quote (no lazy continuation: a reply often follows a quote).
                while i < hi, let q = firstMatch(quote, lines[i]) {
                    quoted.append(group(q, 1, in: lines[i]))
                    i += 1
                }
                append(.quote(quoteBlocks(quoted)))
                continue
            }
            if opensTable(i) {
                let header = splitTableRow(line)
                let align = splitTableRow(lines[i + 1]).map(tableAlign)
                var rows: [[[BodyToken]]] = []
                i += 2
                while i < hi, lines[i].contains("|"),!lines[i].trimmingCharacters(in: .whitespaces).isEmpty {
                    let cells = splitTableRow(lines[i])
                    rows.append(header.indices.map { tokenizeInline($0 < cells.count ? cells[$0] : "") }) // short rows pad, long rows are cut (GFM)
                    i += 1
                }
                append(.table(align: align, header: header.map(tokenizeInline), rows: rows))
                continue
            }
            if listLine(line) != nil {
                var rows: [ListLine] = []
                while i < hi, !isTask(i), let row = listLine(lines[i]) {
                    rows.append(row)
                    i += 1
                }
                // Each list keeps the line of its first item.
                for run in listBlocks(rows) { lined.append((run.block, first + run.from)) }
                continue
            }
            var paragraph: [[BodyToken]] = []
            while i < hi {
                let current = lines[i]
                if !paragraph.isEmpty, opensFence(i) || opensTable(i) || firstMatch(heading, current) != nil || firstMatch(quote, current) != nil || firstMatch(bullet, current) != nil || firstMatch(numbered, current) != nil || isImage(i) || isEmbed(i) || isRule(i) || mathBlock(lines, at: i, limit: hi) != nil || containerEnd(i) != nil { break }
                paragraph.append(tokenizeInline(current))
                i += 1
            }
            append(.paragraph(paragraph))
        }
        return lined
    }

    /// How a paragraph block is drawn (apps/shared/body-paragraphs.json, the same in the three clients).
    struct ParagraphLayout: Equatable {
        /// Blank lines before / after it: a paragraph gap there, separating it from the block before / after.
        let gapBefore: Bool
        let gapAfter: Bool
        /// The runs of lines between blank lines; empty when the paragraph is only blank lines (then it is one gap).
        let groups: [[[BodyToken]]]
    }

    /// 2026-10-05: one newline is a line break; one or more blank lines are a paragraph gap (about 0.4 of a line) rather
    /// than empty lines, several blank lines collapsing into one gap (as in Slack and markdown). A line of spaces is blank.
    static func paragraphLayout(_ lines: [[BodyToken]]) -> ParagraphLayout {
        func blank(_ tokens: [BodyToken]) -> Bool {
            tokens.allSatisfy { if case .text(let s) = $0 { return s.trimmingCharacters(in: .whitespaces).isEmpty } else { return false } }
        }
        var groups: [[[BodyToken]]] = []
        var current: [[BodyToken]] = []
        for row in lines {
            if blank(row) {
                if !current.isEmpty { groups.append(current) }
                current = []
            } else {
                current.append(row)
            }
        }
        if !current.isEmpty { groups.append(current) }
        guard let first = lines.first, let last = lines.last, !groups.isEmpty else { return ParagraphLayout(gapBefore: false, gapAfter: false, groups: []) }
        return ParagraphLayout(gapBefore: blank(first), gapAfter: blank(last), groups: groups)
    }
}

struct MessageBodyView: View {
    let text: String
    let users: [String: UserPublic]
    /// M12k: user groups by id, for `<@group:id>`.
    var groups: [String: GroupOut] = [:]
    /// M12b: links on this server (`<base>/m/<id>`) become in-app links; the row's `openURL` handler reveals the message.
    var internalBase: URL? = nil
    /// M12f: custom emoji by name and their cached images; `onNeedEmojiImage` fetches a missing one.
    var customEmoji: [String: CustomEmojiOut] = [:]
    var emojiImages: [String: UIImage] = [:]
    /// The animated ones' frames by id: a body with one of them is drawn again as its frames change (GIF).
    var emojiAnimations: [String: EmojiAnimation] = [:]
    var onNeedEmojiImage: ((CustomEmojiOut) -> Void)? = nil
    /// M12g: my notification keywords, highlighted where they occur (as on the web; M28d).
    var keywords: [String] = []
    /// M45: blocks parsed already (a canvas draws its own blocks and hands the others over one by one); `text` is then
    /// only read for its custom emoji.
    var preparsed: [BodyBlock]? = nil
    /// M71: a message link labelled with a number is an AI answer's citation, drawn as 「[n]」.
    var citations = false
    /// M101 (docs/EMOJI.md §7): an emoji-only body is shown large (the timeline and threads only, not previews).
    var jumbo = false
    /// A mention of someone known is a link (UserLink) the row turns into their profile; where nothing handles it
    /// (previews, search results) mentions stay plain text.
    var userLinks = false
    /// M122 (docs/WIKI.md §3.3): what a wiki page link (`page:<id>`, `<server>/p/<id>`) shows — the page's icon and title
    /// now, 「表示できないページ」, or (nil) its own label while not known.
    var pageLabel: ((String) -> WikiHub.LinkState?)? = nil

    /// The animated custom emoji in this text, by id.
    private var animatedHere: [String: EmojiAnimation] {
        guard !emojiAnimations.isEmpty, text.contains(":") else { return [:] }
        var found: [String: EmojiAnimation] = [:]
        for case .emoji(let name) in CustomEmoji.split(text, known: { customEmoji[$0] != nil }) {
            if let id = customEmoji[name]?.id, let animation = emojiAnimations[id] { found[id] = animation }
        }
        return found
    }

    var body: some View {
        let animated = animatedHere
        let only = jumbo ? EmojiOnly.parse(text, custom: customEmoji) : nil
        if let only, only.stamp {
            stampView  // EmojiImage moves an animated one itself
        } else if animated.isEmpty {
            content(only)
        } else {
            TimelineView(.animation(minimumInterval: 0.04)) { context in
                var moment = self
                let _ = animated.forEach { id, animation in moment.emojiImages[id] = animation.frame(at: context.date.timeIntervalSinceReferenceDate) }
                moment.content(only)
            }
        }
    }

    @ViewBuilder
    private func content(_ only: EmojiOnly.Result?) -> some View {
        if only != nil { jumboText } else { blocks }
    }

    /// M101: an emoji-only body, large: standard emoji at `Jumbo.font`, image emoji `Jumbo.image` high (a wide one wider,
    /// at most 3:1), text emoji as `Jumbo.pill` pills, pack emoji `Jumbo.pack` high. A blank of the same size holds an
    /// image's place until it is cached (nothing moves when it comes); the line grows to hold the tallest.
    private var jumboText: some View {
        let typed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let pieces = CustomEmoji.split(Emoji.replaceShortcodes(typed), known: { customEmoji[$0] != nil })
        let line = pieces.reduce(Text("")) { acc, piece in
            switch piece {
            case .text(let run): return acc + Text(run).font(.system(size: EmojiOnly.Jumbo.font))
            case .emoji(let name):
                guard let emoji = customEmoji[name] else { return acc + Text(":\(name):") }
                let height = emoji.isText ? EmojiOnly.Jumbo.pill : emoji.packId != nil ? EmojiOnly.Jumbo.pack : EmojiOnly.Jumbo.image
                if let image = emojiImages[emoji.id] { return acc + Text(Image(uiImage: CustomEmoji.sized(image, height: height))) }
                onNeedEmojiImage?(emoji)
                return acc + Text(Image(uiImage: CustomEmoji.blank(size: CustomEmoji.size(of: emoji, height: height))))
            }
        }
        return line
            .fixedSize(horizontal: false, vertical: true)
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .combine)
    }

    /// M101: a single pack emoji as a stamp, `Jumbo.stamp` high (its ratio kept, at most 3:1); its box is held while
    /// the image loads.
    @ViewBuilder
    private var stampView: some View {
        if let name = CustomEmoji.split(text.trimmingCharacters(in: .whitespacesAndNewlines), known: { customEmoji[$0] != nil })
            .compactMap({ if case .emoji(let name) = $0 { return name } else { return nil } }).first,
           let emoji = customEmoji[name] {
            let size = CustomEmoji.size(of: emoji, height: EmojiOnly.Jumbo.stamp)
            Group {
                if let still = emojiImages[emoji.id] {
                    EmojiImage(still: still, animation: emojiAnimations[emoji.id])
                } else {
                    Color.clear.onAppear { onNeedEmojiImage?(emoji) }
                }
            }
            .frame(width: size.width, height: size.height)
            .accessibilityLabel(emoji.label ?? ":\(emoji.name):")
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var blocks: some View {
        VStack(alignment: .leading, spacing: Self.blockSpacing) {
            ForEach(Array((preparsed ?? BodyTokenizer.parseBlocks(text)).enumerated()), id: \.offset) { _, block in
                blockView(block)
                    // M38: every block as wide as the row and as tall as its wrapped text at that width. A quote's
                    // text beside its bar was measured at one width and drawn at another: lines ran past the right
                    // edge or were cut short with 「…」 while the next block had room to spare (testers,
                    // 2026-09-30; worst in the thread and with larger text).
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        // Not selectable: a long press on a message opens its actions (Slack), which copy the text; iOS's text selection
        // took the long press first (2026-09-28).
    }

    @ViewBuilder
    private func blockView(_ block: BodyBlock) -> some View {
        switch block {
        case .heading(let level, let tokens):
            // Larger than they were (testers, 2026-09-29), custom emoji with them.
            inlineText(tokens, emojiHeight: CustomEmoji.headingHeights[min(max(level, 1), 3) - 1])
                .font(level == 1 ? .title.bold() : level == 2 ? .title2.bold() : .title3.bold())
        case .paragraph(let lines):
            paragraphView(BodyTokenizer.paragraphLayout(lines))
        case .quote(let inner):
            // The bar is drawn beside the text rather than laid out with it: in an HStack the bar (a shape, as tall as
            // it is offered) took part in sharing the width, and the text was measured for one width and drawn in
            // another (M38). 2026-10-08: its lines are paragraphs and lists (apps/shared/lists.json `quoted`), drawn
            // as outside a quote in the secondary colour (the drawn bullets take it too).
            VStack(alignment: .leading, spacing: Self.blockSpacing) {
                ForEach(Array(inner.enumerated()), id: \.offset) { _, block in
                    quotedView(block)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.leading, Self.quoteIndent)
                .overlay(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 1.5).fill(Color.secondary.opacity(0.35)).frame(width: 3)
                }
        case .list(_, _, let items):
            listView(items)
        case .table(let align, let header, let rows):
            tableView(align: align, header: header, rows: rows)
        case .math(let tex):
            MathBlockView(tex: tex)
        case .task, .image, .rule, .callout, .toggle, .embed:
            EmptyView() // the canvas dialect: drawn by CanvasBodyView (messages never parse these)
        case .codeBlock(let code, let lang):
            VStack(alignment: .trailing, spacing: 0) {
                if let lang { Text(lang.uppercased()).font(.caption2).foregroundStyle(.secondary) }
                // 2026-10-06: SF Mono (the system's monospaced design) a step smaller than the text, a little more
                // room between lines; a soft box with a hairline edge, as on the web.
                Text(Self.untabbed(code)).font(Self.codeBlockFont)
                    .lineSpacing(3)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(Self.codeBackground, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.secondary.opacity(0.2), lineWidth: 0.5))
        }
    }

    /// A quote's paragraphs and lists (a function of its own: `blockView` cannot call itself in a view builder).
    @ViewBuilder
    private func quotedView(_ block: BodyBlock) -> some View {
        switch block {
        case .paragraph(let lines): paragraphView(BodyTokenizer.paragraphLayout(lines))
        case .list(_, _, let items): listView(items)
        default: EmptyView()
        }
    }

    /// apps/shared/lists.json: each item's marker (1. a. i. / • ◦ ▪) comes from the parser; bullets are drawn.
    private func listView(_ items: [BodyListItem]) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Group {
                        if item.ordered {
                            Text(item.marker).monospacedDigit().foregroundStyle(.secondary)
                        } else {
                            ListBulletMark(level: item.level).padding(.trailing, 2)
                        }
                    }
                    .frame(minWidth: 20, alignment: .trailing)
                    inlineText(item.tokens)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .padding(.leading, CGFloat(item.level) * 20)
            }
        }
    }

    /// 2026-10-05: blank lines are this gap (about 0.45 of a body line), not empty lines — between the runs of a
    /// paragraph, and at its ends (with the blocks' own spacing) toward the block before / after; several blank lines
    /// are one gap (apps/shared/body-paragraphs.json).
    static let paragraphGap: CGFloat = 10
    /// The spacing `blocks` puts between any two blocks.
    static let blockSpacing: CGFloat = 4

    @ViewBuilder
    private func paragraphView(_ layout: BodyTokenizer.ParagraphLayout) -> some View {
        if layout.groups.isEmpty {
            // Only blank lines between two blocks: one gap, counting the spacing on both sides.
            Color.clear.frame(height: Self.paragraphGap - 2 * Self.blockSpacing)
        } else {
            VStack(alignment: .leading, spacing: Self.paragraphGap) {
                ForEach(Array(layout.groups.enumerated()), id: \.offset) { _, group in
                    joined(group)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding(.top, layout.gapBefore ? Self.paragraphGap - Self.blockSpacing : 0)
            .padding(.bottom, layout.gapAfter ? Self.paragraphGap - Self.blockSpacing : 0)
        }
    }

    /// Code (2026-10-06): the system's monospaced design (SF Mono) everywhere. A code block a step smaller than the body
    /// text; inline code keeps the size and weight of the text around it (a heading's, a table cell's) on a soft
    /// background, with a thin space either side so the background does not touch the letters.
    static let codeBlockFont: Font = .system(.callout, design: .monospaced)
    static let codeBackground = Color.secondary.opacity(0.12)

    static func inlineCode(_ text: String) -> Text {
        var code = AttributedString("\u{2009}" + untabbed(text) + "\u{2009}")
        code.backgroundColor = Color.secondary.opacity(0.16)
        return Text(code).monospaced()
    }

    /// The text of a quote starts this far right of the row's text (its bar and the gap after it).
    static let quoteIndent: CGFloat = 11
    /// M38: a table cell wraps at this width, so a long cell makes its row taller rather than the table wider.
    static let tableCellMaxWidth: CGFloat = 200

    /// M15g: a bordered grid; a table with more columns than fit scrolls sideways, each cell wrapping at
    /// `tableCellMaxWidth` (M38: a long cell ran the table off the screen).
    private func tableView(align: [BodyTableAlign], header: [[BodyToken]], rows: [[[BodyToken]]]) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
                GridRow {
                    ForEach(header.indices, id: \.self) { column in
                        tableCell(header[column], align: align[column], header: true)
                    }
                }
                ForEach(rows.indices, id: \.self) { row in
                    GridRow {
                        ForEach(rows[row].indices, id: \.self) { column in
                            tableCell(rows[row][column], align: align[column], header: false)
                        }
                    }
                }
            }
            .fixedSize(horizontal: false, vertical: true) // rows only as tall as their content
            .overlay(Rectangle().stroke(Color.secondary.opacity(0.3), lineWidth: 0.5))
        }
    }

    private func tableCell(_ tokens: [BodyToken], align: BodyTableAlign, header: Bool) -> some View {
        let alignment: Alignment = align == .center ? .center : align == .right ? .trailing : .leading
        return CappedWidth(max: Self.tableCellMaxWidth) {
            inlineText(tokens).font(header ? .subheadline.bold() : .subheadline)
        }
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: alignment) // every cell fills its row
            .background(header ? Color.secondary.opacity(0.1) : Color.clear)
            .border(Color.secondary.opacity(0.25), width: 0.5)
    }

    private func joined(_ lines: [[BodyToken]]) -> Text {
        lines.enumerated().reduce(Text("")) { acc, entry in
            let (index, tokens) = entry
            return acc + (index > 0 ? Text("\n") : Text("")) + inlineText(tokens)
        }
    }

    private func inlineText(_ tokens: [BodyToken], emojiHeight: CGFloat = CustomEmoji.inlineHeight) -> Text {
        tokens.reduce(Text("")) { $0 + render($1, emojiHeight: emojiHeight) }
    }

    /// A tab as spaces: SwiftUI's Text puts what follows a tab at the next tab stop but breaks the line as if it were not
    /// there, so a table pasted with tabs ran past the right edge, cut off (tester, 2026-09-30).
    static func untabbed(_ text: String) -> String {
        text.contains("\t") ? text.replacingOccurrences(of: "\t", with: "    ") : text
    }

    private func emojiText(_ text: String, height: CGFloat = CustomEmoji.inlineHeight) -> Text {
        let text = Self.untabbed(text)
        guard !keywords.isEmpty else { return plainEmojiText(text, height: height) }
        return NotifyKeywords.pieces(text, keywords).reduce(Text("")) { sum, piece in
            sum + (piece.hit ? Text(piece.text).bold().foregroundStyle(Color.accentColor) : plainEmojiText(piece.text, height: height))
        }
    }

    private func plainEmojiText(_ text: String, height: CGFloat) -> Text {
        CustomEmoji.text(Emoji.replaceShortcodes(text), custom: customEmoji, images: emojiImages, onNeed: onNeedEmojiImage, height: height)
    }

    /// M122: 「📄 題名」 (the page's own emoji when it has one), 「📄 表示できないページ」, or the link's label while the
    /// title is not known (「ページを開く」 for a bare permalink).
    static func pageLinkText(_ state: WikiHub.LinkState?, label: String?) -> String {
        switch state {
        case .page(let title, let icon)?:
            let mark = icon.flatMap { $0.isEmpty || $0.hasPrefix(":") ? nil : $0 } ?? "📄"
            return mark + " " + title
        case .unreadable?:
            return "📄 " + tr("表示できないページ")
        case nil:
            return "📄 " + ((label?.isEmpty == false) ? label! : tr("ページを開く"))
        }
    }

    private func render(_ token: BodyToken, emojiHeight: CGFloat = CustomEmoji.inlineHeight) -> Text {
        switch token {
        case .text(let text): return emojiText(text, height: emojiHeight)
        case .bold(let text): return emojiText(text, height: emojiHeight).bold()
        case .italic(let text): return emojiText(text, height: emojiHeight).italic()
        case .strike(let text): return emojiText(text, height: emojiHeight).strikethrough()
        case .code(let text): return Self.inlineCode(text)
        case .codeBlock(let text, _): return Text(Self.untabbed(text)).font(Self.codeBlockFont)
        case .link(let url, let label):
            if let id = PageLink.pageId(base: internalBase, url: url) {
                // M122: a wiki page opens in the app (its screen, or 「ページが見つかりません」).
                var attributed = AttributedString(Self.pageLinkText(pageLabel?(id), label: label != url ? label : nil))
                attributed.link = PageLink.internalLink(pageId: id)
                return Text(attributed)
            }
            if let id = FileLink.attachmentId(url) {
                // M122: a page's file (`[name](attachment:<id>)`, not an image): opened in the app.
                var attributed = AttributedString("📎 " + ((label?.isEmpty == false) ? label! : tr("ファイル")))
                attributed.link = FileLink.internalLink(attachmentId: id)
                return Text(attributed)
            }
            if let id = CanvasLink.canvasId(base: internalBase, url: url) {
                // M45: a canvas of this server opens in the app (its screen, or 「メンバーではありません」).
                var attributed = AttributedString("📄 " + ((label != nil && label != url) ? label! : tr("キャンバスを開く")))
                attributed.link = CanvasLink.internalLink(canvasId: id)
                return Text(attributed)
            }
            if let id = Permalink.messageId(base: internalBase, url: url) {
                if citations, let label, !label.isEmpty, label.allSatisfy(\.isASCII), Int(label) != nil {
                    // M71: an AI answer's [n], a link to the cited message (AskRules.linkCitations).
                    var attributed = AttributedString("[\(label)]")
                    attributed.link = Permalink.internalLink(messageId: id)
                    return Text(attributed).foregroundStyle(Color.accentColor)
                }
                var attributed = AttributedString("💬 " + ((label != nil && label != url) ? label! : tr("メッセージを表示")))
                attributed.link = Permalink.internalLink(messageId: id)
                return Text(attributed)
            }
            var attributed = AttributedString(label ?? url)
            attributed.link = URL(string: url)
            return Text(attributed)
        case .mention(let userId):
            if userLinks, let user = users[userId], let link = UserLink.internalLink(userId: userId) {
                var attributed = AttributedString("@" + user.displayName)
                attributed.link = link
                return Text(attributed)  // links take the tint, the accent colour as before
            }
            return Text("@" + (users[userId]?.displayName ?? "unknown")).foregroundStyle(Color.accentColor)
        case .mentionGroup(let groupId): return Text("@" + (groups[groupId]?.name ?? tr("グループ"))).foregroundStyle(Color.accentColor)
        case .mentionAll(let target): return Text("@" + target).foregroundStyle(Color.accentColor)
        case .math(let tex, let display): return MathRender.inlineText(tex, display: display)
        case .newline: return Text("\n")
        }
    }
}


/// 2026-10-08: a bullet drawn rather than a glyph ("•" in the secondary colour was small and faint), as the web draws
/// it (styles.css `.md-ul`): a solid dot for the first level, a ring for the second, a small square for the third, in
/// the text's colour, about 0.4 of the body size, its centre on the middle of the first line's lowercase letters. It
/// sits on the row's first text baseline, so a line with a large emoji keeps its dot by the text.
struct ListBulletMark: View {
    let level: Int
    /// About 0.4 of the body text (17 pt at the default size), growing with Dynamic Type.
    @ScaledMetric(relativeTo: .body) private var size: CGFloat = 6.8
    /// How far above the baseline the mark's centre sits: half the x-height and a little (as `vertical-align: middle`).
    @ScaledMetric(relativeTo: .body) private var lift: CGFloat = 5.2

    var body: some View {
        mark
            .accessibilityHidden(true)
            .alignmentGuide(.firstTextBaseline) { d in d.height / 2 + lift }
    }

    @ViewBuilder private var mark: some View {
        switch min(level, 2) {
        case 0: Circle().fill(.foreground).frame(width: size, height: size)
        case 1: Circle().strokeBorder(.foreground, lineWidth: max(1.3, size * 0.2)).frame(width: size * 1.05, height: size * 1.05)
        default: RoundedRectangle(cornerRadius: 1).fill(.foreground).frame(width: size * 0.9, height: size * 0.9)
        }
    }
}

/// M38: its content at most `max` wide, wrapping there, also where it is offered any width (a sideways scroll view):
/// `.frame(maxWidth:)` let a Text take its one-line width there and was then only as wide as `max`, the text beyond it.
struct CappedWidth: Layout {
    let max: CGFloat

    /// The width the content is laid out in: what is offered, at most `max`.
    static func width(offered: CGFloat?, max: CGFloat) -> CGFloat {
        guard let offered, offered.isFinite else { return max }
        return Swift.min(Swift.max(offered, 0), max)
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = Self.width(offered: proposal.width, max: max)
        let sizes = subviews.map { $0.sizeThatFits(ProposedViewSize(width: width, height: nil)) }
        return CGSize(width: sizes.map(\.width).max() ?? 0, height: sizes.map(\.height).max() ?? 0)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        for subview in subviews {
            subview.place(at: bounds.origin, proposal: ProposedViewSize(width: bounds.width, height: nil))
        }
    }
}
