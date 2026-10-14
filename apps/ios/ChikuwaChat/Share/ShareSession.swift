import Foundation

/// A workspace's tokens as the app and the Share Extension share them (MOBILE_UI.md §21.3). The refresh token rotates
/// on every refresh and a rotated one used again ends the session (SECURITY.md §2.3), so a refresh happens only while
/// holding the token lock (a file lock in the App Group) and always from the token the Keychain holds then: whoever
/// refreshed before (the app or the extension) left the newest one there.
enum SharedTokens {
    struct Access: Codable, Equatable {
        var token: String
        var expiresAt: Date

        func valid(for margin: TimeInterval, now: Date = Date()) -> Bool { expiresAt.timeIntervalSince(now) > margin }
    }

    /// One lock for every account: refreshes are rare (15 minutes apart at most per account).
    static var lockURL: URL? { SharedContainer.url?.appendingPathComponent("Locks/tokens.lock") }

    /// Long enough for a refresh with its retries (ApiClient: 10 s timeout, 1 + 2 + 4 + 8 s pauses inside the
    /// server's 30 s grace); past it the waiter goes ahead without the lock rather than hang.
    static let lockTimeout: TimeInterval = 30

    static func lock() async -> FileLock? {
        guard let url = lockURL else { return nil }
        return await FileLock.acquire(url, timeout: lockTimeout)
    }

    static func refreshToken(account: String) -> String? { Keychain.get(account: account) }

    static func access(account: String) -> Access? {
        guard let text = Keychain.get(account: Keychain.accessAccount(account)), let data = text.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(Access.self, from: data)
    }

    /// A new sign-in of the account (the app: login, invite, Google): a new generation, then both tokens, as one step
    /// under the session lock (AccountSessions). Returns the generation the session has.
    @discardableResult
    static func signIn(account: String, accessToken: String, expiresIn: Int, refreshToken: String,
                       sessions: AccountSessions = .shared) -> Int {
        sessions.signIn(account: account) {
            store(account: account, accessToken: accessToken, expiresIn: expiresIn, refreshToken: refreshToken)
        }
    }

    /// The account signs out or leaves this device (the app): a new generation, then both tokens go, as one step under
    /// the session lock, so a refresh or a widget's answer that was on its way can no longer put anything back.
    static func signOut(account: String, sessions: AccountSessions = .shared) {
        sessions.signOut(account: account) { Keychain.delete(account: account) }
    }

    /// A refresh's tokens (the app's or an extension's), stored only while the session it started from is still the
    /// account's (same generation, still signed in), checked and stored under the session lock. False: dropped.
    @discardableResult
    static func commit(account: String, generation: Int, accessToken: String, expiresIn: Int, refreshToken: String,
                       sessions: AccountSessions = .shared) -> Bool {
        sessions.ifCurrent(account: account, generation: generation) {
            store(account: account, accessToken: accessToken, expiresIn: expiresIn, refreshToken: refreshToken)
        }
    }

    /// After a sign-in or a refresh: both tokens, the access token with its expiry on this device's clock. (Outside the
    /// tests it is reached through signIn / commit, which order it with a sign-out.)
    static func store(account: String, accessToken: String, expiresIn: Int, refreshToken: String, now: Date = Date()) {
        Keychain.set(account: account, value: refreshToken)
        let access = Access(token: accessToken, expiresAt: now.addingTimeInterval(TimeInterval(expiresIn)))
        if let data = try? JSONEncoder().encode(access), let text = String(data: data, encoding: .utf8) {
            Keychain.set(account: Keychain.accessAccount(account), value: text)
        }
    }
}

/// Which session of an account the app, the Share Extension and the widgets are working for (MOBILE_UI.md §21.3,
/// WIDGETS.md): a generation per account, raised by the app on every sign-in and on every sign-out or removal, with
/// whether the account is signed in now. An extension's refresh, a widget's refresh or button and a pending share note
/// the generation when they start and store their result (tokens, a snapshot) only while it is unchanged and the
/// account still signed in; the app's sign-out raises it and deletes the tokens in one step. Both sides take the
/// session lock (a file lock in the App Group held for a few milliseconds — never across a request, unlike the token
/// lock), so an answer that was on its way when the account signed out never brings its tokens or its private snapshot
/// back, and a late answer of an old session never overwrites a new sign-in's tokens.
///
/// Kept in the App Group (`Auth/sessions.json`, nothing secret). An account without a record (an install from before
/// the record: generation 0) counts as signed in while its refresh token is in the Keychain.
struct AccountSessions {
    struct Record: Codable, Equatable {
        var generation: Int
        var signedIn: Bool
    }

