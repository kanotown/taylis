import Foundation

/// M37 (MOBILE_UI.md §6.2): finding a conversation or a person by name in 「移動・検索」 and the ✏️ picker. The rule
/// and its cases are apps/shared/jump-match.json (gen_jump_match.py is the reference); the web, Android and the
/// desktop's ⌘K follow the same file.
enum JumpMatch {
    struct Item: Equatable {
        let id: String
        /// What the order falls back to (a channel's name, a DM's people).
        let title: String
        /// What the query is matched against: a channel's name; a DM's people's display names and usernames.
        let names: [String]
        var unread = false
    }

    /// Word boundaries: space, - _ . / ・ and the ideographic space (NFKC makes that one a space already).
    private static let separators: Set<Unicode.Scalar> = Set(" -_./・\u{3000}".unicodeScalars)  // i18n-ignore

    /// NFKC (full-width / half-width forms), lower case, katakana as hiragana, no leading # or @, trimmed.
    static func normalize(_ text: String) -> String {
        // NFC after Foundation's NFKC: it leaves a half-width voiced mark apart (ｾﾞ → セ + U+3099, not ゼ as Python,
        // Java and JavaScript give).
        let folded = text.precomposedStringWithCompatibilityMapping.precomposedStringWithCanonicalMapping.lowercased()
            .trimmingCharacters(in: .whitespacesAndNewlines)
        var scalars = String.UnicodeScalarView()
        for scalar in folded.unicodeScalars {
            if (0x30A1...0x30F6).contains(scalar.value), let hiragana = Unicode.Scalar(scalar.value - 0x60) {
                scalars.append(hiragana)
            } else {
                scalars.append(scalar)
            }
        }
        let kana = String(scalars)
        return String(kana.unicodeScalars.drop { $0 == "#" || $0 == "@" }).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// 0: a name starts with the query; 1: a word in a name does; 2: a name contains it; nil: no match (or no query).
    /// The best over the names.
    static func score(_ query: String, names: [String]) -> Int? {
        let q = Array(normalize(query).unicodeScalars)
        guard !q.isEmpty else { return nil }
        var best: Int?
        for name in names {
            let n = Array(normalize(name).unicodeScalars)
            let s: Int
            if starts(n, at: 0, with: q) {
                s = 0
            } else if n.indices.dropFirst().contains(where: { separators.contains(n[$0 - 1]) && starts(n, at: $0, with: q) }) {
                s = 1
            } else if n.indices.contains(where: { starts(n, at: $0, with: q) }) {
                s = 2
            } else {
                continue
            }
            best = min(best ?? s, s)
        }
        return best
    }

    /// The matches only: by score, then unread first, then the normalized title in UTF-16 code unit order (no locale
    /// collation, the same on every platform), then the id.
    static func rank(_ query: String, _ items: [Item]) -> [Item] {
        let keyed = items.compactMap { item -> (Int, Bool, [UInt16], [UInt16], Item)? in
            guard let s = score(query, names: item.names) else { return nil }
            return (s, !item.unread, Array(normalize(item.title).utf16), Array(item.id.utf16), item)
        }
        return keyed.sorted { a, b in
            if a.0 != b.0 { return a.0 < b.0 }
            if a.1 != b.1 { return !a.1 }
            if a.2 != b.2 { return a.2.lexicographicallyPrecedes(b.2) }
            return a.3.lexicographicallyPrecedes(b.3)
        }.map(\.4)
    }

    private static func starts(_ text: [Unicode.Scalar], at index: Int, with prefix: [Unicode.Scalar]) -> Bool {
        guard index + prefix.count <= text.count else { return false }
        return text[index..<(index + prefix.count)].elementsEqual(prefix)
    }

    // MARK: what the lists offer

    /// A conversation as the jump view matches it: a channel by its name; a DM by the other members' display names
    /// and usernames; my DM with myself by my own.
    static func item(_ channel: ChannelState, users: [String: UserPublic], me: UserPublic?, meId: String?) -> Item {
        let unread = channel.hasUnread(meId: meId)
        guard channel.channel.isDm else {
            let name = channel.channel.name ?? ""
            return Item(id: channel.id, title: name, names: [name], unread: unread)
        }
        let others = (channel.channel.dmUserIds ?? []).filter { $0 != meId }
        let people: [UserPublic] = others.isEmpty ? (me.map { [$0] } ?? []) : others.compactMap { users[$0] }
        let title = people.map { $0.displayName.isEmpty ? $0.username : $0.displayName }.joined(separator: ", ")
        return Item(id: channel.id, title: title, names: people.flatMap { [$0.displayName, $0.username] }, unread: unread)
    }

    /// 「会話」: the conversations I am in, less the archived ones, ranked; at most `limit`.
    static func conversations(_ query: String, channels: [ChannelState], users: [String: UserPublic], me: UserPublic?,
                              limit: Int = 20) -> [String] {
        let meId = me?.id
        let items = channels.filter { $0.isMember && !$0.channel.archived }.map { item($0, users: users, me: me, meId: meId) }
        return Array(rank(query, items).prefix(limit).map(\.id))
    }

    /// 「人」: people who are not deactivated (me too: my DM with myself), ranked; at most `limit`.
    static func people(_ query: String, users: [UserPublic], limit: Int = 10) -> [String] {
        let items = users.filter { $0.deactivatedAt == nil }.map { Item(id: $0.id, title: $0.displayName, names: [$0.displayName, $0.username]) }
        return Array(rank(query, items).prefix(limit).map(\.id))
    }

    // MARK: 「新しいメッセージ」 (M37 (6))

    /// The channels a new message can go to: those I am in, then the public ones I can join (not a guest's); by name
    /// without a query, ranked with one.
    static func destinationChannels(_ query: String, channels: [ChannelState], joinable: Bool = true) -> [String] {
        let live = channels.filter { !$0.channel.isDm && !$0.channel.archived }
        let mine = live.filter(\.isMember)
        let open = joinable ? live.filter { !$0.isMember && $0.channel.type == "public" } : []
        let typed = !normalize(query).isEmpty
        let ordered = { (rows: [ChannelState]) -> [String] in
            let items = rows.map { Item(id: $0.id, title: $0.channel.name ?? "", names: [$0.channel.name ?? ""]) }
            if typed { return rank(query, items).map(\.id) }
            return items.sorted { a, b in
                let x = Array(normalize(a.title).utf16), y = Array(normalize(b.title).utf16)
                return x != y ? x.lexicographicallyPrecedes(y) : a.id < b.id
            }.map(\.id)
        }
        return ordered(mine) + ordered(open)
    }

    /// The people a new message can go to: me first (my DM with myself), then by display name; ranked with a query.
    static func destinationPeople(_ query: String, users: [UserPublic], meId: String?) -> [String] {
        let live = users.filter { $0.deactivatedAt == nil }
        if !normalize(query).isEmpty { return people(query, users: live, limit: live.count) }
        let others = live.filter { $0.id != meId }.sorted { a, b in
            a.displayName != b.displayName ? a.displayName < b.displayName : a.id < b.id
        }
        return live.filter { $0.id == meId }.map(\.id) + others.map(\.id)
    }
}

/// 「最近の会話」 (M37): the last ten conversations opened on this device, per workspace account (UserDefaults, a
/// convenience only; the server knows nothing of it).
enum RecentConversations {
    static let limit = 10

    /// `account` is "server|username", as for the recent searches.
    static func key(account: String) -> String { "chikuwa.jump.recent:\(account)" }

    static func read(key: String, defaults: UserDefaults = .standard) -> [String] {
        Array((defaults.stringArray(forKey: key) ?? []).prefix(limit))
    }

    /// Newest first, each once.
    static func pushed(_ id: String, onto list: [String]) -> [String] {
        Array(([id] + list.filter { $0 != id }).prefix(limit))
    }

    @discardableResult
    static func push(_ id: String, key: String, defaults: UserDefaults = .standard) -> [String] {
        let current = read(key: key, defaults: defaults)
        let next = pushed(id, onto: current)
        if next != current { defaults.set(next, forKey: key) }
        return next
    }
}
