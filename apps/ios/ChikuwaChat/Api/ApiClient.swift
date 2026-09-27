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

    var code: String {
        if case .api(_, let code, _) = self { return code }
        return "network_error"
    }
}

/// Thin HTTP client: bearer auth, single-flight refresh on token_expired, structured errors.
@MainActor
final class ApiClient: SyncApi {
    let baseUrl: URL
    private var sessionVersion = 0
    var accessToken: String?
    var refreshToken: String?
    var onTokens: ((TokenResponse) -> Void)?
    var onSignedOut: (() -> Void)?
    private let session: URLSession
    private var refreshTask: Task<TokenResponse, Error>?

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

    func refresh() async throws -> TokenResponse {
        if let task = refreshTask { return try await task.value }
        guard let token = refreshToken else { throw ApiError.api(status: 401, code: "missing_token", message: "No refresh token") }
        let version = sessionVersion
        let task = Task<TokenResponse, Error> {
            do {
                let tokens: TokenResponse = try await request("POST", "/api/v1/auth/refresh", body: .object(["refresh_token": .string(token)]), auth: false)
                guard version == sessionVersion else { throw ApiError.api(status: 401, code: "session_changed", message: "Session changed") }
                apply(tokens)
                return tokens
            } catch {
                if version == sessionVersion, let apiError = error as? ApiError, apiError.isAuth { signOut() }
                throw error
            }
        }
        refreshTask = task
        defer { refreshTask = nil }
        return try await task.value
    }

    func logout() async {
        _ = try? await requestRaw("POST", "/api/v1/auth/logout", body: nil, auth: true, retry401: false)
        signOut()
    }

    func signOut() {
        sessionVersion += 1
        accessToken = nil
        refreshToken = nil
        onSignedOut?()
    }

    private func apply(_ tokens: TokenResponse) {
        accessToken = tokens.accessToken
        refreshToken = tokens.refreshToken
        onTokens?(tokens)
    }

    // MARK: endpoints

    func me() async throws -> UserMe { try await request("GET", "/api/v1/users/me") }