    let file: URL
    let lockURL: URL
    /// Whether the account's refresh token is in the Keychain (an account without a record).
    var hasTokens: (String) -> Bool = { SharedTokens.refreshToken(account: $0) != nil }

    private static var folder: URL { SharedContainer.url ?? FileManager.default.temporaryDirectory }

    static let shared = AccountSessions(file: folder.appendingPathComponent("Auth/sessions.json"),
                                        lockURL: folder.appendingPathComponent("Locks/sessions.lock"))

    /// The lock is held for a file write and a Keychain call: a holder that does not let go within this (a process
    /// suspended while holding it) is passed rather than hang the app's sign-out.
    static let lockTimeout: TimeInterval = 2

    func records() -> [String: Record] {
        guard let data = try? Data(contentsOf: file) else { return [:] }
        return (try? JSONDecoder().decode([String: Record].self, from: data)) ?? [:]
    }

    /// The account's generation now (0: none recorded yet).
    func generation(account: String) -> Int { records()[account]?.generation ?? 0 }

    /// Whether the account is signed in on this device now.
    func isSignedIn(account: String) -> Bool { records()[account]?.signedIn ?? hasTokens(account) }

    /// The session noted as `generation` is still the account's, signed in.
    func isCurrent(account: String, generation: Int) -> Bool {
        let record = records()[account]
        return (record?.generation ?? 0) == generation && (record?.signedIn ?? hasTokens(account))
    }

    /// Runs `body` under the session lock only while the session noted as `generation` is current. Returns whether it ran.
    @discardableResult
    func ifCurrent(account: String, generation: Int, _ body: () -> Void) -> Bool {
        locked {
            guard isCurrent(account: account, generation: generation) else { return false }
            body()
            return true
        }
    }

    /// A sign-in: the next generation, signed in, then `body` (the tokens stored). Returns the new generation.
    @discardableResult
    func signIn(account: String, _ body: () -> Void) -> Int { advance(account, signedIn: true, body) }

    /// A sign-out or removal: the next generation, signed out, then `body` (the tokens deleted).
    @discardableResult
    func signOut(account: String, _ body: () -> Void) -> Int { advance(account, signedIn: false, body) }

    private func advance(_ account: String, signedIn: Bool, _ body: () -> Void) -> Int {
        locked {
            var all = records()
            let next = (all[account]?.generation ?? 0) + 1
            all[account] = Record(generation: next, signedIn: signedIn)
            write(all)
            body()
            return next
        }
    }

    private func write(_ all: [String: Record]) {
        guard let data = try? JSONEncoder().encode(all) else { return }
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    private func locked<T>(_ body: () -> T) -> T {
        let lock = FileLock.acquireNow(lockURL, timeout: Self.lockTimeout)
        defer { lock?.release() }
        return body()
    }
}

/// What can go wrong with a share, in the words the extension and the app show (ShareTexts / AppController).
enum ShareFailure: Error, Equatable {
    /// No session to use: open Taylis and sign in.
    case notSignedIn
    /// No answer (offline, timeout) or a temporary server error: kept and sent again later.
    case temporary(String)
    /// The server refused it (its error code): sending it again cannot help.
    case refused(status: Int, code: String)

    var isTemporary: Bool { if case .temporary = self { return true } else { return false } }
}

/// The few calls a share needs, with the shared tokens (the app's own ApiClient is tied to the main actor and its
/// store; this one runs in the extension and in the app's share queue).
final class ShareApi: @unchecked Sendable {
    let baseUrl: URL
    let account: String
    let language: String
    private let session: URLSession
    /// Pauses between refresh attempts whose answer did not arrive (the server honours the old token 30 s).
    var refreshRetryDelays: [TimeInterval] = [1, 2, 4]
    /// Tests: the lock (nil: none).
    var lockProvider: () async -> FileLock? = { await SharedTokens.lock() }
    /// The account's session this client works for (AccountSessions), noted when it is made (for a pending share: when
    /// it was shared). Once the account signed out or in again, this client uses no token and stores none.
    let generation: Int
    let sessions: AccountSessions

