import Foundation
import Observation
import UIKit

/// Application controller: login, session restore and the sync engine lifecycle.
@MainActor
@Observable
final class AppController {
    enum Screen { case boot, login, changePassword, main }

    var screen: Screen = .boot
    var error: String?
    var me: UserMe?
    private(set) var api: ApiClient?
    private(set) var store = Store()
    private(set) var engine: SyncEngine?

    private let defaults = UserDefaults.standard
    private static let serverKey = "chikuwa.server"
    private static let usernameKey = "chikuwa.username"
    private static let appVersion = "0.1.0"

    var serverUrl: String { defaults.string(forKey: Self.serverKey) ?? "http://127.0.0.1:8000" }
    var username: String { defaults.string(forKey: Self.usernameKey) ?? "" }

    private func account(_ server: String, _ username: String) -> String { "\(server)|\(username)" }

    private func makeApi(server: URL, username: String) -> ApiClient {
        let account = account(server.absoluteString, username)
        let api = ApiClient(baseUrl: server)
        api.onTokens = { tokens in Keychain.set(account: account, value: tokens.refreshToken) }
        api.onSignedOut = { [weak self] in Task { @MainActor in self?.handleSignedOut(account: account) } }
        return api
    }

    /// Startup: restore the previous session from the Keychain (SYNC_PROTOCOL.md §7.2).
    func boot() async {
        let username = username
        guard !username.isEmpty, let server = URL(string: serverUrl),
              let refreshToken = Keychain.get(account: account(server.absoluteString, username)) else {
            screen = .login
            return
        }
        let api = makeApi(server: server, username: username)
        api.refreshToken = refreshToken
        do {
            let tokens = try await api.refresh()
            await enterSession(api: api, username: username, me: tokens.user)
        } catch {
            screen = .login
            if case ApiError.api(let status, _, _) = error, status == 401 { self.error = nil } else { self.error = describe(error) }
        }
    }

