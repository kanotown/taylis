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

/// Emoji-only messages (M101, docs/EMOJI.md §7): a body that is nothing but emoji (standard ones, `:shortcode:`s and
/// custom emoji of any kind; at most `maxItems`, whitespace between them) is shown large in the timeline and threads.
/// The rule and its cases are shared with the web and Android: apps/shared/emoji-only.json (CustomEmojiTests compares
/// the tables below with it and runs the cases).
enum EmojiOnly {
    enum Kind: String { case unicode, image, text, pack }

    struct Result: Equatable {
        let kinds: [Kind]
        /// Exactly one emoji of a pack: shown as a stamp.
        var stamp: Bool { kinds == [.pack] }
    }

    static let maxItems = 23
    static let whitespace: [UInt32] = [0x20, 0x09, 0x0A, 0x0D, 0xA0, 0x3000]
    /// The Unicode Emoji property without ASCII and the sequence components, plus all of 1F000–1FAFF.
    static let pictographic: [ClosedRange<UInt32>] = [
        0xA9...0xA9, 0xAE...0xAE, 0x203C...0x203C, 0x2049...0x2049, 0x2122...0x2122, 0x2139...0x2139, 0x2194...0x2199,
        0x21A9...0x21AA, 0x231A...0x231B, 0x2328...0x2328, 0x23CF...0x23CF, 0x23E9...0x23F3, 0x23F8...0x23FA,
        0x24C2...0x24C2, 0x25AA...0x25AB, 0x25B6...0x25B6, 0x25C0...0x25C0, 0x25FB...0x25FE, 0x2600...0x2604,
        0x260E...0x260E, 0x2611...0x2611, 0x2614...0x2615, 0x2618...0x2618, 0x261D...0x261D, 0x2620...0x2620,
        0x2622...0x2623, 0x2626...0x2626, 0x262A...0x262A, 0x262E...0x262F, 0x2638...0x263A, 0x2640...0x2640,
        0x2642...0x2642, 0x2648...0x2653, 0x265F...0x2660, 0x2663...0x2663, 0x2665...0x2666, 0x2668...0x2668,
        0x267B...0x267B, 0x267E...0x267F, 0x2692...0x2697, 0x2699...0x2699, 0x269B...0x269C, 0x26A0...0x26A1,
        0x26A7...0x26A7, 0x26AA...0x26AB, 0x26B0...0x26B1, 0x26BD...0x26BE, 0x26C4...0x26C5, 0x26C8...0x26C8,
        0x26CE...0x26CF, 0x26D1...0x26D1, 0x26D3...0x26D4, 0x26E9...0x26EA, 0x26F0...0x26F5, 0x26F7...0x26FA,
        0x26FD...0x26FD, 0x2702...0x2702, 0x2705...0x2705, 0x2708...0x270D, 0x270F...0x270F, 0x2712...0x2712,
        0x2714...0x2714, 0x2716...0x2716, 0x271D...0x271D, 0x2721...0x2721, 0x2728...0x2728, 0x2733...0x2734,
        0x2744...0x2744, 0x2747...0x2747, 0x274C...0x274C, 0x274E...0x274E, 0x2753...0x2755, 0x2757...0x2757,
        0x2763...0x2764, 0x2795...0x2797, 0x27A1...0x27A1, 0x27B0...0x27B0, 0x27BF...0x27BF, 0x2934...0x2935,
        0x2B05...0x2B07, 0x2B1B...0x2B1C, 0x2B50...0x2B50, 0x2B55...0x2B55, 0x3030...0x3030, 0x303D...0x303D,
        0x3297...0x3297, 0x3299...0x3299, 0x1F000...0x1F1E5, 0x1F200...0x1F3FA, 0x1F400...0x1FAFF,
    ]

    private static let namePattern = try! NSRegularExpression(pattern: "^[a-z0-9][a-z0-9_+-]{1,31}$")