    init(baseUrl: URL, account: String, language: String = SharedContainer.language() ?? "ja", session: URLSession = .shared,
         generation: Int? = nil, sessions: AccountSessions = .shared) {
        self.baseUrl = baseUrl
        self.account = account
        self.language = language
        self.session = session
        self.sessions = sessions
        self.generation = generation ?? sessions.generation(account: account)
    }

    convenience init?(workspace: Workspace, session: URLSession = .shared) {
        guard let url = URL(string: workspace.serverUrl) else { return nil }
        self.init(baseUrl: url, account: workspace.account, session: session)
    }

    // MARK: tokens

    /// The account signed out or in again since this client's session began: nothing more is sent with it.
    private func checkSession() throws {
        guard sessions.isCurrent(account: account, generation: generation) else { throw ShareFailure.notSignedIn }
    }

    /// An access token good for at least `margin` seconds: the stored one, else a refresh.
    func accessToken(margin: TimeInterval = 60) async throws -> String {
        try checkSession()
        if let stored = SharedTokens.access(account: account), stored.valid(for: margin) { return stored.token }
        return try await refreshedToken(replacing: nil)
    }

    /// A new access token after `failed` was refused (401 token_expired) or none was usable. Under the lock: when the
    /// Keychain already holds another valid one (the app or another request refreshed meanwhile) it is used as it is;
    /// else the refresh starts from the refresh token stored now. The answer's tokens are stored only while this client's
    /// session is still the account's (AccountSessions, checked under the session lock): an answer that comes back
    /// after the app signed out (or in again) is dropped, so it neither restores the deleted tokens nor overwrites a new
    /// session's.
    func refreshedToken(replacing failed: String?) async throws -> String {
        let lock = await lockProvider()
        defer { lock?.release() }
        try checkSession()
        if let stored = SharedTokens.access(account: account), stored.token != failed, stored.valid(for: 30) { return stored.token }
        guard let refresh = SharedTokens.refreshToken(account: account) else { throw ShareFailure.notSignedIn }
        var attempt = 0
        while true {
            do {
                let (data, status) = try await send(path: "/api/v1/auth/refresh", method: "POST",
                                                    json: ["refresh_token": refresh], token: nil, timeout: 10)
                guard (200..<300).contains(status) else {
                    if status == 401 || status == 403 { throw ShareFailure.notSignedIn }
                    throw Self.failure(status: status, data: data)
                }
                struct Tokens: Decodable { let accessToken: String; let refreshToken: String; let expiresIn: Int }
                guard let tokens = try? JSON.snakeDecoder.decode(Tokens.self, from: data) else { throw ShareFailure.temporary("decode_error") }
                guard SharedTokens.commit(account: account, generation: generation, accessToken: tokens.accessToken,
                                          expiresIn: tokens.expiresIn, refreshToken: tokens.refreshToken, sessions: sessions)
                else { throw ShareFailure.notSignedIn }
                return tokens.accessToken
            } catch let failure as ShareFailure where failure.isTemporary && attempt < refreshRetryDelays.count {
                try? await Task.sleep(nanoseconds: UInt64(refreshRetryDelays[attempt] * 1_000_000_000))
                attempt += 1
            }
        }
    }

    // MARK: calls

    struct Channel: Decodable, Equatable {
        let id: String
        let type: String
        let name: String?
        let archived: Bool
        let lastMessageAt: String?
        let dmUserIds: [String]?
        let postingPolicy: String?
        let membership: Membership?
        struct Membership: Decodable, Equatable { let role: String }
    }

    struct User: Decodable, Equatable {
        let id: String
        let username: String
        let displayName: String
        let role: String?
    }

    struct Me: Decodable { let id: String; let role: String; let displayName: String; let username: String }

