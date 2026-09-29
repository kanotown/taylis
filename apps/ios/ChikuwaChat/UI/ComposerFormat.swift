import Foundation

/// The composer's 「書式」 menu (testers, 2026-09-29, like Slack / Mattermost): the markdown the message body shows
/// (BodyTokenizer), put around the selected text or at the cursor. A line style goes at the start of each line the
/// selection touches.
enum ComposerFormat: String, CaseIterable, Identifiable {
    case bold, italic, strike, code, codeBlock, quote, bullet, numbered, link

    var id: String { rawValue }

    var label: String {
        switch self {
        case .bold: "太字"
        case .italic: "斜体"
        case .strike: "取り消し線"
        case .code: "コード"
        case .codeBlock: "コードブロック"
        case .quote: "引用"
        case .bullet: "箇条書き"
        case .numbered: "番号付きリスト"
        case .link: "リンク"
        }
    }

    var icon: String {
        switch self {
        case .bold: "bold"
        case .italic: "italic"
        case .strike: "strikethrough"
        case .code: "chevron.left.forwardslash.chevron.right"
        case .codeBlock: "curlybraces"
        case .quote: "text.quote"
        case .bullet: "list.bullet"
        case .numbered: "list.number"
        case .link: "link"
        }
    }

    /// The text with the format applied to `selection` (character offsets), and where the cursor or selection goes.
    func apply(to text: String, selection: Range<Int>) -> (text: String, selection: Range<Int>) {
        var chars = Array(text)
        let lower = max(0, min(selection.lowerBound, chars.count)), upper = max(lower, min(selection.upperBound, chars.count))
        let selected = String(chars[lower..<upper])
        func wrap(_ open: String, _ close: String) -> (text: String, selection: Range<Int>) {
            chars.replaceSubrange(lower..<upper, with: Array(open + selected + close))
            let start = lower + open.count
            return (String(chars), start..<(start + selected.count))
        }
        switch self {
        case .bold: return wrap("**", "**")
        case .italic: return wrap("_", "_")
        case .strike: return wrap("~~", "~~")
        case .code: return wrap("`", "`")
        case .codeBlock:
            let before = lower > 0 && chars[lower - 1] != "\n" ? "\n" : ""
            return wrap(before + "```\n", "\n```")
        case .link:
            if selected.isEmpty { return wrap("[", "](https://)") }
            chars.replaceSubrange(lower..<upper, with: Array("[" + selected + "](https://)"))
            let cursor = lower + selected.count + "[](https://".count
            return (String(chars), cursor..<cursor)
        case .quote, .bullet, .numbered:
            // Every line the selection touches, from the start of the first one.
            var start = lower
            while start > 0 && chars[start - 1] != "\n" { start -= 1 }
            var end = upper
            while end < chars.count && chars[end] != "\n" { end += 1 }
            let lines = String(chars[start..<end]).split(separator: "\n", omittingEmptySubsequences: false)
            let marked = lines.enumerated().map { index, line in
                (self == .quote ? "> " : self == .bullet ? "- " : "\(index + 1). ") + line
            }.joined(separator: "\n")
            chars.replaceSubrange(start..<end, with: Array(marked))
            let added = marked.count - (end - start)
            // One line: the cursor keeps its place after the mark; several: they stay selected.
            if lines.count == 1 { let shift = marked.count - lines[0].count; return (String(chars), (lower + shift)..<(upper + shift)) }
            return (String(chars), start..<(end + added))
        }
    }
}
