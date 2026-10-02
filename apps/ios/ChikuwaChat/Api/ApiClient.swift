import Foundation

/// Structured API errors (ARCHITECTURE.md §9).
enum ApiError: Error {
    case api(status: Int, code: String, message: String)
    case network(Error)

    var isAuth: Bool { if case .api(let status, _, _) = self { return status == 401 } else { return false } }

    /// Temporary failures worth retrying; the idempotency key prevents duplicates.
    var isRetryable: Bool {
        switch self {
        case .network: return true
        case .api(let status, _, _): return status == 429 || status >= 500
        }
    }

    /// 4xx other than 401 and 429: the request itself was refused, so sending it again cannot help.
    var isRefused: Bool {
        if case .api(let status, _, _) = self { return (400..<500).contains(status) && status != 401 && status != 429 }
        return false
    }

    var code: String {
        if case .api(_, let code, _) = self { return code }
        return "network_error"
    }
}

extension ErrorMessages {
    /// What the user reads for a failure (ARCHITECTURE.md §9): the shared Japanese text for the code, else for the
    /// HTTP status, the network text for no response; never the server's English message or a Swift description.
    static func text(for error: Error) -> String {
        switch error {
        case ApiError.api(let status, let code, _):
            if let text = byCode[code] { return text }
            if status >= 500 { return byStatus["5xx"] ?? unknown }
            return byStatus[String(status)] ?? unknown
        case ApiError.network:
            return network
        default:
            return unknown
        }
    }
}

/// Thin HTTP client: bearer auth, single-flight refresh on token_expired, structured errors.
@MainActor
final class ApiClient: SyncApi, DraftApi, ChannelLinksApi, ActivityApi, CanvasApi, CalendarApi, CalendarFeedApi, TaskApi, RecurringApi, AiApi {
    let baseUrl: URL
    private var sessionVersion = 0
    var accessToken: String?
    var refreshToken: String?
    /// When the access token stops being accepted, from `expires_in` on this device's clock (nil = unknown).
    private(set) var accessTokenExpiresAt: Date?
    /// Pauses between attempts of a refresh that failed on the way (SYNC_PROTOCOL.md §7.2).
    var refreshRetryDelays: [TimeInterval] = [1, 2, 4, 8]
    var onTokens: ((TokenResponse) -> Void)?
    var onSignedOut: (() -> Void)?
    private let session: URLSession
    private var refreshTask: Task<TokenResponse, Error>?
    /// A refresh answers quickly or is retried; the old token is honoured for 30 s only (SECURITY.md §2.3).
    private static let refreshTimeout: TimeInterval = 10

    init(baseUrl: URL, session: URLSession = .shared) {
        self.baseUrl = baseUrl
        self.session = session
    }

    var wsUrl: URL {
        var components = URLComponents(url: baseUrl, resolvingAgainstBaseURL: false)!
        components.scheme = components.scheme == "https" ? "wss" : "ws"
        components.path = "/api/v1/ws"
        return components.url!
    }

    // MARK: auth

    /// `totpCode` (M12i) is the authenticator or recovery code once the server answered 401 totp_required.
    func login(username: String, password: String, device: DeviceInfo, totpCode: String? = nil) async throws -> TokenResponse {
        var fields: [String: JSONValue] = [
            "username": .string(username),
            "password": .string(password),
            "device": .object([
                "platform": .string(device.platform),
                "device_name": device.deviceName.map(JSONValue.string) ?? .null,
                "app_version": device.appVersion.map(JSONValue.string) ?? .null,
            ]),
        ]
        if let totpCode, !totpCode.isEmpty { fields["totp_code"] = .string(totpCode) }
        let tokens: TokenResponse = try await request("POST", "/api/v1/auth/login", body: .object(fields), auth: false)
        apply(tokens)
        return tokens
    }

    /// GET /auth/methods (M48, no login).
    func authMethods() async throws -> AuthMethodsOut { try await request("GET", "/api/v1/auth/methods", auth: false, timeout: 15) }

    /// Whether the login screen offers 「Google でログイン」: only when the server says so. Any failure (a server before
    /// M48 answers 404, no answer, another product) just leaves the button out.
    func offersGoogle() async -> Bool {
        (try? await authMethods())?.googleEnabled == true
    }

    /// POST /auth/sso/exchange (M48): the ticket from the sign-in sheet and the verifier this app made for it → the same
    /// tokens as a login.
    func ssoExchange(ticket: String, verifier: String, device: DeviceInfo) async throws -> TokenResponse {
        let body: JSONValue = .object([
            "ticket": .string(ticket),
            "verifier": .string(verifier),
            "device": .object([
                "platform": .string(device.platform),
                "device_name": device.deviceName.map(JSONValue.string) ?? .null,
                "app_version": device.appVersion.map(JSONValue.string) ?? .null,
            ]),
        ])
        let tokens: TokenResponse = try await request("POST", "/api/v1/auth/sso/exchange", body: body, auth: false)
        apply(tokens)
        return tokens
    }

    /// §7.2: connect with the access token we have unless it is missing or expires within `margin` seconds.
    /// Every refresh rotates the refresh token, so refreshing only when needed keeps a lost response rare.
    func needsRefresh(margin: TimeInterval = 60) -> Bool {
        guard accessToken != nil, let expiresAt = accessTokenExpiresAt else { return true }
        return expiresAt.timeIntervalSinceNow < margin
    }

    func refresh() async throws -> TokenResponse {
        if let task = refreshTask { return try await task.value }
        guard let token = refreshToken else { throw ApiError.api(status: 401, code: "missing_token", message: "No refresh token") }
        let version = sessionVersion
        let delays = refreshRetryDelays
        let task = Task<TokenResponse, Error> {
            var attempt = 0
            while true {
                do {
                    guard version == sessionVersion else { throw ApiError.api(status: 401, code: "session_changed", message: "Session changed") }
                    let tokens: TokenResponse = try await request("POST", "/api/v1/auth/refresh", body: .object(["refresh_token": .string(token)]),
                                                                  auth: false, timeout: Self.refreshTimeout)
                    guard version == sessionVersion else { throw ApiError.api(status: 401, code: "session_changed", message: "Session changed") }
                    apply(tokens)
                    return tokens
                } catch let error as ApiError where error.isRetryable && attempt < delays.count {
                    // The server may have rotated the token and the answer got lost: the old one still works for
                    // 30 s, so try again at short intervals inside that grace (SYNC_PROTOCOL.md §7.2).
                    try? await Task.sleep(nanoseconds: UInt64(delays[attempt] * 1_000_000_000))
                    attempt += 1
                } catch {
                    if version == sessionVersion, let apiError = error as? ApiError, apiError.isAuth { signOut() }
                    throw error
                }
            }
        }
        refreshTask = task
        defer { refreshTask = nil }
        return try await task.value
    }

    /// Ends the server session (the device stops getting pushes), refreshing first when the access token has
    /// expired (SYNC_PROTOCOL.md §11); signed out locally in any case.
    func logout() async {
        _ = try? await requestRaw("POST", "/api/v1/auth/logout", body: nil, auth: true, retry401: true)
        signOut()
    }

    func signOut() {
        sessionVersion += 1
        accessToken = nil
        accessTokenExpiresAt = nil
        refreshToken = nil
        onSignedOut?()
    }

    private func apply(_ tokens: TokenResponse) {
        accessToken = tokens.accessToken
        accessTokenExpiresAt = Date().addingTimeInterval(TimeInterval(tokens.expiresIn))
        refreshToken = tokens.refreshToken
        onTokens?(tokens)
    }

