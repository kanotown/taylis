import Foundation
import Observation

/// The server API the engine needs (implemented by ApiClient and by the test fake).
@MainActor
protocol SyncApi: AnyObject {
    func bootstrap() async throws -> BootstrapOut
    func history(channelId: String, beforeSeq: Int?, limit: Int) async throws -> HistoryOut
    func delta(channelId: String, sinceSeq: Int, limit: Int) async throws -> DeltaOut
    func postMessage(channelId: String, clientMsgId: String, body: String, parentId: String?, attachmentIds: [String], options: SendOptions) async throws -> (MessageOut, Bool)
    func publicChannels() async throws -> [ChannelOut]
    func markRead(channelId: String, lastReadSeq: Int) async throws -> ReadStateOut
    /// M12a: every channel read to its end; returns the new states.
    func readAll() async throws -> [ChannelReadStateOut]
    /// M12d: my pending scheduled messages.
    func listScheduled() async throws -> [ScheduledOut]
    /// M12e: my open reminders.
    func listReminders() async throws -> [ReminderOut]
    func setReadPosition(channelId: String, lastReadSeq: Int) async throws -> ReadStateOut
    func replies(messageId: String) async throws -> [MessageOut]
    /// THREADS.md §3.
    func threads(filter: String, cursor: String?, limit: Int) async throws -> ThreadListOut
    func threadState(messageId: String) async throws -> ThreadState
    func markThreadRead(messageId: String, lastReadSeq: Int) async throws -> ThreadState
    func setThreadFollow(messageId: String, following: Bool) async throws -> ThreadState
}

enum EngineStatus: String { case idle, connecting, online, offline, signedOut }

/// Extras for a send (they travel with the outbox so retries keep them).
struct SendOptions: Equatable {
    /// M15c: a thread reply also shown in the channel.
    var alsoInChannel = false
    /// M15e: top-level posts only.
    var priority: String? = nil
    var ackRequested = false
}

struct EngineOptions {
    var pageSize = 50
    var gapLimit = 5000
    var deltaLimit = 200
    var helloTimeout: TimeInterval = 10
    var reconnectMin: TimeInterval = 1
    var reconnectMax: TimeInterval = 30
    /// §5.3: ping interval; nil = what the server's hello says. The connection counts as dead once nothing has
    /// arrived for two intervals.
    var heartbeatInterval: TimeInterval? = nil
    /// §9: a send that failed for a temporary reason is retried after 2 s, 4 s … 30 s while connected.
    var outboxRetryMin: TimeInterval = 2
    var outboxRetryMax: TimeInterval = 30
    /// §10: read marks are debounced so scrolling does not spam the server.
    var readDebounce: TimeInterval = 1
    var threadPageSize = 50
    /// thread.updated bursts (one per reply) collapse into one list / badge refresh.
    var threadRefresh: TimeInterval = 0.3
    /// §5.2: typing frames go out at most this often per conversation; indicators expire after typingTtl.
    var typingInterval: TimeInterval = 3
    var typingTtl: TimeInterval = 5
    /// M15d: a draft is saved on the server this long after typing pauses.
    var draftSave: TimeInterval = 1
    var sleep: (TimeInterval) async -> Void = { seconds in try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000)) }
    var random: () -> Double = { Double.random(in: 0..<1) }
    var newId: () -> String = { UUID().uuidString.lowercased() }
    var now: () -> String = { ISO8601DateFormatter().string(from: Date()) }
}

/// The client side of SYNC_PROTOCOL.md (§5 heartbeat / reconnect, §7 start / catch_up / live,
/// §8 merge, §9 optimistic send). Same algorithm as the desktop engine; the reference client in
/// server/tests/contract_client.py is the spec.
@MainActor
@Observable
final class SyncEngine {
    private(set) var status: EngineStatus = .idle
    /// The conversation on screen. The one left (another opened, back to the list, a search result's conversation
    /// closed) is trimmed to the cap (§7.7), in the queue, unless it is shown again by then.
    var currentChannelId: String? {
        didSet { if let oldValue, oldValue != currentChannelId { trimLater(oldValue) } }
    }
    private(set) var catchUps = 0
    private(set) var reloads = 0
    private(set) var reconnects = 0
    let store: Store
    var onSignedOut: (() -> Void)?
    var onNotify: ((MessageOut, ChannelState) -> Void)?
    /// A channel became fully read (here or on another device): dismiss its notifications.
    var onRead: ((String) -> Void)?
    /// The app badge (unread DMs + mentions) changed.
    var onBadge: ((Int) -> Void)?
    private var pendingReads: [String: Task<Void, Never>] = [:]
    /// Channels marked unread by hand: visible-range marking pauses until the reader opens another one (§10).
    private(set) var unreadHold: [String: Int] = [:]
    /// The newest top-level post this device made through an endpoint of its own rather than the outbox (a poll, M14b):
    /// the conversation goes to it as to a pending post of mine (§10.1 11.).
    private(set) var postedHere: String?
    /// Thread read positions sent (or about to be) while the thread's state is not loaded yet.
    private var threadReadFloor: [String: Int] = [:]
    /// §10.2: parent id → channel id of the threads whose replies were all fetched since the channel's rows were last
    /// cleared. Only those take visible-range read marks: a partial thread (live replies only) would skip older unread ones.
    private(set) var completeThreads: [String: String] = [:]
    /// §7.7: views of a channel's rows (a thread, a conversation still on screen under the search sheet), counted per
    /// channel; the channel is not trimmed while any is shown.
    @ObservationIgnored private var views: [String: Int] = [:]
    private var threadRefreshTask: Task<Void, Never>?
    /// "channel[:parent]" → when the last typing frame went out.
    private var typingSent: [String: Date] = [:]
    var isActive: () -> Bool = { true }
    /// Runs before every connection (§7.2). `refresh` is true when the server refused the access token (close 4001),
    /// so it has to be renewed even if it looks valid; an auth error thrown here signs out.
    var prepareConnection: ((_ refresh: Bool) async throws -> Void)?

    private let api: SyncApi
    private let connect: WsConnector
    private let wsUrl: URL
    private let getAccessToken: () -> String?
    private let options: EngineOptions
    private var ws: WsTransport?
    private var chain: Task<Void, Never>?
    private var helloContinuation: CheckedContinuation<Bool, Never>?
    private var helloReceived = false
    /// Numbers the hello waits, so a stale timeout never cancels a later connection's wait.
    private var helloWait = 0
    private var heartbeatTask: Task<Void, Never>?
    private var watchdogTask: Task<Void, Never>?
    /// When the current connection last delivered any frame (§5.3).
    private var lastHeard = Date()
    /// The server refused the access token: renew it before the next connection (§5.3).
    private var refreshBeforeConnect = false
    private var reconnectPending = false
    private var stopped = false
    private var flushing = false
    private var flushAgain = false
    private var outboxRetryTask: Task<Void, Never>?
    private var outboxRetryAttempt = 0
    private var reconnectAttempt = 0
    /// M15d: my drafts across devices.
    @ObservationIgnored private(set) var drafts: DraftSync!