    private static func isPictographic(_ cp: UInt32) -> Bool {
        var lo = 0, hi = pictographic.count - 1
        while lo <= hi {
            let mid = (lo + hi) / 2
            if cp < pictographic[mid].lowerBound { hi = mid - 1 } else if cp > pictographic[mid].upperBound { lo = mid + 1 } else { return true }
        }
        return false
    }

    /// The emoji of an emoji-only body (in order), or nil when it is not one. `custom`: custom emoji by name.
    static func parse(_ body: String, custom: [String: CustomEmojiOut]) -> Result? {
        parse(body) { name in custom[name].map { $0.isText ? .text : $0.packId != nil ? .pack : .image } }
    }

    static func parse(_ body: String, kind: (String) -> Kind?) -> Result? {
        let cps = Emoji.replaceShortcodes(body).unicodeScalars.map(\.value)
        func at(_ index: Int) -> UInt32? { index < cps.count ? cps[index] : nil }
        func regional(_ cp: UInt32?) -> Bool { cp.map { (0x1F1E6...0x1F1FF).contains($0) } ?? false }
        func skinTone(_ cp: UInt32?) -> Bool { cp.map { (0x1F3FB...0x1F3FF).contains($0) } ?? false }
        func tag(_ cp: UInt32?) -> Bool { cp.map { (0xE0020...0xE007E).contains($0) } ?? false }
        /// One element of an emoji sequence at `start`: its end, or nil.
        func element(_ start: Int) -> Int? {
            guard let base = at(start), isPictographic(base) else { return nil }
            var j = start + 1
            if at(j) == 0xFE0F { j += 1 }
            if skinTone(at(j)) { j += 1 }
            if base == 0x1F3F4, tag(at(j)) {
                while tag(at(j)) { j += 1 }
                guard at(j) == 0xE007F else { return nil }
                j += 1
            }
            return j
        }
        var kinds: [Kind] = []
        var i = 0
        while i < cps.count {
            let cp = cps[i]
            if whitespace.contains(cp) { i += 1; continue }
            if kinds.count == maxItems { return nil }
            if cp == 0x3A { // ':' name ':'
                var j = i + 1
                while j < cps.count, cps[j] != 0x3A, j - i <= 33 { j += 1 }
                guard at(j) == 0x3A else { return nil }
                var name = ""
                name.unicodeScalars.append(contentsOf: cps[(i + 1)..<j].compactMap(Unicode.Scalar.init))
                guard namePattern.firstMatch(in: name, range: NSRange(location: 0, length: (name as NSString).length)) != nil,
                      let found = kind(name) else { return nil }
                kinds.append(found)
                i = j + 1
                continue
            }
            if (0x30...0x39).contains(cp) || cp == 0x23 || cp == 0x2A {
                var j = i + 1
                if at(j) == 0xFE0F { j += 1 }
                guard at(j) == 0x20E3 else { return nil }
                kinds.append(.unicode)
                i = j + 1
                continue
            }
            if regional(cp) {
                guard regional(at(i + 1)) else { return nil }
                kinds.append(.unicode)
                i += 2
                continue
            }
            guard var j = element(i) else { return nil }
            while at(j) == 0x200D {
                guard let next = element(j + 1) else { return nil }
                j = next
            }
            kinds.append(.unicode)
            i = j
        }
        return kinds.isEmpty ? nil : Result(kinds: kinds)
    }

    /// The sizes on iOS (pt; docs/EMOJI.md §7): a standard emoji's font size, an image emoji's height (a wide one keeps
    /// its ratio, at most 3:1), a text emoji's pill height (its label 1.6× the inline one's), a pack emoji's height
    /// (several), and a single pack emoji's (a stamp).
    enum Jumbo {
        static let font: CGFloat = 30
        static let image: CGFloat = 34
        static let pill: CGFloat = 26
        static let pack: CGFloat = 64
        static let stamp: CGFloat = 120
    }
}
