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
    /// M12i: the last login was refused for lack of an authenticator code; the form asks for one.
    var totpRequired = false
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
        AvatarCache.shared.fetcher = { [weak api] path in
            guard let api else { throw ApiError.api(status: 0, code: "signed_out", message: "") }
            return try await api.fetchData(path)
        }
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

    func login(server: String, username: String, password: String, totpCode: String? = nil) async {
        let trimmed = server.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "/+$", with: "", options: .regularExpression)
        guard let url = URL(string: trimmed), url.scheme != nil else {
            error = "サーバ URL が正しくありません"
            return
        }
        let api = makeApi(server: url, username: username)
        do {
            let tokens = try await api.login(username: username, password: password,
                                             device: .init(platform: "ios", deviceName: UIDevice.current.name, appVersion: Self.appVersion),
                                             totpCode: totpCode.map(Totp.normalize))
            defaults.set(trimmed, forKey: Self.serverKey)
            defaults.set(username, forKey: Self.usernameKey)
            error = nil
            totpRequired = false
            await enterSession(api: api, username: username, me: tokens.user)
        } catch {
            if case ApiError.api(_, let code, _) = error, code == "totp_required" {
                totpRequired = true
                self.error = nil
                return
            }
            if case ApiError.api(_, let code, _) = error, code == "invalid_totp" {
                totpRequired = true
                self.error = Totp.errorText(error)
                return
            }
            totpRequired = false
            self.error = describe(error)
        }
    }

    // MARK: two-factor authentication (M12i): the settings sheet drives these

    func totpStatus() async -> TotpStatusOut? {
        guard let api else { return nil }
        do { return try await api.totpStatus() } catch { self.error = describe(error); return nil }
    }

    func beginTotpSetup(password: String) async throws -> TotpSetupOut {
        guard let api else { throw ApiError.api(status: 0, code: "signed_out", message: "ログインしていません") }
        return try await api.totpSetup(password: password)
    }

    func enableTotp(code: String) async throws -> TotpEnabledOut {
        guard let api else { throw ApiError.api(status: 0, code: "signed_out", message: "ログインしていません") }
        return try await api.totpEnable(code: Totp.normalize(code))
    }

    func disableTotp(password: String) async throws {
        guard let api else { throw ApiError.api(status: 0, code: "signed_out", message: "ログインしていません") }
        try await api.totpDisable(password: password)
    }

    /// M12h: what an invite link offers, before any account exists (throws on a dead link).
    func previewInvite(server: URL, token: String) async throws -> InvitePreviewOut {
        try await ApiClient(baseUrl: server).invitePreview(token: token)
    }

    /// M12h: create the account the link allows and enter the session; returns the failure text, if any.
    func acceptInvite(server: URL, token: String, username: String, displayName: String, password: String) async -> String? {
        let api = makeApi(server: server, username: username)
        do {
            let tokens = try await api.acceptInvite(token: token, username: username, displayName: displayName, password: password,
                                                    device: .init(platform: "ios", deviceName: UIDevice.current.name, appVersion: Self.appVersion))
            defaults.set(server.absoluteString, forKey: Self.serverKey)
            defaults.set(username, forKey: Self.usernameKey)
            error = nil
            await enterSession(api: api, username: username, me: tokens.user)
            return nil
        } catch {
            return Invite.errorText(error) ?? describe(error)
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
        engine.onReminder = { [weak self] reminder in
            self?.notice = "⏰ " + ((reminder.note?.isEmpty == false ? reminder.note! + " — " : "") + reminder.preview)
        }
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
    /// M13e: confined to the channels they were added to; browsing and creation are hidden.
    var isGuest: Bool { me?.role == "guest" }

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

    // MARK: custom emoji (M12f)

    private var emojiLoads: Set<String> = []

    /// Fetches an emoji image once (scaled for inline text) into the store's cache.
    func loadEmojiImage(_ emoji: CustomEmojiOut) {
        guard let api, store.emojiImages[emoji.id] == nil, !emojiLoads.contains(emoji.id) else { return }
        emojiLoads.insert(emoji.id)
        Task {
            defer { emojiLoads.remove(emoji.id) }
            guard let data = try? await api.fetchData("/api/v1/emoji/\(emoji.id)/image"), let image = UIImage(data: data) else { return }
            store.emojiImages[emoji.id] = CustomEmoji.inlineImage(image)
        }
    }

    // MARK: reminders (M12e)

    func setReminder(messageId: String, at: Date, note: String? = nil) async -> Bool {
        guard let api else { return false }
        do {
            let row = try await api.createReminder(messageId: messageId, remindAt: at, note: note)
            store.applyReminder(row)
            notice = "\(Schedule.label(at)) にリマインドします"
            return true
        } catch { self.error = describe(error); return false }
    }

    /// Cancels a pending reminder or marks a fired one done.
    func closeReminder(_ row: ReminderOut) async {
        guard let api else { return }
        do {
            try await api.closeReminder(id: row.id)
            store.reminders.removeValue(forKey: row.id)
        } catch { self.error = describe(error) }
    }

    // MARK: scheduled messages (M12d)

    /// 「後で送信」: the server posts the draft at `sendAt`; the row shows up under 下書き.
    func scheduleMessage(channelId: String, parentId: String?, body: String, attachmentIds: [String], sendAt: Date) async -> Bool {
        guard let api else { return false }
        do {
            let row = try await api.scheduleMessage(channelId: channelId, clientMsgId: UUID().uuidString.lowercased(), body: body,
                                                    parentId: parentId, attachmentIds: attachmentIds, sendAt: sendAt)
            store.applyScheduled(row)
            notice = "\(Schedule.label(sendAt)) に送信します"
            return true
        } catch { self.error = describe(error); return false }
    }

    /// Cancel a scheduled message; its text returns to the conversation's draft so nothing is lost.
    func cancelScheduled(_ row: ScheduledOut) async {
        guard let api else { return }
        do {
            try await api.cancelScheduled(id: row.id)
            store.scheduled.removeValue(forKey: row.id)
            if !row.body.isEmpty { store.setDraft(row.channelId, parentId: row.parentId) { $0.text = row.body } }
        } catch { self.error = describe(error) }
    }

    func sendScheduledNow(_ row: ScheduledOut) async {
        guard let api else { return }
        do {
            _ = try await api.sendScheduledNow(id: row.id)
            store.scheduled.removeValue(forKey: row.id)
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

    func unarchiveChannel(_ channelId: String) async -> Bool {
        guard let api else { return false }
        do {
            store.upsertChannel(try await api.unarchiveChannel(id: channelId))
            return true
        } catch { self.error = describe(error); return false }
    }

    /// M13c: post a quote of `message` and its permalink into another conversation.
    func shareMessage(_ message: MessageState, to channelId: String, comment: String) async -> Bool {
        guard let engine, let link = permalink(message.id) else { return false }
        await engine.send(channelId, body: Share.body(original: message.body, permalink: link, comment: comment))
        notice = "共有しました"
        return true
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
    func updateProfile(title: String?? = nil, statusText: String?? = nil, statusEmoji: String?? = nil, statusExpiresAt: String?? = nil,
                       dndUntil: String?? = nil, quietHours: QuietHours?? = nil, notifyKeywords: [String]? = nil) async -> Bool {
        guard let api else { return false }
        var fields: [String: JSONValue] = [:]
        if let title { fields["title"] = title.map(JSONValue.string) ?? .null }
        if let statusText { fields["status_text"] = statusText.map(JSONValue.string) ?? .null }
        if let statusEmoji { fields["status_emoji"] = statusEmoji.map(JSONValue.string) ?? .null }
        if let statusExpiresAt { fields["status_expires_at"] = statusExpiresAt.map(JSONValue.string) ?? .null }
        // M12g
        if let notifyKeywords { fields["notify_keywords"] = .array(notifyKeywords.map(JSONValue.string)) }
        // M12c
        if let dndUntil { fields["dnd_until"] = dndUntil.map(JSONValue.string) ?? .null }
        if let quietHours {
            fields["quiet_hours"] = quietHours.map { hours in
                JSONValue.object(["start": .string(hours.start), "end": .string(hours.end),
                                  "days": .array(hours.days.map { .number(Double($0)) }), "tz": .string(hours.tz)])
            } ?? .null
        }
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

    /// M14a: choose (or drop) my profile picture; the store learns the new version at once.
    func uploadAvatar(data: Data, contentType: String) async -> Bool {
        guard let api else { return false }
        do {
            let updated = try await api.uploadAvatar(data: data, contentType: contentType)
            me = updated
            store.setMe(updated)
            return true
        } catch { self.error = describe(error); return false }
    }

    func deleteAvatar() async -> Bool {
        guard let api else { return false }
        do {
            let updated = try await api.deleteAvatar()
            me = updated
            store.setMe(updated)
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

    // MARK: edit history (M14c)

    func messageRevisions(_ messageId: String) async -> [MessageRevisionOut]? {
        guard let api else { return nil }
        do { return try await api.messageRevisions(messageId) } catch { self.error = describe(error); return nil }
    }

    // MARK: polls (M14b)

    func vote(_ message: MessageState, option: Int, present: Bool) async -> Bool {
        guard let api else { return false }
        do {
            store.upsertMessage(try await api.vote(messageId: message.id, option: option, present: present))
            return true
        } catch { self.error = describe(error); return false }
    }

    func closePoll(_ message: MessageState) async -> Bool {
        guard let api else { return false }
        do {
            store.upsertMessage(try await api.closePoll(messageId: message.id))
            return true
        } catch { self.error = describe(error); return false }
    }

    func createPoll(channelId: String, parentId: String?, question: String, options: [String], multiple: Bool) async -> Bool {
        guard let api else { return false }
        do {
            store.upsertMessage(try await api.postPoll(channelId: channelId, parentId: parentId, question: question, options: options, multiple: multiple))
            return true
        } catch { self.error = describe(error); return false }
    }

    // MARK: slash commands (M13b)

    /// Runs a command typed in the composer; false when it could not (the reason is in `error`).
    func runCommand(_ command: SlashCommands.Parsed, channelId: String, parentId: String?) async -> Bool {
        guard let api, let state = store.channels[channelId] else { return false }
        let isDm = state.channel.type == "dm" || state.channel.type == "group_dm"
        guard let spec = SlashCommands.all.first(where: { $0.name == command.name }) else {
            error = "/\(command.name) というコマンドはありません (/help で一覧)"
            return false
        }
        if spec.channelOnly && isDm { error = "/\(command.name) はチャンネルでだけ使えます"; return false }
        func user(_ handle: String) -> UserPublic? {
            let name = (handle.hasPrefix("@") ? String(handle.dropFirst()) : handle).lowercased()
            return store.users.values.first { $0.username.lowercased() == name }
        }
        let iso = ISO8601DateFormatter()
        let level = state.channel.notification?.level ?? (isDm ? "all" : "mentions")
        switch command.name {
        case "help":
            notice = SlashCommands.all.map(\.usage).joined(separator: " · ")
            return true
        case "status":
            if command.args.isEmpty || command.args == "clear" {
                let ok = await updateProfile(statusText: .some(nil), statusEmoji: .some(nil), statusExpiresAt: .some(nil))
                if ok { notice = "ステータスを消しました" }
                return ok
            }
            let parts = SlashCommands.splitStatus(command.args)
            let ok = await updateProfile(statusText: .some(parts.text.isEmpty ? nil : parts.text), statusEmoji: .some(parts.emoji), statusExpiresAt: .some(nil))
            if ok { notice = "ステータスを更新しました" }
            return ok
        case "dnd":
            if command.args.isEmpty || command.args == "off" {
                let ok = await updateProfile(dndUntil: .some(nil))
                if ok { notice = "通知の一時停止を解除しました" }
                return ok
            }
            guard let until = SlashCommands.duration(command.args) else { error = "/dnd 30m | 1h | 2h | 4h | tomorrow | off"; return false }
            let ok = await updateProfile(dndUntil: .some(iso.string(from: until)))
            if ok { notice = "\(Schedule.label(until)) まで通知を止めます" }
            return ok
        case "topic":
            _ = await updateTopic(channelId, topic: command.args)
            return true
        case "leave":
            _ = await leaveChannel(channelId)
            return true
        case "invite":
            let handles = command.args.split(separator: " ").map(String.init).filter { !$0.isEmpty }
            if handles.isEmpty { error = "/invite @名前"; return false }
            for handle in handles {
                guard let target = user(handle) else { error = "\(handle) というユーザーはいません"; return false }
                do { _ = try await api.addMember(channelId: channelId, userId: target.id) } catch { self.error = describe(error); return false }
            }
            notice = "\(handles.count) 人を追加しました"
            return true
        case "join":
            let name = (command.args.hasPrefix("#") ? String(command.args.dropFirst()) : command.args).lowercased()
            guard let target = store.channels.values.first(where: { $0.channel.type == "public" && ($0.channel.name ?? "").lowercased() == name }) else {
                error = "#\(name) という公開チャンネルはありません"
                return false
            }
            if !target.isMember {
                do { store.upsertChannel(try await api.joinChannel(id: target.id), isMember: true) } catch { self.error = describe(error); return false }
            }
            PushCenter.shared.pendingChannelId = target.id
            return true
        case "dm":
            guard let target = user(command.args.split(separator: " ").first.map(String.init) ?? "") else { error = "/dm @名前"; return false }
            guard let id = await openDmWith(target.id) else { return false }
            PushCenter.shared.pendingChannelId = id
            return true
        case "mute":
            let until = command.args.isEmpty ? Date().addingTimeInterval(8 * 3600) : SlashCommands.duration(command.args)
            guard let until else { error = "/mute 1h | 8h | tomorrow"; return false }
            _ = await setNotification(channelId, level: level, mutedUntil: iso.string(from: until))
            notice = "\(Schedule.label(until)) まで通知を止めます"
            return true
        case "unmute":
            _ = await setNotification(channelId, level: level, mutedUntil: nil)
            notice = "通知を再開しました"
            return true
        case "me":
            if command.args.isEmpty { return false }
            await engine?.send(channelId, body: "_\(command.args)_", parentId: parentId)
            return true
        case "shrug":
            await engine?.send(channelId, body: (command.args.isEmpty ? "" : command.args + " ") + SlashCommands.shrug, parentId: parentId)
            return true
        case "poll":
            let parts = command.args.split(separator: "|").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
            guard parts.count >= 3 else { error = "/poll 質問 | 選択肢 | 選択肢 …"; return false }
            return await createPoll(channelId: channelId, parentId: parentId, question: parts[0], options: Array(parts.dropFirst()), multiple: false)
        default:
            return false
        }
    }

    func logout() async {
        engine?.stop()
        engine = nil
        await api?.logout()
    }

    private func handleSignedOut(account: String) {
        AvatarCache.shared.reset()
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
