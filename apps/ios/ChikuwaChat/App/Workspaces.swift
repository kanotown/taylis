import Foundation

// M16c (WORKSPACES.md): the servers this device signs in to, one account each. The list lives in UserDefaults;
// refresh tokens stay in the Keychain and messages in each workspace's own local store.

/// One registered workspace (WORKSPACES.md §4).
struct Workspace: Codable, Equatable, Identifiable {
    /// The list key: a normalized URL. A workspace migrated from an older build keeps the string it logged in with,
    /// because it names the Keychain item and the local database (`server|username`).
    var serverUrl: String
    /// GET /server; nil until the server has been asked (routes notifications, finds a duplicate).
    var workspaceId: String?
    /// GET /server; the host until known.
    var name: String
    var username: String
    var userId: String?
    /// The session ended without the user leaving (revoked elsewhere, refresh refused): kept for signing back in.
    var signedOut: Bool?
    /// The last known unread state while the workspace is not open (§6).
    var badge: Int?
    var hasUnread: Bool?

    var id: String { serverUrl }
    /// Names this account's Keychain item, local store and recent searches.
    var account: String { "\(serverUrl)|\(username)" }
    var isSignedIn: Bool { signedOut != true }
    var host: String { Workspaces.host(serverUrl) }
    /// The key of the tile colour (same as the desktop rail).
    var colorKey: String { workspaceId ?? serverUrl }
    var initials: String { Workspaces.initials(name) }
    /// Something waits there (for the switcher; the open workspace shows its own counts).
    var hasNews: Bool { isSignedIn && ((badge ?? 0) > 0 || hasUnread == true) }

    init(serverUrl: String, workspaceId: String? = nil, name: String? = nil, username: String, userId: String? = nil,
         signedOut: Bool? = nil, badge: Int? = nil, hasUnread: Bool? = nil) {
        self.serverUrl = serverUrl
        self.workspaceId = workspaceId
        self.name = name ?? Workspaces.host(serverUrl)
        self.username = username
        self.userId = userId
        self.signedOut = signedOut
        self.badge = badge
        self.hasUnread = hasUnread
    }

    private enum CodingKeys: String, CodingKey { case serverUrl, workspaceId, name, username, userId, signedOut, badge, hasUnread }

    /// A damaged field loses only itself; a row without its server or account is not a workspace.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        serverUrl = try c.decode(String.self, forKey: .serverUrl)
        username = try c.decode(String.self, forKey: .username)
        workspaceId = try? c.decodeIfPresent(String.self, forKey: .workspaceId)
        name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? Workspaces.host(serverUrl)
        userId = try? c.decodeIfPresent(String.self, forKey: .userId)
        signedOut = try? c.decodeIfPresent(Bool.self, forKey: .signedOut)
        badge = try? c.decodeIfPresent(Int.self, forKey: .badge)
        hasUnread = try? c.decodeIfPresent(Bool.self, forKey: .hasUnread)
    }
}

/// What a notification says about where it comes from (PUSH_NOTIFICATIONS.md §5; APNs keeps these outside `aps`).
struct PushPayload: Equatable, Sendable {
    var workspaceId: String?
    var channelId: String?
    var messageId: String?
    /// `aps.badge`: that server's count for this account.
    var badge: Int?

    init(workspaceId: String? = nil, channelId: String? = nil, messageId: String? = nil, badge: Int? = nil) {
        self.workspaceId = workspaceId
        self.channelId = channelId
        self.messageId = messageId
        self.badge = badge
    }

    init(userInfo: [AnyHashable: Any]) {
        func text(_ key: String) -> String? {
            guard let value = userInfo[key] as? String, !value.isEmpty else { return nil }
            return value
        }
        workspaceId = text("workspace_id")
        channelId = text("channel_id")
        messageId = text("message_id")
        badge = (userInfo["aps"] as? [AnyHashable: Any])?["badge"] as? Int
    }
}

enum Workspaces {
    static let listKey = "chikuwa.workspaces"
    static let activeKey = "chikuwa.workspace.active"
    /// The single server and account older builds kept; they now follow the active workspace.
    static let legacyServerKey = "chikuwa.server"
    static let legacyUsernameKey = "chikuwa.username"

    /// "chat.example.com" → "https://chat.example.com": https:// when no scheme is typed, lower-case scheme and
    /// host, no default port, no user, query or trailing "/" (scheme + host (+ port) + path, §4). nil if it is not
    /// an http(s) address.
    static func normalize(_ input: String) -> String? {
        var text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        if text.range(of: "^[A-Za-z][A-Za-z0-9+.-]*://", options: .regularExpression) == nil { text = "https://" + text }
        guard let components = URLComponents(string: text), let scheme = components.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = components.host, !host.isEmpty, components.user == nil, components.password == nil else { return nil }
        var result = "\(scheme)://\(host.lowercased())"
        if let port = components.port, !(scheme == "https" && port == 443), !(scheme == "http" && port == 80) { result += ":\(port)" }
        var path = components.percentEncodedPath
        while path.hasSuffix("/") { path.removeLast() }
        return result + path
    }

    /// Two spellings of one server ("HTTPS://Chat.example.com/" and "chat.example.com").
    static func sameServer(_ a: String, _ b: String) -> Bool { (normalize(a) ?? a) == (normalize(b) ?? b) }

