import Foundation
import Observation

/// A conversation a share can go to (MOBILE_UI.md §21.2).
struct ShareDestination: Codable, Equatable, Hashable, Identifiable {
    /// The channel id.
    var id: String
    /// 「#general」, or a DM's other people (「Alice, Bob」).
    var title: String
    /// "public" / "private" / "dm" / "group_dm".
    var kind: String
    var lastMessageAt: String?
    /// Also matched by the search: the DM people's usernames.
    var keywords: String = ""

    var isDm: Bool { kind == "dm" || kind == "group_dm" }
}

enum ShareDestinations {
    static let recentKey = "share.recent"
    /// The recent conversations the app leaves for the share sheet (newest message first).
    static let recentLimit = 30

    static func recent(account: String, _ defaults: UserDefaults = SharedContainer.defaults) -> [ShareDestination] {
        guard let data = (defaults.dictionary(forKey: recentKey) ?? [:])[account] as? Data else { return [] }
        return (try? JSONDecoder().decode([ShareDestination].self, from: data)) ?? []
    }

    static func saveRecent(_ list: [ShareDestination], account: String, to defaults: UserDefaults = SharedContainer.defaults) {
        var all = defaults.dictionary(forKey: recentKey) ?? [:]
        guard let data = try? JSONEncoder().encode(Array(list.prefix(recentLimit))), all[account] as? Data != data else { return }
        all[account] = data
        defaults.set(all, forKey: recentKey)
    }

    static func clearRecent(account: String, _ defaults: UserDefaults = SharedContainer.defaults) {
        var all = defaults.dictionary(forKey: recentKey) ?? [:]
        guard all.removeValue(forKey: account) != nil else { return }
        defaults.set(all, forKey: recentKey)
    }

    /// Newest conversation first (no message yet: last).
    static func ordered(_ list: [ShareDestination]) -> [ShareDestination] {
        list.sorted { ($0.lastMessageAt ?? "") > ($1.lastMessageAt ?? "") }
    }

    /// My conversations from GET /channels and GET /users that a top-level post can go to: not archived, and an
    /// announcement channel (`posting_policy = owners`) only for its owners and the admins.
    static func build(channels: [ShareApi.Channel], users: [ShareApi.User], meId: String?, isAdmin: Bool) -> [ShareDestination] {
        let byId = Dictionary(users.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let list = channels.compactMap { channel -> ShareDestination? in
            guard !channel.archived, channel.membership != nil || channel.type == "dm" || channel.type == "group_dm" else { return nil }
            if channel.postingPolicy == "owners", !isAdmin, channel.membership?.role != "owner" { return nil }
            if channel.type == "dm" || channel.type == "group_dm" {
                let others = (channel.dmUserIds ?? []).filter { $0 != meId }
                let people = (others.isEmpty ? [meId].compactMap { $0 } : others).compactMap { byId[$0] }
                let title = people.map { $0.displayName.isEmpty ? $0.username : $0.displayName }.joined(separator: ", ")
                return ShareDestination(id: channel.id, title: title.isEmpty ? "…" : title, kind: channel.type,
                                        lastMessageAt: channel.lastMessageAt, keywords: people.map(\.username).joined(separator: " "))
            }
            return ShareDestination(id: channel.id, title: "#\(channel.name ?? "")", kind: channel.type, lastMessageAt: channel.lastMessageAt)
        }
        return ordered(list)
    }

    /// The conversations whose name (without 「#」) or DM usernames contain every word of `query`, ignoring case and
    /// full/half width; names that start with the query come first. An empty query answers the list as it is.
    static func search(_ query: String, in list: [ShareDestination]) -> [ShareDestination] {
        let words = fold(query).split(whereSeparator: { $0.isWhitespace }).map(String.init)
        guard !words.isEmpty else { return list }
        let matches = list.filter { destination in
            let haystack = fold(destination.title + " " + destination.keywords)
            return words.allSatisfy { haystack.contains($0) }
        }
        let first = words[0]
        let starting = matches.filter { fold($0.title).trimmingCharacters(in: CharacterSet(charactersIn: "#")).hasPrefix(first) }
        return starting + matches.filter { !starting.contains($0) }
    }

    static func fold(_ text: String) -> String {
        (text.applyingTransform(.fullwidthToHalfwidth, reverse: false) ?? text)
            .folding(options: [.caseInsensitive, .diacriticInsensitive, .widthInsensitive], locale: nil)
    }
}

/// The share sheet's destination list (MOBILE_UI.md §21.2): the recent conversations the app left in the App Group
/// show at once; the first search loads every conversation of mine from the server (GET /channels, GET /users) and
/// searches those.
@MainActor
@Observable
final class ShareDestinationModel {
    let account: String
    private(set) var recent: [ShareDestination]
    /// Every conversation of mine, once loaded.
    private(set) var all: [ShareDestination]?
    private(set) var loading = false
    private(set) var failure: ShareFailure?
    var query = ""
    @ObservationIgnored private let fetch: () async throws -> [ShareDestination]

    init(account: String, recent: [ShareDestination], fetch: @escaping () async throws -> [ShareDestination]) {
        self.account = account
        self.recent = recent
        self.fetch = fetch
    }

    /// For a workspace: the cache, and the server through `api`.
    convenience init(workspace: Workspace, api: ShareApi) {
        self.init(account: workspace.account, recent: ShareDestinations.recent(account: workspace.account)) {
            async let channels = api.channels()
            async let users = api.users()
            async let me = api.me()
            let profile = try await me
            return ShareDestinations.build(channels: try await channels, users: try await users, meId: profile.id, isAdmin: profile.role == "admin")
        }
    }

    /// What the list shows: the query's matches among every conversation (the recent ones while they load), or the
    /// recent ones (every conversation when the app left none).
    var results: [ShareDestination] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return recent.isEmpty ? (all ?? []) : recent }
        return ShareDestinations.search(trimmed, in: all ?? recent)
    }

    /// Loads every conversation once (on the first search, or at once when there is no cache).
    func loadAll() async {
        guard all == nil, !loading else { return }
        loading = true
        defer { loading = false }
        do {
            let list = try await fetch()
            all = list
            failure = nil
            // Freshen the recent list too: a conversation left or archived since the app wrote it goes.
            if !recent.isEmpty {
                let current = Dictionary(list.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
                recent = recent.compactMap { current[$0.id] }
            }
        } catch {
            failure = (error as? ShareFailure) ?? .temporary("network_error")
        }
    }
}
