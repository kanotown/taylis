import Foundation

/// Emoji shortcodes and the picker's search (M11f); the table is generated from apps/shared/emoji.json.
enum Emoji {
    private static let byShortcode: [String: EmojiEntry] = Dictionary(EmojiData.all.map { ($0.shortcode, $0) }, uniquingKeysWith: { a, _ in a })
    private static let shortcodePattern = try! NSRegularExpression(pattern: #":([a-z0-9_+\-]{1,30}):"#)
    /// ":ta" at the end of the text, at a word start; the query needs at least 2 characters. M100: or a Japanese word
    /// (":ありがとう", "：了解"), one character enough: custom emoji by label / keyword, standard ones by keyword.
    private static let queryPattern = try! NSRegularExpression(pattern: #"(^|[\s(（「])[:：]([a-z0-9_+\-]{2,30}|[^\s:：\x00-\x7f][^\s:：]{0,19})$"#)

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
        let folded = fold(q)
        let rest = EmojiData.all.filter {
            !$0.shortcode.hasPrefix(q) && ($0.shortcode.contains(q) || $0.keywords.lowercased().contains(q)
                || (folded != q && fold($0.keywords).contains(folded)))
        }
        return Array((prefix + rest).prefix(limit))
    }

    /// M100: lower case, full-width as half-width (NFKC), katakana as hiragana (「アリガトウ」 finds 「ありがとう」).
    static func fold(_ text: String) -> String {
        let normalized = text.precomposedStringWithCompatibilityMapping.lowercased()
        return String(String.UnicodeScalarView(normalized.unicodeScalars.map { scalar in
            (0x30A1...0x30F6).contains(scalar.value) ? Unicode.Scalar(scalar.value - 0x60) ?? scalar : scalar
        }))
    }

    /// Custom emoji for a query (M12f; M100 also by label and keywords): names starting with it, names containing it,
    /// then labels / keywords starting with it, then containing it; by name within each.
    static func customCandidates(_ query: String, custom: [CustomEmojiOut], limit: Int = 4) -> [CustomEmojiOut] {
        let q = fold(query.trimmingCharacters(in: .whitespaces))
        guard !q.isEmpty else { return [] }
        func rank(_ emoji: CustomEmojiOut) -> Int? {
            if emoji.name.hasPrefix(q) { return 0 }
            if emoji.name.contains(q) { return 1 }
            let words = ([emoji.label ?? ""] + (emoji.keywords ?? [])).filter { !$0.isEmpty }.map(fold)
            if words.contains(where: { $0.hasPrefix(q) }) { return 2 }
            if words.contains(where: { $0.contains(q) }) { return 3 }
            return nil
        }
        let ranked = custom.compactMap { emoji in rank(emoji).map { ($0, emoji) } }
            .sorted { ($0.0, $0.1.name) < ($1.0, $1.1.name) }
        return Array(ranked.prefix(limit).map(\.1))
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

/// MOBILE_POLISH.md C10: 「よく使う」 at the head of the emoji picker. How often each emoji was used on this device (picked
/// in a picker or tapped as a quick reaction), in UserDefaults as JSON: per device, like the web's recent emoji. The
/// most used come first, and among equals the latest. 「emoji.recent」 (the order the quick reactions follow, C8) stays
/// as it is; the first time, the counts start from it.
struct EmojiUsage: Codable, Equatable {
    struct Entry: Codable, Equatable {
        var glyph: String
        var count: Int
        /// When it was last used, as a running number (the latest is the largest).
        var last: Int
    }

    static let key = "emoji.usage"
    static let recentKey = "emoji.recent"
    /// Entries remembered; past this the least used (the oldest among equals) is forgotten.
    static let kept = 40
    /// Shown in 「よく使う」: two rows of the picker's eight.
    static let shown = 16

    var entries: [Entry] = []

    private static func ranked(_ a: Entry, _ b: Entry) -> Bool { a.count != b.count ? a.count > b.count : a.last > b.last }

    /// The picker's 「よく使う」: the most used first, the latest first among equals.
    var frequent: [String] { entries.sorted(by: Self.ranked).prefix(Self.shown).map(\.glyph) }

    /// 「よく使う」 as the picker draws it: each glyph once (the grid's ids; a stored list written elsewhere may repeat
    /// one), no empty ones, and a custom `:name:` only while `customNames` has it (removed, renamed, from another
    /// workspace, or the list not loaded yet: it has no image to show and nothing valid to pick).
    static func shown(_ glyphs: [String], customNames: Set<String>) -> [String] {
        var seen: Set<String> = []
        return glyphs.filter { glyph in
            guard !glyph.isEmpty, seen.insert(glyph).inserted else { return false }
            guard let name = CustomEmoji.name(of: glyph) else { return true }
            return customNames.contains(name)
        }
    }

    mutating func record(_ glyph: String) {
        guard !glyph.isEmpty else { return }
        let next = (entries.map(\.last).max() ?? 0) + 1
        if let index = entries.firstIndex(where: { $0.glyph == glyph }) {
            entries[index].count += 1
            entries[index].last = next
        } else {
            if entries.count >= Self.kept { entries = Array(entries.sorted(by: Self.ranked).prefix(Self.kept - 1)) }
            entries.append(Entry(glyph: glyph, count: 1, last: next))
        }
    }

    /// The stored counts; without any (or unreadable), the recent list (newest first) counted once each, in its order.
    static func decode(_ raw: String, recent: String = "") -> EmojiUsage {
        if let data = raw.data(using: .utf8), let usage = try? JSONDecoder().decode(EmojiUsage.self, from: data) { return usage }
        let glyphs = recent.split(separator: " ").map(String.init).filter { !$0.isEmpty }
        return EmojiUsage(entries: glyphs.enumerated().map { Entry(glyph: $1, count: 1, last: glyphs.count - $0) })
    }

    var encoded: String { (try? JSONEncoder().encode(self)).flatMap { String(data: $0, encoding: .utf8) } ?? "" }

    /// Counts one use in `defaults` (a quick reaction: no picker is open to do it).
    static func note(_ glyph: String, defaults: UserDefaults = .standard) {
        var usage = decode(defaults.string(forKey: key) ?? "", recent: defaults.string(forKey: recentKey) ?? "")
        usage.record(glyph)
        defaults.set(usage.encoded, forKey: key)
    }
}