    /// "chat.example.com" or "127.0.0.1:8000": the name until GET /server answers.
    static func host(_ serverUrl: String) -> String {
        guard let components = URLComponents(string: serverUrl), let host = components.host, !host.isEmpty else { return serverUrl }
        return components.port.map { "\(host):\($0)" } ?? host
    }

    /// The letters on a tile: 「テストチーム」 → テ, "ChikuwaChat" → C, "dev team" → DT (as on the desktop rail).
    static func initials(_ name: String) -> String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let words = trimmed.split(whereSeparator: { $0.isWhitespace || $0 == "." || $0 == "_" || $0 == "-" })
        func plain(_ character: Character?) -> Bool { character.map { $0.isASCII && ($0.isLetter || $0.isNumber) } ?? false }
        if words.count >= 2, plain(words[0].first), plain(words[1].first), let a = words[0].first, let b = words[1].first {
            return String([a, b]).uppercased()
        }
        guard let first = trimmed.first else { return "?" }
        return String(first).uppercased()
    }

    /// Which of the eight tile colours a workspace gets (the desktop's hash, so both show the same colour).
    static func paletteIndex(_ key: String) -> Int {
        var hash: UInt32 = 0
        for unit in key.utf16 { hash = hash &* 31 &+ UInt32(unit) }
        return Int(hash % 8)
    }

    struct Saved: Equatable {
        var list: [Workspace]
        var active: String?
    }

    /// The saved list in the order added. The first run after the update builds it from the single server an older
    /// build kept (keeping its exact spelling), when that account still has its refresh token.
    static func load(_ defaults: UserDefaults, hasCredentials: (String) -> Bool) -> Saved {
        var list: [Workspace] = []
        if let text = defaults.string(forKey: listKey), let data = text.data(using: .utf8),
           let rows = (try? JSONSerialization.jsonObject(with: data)) as? [Any] {
            list = rows.compactMap { row in
                guard let object = row as? [String: Any], let json = try? JSONSerialization.data(withJSONObject: object) else { return nil }
                return try? JSONDecoder().decode(Workspace.self, from: json)
            }
            var seen = Set<String>()
            list = list.filter { seen.insert($0.serverUrl).inserted }
        }
        var active = defaults.string(forKey: activeKey)
        if list.isEmpty, let server = defaults.string(forKey: legacyServerKey), !server.isEmpty,
           let username = defaults.string(forKey: legacyUsernameKey), !username.isEmpty, hasCredentials("\(server)|\(username)") {
            list = [Workspace(serverUrl: server, username: username)]
            active = server
            save(Saved(list: list, active: active), to: defaults)
        }
        if active.map({ current in !list.contains { $0.serverUrl == current } }) ?? true { active = list.first?.serverUrl }
        return Saved(list: list, active: active)
    }

    static func save(_ saved: Saved, to defaults: UserDefaults) {
        if let data = try? JSONEncoder().encode(saved.list), let text = String(data: data, encoding: .utf8) { defaults.set(text, forKey: listKey) }
        if let active = saved.active { defaults.set(active, forKey: activeKey) } else { defaults.removeObject(forKey: activeKey) }
        // The older keys follow the active workspace; with none left they go, so the list is never rebuilt from them.
        if let current = saved.list.first(where: { $0.serverUrl == saved.active }) {
            defaults.set(current.serverUrl, forKey: legacyServerKey)
            defaults.set(current.username, forKey: legacyUsernameKey)
        } else {
            defaults.removeObject(forKey: legacyServerKey)
            defaults.removeObject(forKey: legacyUsernameKey)
        }
    }

    /// The registered workspace that is the same deployment: the same workspace_id, or the same address once
    /// normalized (one server, one account: §5.1).
    static func duplicate(of serverUrl: String, workspaceId: String?, in list: [Workspace]) -> Workspace? {
        list.first { entry in (workspaceId != nil && entry.workspaceId == workspaceId) || sameServer(entry.serverUrl, serverUrl) }
    }

    /// Which workspace a notification belongs to (§7): its workspace_id; else the one whose local store has the
    /// channel (a server without workspace_id, or an id changed by a restore); else the active one.
    static func route(_ payload: PushPayload, list: [Workspace], active: String?, hasChannel: (Workspace, String) -> Bool) -> Workspace? {
        if let id = payload.workspaceId, let match = list.first(where: { $0.workspaceId == id }) { return match }
        if let channelId = payload.channelId {
            let ordered = list.filter { $0.serverUrl == active } + list.filter { $0.serverUrl != active }
            if let match = ordered.first(where: { hasChannel($0, channelId) }) { return match }
        }
        return list.first { $0.serverUrl == active } ?? list.first
    }

    /// willPresent (§7): a notification that arrives with the app on screen shows, except for the conversation open
    /// in the workspace on screen (its WebSocket delivered the message already).
    static func shouldPresent(_ payload: PushPayload, target: Workspace?, active: String?, openChannelId: String?) -> Bool {
        guard let target, target.serverUrl == active, let channelId = payload.channelId, let openChannelId else { return true }
        return channelId != openChannelId
    }

    /// The app icon (§6): the open workspace's own count plus the last known counts of the others.
    static func appBadge(activeBadge: Int, active: String?, list: [Workspace]) -> Int {
        max(0, activeBadge) + list.filter { $0.serverUrl != active && $0.isSignedIn }.reduce(0) { $0 + max(0, $1.badge ?? 0) }
    }
}