    /// My conversations (channels, DMs, group DMs): GET /channels answers only those I am a member of.
    func channels() async throws -> [Channel] { try await getJSON("/api/v1/channels") }
    func users() async throws -> [User] { try await getJSON("/api/v1/users") }
    func me() async throws -> Me { try await getJSON("/api/v1/users/me") }

    /// POST /channels/{id}/messages: the same `client_msg_id` again answers the message already made (200), so a
    /// retry never posts twice (SYNC_PROTOCOL.md). Returns the message id and whether this call created it.
    func postMessage(channelId: String, clientMsgId: String, body: String, parentId: String?, attachmentIds: [String]) async throws -> (String, Bool) {
        var fields: [String: Any] = ["client_msg_id": clientMsgId, "body": body, "attachment_ids": attachmentIds]
        fields["parent_id"] = parentId ?? NSNull()
        let (data, status) = try await authorized { token in
            try await self.send(path: "/api/v1/channels/\(channelId)/messages", method: "POST", json: fields, token: token, timeout: 30)
        }
        struct Posted: Decodable { let id: String }
        guard let posted = try? JSON.snakeDecoder.decode(Posted.self, from: data) else { throw ShareFailure.temporary("decode_error") }
        return (posted.id, status == 201)
    }

    /// The upload request for a multipart body on disk (POST /attachments), for a background upload task.
    func uploadRequest(boundary: String, token: String) -> URLRequest {
        var request = URLRequest(url: URL(string: "/api/v1/attachments", relativeTo: baseUrl)!.absoluteURL)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(language, forHTTPHeaderField: "Accept-Language")
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return request
    }

    // MARK: transport

    func getJSON<T: Decodable>(_ path: String) async throws -> T {
        let (data, _) = try await authorized { token in try await self.send(path: path, method: "GET", json: nil, token: token, timeout: 20) }
        do { return try JSON.snakeDecoder.decode(T.self, from: data) } catch { throw ShareFailure.temporary("decode_error") }
    }

    /// One call with the access token; a 401 token_expired refreshes once and tries again. Any other non-2xx is
    /// turned into a ShareFailure. (Internal: the widget's calls, AttendanceWidgetData.swift, use it too.)
    func authorized(_ call: @escaping (String) async throws -> (Data, Int)) async throws -> (Data, Int) {
        var token = try await accessToken()
        var retried = false
        while true {
            let (data, status) = try await call(token)
            if (200..<300).contains(status) { return (data, status) }
            if status == 401 {
                guard !retried, Self.errorCode(data) == "token_expired" else { throw ShareFailure.notSignedIn }
                retried = true
                token = try await refreshedToken(replacing: token)
                continue
            }
            throw Self.failure(status: status, data: data)
        }
    }

    func send(path: String, method: String, json: [String: Any]?, token: String?, timeout: TimeInterval) async throws -> (Data, Int) {
        let request = try Self.request(baseUrl: baseUrl, path: path, method: method, json: json, token: token, language: language,
                                       timeout: timeout)
        do {
            let (data, response) = try await session.data(for: request)
            return (data, (response as? HTTPURLResponse)?.statusCode ?? 0)
        } catch {
            throw ShareFailure.temporary("network_error")
        }
    }

    /// One JSON request to the server (the tests look at what a call sends without sending it).
    static func request(baseUrl: URL, path: String, method: String, json: [String: Any]?, token: String?, language: String,
                        timeout: TimeInterval) throws -> URLRequest {
        var request = URLRequest(url: URL(string: path, relativeTo: baseUrl)!.absoluteURL)
        request.httpMethod = method
        request.timeoutInterval = timeout
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(language, forHTTPHeaderField: "Accept-Language")
        if let json {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: json)
        }
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        return request
    }

    static func errorCode(_ data: Data) -> String? {
        struct Envelope: Decodable { struct Inner: Decodable { let code: String }; let error: Inner }
        return (try? JSON.plainDecoder.decode(Envelope.self, from: data))?.error.code
    }

    /// 429 and 5xx are temporary (sent again later); other 4xx are refusals.
    static func failure(status: Int, data: Data) -> ShareFailure {
        let code = errorCode(data) ?? "http_\(status)"
        if status == 0 || status == 429 || status >= 500 { return .temporary(code) }
        return .refused(status: status, code: code)
    }
}