    /// error frame codes that mean the auth frame was refused (a close 4001 follows).
    private static let authRefusals: Set<String> = ["auth_required", "token_expired", "invalid_token", "session_revoked", "session_expired",
                                                    "password_change_required"]
    /// Key prefix of a thread's unsent read position in `Store.unsentReads` (and of its debounce task).
    private static let threadReadPrefix = "thread:"
    /// §7.7: a channel nobody looks at is trimmed back to the cap once live rows take it this far past it.
    private static let trimMargin = 100

    init(api: SyncApi, connect: @escaping WsConnector, wsUrl: URL, store: Store,
         getAccessToken: @escaping () -> String?, options: EngineOptions = EngineOptions()) {
        self.api = api
        self.connect = connect
        self.wsUrl = wsUrl
        self.store = store
        self.getAccessToken = getAccessToken
        self.options = options
        drafts = DraftSync(api: api as? DraftApi, store: store, isOnline: { [weak self] in self?.status == .online }, delay: options.draftSave)
        store.onDraftEdited = { [weak self] channelId, parentId in self?.drafts.edited(channelId, parentId: parentId) }
        store.onChannelRemoved = { [weak self] channelId in self?.channelRemoved(channelId) }
    }

    /// M15f: the conversation's link bar; loaded when it opens and after reconnecting (not in bootstrap).
    func loadLinks(_ channelId: String) async {
        guard let linksApi = api as? ChannelLinksApi else { return }
        if let links = try? await linksApi.channelLinks(channelId: channelId) { store.setChannelLinks(channelId, links) }
    }

    /// Save edited drafts now instead of after the typing pause (tests, sign-out).
    func flushDrafts() async { await drafts.flush() }

    // MARK: serial queue

    /// Runs `work` after everything already queued: frames and sync steps never interleave.
    @discardableResult
    private func enqueue(_ work: @escaping @MainActor () async throws -> Void) -> Task<Void, Error> {
        let previous = chain
        let task = Task<Void, Error> { @MainActor in
            await previous?.value
            try await work()
        }
        chain = Task { _ = try? await task.value }
        return task
    }

    /// Resolves once all queued frames / steps have been processed.
    func idle() async {
        await chain?.value
    }

    // MARK: §7.2 start, §7.5 reconnect

    func start() async {
        stopped = false
        await connectSocket()
    }

    func stop() {
        stopped = true
        clearTimers()
        ws?.close()
        ws = nil
        status = .idle
    }

    private func connectSocket() async {
        if stopped || status == .connecting || status == .online || status == .signedOut { return }
        status = .connecting
        let refresh = refreshBeforeConnect
        do { try await prepareConnection?(refresh) } catch {
            if let error = error as? ApiError, error.isAuth { signOut() } else { await scheduleReconnect() }
            return
        }
        if refresh { refreshBeforeConnect = false }
        if stopped { return }
        guard let token = getAccessToken() else {
            signOut()
            return
        }
        let socket: WsTransport
        do {
            socket = try await connect(wsUrl, token)
        } catch {
            await scheduleReconnect()
            return
        }
        if stopped {
            socket.close()
            return
        }
        ws = socket
        helloReceived = false
        socket.onMessage = { [weak self, weak socket] text in
            guard let self, let socket, self.ws === socket else { return } // a discarded connection says nothing
            self.onRaw(text)
        }
        socket.onClose = { [weak self, weak socket] code in
            guard let self, let socket else { return }
            self.handleClose(socket, code: code)
        }
        try? await socket.send(ClientFrame.auth(token: token))

        // §5.3: every await below may find this connection closed or replaced; it then gives up without
        // touching the status, and the close handler has already booked the one reconnect.
        let step = enqueue { [self] in
            guard ws === socket, await waitForHello(), ws === socket else { throw ApiError.network(URLError(.networkConnectionLost)) }
            // Frames that arrive from here on are queued behind this step (= buffered, §7.2).
            let bootstrap = try await api.bootstrap()
            guard ws === socket else { throw ApiError.network(URLError(.networkConnectionLost)) }
            applyBootstrap(bootstrap)
            await loadBrowsableChannels()
            if let current = currentChannelId, store.channel(current)?.isMember == true {
                do {
                    try await catchUp(current)
                } catch let error as ApiError where error.isRefused {
                    // Left or removed in the meantime (403 / 404): one conversation does not fail the connection.
                }
            }
            guard ws === socket else { throw ApiError.network(URLError(.networkConnectionLost)) }
            reconnectAttempt = 0
            status = .online
        }
        do {
            try await step.value
        } catch {
            if let apiError = error as? ApiError, apiError.isAuth {
                signOut()
                return
            }
            guard ws === socket else { return } // already closed: its close handler reconnects
            ws = nil
            clearTimers()
            socket.close()
            await scheduleReconnect()
            return
        }
        guard status == .online, ws === socket else { return }
        outboxRetryAttempt = 0
        Task { await flushOutbox() }
        Task { await resendReads() } // §10: marks that could not be sent before
        Task { await drafts.flush() } // edited while offline (M15d)
        // Open the conversation again: its links may have changed while away (M15f), and one opened while this
        // connection was starting (a tap during start-up) skipped its catch-up then; a synced one costs nothing.
        if let current = currentChannelId { Task { await openChannel(current) } }
    }

    private func waitForHello() async -> Bool {
        if helloReceived { return true } // the fake server answers auth synchronously
        helloWait += 1
        let wait = helloWait
        return await withCheckedContinuation { continuation in
            helloContinuation = continuation
            let timeout = options.helloTimeout
            Task { [weak self] in
                // A real clock on purpose: the injectable `sleep` (stubbed in tests) only paces reconnects.
                try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                guard let self, self.helloWait == wait else { return } // a later connection is waiting now
                self.resumeHello(false)
            }
        }
    }

    private func resumeHello(_ ok: Bool) {
        guard let continuation = helloContinuation else { return }
        helloContinuation = nil
        continuation.resume(returning: ok)
    }

    /// Exactly one reconnect at a time (§5.3): a failure while one is already booked only marks the status.
    private func scheduleReconnect() async {
        if stopped || status == .signedOut { return }
        status = .offline
        if reconnectPending { return }
        reconnectPending = true
        reconnectAttempt += 1
        reconnects += 1
        let base = min(options.reconnectMin * pow(2, Double(reconnectAttempt - 1)), options.reconnectMax)
        await options.sleep(base * (0.5 + options.random()))
        reconnectPending = false
        await connectSocket()
    }

    private func handleClose(_ socket: WsTransport, code: Int) {
        guard ws === socket else { return }
        ws = nil
        clearTimers()
        resumeHello(false) // a connection still waiting for hello gives up now
        if code == closeSessionRevoked {
            signOut()
            return
        }
        // §5.3: 4001 (auth frame too late, token refused) is no sign-out: renew the token, then reconnect.
        // Only a refresh the server rejects with 401 signs out (prepareConnection throws it).
        if code == closeAuthFailed { refreshBeforeConnect = true }
        if !stopped { Task { await scheduleReconnect() } }
    }