    /// A path with a query. URLComponents leaves "+" as it is, which servers read as a space ("C++", links with
    /// "+" in them), so it is percent-encoded as well.
    static func pathWithQuery(_ path: String, _ items: [URLQueryItem]) -> String {
        var components = URLComponents()
        components.path = path
        components.queryItems = items
        components.percentEncodedQuery = components.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B")
        return components.string ?? path
    }

    // MARK: endpoints

    func me() async throws -> UserMe { try await request("GET", "/api/v1/users/me") }

    func changePassword(current: String, new: String) async throws {
        _ = try await requestRaw("PUT", "/api/v1/users/me/password",
                                 body: .object(["current_password": .string(current), "new_password": .string(new)]), auth: true, retry401: true)
    }

    /// M40: my signed-in devices; ending one signs that device out (its pushes stop).
    func sessions() async throws -> [SessionOut] { try await request("GET", "/api/v1/auth/sessions") }

    func revokeSession(id: String) async throws {
        _ = try await requestRaw("DELETE", "/api/v1/auth/sessions/\(id)", body: nil, auth: true, retry401: true)
    }

    func users() async throws -> [UserPublic] { try await request("GET", "/api/v1/users") }

    /// Register (or clear, with nil) this session's push token (PUSH_NOTIFICATIONS.md §3).
    func updateDevice(pushProvider: String, pushToken: String?, pushEnvironment: String) async throws -> DeviceOut {
        try await request("PUT", "/api/v1/devices/current", body: .object([
            "push_provider": .string(pushProvider),
            "push_token": pushToken.map(JSONValue.string) ?? .null,
            "push_environment": .string(pushEnvironment),
        ]))
    }

    func bootstrap() async throws -> BootstrapOut { try await request("GET", "/api/v1/sync/bootstrap") }

    func channels(includePublic: Bool) async throws -> [ChannelOut] {
        try await request("GET", "/api/v1/channels" + (includePublic ? "?include=public" : ""))
    }

    /// GET /channels/{id}: with the member's `last_message` (M49).
    func channel(id: String) async throws -> ChannelOut { try await request("GET", "/api/v1/channels/\(id)") }

    func publicChannels() async throws -> [ChannelOut] {
        try await channels(includePublic: true).filter { $0.membership == nil }
    }

    func createChannel(name: String, type: String) async throws -> ChannelOut {
        try await request("POST", "/api/v1/channels", body: .object(["name": .string(name), "type": .string(type)]))
    }

    func joinChannel(id: String) async throws -> ChannelOut { try await request("POST", "/api/v1/channels/\(id)/join", body: .object([:])) }

    /// M24: my times, made on the first call (201) and returned afterwards (200).
    func ensureTimes() async throws -> ChannelOut { try await request("POST", "/api/v1/times", body: .object([:])) }

    func leaveChannel(id: String) async throws {
        _ = try await requestRaw("POST", "/api/v1/channels/\(id)/leave", body: .object([:]), auth: true, retry401: true)
    }

    func archiveChannel(id: String) async throws -> ChannelOut { try await request("POST", "/api/v1/channels/\(id)/archive", body: .object([:])) }
    /// M13d: owner or administrator; the channel becomes writable again.
    func unarchiveChannel(id: String) async throws -> ChannelOut { try await request("POST", "/api/v1/channels/\(id)/unarchive", body: .object([:])) }

    /// `postingPolicy` (M15a) and `type` (M15b: "public" / "private") are for owners and admins.
    func updateChannel(id: String, topic: String? = nil, name: String? = nil, purpose: String? = nil,
                       postingPolicy: String? = nil, type: String? = nil) async throws -> ChannelOut {
        var body: [String: JSONValue] = [:]
        if let topic { body["topic"] = .string(topic) }
        if let name { body["name"] = .string(name) }
        if let purpose { body["purpose"] = .string(purpose) }
        if let postingPolicy { body["posting_policy"] = .string(postingPolicy) }
        if let type { body["type"] = .string(type) }
        return try await request("PATCH", "/api/v1/channels/\(id)", body: .object(body))
    }

    /// level nil = follow my overall setting (M35); muted nil = leave the mute until unmuted as it is.
    func setNotificationPreference(channelId: String, level: String?, mutedUntil: String?, muted: Bool? = nil) async throws -> NotificationPreferenceOut {
        var body: [String: JSONValue] = ["level": level.map(JSONValue.string) ?? .null, "muted_until": mutedUntil.map(JSONValue.string) ?? .null]
        if let muted { body["muted"] = .bool(muted) }
        return try await request("PUT", "/api/v1/channels/\(channelId)/notification-preference", body: .object(body))
    }

    func updateMe(displayName: String? = nil, email: String? = nil) async throws -> UserMe {
        var body: [String: JSONValue] = [:]
        if let displayName { body["display_name"] = .string(displayName) }
        if let email { body["email"] = .string(email) }
        return try await request("PATCH", "/api/v1/users/me", body: .object(body))
    }

    /// M11d: profile card fields; `.null` clears a field, omitted fields keep their value.
    func updateProfile(_ fields: [String: JSONValue]) async throws -> UserMe {
        try await request("PATCH", "/api/v1/users/me", body: .object(fields))
    }

    func members(channelId: String) async throws -> [MemberOut] { try await request("GET", "/api/v1/channels/\(channelId)/members") }

    func addMember(channelId: String, userId: String) async throws -> MemberOut {
        try await request("POST", "/api/v1/channels/\(channelId)/members", body: .object(["user_id": .string(userId)]))
    }

    func createDm(userIds: [String]) async throws -> ChannelOut {
        try await request("POST", "/api/v1/dms", body: .object(["user_ids": .array(userIds.map(JSONValue.string))]))
    }

    func history(channelId: String, beforeSeq: Int?, limit: Int) async throws -> HistoryOut {
        var path = "/api/v1/channels/\(channelId)/messages?limit=\(limit)"
        if let beforeSeq { path += "&before_seq=\(beforeSeq)" }
        return try await request("GET", path)
    }

    func delta(channelId: String, sinceSeq: Int, limit: Int) async throws -> DeltaOut {
        try await request("GET", "/api/v1/channels/\(channelId)/sync?since_seq=\(sinceSeq)&limit=\(limit)")
    }

    func postMessage(channelId: String, clientMsgId: String, body: String, parentId: String? = nil, attachmentIds: [String] = [],
                     options: SendOptions = SendOptions()) async throws -> (MessageOut, Bool) {
        var fields: [String: JSONValue] = ["client_msg_id": .string(clientMsgId), "body": .string(body),
                                           "parent_id": parentId.map(JSONValue.string) ?? .null,
                                           "attachment_ids": .array(attachmentIds.map(JSONValue.string))]
        if options.alsoInChannel { fields["also_in_channel"] = .bool(true) } // M15c
        if let priority = options.priority { fields["priority"] = .string(priority) } // M15e
        if options.ackRequested { fields["ack_requested"] = .bool(true) }
        let (data, status) = try await requestRaw("POST", "/api/v1/channels/\(channelId)/messages", body: .object(fields), auth: true, retry401: true)
        return (try JSON.snakeDecoder.decode(MessageOut.self, from: data), status == 201)
    }

    // MARK: channel links (M15f)

    func channelLinks(channelId: String) async throws -> [ChannelLinkOut] { try await request("GET", "/api/v1/channels/\(channelId)/links") }

    func addChannelLink(channelId: String, title: String, url: String) async throws -> [ChannelLinkOut] {
        try await request("POST", "/api/v1/channels/\(channelId)/links", body: .object(["title": .string(title), "url": .string(url)]))
    }

