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
    /// A short confirmation (「リンクをコピーしました」); nil when nothing to say.
    var notice: String?
    var me: UserMe?
    struct MessageFocus {
        var channelId: String
        var messageId: String
        var parentId: String?
        var context: [MessageState]
    }
    var messageFocus: MessageFocus?
    func revealMessage(_ message: MessageOut) async -> Bool {
        await revealMessage(id: message.id, channelId: message.channelId, parentId: message.parentId)
    }

    /// Focus a message known only by its ids (M11i files list): the context comes from the server.
    func revealMessage(id: String, channelId: String, parentId: String?) async -> Bool {
        guard let api else { return false }
        do {
            let context = try await api.messageContext(id)
            if let parentId {
                for reply in try await api.replies(messageId: parentId) { store.upsertMessage(reply) }
            }
            messageFocus = MessageFocus(channelId: channelId, messageId: id, parentId: parentId, context: context.map(MessageState.init))
            return true
        } catch { self.error = describe(error); return false }
    }
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
        api.onSignedOut = { [weak self, weak api] in Task { @MainActor in
            guard let self, self.api === api else { return }
            self.handleSignedOut(account: account)
        } }
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
        self.api = api
        if await startEngine(restoring: true) { return }
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

    @discardableResult
    private func startEngine(restoring: Bool = false) async -> Bool {
        guard let api else { return false }
        engine?.stop()
        messageFocus = nil
        let account = account(api.baseUrl.absoluteString, username)
        let persistence = try? SQLitePersistence.open(profile: account)
        let store = Store(persistence: persistence)
        store.load()
        self.store = store
        if restoring {
            guard let cached = store.me, !cached.mustChangePassword else { return false }
            me = cached
        } else if let me { store.setMe(me) }
        let engine = SyncEngine(
            api: api,
            connect: { url, _ in try await WebSocketTransport.connect(url: url) },
            wsUrl: api.wsUrl,
            store: store,
            getAccessToken: { api.accessToken },
            options: .init()
        )
        engine.onSignedOut = { [weak self, weak engine] in
            guard let self, self.engine === engine else { return }
            self.handleSignedOut(account: account)
        }
        engine.isActive = { UIApplication.shared.applicationState == .active }
        engine.onRead = { channelId in PushCenter.shared.clearNotifications(channelId: channelId) }
        engine.onBadge = { count in PushCenter.shared.setBadge(count) }
        self.engine = engine
        engine.prepareConnection = { [weak self, weak engine] in
            let tokens = try await api.refresh()
            guard let self, self.api === api, self.engine === engine else { return }
            self.me = tokens.user
            self.store.setMe(tokens.user)
            if tokens.user.mustChangePassword {
                engine?.stop()
                self.screen = .changePassword
                throw ApiError.api(status: 403, code: "password_change_required", message: "Password change required")
            }
            PushCenter.shared.attach(controller: self)
        }
        screen = .main
        Task { await engine.start() }
        return true
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

    // MARK: link previews (M11g): one fetch per URL per session

    /// url → preview (nil = failed / none). Views read this; `loadLinkPreview` fills it.
    var linkPreviews: [String: LinkPreviewOut?] = [:]
    private var previewLoads: Set<String> = []

    func loadLinkPreview(_ url: String) async {
        guard let api, linkPreviews[url] == nil, !previewLoads.contains(url) else { return }
        previewLoads.insert(url)
        defer { previewLoads.remove(url) }
        do {
            let preview = try await api.linkPreview(url: url)
            linkPreviews[url] = .some(preview.status == "ok" ? preview : nil)
        } catch {
            linkPreviews[url] = .some(nil) // refused or rate limited: no card this session
        }
    }

    /// M11c: any member pins / unpins; the updated message (with pinnedAt) replaces the row.
    func togglePin(_ message: MessageState) async {
        guard let api else { return }
        do {
            _ = store.upsertMessage(message.pinnedAt != nil ? try await api.unpinMessage(id: message.id) : try await api.pinMessage(id: message.id))
        } catch { self.error = describe(error) }
    }

    // MARK: permalinks (M12b)

    func permalink(_ messageId: String) -> String? {
        api.map { Permalink.url(base: $0.baseUrl, messageId: messageId) }
    }

    func copyPermalink(_ messageId: String) {
        guard let url = permalink(messageId) else { return }
        UIPasteboard.general.string = url
        notice = "リンクをコピーしました"
    }

    /// A permalink tapped in a body: fetch the message (membership is checked there), reveal it and open its conversation.
    func openPermalink(_ messageId: String) async {
        guard let api else { return }
        do {
            let message = try await api.message(id: messageId)
            if await revealMessage(message) {
                NotificationCenter.default.post(name: .chikuwaOpenChannel, object: nil,
                                                userInfo: ["id": message.channelId, "parentId": message.parentId as Any])
            }
        } catch { self.error = describe(error) }
    }

    /// M12a: a starred channel; the flag moves at once, favorite.updated confirms on every device.
    func toggleFavorite(_ channelId: String) async {
        guard let api else { return }
        let on = !store.isFavorite(channelId)
        store.setFavorite(channelId, on: on)
        do {
            if on { _ = try await api.favoriteChannel(id: channelId) } else { _ = try await api.unfavoriteChannel(id: channelId) }
        } catch {
            store.setFavorite(channelId, on: !on)
            self.error = describe(error)
        }
    }

    /// M12a 「すべて既読にする」.
    func markAllRead() async {
        guard let engine else { return }
        do { try await engine.markAllRead() } catch { self.error = describe(error) }
    }

    /// M11c: saved for me only; the flag moves at once, bookmark.updated confirms on every device.
    func toggleBookmark(_ messageId: String) async {
        guard let api else { return }
        let on = !store.isBookmarked(messageId)
        store.setBookmarked(messageId, on: on)
        do {
            if on { _ = try await api.bookmarkMessage(id: messageId) } else { _ = try await api.unbookmarkMessage(id: messageId) }
        } catch {
            store.setBookmarked(messageId, on: !on)
            self.error = describe(error)
        }
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

    // MARK: channel management (M11h)

    func updatePurpose(_ channelId: String, purpose: String) async -> Bool {
        guard let api else { return false }
        do {
            store.upsertChannel(try await api.updateChannel(id: channelId, purpose: purpose.trimmingCharacters(in: .whitespacesAndNewlines)))
            return true
        } catch { self.error = describe(error); return false }
    }

    func renameChannel(_ channelId: String, name: String) async -> Bool {
        guard let api else { return false }
        do {
            store.upsertChannel(try await api.updateChannel(id: channelId, name: name.trimmingCharacters(in: .whitespacesAndNewlines)))
            return true
        } catch { self.error = describe(error); return false }
    }

    func archiveChannel(_ channelId: String) async -> Bool {
        guard let api else { return false }
        do {
            store.upsertChannel(try await api.archiveChannel(id: channelId))
            return true
        } catch { self.error = describe(error); return false }
    }

    /// Leaving drops the channel locally at once; the server's member_removed confirms it.
    func leaveChannel(_ channelId: String) async -> Bool {
        guard let api else { return false }
        do {
            try await api.leaveChannel(id: channelId)
            store.removeChannel(channelId)
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

    /// M11d: title / custom status. nil values clear; pass only the fields to change.
    func updateProfile(title: String?? = nil, statusText: String?? = nil, statusEmoji: String?? = nil, statusExpiresAt: String?? = nil) async -> Bool {
        guard let api else { return false }
        var fields: [String: JSONValue] = [:]
        if let title { fields["title"] = title.map(JSONValue.string) ?? .null }
        if let statusText { fields["status_text"] = statusText.map(JSONValue.string) ?? .null }
        if let statusEmoji { fields["status_emoji"] = statusEmoji.map(JSONValue.string) ?? .null }
        if let statusExpiresAt { fields["status_expires_at"] = statusExpiresAt.map(JSONValue.string) ?? .null }
        do {
            let updated = try await api.updateProfile(fields)
            me = updated
            store.setMe(updated)
            store.upsertUser(updated.asPublic)
            return true
        } catch { self.error = describe(error); return false }
    }

    /// Open (or create) the DM with one user; returns its channel id.
    func openDmWith(_ userId: String) async -> String? {
        guard let api else { return nil }
        if let existing = store.channels.values.first(where: { $0.channel.type == "dm" && ($0.channel.dmUserIds ?? []).contains(userId) && ($0.channel.dmUserIds ?? []).count <= 2 }) {
            return existing.id
        }
        do {
            let channel = try await api.createDm(userIds: [userId])
            store.upsertChannel(channel, isMember: true)
            return channel.id
        } catch { self.error = describe(error); return nil }
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