    private func signOut() {
        guard status != .signedOut else { return }
        stopped = true
        clearTimers()
        ws?.close()
        ws = nil
        status = .signedOut
        onSignedOut?()
    }

    /// Foreground / network change: skip the backoff.
    func reconnectNow() {
        if status == .offline, ws == nil { Task { await connectSocket() } }
        if status == .online, let current = currentChannelId, store.channel(current)?.isMember == true {
            enqueue { [self] in try await catchUp(current) }
        }
    }

    // MARK: frames

    private func onRaw(_ text: String) {
        lastHeard = Date() // §5.3: any frame shows the connection is alive
        guard let frame = ServerFrame.parse(text) else { return }
        switch frame {
        case .typing(let channelId, let parentId, let userId):
            // Volatile (SYNC_PROTOCOL.md §5.2): shown for a few seconds, never stored.
            if userId != store.me?.id { store.noteTyping(channelId, parentId: parentId, userId: userId, until: Date().addingTimeInterval(options.typingTtl)) }
        case .presence(let userId, let status):
            store.setPresence(userId, status: status)
        case .hello(_, let interval):
            helloReceived = true
            resumeHello(true)
            startHeartbeat(interval: options.heartbeatInterval ?? TimeInterval(max(interval, 1)))
            // The server counts a new connection as in use (PUSH_NOTIFICATIONS.md §4.1): one that is not (connected from
            // the background, for a push) says so at once, not a heartbeat later.
            if !isActive(), let ws { Task { try? await ws.send(ClientFrame.ping(active: false)) } }
        case .pong:
            break // counted above
        case .error(let code, _):
            // An auth failure is followed by close 4001; the reconnect renews the token first and only a refused
            // refresh signs out (§5.3). Nothing is decided on the frame alone.
            if Self.authRefusals.contains(code) { refreshBeforeConnect = true }
        case .event(let event):
            enqueue { [self] in try await applyEvent(event) }
        }
    }

