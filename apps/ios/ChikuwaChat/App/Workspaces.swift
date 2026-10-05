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
    /// The name signed in with: it names the Keychain item and the local database, so it stays after a rename.
    var username: String
    /// M96: the account's username now, when it changed after signing in; nil = `username`.
    var loginName: String?
    var userId: String?
    /// The session ended without the user leaving (revoked elsewhere, refresh refused): kept for signing back in.
    var signedOut: Bool?
    /// The last known unread state while the workspace is not open (§6).
    var badge: Int?
    var hasUnread: Bool?
    /// M93 (WORKSPACES.md §3.4): the admin's workspace icon (GET /server's `icon_version`); nil = the letter tile.
    var iconVersion: String?

    var id: String { serverUrl }
    /// Names this account's Keychain item, local store and recent searches.
    var account: String { "\(serverUrl)|\(username)" }
    /// M96: the name to show and to sign in with (`username` may be the old one).
    var signInName: String { loginName ?? username }
    var isSignedIn: Bool { signedOut != true }
    var host: String { Workspaces.host(serverUrl) }
    /// The key of the tile colour (same as the desktop rail).
    var colorKey: String { workspaceId ?? serverUrl }
    var initials: String { Workspaces.initials(name) }
    /// Something waits there (for the switcher; the open workspace shows its own counts).
    var hasNews: Bool { isSignedIn && ((badge ?? 0) > 0 || hasUnread == true) }

    init(serverUrl: String, workspaceId: String? = nil, name: String? = nil, username: String, loginName: String? = nil, userId: String? = nil,
         signedOut: Bool? = nil, badge: Int? = nil, hasUnread: Bool? = nil, iconVersion: String? = nil) {
        self.serverUrl = serverUrl
        self.workspaceId = workspaceId
        self.name = name ?? Workspaces.host(serverUrl)
        self.username = username
        self.loginName = loginName
        self.userId = userId
        self.signedOut = signedOut
        self.badge = badge
        self.hasUnread = hasUnread
        self.iconVersion = iconVersion
    }

    private enum CodingKeys: String, CodingKey { case serverUrl, workspaceId, name, username, loginName, userId, signedOut, badge, hasUnread, iconVersion }

    /// A damaged field loses only itself; a row without its server or account is not a workspace.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        serverUrl = try c.decode(String.self, forKey: .serverUrl)
        username = try c.decode(String.self, forKey: .username)
        loginName = try? c.decodeIfPresent(String.self, forKey: .loginName)
        workspaceId = try? c.decodeIfPresent(String.self, forKey: .workspaceId)
        name = (try? c.decodeIfPresent(String.self, forKey: .name)) ?? Workspaces.host(serverUrl)
        userId = try? c.decodeIfPresent(String.self, forKey: .userId)
        signedOut = try? c.decodeIfPresent(Bool.self, forKey: .signedOut)
        badge = try? c.decodeIfPresent(Int.self, forKey: .badge)
        hasUnread = try? c.decodeIfPresent(Bool.self, forKey: .hasUnread)
        iconVersion = try? c.decodeIfPresent(String.self, forKey: .iconVersion)
    }
}

/// What a notification says about where it comes from (PUSH_NOTIFICATIONS.md §5; APNs keeps these outside `aps`).
struct PushPayload: Equatable, Sendable {
    var workspaceId: String?
    var channelId: String?
    var messageId: String?
    /// The reply's thread (M28d): a tap opens it with the channel.
    var parentId: String?
    /// `aps.badge`: that server's count for this account.
    var badge: Int?
    /// "message" (also when absent), "reminder", "reaction" (M39), "calendar" (M51), "task" (M55) …
    var kind: String?
    /// M52: a calendar alarm's event (`kind = calendar`; its `channel_id` is null for my own calendar).
    var eventId: String?
    /// M56: an assigned or due task (`kind = task`; its `channel_id` is null for my own list).
    var taskId: String?
    /// M73: a canvas that newly mentions me (`kind = canvas`, CANVAS.md §18.1).
    var canvasId: String?