    func changePassword(current: String, new: String) async throws {
        _ = try await requestRaw("PUT", "/api/v1/users/me/password",
                                 body: .object(["current_password": .string(current), "new_password": .string(new)]), auth: true, retry401: true)
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

    func publicChannels() async throws -> [ChannelOut] {
        try await channels(includePublic: true).filter { $0.membership == nil }
    }

    func createChannel(name: String, type: String) async throws -> ChannelOut {
        try await request("POST", "/api/v1/channels", body: .object(["name": .string(name), "type": .string(type)]))
    }

    func joinChannel(id: String) async throws -> ChannelOut { try await request("POST", "/api/v1/channels/\(id)/join", body: .object([:])) }

    func leaveChannel(id: String) async throws {
        _ = try await requestRaw("POST", "/api/v1/channels/\(id)/leave", body: .object([:]), auth: true, retry401: true)
    }

    func archiveChannel(id: String) async throws -> ChannelOut { try await request("POST", "/api/v1/channels/\(id)/archive", body: .object([:])) }
    /// M13d: owner or administrator; the channel becomes writable again.
    func unarchiveChannel(id: String) async throws -> ChannelOut { try await request("POST", "/api/v1/channels/\(id)/unarchive", body: .object([:])) }

    func updateChannel(id: String, topic: String? = nil, name: String? = nil, purpose: String? = nil) async throws -> ChannelOut {
        var body: [String: JSONValue] = [:]
        if let topic { body["topic"] = .string(topic) }
        if let name { body["name"] = .string(name) }
        if let purpose { body["purpose"] = .string(purpose) }
        return try await request("PATCH", "/api/v1/channels/\(id)", body: .object(body))
    }

    func setNotificationPreference(channelId: String, level: String, mutedUntil: String?) async throws -> NotificationPreferenceOut {
        try await request("PUT", "/api/v1/channels/\(channelId)/notification-preference",
                          body: .object(["level": .string(level), "muted_until": mutedUntil.map { JSONValue.string($0) } ?? .null]))
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

    func postMessage(channelId: String, clientMsgId: String, body: String, parentId: String? = nil, attachmentIds: [String] = []) async throws -> (MessageOut, Bool) {
        let (data, status) = try await requestRaw("POST", "/api/v1/channels/\(channelId)/messages",
                                                  body: .object(["client_msg_id": .string(clientMsgId), "body": .string(body),
                                                                 "parent_id": parentId.map(JSONValue.string) ?? .null,
                                                                 "attachment_ids": .array(attachmentIds.map(JSONValue.string))]), auth: true, retry401: true)
        return (try JSON.snakeDecoder.decode(MessageOut.self, from: data), status == 201)
    }

    // MARK: link previews (M11g)

    func linkPreview(url: String) async throws -> LinkPreviewOut {
        var components = URLComponents()
        components.path = "/api/v1/link-previews"
        components.queryItems = [URLQueryItem(name: "url", value: url)]
        return try await request("GET", components.string ?? "/api/v1/link-previews")
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
    func cancelScheduled(id: String) async throws {
        _ = try await requestRaw("DELETE", "/api/v1/scheduled/\(id)", body: nil, auth: true, retry401: true)
    }
    func sendScheduledNow(id: String) async throws -> MessageOut { try await request("POST", "/api/v1/scheduled/\(id)/send-now", body: .object([:])) }

    // MARK: favorites and read-all (M12a)

    func favoriteChannel(id: String) async throws -> FavoriteStateOut { try await request("PUT", "/api/v1/channels/\(id)/favorite") }
    func unfavoriteChannel(id: String) async throws -> FavoriteStateOut { try await request("DELETE", "/api/v1/channels/\(id)/favorite") }
    func readAll() async throws -> [ChannelReadStateOut] { try await request("POST", "/api/v1/channels/read-all", body: .object([:])) }

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
        var components = URLComponents()
        components.path = "/api/v1/files"
        components.queryItems = items
        return try await request("GET", components.string ?? "/api/v1/files")
    }

    /// M11h: messages that mention me or everyone in my channels.
    func listMentions(cursor: String? = nil, limit: Int = 50) async throws -> MentionListOut {
        var items = [URLQueryItem(name: "limit", value: String(limit))]
        if let cursor { items.append(URLQueryItem(name: "cursor", value: cursor)) }
        var components = URLComponents()
        components.path = "/api/v1/mentions"
        components.queryItems = items
        return try await request("GET", components.string ?? "/api/v1/mentions")
    }

    func listBookmarks(cursor: String? = nil, limit: Int = 50) async throws -> BookmarkListOut {
        var items = [URLQueryItem(name: "limit", value: String(limit))]
        if let cursor { items.append(URLQueryItem(name: "cursor", value: cursor)) }
        var components = URLComponents()
        components.path = "/api/v1/bookmarks"
        components.queryItems = items
        return try await request("GET", components.string ?? "/api/v1/bookmarks")
    }

    func bookmarkMessage(id: String) async throws -> BookmarkStateOut { try await request("PUT", "/api/v1/messages/\(id)/bookmark") }
    func unbookmarkMessage(id: String) async throws -> BookmarkStateOut { try await request("DELETE", "/api/v1/messages/\(id)/bookmark") }

    // MARK: threads (THREADS.md §3)

    /// GET /threads: the threads I follow, newest reply first; `cursor` is the previous page's next_cursor.
    func threads(filter: String = "all", cursor: String? = nil, limit: Int = 50) async throws -> ThreadListOut {
        var items = [URLQueryItem(name: "filter", value: filter), URLQueryItem(name: "limit", value: String(limit))]
        if let cursor { items.append(URLQueryItem(name: "cursor", value: cursor)) }
        var components = URLComponents()
        components.path = "/api/v1/threads"
        components.queryItems = items
        return try await request("GET", components.string ?? "/api/v1/threads")
    }

    func threadState(messageId: String) async throws -> ThreadState { try await request("GET", "/api/v1/messages/\(messageId)/thread") }

    func markThreadRead(messageId: String, lastReadSeq: Int) async throws -> ThreadState {
        try await request("PUT", "/api/v1/messages/\(messageId)/thread/read", body: .object(["last_read_seq": .number(Double(lastReadSeq))]))
    }

    func setThreadFollow(messageId: String, following: Bool) async throws -> ThreadState {
        try await request("PUT", "/api/v1/messages/\(messageId)/thread/follow", body: .object(["following": .bool(following)]))
    }

    /// GET /search/messages: full-text search across my channels (the server applies the membership filter).
    func searchMessages(_ query: String, channelId: String? = nil, limit: Int = 20, offset: Int = 0) async throws -> SearchOut {
        var items = [URLQueryItem(name: "q", value: query), URLQueryItem(name: "limit", value: String(limit)), URLQueryItem(name: "offset", value: String(offset))]
        if let channelId { items.append(URLQueryItem(name: "channel_id", value: channelId)) }
        // before: / after: / on: dates are interpreted in the caller's zone (DATA_MODEL.md 検索).
        items.append(URLQueryItem(name: "tz_offset_minutes", value: String(TimeZone.current.secondsFromGMT() / 60)))
        var components = URLComponents()
        components.path = "/api/v1/search/messages"
        components.queryItems = items
        return try await request("GET", components.string ?? "/api/v1/search/messages")
    }

    /// POST /attachments (multipart): the server sniffs the type; the id is bound when a message is sent.
    func uploadAttachment(data fileData: Data, filename: String, contentType: String) async throws -> AttachmentOut {
        let boundary = "chikuwa-" + UUID().uuidString
        var body = Data()
        body.append("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(filename.replacingOccurrences(of: "\"", with: "_"))\"\r\nContent-Type: \(contentType)\r\n\r\n".data(using: .utf8)!)
        body.append(fileData)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)
        let (data, _) = try await requestData("POST", "/api/v1/attachments", body: body, contentType: "multipart/form-data; boundary=\(boundary)", retry401: true)
        return try JSON.snakeDecoder.decode(AttachmentOut.self, from: data)
    }

    /// M14a: my profile picture (any common image; the server stores a 256px PNG).
    func uploadAvatar(data fileData: Data, contentType: String) async throws -> UserMe {
        let boundary = "chikuwa-" + UUID().uuidString
        var body = Data()
        body.append("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"avatar\"\r\nContent-Type: \(contentType)\r\n\r\n".data(using: .utf8)!)
        body.append(fileData)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)
        let (data, _) = try await requestData("POST", "/api/v1/users/me/avatar", body: body, contentType: "multipart/form-data; boundary=\(boundary)", retry401: true)
        return try JSON.snakeDecoder.decode(UserMe.self, from: data)
    }

    func deleteAvatar() async throws -> UserMe { try await request("DELETE", "/api/v1/users/me/avatar") }

    /// Authenticated GET returning the raw body (thumbnails, downloads).
    func fetchData(_ path: String) async throws -> Data {
        try await requestData("GET", path, body: nil, contentType: nil, retry401: true).0
    }

    private func requestData(_ method: String, _ path: String, body: Data?, contentType: String?, retry401: Bool) async throws -> (Data, Int) {
        if accessToken == nil, refreshToken != nil { _ = try await refresh() }
        var request = URLRequest(url: URL(string: path, relativeTo: baseUrl)!.absoluteURL)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let contentType { request.setValue(contentType, forHTTPHeaderField: "Content-Type") }
        if let accessToken { request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization") }
        request.httpBody = body
        let (data, response): (Data, URLResponse)
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw ApiError.network(error)
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status == 401 && retry401 {
            _ = try await refresh()
            return try await requestData(method, path, body: body, contentType: contentType, retry401: false)
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

    func createSidebarSection(name: String) async throws -> [SidebarSectionOut] {
        try await request("POST", "/api/v1/sidebar/sections", body: .object(["name": .string(name)]))
    }

    func updateSidebarSection(_ id: String, name: String? = nil, position: Int? = nil) async throws -> [SidebarSectionOut] {
        var fields: [String: JSONValue] = [:]
        if let name { fields["name"] = .string(name) }
        if let position { fields["position"] = .number(Double(position)) }
        return try await request("PATCH", "/api/v1/sidebar/sections/\(id)", body: .object(fields))
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

    // MARK: polls (M14b)

    func vote(messageId: String, option: Int, present: Bool) async throws -> MessageOut {
        try await request(present ? "PUT" : "DELETE", "/api/v1/messages/\(messageId)/poll/votes/\(option)", body: present ? .object([:]) : nil)
    }

    func closePoll(messageId: String) async throws -> MessageOut {
        try await request("POST", "/api/v1/messages/\(messageId)/poll/close", body: .object([:]))
    }

    /// A message that carries a poll; posted directly (not through the offline queue).
    func postPoll(channelId: String, parentId: String?, question: String, options: [String], multiple: Bool) async throws -> MessageOut {
        let body: JSONValue = .object([
            "client_msg_id": .string(UUID().uuidString.lowercased()),
            "body": .string(""),
            "parent_id": parentId.map(JSONValue.string) ?? .null,
            "poll": .object(["question": .string(question), "options": .array(options.map(JSONValue.string)), "multiple": .bool(multiple)]),
        ])
        return try await request("POST", "/api/v1/channels/\(channelId)/messages", body: body)
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

    // MARK: transport

    private func request<T: Decodable>(_ method: String, _ path: String, body: JSONValue? = nil, auth: Bool = true) async throws -> T {
        let (data, _) = try await requestRaw(method, path, body: body, auth: auth, retry401: true)
        do {
            return try JSON.snakeDecoder.decode(T.self, from: data)
        } catch {
            throw ApiError.api(status: 0, code: "decode_error", message: "Unexpected response: \(error)")
        }
    }

    private func requestRaw(_ method: String, _ path: String, body: JSONValue?, auth: Bool, retry401: Bool) async throws -> (Data, Int) {
        if auth, accessToken == nil, refreshToken != nil { _ = try await refresh() }
        var request = URLRequest(url: URL(string: path, relativeTo: baseUrl)!.absoluteURL)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSON.plainEncoder.encode(body)
        }
        if auth, let accessToken { request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization") }

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
            return try await requestRaw(method, path, body: body, auth: auth, retry401: false)
        }
        if auth, response.statusCode == 401, error.code != "token_expired" { signOut() }
        throw error
    }
}