    /// §5.3: a ping every interval, and the connection counts as dead once nothing (pong or any other frame) has
    /// arrived for two intervals. The deadline runs from the last frame received; pings never extend it, or a
    /// half-open socket would stay "online" for ever.
    private func startHeartbeat(interval: TimeInterval) {
        heartbeatTask?.cancel()
        watchdogTask?.cancel()
        lastHeard = Date()
        heartbeatTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
                guard let self, let ws = self.ws, !Task.isCancelled else { return }
                try? await ws.send(ClientFrame.ping(active: self.isActive()))
            }
        }
        let timeout = interval * 2
        watchdogTask = Task { [weak self] in
            var wait = timeout
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(max(wait, 0.001) * 1_000_000_000))
                guard let self, !Task.isCancelled else { return }
                wait = self.lastHeard.addingTimeInterval(timeout).timeIntervalSinceNow
                if wait <= 0 {
                    self.ws?.close() // its close handler reconnects
                    return
                }
            }
        }
    }

    private func clearTimers() {
        heartbeatTask?.cancel()
        watchdogTask?.cancel()
        threadRefreshTask?.cancel()
        outboxRetryTask?.cancel()
        heartbeatTask = nil
        watchdogTask = nil
        threadRefreshTask = nil
        outboxRetryTask = nil
    }

    private func applyBootstrap(_ bootstrap: BootstrapOut) {
        store.setMe(bootstrap.me)
        store.limits = bootstrap.limits
        for user in bootstrap.users { store.upsertUser(user) }
        var seen = Set<String>()
        for channel in bootstrap.channels {
            seen.insert(channel.id)
            store.upsertChannel(channel, isMember: true)
        }
        for channel in Array(store.channels.values) where channel.isMember && !seen.contains(channel.id) {
            store.removeChannel(channel.id) // no longer a member
        }
        reapplyUnsentReads()
        if let summary = bootstrap.threads { store.setThreadSummary(summary) }
        if store.threadsLoaded { scheduleThreadRefresh() } // the list may have moved while we were away
        store.replacePresence(bootstrap.presence ?? [])
        store.replaceBookmarks(bootstrap.bookmarks ?? [])
        store.replaceFavorites(bootstrap.favorites ?? [])
        store.replaceCustomEmoji(bootstrap.customEmoji ?? [])
        store.replaceGroups(bootstrap.groups ?? [])
        store.replaceRoster(bootstrap.roster ?? [])
        store.replaceSidebar(bootstrap.sidebarSections ?? [])
        drafts.applyBootstrap(bootstrap.drafts ?? [])
        Task { await self.loadScheduled() }
        Task { await self.loadReminders() }
        onBadge?(store.badgeCount)
    }

    /// The store dropped a conversation (left, removed, made private): it is no longer the open one, so the next
    /// connection does not try to catch it up (§7.6).
    private func channelRemoved(_ channelId: String) {
        if currentChannelId == channelId { currentChannelId = nil }
        forgetThreads(of: channelId)
        unreadHold[channelId] = nil
        pendingReads[channelId]?.cancel()
        pendingReads[channelId] = nil
        store.setUnsentRead(channelId, nil)
    }

    /// The composer changed: tell the other members, at most once per typingInterval per conversation.
    /// Tells the server now whether the reader is using this device (the app went to the background or came back),
    /// not at the next heartbeat: a phone in the background gets its pushes at once (PUSH_NOTIFICATIONS.md §4.1).
    func reportActivity() {
        guard status == .online, let ws else { return }
        let active = isActive()
        Task { try? await ws.send(ClientFrame.ping(active: active)) }
    }

    func sendTyping(_ channelId: String, parentId: String? = nil) {
        guard status == .online, let ws else { return }
        let key = parentId.map { "\(channelId):\($0)" } ?? channelId
        let now = Date()
        if let last = typingSent[key], now.timeIntervalSince(last) < options.typingInterval { return }
        typingSent[key] = now
        Task { try? await ws.send(ClientFrame.typing(channelId: channelId, parentId: parentId)) }
    }

    /// Public channels I am not a member of; bootstrap only lists my own channels.
    func loadBrowsableChannels() async {
        guard let listed = try? await api.publicChannels() else { return }
        let ids = Set(listed.map(\.id))
        for channel in listed where store.channel(channel.id) == nil {
            store.upsertChannel(channel, isMember: false)
        }
        for channel in Array(store.channels.values) where !channel.isMember && !ids.contains(channel.id) {
            store.removeChannel(channel.id)
        }
    }

    private func applyEvent(_ frame: EventFrame) async throws {
        switch frame.event {
        case "message.created", "message.updated", "message.deleted":
            try await applyTimelineEvent(frame)
        case "channel.created", "channel.updated":
            struct Payload: Decodable { let channel: ChannelOut; let memberIds: [String] }
            let payload = try frame.data.decode(Payload.self)
            let isMember = store.me.map { payload.memberIds.contains($0.id) } ?? false
            if isMember || payload.channel.type == "public" {
                store.upsertChannel(payload.channel, isMember: isMember)
            } else if store.channel(payload.channel.id) != nil {
                store.removeChannel(payload.channel.id) // made private while I am not a member (M15b)
            }
        case "channel.archived":
            if let id = frame.data["channel_id"]?.stringValue {
                store.updateChannel(id) { state in state.channel.archived = true }
            }
        case "channel.member_added":
            // M11h: keep the intro's member count current; the member list itself is loaded on demand.
            if let id = frame.data["channel_id"]?.stringValue {
                store.updateChannel(id) { state in if let count = state.channel.memberCount { state.channel.memberCount = count + 1 } }
            }
        case "channel.member_removed":
            if let me = store.me, frame.data["user_id"]?.stringValue == me.id, let id = frame.data["channel_id"]?.stringValue {
                store.removeChannel(id)
            } else if let id = frame.data["channel_id"]?.stringValue {
                store.updateChannel(id) { state in if let count = state.channel.memberCount { state.channel.memberCount = max(0, count - 1) } }
            }
        case "user.created", "user.updated", "user.deactivated":
            struct Payload: Decodable { let user: UserPublic }
            store.upsertUser(try frame.data.decode(Payload.self).user)
        case "read.updated":
            if let id = frame.data["channel_id"]?.stringValue {
                applyReadState(id, try frame.data.decode(ReadStateOut.self), allowDecrease: frame.data["reason"]?.stringValue == "set")
            }
        case "bookmark.updated":
            if let id = frame.data["message_id"]?.stringValue, case .bool(let on)? = frame.data["bookmarked"] {
                store.setBookmarked(id, on: on)
            }
        case "emoji.updated":
            struct Payload: Decodable { let emoji: CustomEmojiOut; let deleted: Bool }
            let payload = try frame.data.decode(Payload.self)
            store.applyCustomEmoji(payload.emoji, deleted: payload.deleted)
        case "channel.links_updated":
            struct Payload: Decodable { let channelId: String; let links: [ChannelLinkOut] }
            let payload = try frame.data.decode(Payload.self)
            store.setChannelLinks(payload.channelId, payload.links)
        case "draft.updated":
            drafts.applyEvent(try frame.data.decode(DraftUpdated.self))
        case "sidebar.updated":
            struct Payload: Decodable { let sections: [SidebarSectionOut] }
            store.replaceSidebar(try frame.data.decode(Payload.self).sections)
        case "group.updated":
            struct Payload: Decodable { let group: GroupOut; let deleted: Bool }
            let payload = try frame.data.decode(Payload.self)
            store.applyGroup(payload.group, deleted: payload.deleted)
        case "roster.updated":
            // M23: one line added, changed or removed (`profile` null = off the roster). The managed groups it moves
            // arrive on their own as group.updated.
            struct Payload: Decodable { let userId: String; let profile: LabProfileOut? }
            let payload = try frame.data.decode(Payload.self)
            store.applyRoster(payload.userId, payload.profile)
        case "reminder.updated":
            struct Payload: Decodable { let reminder: ReminderOut }
            let reminder = try frame.data.decode(Payload.self).reminder
            let before = store.reminders[reminder.id]?.status
            store.applyReminder(reminder)
            if reminder.status == "fired" && before != "fired" { onReminder?(reminder) }
            onBadge?(store.badgeCount)
        case "scheduled.updated":
            struct Payload: Decodable { let scheduled: ScheduledOut }
            store.applyScheduled(try frame.data.decode(Payload.self).scheduled)
        case "favorite.updated":
            if let id = frame.data["channel_id"]?.stringValue, case .bool(let on)? = frame.data["favorite"] {
                store.setFavorite(id, on: on)
            }
        case "thread.updated":
            // THREADS.md §4: the row (if held) takes the new state now; the badge and the open list are
            // refreshed from the server shortly after, which also covers threads we do not hold.
            applyThreadState(try frame.data.decode(ThreadState.self))
            onBadge?(store.badgeCount)
            scheduleThreadRefresh()
        case "notification_preference.updated":
            if let id = frame.data["channel_id"]?.stringValue {
                store.setNotification(id, level: frame.data["level"]?.stringValue ?? "mentions", mutedUntil: frame.data["muted_until"]?.stringValue)
            }
        case "session.revoked":
            signOut()
        default:
            break
        }
    }

    // MARK: §7.4 live timeline events

    private func applyTimelineEvent(_ frame: EventFrame) async throws {
        guard let channelId = frame.channelId, let seq = frame.seq, let channel = store.channel(channelId) else { return }
        struct Payload: Decodable { let message: MessageOut; let parentThread: ParentThread? }
        let payload = try frame.data.decode(Payload.self)
        let message = payload.message
        let thread = payload.parentThread
        let isNew = frame.event == "message.created"
        if isNew { noteActivity(message) }

        guard let synced = channel.syncedSeq else {
            // No timeline here: the list's numbers move, and rows already held (a thread opened from 「スレッド」,
            // its parent) take the change so that thread stays live (§7.4).
            if isHeld(message) { store.upsertMessage(message) }
            if let thread { store.applyParentThread(channelId, thread) }
            store.updateChannel(channelId) { $0.lastSeq = max($0.lastSeq, seq) }
            if isNew { countUnread(message); maybeNotify(message, channel, thread) }
            return
        }
        if seq == synced + 1 {
            store.upsertMessage(message)
            if let thread { store.applyParentThread(channelId, thread) }
            store.updateChannel(channelId) { $0.syncedSeq = seq; $0.lastSeq = max($0.lastSeq, seq) }
            if isNew { countUnread(message); maybeNotify(message, channel, thread) }
            trimIfFull(channelId)
        } else if seq > synced + 1 {
            store.updateChannel(channelId) { $0.lastSeq = max($0.lastSeq, seq) }
            try await catchUp(channelId)
            trimIfFull(channelId)
            if isNew { countUnread(message); maybeNotify(message, channel, thread) }
        }
        // seq <= synced: already applied.
    }

    /// The message itself is stored here, or it is a reply to a thread whose parent or replies are.
    private func isHeld(_ message: MessageOut) -> Bool {
        if store.message(message.channelId, id: message.id) != nil { return true }
        guard let parentId = message.parentId else { return false }
        return store.message(message.channelId, id: parentId) != nil || !store.replies(message.channelId, parentId: parentId).isEmpty
    }

    /// §7.4: a new message in the conversation (top-level, or a reply also sent there) moves it up the DM list.
    private func noteActivity(_ message: MessageOut) {
        guard message.parentId == nil || message.alsoInChannel,
              let current = store.channel(message.channelId), (current.channel.lastMessageAt ?? "") < message.createdAt else { return }
        store.updateChannel(message.channelId) { $0.channel.lastMessageAt = message.createdAt }
    }

    /// §7.4 / §10: someone else's message is unread until read.updated says otherwise. Counted as the server counts
    /// (§10.1 12.): rows from others, of type "user", in the timeline (top-level, or a reply also sent there, M15c).
    /// My own message moves nothing here (§10.1 11.): this device's send moves the position from its POST response
    /// (`readOwnPost`), a post from my other device is followed by the server's read.updated, and a scheduled send
    /// (M12d) reads nothing on the server either.
    private func countUnread(_ message: MessageOut) {
        store.clearTyping(message.channelId, parentId: message.parentId, userId: message.senderId) // their message arrived
        guard let me = store.me, MessageState(message).countsAsUnread(meId: me.id) else { return }
        store.updateChannel(message.channelId) { state in
            guard message.seq > state.lastReadSeq else { return }
            if state.unreadCount == 0 { state.firstUnreadAt = message.createdAt } // §10.1 8.
            state.unreadCount += 1
            if message.mentionsMe(me) { state.mentionCount += 1 }
        }
        onBadge?(store.badgeCount)
    }

    /// A post this device created through its own endpoint (a poll): stored, and read like a send from the outbox
    /// (§10.1 11.; the server reads the channel up to it the same way). Before, a poll left the position where it was
    /// and the conversation where the reader was, as if it came from another device (testers, 2026-09-29).
    func postedFromHere(_ message: MessageOut) {
        store.upsertMessage(message)
        if message.parentId == nil { postedHere = message.id }
        readOwnPost(message, created: true)
    }

    /// §10.1 11.: the server read the channel up to my top-level post inside the send transaction; this device mirrors it
    /// from the POST response, and the post ends a 「ここから未読にする」 hold. A reply (also sent to the channel or not)
    /// moves only its thread's position.
    /// - A retry that found the post already stored (`created` false) read nothing now: that commit's read.updated (or
    ///   the bootstrap) carried its position, and a mark-as-unread may have lowered it since. Only the hold ends.
    /// - Rows from others after my post (their events came before this response) stay unread: they are counted again
    ///   from the rows held when every one of them is, and otherwise left to the server's read.updated. Zeroing them
    ///   let the next visible mark skip unread rows never shown.
    private func readOwnPost(_ message: MessageOut, created: Bool) {
        guard message.parentId == nil else { return }
        unreadHold[message.channelId] = nil
        guard created else { return }
        store.updateChannel(message.channelId) { state in state.lastReadSeq = max(state.lastReadSeq, message.seq) }
        guard let state = store.channel(message.channelId) else { return }
        if state.lastReadSeq >= state.lastSeq {
            store.updateChannel(message.channelId) { $0.unreadCount = 0; $0.mentionCount = 0; $0.firstUnreadAt = nil }
        } else if ReadGate.covers(state.oldestLoadedSeq, state.lastReadSeq) && ReadGate.reachesNewest(state) {
            let held = heldUnread(message.channelId, after: state.lastReadSeq)
            store.updateChannel(message.channelId) { $0.unreadCount = held.count; $0.mentionCount = held.mentions; $0.firstUnreadAt = held.firstAt }
        }
        onBadge?(store.badgeCount)
    }

    /// The counts after `after` from the rows held, as the server counts them (§10.1 12.): someone else's user messages
    /// in the timeline. Right only while every timeline row after `after` is held.
    private func heldUnread(_ channelId: String, after: Int) -> (count: Int, mentions: Int, firstAt: String?) {
        let me = store.me
        let later = store.messages(channelId).filter { ($0.seq ?? 0) > after && $0.countsAsUnread(meId: me?.id) }
        // Mentions counted with the same rule as live events, notification keywords included (§7.4).
        let mentions = me.map { me in later.filter { $0.mentionAll || $0.mentionedUserIds.contains(me.id) || NotifyKeywords.matches($0.body, me.notifyKeywords) }.count } ?? 0
        return (later.count, mentions, later.first?.createdAt)
    }

    /// M12e: open reminders; refreshed after every bootstrap.
    func loadReminders() async {
        if let rows = try? await api.listReminders() { store.replaceReminders(rows) }
    }

    /// M12e: a reminder just fired while the app is open (the push covers the background case).
    var onReminder: ((ReminderOut) -> Void)?

    /// M12d: the pending scheduled messages; refreshed after every bootstrap (a reconnect may have missed events).
    func loadScheduled() async {
        if let rows = try? await api.listScheduled() { store.replaceScheduled(rows) }
    }

    /// 「すべて既読にする」 (M12a): the server moves every channel; the states apply like read.updated.
    func markAllRead() async throws {
        for row in try await api.readAll() {
            applyReadState(row.channelId, ReadStateOut(lastReadSeq: row.lastReadSeq, unreadCount: row.unreadCount, mentionCount: row.mentionCount,
                                                       firstUnreadAt: row.firstUnreadAt))
        }
        onBadge?(store.badgeCount)
    }

    private func applyReadState(_ channelId: String, _ state: ReadStateOut, allowDecrease: Bool = false) {
        guard store.channel(channelId) != nil else { return }
        // Advances merge with max (an event for an older PUT may arrive after a newer local mark);
        // a mark-as-unread (reason "set") moves the position down as well, and wins over a mark not sent yet.
        if allowDecrease || (store.unsentReads[channelId] ?? .max) <= state.lastReadSeq { store.setUnsentRead(channelId, nil) }
        store.updateChannel(channelId) {
            $0.lastReadSeq = allowDecrease ? state.lastReadSeq : max($0.lastReadSeq, state.lastReadSeq)
            $0.unreadCount = state.unreadCount
            $0.mentionCount = state.mentionCount
            $0.firstUnreadAt = state.firstUnreadAt
        }
        if state.unreadCount == 0 { onRead?(channelId) }
        onBadge?(store.badgeCount)
    }

    /// DMs always notify; channels when I am mentioned or take part in the thread (PUSH_NOTIFICATIONS.md §4).
    private func maybeNotify(_ message: MessageOut, _ channel: ChannelState, _ thread: ParentThread? = nil) {
        guard let me = store.me, message.senderId != me.id else { return }
        // Same rule as the server's PushPlanner: the per-channel level, "none" or a timed mute silences everything.
        let level = channel.channel.notification?.level ?? (channel.channel.isDm ? "all" : "mentions")
        if channel.isMuted { return }
        let involved = message.mentionsMe(me) || (thread?.participantIds.contains(me.id) ?? false)
        if level == "mentions" && !involved { return }
        if isActive() && currentChannelId == channel.id { return }
        onNotify?(message, channel)
    }

    /// Opening a thread: fetch its replies (live ones keep arriving as timeline events). True only when the fetch
    /// succeeded: the thread is then complete and takes visible-range read marks (§10.2).
    @discardableResult
    func loadReplies(_ channelId: String, parentId: String) async -> Bool {
        var loaded = false
        _ = try? await enqueue { [self] in
            guard status == .online else { return }
            for reply in try await api.replies(messageId: parentId) { store.upsertMessage(reply) }
            completeThreads[parentId] = channelId
            loaded = true
        }.value
        return loaded
    }

    /// §10.2: every reply of the thread has been fetched (live ones keep arriving after that).
    func threadComplete(_ parentId: String) -> Bool { completeThreads[parentId] != nil }

    /// The channel's local rows are gone (§7.3 reload, removed from it): its threads have to be fetched again.
    private func forgetThreads(of channelId: String) {
        guard completeThreads.values.contains(channelId) else { return }
        completeThreads = completeThreads.filter { $0.value != channelId }
    }

    // MARK: §7.7 the cap on held messages

    /// §7.7: a view of the channel's rows other than the open conversation (a thread) keeps them whole until the returned
    /// function releases it; only the first call releases, and the channel is trimmed then unless it is still shown.
    func viewing(_ channelId: String) -> @MainActor () -> Void {
        views[channelId, default: 0] += 1
        var released = false
        return { [weak self] in
            guard !released, let self else { return }
            released = true
            let left = (views[channelId] ?? 1) - 1
            if left > 0 {
                views[channelId] = left
            } else {
                views[channelId] = nil
                trimLater(channelId)
            }
        }
    }

    private func shown(_ channelId: String) -> Bool { channelId == currentChannelId || views[channelId] != nil }

    /// §7.7, in the queue: after any page still loading for the channel (a page landing after the trim would leave a gap).
    private func trimLater(_ channelId: String) {
        enqueue { [self] in trim(channelId) }
    }

    /// Live rows piling up in a channel nobody looks at: trimmed once they pass the cap by a margin (not on every row).
    private func trimIfFull(_ channelId: String) {
        if store.heldCount(channelId) > cachedMessagesPerChannel + Self.trimMargin { trim(channelId) }
    }

    /// Never on screen (§10.1 9.): checked when the queue gets here, as the channel may have been opened again meanwhile.
    private func trim(_ channelId: String) {
        guard !shown(channelId) else { return }
        // A thread whose older replies went is no longer complete (§10.2): opening it fetches them again.
        if store.trimMessages(channelId) { forgetThreads(of: channelId) }
    }

    // MARK: §7.3 catch_up

    /// No conversation is on screen any more (back to the channel list, or the threads / mentions / saved views): a
    /// 「ここから未読にする」 hold lasts only until its conversation is left (§10), and notifications cover every channel.
    func closeConversation() {
        currentChannelId = nil
        unreadHold = [:]
    }

    func openChannel(_ channelId: String) async {
        currentChannelId = channelId
        for held in unreadHold.keys where held != channelId { unreadHold[held] = nil }
        // A public channel I only browse has no timeline to catch up (its content needs membership).
        guard status == .online, store.channel(channelId)?.isMember == true else { return }
        Task { await loadLinks(channelId) }
        _ = try? await enqueue { [self] in
            guard let channel = store.channel(channelId), channel.isMember else { return }
            if channel.syncedSeq == nil || channel.oldestLoadedSeq == nil || (channel.syncedSeq ?? 0) < channel.lastSeq { try await catchUp(channelId) }
            // Only the visible timeline advances read state.
        }.value
    }

    /// §10: move the local position at once (monotonic), then PUT after a debounce; the server's answer wins.
    /// 「ここから未読にする」: seq - 1 becomes the position here and on the server (mode=set) at once. Returns the position
    /// visible-range reads are held at (nil when nothing happened).
    @discardableResult
    func markUnread(_ channelId: String, seq: Int) -> Int? {
        guard status == .online, seq >= 1, let channel = store.channel(channelId), channel.isMember else { return nil }
        // §10.1 10.: moving the position forward reads the rows before `seq`, and unread rows this device never loaded may
        // be among them. Nothing moves and nothing is sent; visible-range reads only pause where they are.
        guard ReadGate.markUnreadOffered(channel, seq: seq) else {
            unreadHold[channelId] = channel.lastReadSeq
            return channel.lastReadSeq
        }
        let target = seq - 1
        unreadHold[channelId] = target
        pendingReads[channelId]?.cancel()
        store.setUnsentRead(channelId, nil) // an advance not sent yet must not undo this
        let later = heldUnread(channelId, after: target)
        store.updateChannel(channelId) { state in
            state.lastReadSeq = target
            state.unreadCount = later.count
            state.mentionCount = later.mentions
            state.firstUnreadAt = later.firstAt
        }
        onBadge?(store.badgeCount)
        pendingReads[channelId] = Task { [weak self] in
            guard let self else { return }
            self.pendingReads[channelId] = nil
            guard let state = try? await self.api.setReadPosition(channelId: channelId, lastReadSeq: target) else { return }
            _ = try? await self.enqueue { [self] in self.applyReadState(channelId, state, allowDecrease: true) }.value
        }
        return target
    }

    /// Visible-range marks (`force` false) do nothing until every unread row is held (§10.1): the rows on screen may be
    /// the newest page of many more unread ones this device never loaded. Explicit reads (「既読にする」) always apply.
    func markRead(_ channelId: String, seq: Int, force: Bool = false) {
        guard status == .online, isActive() else { return }
        if force { unreadHold[channelId] = nil } else if unreadHold[channelId] != nil { return }
        guard let channel = store.channel(channelId), channel.isMember, seq > channel.lastReadSeq else { return }
        if !force && !ReadGate.readRangeReady(channel) { return }
        store.updateChannel(channelId) { state in
            state.lastReadSeq = seq
            if seq >= state.lastSeq { state.unreadCount = 0; state.mentionCount = 0; state.firstUnreadAt = nil }
        }
        store.setUnsentRead(channelId, seq) // kept until the server has it (§10)
        onBadge?(store.badgeCount)
        pendingReads[channelId]?.cancel()
        let options = self.options
        pendingReads[channelId] = Task { [weak self] in
            await options.sleep(options.readDebounce)
            guard let self, !Task.isCancelled else { return }
            self.pendingReads[channelId] = nil
            await self.sendRead(channelId)
        }
    }

    /// PUT the remembered position. A temporary failure keeps it for the next connection (§10); a refusal
    /// (left the conversation) drops it.
    private func sendRead(_ channelId: String) async {
        guard let target = store.unsentReads[channelId] else { return }
        let state: ReadStateOut
        do {
            state = try await api.markRead(channelId: channelId, lastReadSeq: target)
        } catch {
            if let apiError = error as? ApiError, apiError.isRefused { store.setUnsentRead(channelId, nil) }
            return
        }
        if (store.unsentReads[channelId] ?? 0) <= target { store.setUnsentRead(channelId, nil) }
        _ = try? await enqueue { [self] in self.applyReadState(channelId, state) }.value
    }

    /// §10: bootstrap's read state is the server's; a position this device reached but could not send yet goes on
    /// top of it again (optimistically, as when it was marked) and is resent once connected.
    private func reapplyUnsentReads() {
        for (key, seq) in store.unsentReads where !key.hasPrefix(Self.threadReadPrefix) {
            guard let channel = store.channel(key), channel.isMember, seq > channel.lastReadSeq else {
                store.setUnsentRead(key, nil) // gone, or the server is already there
                continue
            }
            store.updateChannel(key) { state in
                state.lastReadSeq = seq
                if seq >= state.lastSeq { state.unreadCount = 0; state.mentionCount = 0; state.firstUnreadAt = nil }
            }
        }
    }

    /// After connecting: the read marks (channels and threads) that could not be sent before.
    private func resendReads() async {
        for (key, seq) in store.unsentReads where pendingReads[key] == nil {
            if key.hasPrefix(Self.threadReadPrefix) {
                let parentId = String(key.dropFirst(Self.threadReadPrefix.count))
                threadReadFloor[parentId] = max(threadReadFloor[parentId] ?? 0, seq)
                await sendThreadRead(parentId)
            } else {
                await sendRead(key)
            }
        }
    }

    /// Waits for debounced read marks (tests).
    func flushReads() async {
        for task in Array(pendingReads.values) { await task.value }
        await idle()
    }

    // MARK: followed threads (THREADS.md §5)

    /// The threads view opens (or switches filter): fetch the first page; `more` appends the next one.
    func loadThreads(filter: String, more: Bool = false) async {
        _ = try? await enqueue { [self] in
            guard status == .online else { return }
            let cursor = more && store.threadsFilter == filter ? store.threadsCursor : nil
            if more && cursor == nil { return }
            let page = try await api.threads(filter: filter, cursor: cursor, limit: options.threadPageSize)
            let items = page.items.map { ThreadItem(parent: $0.parent, state: floored($0.state)) }
            store.setThreadPage(filter: filter, items: items, cursor: page.nextCursor, append: cursor != nil, pageSize: options.threadPageSize)
            store.setThreadSummary(page.summary)
            onBadge?(store.badgeCount)
        }.value
    }

    /// A thread opened from a channel: fetch my relation to it (follow flag, read position).
    func loadThreadState(_ parentId: String, parent: MessageOut? = nil) async {
        _ = try? await enqueue { [self] in
            guard status == .online else { return }
            applyThreadState(try await api.threadState(messageId: parentId), parent: parent)
        }.value
    }

    /// The reply with `seq` was shown: the thread position moves now (monotonic) and is sent after a debounce.
    /// Ignored until the whole thread has been fetched (§10.2).
    func markThreadRead(_ parentId: String, seq: Int) {
        guard status == .online, isActive(), threadComplete(parentId) else { return }
        let current = max(store.threads[parentId]?.state.lastReadSeq ?? 0, threadReadFloor[parentId] ?? 0)
        guard seq > current else { return }
        threadReadFloor[parentId] = seq
        if var state = store.threads[parentId]?.state {
            let newest = store.replies(state.channelId, parentId: parentId).compactMap(\.seq).max() ?? 0
            state.lastReadSeq = seq
            if seq >= newest { state.unreadCount = 0; state.mentionCount = 0 }
            store.applyThreadState(state)
            onBadge?(store.badgeCount)
        }
        let key = Self.threadReadPrefix + parentId
        store.setUnsentRead(key, seq) // kept until the server has it (§10)
        pendingReads[key]?.cancel()
        let options = self.options
        pendingReads[key] = Task { [weak self] in
            await options.sleep(options.readDebounce)
            guard let self, !Task.isCancelled else { return }
            self.pendingReads[key] = nil
            await self.sendThreadRead(parentId)
        }
    }

    private func sendThreadRead(_ parentId: String) async {
        let key = Self.threadReadPrefix + parentId
        guard let target = store.unsentReads[key] else { return }
        let state: ThreadState
        do {
            state = try await api.markThreadRead(messageId: parentId, lastReadSeq: target)
        } catch {
            if let apiError = error as? ApiError, apiError.isRefused { store.setUnsentRead(key, nil) }
            return
        }
        if (store.unsentReads[key] ?? 0) <= target { store.setUnsentRead(key, nil) }
        _ = try? await enqueue { [self] in
            self.applyThreadState(state) // the position reached here stays even when the server keeps none (not followed)
            self.onBadge?(self.store.badgeCount)
        }.value
    }

    func setThreadFollow(_ parentId: String, following: Bool) async {
        _ = try? await enqueue { [self] in
            guard status == .online else { return }
            applyThreadState(try await api.setThreadFollow(messageId: parentId, following: following))
            onBadge?(store.badgeCount)
        }.value
    }

    /// §10.2: a thread's state from the server (thread.updated, GET state, the threads list, the PUT read and follow
    /// responses) never takes its read position below what this device reached there, debounced or unsent PUTs
    /// included. An older position puts the first unread reply above the screen again: the open thread drops its anchor
    /// and replies already read show as unread.
    private func floored(_ state: ThreadState) -> ThreadState {
        guard let floor = threadReadFloor[state.parentId], floor > state.lastReadSeq else { return state }
        var state = state
        state.lastReadSeq = floor
        // As markThreadRead counts it: every reply held is read when the thread is complete.
        let newest = store.replies(state.channelId, parentId: state.parentId).compactMap(\.seq).max() ?? 0
        if threadComplete(state.parentId) && floor >= newest { state.unreadCount = 0; state.mentionCount = 0 }
        return state
    }

    private func applyThreadState(_ state: ThreadState, parent: MessageOut? = nil) {
        store.applyThreadState(floored(state), parent: parent)
    }

    private func scheduleThreadRefresh() {
        threadRefreshTask?.cancel()
        let options = self.options
        threadRefreshTask = Task { [weak self] in
            await options.sleep(options.threadRefresh)
            guard let self, !Task.isCancelled, self.status == .online else { return }
            await self.refreshThreads()
        }
    }

    /// Re-read the badge (and the open list) from the server; cheap, and always consistent.
    func refreshThreads() async {
        if store.threadsLoaded {
            await loadThreads(filter: store.threadsFilter)
        } else if let page = try? await api.threads(filter: "unread", cursor: nil, limit: 1) {
            store.setThreadSummary(page.summary)
            onBadge?(store.badgeCount)
        }
    }

    /// Waits for the debounced thread refresh and read marks (tests).
    func flushThreads() async {
        await threadRefreshTask?.value
        await flushReads()
    }

    func catchUp(_ channelId: String) async throws {
        catchUps += 1
        guard var channel = store.channel(channelId) else { return }
        // Far behind, or a timeline stored before its window was tracked: read the newest page again (§7.3).
        if let synced = channel.syncedSeq, channel.lastSeq - synced > options.gapLimit || channel.oldestLoadedSeq == nil {
            store.clearMessages(channelId)
            forgetThreads(of: channelId)
            store.updateChannel(channelId) { $0.syncedSeq = nil; $0.oldestLoadedSeq = nil; $0.hasOlder = true }
            channel = store.channel(channelId) ?? channel
            reloads += 1
        }
        guard var since = channel.syncedSeq else {
            let page = try await api.history(channelId: channelId, beforeSeq: nil, limit: options.pageSize)
            for message in page.messages { store.upsertMessage(message) }
            store.updateChannel(channelId) { state in
                state.syncedSeq = page.channelLastSeq
                state.lastSeq = max(state.lastSeq, page.channelLastSeq)
                state.hasOlder = page.hasMore && !page.messages.isEmpty
                state.oldestLoadedSeq = state.hasOlder ? page.messages.map(\.seq).min() : 0 // the window starts with this page
            }
            return
        }
        while true {
            let delta = try await api.delta(channelId: channelId, sinceSeq: since, limit: options.deltaLimit)
            for message in delta.messages { store.upsertMessage(message) }
            since = delta.nextSinceSeq
            store.updateChannel(channelId) { $0.syncedSeq = since; $0.lastSeq = max($0.lastSeq, since) }
            if !delta.hasMore { return }
        }
    }

    /// Scroll-up pagination (§7.3): the page before the window's first seq, which then grows by that page.
    /// Rows stored outside the window (older ones that arrived on their own) never serve as the cursor.
    func loadOlder(_ channelId: String) async {
        _ = try? await enqueue { [self] in
            guard status == .online else { return }
            guard let channel = store.channel(channelId), channel.isMember, channel.hasOlder, let oldest = channel.oldestLoadedSeq, oldest > 0 else { return }
            prepend(channelId, try await api.history(channelId: channelId, beforeSeq: oldest, limit: options.pageSize), before: oldest)
        }.value
    }

    /// A page read before the window's start joins the window: one rule for scrolling up and 「最初の未読へ」.
    private func prepend(_ channelId: String, _ page: HistoryOut, before oldest: Int) {
        for message in page.messages { store.upsertMessage(message) }
        store.updateChannel(channelId) { state in
            state.hasOlder = page.hasMore && !page.messages.isEmpty
            state.oldestLoadedSeq = state.hasOlder ? min(oldest, page.messages.map(\.seq).min() ?? oldest) : 0
        }
    }

    /// Visible-range marks may move the read position (§10.1).
    func readRangeReady(_ channelId: String) -> Bool { store.channel(channelId).map(ReadGate.readRangeReady) ?? false }

    /// 「最初の未読へ」 (§10.1 6.): pages backwards from the window's start, as scrolling up does, until every row after the
    /// read position (as it was when pressed) is held; at most jumpMaxPages pages per press, and a press again continues.
    /// Paging backwards keeps the one contiguous window, so nothing else changes. True when the range is held.
    func loadFirstUnread(_ channelId: String) async throws -> Bool {
        guard let target = store.channel(channelId)?.lastReadSeq else { return false } // when pressed, not when the queue gets to it
        var covered = false
        try await enqueue { [self] in
            var pages = 0
            while let channel = store.channel(channelId), !ReadGate.covers(channel.oldestLoadedSeq, target), channel.hasOlder,
                  let oldest = channel.oldestLoadedSeq, oldest > 0, pages < ReadGate.jumpMaxPages, status == .online, currentChannelId == channelId {
                prepend(channelId, try await api.history(channelId: channelId, beforeSeq: oldest, limit: ReadGate.jumpPageSize), before: oldest)
                pages += 1
            }
            covered = ReadGate.covers(store.channel(channelId)?.oldestLoadedSeq, target)
        }.value
        return covered
    }

    // MARK: §9 optimistic send

    func send(_ channelId: String, body: String, clientMsgId: String? = nil, parentId: String? = nil, attachmentIds: [String] = [],
              options sendOptions: SendOptions = SendOptions()) async {
        let clientMsgId = clientMsgId ?? options.newId()
        let createdAt = options.now()
        let shared = sendOptions.alsoInChannel && parentId != nil // M15c: only replies can also go to the channel
        let priority = parentId == nil ? sendOptions.priority : nil // M15e: top-level posts only
        let ackRequested = parentId == nil && sendOptions.ackRequested
        store.addOutbox(OutboxItem(clientMsgId: clientMsgId, channelId: channelId, body: body, createdAt: createdAt, failed: nil, parentId: parentId,
                                   attachmentIds: attachmentIds, alsoInChannel: shared ? true : nil, priority: priority,
                                   ackRequested: ackRequested ? true : nil))
        store.putPlaceholder(MessageState(placeholderFor: clientMsgId, channelId: channelId, senderId: store.me?.id ?? "", body: body, createdAt: createdAt,
                                          parentId: parentId, alsoInChannel: shared, priority: priority, ackRequested: ackRequested))
        await flushOutbox()
    }

    /// 「再送」 on one failed message: that message only (others stay failed until their own 再送).
    func retryFailed(_ clientMsgId: String) async {
        if store.outbox.contains(where: { $0.clientMsgId == clientMsgId && $0.failed != nil }) {
            store.markOutboxFailed(clientMsgId, reason: nil)
        }
        await flushOutbox()
    }

    func discardFailed(_ clientMsgId: String) {
        guard let item = store.outbox.first(where: { $0.clientMsgId == clientMsgId }) else { return }
        var tombstone = MessageState(placeholderFor: clientMsgId, channelId: item.channelId, senderId: "", body: "", createdAt: "")
        tombstone.clientMsgId = nil
        tombstone.updatedSeq = Int.max
        tombstone.deleted = true
        store.upsertMessage(tombstone)
        store.removeOutbox(clientMsgId)
    }

    /// Sends queued messages one at a time, in order (§9). The queue is read again for every item, so whatever is
    /// added meanwhile goes out in the same run. A refused item (4xx) stays as failed and the next one is tried;
    /// a temporary failure (429 / 5xx / network) pauses the queue until the backoff timer, while connected, or the
    /// next connection.
    func flushOutbox() async {
        if flushing {
            flushAgain = true
            return
        }
        guard status == .online else { return }
        flushing = true
        flushAgain = false
        var paused = false
        while status == .online, let item = store.outbox.first(where: { $0.failed == nil }) {
            do {
                let (message, created) = try await api.postMessage(channelId: item.channelId, clientMsgId: item.clientMsgId, body: item.body, parentId: item.parentId,
                                                             attachmentIds: item.attachmentIds,
                                                             options: SendOptions(alsoInChannel: item.alsoInChannel ?? false, priority: item.priority,
                                                                                  ackRequested: item.ackRequested ?? false))
                store.upsertMessage(message)
                store.removeOutbox(item.clientMsgId)
                readOwnPost(message, created: created)
                outboxRetryAttempt = 0
            } catch let error as ApiError where error.isRefused {
                store.markOutboxFailed(item.clientMsgId, reason: error.code) // persisted: still 「送信に失敗」 after a restart
            } catch {
                paused = true
                break
            }
        }
        flushing = false
        if paused {
            scheduleOutboxRetry()
        } else if flushAgain {
            await flushOutbox()
        }
    }

    /// §9: 2 s, 4 s … 30 s between attempts while connected; a new connection flushes the queue anyway.
    private func scheduleOutboxRetry() {
        guard status == .online, outboxRetryTask == nil else { return }
        outboxRetryAttempt += 1
        let delay = min(options.outboxRetryMin * pow(2, Double(outboxRetryAttempt - 1)), options.outboxRetryMax)
        outboxRetryTask = Task { [weak self] in
            // A real clock: the injectable `sleep` is stubbed in tests, and a stubbed timer would spin.
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard let self, !Task.isCancelled else { return }
            self.outboxRetryTask = nil
            await self.flushOutbox()
        }
    }
}
