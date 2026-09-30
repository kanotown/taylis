import Foundation
import Observation
import UIKit

/// Application controller: the workspaces (M16c), login, session restore and the sync engine of the workspace on screen.
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
    /// M45: a canvas link (`<server>/c/<id>`) tapped in a message: its screen shows over everything (MainView).
    var canvasLink: CanvasLinkTarget?
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

    private let defaults: UserDefaults
    private static let appVersion = "0.1.0"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    // MARK: workspaces (M16c, WORKSPACES.md)

    /// The registered workspaces in the order added. Only the active one is connected and on screen (§6); the others
    /// hear of new messages by push and show their last known badge.
    private(set) var workspaces: [Workspace] = []
    private(set) var activeServerUrl: String?
    var activeWorkspace: Workspace? { workspaces.first { $0.serverUrl == activeServerUrl } }
    /// The name over the channel list (GET /server); ChikuwaChat before any workspace.
    var workspaceName: String { activeWorkspace?.name ?? "ChikuwaChat" }
    /// Another workspace has something unread: the switcher shows a dot.
    var otherWorkspacesUnread: Bool { workspaces.contains { $0.serverUrl != activeServerUrl && $0.hasNews } }
    /// Where the login form starts once no workspace is left: the last one signed out of in this run.
    private var lastSignIn: (server: String, username: String)?
    /// One API client per workspace for the life of the app: every refresh of a workspace goes through it, one at a
    /// time (a refresh token used twice revokes the session: SECURITY.md §2.3, WORKSPACES.md §8).
    @ObservationIgnored private var clients: [String: ApiClient] = [:]
    /// The APNs token each workspace got in this run; a new session registers it again.
    @ObservationIgnored private var pushTokens: [String: String] = [:]
    @ObservationIgnored private var pushUploads: Set<String> = []
    /// The open workspace's own badge (unread DMs + mentions, PUSH_NOTIFICATIONS.md §4.2).
    @ObservationIgnored private var activeBadge = 0
    /// Startup is over: a tapped notification can be routed.
    @ObservationIgnored private(set) var booted = false

    /// The login form starts from the workspace to sign back in to, else the last one used on this device.
    var loginServer: String {
        activeWorkspace?.serverUrl ?? lastSignIn?.server ?? defaults.string(forKey: Workspaces.legacyServerKey) ?? "http://127.0.0.1:8000"
    }

    var loginUsername: String {
        activeWorkspace?.username ?? lastSignIn?.username ?? defaults.string(forKey: Workspaces.legacyUsernameKey) ?? ""
    }

    /// M16b: where the open account's recent searches are kept on this device.
    var recentSearchKey: String { RecentSearches.key(account: activeWorkspace?.account ?? "") }
    /// M37: where the open account's 「最近の会話」 are kept on this device.
    var recentConversationKey: String { RecentConversations.key(account: activeWorkspace?.account ?? "") }
    /// M37 (6): a conversation chosen from 「新しいメッセージ」, whose input takes the keyboard once it shows; its composer
    /// clears this.
    var composerFocus: String?

    /// The API client of a workspace, made from its saved refresh token the first time.
    private func client(for workspace: Workspace) -> ApiClient {
        if let api = clients[workspace.serverUrl] { return api }
        let api = makeClient(serverUrl: workspace.serverUrl, username: workspace.username)
        api.refreshToken = Keychain.get(account: workspace.account)
        clients[workspace.serverUrl] = api
        return api
    }

    /// Rotated refresh tokens go to the Keychain; a session the server ended signs out that workspace only.
    private func makeClient(serverUrl: String, username: String) -> ApiClient {
        let account = "\(serverUrl)|\(username)"
        let api = ApiClient(baseUrl: URL(string: serverUrl) ?? URL(string: "https://invalid.invalid")!)
        api.onTokens = { tokens in Keychain.set(account: account, value: tokens.refreshToken) }
        api.onSignedOut = { [weak self, weak api] in Task { @MainActor in
            guard let self, let api, self.clients[serverUrl] === api else { return }
            self.sessionEnded(serverUrl)
        } }
        return api
    }

    private func persistWorkspaces() {
        Workspaces.save(Workspaces.Saved(list: workspaces, active: activeServerUrl), to: defaults)
    }

    /// Changes one entry and saves the list when something changed.
    private func patch(_ serverUrl: String, _ change: (inout Workspace) -> Void) {
        guard let index = workspaces.firstIndex(where: { $0.serverUrl == serverUrl }) else { return }
        var entry = workspaces[index]
        change(&entry)
        guard entry != workspaces[index] else { return }
        workspaces[index] = entry
        persistWorkspaces()
    }

    // MARK: startup and switching (SYNC_PROTOCOL.md §7.2, WORKSPACES.md §5.2)

    /// Startup: the workspace list (built once from the single server of an older install), then the active
    /// workspace's session from its saved refresh token.
    func boot() async {
        PushCenter.shared.bind(self)
        let saved = Workspaces.load(defaults) { Keychain.get(account: $0) != nil }
        workspaces = saved.list
        activeServerUrl = saved.active
        // Launched by tapping a notification: open its workspace right away (§7).
        let tap = PushCenter.shared.takePendingTap()
        if let tap, let target = Workspaces.route(tap, list: workspaces, active: activeServerUrl, hasChannel: workspaceHasChannel) {
            activeServerUrl = target.serverUrl
        }
        if let active = activeWorkspace {
            await open(active)
        } else {
            screen = .login
        }
        booted = true
        if let tap { PushCenter.shared.pendingChannelId = tap.channelId }
        Task { await refreshServerInfo() }
        Task { await refreshSummaries() }
        if let late = PushCenter.shared.takePendingTap() { await openNotification(late) }
    }

    /// Puts another workspace on screen: this one's engine stops (its store keeps the open state and drafts), the
    /// other's session starts from its saved refresh token.
    func switchTo(_ serverUrl: String) async {
        guard let target = workspaces.first(where: { $0.serverUrl == serverUrl }) else { return }
        if serverUrl == activeServerUrl && screen == .main { return }
        await open(target)
    }

    /// The session of `workspace` on screen, restored from the Keychain: the local store first, then the engine
    /// (which refreshes the access token when needed). A refused refresh signs out that workspace only.
    private func open(_ workspace: Workspace) async {
        closeSession()
        activeServerUrl = workspace.serverUrl
        activeBadge = workspace.badge ?? 0 // until its bootstrap says (the app icon follows then)
        error = nil
        persistWorkspaces()
        guard workspace.isSignedIn else {
            screen = .login
            return
        }
        let api = client(for: workspace)
        guard api.refreshToken != nil || api.accessToken != nil else {
            forget(workspace, remove: false) // nothing saved to sign in with
            return
        }
        self.api = api
        if await startEngine(restoring: true) {
            opened(workspace.serverUrl)
            return
        }
        screen = .boot
        do {
            let tokens = try await api.refresh()
            guard self.api === api else { return }
            await enterSession(api: api, me: tokens.user)
            opened(workspace.serverUrl)
        } catch {
            guard self.api === api else { return }
            screen = .login
            if case ApiError.api(let status, _, _) = error, status == 401 { self.error = nil } else { self.error = describe(error) }
        }
    }

    /// A workspace is open: its account id, and its name from GET /server (read again whenever it opens, §4).
    private func opened(_ serverUrl: String) {
        if let id = me?.id ?? store.me?.id { patch(serverUrl) { $0.userId = id } }
        Task { await refreshServerInfo(serverUrl) }
    }

    /// The workspace on screen goes: its engine stops and its store closes. Nothing of it may show in the next one.
    private func closeSession() {
        engine?.stop()
        engine = nil
        api = nil
        me = nil
        messageFocus = nil
        canvasLink = nil
        linkPreviews = [:]
        previewLoads = []
        emojiLoads = []
        AvatarCache.shared.reset()
        PushCenter.shared.pendingChannelId = nil
        let previous = store
        store = Store()
        previous.close()
    }

    // MARK: signing in (WORKSPACES.md §5.1)

    enum SignInOutcome: Equatable {
        case signedIn
        /// The server is a workspace already signed in here: it was opened instead.
        case switched
        /// The account asks for an authenticator code (M12i); the text says what was wrong with the last one.
        case needsCode(String?)
        case failed(String)
    }

    /// The login form: the address is normalized and asked for GET /server. Adding a workspace needs a ChikuwaChat
    /// answer, and a workspace registered already (same workspace_id or address) is opened instead: one account per
    /// server. The new session joins the list (or renews its entry) and comes on screen.
    func signIn(server input: String, username: String, password: String, totpCode: String? = nil, adding: Bool = false) async -> SignInOutcome {
        guard let normalized = Workspaces.normalize(input) else { return .failed("サーバ URL が正しくありません") }
        // A registered address keeps its spelling: it names the Keychain item and the local store.
        var serverUrl = workspaces.first { Workspaces.sameServer($0.serverUrl, normalized) }?.serverUrl ?? normalized
        guard let url = URL(string: serverUrl) else { return .failed("サーバ URL が正しくありません") }
        var info: ServerInfoOut?
        do {
            let answer = try await ApiClient(baseUrl: url).serverInfo()
            info = answer.product == "chikuwachat" ? answer : nil
        } catch let error as ApiError where error.isRetryable {
            return .failed(describe(error)) // no answer, or a server error: not a verdict on the address
        } catch {
            info = nil
        }
        if adding {
            guard let info else { return .failed("ChikuwaChat のサーバーではありません") }
            if let known = Workspaces.duplicate(of: serverUrl, workspaceId: info.workspaceId, in: workspaces) {
                if known.isSignedIn {
                    await switchTo(known.serverUrl)
                    notice = "\(known.name) は登録済みです"
                    return .switched
                }
                serverUrl = known.serverUrl // registered but signed out: sign in to it again
            }
        }
        let api = makeClient(serverUrl: serverUrl, username: username)
        do {
            let tokens = try await api.login(username: username, password: password,
                                             device: .init(platform: "ios", deviceName: UIDevice.current.name, appVersion: Self.appVersion),
                                             totpCode: totpCode.map(Totp.normalize))
            await adopt(api, serverUrl: serverUrl, username: username, me: tokens.user, info: info)
            return .signedIn
        } catch {
            if case ApiError.api(_, let code, _) = error, code == "totp_required" { return .needsCode(nil) }
            if case ApiError.api(_, let code, _) = error, code == "invalid_totp" { return .needsCode(Totp.errorText(error)) }
            return .failed(describe(error))
        }
    }

    /// A new sign-in (login form or invite link): the workspace joins the list, or its entry is renewed, and opens.
    private func adopt(_ api: ApiClient, serverUrl: String, username: String, me: UserMe, info: ServerInfoOut?) async {
        let known = workspaces.first { $0.serverUrl == serverUrl }
        closeSession()
        if let known, known.username != username {
            // Another account of this server leaves this device (one account per server).
            Keychain.delete(account: known.account)
            SQLitePersistence.destroy(profile: known.account)
            RecentSearches.clear(key: RecentSearches.key(account: known.account))
        }
        if let previous = clients[serverUrl], previous !== api { previous.signOut() }
        clients[serverUrl] = api
        pushTokens[serverUrl] = nil
        let entry = Workspace(serverUrl: serverUrl, workspaceId: info?.workspaceId ?? known?.workspaceId, name: info?.name ?? known?.name,
                              username: username, userId: me.id)
        if let index = workspaces.firstIndex(where: { $0.serverUrl == serverUrl }) { workspaces[index] = entry } else { workspaces.append(entry) }
        activeServerUrl = serverUrl
        activeBadge = 0
        error = nil
        persistWorkspaces()
        await enterSession(api: api, me: me)
        if info == nil { Task { await refreshServerInfo(serverUrl) } }
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

    /// M12h: create the account the link allows and enter the session; returns the failure text, if any. The server
    /// becomes a workspace like any other (one account per server).
    func acceptInvite(server: URL, token: String, username: String, displayName: String, password: String) async -> String? {
        guard let normalized = Workspaces.normalize(server.absoluteString) else { return "サーバ URL が正しくありません" }
        let serverUrl = workspaces.first { Workspaces.sameServer($0.serverUrl, normalized) }?.serverUrl ?? normalized
        let answer = try? await ApiClient(baseUrl: URL(string: serverUrl) ?? server).serverInfo()
        let info = answer?.product == "chikuwachat" ? answer : nil
        if let known = Workspaces.duplicate(of: serverUrl, workspaceId: info?.workspaceId, in: workspaces), known.isSignedIn {
            return "\(known.name) にはすでにログインしています (1 つのサーバーに 1 アカウント)"
        }
        let api = makeClient(serverUrl: serverUrl, username: username)
        do {
            let tokens = try await api.acceptInvite(token: token, username: username, displayName: displayName, password: password,
                                                    device: .init(platform: "ios", deviceName: UIDevice.current.name, appVersion: Self.appVersion))
            await adopt(api, serverUrl: serverUrl, username: username, me: tokens.user, info: info)
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

    private func enterSession(api: ApiClient, me: UserMe) async {
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
        guard let api, let workspace = activeWorkspace else { return false }
        engine?.stop()
        messageFocus = nil
        let account = workspace.account
        let serverUrl = workspace.serverUrl
        let persistence = try? SQLitePersistence.open(profile: account)
        let store = Store(persistence: persistence)
        store.load()
        self.store = store
        if restoring {
            guard let cached = store.me, !cached.mustChangePassword else { return false }
            me = cached
        } else if let me { store.setMe(me) }
        AvatarCache.shared.fetcher = { [weak api] path in
            guard let api else { throw ApiError.api(status: 0, code: "signed_out", message: "") }
            return try await api.fetchData(path)
        }
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
            self.sessionEnded(serverUrl)
        }
        engine.isActive = { UIApplication.shared.applicationState == .active }
        engine.onRead = { channelId in PushCenter.shared.clearNotifications(channelId: channelId) }
        engine.onReminder = { [weak self] reminder in
            self?.notice = "⏰ " + ((reminder.note?.isEmpty == false ? reminder.note! + " — " : "") + reminder.preview)
        }
        engine.onBadge = { [weak self, weak engine] count in
            guard let self, self.engine === engine else { return } // a signed-out engine's late tasks leave the badge alone (§11)
            self.activeBadgeChanged(count)
        }
        self.engine = engine
        engine.prepareConnection = { [weak self, weak engine] refresh in
            // §7.2: renew the access token only when it is missing, about to expire, or was refused (close 4001);
            // every refresh rotates the refresh token, and a lost answer must not turn into a forced logout.
            if refresh || api.needsRefresh() {
                let tokens = try await api.refresh()
                guard let self, self.api === api, self.engine === engine else { return }
                self.me = tokens.user
                self.store.setMe(tokens.user)
                if tokens.user.mustChangePassword {
                    engine?.stop()
                    self.screen = .changePassword
                    throw ApiError.api(status: 403, code: "password_change_required", message: "Password change required")
                }
            }
            guard let self, self.api === api, self.engine === engine else { return }
            PushCenter.shared.bind(self)
            PushCenter.shared.sessionConnected()
        }
        screen = .main
        Task { await engine.start() }
        return true
    }

    /// Foreground: iOS suspends sockets in the background, so reconnect and catch up (SYNC_PROTOCOL.md §7.5); the
    /// push token goes to every workspace and the other workspaces' badges are read again (WORKSPACES.md §6, §8).
    func didBecomeActive() {
        engine?.reconnectNow()
        guard booted else { return }
        Task {
            await uploadPushTokens()
            await refreshSummaries()
        }
    }

    /// Background: the server learns at once that this phone is not in use, so its pushes are not held back for
    /// the activity window (PUSH_NOTIFICATIONS.md §4.1); iOS suspends the socket soon after.
    func didEnterBackground() {
        engine?.reportActivity()
        // M45 (CANVAS.md §4.4 「背面に回るとき」): what was typed in a canvas is saved now, not after the pause.
        if let canvases = engine?.canvases { Task { await canvases.flushAll() } }
    }

    // MARK: workspaces that are not open (WORKSPACES.md §6, §7, §8)

    /// The open workspace's count changed (bootstrap, reads, events): its entry and the app icon follow.
    private func activeBadgeChanged(_ count: Int) {
        activeBadge = count
        if let serverUrl = activeServerUrl {
            let meId = store.me?.id
            let unread = store.channels.values.contains { $0.hasUnread(meId: meId) && !$0.channel.archived } || store.threadSummary.unreadCount > 0
            patch(serverUrl) { entry in
                entry.badge = count
                entry.hasUnread = unread
            }
        }
        updateAppBadge()
    }

    /// App icon = the open workspace's count + the last known counts of the others.
    private func updateAppBadge() {
        PushCenter.shared.setBadge(Workspaces.appBadge(activeBadge: activeBadge, active: activeServerUrl, list: workspaces))
    }

    /// GET /sync/summary for every signed-in workspace that is not open: when the app comes to the foreground and when
    /// the switcher opens. A failure keeps the last known values; a refused session signs that workspace out.
    func refreshSummaries() async {
        for workspace in workspaces where workspace.serverUrl != activeServerUrl && workspace.isSignedIn {
            let api = client(for: workspace)
            guard api.refreshToken != nil || api.accessToken != nil, let summary = try? await api.syncSummary() else { continue }
            guard clients[workspace.serverUrl] === api, workspace.serverUrl != activeServerUrl else { continue }
            patch(workspace.serverUrl) { entry in
                entry.badge = summary.badge
                entry.hasUnread = summary.hasUnread
            }
        }
        updateAppBadge()
    }

    /// GET /server (no login) for one workspace or all: the name for the switcher, and a workspace_id that changed
    /// with a restore (§3.1). A failure keeps what is known.
    func refreshServerInfo(_ only: String? = nil) async {
        for workspace in workspaces where only == nil || workspace.serverUrl == only {
            guard let url = URL(string: workspace.serverUrl), let info = try? await ApiClient(baseUrl: url).serverInfo(),
                  info.product == "chikuwachat" else { continue }
            patch(workspace.serverUrl) { entry in
                entry.name = info.name
                entry.workspaceId = info.workspaceId
            }
        }
    }

    /// The workspace on screen (re)connected: register the APNs token with it again (a new login has a new device row).
    func pushSessionStarted() {
        if let serverUrl = activeServerUrl { pushTokens[serverUrl] = nil }
        Task { await uploadPushTokens() }
    }

    /// PUT /devices/current with this device's APNs token on every signed-in workspace that does not have it yet
    /// (PUSH_NOTIFICATIONS.md §3). One that is not open renews its access token with its saved refresh token first,
    /// through its own client (so its refreshes never overlap), and keeps the rotated token.
    func uploadPushTokens() async {
        guard let token = PushCenter.shared.token else { return }
        let environment = PushEnvironment.current()
        for workspace in workspaces where workspace.isSignedIn && pushTokens[workspace.serverUrl] != token && !pushUploads.contains(workspace.serverUrl) {
            let serverUrl = workspace.serverUrl
            let api: ApiClient
            if serverUrl == activeServerUrl {
                guard let active = self.api, engine != nil else { continue }
                api = active
            } else {
                api = client(for: workspace)
                guard api.refreshToken != nil || api.accessToken != nil else { continue }
            }
            pushUploads.insert(serverUrl)
            do {
                _ = try await api.updateDevice(pushProvider: "apns", pushToken: token, pushEnvironment: environment)
                if clients[serverUrl] === api { pushTokens[serverUrl] = token }
            } catch {
                print("push token upload failed (\(workspace.host)): \(error)")
            }
            pushUploads.remove(serverUrl)
        }
    }

    /// willPresent (WORKSPACES.md §7): the workspace on screen syncs and only the conversation open there stays quiet;
    /// another workspace's notification always shows and marks that workspace unread.
    func foregroundNotification(_ payload: PushPayload) -> Bool {
        let target = Workspaces.route(payload, list: workspaces, active: activeServerUrl, hasChannel: workspaceHasChannel)
        if let target, target.serverUrl != activeServerUrl {
            patch(target.serverUrl) { entry in
                entry.hasUnread = true
                if let badge = payload.badge { entry.badge = badge }
            }
            updateAppBadge()
        } else {
            engine?.reconnectNow() // new data may exist: sync (PUSH_NOTIFICATIONS.md §9)
        }
        return Workspaces.shouldPresent(payload, target: target, active: activeServerUrl,
                                        openChannelId: screen == .main ? engine?.currentChannelId : nil)
    }

    /// A tapped notification: its workspace comes on screen (switching if needed), then the conversation opens after
    /// the usual sync (MainView watches pendingChannelId).
    func openNotification(_ payload: PushPayload) async {
        guard booted else {
            PushCenter.shared.queueTap(payload)
            return
        }
        if let target = Workspaces.route(payload, list: workspaces, active: activeServerUrl, hasChannel: workspaceHasChannel),
           target.serverUrl != activeServerUrl || screen != .main {
            await switchTo(target.serverUrl)
        }
        if payload.opensMessage, let messageId = payload.messageId {
            // M39: a reaction to my message (PUSH_NOTIFICATIONS.md §4): that message, not the conversation's unread
            // position (it may be old), in its thread when it is a reply.
            engine?.reconnectNow()
            await openPermalink(messageId)
            return
        }
        PushCenter.shared.pendingChannelId = payload.channelId
        PushCenter.shared.pendingParentId = payload.parentId // a reply: its thread opens too (M28d)
        engine?.reconnectNow()
    }

    /// Whether a workspace's local store knows the channel: the open one in memory, the others on disk.
    private func workspaceHasChannel(_ workspace: Workspace, _ channelId: String) -> Bool {
        if workspace.serverUrl == activeServerUrl && store.channel(channelId) != nil { return true }
        return SQLitePersistence.hasChannel(profile: workspace.account, channelId: channelId)
    }

    var isAdmin: Bool { me?.role == "admin" }
    /// M13e: confined to the channels they were added to; browsing and creation are hidden.
    var isGuest: Bool { me?.role == "guest" }

    // MARK: attachments (M9a)

    func uploadAttachment(data: Data, filename: String, contentType: String) async -> AttachmentOut? {
        guard let api else { return nil }
        do { return try await api.uploadAttachment(data: data, filename: filename, contentType: contentType) } catch { self.error = describe(error); return nil }
    }

    /// A picked file, streamed from disk (large files never sit in memory).
    func uploadAttachment(fileAt url: URL, filename: String, contentType: String) async -> AttachmentOut? {
        guard let api else { return nil }
        do { return try await api.uploadAttachment(fileAt: url, filename: filename, contentType: contentType) } catch { self.error = describe(error); return nil }
    }

    /// The refusal text when `bytes` exceed the server's attachment limit (from bootstrap); nil while it fits or is not known yet.
    func attachmentTooLarge(_ bytes: Int) -> String? {
        guard let limit = store.limits?.maxAttachmentBytes, bytes > limit else { return nil }
        return "\(ErrorMessages.byCode["attachment_too_large"] ?? ErrorMessages.unknown) (上限 \(formatSize(Int64(limit))))"
    }

    /// Fetch with authentication into a per-attachment temporary file for preview / sharing.
    func downloadAttachment(_ attachment: AttachmentOut) async -> URL? {
        guard let api else { return nil }
        do {
            let data = try await api.fetchData("/api/v1/attachments/\(attachment.id)/content")
            let dir = FileManager.default.temporaryDirectory.appendingPathComponent("attachments", isDirectory: true)
            let url = AttachmentFileCache.destination(for: attachment, in: dir)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: url, options: .atomic)
            return url
        } catch {
            self.error = describe(error)
            return nil
        }
    }

    // MARK: message actions (M8a): apply the server's answer at once; the WS event is deduplicated

    /// nil once saved, else the error: the editor shows it and keeps the text (C4).
    func editMessage(_ messageId: String, body: String) async -> String? {
        guard let api else { return ErrorMessages.unknown }
        do {
            _ = store.upsertMessage(try await api.editMessage(id: messageId, body: body))
            return nil
        } catch { return describe(error) }
    }

    /// The row gone from the list at once, for the view to animate (the rows closing up in one frame when the server's
    /// answer came jolted the list, testers 2026-09-29); `deleteMessage` puts it back if the server refuses.
    func hideMessage(_ message: MessageState) {
        var gone = message
        gone.deleted = true
        store.upsertMessage(gone, replacingSameVersion: true)
    }

    func deleteMessage(_ message: MessageState) async {
        guard let api else { return }
        do { _ = store.upsertMessage(try await api.deleteMessage(id: message.id)) } catch {
            store.upsertMessage(message, replacingSameVersion: true)
            self.error = describe(error)
        }
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
            guard let data = try? await api.fetchData("/api/v1/emoji/\(emoji.id)/image"),
                  let decoded = await Task.detached(operation: { CustomEmoji.decode(data) }).value else { return }
            if let animation = decoded.animation { store.emojiAnimations[emoji.id] = animation }
            store.emojiImages[emoji.id] = decoded.still
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

    /// Cancel a scheduled message; its text returns to the conversation's draft so nothing is lost: as typed
    /// (`@name`, not the wire tokens), after whatever is being written there already.
    func cancelScheduled(_ row: ScheduledOut) async {
        guard let api else { return }
        do {
            try await api.cancelScheduled(id: row.id)
            store.scheduled.removeValue(forKey: row.id)
            if !row.body.isEmpty {
                let text = Mentions.decode(row.body, users: store.users, groups: store.groups)
                store.setDraft(row.channelId, parentId: row.parentId) { draft in
                    draft.text = draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? text : draft.text + "\n" + text
                }
            }
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
            // M27: a public channel I have not joined opens as its preview, read-only, around the linked message.
            if store.channel(message.channelId)?.isMember == false {
                NotificationCenter.default.post(name: .chikuwaOpenChannel, object: nil,
                                                userInfo: ["id": message.channelId, "messageId": messageId])
                return
            }
            if await revealMessage(message) {
                NotificationCenter.default.post(name: .chikuwaOpenChannel, object: nil,
                                                userInfo: ["id": message.channelId, "parentId": message.parentId as Any])
            }
        } catch { self.error = describe(error) }
    }

    /// THREADS.md: follow or unfollow a thread, and say so when it could not be done (it was silent: an offline tap
    /// changed nothing and showed nothing, audit 2026-09-29).
    func setThreadFollow(_ parentId: String, following: Bool) async {
        guard let engine else { return }
        if engine.status != .online {
            error = ErrorMessages.network
        } else if !(await engine.setThreadFollow(parentId, following: following)) {
            error = following ? "スレッドをフォローできませんでした" : "スレッドのフォローを外せませんでした"
        }
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

    // MARK: channel links (M15f)

    func addChannelLink(_ channelId: String, title: String, url: String) async -> Bool {
        guard let api else { return false }
        do { store.setChannelLinks(channelId, try await api.addChannelLink(channelId: channelId, title: title, url: url)); return true }
        catch { self.error = describe(error); return false }
    }

    func updateChannelLink(_ channelId: String, linkId: String, title: String? = nil, url: String? = nil, position: Int? = nil) async -> Bool {
        guard let api else { return false }
        do {
            store.setChannelLinks(channelId, try await api.updateChannelLink(channelId: channelId, linkId: linkId, title: title, url: url, position: position))
            return true
        } catch { self.error = describe(error); return false }
    }

    func deleteChannelLink(_ channelId: String, linkId: String) async -> Bool {
        guard let api else { return false }
        do { store.setChannelLinks(channelId, try await api.deleteChannelLink(channelId: channelId, linkId: linkId)); return true }
        catch { self.error = describe(error); return false }
    }

    /// M15e: 「確認しました」 on a message that asks for it, or take it back.
    func toggleAck(_ message: MessageState) async {
        guard let api, let me = store.me else { return }
        let mine = message.acks.contains { $0.userId == me.id }
        do { store.upsertMessage(try await api.acknowledge(messageId: message.id, present: !mine)) } catch { self.error = describe(error) }
    }

    /// M15a: "owners" makes an announcement channel (owners and admins start the posts).
    func setPostingPolicy(_ channelId: String, policy: String) async -> Bool {
        guard let api else { return false }
        do {
            store.upsertChannel(try await api.updateChannel(id: channelId, postingPolicy: policy))
            return true
        } catch { self.error = describe(error); return false }
    }

    /// M15b: public → private (owner / admin) or private → public (admin only).
    func convertChannel(_ channelId: String, to type: String) async -> Bool {
        guard let api else { return false }
        do {
            store.upsertChannel(try await api.updateChannel(id: channelId, type: type))
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

    /// PUT replaces the level (nil = follow my overall setting, M35) and the timed mute; `muted` (until unmuted) is
    /// left as it is when nil. Callers changing one part pass the others' current values (`ownNotificationLevel`).
    func setNotification(_ channelId: String, level: String?, mutedUntil: String?, muted: Bool? = nil) async -> Bool {
        guard let api else { return false }
        do {
            let pref = try await api.setNotificationPreference(channelId: channelId, level: level, mutedUntil: mutedUntil, muted: muted)
            store.setNotification(channelId, pref)
            engine?.onBadge?(store.badgeCount)
            return true
        } catch { self.error = describe(error); return false }
    }

    /// The level picker (nil = 既定): the mutes stay.
    func setNotificationLevel(_ channel: ChannelState, own: String?) async -> Bool {
        await setNotification(channel.id, level: own, mutedUntil: channel.channel.notification?.mutedUntil)
    }

    /// M35: 「ミュート」 on / off (until unmuted); the level and a timed mute stay.
    func setMuted(_ channel: ChannelState, _ muted: Bool) async -> Bool {
        await setNotification(channel.id, level: channel.ownNotificationLevel, mutedUntil: channel.channel.notification?.mutedUntil, muted: muted)
    }

    /// 「8 時間ミュート」 / its 解除 (nil): the level stays (also when it follows the default).
    func setTimedMute(_ channel: ChannelState, until: Date?) async -> Bool {
        await setNotification(channel.id, level: channel.ownNotificationLevel, mutedUntil: until.map { ISO8601DateFormatter().string(from: $0) })
    }

    /// M11d: title / custom status. nil values clear; pass only the fields to change.
    func updateProfile(title: String?? = nil, statusText: String?? = nil, statusEmoji: String?? = nil, statusExpiresAt: String?? = nil,
                       dndUntil: String?? = nil, quietHours: QuietHours?? = nil, notifyKeywords: [String]? = nil,
                       presenceHidden: Bool? = nil, notificationDefault: String? = nil, notifyReactions: Bool? = nil) async -> Bool {
        guard let api else { return false }
        var fields: [String: JSONValue] = [:]
        if let notifyReactions { fields["notify_reactions"] = .bool(notifyReactions) }  // M39
        // M35: channels that follow the default show the new level at once (they resolve with store.me).
        if let notificationDefault { fields["notification_default"] = .string(notificationDefault) }
        if let title { fields["title"] = title.map(JSONValue.string) ?? .null }
        if let statusText { fields["status_text"] = statusText.map(JSONValue.string) ?? .null }
        if let statusEmoji { fields["status_emoji"] = statusEmoji.map(JSONValue.string) ?? .null }
        if let statusExpiresAt { fields["status_expires_at"] = statusExpiresAt.map(JSONValue.string) ?? .null }
        // M12g
        if let notifyKeywords { fields["notify_keywords"] = .array(notifyKeywords.map(JSONValue.string)) }
        if let presenceHidden { fields["presence_hidden"] = .bool(presenceHidden) }  // L4
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

    /// M39: the activity is read up to `readAt` (「すべて既読」, or the newest item the list showed). The badge takes the
    /// server's answer; my other devices follow through activity.read. Whether it went through (the reason is shown).
    func markActivityRead(_ readAt: String) async -> Bool {
        guard let engine else { return false }
        do {
            try await engine.markActivityRead(readAt)
            return true
        } catch { self.error = describe(error); return false }
    }

    /// L4: the members who have not acknowledged a message; nil when it could not be loaded (the reason is shown).
    func ackPending(_ message: MessageState) async -> [String]? {
        guard let api else { return nil }
        do { return try await api.ackPending(messageId: message.id) } catch { self.error = describe(error); return nil }
    }

    /// L4: the author (or an admin) reminds them; each gets a reminder only they see. What happened, in words for the
    /// sheet that asked (the app's toasts are behind it), and whether it went through.
    func remindUnacknowledged(_ message: MessageState) async -> (ok: Bool, text: String) {
        guard let api else { return (false, "サーバーに接続できません") }
        do {
            let count = try await api.remindUnacknowledged(messageId: message.id)
            return (true, count > 0 ? "\(count) 人にリマインドしました" : "リマインド済みの人だけです")
        } catch { return (false, describe(error)) }
    }

    /// L4: make a member an owner, or a member again (owners and admins; the store follows channel.member_updated too).
    func setMemberRole(channelId: String, userId: String, role: String) async -> MemberOut? {
        guard let api else { return nil }
        do {
            let member = try await api.setMemberRole(channelId: channelId, userId: userId, role: role)
            if userId == store.me?.id { store.setMembershipRole(channelId, role: member.role) }
            return member
        } catch { self.error = describe(error); return nil }
    }

    /// M23: my research topic and reading on the lab roster; the store takes the saved line at once (roster.updated
    /// brings it to my other devices).
    func updateMyRosterLine(researchTopic: String?, reading: String?) async -> Bool {
        guard let api else { return false }
        do {
            let line = try await api.updateMyRosterLine(researchTopic: researchTopic, reading: reading)
            store.applyRoster(line.userId, line)
            return true
        } catch { self.error = describe(error); return false }
    }

    /// Open (or create) the DM with one user, or with myself alone (notes to self); returns its channel id.
    func openDmWith(_ userId: String) async -> String? {
        guard let api else { return nil }
        // Exactly the two of us (me alone for my own id: "contains" took any DM of mine for notes to self).
        let members = Set([userId] + (store.me.map { [$0.id] } ?? []))
        if let existing = store.channels.values.first(where: { $0.isMember && $0.channel.type == "dm" && Set($0.channel.dmUserIds ?? []) == members }) {
            return existing.id
        }
        do {
            let channel = try await api.createDm(userIds: [userId])
            store.upsertChannel(channel, isMember: true)
            return channel.id
        } catch { self.error = describe(error); return nil }
    }

    /// M24: my times (made on the first call; the supervisors on the roster join it); returns its id to open.
    func ensureTimes() async -> String? {
        guard let api else { return nil }
        do {
            let channel = try await api.ensureTimes()
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

    /// M40: my signed-in devices, this one first (the account screen's ログイン中の端末).
    func loadSessions() async throws -> [SessionOut] {
        guard let api else { throw ApiError.network(URLError(.notConnectedToInternet)) }
        return SessionList.ordered(try await api.sessions())
    }

    /// M40: sign another device out; whether it went through (the reason is shown).
    func revokeSession(_ id: String) async -> Bool {
        guard let api else { return false }
        do { try await api.revokeSession(id: id); return true } catch { self.error = describe(error); return false }
    }

    // MARK: sidebar sections (M14f)

    private func sidebarChange(_ work: (ApiClient) async throws -> [SidebarSectionOut]) async -> Bool {
        guard let api else { return false }
        do {
            store.replaceSidebar(try await work(api))
            return true
        } catch { self.error = describe(error); return false }
    }

    /// A new section at the end (M26: with its icon); `channelIds` move into it from wherever they were.
    func createSection(_ name: String, emoji: String?, channelIds: [String]) async -> Bool {
        await sidebarChange { try await $0.createSidebarSection(name: name, emoji: emoji, channelIds: channelIds) }
    }

    /// M26: the name and the icon (nil takes it off).
    func editSection(_ id: String, name: String, emoji: String?) async -> Bool {
        await sidebarChange { try await $0.editSidebarSection(id, name: name, emoji: emoji) }
    }

    /// M26: folds or unfolds one of my sections on all my devices. The list changes at once; if the server refuses,
    /// it goes back. `apply` makes each change (the view animates them).
    func setSectionCollapsed(_ id: String, collapsed: Bool, apply: (() -> Void) -> Void = { $0() }) async -> Bool {
        let before = store.sidebarSections
        apply {
            store.replaceSidebar(before.map { section in
                var section = section
                if section.id == id { section.collapsed = collapsed }
                return section
            })
        }
        let done = await sidebarChange { try await $0.updateSidebarSection(id, collapsed: collapsed) }
        if !done { apply { store.replaceSidebar(before) } }
        return done
    }
    func moveSection(_ id: String, position: Int) async -> Bool { await sidebarChange { try await $0.updateSidebarSection(id, position: position) } }
    func deleteSection(_ id: String) async -> Bool { await sidebarChange { try await $0.deleteSidebarSection(id) } }

    /// `sectionId` nil puts the conversation back in the default sections.
    func moveToSection(_ channelId: String, sectionId: String?) async -> Bool {
        await sidebarChange { api in
            if let sectionId { return try await api.placeInSidebarSection(sectionId, channelId: channelId) }
            return try await api.removeFromSidebarSection(channelId)
        }
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
            let answer = try await api.vote(messageId: message.id, option: option, present: present)
            store.upsertMessage(answer)
            store.setMyVotes(answer) // also when another vote's event came first (§8)
            return true
        } catch { self.error = describe(error); return false }
    }

    func closePoll(_ message: MessageState) async -> Bool {
        guard let api else { return false }
        do {
            let answer = try await api.closePoll(messageId: message.id)
            store.upsertMessage(answer)
            store.setMyVotes(answer)
            return true
        } catch { self.error = describe(error); return false }
    }

    func createPoll(channelId: String, parentId: String?, question: String, options: [String], multiple: Bool,
                    anonymous: Bool = false) async -> Bool {
        guard let api else { return false }
        do {
            let message = try await api.postPoll(channelId: channelId, parentId: parentId, question: question, options: options,
                                                 multiple: multiple, anonymous: anonymous)
            if let engine { engine.postedFromHere(message) } else { store.upsertMessage(message) }
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
        switch command.name {
        case "help":
            // M30: the templates too, which `/name` puts into the input.
            let templates = Templates.ordered(store.templates, inTimes: state.channel.isTimes).map { "/" + $0.name }
            notice = (SlashCommands.all.map(\.usage) + templates).joined(separator: " · ")
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
            return await updateTopic(channelId, topic: command.args) // false when refused: the composer keeps the text
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
            // The channel's own level goes back as it is (nil keeps it following the overall setting, M35).
            _ = await setTimedMute(state, until: until)
            notice = "\(Schedule.label(until)) まで通知を止めます"
            return true
        case "unmute":
            // Both mutes end (the timed one and M35's until unmuted); the level stays.
            _ = await setNotification(channelId, level: state.ownNotificationLevel, mutedUntil: nil, muted: false)
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
        case "日程":  // M30: a multiple-choice poll of dates
            guard let schedule = Templates.parseSchedule(command.args, today: .today()) else {
                error = Templates.scheduleUsage
                return false
            }
            return await createPoll(channelId: channelId, parentId: parentId, question: schedule.question, options: schedule.options, multiple: true)
        default:
            return false
        }
    }

    // MARK: signing out (WORKSPACES.md §5.3, SYNC_PROTOCOL.md §11)

    /// 「ログアウト」: sign out of the workspace on screen; the next one opens (or the login form).
    func logout() async {
        guard let serverUrl = activeServerUrl else { return }
        await signOutWorkspace(serverUrl)
    }

    /// Sign out of a workspace, on screen or not, and forget it: the server session ends (so the device stops getting
    /// its pushes), then nothing of the account stays here. One already signed out just leaves the list.
    func signOutWorkspace(_ serverUrl: String) async {
        guard let workspace = workspaces.first(where: { $0.serverUrl == serverUrl }) else { return }
        if serverUrl == activeServerUrl {
            await engine?.canvases.flushAll() // M45: a canvas typed in the last seconds too
            engine?.stop()
        }
        // Out of the clients first: its own signed-out callback must not mark the entry instead of removing it.
        var api = clients.removeValue(forKey: serverUrl)
        if api == nil, workspace.isSignedIn, let token = Keychain.get(account: workspace.account) {
            api = makeClient(serverUrl: serverUrl, username: workspace.username)
            api?.refreshToken = token
        }
        if let api, api.refreshToken != nil || api.accessToken != nil { await api.logout() }
        forget(workspace, remove: true)
    }

    /// The server ended the session (revoked, refresh refused): only this workspace signs out, and it stays in the
    /// list to sign back in (WORKSPACES.md §5.2).
    private func sessionEnded(_ serverUrl: String) {
        guard let workspace = workspaces.first(where: { $0.serverUrl == serverUrl }) else { return }
        forget(workspace, remove: false)
    }

    /// SYNC_PROTOCOL.md §11 for one workspace: its refresh token, local store (messages, drafts, send queue), recent
    /// searches and delivered notifications go. `remove` takes it off the list, else it stays there signed out. When
    /// it was on screen, the first signed-in workspace left takes its place (or the login form).
    private func forget(_ workspace: Workspace, remove: Bool) {
        let serverUrl = workspace.serverUrl
        let wasActive = serverUrl == activeServerUrl
        if let api = clients.removeValue(forKey: serverUrl), api.refreshToken != nil || api.accessToken != nil { api.signOut() }
        pushTokens[serverUrl] = nil
        if wasActive {
            closeSession()
            activeBadge = 0
        }
        Keychain.delete(account: workspace.account)
        SQLitePersistence.destroy(profile: workspace.account)
        RecentSearches.clear(key: RecentSearches.key(account: workspace.account))
        if remove {
            workspaces.removeAll { $0.serverUrl == serverUrl }
            if workspaces.isEmpty { lastSignIn = (serverUrl, workspace.username) }
        } else {
            patch(serverUrl) { entry in
                entry.signedOut = true
                entry.badge = nil
                entry.hasUnread = nil
            }
        }
        if workspaces.contains(where: { $0.serverUrl != serverUrl && $0.isSignedIn }) {
            PushCenter.shared.clearNotifications(workspaceId: workspace.workspaceId)
        } else {
            PushCenter.shared.clearAll() // no other account here: nothing may stay (as with a single server)
        }
        let next = wasActive && remove ? (workspaces.first(where: \.isSignedIn) ?? workspaces.first) : nil
        if wasActive && remove { activeServerUrl = next?.serverUrl }
        persistWorkspaces()
        updateAppBadge()
        guard wasActive else { return }
        if let next {
            screen = .boot // not an empty channel list while the next workspace opens
            Task { await open(next) }
        } else {
            screen = .login
        }
    }

    /// The Japanese text for a failure (ARCHITECTURE.md §9); never the server's English message.
    func describe(_ error: Error) -> String { ErrorMessages.text(for: error) }
}