    func updateChannelLink(channelId: String, linkId: String, title: String? = nil, url: String? = nil, position: Int? = nil) async throws -> [ChannelLinkOut] {
        var body: [String: JSONValue] = [:]
        if let title { body["title"] = .string(title) }
        if let url { body["url"] = .string(url) }
        if let position { body["position"] = .number(Double(position)) }
        return try await request("PATCH", "/api/v1/channels/\(channelId)/links/\(linkId)", body: .object(body))
    }

    func deleteChannelLink(channelId: String, linkId: String) async throws -> [ChannelLinkOut] {
        try await request("DELETE", "/api/v1/channels/\(channelId)/links/\(linkId)")
    }

    // MARK: acknowledgements (M15e)

    func acknowledge(messageId: String, present: Bool) async throws -> MessageOut {
        present ? try await request("PUT", "/api/v1/messages/\(messageId)/ack", body: .object([:]))
                : try await request("DELETE", "/api/v1/messages/\(messageId)/ack")
    }

    // MARK: drafts (M15d)

    func saveDraft(channelId: String, parentId: String?, body: String) async throws -> DraftOut {
        try await request("PUT", "/api/v1/drafts", body: .object(["channel_id": .string(channelId), "parent_id": parentId.map(JSONValue.string) ?? .null,
                                                                  "body": .string(body)]))
    }

    func deleteDraft(channelId: String, parentId: String?) async throws {
        let items = [URLQueryItem(name: "channel_id", value: channelId)] + (parentId.map { [URLQueryItem(name: "parent_id", value: $0)] } ?? [])
        _ = try await requestRaw("DELETE", Self.pathWithQuery("/api/v1/drafts", items), body: nil, auth: true, retry401: true)
    }

    // MARK: link previews (M11g)

    func linkPreview(url: String) async throws -> LinkPreviewOut {
        try await request("GET", Self.pathWithQuery("/api/v1/link-previews", [URLQueryItem(name: "url", value: url)]))
    }

    // MARK: reminders (M12e)

    func createReminder(messageId: String, remindAt: Date, note: String?) async throws -> ReminderOut {
        try await request("POST", "/api/v1/messages/\(messageId)/reminders", body: .object([
            "remind_at": .string(ISO8601DateFormatter().string(from: remindAt)),
            "note": note.map(JSONValue.string) ?? .null,
        ]))
    }
    func listReminders() async throws -> [ReminderOut] { try await request("GET", "/api/v1/reminders") }
    /// Cancels a pending reminder or marks a fired one done.
    func closeReminder(id: String) async throws {
        _ = try await requestRaw("DELETE", "/api/v1/reminders/\(id)", body: nil, auth: true, retry401: true)
    }

    // MARK: scheduled messages (M12d)

    func scheduleMessage(channelId: String, clientMsgId: String, body: String, parentId: String?, attachmentIds: [String], sendAt: Date) async throws -> ScheduledOut {
        try await request("POST", "/api/v1/channels/\(channelId)/scheduled", body: .object([
            "client_msg_id": .string(clientMsgId), "body": .string(body),
            "parent_id": parentId.map(JSONValue.string) ?? .null,
            "attachment_ids": .array(attachmentIds.map(JSONValue.string)),
            "send_at": .string(ISO8601DateFormatter().string(from: sendAt)),
        ]))
    }
    func listScheduled() async throws -> [ScheduledOut] { try await request("GET", "/api/v1/scheduled") }
    /// M28d (parity): an owner or an admin takes a member out of a channel (the web had it; DATA_MODEL.md).
    /// L4: make a member an owner of the channel, or a member again.
    func setMemberRole(channelId: String, userId: String, role: String) async throws -> MemberOut {
        try await request("PATCH", "/api/v1/channels/\(channelId)/members/\(userId)", body: .object(["role": .string(role)]))
    }

    /// L4: who in the channel has not acknowledged the message (by display name).
    func ackPending(messageId: String) async throws -> [String] {
        struct Pending: Decodable { let userIds: [String] }
        let pending: Pending = try await request("GET", "/api/v1/messages/\(messageId)/ack/pending")
        return pending.userIds
    }

    /// L4: remind them (the author or an admin); how many got a reminder.
    func remindUnacknowledged(messageId: String) async throws -> Int {
        struct Reminded: Decodable { let reminded: Int }
        let result: Reminded = try await request("POST", "/api/v1/messages/\(messageId)/ack/remind")
        return result.reminded
    }

    func removeMember(channelId: String, userId: String) async throws {
        _ = try await requestRaw("DELETE", "/api/v1/channels/\(channelId)/members/\(userId)", body: nil, auth: true, retry401: true)
    }

    func cancelScheduled(id: String) async throws {
        _ = try await requestRaw("DELETE", "/api/v1/scheduled/\(id)", body: nil, auth: true, retry401: true)
    }
    func sendScheduledNow(id: String) async throws -> MessageOut { try await request("POST", "/api/v1/scheduled/\(id)/send-now", body: .object([:])) }

    // MARK: favorites and read-all (M12a)

    func favoriteChannel(id: String) async throws -> FavoriteStateOut { try await request("PUT", "/api/v1/channels/\(id)/favorite") }
    func unfavoriteChannel(id: String) async throws -> FavoriteStateOut { try await request("DELETE", "/api/v1/channels/\(id)/favorite") }
    func readAll() async throws -> [ChannelReadStateOut] { try await request("POST", "/api/v1/channels/read-all", body: .object([:])) }
    /// L8: `scope` "times" reads only the Times feed's channels (member, not muted) to their end; "all" is readAll().
    func readAll(scope: String) async throws -> [ChannelReadStateOut] {
        try await request("POST", "/api/v1/channels/read-all", body: .object(["scope": .string(scope)]))
    }

    /// GET /times/feed (L8, TIMES_FEED.md §3): `cursor` is the previous page's next_cursor.
    func timesFeed(cursor: String? = nil, limit: Int = 50) async throws -> TimesFeedOut {
        var items = [URLQueryItem(name: "limit", value: String(limit))]
        if let cursor { items.append(URLQueryItem(name: "cursor", value: cursor)) }
        return try await request("GET", Self.pathWithQuery("/api/v1/times/feed", items))
    }

    // MARK: pins and bookmarks (M11c)

    func listPins(channelId: String) async throws -> [MessageOut] { try await request("GET", "/api/v1/channels/\(channelId)/pins") }
    func pinMessage(id: String) async throws -> MessageOut { try await request("PUT", "/api/v1/messages/\(id)/pin") }
    func unpinMessage(id: String) async throws -> MessageOut { try await request("DELETE", "/api/v1/messages/\(id)/pin") }

    /// M11i: attached files in my channels (optionally one channel), newest first.
    func listFiles(channelId: String? = nil, query: String? = nil, cursor: String? = nil, limit: Int = 50) async throws -> FileListOut {
        var items = [URLQueryItem(name: "limit", value: String(limit))]
        if let channelId { items.append(URLQueryItem(name: "channel_id", value: channelId)) }
        if let query, !query.isEmpty { items.append(URLQueryItem(name: "q", value: query)) }
        if let cursor { items.append(URLQueryItem(name: "cursor", value: cursor)) }
        return try await request("GET", Self.pathWithQuery("/api/v1/files", items))
    }

    /// M11h: messages that mention me or everyone in my channels.
    func listMentions(cursor: String? = nil, limit: Int = 50) async throws -> MentionListOut {
        var items = [URLQueryItem(name: "limit", value: String(limit))]
        if let cursor { items.append(URLQueryItem(name: "cursor", value: cursor)) }
        return try await request("GET", Self.pathWithQuery("/api/v1/mentions", items))
    }

    // MARK: activity (M39, MOBILE_UI.md §7.2)