    init(workspaceId: String? = nil, channelId: String? = nil, messageId: String? = nil, parentId: String? = nil, badge: Int? = nil,
         kind: String? = nil, eventId: String? = nil, taskId: String? = nil, canvasId: String? = nil) {
        self.workspaceId = workspaceId
        self.channelId = channelId
        self.messageId = messageId
        self.parentId = parentId
        self.badge = badge
        self.kind = kind
        self.eventId = eventId
        self.taskId = taskId
        self.canvasId = canvasId
    }

    /// M52: a calendar alarm opens its event (in its channel's 「予定」 tab, or in the calendar for my own).
    var opensEvent: Bool { kind == "calendar" && eventId != nil }

    /// M56: a task's notification opens the task (in its channel's 「タスク」 tab, or in 「自分のタスク」 for my own).
    var opensTask: Bool { kind == "task" && taskId != nil }

    /// M73: a canvas mention opens that canvas (its conversation's 「キャンバス」 tab).
    var opensCanvas: Bool { kind == "canvas" && canvasId != nil }

    /// M39: a reaction to my message opens that message (it may be far above the conversation's unread position); a
    /// message push opens its conversation (and a reply's thread) as before.
    var opensMessage: Bool { kind == "reaction" && messageId != nil }

    init(userInfo: [AnyHashable: Any]) {
        func text(_ key: String) -> String? {
            guard let value = userInfo[key] as? String, !value.isEmpty else { return nil }
            return value
        }
        workspaceId = text("workspace_id")
        channelId = text("channel_id")
        messageId = text("message_id")
        parentId = text("parent_id")
        kind = text("kind")
        eventId = text("event_id")
        taskId = text("task_id")
        canvasId = text("canvas_id")
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

    /// §5.4 (M114): the list with the entries at `source` moved before `destination` (the offsets `List.onMove` gives).
    static func moved(_ list: [Workspace], fromOffsets source: IndexSet, toOffset destination: Int) -> [Workspace] {
        let moving = source.filter { list.indices.contains($0) }.map { list[$0] }
        var rest = list.enumerated().filter { !source.contains($0.offset) }.map(\.element)
        let at = destination - source.filter { $0 < destination }.count
        rest.insert(contentsOf: moving, at: min(max(at, 0), rest.count))
        return rest
    }

    /// §5.4 (M114): one workspace a step up (`by: -1`) or down (`by: 1`); at an end the list stays as it is.
    static func moved(_ list: [Workspace], _ serverUrl: String, by delta: Int) -> [Workspace] {
        guard let index = list.firstIndex(where: { $0.serverUrl == serverUrl }), list.indices.contains(index + delta) else { return list }
        var next = list
        next.swapAt(index, index + delta)
        return next
    }

    /// The saved list in the order the person left it (§5.4; new ones last). The first run after the update builds it from the single server an older
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
    /// A calendar alarm and a task's notification (M56) always show: the open conversation says nothing of them.
    static func shouldPresent(_ payload: PushPayload, target: Workspace?, active: String?, openChannelId: String?) -> Bool {
        // A canvas mention (M73) is not the conversation's messages: shown even while that conversation is open.
        // A test notification (PUSH_NOTIFICATIONS.md §15) is pressed for with the app open: it must show.
        if payload.kind == "calendar" || payload.kind == "task" || payload.kind == "canvas" || payload.kind == "test" { return true }
        guard let target, target.serverUrl == active, let channelId = payload.channelId, let openChannelId else { return true }
        return channelId != openChannelId
    }

    /// The app icon (§6): the open workspace's own count plus the last known counts of the others.
    static func appBadge(activeBadge: Int, active: String?, list: [Workspace]) -> Int {
        max(0, activeBadge) + list.filter { $0.serverUrl != active && $0.isSignedIn }.reduce(0) { $0 + max(0, $1.badge ?? 0) }
    }
}
