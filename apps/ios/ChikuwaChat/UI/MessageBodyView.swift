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
    case newline
}

struct BodyListItem: Equatable {
    let level: Int
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
    case quote([[BodyToken]])
    case list(ordered: Bool, start: Int, items: [BodyListItem])
    case codeBlock(String, lang: String?)
    /// M15g: a GFM table; rows have exactly as many cells as the header.
    case table(align: [BodyTableAlign], header: [[BodyToken]], rows: [[[BodyToken]]])
    // The canvas dialect (CANVAS.md §4.2, `canvas: true`; messages keep these as text).
    case task([BodyTaskItem])
    /// `![alt](attachment:<uuid>)` on a line of its own: an image of the canvas (other image URLs stay text).
    case image(alt: String, attachmentId: String, line: Int)
    /// `---` between blank lines.
    case rule
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
    private static let inline = #"(\*\*((?:\\.|[^*\n\\])+?)\*\*)|(`([^`\n]+)`)|(\*((?:\\.|[^*\n\\])+)\*)|((?<![\p{L}\p{N}_])_(?![\s\u3000_])((?:\\.|[^\n\\])*?(?:\\.|[^\s\u3000_\\]))_(?![\p{L}\p{N}_]))|(~~((?:\\.|[^~\n\\])+)~~)|(\[([^\]\n]+)\]\((https?://[^\s)]+)\))|(<@group:([0-9a-f-]{36})>)|(<@([0-9a-f-]{36})>)|(<!(channel|here)>)|(https?://[^\s<>]+)|(\\([_*~`]))|([A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){1,8}|¯\\_\(ツ\)_/¯)"#
    private static let escaped = try! NSRegularExpression(pattern: #"\\([_*~`])"#)
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
            else if group(3) != nil { tokens.append(.code(group(4) ?? "")) }
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
        case .newline: return "\n"
        }
    }

    private static func splitFence(_ raw: String) -> (String, String?) {
        let lines = raw.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        if lines.count > 1, let first = lines.first, !first.isEmpty, first.range(of: #"^[A-Za-z0-9_+#.-]{1,20}$"#, options: .regularExpression) != nil {
            var rest = lines.dropFirst().joined(separator: "\n")
            if rest.hasSuffix("\n") { rest.removeLast() }
            return (rest, first.lowercased())
        }
        var text = raw
        if text.hasPrefix("\n") { text.removeFirst() }
        if text.hasSuffix("\n") { text.removeLast() }
        return (text, nil)
    }

    private static func firstMatch(_ regex: NSRegularExpression, _ line: String) -> NSTextCheckingResult? {
        regex.firstMatch(in: line, range: NSRange(location: 0, length: (line as NSString).length))
    }

    private static func group(_ match: NSTextCheckingResult, _ index: Int, in line: String) -> String {
        let range = match.range(at: index)
        return range.location == NSNotFound ? "" : (line as NSString).substring(with: range)
    }

    /// Block structure for rendering: paragraphs, quotes, lists and fenced code, in order. `canvas`: the canvas dialect
    /// (tasks, images and rules; apps/shared/canvas_markdown.json).
    static func parseBlocks(_ body: String, canvas: Bool = false) -> [BodyBlock] {
        parseLinedBlocks(body, canvas: canvas).map(\.block)
    }

    /// The blocks with the line each starts on (0-based): a canvas's outline and section editing find its headings.
    static func parseLinedBlocks(_ body: String, canvas: Bool = false) -> [(block: BodyBlock, line: Int)] {
        let split = body.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n").components(separatedBy: "\n")
        // M83 (CANVAS.md §22): a canvas's task markers are never shown; the lines stay where they are (a tick still
        // changes its line of the stored body, the marker with it).
        let lines = canvas ? split.map(CanvasMarkers.strip) : split
        func blank(_ index: Int) -> Bool { index < 0 || index >= lines.count || lines[index].trimmingCharacters(in: .whitespaces).isEmpty }
        func isTask(_ index: Int) -> Bool { canvas && index < lines.count && firstMatch(CanvasText.taskLine, lines[index]) != nil }
        func isImage(_ index: Int) -> Bool { canvas && firstMatch(imageLine, lines[index]) != nil }
        func isRule(_ index: Int) -> Bool { canvas && firstMatch(ruleLine, lines[index]) != nil && blank(index - 1) && blank(index + 1) }
        func fenceCloseAfter(_ index: Int) -> Int? {
            ((index + 1)..<lines.count).first { firstMatch(fenceClose, lines[$0]) != nil }
        }
        func opensFence(_ index: Int) -> Bool { firstMatch(fenceOpen, lines[index]) != nil && fenceCloseAfter(index) != nil }
        // M15g: a header row with a pipe, directly followed by a separator with as many cells.
        func opensTable(_ index: Int) -> Bool {
            guard index + 1 < lines.count, lines[index].contains("|"), firstMatch(tableSeparator, lines[index + 1]) != nil else { return false }
            return splitTableRow(lines[index]).count == splitTableRow(lines[index + 1]).count
        }
        var lined: [(block: BodyBlock, line: Int)] = []
        var i = 0
        while i < lines.count {
            let line = lines[i]
            let first = i
            func append(_ block: BodyBlock) { lined.append((block, first)) }
            if opensFence(i), let open = firstMatch(fenceOpen, line), let close = fenceCloseAfter(i) {
                let lang = group(open, 1, in: line)
                append(.codeBlock(lines[(i + 1)..<close].joined(separator: "\n"), lang: lang.isEmpty ? nil : lang.lowercased()))
                i = close + 1
                continue
            }
            if let h = firstMatch(heading, line) {
                append(.heading(group(h, 1, in: line).count, tokenizeInline(group(h, 2, in: line))))
                i += 1
                continue
            }
            if isTask(i) {
                var items: [BodyTaskItem] = []
                while i < lines.count, let m = firstMatch(CanvasText.taskLine, lines[i]) {
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
                var quoted: [[BodyToken]] = []
                while i < lines.count, let q = firstMatch(quote, lines[i]) {
                    quoted.append(tokenizeInline(group(q, 1, in: lines[i])))
                    i += 1
                }
                append(.quote(quoted))
                continue
            }
            if opensTable(i) {
                let header = splitTableRow(line)
                let align = splitTableRow(lines[i + 1]).map(tableAlign)
                var rows: [[[BodyToken]]] = []
                i += 2
                while i < lines.count, lines[i].contains("|"), !lines[i].trimmingCharacters(in: .whitespaces).isEmpty {
                    let cells = splitTableRow(lines[i])
                    rows.append(header.indices.map { tokenizeInline($0 < cells.count ? cells[$0] : "") }) // short rows pad, long rows are cut (GFM)
                    i += 1
                }
                append(.table(align: align, header: header.map(tokenizeInline), rows: rows))
                continue
            }
            let isBullet = firstMatch(bullet, line) != nil
            if isBullet || firstMatch(numbered, line) != nil {
                let ordered = !isBullet
                var items: [BodyListItem] = []
                var start = 1
                if ordered, let first = firstMatch(numbered, line) { start = Int(group(first, 2, in: line)) ?? 1 }
                while i < lines.count, !isTask(i), let m = firstMatch(ordered ? numbered : bullet, lines[i]) {
                    let indent = group(m, 1, in: lines[i]).replacingOccurrences(of: "\t", with: "  ").count
                    let text = group(m, ordered ? 3 : 2, in: lines[i])
                    items.append(BodyListItem(level: indent >= 2 ? 1 : 0, tokens: tokenizeInline(text)))
                    i += 1
                }
                append(.list(ordered: ordered, start: start, items: items))
                continue
            }
            var paragraph: [[BodyToken]] = []
            while i < lines.count {
                let current = lines[i]
                if !paragraph.isEmpty, opensFence(i) || opensTable(i) || firstMatch(heading, current) != nil || firstMatch(quote, current) != nil || firstMatch(bullet, current) != nil || firstMatch(numbered, current) != nil || isImage(i) || isRule(i) { break }
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
        case .quote(let lines):
            // The bar is drawn beside the text rather than laid out with it: in an HStack the bar (a shape, as tall as
            // it is offered) took part in sharing the width, and the text was measured for one width and drawn in
            // another (M38).
            joined(lines).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.leading, Self.quoteIndent)
                .overlay(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 1.5).fill(Color.secondary.opacity(0.35)).frame(width: 3)
                }
        case .list(let ordered, let start, let items):
            VStack(alignment: .leading, spacing: 2) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(marker(ordered: ordered, index: index, start: start, level: item.level))
                            .foregroundStyle(.secondary)
                            .frame(minWidth: 18, alignment: .trailing)
                        inlineText(item.tokens)
                            .fixedSize(horizontal: false, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .padding(.leading, CGFloat(item.level) * 16)
                }
            }
        case .table(let align, let header, let rows):
            tableView(align: align, header: header, rows: rows)
        case .task, .image, .rule:
            EmptyView() // the canvas dialect: drawn by CanvasBodyView (messages never parse these)
        case .codeBlock(let code, let lang):
            VStack(alignment: .trailing, spacing: 0) {
                if let lang { Text(lang.uppercased()).font(.caption2).foregroundStyle(.secondary) }
                Text(Self.untabbed(code)).font(.system(.body, design: .monospaced))
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(8)
            .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
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

    private func marker(ordered: Bool, index: Int, start: Int, level: Int) -> String {
        if ordered { return "\(start + index)." }
        return level > 0 ? "◦" : "•"
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

    private func render(_ token: BodyToken, emojiHeight: CGFloat = CustomEmoji.inlineHeight) -> Text {
        switch token {
        case .text(let text): return emojiText(text, height: emojiHeight)
        case .bold(let text): return emojiText(text, height: emojiHeight).bold()
        case .italic(let text): return emojiText(text, height: emojiHeight).italic()
        case .strike(let text): return emojiText(text, height: emojiHeight).strikethrough()
        case .code(let text): return Text(Self.untabbed(text)).font(.system(.body, design: .monospaced))
        case .codeBlock(let text, _): return Text(Self.untabbed(text)).font(.system(.body, design: .monospaced))
        case .link(let url, let label):
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
        case .mention(let userId): return Text("@" + (users[userId]?.displayName ?? "unknown")).foregroundStyle(Color.accentColor)
        case .mentionGroup(let groupId): return Text("@" + (groups[groupId]?.name ?? tr("グループ"))).foregroundStyle(Color.accentColor)
        case .mentionAll(let target): return Text("@" + target).foregroundStyle(Color.accentColor)
        case .newline: return Text("\n")
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
