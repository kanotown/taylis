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
    /// A new UI language rebuilds the screens: MainView opens 自分 → 表示 → 言語 again, where it was chosen.
    var reopenLanguageSettings = false
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
    /// M73: a canvas to show in its conversation's 「キャンバス」 tab (a canvas mention's notification, a task's 元のキャンバス).
    var canvasOpen: CanvasOpen?
    /// M73: the notice on screen opens this canvas when tapped (an in-app canvas mention); kept with its text.
    var noticeCanvas: (notice: String, target: CanvasOpen)?
    /// M122: a wiki page link (`page:<id>`, `<server>/p/<id>`) tapped outside the wiki's screens: the page over
    /// everything (MainView).
    var pageLink: PageLinkTarget?
    /// M122: the notice on screen opens this page when tapped (an in-app page mention or share); kept with its text.
    var noticePage: (notice: String, pageId: String)?
    /// L8: the Times feed's rows while the app runs (TIMES_FEED.md §5), one per open workspace.
    private(set) var timesFeed = TimesFeedModel()
    /// The conversations' 「ピン留め」 tabs (PinsView), kept live by the same rows as the Times feed.
    var pinLists = PinLists()
    /// M52: an event to show (a calendar alarm's notification): its channel's 「予定」 tab or the calendar takes it.
    var calendarOpen: CalendarOpen?
    /// M56: a task to show, or a board to open (a task's notification, 「自分の担当」's channel): its channel's 「タスク」 tab
    /// or 「自分のタスク」 takes it.
    var taskOpen: TaskOpen?
    /// M95: a workflow's form, full screen over everything (MainView): from the composer's 「＋」, `/name`, the channel
    /// details and a message's 「⚡ name」.
    var workflowRun: WorkflowRunTarget?
    /// M95: each channel's workflows as last read, kept a minute (their changes send no events, WORKFLOWS.md §4).
    @ObservationIgnored var workflowLists: [String: (at: Date, list: [WorkflowOut])] = [:]
    /// M117: the call each conversation is starting, kept for a retry (CallKeys).
    @ObservationIgnored var callKeys = CallKeys()
    func revealMessage(_ message: MessageOut) async -> Bool {
        await revealMessage(id: message.id, channelId: message.channelId, parentId: message.parentId)
    }

    /// Focus a message known only by its ids (M11i files list): the context comes from the server.
    func revealMessage(id: String, channelId: String, parentId: String?) async -> Bool {
        guard let api else { return false }
        do {
            let context = try await api.messageContext(id)
            if let parentId {
                do {
                    for reply in try await api.replies(messageId: parentId) { store.upsertMessage(reply) }
                } catch let error as ApiError where error.code == "message_not_found" {
                    // A reply whose root is deleted (a stale link, a notification): the thread opens saying so (THREADS.md §5).
                    store.threadRootDeleted(channelId, parentId)
                }
            }
            messageFocus = MessageFocus(channelId: channelId, messageId: id, parentId: parentId, context: context.map(MessageState.init))
            return true
        } catch { self.error = describe(error); return false }
    }

    /// 「スレッド」's conversation link: the thread's parent revealed in its conversation's timeline (not the thread);
    /// the caller then shows the conversation alone. Returns its channel, nil when the message could not be loaded.
    func revealThreadParent(_ entry: ThreadEntry) async -> String? {
        let channelId = entry.state.channelId
        return await revealMessage(id: entry.parent.id, channelId: channelId, parentId: nil) ? channelId : nil
    }
    /// The open workspace's client; the sign-in and workspace flows set it (a view test sets a stubbed one).
    var api: ApiClient?
    private(set) var store = Store()
    private(set) var engine: SyncEngine?

    private let defaults: UserDefaults
    private static let appVersion = "0.1.0"

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    // MARK: workspaces (M16c, WORKSPACES.md)

    /// The registered workspaces in the order added or as reordered in the switcher (M114, §5.4). Only the active one is connected and on screen (§6); the others
    /// hear of new messages by push and show their last known badge.
    private(set) var workspaces: [Workspace] = []
    private(set) var activeServerUrl: String?
    var activeWorkspace: Workspace? { workspaces.first { $0.serverUrl == activeServerUrl } }
    /// The name over the channel list (GET /server); "Taylis" before any workspace.
    var workspaceName: String { activeWorkspace?.name ?? "Taylis" }
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
        activeWorkspace?.signInName ?? lastSignIn?.username ?? defaults.string(forKey: Workspaces.legacyUsernameKey) ?? ""
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
        let api = ApiClient(baseUrl: URL(string: serverUrl) ?? URL(string: "https://invalid.invalid")!)
        wire(api, serverUrl: serverUrl, username: username)
        return api
    }

    /// The callbacks of a workspace's client (M48: a Google sign-in learns the username only from the exchange).
    private func wire(_ api: ApiClient, serverUrl: String, username: String) {
        let account = "\(serverUrl)|\(username)"
        api.onTokens = { tokens in Keychain.set(account: account, value: tokens.refreshToken) }
        api.onSignedOut = { [weak self, weak api] in Task { @MainActor in
            guard let self, let api, self.clients[serverUrl] === api else { return }
            self.sessionEnded(serverUrl)
        } }
    }

    private func persistWorkspaces() {
        Workspaces.save(Workspaces.Saved(list: workspaces, active: activeServerUrl), to: defaults)
    }

    /// M114 (WORKSPACES.md §5.4): the switcher's order, kept on this device only (each workspace is its own server).
    func reorderWorkspaces(_ list: [Workspace]) {
        guard list != workspaces, Set(list.map(\.serverUrl)) == Set(workspaces.map(\.serverUrl)) else { return }
        workspaces = list
        persistWorkspaces()
    }

    /// M96: the account's username now reaches the saved entry (the list and the next login form show it); `username`
    /// keeps naming the Keychain item and the local database. Called with every UserMe this device gets: a rename here,
    /// a token refresh (every 15 minutes at most) and a sign-in.
    func followUsername(_ live: String, serverUrl: String) {
        patch(serverUrl) { entry in entry.loginName = live == entry.username ? nil : live }
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

    /// A view test runs a screen on a store and an engine of its own (the sign-in flow makes them otherwise).
    func attachForTesting(store: Store, engine: SyncEngine) {
        self.store = store
        self.engine = engine
    }

    /// The workspace on screen goes: its engine stops and its store closes. Nothing of it may show in the next one.
    private func closeSession() {
        engine?.stop()
        engine = nil
        api = nil
        me = nil
        messageFocus = nil
        canvasLink = nil
        canvasOpen = nil
        noticeCanvas = nil
        pageLink = nil
        noticePage = nil
        workflowRun = nil
        workflowLists = [:]
        timesFeed = TimesFeedModel()
        pinLists = PinLists()
        previewLoads = [:]
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
        let serverUrl: String, info: ServerInfoOut?
        switch await signInTarget(input, adding: adding) {
        case .server(let url, let answer): (serverUrl, info) = (url, answer)
        case .done(let outcome): return outcome
        }
        let api = makeClient(serverUrl: serverUrl, username: username)
        do {
            let tokens = try await api.login(username: username, password: password, device: Self.deviceInfo, totpCode: totpCode.map(Totp.normalize))
            await adopt(api, serverUrl: serverUrl, username: username, me: tokens.user, info: info)
            return .signedIn
        } catch {
            if case ApiError.api(_, let code, _) = error, code == "totp_required" { return .needsCode(nil) }
            if case ApiError.api(_, let code, _) = error, code == "invalid_totp" { return .needsCode(Totp.errorText(error)) }
            return .failed(describe(error))
        }
    }

    /// M48 (SSO.md §6): 「Google でログイン」. The sign-in sheet opens on the server the form names and its ticket is
    /// exchanged with that same server (the verifier never leaves this call); the account's username comes with the
    /// tokens. nil: the person closed the sheet, and the form says nothing.
    func signInWithGoogle(server input: String, adding: Bool = false, authenticator: WebAuthenticator? = nil) async -> SignInOutcome? {
        let serverUrl: String, info: ServerInfoOut?
        switch await signInTarget(input, adding: adding) {
        case .server(let url, let answer): (serverUrl, info) = (url, answer)
        case .done(let outcome): return outcome
        }
        guard let url = URL(string: serverUrl) else { return .failed(tr("サーバ URL が正しくありません")) }
        let ticket: String, verifier: String
        switch await Sso.run(server: url, authenticator: authenticator ?? SystemWebAuthenticator()) {
        case .ticket(let t, let v): (ticket, verifier) = (t, v)
        case .cancelled: return nil
        case .failed(let text): return .failed(text)
        }
        let api = ApiClient(baseUrl: url)
        do {
            let tokens = try await api.ssoExchange(ticket: ticket, verifier: verifier, device: Self.deviceInfo)
            let username = tokens.user.username
            wire(api, serverUrl: serverUrl, username: username)
            api.onTokens?(tokens) // the refresh token goes to the Keychain as a login's does
            await adopt(api, serverUrl: serverUrl, username: username, me: tokens.user, info: info)
            return .signedIn
        } catch {
            return .failed(describe(error))
        }
    }

    /// GET /auth/methods of the server the form names: its Google button, nil when it offers none (or on any failure).
    func offersGoogle(server input: String) async -> GoogleButtonText? {
        guard let normalized = Workspaces.normalize(input) else { return nil }
        let serverUrl = workspaces.first { Workspaces.sameServer($0.serverUrl, normalized) }?.serverUrl ?? normalized
        guard let url = URL(string: serverUrl) else { return nil }
        return await ApiClient(baseUrl: url).offersGoogle()
    }

    private static var deviceInfo: DeviceInfo { .init(platform: "ios", deviceName: UIDevice.current.name, appVersion: appVersion) }

    private enum SignInTarget {
        /// Sign in to this address (a registered one keeps its spelling); the GET /server answer when it is ChikuwaChat.
        case server(String, ServerInfoOut?)
        case done(SignInOutcome)
    }

    /// The form's address, normalized and asked for GET /server. Adding a workspace needs a ChikuwaChat answer, and a
    /// workspace registered already (same workspace_id or address) is opened instead: one account per server.
    private func signInTarget(_ input: String, adding: Bool) async -> SignInTarget {
        guard let normalized = Workspaces.normalize(input) else { return .done(.failed(tr("サーバ URL が正しくありません"))) }
        // A registered address keeps its spelling: it names the Keychain item and the local store.
        var serverUrl = workspaces.first { Workspaces.sameServer($0.serverUrl, normalized) }?.serverUrl ?? normalized
        guard let url = URL(string: serverUrl) else { return .done(.failed(tr("サーバ URL が正しくありません"))) }
        var info: ServerInfoOut?
        do {
            let answer = try await ApiClient(baseUrl: url).serverInfo()
            info = answer.product == "chikuwachat" ? answer : nil
        } catch let error as ApiError where error.isRetryable {
            return .done(.failed(describe(error))) // no answer, or a server error: not a verdict on the address
        } catch {
            info = nil
        }
        if adding {
            guard let info else { return .done(.failed(tr("Taylis のサーバーではありません"))) }
            if let known = Workspaces.duplicate(of: serverUrl, workspaceId: info.workspaceId, in: workspaces) {
                if known.isSignedIn {
                    await switchTo(known.serverUrl)
                    notice = tr("\(known.name) は登録済みです")
                    return .done(.switched)
                }
                serverUrl = known.serverUrl // registered but signed out: sign in to it again
            }
        }
        return .server(serverUrl, info)
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
                              username: username, userId: me.id,
                              iconVersion: info?.hasIconVersion == true ? info?.iconVersion : known?.iconVersion)
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
        guard let api else { throw ApiError.api(status: 0, code: "signed_out", message: tr("ログインしていません")) }
        return try await api.totpSetup(password: password)
    }

    func enableTotp(code: String) async throws -> TotpEnabledOut {
        guard let api else { throw ApiError.api(status: 0, code: "signed_out", message: tr("ログインしていません")) }
        return try await api.totpEnable(code: Totp.normalize(code))
    }

    func disableTotp(password: String) async throws {
        guard let api else { throw ApiError.api(status: 0, code: "signed_out", message: tr("ログインしていません")) }
        try await api.totpDisable(password: password)
    }

    /// M12h: what an invite link offers, before any account exists (throws on a dead link).
    func previewInvite(server: URL, token: String) async throws -> InvitePreviewOut {
        try await ApiClient(baseUrl: server).invitePreview(token: token)
    }

    /// M12h: create the account the link allows and enter the session; returns the failure text, if any. The server
    /// becomes a workspace like any other (one account per server).
    func acceptInvite(server: URL, token: String, username: String, displayName: String, password: String) async -> String? {
        guard let normalized = Workspaces.normalize(server.absoluteString) else { return tr("サーバ URL が正しくありません") }
        let serverUrl = workspaces.first { Workspaces.sameServer($0.serverUrl, normalized) }?.serverUrl ?? normalized
        let answer = try? await ApiClient(baseUrl: URL(string: serverUrl) ?? server).serverInfo()
        let info = answer?.product == "chikuwachat" ? answer : nil
        if let known = Workspaces.duplicate(of: serverUrl, workspaceId: info?.workspaceId, in: workspaces), known.isSignedIn {
            return tr("\(known.name) にはすでにログインしています（1 つのサーバーに 1 アカウント）")
        }
        let api = makeClient(serverUrl: serverUrl, username: username)
        do {
            let tokens = try await api.acceptInvite(token: token, username: username, displayName: displayName, password: password,
                                                    device: Self.deviceInfo)
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
        if let me { followUsername(me.username, serverUrl: serverUrl) }  // M96
        // M93 (WORKSPACES.md §3.4.1): an admin changed the workspace icon (bootstrap, workspace.settings_updated).
        store.onWorkspaceIcon = { [weak self, weak store] version in
            guard let self, let store, self.store === store else { return }
            self.patch(serverUrl) { $0.iconVersion = version }
        }
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
        // M52: my calendar alarm while the app is open (the server's push covers the background), worded like that push.
        // Review v0.1.22 #9: nil when the occurrence it is for is not known here: a neutral line, never another occurrence's.
        engine.onCalendarAlarm = { [weak self] event, channelId in
            guard let self else { return }
            notice = "📅 " + CalendarDates.alarmText(event, channelName: channelId.flatMap { self.store.channel($0)?.channel.name })
        }
        // M56: an assignment or a due date while the app is open, worded like the push (not with notify_tasks off or in DND).
        engine.onTaskNotice = { [weak self] notice in self?.sayTaskNotice(notice) }
        // M73: a canvas mention while the app is open, worded like the push; the notice opens the canvas.
        engine.onCanvasMention = { [weak self] mention, _ in self?.sayCanvasMention(mention) }
        engine.onReservationNotice = { [weak self] notice in self?.sayReservationNotice(notice) }
        engine.onWikiNotice = { [weak self] notice, shared in self?.sayWikiNotice(notice, shared: shared) }
        // L8: the Times feed keeps its rows with the live message events (TIMES_FEED.md §5).
        timesFeed = TimesFeedModel()
        engine.onTimelineMessage = { [weak self, weak engine] event, message, thread in
            guard let self, self.engine === engine else { return }
            self.timesFeed.live(event, message, thread: thread, channel: self.store.channel(message.channelId))
            self.takePinRow(message) // a pinned message deleted or unpinned by anyone, held here or not
        }
        // Review #4: the rows the store takes otherwise (the delta after a gap, the answers to my own actions) and my
        // poll part reach the feed too; it keeps the newer version of each (§8).
        store.onMessageTaken = { [weak self, weak store] message in
            guard let self, let store, self.store === store else { return }
            self.timesFeed.stored(message, channel: store.channel(message.channelId))
            self.takePinRow(message)
        }
        store.onMyPart = { [weak self, weak store] answer in
            guard let self, let store, self.store === store else { return }
            self.timesFeed.myPart(answer)
        }
        store.onParentThread = { [weak self, weak store] thread in
            guard let self, let store, self.store === store else { return }
            self.timesFeed.thread(thread)
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
                self.followUsername(tokens.user.username, serverUrl: serverUrl)
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
        refreshDeadlines() // M86: a deadline may have been added while away (offline: the reconnect reads it)
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
        if let wiki = engine?.wiki { Task { await wiki.flushAll() } }  // M122
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
                if info.hasIconVersion { entry.iconVersion = info.iconVersion } // M93; a server before it: keep
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
        if payload.opensEvent, let eventId = payload.eventId {
            // M52 (PUSH_NOTIFICATIONS.md §4, kind = calendar): the event, in its channel's 「予定」 tab once the store knows
            // the channel (as a message's conversation), or in the calendar for my own (no channel).
            calendarOpen = CalendarOpen(eventId: eventId, channelId: payload.channelId)
            if payload.channelId == nil { PushCenter.shared.pendingCalendar = true }
        }
        if payload.opensPage, let pageId = payload.pageId {
            // M122 (docs/WIKI.md §9.3, kind = page): the page, on the home tab over 「ドキュメント」.
            PushCenter.shared.pendingPage = pageId
            engine?.reconnectNow()
            return
        }
        if payload.opensReservations {
            // M112 (PUSH_NOTIFICATIONS.md §4, kind = reservation): 「予約」 on the home tab.
            PushCenter.shared.pendingReservations = true
            engine?.reconnectNow()
            return
        }
        if payload.opensCanvas, let canvasId = payload.canvasId {
            // M73 (CANVAS.md §18.5, kind = canvas): the canvas, in its conversation's 「キャンバス」 tab once the store knows
            // the conversation; without one (not expected) its own sheet.
            guard let channelId = payload.channelId else {
                canvasLink = CanvasLinkTarget(id: canvasId)
                engine?.reconnectNow()
                return
            }
            canvasOpen = CanvasOpen(canvasId: canvasId, channelId: channelId)
        }
        if payload.opensTask, let taskId = payload.taskId {
            // M56 (PUSH_NOTIFICATIONS.md §4, kind = task): the task, in its channel's 「タスク」 tab once the store knows the
            // channel (as a message's conversation), or in 「自分のタスク」 for my own (no channel).
            // L9: a DM's task (a review request in a DM) has no board: it opens in 「自分のタスク」 too.
            let board = isDmTask(payload.channelId) ? nil : payload.channelId
            taskOpen = TaskOpen(taskId: taskId, channelId: board)
            if board == nil {
                PushCenter.shared.pendingTasks = true
                PushCenter.shared.pendingChannelId = nil
                PushCenter.shared.pendingParentId = nil
                engine?.reconnectNow()
                return
            }
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
        return tr("\(ErrorMessages.byCode["attachment_too_large"] ?? ErrorMessages.unknown)（上限 \(formatSize(Int64(limit)))）")
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
            threadRootsDeletedHere.remove(message.id) // refused: the thread stays, and a later deletion is not mine
            self.error = describe(error)
        }
    }

    /// THREADS.md: thread roots I am deleting from their own thread screen (its root row): that screen then closes without
    /// the notice. Marked right before the delete is asked for, taken when the screen closes.
    @ObservationIgnored private var threadRootsDeletedHere: Set<String> = []

    func markThreadRootDeletedHere(_ parentId: String) { threadRootsDeletedHere.insert(parentId) }

    /// An open thread closes because its root was deleted (ThreadRootWatch): 「元のメッセージが削除されたため、スレッドを
    /// 閉じました」, unless I deleted it from that thread myself.
    func threadClosedForDeletedRoot(_ parentId: String) {
        if threadRootsDeletedHere.remove(parentId) != nil { return }
        notice = tr("元のメッセージが削除されたため、スレッドを閉じました")
    }

    // MARK: link previews (M11g): kept with the account (Store.linkPreviews), asked for once per URL per session

    /// url → preview (nil = the page gives none). Views read this; `loadLinkPreview` fills it.
    var linkPreviews: [String: LinkPreviewOut?] { store.linkPreviews }
    private var previewLoads: [String: Task<Void, Never>] = [:]
    /// Messages whose 「プレビューを表示」 was tapped this session (LinkPreviewRules): their rows ask for the preview.
    var revealedPreviews: Set<String> = []
    /// M104: the messages of blocked people shown on request (「表示」), for as long as the app runs.
    var revealedBlocked: Set<String> = []

    /// Whether the message's row asks for its link's preview by itself (review v0.1.18 #5): not for an AI bot's or
    /// another bot's message (LinkPreviewRules), unless its preview was asked for by hand.
    func autoLoadsLinkPreview(_ message: MessageState) -> Bool {
        let sender = store.users[message.senderId]
        return LinkPreviewRules.autoLoads(senderId: message.senderId, senderRole: sender?.role, senderBotKind: sender?.botKind,
                                   aiBotIds: aiHub?.botUserIds ?? [])
    }

    /// 「プレビューを表示」 on the message's row.
    func revealLinkPreview(_ messageId: String) { revealedPreviews.insert(messageId) }

    /// What a row shows for its link now (LinkPreviewSlot).
    func linkPreviewSlot(_ url: String) -> LinkPreviewSlot {
        LinkPreviewSlot.of(store.linkPreviews[url], failed: store.sessionPreviewFailures.contains(url))
    }

    /// Asks for the link's preview once, however many rows show it. The request is not the row's: a row leaving the
    /// screen (the landing scrolls the newest rows away) cancelled it, and another row with the same link, which had
    /// found it under way, never got its card.
    func loadLinkPreview(_ url: String) async {
        if let running = previewLoads[url] { return await running.value }
        let store = store // the account asking, even if another one opens meanwhile
        guard let api, store.linkPreviewWanted(url) else { return }
        let load = Task {
            do {
                let preview = try await api.linkPreview(url: url)
                store.setLinkPreview(url, preview.status == "ok" ? preview : nil)
            } catch let error as ApiError where !error.isRetryable {
                store.setLinkPreview(url, nil) // refused (not a public page): no card
            } catch {
                store.setLinkPreviewFailed(url) // offline or rate limited: no card this session; one kept before stays
            }
        }
        previewLoads[url] = load
        await load.value
        if previewLoads[url] == load { previewLoads[url] = nil }
    }

    /// M11c: any member pins / unpins; the updated message (with pinnedAt) replaces the row.
    func togglePin(_ message: MessageState) async {
        guard let api else { return }
        do {
            _ = store.upsertMessage(message.pinnedAt != nil ? try await api.unpinMessage(id: message.id) : try await api.pinMessage(id: message.id))
        } catch { self.error = describe(error) }
    }

    /// A message row taken (a live event, my own pin, unpin or delete answered): the pins tabs follow it, written back
    /// only when it changed them, so that the rows of a page going by redraw nothing.
    private func takePinRow(_ message: MessageOut) {
        var lists = pinLists
        if lists.take(message) { pinLists = lists }
    }

    // MARK: custom emoji (M12f)

    /// The images being fetched. Not observed: `loadEmojiImage` runs inside a view's body (`CustomEmoji.text`'s
    /// `onNeed`), and a tracked write there invalidated the view being drawn, an AttributeGraph abort opening the
    /// threads list (TestFlight build 109, 2026-10-08).
    @ObservationIgnored private var emojiLoads: Set<String> = []

    /// M100: text emoji pills follow the app's light / dark look (RootView reports it through `appearanceChanged`).
    /// A change swaps the cached pills for the other look at once (both looks are drawn once and kept, see
    /// `CustomEmoji.textPill`), so no pill is left in the old look: build 95 cleared them and redrew them in a deferred
    /// task with the look captured before it, so a pill drawn across a change kept the old palette (2026-10-05).
    private(set) var textEmojiDark = false {
        didSet {
            guard textEmojiDark != oldValue else { return }
            for emoji in store.customEmoji.values where emoji.isText && store.emojiImages[emoji.id] != nil {
                store.emojiImages[emoji.id] = CustomEmoji.textPill(emoji, dark: textEmojiDark)
            }
        }
    }

    /// The look in effect (`dark`) and whether the scene is in the foreground. iOS draws a backgrounded app's
    /// app-switcher snapshot in the other look too, flipping the scene to it for a moment: the pills followed that
    /// flip and could stay dark in light mode (2026-10-05). Only an active scene's look counts; RootView reports again
    /// when the scene becomes active, so a change made while away (Control Center, the evening switch) is taken then.
    func appearanceChanged(dark: Bool, active: Bool) {
        if active { textEmojiDark = dark }
    }

    /// Fetches an emoji image once (scaled for inline text) into the store's cache. M100: a text emoji's pill is drawn
    /// here instead (no request), so every place that shows a custom emoji's image shows the pill.
    func loadEmojiImage(_ emoji: CustomEmojiOut) {
        if emoji.isText {
            guard store.emojiImages[emoji.id] == nil, !emojiLoads.contains(emoji.id) else { return }
            emojiLoads.insert(emoji.id)
            // Not while a view is being drawn (onNeed is called from body): the next turn of the main loop. The look
            // is read then, not now: it may change in between.
            Task { @MainActor in
                defer { emojiLoads.remove(emoji.id) }
                guard let current = store.customEmoji[emoji.name], current.id == emoji.id else { return }
                store.emojiImages[emoji.id] = CustomEmoji.textPill(current, dark: textEmojiDark)
            }
            return
        }
        guard let api, store.emojiImages[emoji.id] == nil, !emojiLoads.contains(emoji.id) else { return }
        emojiLoads.insert(emoji.id)
        Task {
            defer { emojiLoads.remove(emoji.id) }
            guard let data = try? await api.fetchData("/api/v1/emoji/\(emoji.id)/image"),
                  let decoded = await Task.detached(operation: { CustomEmoji.decode(data, pack: emoji.packId != nil) }).value else { return }
            if let animation = decoded.animation { store.emojiAnimations[emoji.id] = animation }
            store.emojiImages[emoji.id] = decoded.still
        }
    }

    /// M100: a pack's tab icon, once per version.
    func loadPackTab(_ pack: EmojiPackOut) {
        guard let api, let version = pack.tabVersion else { return }
        let key = "\(pack.id):\(version)"
        guard store.packTabImages[key] == nil, !emojiLoads.contains(key) else { return }
        emojiLoads.insert(key)
        Task {
            defer { emojiLoads.remove(key) }
            guard let data = try? await api.fetchData("/api/v1/emoji/packs/\(pack.id)/tab"),
                  let image = UIImage(data: data) else { return }
            store.packTabImages[key] = image
        }
    }

    // MARK: reminders (M12e)

    func setReminder(messageId: String, at: Date, note: String? = nil) async -> Bool {
        guard let api else { return false }
        do {
            let row = try await api.createReminder(messageId: messageId, remindAt: at, note: note)
            store.applyReminder(row)
            notice = tr("\(Schedule.label(at)) にリマインドします")
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
            notice = tr("\(Schedule.label(sendAt)) に送信します")
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
        copyToClipboard(url, notice: tr("リンクをコピーしました"))
    }

    /// 2026-10-08: what every copy button does. iOS says nothing when the pasteboard is written, so the app's toast says
    /// 「コピーしました」 (or what was copied: 「リンクをコピーしました」). A sheet that covers the toast shows its own
    /// 「コピーしました」 on the button instead (回復コード, AI の答え, カレンダーの購読 URL).
    func copyToClipboard(_ text: String, notice: String? = nil, pasteboard: UIPasteboard = .general) {
        pasteboard.string = text
        self.notice = notice ?? tr("コピーしました")
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
            error = following ? tr("スレッドをフォローできませんでした") : tr("スレッドのフォローを外せませんでした")
        }
    }

    /// M12a: a starred channel; the flag moves at once, favorite.updated confirms on every device.
    /// Starring takes it out of my section at once (DATA_MODEL.md sidebar_sections 「1 つの会話は 1 か所」; the server does
    /// the same and sidebar.updated confirms); a refusal puts both back.
    func toggleFavorite(_ channelId: String) async {
        guard let api else { return }
        let on = !store.isFavorite(channelId)
        let sections = store.sidebarSections
        store.setFavorite(channelId, on: on)
        if on, store.sectionOf(channelId) != nil {
            store.replaceSidebar(sections.map { section in
                var section = section
                section.channelIds.removeAll { $0 == channelId }
                return section
            })
        }
        do {
            if on { _ = try await api.favoriteChannel(id: channelId) } else { _ = try await api.unfavoriteChannel(id: channelId) }
        } catch {
            store.setFavorite(channelId, on: !on)
            if on { store.replaceSidebar(sections) }
            self.error = describe(error)
        }
    }

    /// M118 「上に固定」/「固定を外す」: the list moves at once and goes back if the server refuses; dm_pin.updated brings my
    /// other devices along.
    func setDmPinned(_ channelId: String, on: Bool) async {
        guard let api else { return }
        let place = store.dmPins.firstIndex(of: channelId)
        store.setDmPin(channelId, on: on)
        do {
            if on { _ = try await api.pinDm(id: channelId) } else { _ = try await api.unpinDm(id: channelId) }
        } catch {
            store.restoreDmPin(channelId, at: place)
            self.error = describe(error)
        }
    }

    /// M141 「会話を閉じる」 (SYNC_PROTOCOL.md §7.9): at once hidden from the DM lists, unpinned and read (as the server
    /// does), and taken off the screens it is on (`chikuwaCloseConversation`); all three go back if the server refuses.
    ///
    /// Review v0.1.43 #7: the rollback puts back only what the close touched (apps/shared/dm-close-rules.json): its own
    /// pin in its place (pins changed meanwhile stay), and the read state as the server has it (asked again with PUT read
    /// 0, which moves nothing; the snapshot only when that fails too and nothing changed it since), so a message or
    /// another device's read that came meanwhile stays.
    func closeDm(_ channelId: String) async {
        guard let api, let before = store.channel(channelId), before.channel.isDm else { return }
        let pinPlace = store.dmPins.firstIndex(of: channelId)
        store.setDmClosed(channelId, closed: true)
        store.setDmPin(channelId, on: false)
        store.updateChannel(channelId) { state in
            state.lastReadSeq = max(state.lastReadSeq, state.lastSeq)
            state.unreadCount = 0
            state.mentionCount = 0
            state.firstUnreadAt = nil
        }
        let optimistic = store.channel(channelId).map(Self.readMark)
        engine?.onBadge?(store.badgeCount)
        NotificationCenter.default.post(name: .chikuwaCloseConversation, object: nil, userInfo: ["id": channelId])
        do {
            _ = try await api.closeDm(id: channelId)
        } catch {
            store.setDmClosed(channelId, closed: false)
            if pinPlace != nil { store.restoreDmPin(channelId, at: pinPlace) }
            self.error = describe(error)
            do {
                store.setReadState(channelId, try await api.markRead(channelId: channelId, lastReadSeq: 0))
            } catch {
                print("could not read the read state back after a refused close: \(error)")
                if let optimistic, let now = store.channel(channelId),
                   DmCloseRules.readFallbackTakesSnapshot(optimistic: optimistic, now: Self.readMark(now)) {
                    store.updateChannel(channelId) { state in
                        state.lastReadSeq = before.lastReadSeq
                        state.unreadCount = before.unreadCount
                        state.mentionCount = before.mentionCount
                        state.firstUnreadAt = before.firstUnreadAt
                    }
                }
            }
            engine?.onBadge?(store.badgeCount)
        }
    }

    private static func readMark(_ state: ChannelState) -> DmCloseRules.ReadMark {
        DmCloseRules.ReadMark(lastSeq: state.lastSeq, lastReadSeq: state.lastReadSeq, unreadCount: state.unreadCount,
                              mentionCount: state.mentionCount)
    }

    /// M141 (§7.9): a closed DM opened explicitly (a search result, a profile's 「メッセージを送る」, a link, a
    /// notification) is open again at once; a failure is only logged (the next bootstrap closes it again).
    func reopenDmIfClosed(_ channelId: String) {
        guard store.isDmClosed(channelId) else { return }
        store.setDmClosed(channelId, closed: false)
        guard let api else { return }
        Task {
            do { _ = try await api.reopenDm(id: channelId) } catch { print("could not reopen the conversation: \(error)") }
        }
    }

    /// M104 「ブロック」/「ブロックを解除」 (MODERATION.md §4): the store flag moves at once, block.updated brings my other
    /// devices along. The blocked person is not told.
    func setUserBlocked(_ userId: String, on: Bool) async {
        guard let api else { return }
        let before = store.isBlocked(userId)
        store.setBlocked(userId, on: on)
        do {
            if on { _ = try await api.blockUser(id: userId) } else { _ = try await api.unblockUser(id: userId) }
            notice = on ? tr("ブロックしました") : tr("ブロックを解除しました")
        } catch {
            store.setBlocked(userId, on: before)
            self.error = describe(error)
        }
    }

    /// M104 「報告する」 (MODERATION.md §3): true when the server took it.
    func reportMessage(_ messageId: String, reason: String, note: String) async -> Bool {
        guard let api else { return false }
        do {
            let trimmed = note.trimmingCharacters(in: .whitespacesAndNewlines)
            _ = try await api.reportMessage(id: messageId, reason: reason, note: trimmed.isEmpty ? nil : trimmed)
            notice = tr("報告しました。管理者が確認します")
            return true
        } catch {
            self.error = describe(error)
            return false
        }
    }

    /// M119 「問題を報告・ご意見」/ プロフィールの「報告する」 (MODERATION.md §3.1). Returns the error to show in the form, or
    /// nil when the server took it (a resend with the same `client_report_id` gets the first report back).
    func submitReport(_ form: GeneralReportForm) async -> String? {
        guard let api else { return tr("ログインしていません") }
        do {
            _ = try await api.submitReport(form.body)
            return nil
        } catch {
            return describe(error)
        }
    }

    /// M104 「アカウントを削除」 (MODERATION.md §2): my password, or my username for an account without one. On success the
    /// server has ended every session and this workspace is signed out here. Returns the error to show, or nil.
    func deleteAccount(secret: String) async -> String? {
        guard let api, let serverUrl = activeServerUrl else { return tr("ログインしていません") }
        let hasPassword = (store.me ?? me)?.passwordSet ?? true
        do {
            try await api.deleteAccount(password: hasPassword ? secret : nil, confirmUsername: hasPassword ? nil : secret)
        } catch {
            return describe(error)
        }
        await signOutWorkspace(serverUrl)
        return nil
    }

    /// M12a 「すべて既読にする」.
    func markAllRead() async {
        guard let engine else { return }
        do { try await engine.markAllRead() } catch { self.error = describe(error) }
    }

    /// THREADS.md §3.2: 「スレッド」's 「すべて既読にする」 (every followed thread; the activity's own read is separate).
    func markAllThreadsRead() async {
        guard let engine else { return }
        do { try await engine.markAllThreadsRead() } catch { self.error = describe(error) }
    }

    /// L8 (TIMES_FEED.md §4): the Times feed's 「すべて既読にする」: only its channels (member, not muted) are read to
    /// their end; the rows apply like read.updated.
    func markTimesRead() async {
        guard let api, let engine else { return }
        do { engine.applyReadAll(try await api.readAll(scope: "times")) } catch { self.error = describe(error) }
    }

    /// L8: the feed's first page again (TimesFeedModel.refresh).
    func refreshTimesFeed() async {
        guard let api else { return }
        let store = store
        await timesFeed.refresh(fetch: { try await api.timesFeed(cursor: $0, limit: TimesFeedModel.pageSize) }, channel: { store.channel($0) })
    }

    func loadMoreTimesFeed() async {
        guard let api else { return }
        let store = store
        await timesFeed.loadMore(fetch: { try await api.timesFeed(cursor: $0, limit: TimesFeedModel.pageSize) }, channel: { store.channel($0) })
    }

    /// Review #8: a thread opened from the feed needs its parent. A feed row is one (ThreadView falls back to the feed);
    /// the parent of a reply also sent to the channel may be in neither the feed nor the store: it is fetched by id.
    func loadTimesFeedParent(channelId: String, parentId: String) async {
        guard let api, store.message(channelId, id: parentId) == nil, store.threads[parentId] == nil,
              timesFeed.parent(parentId) == nil else { return }
        do { timesFeed.keepParent(try await api.message(id: parentId)) } catch { self.error = describe(error) }
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

    // MARK: reservation pools (M99, M112, docs/RESERVATIONS.md §6)

    /// M112: a reservation notice while the app is open: the banner (the activity lists it too).
    func sayReservationNotice(_ notice: ReservationNotice) {
        guard !DND.isActive(currentMe?.asPublic) else { return }
        self.notice = "🎫 " + notice.text
    }

    /// A booking (start on the hour, `hours` long).
    @discardableResult
    func bookReservation(_ poolId: String, startAt: Date, hours: Int) async -> PoolOut? {
        await withPool { try await $0.bookReservation(poolId: poolId, startAt: ISO8601DateFormatter().string(from: startAt), hours: hours) }
    }

    /// 「延長」 by an hour.
    @discardableResult
    func extendReservation(_ reservationId: String) async -> PoolOut? {
        await withPool { try await $0.extendReservation(reservationId: reservationId) }
    }

    /// Runs one call that answers with the pool and puts it in the store; an error goes to the banner.
    @discardableResult
    func withPool(_ call: (ApiClient) async throws -> PoolOut) async -> PoolOut? {
        guard let api else { return nil }
        do {
            let pool = try await call(api)
            store.putReservationPool(pool)
            return pool
        } catch { self.error = describe(error); return nil }
    }

    /// 「今すぐ (順番待ち)」.
    @discardableResult
    func reservePool(_ poolId: String) async -> PoolOut? { await withPool { try await $0.reserve(poolId: poolId) } }

    /// cancel / return / assign / remove.
    @discardableResult
    func reservationAction(_ reservationId: String, _ action: String) async -> PoolOut? {
        await withPool { try await $0.reservationAction(reservationId: reservationId, action: action) }
    }

    /// 「入れ替えた」.
    @discardableResult
    func swapReservations(_ poolId: String, removeId: String, assignId: String) async -> PoolOut? {
        await withPool { try await $0.swapReservations(poolId: poolId, removeId: removeId, assignId: assignId) }
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
        notice = tr("共有しました")
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
                       presenceHidden: Bool? = nil, notificationDefault: String? = nil, notifyReactions: Bool? = nil,
                       quickReactions: [String]?? = nil, notifyTasks: Bool? = nil, navItems: [NavItem]?? = nil,
                       locale: String?? = nil, quiet: Bool = false) async -> Bool {
        guard let api else { return false }
        var fields: [String: JSONValue] = [:]
        if let locale { fields["locale"] = locale.map(JSONValue.string) ?? .null }
        if let navItems {  // M111
            fields["nav_items"] = navItems.map { list in .array(list.map { .object(["key": .string($0.key), "visible": .bool($0.visible)]) }) } ?? .null
        }
        if let notifyTasks { fields["notify_tasks"] = .bool(notifyTasks) }  // M56
        if let quickReactions { fields["quick_reactions"] = quickReactions.map { .array($0.map(JSONValue.string)) } ?? .null }  // M50
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
        } catch {
            // `quiet`: a background save that is tried again later (the language) shows only what will not pass then.
            if quiet, case ApiError.network = error { return false }
            self.error = describe(error); return false
        }
    }

    /// The quick status menu's 「解除」 and the settings' 「通知を再開」 (PRESENCE.md §11.1): the pause alone ends,
    /// `PATCH /users/me {dnd_until: null}`. 離席中 and 「在席を隠す」 chosen in the settings stay (`status: "auto"` would
    /// clear them too).
    func endMyPause() async -> Bool { await updateProfile(dndUntil: .some(nil)) }

    /// The reason the last refusal left for the toast, taken off it: a sheet shows it in its own line instead (the
    /// toast is drawn behind the sheet). nil when the last call left none.
    func takeError() -> String? {
        defer { error = nil }
        return error
    }

    /// PRESENCE.md §11: the quick status menu (PUT /users/me/presence). 取り込み中 sends its length and this device's
    /// zone; the answer replaces me (my other devices hear user.updated and read /users/me again). An older server
    /// answers 404: the reason is shown and nothing changes (the settings' 「通知を一時停止」 still works).
    func setMyPresence(_ choice: PresenceChoice, duration: DndDuration? = nil) async -> Bool {
        guard let api else { return false }
        do {
            let updated = try await api.setPresence(PresenceRules.requestBody(choice, duration: duration))
            me = updated
            store.setMe(updated)
            store.upsertUser(updated.asPublic)
            return true
        } catch {
            self.error = describe(error)
            return false
        }
    }

    /// Me with the newest public fields (PresenceRules.currentMe): what the DND checks of in-app notices read.
    var currentMe: UserMe? { store.currentMe ?? me }

    /// M50: the long-press quick reactions (nil: back to the recent-first rule), shown at once and taken back when the
    /// server refuses (the reason is shown). My other devices take it with their next bootstrap, as the other prefs.
    func setQuickReactions(_ list: [String]?) async -> Bool {
        guard let before = store.me else { return false }
        var shown = before
        shown.quickReactions = list.map(QuickReactionsSetting.chosen) ?? .unset
        store.setMe(shown)
        if await updateProfile(quickReactions: .some(list)) { return true }
        if store.me == shown { store.setMe(before) }
        return false
    }

    /// 自分 → 表示 → 言語 (nil: follow the device): the UI switches at once, here even offline; the server keeps it for
    /// my other devices (sent again with the next me while it has not taken it, `UILanguage.needsUpload`).
    func setLanguage(_ language: AppLanguage?) {
        if language != UILanguage.shared.choice { reopenLanguageSettings = true }
        UILanguage.shared.set(language)
        uploadLanguage()
    }

    /// `UserMe.locale` as it arrives (bootstrap, user.updated → /users/me, the cache): a choice not yet on the server
    /// is sent; otherwise the server's value (chosen on another device) is adopted.
    func languageSettingChanged(_ setting: LocaleSetting?) {
        guard case .value(let raw)? = setting else { return }
        let language = UILanguage.shared
        if language.needsUpload {
            if raw != language.choice?.rawValue { uploadLanguage() } else { language.needsUpload = false }
        } else if raw != language.choice?.rawValue {
            language.adoptServerValue(raw)
        }
    }

    private var languageUpload: Task<Void, Never>?
    private func uploadLanguage() {
        guard store.me?.locale.isSupported == true, languageUpload == nil else { return }
        languageUpload = Task { [weak self] in
            guard let self else { return }
            let choice = UILanguage.shared.choice
            let raw = choice?.rawValue
            if await self.updateProfile(locale: .some(raw), quiet: true), UILanguage.shared.choice == choice {
                UILanguage.shared.needsUpload = false
            }
            self.languageUpload = nil
            // Changed again while that was on its way.
            if UILanguage.shared.needsUpload, self.store.me?.locale != .value(UILanguage.shared.choice?.rawValue) { self.uploadLanguage() }
        }
    }

    /// M111: 「ホームのタイル」 (nil: back to the defaults), shown at once and taken back when the server refuses (the
    /// reason is shown). My other devices read it again when they hear user.updated about me (SyncEngine).
    func setNavItems(_ list: [NavItem]?) async -> Bool {
        guard let before = store.me else { return false }
        var shown = before
        shown.navItems = list.map(NavItemsSetting.chosen) ?? .unset
        store.setMe(shown)
        if await updateProfile(navItems: .some(list)) { return true }
        if store.me == shown { store.setMe(before) }
        return false
    }

    /// M39: the activity is read up to `readAt` (「すべて既読にする」). The badge takes the server's answer; my other
    /// devices follow through activity.read. Whether it went through (the reason is shown).
    func markActivityRead(_ readAt: String) async -> Bool {
        guard let engine else { return false }
        do {
            try await engine.markActivityRead(readAt)
            return true
        } catch { self.error = describe(error); return false }
    }

    /// 2026-10-07 (MOBILE_UI.md §6.4 「開いたら既読」): activity rows opened (tapped). Their dots go at once; the badge takes
    /// the server's answer; my other devices follow through activity.items_read. Rows without the server's id (a server
    /// before it) are left to the read position. Whether it went through (a failure is shown; the dot stays gone here,
    /// and the next list says what the server holds).
    @discardableResult
    func markActivityItemsRead(_ items: [ActivityItem]) async -> Bool {
        guard let engine else { return false }
        do {
            return try await engine.markActivityItemsRead(ActivityRules.openable(items))
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
        guard let api else { return (false, tr("サーバーに接続できません")) }
        do {
            let count = try await api.remindUnacknowledged(messageId: message.id)
            return (true, count > 0 ? tr("\(count) 人にリマインドしました") : tr("リマインド済みの人だけです"))
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

    /// M96: rename myself; nil when done, else the reason for under the field (taken, reserved, 3 times in 24 hours …).
    func renameMe(_ username: String) async -> String? {
        guard let api, let serverUrl = activeServerUrl else { return tr("ログインしていません") }
        do {
            let updated = try await api.updateUsername(username)
            me = updated
            store.setMe(updated)
            store.upsertUser(updated.asPublic)
            followUsername(updated.username, serverUrl: serverUrl)
            return nil
        } catch { return describe(error) }
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
        guard let api else { return tr("ログインしていません") }
        do { try await api.changePassword(current: current, new: new); return nil } catch { return describe(error) }
    }

    /// M40: my signed-in devices, this one first (the account screen's ログイン中の端末).
    func loadSessions() async throws -> [SessionOut] {
        guard let api else { throw ApiError.network(URLError(.notConnectedToInternet)) }
        return SessionList.ordered(try await api.sessions())
    }

    /// 「テスト通知を送る」 (PUSH_NOTIFICATIONS.md §15): the server pushes to every device of mine (this one too); the
    /// banner shows even with the app open (Workspaces.shouldPresent). Throws; the settings say why inline.
    func sendTestNotification() async throws -> TestNotificationOut {
        guard let api else { throw ApiError.network(URLError(.notConnectedToInternet)) }
        return try await api.sendTestNotification()
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
        let done = await sidebarChange { try await $0.createSidebarSection(name: name, emoji: emoji, channelIds: channelIds) }
        if done { leaveFavorites(channelIds) }
        return done
    }

    /// DATA_MODEL.md sidebar_sections 「1 つの会話は 1 か所」: a conversation put in one of my sections is no longer
    /// starred. The server unstarred it in the same change (favorite.updated confirms); the row moves here at once.
    private func leaveFavorites(_ channelIds: [String]) {
        for id in channelIds { store.setFavorite(id, on: false) }
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

    /// Which section a sort belongs to: one of mine (its id) or a default one ("favorites", "channels", "dms").
    enum SortTarget: Equatable {
        case section(String)
        case defaults(String)
    }

    /// DATA_MODEL.md sidebar_sections 「並べ替え」: a section's sort. 「手動」 starts from the order shown now (`shownIds`),
    /// so nothing jumps. Changes at once here; a refusal puts it back.
    func setSectionSort(_ target: SortTarget, sort: String, shownIds: [String]) async -> Bool {
        await applySort(target, sort: sort, manualOrder: sort == "manual" ? shownIds : nil)
    }

    /// The order made by hand (Edit mode's handles); the section stays 「手動」.
    func reorderSection(_ target: SortTarget, ids: [String]) async -> Bool {
        await applySort(target, sort: "manual", manualOrder: ids)
    }

    private func applySort(_ target: SortTarget, sort: String, manualOrder: [String]?) async -> Bool {
        switch target {
        case .section(let id):
            let before = store.sidebarSections
            store.replaceSidebar(before.map { section in
                var section = section
                if section.id == id {
                    section.sort = sort
                    if let manualOrder { section.manualOrder = manualOrder }
                }
                return section
            })
            let done = await sidebarChange { try await $0.updateSidebarSection(id, sort: sort, manualOrder: manualOrder) }
            if !done { store.replaceSidebar(before) }
            return done
        case .defaults(let key):
            let before = store.sidebarDefaults
            var row = store.defaultSort(key)
            row.sort = sort
            if let manualOrder { row.manualOrder = manualOrder }
            store.replaceSidebarDefaults(before.filter { $0.key != key } + [row])
            guard let api else { return false }
            do {
                store.replaceSidebarDefaults(try await api.updateSidebarDefault(key, sort: sort, manualOrder: manualOrder))
                return true
            } catch {
                store.replaceSidebarDefaults(before)
                self.error = describe(error)
                return false
            }
        }
    }

    /// `sectionId` nil puts the conversation back in the default sections.
    /// `sectionId` nil puts it back in the default sections; into a section it leaves お気に入り too.
    func moveToSection(_ channelId: String, sectionId: String?) async -> Bool {
        let done = await sidebarChange { api in
            if let sectionId { return try await api.placeInSidebarSection(sectionId, channelId: channelId) }
            return try await api.removeFromSidebarSection(channelId)
        }
        if done, sectionId != nil { leaveFavorites([channelId]) }
        return done
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

    // MARK: scheduling polls (M54, SCHEDULING.md)

    /// A scheduling poll: the candidates as UTC instants (or dates) and the device's zone, in which the server labels them.
    func createSchedulePoll(channelId: String, parentId: String?, question: String, slots: [SchedulePoll.SlotIn],
                            tz: String = CalendarDates.zoneId, anonymous: Bool = false) async -> Bool {
        guard let api else { return false }
        do {
            let message = try await api.postSchedulePoll(channelId: channelId, parentId: parentId, question: question, slots: slots,
                                                         tz: tz, anonymous: anonymous)
            if let engine { engine.postedFromHere(message) } else { store.upsertMessage(message) }
            return true
        } catch { self.error = describe(error); return false }
    }

    /// My ○ / △ / × for every candidate at once (nil = unanswered); `comment` nil keeps mine, "" removes it.
    func answerSchedule(_ message: MessageState, answers: [SchedulePoll.Answer?], comment: String? = nil) async -> Bool {
        guard let api else { return false }
        do {
            let answer = try await api.answerPoll(messageId: message.id, answers: answers,
                                                  comment: comment.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) })
            store.upsertMessage(answer)
            store.setMyVotes(answer) // my_answers / my_comment also when another member's event came first (§8)
            return true
        } catch { self.error = describe(error); return false }
    }

    enum DecideOutcome: Equatable {
        case decided
        /// 403 posting_restricted: I may decide, but not make the channel's event (SCHEDULING.md §7 3.); the card offers
        /// to decide without it.
        case eventRefused
        case failed
    }

    /// Decide a candidate: the server makes the channel's event (`createEvent`; never in a DM) and replies in the thread.
    func decideSchedule(_ message: MessageState, index: Int, createEvent: Bool = true) async -> DecideOutcome {
        guard let api else { return .failed }
        do {
            let answer = try await api.decidePoll(messageId: message.id, index: index, createEvent: createEvent)
            store.upsertMessage(answer)
            store.setMyVotes(answer)
            notice = tr("日程を決定しました")
            return .decided
        } catch {
            if createEvent, let refused = error as? ApiError, refused.code == "posting_restricted" { return .eventRefused }
            self.error = describe(error)
            return .failed
        }
    }

    /// Take the decision back: answering opens again; the event stays.
    func undecideSchedule(_ message: MessageState) async -> Bool {
        guard let api else { return false }
        do {
            let answer = try await api.undecidePoll(messageId: message.id)
            store.upsertMessage(answer)
            store.setMyVotes(answer)
            return true
        } catch { self.error = describe(error); return false }
    }

    /// The event a decision made (the card's 「予定を開く」): held, or from the server; nil when gone or hidden (the toast).
    func loadCalendarEvent(_ eventId: String) async -> CalendarEventOut? {
        do {
            if let hub = calendarHub { return try await hub.fetch(eventId) }
            guard let api else { return nil }
            return try await api.calendarEvent(id: eventId)
        } catch { self.error = describe(error); return nil }
    }

    // MARK: slash commands (M13b)

    /// Runs a command typed in the composer; false when it could not (the reason is in `error`).
    func runCommand(_ command: SlashCommands.Parsed, channelId: String, parentId: String?) async -> Bool {
        guard let api, let state = store.channels[channelId] else { return false }
        let isDm = state.channel.type == "dm" || state.channel.type == "group_dm"
        guard let spec = SlashCommands.all.first(where: { $0.name == command.name }) else {
            error = tr("/\(command.name) というコマンドはありません（/help で一覧）")
            return false
        }
        if spec.channelOnly && isDm { error = tr("/\(command.name) はチャンネルでだけ使えます"); return false }
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
                if ok { notice = tr("ステータスを消しました") }
                return ok
            }
            let parts = SlashCommands.splitStatus(command.args)
            let ok = await updateProfile(statusText: .some(parts.text.isEmpty ? nil : parts.text), statusEmoji: .some(parts.emoji), statusExpiresAt: .some(nil))
            if ok { notice = tr("ステータスを更新しました") }
            return ok
        case "dnd":
            if command.args.isEmpty || command.args == "off" {
                let ok = await updateProfile(dndUntil: .some(nil))
                if ok { notice = tr("通知の一時停止を解除しました") }
                return ok
            }
            guard let until = SlashCommands.duration(command.args) else { error = "/dnd 30m | 1h | 2h | 4h | tomorrow | off"; return false }
            let ok = await updateProfile(dndUntil: .some(iso.string(from: until)))
            if ok { notice = tr("\(Schedule.label(until)) まで通知を止めます") }
            return ok
        case "topic":
            return await updateTopic(channelId, topic: command.args) // false when refused: the composer keeps the text
        case "leave":
            _ = await leaveChannel(channelId)
            return true
        case "invite":
            let handles = command.args.split(separator: " ").map(String.init).filter { !$0.isEmpty }
            if handles.isEmpty { error = tr("/invite @名前"); return false }
            var targets: [String] = []
            for handle in handles {
                guard let target = user(handle) else { error = tr("\(handle) というユーザーはいません"); return false }
                if !targets.contains(target.id) { targets.append(target.id) }
            }
            // M89: one request (one 「追加しました」 line); 1 by 1 on a server before M88.
            do { _ = try await api.addMembers(channelId: channelId, userIds: targets) } catch { self.error = describe(error); return false }
            notice = tr("\(handles.count) 人を追加しました")
            return true
        case "join":
            let name = (command.args.hasPrefix("#") ? String(command.args.dropFirst()) : command.args).lowercased()
            guard let target = store.channels.values.first(where: { $0.channel.type == "public" && ($0.channel.name ?? "").lowercased() == name }) else {
                error = tr("#\(name) という公開チャンネルはありません")
                return false
            }
            if !target.isMember {
                do { store.upsertChannel(try await api.joinChannel(id: target.id), isMember: true) } catch { self.error = describe(error); return false }
            }
            PushCenter.shared.pendingChannelId = target.id
            return true
        case "dm":
            guard let target = user(command.args.split(separator: " ").first.map(String.init) ?? "") else { error = tr("/dm @名前"); return false }
            guard let id = await openDmWith(target.id) else { return false }
            PushCenter.shared.pendingChannelId = id
            return true
        case "mute":
            let until = command.args.isEmpty ? Date().addingTimeInterval(8 * 3600) : SlashCommands.duration(command.args)
            guard let until else { error = "/mute 1h | 8h | tomorrow"; return false }
            // The channel's own level goes back as it is (nil keeps it following the overall setting, M35).
            _ = await setTimedMute(state, until: until)
            notice = tr("\(Schedule.label(until)) まで通知を止めます")
            return true
        case "unmute":
            // Both mutes end (the timed one and M35's until unmuted); the level stays.
            _ = await setNotification(channelId, level: state.ownNotificationLevel, mutedUntil: nil, muted: false)
            notice = tr("通知を再開しました")
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
            guard parts.count >= 3 else { error = tr("/poll 質問 | 選択肢 | 選択肢 …"); return false }
            return await createPoll(channelId: channelId, parentId: parentId, question: parts[0], options: Array(parts.dropFirst()), multiple: false)
        case "日程":  // M54: a scheduling poll of the dates read (the composer opens the form with them instead, to check first) (i18n-ignore)
            let read = Templates.readSchedule(command.args, today: .today())
            let slots = read.map { SchedulePoll.slots(from: $0.entries) } ?? []
            guard let read, (SchedulePoll.minSlots...SchedulePoll.maxSlots).contains(slots.count) else {
                error = Templates.scheduleUsage
                return false
            }
            return await createSchedulePoll(channelId: channelId, parentId: parentId, question: read.question, slots: slots.map(SchedulePoll.slotIn))
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
            await engine?.wiki.flushAll() // M122: a page too
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