    func login(server: String, username: String, password: String) async {
        let trimmed = server.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "/+$", with: "", options: .regularExpression)
        guard let url = URL(string: trimmed), url.scheme != nil else {
            error = "サーバ URL が正しくありません"
            return
        }
        let api = makeApi(server: url, username: username)
        do {
            let tokens = try await api.login(username: username, password: password,
                                             device: .init(platform: "ios", deviceName: UIDevice.current.name, appVersion: Self.appVersion))
            defaults.set(trimmed, forKey: Self.serverKey)
            defaults.set(username, forKey: Self.usernameKey)
            error = nil
            await enterSession(api: api, username: username, me: tokens.user)
        } catch {
            self.error = describe(error)
        }
    }

    func changePassword(current: String, new: String) async {
        guard let api else { return }
        do {
            try await api.changePassword(current: current, new: new)
            me = try await api.me()
            error = nil
            await startEngine()
        } catch {
            self.error = describe(error)
        }
    }

    private func enterSession(api: ApiClient, username: String, me: UserMe) async {
        self.api = api
        self.me = me
        if me.mustChangePassword {
            screen = .changePassword
            return
        }
        await startEngine()
    }

    private func startEngine() async {
        guard let api else { return }
        engine?.stop()
        let account = account(api.baseUrl.absoluteString, username)
        let persistence = try? SQLitePersistence.open(profile: account)
        let store = Store(persistence: persistence)
        store.load()
        self.store = store
        let engine = SyncEngine(
            api: api,
            connect: { url, _ in try await WebSocketTransport.connect(url: url) },
            wsUrl: api.wsUrl,
            store: store,
            getAccessToken: { api.accessToken },
            options: .init()
        )
        engine.onSignedOut = { [weak self] in self?.handleSignedOut(account: account) }
        engine.isActive = { UIApplication.shared.applicationState == .active }
        engine.onRead = { channelId in PushCenter.shared.clearNotifications(channelId: channelId) }
        engine.onBadge = { count in PushCenter.shared.setBadge(count) }
        self.engine = engine
        screen = .main
        PushCenter.shared.attach(controller: self)
        await engine.start()
    }

    /// Foreground: iOS suspends sockets in the background, so reconnect and catch up (SYNC_PROTOCOL.md §7.5).
    func didBecomeActive() {
        engine?.reconnectNow()
        PushCenter.shared.uploadTokenIfNeeded()
    }

    var isAdmin: Bool { me?.role == "admin" }

    // MARK: attachments (M9a)

    func uploadAttachment(data: Data, filename: String, contentType: String) async -> AttachmentOut? {
        guard let api else { return nil }
        do { return try await api.uploadAttachment(data: data, filename: filename, contentType: contentType) } catch { self.error = describe(error); return nil }
    }

    /// Fetch the bytes with the bearer token into a temporary file (shared through the system sheet).
    func downloadAttachment(_ attachment: AttachmentOut) async -> URL? {
        guard let api else { return nil }
        do {
            let data = try await api.fetchData("/api/v1/attachments/\(attachment.id)/content")
            let dir = FileManager.default.temporaryDirectory.appendingPathComponent("attachments", isDirectory: true)
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let url = dir.appendingPathComponent(attachment.filename.replacingOccurrences(of: "/", with: "_"))
            try data.write(to: url, options: .atomic)
            return url
        } catch {
            self.error = describe(error)
            return nil
        }
    }

    // MARK: message actions (M8a): apply the server's answer at once; the WS event is deduplicated

    func editMessage(_ messageId: String, body: String) async {
        guard let api else { return }
        do { _ = store.upsertMessage(try await api.editMessage(id: messageId, body: body)) } catch { self.error = describe(error) }
    }

    func deleteMessage(_ messageId: String) async {
        guard let api else { return }
        do { _ = store.upsertMessage(try await api.deleteMessage(id: messageId)) } catch { self.error = describe(error) }
    }

    func toggleReaction(_ message: MessageState, emoji: String) async {
        guard let api, let me = store.me else { return }
        do {
            let updated = message.reactedBy(me.id, emoji)
                ? try await api.removeReaction(id: message.id, emoji: emoji)
                : try await api.addReaction(id: message.id, emoji: emoji)
            _ = store.upsertMessage(updated)
        } catch { self.error = describe(error) }
    }

    // MARK: channel info & settings (UI brush-up)

    func updateTopic(_ channelId: String, topic: String) async -> Bool {
        guard let api else { return false }
        do {
            store.upsertChannel(try await api.updateChannel(id: channelId, topic: topic.trimmingCharacters(in: .whitespacesAndNewlines)))
            return true
        } catch { self.error = describe(error); return false }
    }

    func setNotification(_ channelId: String, level: String, mutedUntil: String? = nil) async -> Bool {
        guard let api else { return false }
        do {
            let pref = try await api.setNotificationPreference(channelId: channelId, level: level, mutedUntil: mutedUntil)
            store.setNotification(channelId, level: pref.level, mutedUntil: pref.mutedUntil)
            return true
        } catch { self.error = describe(error); return false }
    }

    func updateDisplayName(_ displayName: String) async -> Bool {
        guard let api else { return false }
        do {
            let updated = try await api.updateMe(displayName: displayName.trimmingCharacters(in: .whitespacesAndNewlines))
            me = updated
            store.setMe(updated)
            return true
        } catch { self.error = describe(error); return false }
    }

    /// Password change from the settings sheet; returns the error text or nil.
    func changePasswordInSession(current: String, new: String) async -> String? {
        guard let api else { return "ログインしていません" }
        do { try await api.changePassword(current: current, new: new); return nil } catch { return describe(error) }
    }

    func logout() async {
        engine?.stop()
        engine = nil
        await api?.logout()
    }

    private func handleSignedOut(account: String) {
        engine?.stop()
        engine = nil
        api = nil
        me = nil
        Keychain.delete(account: account)
        screen = .login
    }

    func describe(_ error: Error) -> String {
        if case ApiError.api(_, let code, let message) = error {
            switch code {
            case "invalid_credentials": return "ユーザー名またはパスワードが違います"
            case "rate_limited": return "しばらく待ってからやり直してください"
            case "password_too_short": return "パスワードが短すぎます"
            case "invalid_password": return "現在のパスワードが違います"
            default: return message.isEmpty ? code : message
            }
        }
        if case ApiError.network = error { return "サーバに接続できません" }
        return error.localizedDescription
    }
}
