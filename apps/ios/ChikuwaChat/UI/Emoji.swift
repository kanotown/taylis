import Foundation

/// Emoji shortcodes and the picker's search (M11f); the table is generated from apps/shared/emoji.json.
enum Emoji {
    private static let byShortcode: [String: EmojiEntry] = Dictionary(EmojiData.all.map { ($0.shortcode, $0) }, uniquingKeysWith: { a, _ in a })
    private static let shortcodePattern = try! NSRegularExpression(pattern: #":([a-z0-9_+\-]{1,30}):"#)
    /// ":ta" at the end of the text, at a word start; the query needs at least 2 characters.
    private static let queryPattern = try! NSRegularExpression(pattern: #"(^|[\s(（「])[:：]([a-z0-9_+\-]{2,30})$"#)

    static func byShortcode(_ shortcode: String) -> EmojiEntry? { byShortcode[shortcode] }

    /// `:tada:` → 🎉 wherever the shortcode is known; unknown ones stay as typed.
    static func replaceShortcodes(_ text: String) -> String {
        guard text.contains(":") else { return text }
        let ns = text as NSString
        var out = ""
        var last = 0
        for match in shortcodePattern.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            let code = ns.substring(with: match.range(at: 1))
            guard let entry = byShortcode[code] else { continue }
            out += ns.substring(with: NSRange(location: last, length: match.range.location - last))
            out += entry.glyph
            last = match.range.location + match.range.length
        }
        out += ns.substring(from: last)
        return out
    }

    /// The `:query` being typed at the end of the text (the composer edits at the end), like Mentions.query.
    static func query(_ text: String) -> String? {
        let ns = text as NSString
        guard let match = queryPattern.firstMatch(in: text, range: NSRange(location: 0, length: ns.length)) else { return nil }
        return ns.substring(with: match.range(at: 2)).lowercased()
    }

    /// Matches by shortcode prefix first, then by keyword / shortcode substring.
    static func candidates(_ query: String, limit: Int = 8) -> [EmojiEntry] {
        let q = query.lowercased()
        if q.isEmpty { return [] }
        let prefix = EmojiData.all.filter { $0.shortcode.hasPrefix(q) }
        let rest = EmojiData.all.filter { !$0.shortcode.hasPrefix(q) && ($0.shortcode.contains(q) || $0.keywords.lowercased().contains(q)) }
        return Array((prefix + rest).prefix(limit))
    }

    /// Free-text search for the picker: an empty query lists everything.
    static func search(_ query: String) -> [EmojiEntry] {
        let q = query.trimmingCharacters(in: .whitespaces)
        return q.isEmpty ? EmojiData.all : candidates(q, limit: EmojiData.all.count)
    }

    /// Replace the trailing `:query` with the glyph and a space.
    static func complete(_ text: String, glyph: String) -> String {
        let ns = text as NSString
        guard let match = queryPattern.firstMatch(in: text, range: NSRange(location: 0, length: ns.length)) else { return text + glyph + " " }
        let start = match.range(at: 2).location - 1
        return ns.substring(to: start) + glyph + " "
    }
}