    /// Mentions of me, reactions to my messages and replies in threads I follow, newest first; `cursor` is the previous
    /// page's next_cursor. `filter`: all / mentions / threads / reactions.
    func listActivity(filter: String = "all", cursor: String? = nil, limit: Int = 50) async throws -> ActivityListOut {
        var items = [URLQueryItem(name: "filter", value: filter), URLQueryItem(name: "limit", value: String(limit))]
        if let cursor { items.append(URLQueryItem(name: "cursor", value: cursor)) }
        return try await request("GET", Self.pathWithQuery("/api/v1/activity", items))
    }

    /// The activity badge: the items after my read position (at most 99), and whether a mention is among them.
    func activitySummary() async throws -> ActivitySummary { try await request("GET", "/api/v1/activity/summary") }

    /// Everything up to `readAt` is read (the server only moves it forward, never past its own now).
    func markActivityRead(readAt: String) async throws -> ActivitySummary {
        try await request("PUT", "/api/v1/activity/read", body: .object(["read_at": .string(readAt)]))
    }

    func listBookmarks(cursor: String? = nil, limit: Int = 50) async throws -> BookmarkListOut {
        var items = [URLQueryItem(name: "limit", value: String(limit))]
        if let cursor { items.append(URLQueryItem(name: "cursor", value: cursor)) }
        return try await request("GET", Self.pathWithQuery("/api/v1/bookmarks", items))
    }

    func bookmarkMessage(id: String) async throws -> BookmarkStateOut { try await request("PUT", "/api/v1/messages/\(id)/bookmark") }
    func unbookmarkMessage(id: String) async throws -> BookmarkStateOut { try await request("DELETE", "/api/v1/messages/\(id)/bookmark") }

    // MARK: threads (THREADS.md §3)

    /// GET /threads: the threads I follow, newest reply first; `cursor` is the previous page's next_cursor.
    func threads(filter: String = "all", cursor: String? = nil, limit: Int = 50) async throws -> ThreadListOut {
        var items = [URLQueryItem(name: "filter", value: filter), URLQueryItem(name: "limit", value: String(limit))]
        if let cursor { items.append(URLQueryItem(name: "cursor", value: cursor)) }
        return try await request("GET", Self.pathWithQuery("/api/v1/threads", items))
    }

    func threadState(messageId: String) async throws -> ThreadState { try await request("GET", "/api/v1/messages/\(messageId)/thread") }

    func markThreadRead(messageId: String, lastReadSeq: Int) async throws -> ThreadState {
        try await request("PUT", "/api/v1/messages/\(messageId)/thread/read", body: .object(["last_read_seq": .number(Double(lastReadSeq))]))
    }

    func setThreadFollow(messageId: String, following: Bool) async throws -> ThreadState {
        try await request("PUT", "/api/v1/messages/\(messageId)/thread/follow", body: .object(["following": .bool(following)]))
    }

    /// GET /search/messages (M16b): words and structured filters across my channels (the server applies the membership
    /// filter); the words may be empty when a filter is set.
    func searchMessages(_ search: SearchRequest, limit: Int = 30, offset: Int = 0) async throws -> SearchOut {
        try await request("GET", Self.pathWithQuery("/api/v1/search/messages", search.queryItems(limit: limit, offset: offset)))
    }

    // MARK: workspaces (M16c, WORKSPACES.md §3)

    /// GET /server (no login): whether the address is a ChikuwaChat server, its workspace id and name.
    func serverInfo() async throws -> ServerInfoOut { try await request("GET", "/api/v1/server", auth: false, timeout: 15) }

    /// GET /sync/summary: the badge of a workspace that is not open (WORKSPACES.md §6).
    func syncSummary() async throws -> UnreadSummaryOut { try await request("GET", "/api/v1/sync/summary") }

    /// POST /attachments (multipart): the server sniffs the type; the id is bound when a message is sent.
    func uploadAttachment(data fileData: Data, filename: String, contentType: String) async throws -> AttachmentOut {
        let boundary = "chikuwa-" + UUID().uuidString
        var body = Multipart.head(boundary: boundary, filename: filename, contentType: contentType)
        body.append(fileData)
        body.append(Multipart.tail(boundary: boundary))
        let (data, _) = try await requestData("POST", "/api/v1/attachments", body: body, contentType: "multipart/form-data; boundary=\(boundary)", retry401: true)
        return try JSON.snakeDecoder.decode(AttachmentOut.self, from: data)
    }

    /// The same for a file on disk: the multipart body is streamed into a temporary file and uploaded from there,
    /// so a large file is never held in memory.
    func uploadAttachment(fileAt url: URL, filename: String, contentType: String) async throws -> AttachmentOut {
        let boundary = "chikuwa-" + UUID().uuidString
        let head = Multipart.head(boundary: boundary, filename: filename, contentType: contentType)
        let tail = Multipart.tail(boundary: boundary)
        let body = try await Task.detached(priority: .userInitiated) { try Multipart.write(head: head, file: url, tail: tail) }.value
        defer { try? FileManager.default.removeItem(at: body) }
        let (data, _) = try await requestData("POST", "/api/v1/attachments", body: nil, fromFile: body,
                                              contentType: "multipart/form-data; boundary=\(boundary)", retry401: true)
        return try JSON.snakeDecoder.decode(AttachmentOut.self, from: data)
    }

    /// M14a: my profile picture (any common image; the server stores a 256px PNG).
    func uploadAvatar(data fileData: Data, contentType: String) async throws -> UserMe {
        let boundary = "chikuwa-" + UUID().uuidString
        var body = Multipart.head(boundary: boundary, filename: "avatar", contentType: contentType)
        body.append(fileData)
        body.append(Multipart.tail(boundary: boundary))
        let (data, _) = try await requestData("POST", "/api/v1/users/me/avatar", body: body, contentType: "multipart/form-data; boundary=\(boundary)", retry401: true)
        return try JSON.snakeDecoder.decode(UserMe.self, from: data)
    }

    func deleteAvatar() async throws -> UserMe { try await request("DELETE", "/api/v1/users/me/avatar") }

    /// Authenticated GET returning the raw body (thumbnails, downloads).
    func fetchData(_ path: String) async throws -> Data {
        try await requestData("GET", path, body: nil, contentType: nil, retry401: true).0
    }

