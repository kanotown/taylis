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

enum BodyBlock: Equatable {
    case heading(Int, [BodyToken])
    case paragraph([[BodyToken]])
    case quote([[BodyToken]])
    case list(ordered: Bool, start: Int, items: [BodyListItem])
    case codeBlock(String, lang: String?)
}

enum BodyTokenizer {
    private static let inline = #"(\*\*([^*\n]+?)\*\*)|(`([^`\n]+)`)|(\*([^*\n]+)\*)|(_([^_\n]+)_)|(~~([^~\n]+)~~)|(\[([^\]\n]+)\]\((https?://[^\s)]+)\))|(<@group:([0-9a-f-]{36})>)|(<@([0-9a-f-]{36})>)|(<!(channel|here)>)|(https?://[^\s<>]+)"#
    private static let inlinePattern = try! NSRegularExpression(pattern: inline)
    private static let fullPattern = try! NSRegularExpression(pattern: #"(```([\s\S]*?)```)|"# + inline + #"|(\n)"#)
    private static let fenceOpen = try! NSRegularExpression(pattern: #"^```([A-Za-z0-9_+#.-]{0,20})\s*$"#)
    private static let fenceClose = try! NSRegularExpression(pattern: #"^```\s*$"#)
    private static let bullet = try! NSRegularExpression(pattern: #"^(\s*)[-*•]\s+(.*)$"#)
    private static let numbered = try! NSRegularExpression(pattern: #"^(\s*)(\d{1,3})\.\s+(.*)$"#)
    private static let quote = try! NSRegularExpression(pattern: #"^>\s?(.*)$"#)
    private static let heading = try! NSRegularExpression(pattern: #"^(#{1,3})\s+(\S.*)$"#)

    /// Whole-body tokens (inline markup, fenced code and newlines); kept for the search highlighter and tests.
    static func tokenize(_ body: String) -> [BodyToken] { scan(body, pattern: fullPattern, withBlocks: true) }

    /// Inline tokens of a single line.
    static func tokenizeInline(_ line: String) -> [BodyToken] { scan(line, pattern: inlinePattern, withBlocks: false) }

    private static func scan(_ body: String, pattern: NSRegularExpression, withBlocks: Bool) -> [BodyToken] {
        var tokens: [BodyToken] = []
        let ns = body as NSString
        var last = 0
        for match in pattern.matches(in: body, range: NSRange(location: 0, length: ns.length)) {
            if match.range.location > last { tokens.append(.text(ns.substring(with: NSRange(location: last, length: match.range.location - last)))) }
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
            } else if group(1) != nil { tokens.append(.bold(group(2) ?? "")) }
            else if group(3) != nil { tokens.append(.code(group(4) ?? "")) }
            else if group(5) != nil { tokens.append(.bold(group(6) ?? "")) }
            else if group(7) != nil { tokens.append(.italic(group(8) ?? "")) }
            else if group(9) != nil { tokens.append(.strike(group(10) ?? "")) }
            else if group(11) != nil { tokens.append(.link(group(13) ?? "", label: group(12))) }
            else if group(14) != nil { tokens.append(.mentionGroup(group(15) ?? "")) }
            else if group(16) != nil { tokens.append(.mention(group(17) ?? "")) }
            else if group(18) != nil { tokens.append(.mentionAll(group(19) ?? "")) }
            else if let url = group(20) { tokens.append(.link(url)) }
            else { tokens.append(.newline) }
            last = match.range.location + match.range.length
        }
        if last < ns.length { tokens.append(.text(ns.substring(from: last))) }
        return tokens
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

    /// Block structure for rendering: paragraphs, quotes, lists and fenced code, in order.
    static func parseBlocks(_ body: String) -> [BodyBlock] {
        let lines = body.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n").components(separatedBy: "\n")
        func fenceCloseAfter(_ index: Int) -> Int? {
            ((index + 1)..<lines.count).first { firstMatch(fenceClose, lines[$0]) != nil }
        }
        func opensFence(_ index: Int) -> Bool { firstMatch(fenceOpen, lines[index]) != nil && fenceCloseAfter(index) != nil }
        var blocks: [BodyBlock] = []
        var i = 0
        while i < lines.count {
            let line = lines[i]
            if opensFence(i), let open = firstMatch(fenceOpen, line), let close = fenceCloseAfter(i) {
                let lang = group(open, 1, in: line)
                blocks.append(.codeBlock(lines[(i + 1)..<close].joined(separator: "\n"), lang: lang.isEmpty ? nil : lang.lowercased()))
                i = close + 1
                continue
            }
            if let h = firstMatch(heading, line) {
                blocks.append(.heading(group(h, 1, in: line).count, tokenizeInline(group(h, 2, in: line))))
                i += 1
                continue
            }
            if firstMatch(quote, line) != nil {
                var quoted: [[BodyToken]] = []
                while i < lines.count, let q = firstMatch(quote, lines[i]) {
                    quoted.append(tokenizeInline(group(q, 1, in: lines[i])))
                    i += 1
                }
                blocks.append(.quote(quoted))
                continue
            }
            let isBullet = firstMatch(bullet, line) != nil
            if isBullet || firstMatch(numbered, line) != nil {
                let ordered = !isBullet
                var items: [BodyListItem] = []
                var start = 1
                if ordered, let first = firstMatch(numbered, line) { start = Int(group(first, 2, in: line)) ?? 1 }
                while i < lines.count, let m = firstMatch(ordered ? numbered : bullet, lines[i]) {
                    let indent = group(m, 1, in: lines[i]).replacingOccurrences(of: "\t", with: "  ").count
                    let text = group(m, ordered ? 3 : 2, in: lines[i])
                    items.append(BodyListItem(level: indent >= 2 ? 1 : 0, tokens: tokenizeInline(text)))
                    i += 1
                }
                blocks.append(.list(ordered: ordered, start: start, items: items))
                continue
            }
            var paragraph: [[BodyToken]] = []
            while i < lines.count {
                let current = lines[i]
                if !paragraph.isEmpty, opensFence(i) || firstMatch(heading, current) != nil || firstMatch(quote, current) != nil || firstMatch(bullet, current) != nil || firstMatch(numbered, current) != nil { break }
                paragraph.append(tokenizeInline(current))
                i += 1
            }
            blocks.append(.paragraph(paragraph))
        }
        return blocks
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
    var onNeedEmojiImage: ((CustomEmojiOut) -> Void)? = nil

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(BodyTokenizer.parseBlocks(text).enumerated()), id: \.offset) { _, block in
                blockView(block)
            }
        }
        .textSelection(.enabled)
    }

    @ViewBuilder
    private func blockView(_ block: BodyBlock) -> some View {
        switch block {
        case .heading(let level, let tokens):
            inlineText(tokens).font(level == 1 ? .title3.bold() : level == 2 ? .headline : .subheadline.bold())
        case .paragraph(let lines):
            joined(lines)
        case .quote(let lines):
            HStack(alignment: .top, spacing: 8) {
                RoundedRectangle(cornerRadius: 1.5).fill(Color.secondary.opacity(0.35)).frame(width: 3)
                joined(lines).foregroundStyle(.secondary)
            }
        case .list(let ordered, let start, let items):
            VStack(alignment: .leading, spacing: 2) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(marker(ordered: ordered, index: index, start: start, level: item.level))
                            .foregroundStyle(.secondary)
                            .frame(minWidth: 18, alignment: .trailing)
                        inlineText(item.tokens)
                    }
                    .padding(.leading, CGFloat(item.level) * 16)
                }
            }
        case .codeBlock(let code, let lang):
            VStack(alignment: .trailing, spacing: 0) {
                if let lang { Text(lang.uppercased()).font(.caption2).foregroundStyle(.secondary) }
                Text(code).font(.system(.body, design: .monospaced)).frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(8)
            .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
        }
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

    private func inlineText(_ tokens: [BodyToken]) -> Text {
        tokens.reduce(Text("")) { $0 + render($1) }
    }

    private func emojiText(_ text: String) -> Text {
        CustomEmoji.text(Emoji.replaceShortcodes(text), custom: customEmoji, images: emojiImages, onNeed: onNeedEmojiImage)
    }

    private func render(_ token: BodyToken) -> Text {
        switch token {
        case .text(let text): return emojiText(text)
        case .bold(let text): return emojiText(text).bold()
        case .italic(let text): return emojiText(text).italic()
        case .strike(let text): return emojiText(text).strikethrough()
        case .code(let text): return Text(text).font(.system(.body, design: .monospaced))
        case .codeBlock(let text, _): return Text(text).font(.system(.body, design: .monospaced))
        case .link(let url, let label):
            if let id = Permalink.messageId(base: internalBase, url: url) {
                var attributed = AttributedString("💬 " + ((label != nil && label != url) ? label! : "メッセージを表示"))
                attributed.link = Permalink.internalLink(messageId: id)
                return Text(attributed)
            }
            var attributed = AttributedString(label ?? url)
            attributed.link = URL(string: url)
            return Text(attributed)
        case .mention(let userId): return Text("@" + (users[userId]?.displayName ?? "unknown")).foregroundStyle(.blue)
        case .mentionGroup(let groupId): return Text("@" + (groups[groupId]?.name ?? "グループ")).foregroundStyle(.blue)
        case .mentionAll(let target): return Text("@" + target).foregroundStyle(.blue)
        case .newline: return Text("\n")
        }
    }
}