    /// `fromFile` uploads the body from a file instead of `body` (large attachments).
    private func requestData(_ method: String, _ path: String, body: Data?, fromFile: URL? = nil, contentType: String?, retry401: Bool) async throws -> (Data, Int) {
        if accessToken == nil, refreshToken != nil { _ = try await refresh() }
        var request = URLRequest(url: URL(string: path, relativeTo: baseUrl)!.absoluteURL)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let contentType { request.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        if let accessToken { request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization") }
        if fromFile == nil { request.httpBody = body }
        let (data, response): (Data, URLResponse)
        do {
            if let fromFile {
                (data, response) = try await session.upload(for: request, fromFile: fromFile)
            } else {
                (data, response) = try await session.data(for: request)
            }
        } catch {
            throw ApiError.network(error)
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status == 401 && retry401 {
            _ = try await refresh()
            return try await requestData(method, path, body: body, fromFile: fromFile, contentType: contentType, retry401: false)
        }
        if !(200...299).contains(status) {
            struct Envelope: Decodable { struct Inner: Decodable { let code: String; let message: String }; let error: Inner }
            let envelope = try? JSON.plainDecoder.decode(Envelope.self, from: data)
            throw ApiError.api(status: status, code: envelope?.error.code ?? "http_\(status)", message: envelope?.error.message ?? "Request failed")
        }
        return (data, status)
    }

    /// M14c: the bodies earlier edits replaced, oldest first (author only; 403 for others).
    func messageRevisions(_ messageId: String) async throws -> [MessageRevisionOut] {
        try await request("GET", "/api/v1/messages/\(messageId)/revisions")
    }

    func messageContext(_ messageId: String) async throws -> [MessageOut] {
        try await request("GET", "/api/v1/messages/\(messageId)/context")
    }

    func replies(messageId: String) async throws -> [MessageOut] { try await request("GET", "/api/v1/messages/\(messageId)/replies") }

    func markRead(channelId: String, lastReadSeq: Int) async throws -> ReadStateOut {
        try await request("PUT", "/api/v1/channels/\(channelId)/read", body: .object(["last_read_seq": .number(Double(lastReadSeq))]))
    }

    /// 「ここから未読にする」: the exact position, may move backwards (SYNC_PROTOCOL.md §10 mode=set).
    func setReadPosition(channelId: String, lastReadSeq: Int) async throws -> ReadStateOut {
        try await request("PUT", "/api/v1/channels/\(channelId)/read",
                          body: .object(["last_read_seq": .number(Double(lastReadSeq)), "mode": .string("set")]))
    }

    func editMessage(id: String, body: String) async throws -> MessageOut {
        try await request("PATCH", "/api/v1/messages/\(id)", body: .object(["body": .string(body)]))
    }

    /// Returns the tombstone (deleted = true) so the caller can apply it locally.
    func deleteMessage(id: String) async throws -> MessageOut { try await request("DELETE", "/api/v1/messages/\(id)") }
    func message(id: String) async throws -> MessageOut { try await request("GET", "/api/v1/messages/\(id)") }

    func addReaction(id: String, emoji: String) async throws -> MessageOut {
        try await request("PUT", "/api/v1/messages/\(id)/reactions/\(Self.encodeEmoji(emoji))", body: .object([:]))
    }

    func removeReaction(id: String, emoji: String) async throws -> MessageOut {
        try await request("DELETE", "/api/v1/messages/\(id)/reactions/\(Self.encodeEmoji(emoji))")
    }

    private static func encodeEmoji(_ emoji: String) -> String {
        emoji.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? emoji
    }

    // MARK: two-factor authentication (M12i)

    func totpStatus() async throws -> TotpStatusOut { try await request("GET", "/api/v1/auth/totp") }

    /// Needs my password; the secret and QR come back once. A wrong password is 422 invalid_password.
    func totpSetup(password: String) async throws -> TotpSetupOut {
        try await request("POST", "/api/v1/auth/totp/setup", body: .object(["password": .string(password)]))
    }

    /// Confirms the setup with an app code; returns the recovery codes once.
    func totpEnable(code: String) async throws -> TotpEnabledOut {
        try await request("POST", "/api/v1/auth/totp/enable", body: .object(["code": .string(code)]))
    }

    func totpDisable(password: String) async throws {
        _ = try await requestRaw("POST", "/api/v1/auth/totp/disable", body: .object(["password": .string(password)]), auth: true, retry401: true)
    }

    // MARK: sidebar sections (M14f): every call returns my whole list

    /// M26: with its icon, and the conversations to put in it at once (they leave the section they were in). Those
    /// fields go only when set: a server before M26 refuses fields it does not know.
    func createSidebarSection(name: String, emoji: String? = nil, channelIds: [String] = []) async throws -> [SidebarSectionOut] {
        var fields: [String: JSONValue] = ["name": .string(name)]
        if let emoji { fields["emoji"] = .string(emoji) }
        if !channelIds.isEmpty { fields["channel_ids"] = .array(channelIds.map { .string($0) }) }
        return try await request("POST", "/api/v1/sidebar/sections", body: .object(fields))
    }

    func updateSidebarSection(_ id: String, name: String? = nil, position: Int? = nil, collapsed: Bool? = nil) async throws -> [SidebarSectionOut] {
        var fields: [String: JSONValue] = [:]
        if let name { fields["name"] = .string(name) }
        if let position { fields["position"] = .number(Double(position)) }
        if let collapsed { fields["collapsed"] = .bool(collapsed) }
        return try await request("PATCH", "/api/v1/sidebar/sections/\(id)", body: .object(fields))
    }

    /// M26: the name and the icon together; a nil `emoji` takes the icon off.
    func editSidebarSection(_ id: String, name: String, emoji: String?) async throws -> [SidebarSectionOut] {
        try await request("PATCH", "/api/v1/sidebar/sections/\(id)", body: .object(["name": .string(name), "emoji": emoji.map { .string($0) } ?? .null]))
    }

    func deleteSidebarSection(_ id: String) async throws -> [SidebarSectionOut] {
        try await request("DELETE", "/api/v1/sidebar/sections/\(id)")
    }

    func placeInSidebarSection(_ sectionId: String, channelId: String) async throws -> [SidebarSectionOut] {
        try await request("PUT", "/api/v1/sidebar/sections/\(sectionId)/channels/\(channelId)", body: .object([:]))
    }

    func removeFromSidebarSection(_ channelId: String) async throws -> [SidebarSectionOut] {
        try await request("DELETE", "/api/v1/sidebar/channels/\(channelId)")
    }

    // MARK: lab roster (M23)

    /// My research topic and reading; nil clears a field (404 roster_entry_not_found while I am not on the roster).
    /// Both are always sent, as the desktop does; the rest of the line is the administrators'.
    func updateMyRosterLine(researchTopic: String?, reading: String?) async throws -> LabProfileOut {
        try await request("PATCH", "/api/v1/lab/roster/me", body: .object([
            "research_topic": researchTopic.map(JSONValue.string) ?? .null,
            "reading": reading.map(JSONValue.string) ?? .null,
        ]))
    }

    // MARK: polls (M14b)

    func vote(messageId: String, option: Int, present: Bool) async throws -> MessageOut {
        try await request(present ? "PUT" : "DELETE", "/api/v1/messages/\(messageId)/poll/votes/\(option)", body: present ? .object([:]) : nil)
    }

    func closePoll(messageId: String) async throws -> MessageOut {
        try await request("POST", "/api/v1/messages/\(messageId)/poll/close", body: .object([:]))
    }

    /// A message that carries a poll; posted directly (not through the offline queue).
    func postPoll(channelId: String, parentId: String?, question: String, options: [String], multiple: Bool,
                  anonymous: Bool = false) async throws -> MessageOut {
        var poll: [String: JSONValue] = ["question": .string(question), "options": .array(options.map(JSONValue.string)), "multiple": .bool(multiple)]
        // Only when asked for: a server before M27 refuses a poll with a field it does not know.
        if anonymous { poll["anonymous"] = .bool(true) }
        let body: JSONValue = .object([
            "client_msg_id": .string(UUID().uuidString.lowercased()),
            "body": .string(""),
            "parent_id": parentId.map(JSONValue.string) ?? .null,
            "poll": .object(poll),
        ])
        return try await request("POST", "/api/v1/channels/\(channelId)/messages", body: body)
    }

    /// M53 (SCHEDULING.md §3): a scheduling poll. The candidates as UTC instants (or dates) and the zone the server writes
    /// their labels in; it makes the options itself and always takes several answers.
    func postSchedulePoll(channelId: String, parentId: String?, question: String, slots: [SchedulePoll.SlotIn], tz: String,
                          anonymous: Bool = false) async throws -> MessageOut {
        var poll: [String: JSONValue] = ["kind": .string("schedule"), "question": .string(question), "slots": .array(slots.map(\.json)),
                                         "tz": .string(tz)]
        if anonymous { poll["anonymous"] = .bool(true) }
        let body: JSONValue = .object([
            "client_msg_id": .string(UUID().uuidString.lowercased()),
            "body": .string(""),
            "parent_id": parentId.map(JSONValue.string) ?? .null,
            "poll": .object(poll),
        ])
        return try await request("POST", "/api/v1/channels/\(channelId)/messages", body: body)
    }

    /// M53: my ○ / △ / × to every candidate at once (those left out become unanswered). `comment`: nil keeps mine,
    /// "" removes it, any other text sets it.
    func answerPoll(messageId: String, answers: [SchedulePoll.Answer?], comment: String? = nil) async throws -> MessageOut {
        var body: [String: JSONValue] = ["answers": .array(SchedulePoll.answersBody(answers).map { item in
            .object(["index": .number(Double(item.index)), "answer": .string(item.answer.rawValue)])
        })]
        if let comment { body["comment"] = comment.isEmpty ? .null : .string(comment) }
        return try await request("PUT", "/api/v1/messages/\(messageId)/poll/answers", body: .object(body))
    }

    /// M53: decide a candidate (its author, the channel's owners, administrators): the channel's event (`createEvent`;
    /// never in a DM) and a reply in the thread. 403 posting_restricted when the event cannot be made by me.
    func decidePoll(messageId: String, index: Int, createEvent: Bool = true) async throws -> MessageOut {
        try await request("POST", "/api/v1/messages/\(messageId)/poll/decide",
                          body: .object(["index": .number(Double(index)), "create_event": .bool(createEvent)]))
    }

    /// M53: take the decision back (answering opens again; the event stays).
    func undecidePoll(messageId: String) async throws -> MessageOut {
        try await request("DELETE", "/api/v1/messages/\(messageId)/poll/decide", body: nil)
    }

    // MARK: invite links (M12h)

    /// No login: what the link offers. 404 = unknown, 410 = expired / used up / revoked.
    func invitePreview(token: String) async throws -> InvitePreviewOut {
        try await request("GET", "/api/v1/invites/\(token)", auth: false)
    }

    /// Creates the account and logs it in (the response is the same as a login).
    func acceptInvite(token: String, username: String, displayName: String, password: String, device: DeviceInfo) async throws -> TokenResponse {
        let body: JSONValue = .object([
            "username": .string(username),
            "display_name": .string(displayName),
            "password": .string(password),
            "device": .object([
                "platform": .string(device.platform),
                "device_name": device.deviceName.map(JSONValue.string) ?? .null,
                "app_version": device.appVersion.map(JSONValue.string) ?? .null,
            ]),
        ])
        let tokens: TokenResponse = try await request("POST", "/api/v1/invites/\(token)/accept", body: body, auth: false)
        apply(tokens)
        return tokens
    }

    // MARK: canvases (CANVAS.md §4.5, M45)

    /// The conversation's canvases without bodies, most recently updated first (`trashed`: its trash instead).
    func listCanvases(channelId: String, trashed: Bool) async throws -> [CanvasMeta] {
        try await request("GET", "/api/v1/channels/\(channelId)/canvases" + (trashed ? "?trashed=true" : ""))
    }

    /// A new canvas (a retry with the same client_save_id returns the first one). The server puts in a template's
    /// {{date}} and the rest in `tz`.
    func createCanvas(channelId: String, clientSaveId: String, title: String?, templateKey: String?, asTab: Bool, tz: String?) async throws -> CanvasOut {
        var fields: [String: JSONValue] = [
            "client_save_id": .string(clientSaveId),
            "as_tab": .bool(asTab),
            "share_to_channel": .bool(false), // posting it to the conversation is its own action (M42)
        ]
        if let title, !title.isEmpty { fields["title"] = .string(title) }
        if let templateKey { fields["template_key"] = .string(templateKey) }
        if let tz { fields["tz"] = .string(tz) }
        return try await request("POST", "/api/v1/channels/\(channelId)/canvases", body: .object(fields))
    }

    /// Metadata, body and head_rev_id; nil when `knownVersion` is still the current one (304, If-None-Match).
    func getCanvas(id: String, knownVersion: Int?) async throws -> CanvasOut? {
        let headers = knownVersion.map { ["If-None-Match": "\"v\($0)\""] } ?? [:]
        do {
            return try await request("GET", "/api/v1/canvases/\(id)", headers: headers)
        } catch ApiError.api(let status, _, _) where status == 304 {
            return nil
        }
    }

    /// §4.4: the whole body written on `baseRevId`. 409 canvas_conflict / canvas_base_expired and 429 come back as
    /// CanvasSaveFailure with what their `details` carry.
    func saveCanvas(id: String, _ save: CanvasSaveIn) async throws -> CanvasSaveOut {
        let body: JSONValue = .object([
            "base_rev_id": .string(save.baseRevId),
            "body": .string(save.body),
            "client_save_id": .string(save.clientSaveId),
            "on_conflict": .string(save.onConflict.rawValue),
        ])
        return try await request("PUT", "/api/v1/canvases/\(id)/content", body: body, onError: Self.canvasSaveFailure)
    }

    /// The error body of a save, read for its details (nil: the usual ApiError).
    static func canvasSaveFailure(status: Int, data: Data) -> Error? {
        struct Envelope: Decodable {
            struct Inner: Decodable { let code: String; let details: JSONValue? }
            let error: Inner
        }
        guard let envelope = try? JSON.plainDecoder.decode(Envelope.self, from: data) else { return nil }
        let details = envelope.error.details
        switch (status, envelope.error.code) {
        case (409, "canvas_conflict"):
            return (try? details?.decode(CanvasConflictDetails.self)).map { CanvasSaveFailure.conflict($0) }
        case (409, "canvas_base_expired"):
            return (try? details?.decode(CanvasConflictDetails.self)).map { CanvasSaveFailure.expired($0.head) }
        case (429, _):
            if case .number(let seconds)? = details?["retry_after_seconds"] { return CanvasSaveFailure.rateLimited(seconds: seconds) }
            return nil
        default:
            return nil
        }
    }

    /// Title, who may edit, the conversation's tab (§4.7: the creator, owners and administrators; anyone in a DM).
    func updateCanvas(id: String, title: String? = nil, editPolicy: String? = nil, isChannelTab: Bool? = nil) async throws -> CanvasOut {
        var fields: [String: JSONValue] = [:]
        if let title { fields["title"] = .string(title) }
        if let editPolicy { fields["edit_policy"] = .string(editPolicy) }
        if let isChannelTab { fields["is_channel_tab"] = .bool(isChannelTab) }
        return try await request("PATCH", "/api/v1/canvases/\(id)", body: .object(fields))
    }

    /// To the trash (restorable for 30 days).
    func deleteCanvas(id: String) async throws {
        _ = try await requestRaw("DELETE", "/api/v1/canvases/\(id)", body: nil, auth: true, retry401: true)
    }

    func restoreCanvas(id: String) async throws -> CanvasOut {
        try await request("POST", "/api/v1/canvases/\(id)/restore", body: .object([:]))
    }

    func canvasTemplates() async throws -> [CanvasTemplateOut] { try await request("GET", "/api/v1/canvas-templates") }

    /// The history without bodies, newest first.
    func canvasRevisions(id: String, cursor: String? = nil) async throws -> CanvasRevisionPage {
        var items = [URLQueryItem(name: "limit", value: "50")]
        if let cursor { items.append(URLQueryItem(name: "cursor", value: cursor)) }
        return try await request("GET", Self.pathWithQuery("/api/v1/canvases/\(id)/revisions", items))
    }

    func canvasRevision(id: String, revisionId: String) async throws -> CanvasRevisionOut {
        try await request("GET", "/api/v1/canvases/\(id)/revisions/\(revisionId)")
    }

    /// M58 (§4.13): post the canvas's link to its conversation; nothing when its shared message still exists. The
    /// comments are that message's thread.
    func shareCanvas(id: String) async throws -> CanvasOut {
        try await request("POST", "/api/v1/canvases/\(id)/share", body: .object([:]))
    }

    /// M58 (§4.9): that version's body as a new version. A retry with the same key makes no second version.
    func restoreCanvasRevision(id: String, revisionId: String, clientSaveId: String) async throws -> CanvasOut {
        try await request("POST", "/api/v1/canvases/\(id)/revisions/\(revisionId)/restore", body: Self.restoreBody(clientSaveId: clientSaveId))
    }

    static func restoreBody(clientSaveId: String) -> JSONValue { .object(["client_save_id": .string(clientSaveId)]) }

    /// M58: a name for the version (「提出版」); nil removes it.
    func labelCanvasRevision(id: String, revisionId: String, label: String?) async throws -> CanvasRevisionMeta {
        try await request("PATCH", "/api/v1/canvases/\(id)/revisions/\(revisionId)", body: Self.labelBody(label))
    }

    static func labelBody(_ label: String?) -> JSONValue { .object(["label": label.map(JSONValue.string) ?? .null]) }

    /// M74 (§4.9): erase a version's body (owners and administrators; in a DM its creator; never the current version:
    /// 409 canvas_revision_is_head). Audited. The answer is the version, now `erased`.
    func eraseCanvasRevision(id: String, revisionId: String) async throws -> CanvasRevisionMeta {
        try await request("DELETE", "/api/v1/canvases/\(id)/revisions/\(revisionId)")
    }

    /// M58 (§4.8): canvases of my conversations whose title or body matches; typed modifiers stay in `q`.
    func searchCanvases(_ search: SearchRequest, limit: Int = 20, offset: Int = 0) async throws -> CanvasSearchOut {
        try await request("GET", Self.pathWithQuery("/api/v1/search/canvases", search.canvasQueryItems(limit: limit, offset: offset)))
    }

    // MARK: calendar (CALENDAR.md §4, M52)

    /// The events overlapping [from, to) (at most 100 days): mine and my channels' (or one channel's). The range goes
    /// out with the device's offset: the server reads all-day dates in it.
    func calendarEvents(from: Date, to: Date, channelId: String?) async throws -> [CalendarEventOut] {
        var items = [URLQueryItem(name: "from", value: CalendarDates.isoLocal(from)), URLQueryItem(name: "to", value: CalendarDates.isoLocal(to))]
        if let channelId { items.append(URLQueryItem(name: "channel_id", value: channelId)) }
        return try await request("GET", Self.pathWithQuery("/api/v1/calendar/events", items))
    }

    /// Today and the next days (in `tz`), not over yet, earliest first (at most 10).
    func calendarUpcoming(channelId: String?, days: Int, tz: String) async throws -> [CalendarEventOut] {
        var items = [URLQueryItem(name: "days", value: String(days)), URLQueryItem(name: "tz", value: tz)]
        if let channelId { items.append(URLQueryItem(name: "channel_id", value: channelId)) }
        return try await request("GET", Self.pathWithQuery("/api/v1/calendar/upcoming", items))
    }

    func calendarEvent(id: String) async throws -> CalendarEventOut { try await request("GET", "/api/v1/calendar/events/\(id)") }

    /// A retry with the same client_event_id returns the first event (200 instead of 201).
    func createCalendarEvent(_ body: CalendarEventCreate) async throws -> CalendarEventOut {
        try await request("POST", "/api/v1/calendar/events", body: body.json)
    }

    func updateCalendarEvent(id: String, _ patch: CalendarEventPatch) async throws -> CalendarEventOut {
        try await request("PATCH", "/api/v1/calendar/events/\(id)", body: patch.json)
    }

    func deleteCalendarEvent(id: String) async throws {
        _ = try await requestRaw("DELETE", "/api/v1/calendar/events/\(id)", body: nil, auth: true, retry401: true)
    }

    /// My alarm on the event (`tz`: the zone its 8:00 and its words are read in); the event comes back with it.
    func setCalendarAlarm(id: String, minutesBefore: Int, tz: String) async throws -> CalendarEventOut {
        try await request("PUT", "/api/v1/calendar/events/\(id)/alarm", body: .object(["minutes_before": .number(Double(minutesBefore)), "tz": .string(tz)]))
    }

    func clearCalendarAlarm(id: String) async throws {
        _ = try await requestRaw("DELETE", "/api/v1/calendar/events/\(id)/alarm", body: nil, auth: true, retry401: true)
    }

    // MARK: recurring events and iCal feeds (CALENDAR.md §10, M69)

    /// An occurrence's key in a path: "2030-01-10T05:00:00Z" with its ":" (and any "+") percent-encoded, as the web's
    /// encodeURIComponent.
    static func occurrencePath(_ seriesId: String, _ occurrenceStart: String) -> String {
        let key = occurrenceStart.addingPercentEncoding(withAllowedCharacters: CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~"))
        return "/api/v1/calendar/events/\(seriesId)/occurrences/\(key ?? occurrenceStart)"
    }

    /// One occurrence (`this`), it and the later ones (`following`) or the whole series (`all`).
    func updateCalendarOccurrence(seriesId: String, occurrenceStart: String, _ body: CalendarOccurrenceUpdate) async throws -> CalendarEventOut {
        try await request("PATCH", Self.occurrencePath(seriesId, occurrenceStart), body: body.json)
    }

    func deleteCalendarOccurrence(seriesId: String, occurrenceStart: String, scope: OccurrenceScope) async throws {
        _ = try await requestRaw("DELETE", Self.occurrencePath(seriesId, occurrenceStart) + "?scope=\(scope.rawValue)", body: nil, auth: true,
                                 retry401: true)
    }

    func calendarFeeds() async throws -> [CalendarFeedOut] { try await request("GET", "/api/v1/calendar/ical-feeds") }

    /// A new private feed URL (`scope`: all | personal); the URL is in this answer only.
    func createCalendarFeed(scope: String) async throws -> CalendarFeedCreated {
        try await request("POST", "/api/v1/calendar/ical-feeds", body: .object(["scope": .string(scope)]))
    }

    func deleteCalendarFeed(id: String) async throws {
        _ = try await requestRaw("DELETE", "/api/v1/calendar/ical-feeds/\(id)", body: nil, auth: true, retry401: true)
    }

    // MARK: tasks (TASKS.md §3, M56)

    /// A channel's board: every open task and the latest 100 completed ones ("recent"), or every one ("all").
    func listTasks(channelId: String, includeDone: String) async throws -> [TaskOut] {
        try await request("GET", Self.pathWithQuery("/api/v1/tasks", [URLQueryItem(name: "channel_id", value: channelId),
                                                                     URLQueryItem(name: "include_done", value: includeDone)]))
    }

    /// 「自分のタスク」: my personal tasks and the shared ones assigned to me.
    func myTasks() async throws -> [TaskOut] { try await request("GET", "/api/v1/tasks/mine") }

    /// L9 「自分が依頼した」: the shared tasks I made with someone else assigned (DMs too).
    func requestedTasks() async throws -> [TaskOut] { try await request("GET", "/api/v1/tasks/requested") }

    /// The tasks due in the dates [from, to) (at most 100 days), every one I may see (the calendar).
    func dueTasks(from: DayKey, to: DayKey) async throws -> [TaskOut] {
        try await request("GET", Self.pathWithQuery("/api/v1/tasks/due", [URLQueryItem(name: "from", value: from), URLQueryItem(name: "to", value: to)]))
    }

    func task(id: String) async throws -> TaskOut { try await request("GET", "/api/v1/tasks/\(id)") }

    /// A retry with the same client_task_id returns the first task (200 instead of 201).
    func createTask(_ body: TaskCreate) async throws -> TaskOut { try await request("POST", "/api/v1/tasks", body: body.json) }

    func updateTask(id: String, _ patch: TaskPatch) async throws -> TaskOut {
        try await request("PATCH", "/api/v1/tasks/\(id)", body: patch.json)
    }

    func moveTask(id: String, _ move: TaskMove) async throws -> TaskOut {
        try await request("POST", "/api/v1/tasks/\(id)/move", body: move.json)
    }

    func deleteTask(id: String) async throws {
        _ = try await requestRaw("DELETE", "/api/v1/tasks/\(id)", body: nil, auth: true, retry401: true)
    }

    // MARK: recurring posts (L6, M59/M60, RECURRING.md §3)

    /// The channel's recurring posts (whoever reads the channel), oldest first.
    func recurringPosts(channelId: String) async throws -> [RecurringPostOut] {
        try await request("GET", "/api/v1/channels/\(channelId)/recurring-posts")
    }

    /// The channel's owners and the administrators among its members (403 recurring_manage_restricted).
    func createRecurringPost(channelId: String, _ body: RecurringPostCreate) async throws -> RecurringPostOut {
        try await request("POST", "/api/v1/channels/\(channelId)/recurring-posts", body: body.json)
    }

    func updateRecurringPost(id: String, _ patch: RecurringPostPatch) async throws -> RecurringPostOut {
        try await request("PATCH", "/api/v1/recurring-posts/\(id)", body: patch.json)
    }

    func deleteRecurringPost(id: String) async throws {
        _ = try await requestRaw("DELETE", "/api/v1/recurring-posts/\(id)", body: nil, auth: true, retry401: true)
    }

    /// 今すぐ投稿: the next scheduled time stays.
    func runRecurringPost(id: String) async throws -> RecurringRunOut {
        try await request("POST", "/api/v1/recurring-posts/\(id)/run", body: .object([:]))
    }

    // MARK: AI (M66, docs/AI.md §5)

    /// 404 on a server before M65: no AI anywhere.
    func aiStatus() async throws -> AiStatusOut { try await request("GET", "/api/v1/ai/status") }

    /// 202 with the run pending; its states follow as ai.run_updated.
    func createSummary(_ request: AiSummaryRequest) async throws -> AiRunOut {
        try await self.request("POST", "/api/v1/ai/summaries", body: request.json)
    }

    func aiRun(id: String) async throws -> AiRunOut { try await request("GET", "/api/v1/ai/runs/\(id)") }

    /// Review v0.1.18 #2: where a summary of the conversation would go (404 on an older server).
    func summaryTarget(channelId: String) async throws -> AiSummaryTargetOut {
        try await request("GET", "/api/v1/ai/summaries/target?channel_id=\(channelId)")
    }

    /// M71 「AI に聞く」 (docs/AI.md §13.5): 202 with the run pending; its states follow as ai.run_updated.
    func createAsk(_ request: AiAskRequest) async throws -> AiRunOut {
        try await self.request("POST", "/api/v1/ai/ask", body: request.json)
    }

    /// M71: where the question would go (404 on a server without 「AI に聞く」).
    func askTarget(question: String, channelId: String?) async throws -> AiAskTargetOut {
        var items = [URLQueryItem(name: "q", value: question)]
        if let channelId { items.append(URLQueryItem(name: "channel_id", value: channelId)) }
        return try await request("GET", Self.pathWithQuery("/api/v1/ai/ask/target", items))
    }

    /// M71: my recent runs of one kind (20, newest first).
    func aiRuns(kind: String) async throws -> [AiRunOut] {
        try await request("GET", Self.pathWithQuery("/api/v1/ai/runs", [URLQueryItem(name: "kind", value: kind)]))
    }

    // MARK: transport

    private func request<T: Decodable>(_ method: String, _ path: String, body: JSONValue? = nil, auth: Bool = true, timeout: TimeInterval? = nil,
                                       headers: [String: String] = [:], onError: ((Int, Data) -> Error?)? = nil) async throws -> T {
        let (data, _) = try await requestRaw(method, path, body: body, auth: auth, retry401: true, timeout: timeout, headers: headers, onError: onError)
        do {
            return try JSON.snakeDecoder.decode(T.self, from: data)
        } catch {
            throw ApiError.api(status: 0, code: "decode_error", message: "Unexpected response: \(error)")
        }
    }

    /// `headers`: extra request headers (If-None-Match). `onError`: a call that reads an error's `details` turns the status
    /// and body into its own error (nil: the usual ApiError).
    private func requestRaw(_ method: String, _ path: String, body: JSONValue?, auth: Bool, retry401: Bool, timeout: TimeInterval? = nil,
                            headers: [String: String] = [:], onError: ((Int, Data) -> Error?)? = nil) async throws -> (Data, Int) {
        if auth, accessToken == nil, refreshToken != nil { _ = try await refresh() }
        var request = URLRequest(url: URL(string: path, relativeTo: baseUrl)!.absoluteURL)
        request.httpMethod = method
        if let timeout { request.timeoutInterval = timeout }
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSON.plainEncoder.encode(body)
        }
        if auth, let accessToken { request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization") }
        for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }

        let data: Data
        let response: HTTPURLResponse
        do {
            let (d, r) = try await session.data(for: request)
            data = d
            response = r as! HTTPURLResponse
        } catch {
            throw ApiError.network(error)
        }
        if (200..<300).contains(response.statusCode) { return (data, response.statusCode) }

        let envelope = try? JSON.plainDecoder.decode(ErrorEnvelope.self, from: data)
        let error = ApiError.api(status: response.statusCode, code: envelope?.error.code ?? "http_\(response.statusCode)",
                                 message: envelope?.error.message ?? "Request failed")
        if auth, response.statusCode == 401, error.code == "token_expired", retry401 {
            _ = try await refresh()
            return try await requestRaw(method, path, body: body, auth: auth, retry401: false, timeout: timeout, headers: headers, onError: onError)
        }
        if auth, response.statusCode == 401, error.code != "token_expired" { signOut() }
        if let onError, let own = onError(response.statusCode, data) { throw own }
        throw error
    }
}

/// multipart/form-data with a single "file" part (POST /attachments, avatars).
enum Multipart {
    static func head(boundary: String, filename: String, contentType: String) -> Data {
        let name = filename.replacingOccurrences(of: "\"", with: "_")
        return Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(name)\"\r\nContent-Type: \(contentType)\r\n\r\n".utf8)
    }

    static func tail(boundary: String) -> Data { Data("\r\n--\(boundary)--\r\n".utf8) }

    /// head + the file + tail in a temporary file, copied 1 MB at a time; the caller removes it.
    static func write(head: Data, file: URL, tail: Data) throws -> URL {
        let out = FileManager.default.temporaryDirectory.appendingPathComponent("upload-\(UUID().uuidString)")
        guard FileManager.default.createFile(atPath: out.path, contents: head) else { throw CocoaError(.fileWriteUnknown) }
        do {
            let writer = try FileHandle(forWritingTo: out)
            defer { try? writer.close() }
            try writer.seekToEnd()
            let reader = try FileHandle(forReadingFrom: file)
            defer { try? reader.close() }
            while let chunk = try reader.read(upToCount: 1 << 20), !chunk.isEmpty { try writer.write(contentsOf: chunk) }
            try writer.write(contentsOf: tail)
            return out
        } catch {
            try? FileManager.default.removeItem(at: out)
            throw error
        }
    }
}
