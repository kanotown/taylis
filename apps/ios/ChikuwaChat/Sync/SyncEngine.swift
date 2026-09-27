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
    var currentChannelId: String?
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
    /// Thread read positions sent (or about to be) while the thread's state is not loaded yet.
    private var threadReadFloor: [String: Int] = [:]
    private var threadRefreshTask: Task<Void, Never>?
    /// "channel[:parent]" → when the last typing frame went out.
    private var typingSent: [String: Date] = [:]
    var isActive: () -> Bool = { true }
    var prepareConnection: (() async throws -> Void)?

    private let api: SyncApi
    private let connect: WsConnector
    private let wsUrl: URL
    private let getAccessToken: () -> String?
    private let options: EngineOptions
    private var ws: WsTransport?
    private var chain: Task<Void, Never>?
    private var helloContinuation: CheckedContinuation<Bool, Never>?
    private var helloReceived = false
    private var heartbeatTask: Task<Void, Never>?
    private var pongTask: Task<Void, Never>?
    private var stopped = false
    private var flushing = false
    private var reconnectAttempt = 0
    /// M15d: my drafts across devices.
    @ObservationIgnored private(set) var drafts: DraftSync!

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
        if stopped || status == .connecting || status == .online { return }
        status = .connecting
        do { try await prepareConnection?() } catch {
            if let error = error as? ApiError, error.isAuth { signOut() } else { await scheduleReconnect() }
            return
        }
        if stopped { return }
        guard let token = getAccessToken() else {
            signOut()
            return
        }
        status = .connecting
        let socket: WsTransport
        do {
            socket = try await connect(wsUrl, token)
        } catch {
            await scheduleReconnect()
            return
        }
        ws = socket
        helloReceived = false
        socket.onMessage = { [weak self] text in self?.onRaw(text) }
        socket.onClose = { [weak self] code in self?.handleClose(socket, code: code) }
        try? await socket.send(ClientFrame.auth(token: token))

        let step = enqueue { [self] in
            guard await waitForHello() else {
                socket.close()
                throw ApiError.network(URLError(.timedOut))
            }
            // Frames that arrive from here on are queued behind this step (= buffered, §7.2).
            let bootstrap = try await api.bootstrap()
            applyBootstrap(bootstrap)
            await loadBrowsableChannels()
            if let current = currentChannelId { try await catchUp(current) }
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
            socket.close()
            await scheduleReconnect()
            return
        }
        if status == .online {
            Task { await flushOutbox() }
            Task { await drafts.flush() } // edited while offline (M15d)
        }
    }

    private func waitForHello() async -> Bool {
        if helloReceived { return true } // the fake server answers auth synchronously
        return await withCheckedContinuation { continuation in
            helloContinuation = continuation
            let timeout = options.helloTimeout
            Task { [weak self] in
                // A real clock on purpose: the injectable `sleep` (stubbed in tests) only paces reconnects.
                try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                self?.resumeHello(false)
            }
        }
    }

    private func resumeHello(_ ok: Bool) {
        guard let continuation = helloContinuation else { return }
        helloContinuation = nil
        continuation.resume(returning: ok)
    }

    private func scheduleReconnect() async {
        if stopped || status == .signedOut { return }
        status = .offline
        reconnectAttempt += 1
        reconnects += 1
        let base = min(options.reconnectMin * pow(2, Double(reconnectAttempt - 1)), options.reconnectMax)
        await options.sleep(base * (0.5 + options.random()))
        await connectSocket()
    }

    private func handleClose(_ socket: WsTransport, code: Int) {
        guard ws === socket else { return }
        ws = nil
        clearTimers()
        if code == closeSessionRevoked || code == closeAuthFailed {
            signOut()
            return
        }
        if !stopped { Task { await scheduleReconnect() } }
    }

    private func signOut() {
        clearTimers()
        ws?.close()
        ws = nil
        status = .signedOut
        onSignedOut?()
    }

    /// Foreground / network change: skip the backoff.
    func reconnectNow() {
        if status == .offline, ws == nil { Task { await connectSocket() } }
        if status == .online, let current = currentChannelId { enqueue { [self] in try await catchUp(current) } }
    }

    // MARK: frames

    private func onRaw(_ text: String) {
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
            startHeartbeat(interval: TimeInterval(interval))
        case .pong:
            pongTask?.cancel()
            pongTask = nil
        case .error(let code, _):
            if ["invalid_token", "session_revoked", "session_expired", "password_change_required"].contains(code) { signOut() }
        case .event(let event):
            enqueue { [self] in try await applyEvent(event) }
        }
    }

    private func startHeartbeat(interval: TimeInterval) {
        clearTimers()
        heartbeatTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
                guard let self, let ws = self.ws, !Task.isCancelled else { return }
                try? await ws.send(ClientFrame.ping(active: self.isActive()))
                self.pongTask?.cancel()
                self.pongTask = Task {
                    try? await Task.sleep(nanoseconds: UInt64(interval * 2 * 1_000_000_000))
                    if !Task.isCancelled { ws.close() }
                }
            }
        }
    }

    private func clearTimers() {
        heartbeatTask?.cancel()
        pongTask?.cancel()
        threadRefreshTask?.cancel()
        heartbeatTask = nil
        pongTask = nil
        threadRefreshTask = nil
    }

    private func applyBootstrap(_ bootstrap: BootstrapOut) {
        store.setMe(bootstrap.me)
        for user in bootstrap.users { store.upsertUser(user) }
        var seen = Set<String>()
        for channel in bootstrap.channels {
            seen.insert(channel.id)
            store.upsertChannel(channel, isMember: true)
        }
        for channel in Array(store.channels.values) where channel.isMember && !seen.contains(channel.id) {
            store.removeChannel(channel.id) // no longer a member
        }
        if let summary = bootstrap.threads { store.setThreadSummary(summary) }
        if store.threadsLoaded { scheduleThreadRefresh() } // the list may have moved while we were away
        store.replacePresence(bootstrap.presence ?? [])
        store.replaceBookmarks(bootstrap.bookmarks ?? [])
        store.replaceFavorites(bootstrap.favorites ?? [])
        store.replaceCustomEmoji(bootstrap.customEmoji ?? [])
        store.replaceGroups(bootstrap.groups ?? [])
        store.replaceSidebar(bootstrap.sidebarSections ?? [])
        drafts.applyBootstrap(bootstrap.drafts ?? [])
        Task { await self.loadScheduled() }
        Task { await self.loadReminders() }
        onBadge?(store.badgeCount)
    }

    /// The composer changed: tell the other members, at most once per typingInterval per conversation.
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
        case "draft.updated":
            drafts.applyEvent(try frame.data.decode(DraftUpdated.self))
        case "sidebar.updated":
            struct Payload: Decodable { let sections: [SidebarSectionOut] }
            store.replaceSidebar(try frame.data.decode(Payload.self).sections)
        case "group.updated":
            struct Payload: Decodable { let group: GroupOut; let deleted: Bool }
            let payload = try frame.data.decode(Payload.self)
            store.applyGroup(payload.group, deleted: payload.deleted)
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
            store.applyThreadState(try frame.data.decode(ThreadState.self))
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

        guard let synced = channel.syncedSeq else {
            store.updateChannel(channelId) { $0.lastSeq = max($0.lastSeq, seq) }
            if isNew { countUnread(message); maybeNotify(message, channel, thread) }
            return
        }
        if seq == synced + 1 {
            store.upsertMessage(message)
            if let thread { store.applyParentThread(channelId, thread) }
            store.updateChannel(channelId) { $0.syncedSeq = seq; $0.lastSeq = max($0.lastSeq, seq) }
            if isNew { countUnread(message); maybeNotify(message, channel, thread) }
        } else if seq > synced + 1 {
            store.updateChannel(channelId) { $0.lastSeq = max($0.lastSeq, seq) }
            try await catchUp(channelId)
            if isNew { countUnread(message); maybeNotify(message, channel, thread) }
        }
        // seq <= synced: already applied.
    }

    /// §7.4 / §10: my own message is read; someone else's is unread until read.updated says otherwise.
    private func countUnread(_ message: MessageOut) {
        store.clearTyping(message.channelId, parentId: message.parentId, userId: message.senderId) // their message arrived
        guard let me = store.me else { return }
        if message.senderId == me.id {
            unreadHold[message.channelId] = nil // sending reads the conversation (the server does the same)
            store.updateChannel(message.channelId) { $0.lastReadSeq = max($0.lastReadSeq, message.seq); $0.unreadCount = 0; $0.mentionCount = 0 }
        } else if message.isReply && !message.alsoInChannel {
            return // replies are not unread items unless also sent to the channel (M15c)
        } else {
            store.updateChannel(message.channelId) { state in
                guard message.seq > state.lastReadSeq else { return }
                state.unreadCount += 1
                if message.mentions(me.id) { state.mentionCount += 1 }
            }
        }
        onBadge?(store.badgeCount)
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
            applyReadState(row.channelId, ReadStateOut(lastReadSeq: row.lastReadSeq, unreadCount: row.unreadCount, mentionCount: row.mentionCount))
        }
        onBadge?(store.badgeCount)
    }

    private func applyReadState(_ channelId: String, _ state: ReadStateOut, allowDecrease: Bool = false) {
        guard store.channel(channelId) != nil else { return }
        // Advances merge with max (an event for an older PUT may arrive after a newer local mark);
        // a mark-as-unread (reason "set") moves the position down as well.
        store.updateChannel(channelId) {
            $0.lastReadSeq = allowDecrease ? state.lastReadSeq : max($0.lastReadSeq, state.lastReadSeq)
            $0.unreadCount = state.unreadCount
            $0.mentionCount = state.mentionCount
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
        let involved = message.mentions(me.id) || (thread?.participantIds.contains(me.id) ?? false)
        if level == "mentions" && !involved { return }
        if isActive() && currentChannelId == channel.id { return }
        onNotify?(message, channel)
    }

    /// Opening a thread: fetch its replies (live ones keep arriving as timeline events).
    func loadReplies(_ channelId: String, parentId: String) async {
        _ = try? await enqueue { [self] in
            guard status == .online else { return }
            for reply in try await api.replies(messageId: parentId) { store.upsertMessage(reply) }
        }.value
    }

    // MARK: §7.3 catch_up

    func openChannel(_ channelId: String) async {
        currentChannelId = channelId
        for held in unreadHold.keys where held != channelId { unreadHold[held] = nil }
        guard status == .online else { return }
        _ = try? await enqueue { [self] in
            guard let channel = store.channel(channelId) else { return }
            if channel.syncedSeq == nil || (channel.syncedSeq ?? 0) < channel.lastSeq { try await catchUp(channelId) }
            // Only the visible timeline advances read state.
        }.value
    }

    /// §10: move the local position at once (monotonic), then PUT after a debounce; the server's answer wins.
    /// 「ここから未読にする」: seq - 1 becomes the position here and on the server (mode=set) at once.
    func markUnread(_ channelId: String, seq: Int) {
        guard status == .online, seq >= 1, let channel = store.channel(channelId), channel.isMember else { return }
        let target = seq - 1
        unreadHold[channelId] = target
        pendingReads[channelId]?.cancel()
        let me = store.me?.id
        let later = store.messages(channelId).filter { ($0.seq ?? 0) > target && $0.senderId != me }
        store.updateChannel(channelId) { state in
            state.lastReadSeq = target
            state.unreadCount = later.count
            state.mentionCount = later.filter { message in me.map { message.mentionAll || message.mentionedUserIds.contains($0) } ?? false }.count
        }
        onBadge?(store.badgeCount)
        pendingReads[channelId] = Task { [weak self] in
            guard let self else { return }
            self.pendingReads[channelId] = nil
            guard let state = try? await self.api.setReadPosition(channelId: channelId, lastReadSeq: target) else { return }
            _ = try? await self.enqueue { [self] in self.applyReadState(channelId, state, allowDecrease: true) }.value
        }
    }

    func markRead(_ channelId: String, seq: Int, force: Bool = false) {
        guard status == .online, isActive() else { return }
        if force { unreadHold[channelId] = nil } else if unreadHold[channelId] != nil { return }
        guard let channel = store.channel(channelId), channel.isMember, seq > channel.lastReadSeq else { return }
        store.updateChannel(channelId) { state in
            state.lastReadSeq = seq
            if seq >= state.lastSeq { state.unreadCount = 0; state.mentionCount = 0 }
        }
        onBadge?(store.badgeCount)
        pendingReads[channelId]?.cancel()
        let options = self.options
        pendingReads[channelId] = Task { [weak self] in
            await options.sleep(options.readDebounce)
            guard let self, !Task.isCancelled else { return }
            self.pendingReads[channelId] = nil
            let target = self.store.channel(channelId)?.lastReadSeq ?? seq
            guard let state = try? await self.api.markRead(channelId: channelId, lastReadSeq: target) else { return }
            _ = try? await self.enqueue { [self] in self.applyReadState(channelId, state) }.value
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
            store.setThreadPage(filter: filter, items: page.items, cursor: page.nextCursor, append: cursor != nil, pageSize: options.threadPageSize)
            store.setThreadSummary(page.summary)
            onBadge?(store.badgeCount)
        }.value
    }

    /// A thread opened from a channel: fetch my relation to it (follow flag, read position).
    func loadThreadState(_ parentId: String, parent: MessageOut? = nil) async {
        _ = try? await enqueue { [self] in
            guard status == .online else { return }
            var state = try await api.threadState(messageId: parentId)
            if let floor = threadReadFloor[parentId], floor > state.lastReadSeq { state.lastReadSeq = floor }
            store.applyThreadState(state, parent: parent)
        }.value
    }

    /// The reply with `seq` was shown: the thread position moves now (monotonic) and is sent after a debounce.
    func markThreadRead(_ parentId: String, seq: Int) {
        guard status == .online, isActive() else { return }
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
        let key = "thread:" + parentId
        pendingReads[key]?.cancel()
        let options = self.options
        pendingReads[key] = Task { [weak self] in
            await options.sleep(options.readDebounce)
            guard let self, !Task.isCancelled else { return }
            self.pendingReads[key] = nil
            let target = self.threadReadFloor[parentId] ?? seq
            guard let state = try? await self.api.markThreadRead(messageId: parentId, lastReadSeq: target) else { return }
            _ = try? await self.enqueue { [self] in
                self.store.applyThreadState(state)
                self.onBadge?(self.store.badgeCount)
            }.value
        }
    }

    func setThreadFollow(_ parentId: String, following: Bool) async {
        _ = try? await enqueue { [self] in
            guard status == .online else { return }
            store.applyThreadState(try await api.setThreadFollow(messageId: parentId, following: following))
            onBadge?(store.badgeCount)
        }.value
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
        if let synced = channel.syncedSeq, channel.lastSeq - synced > options.gapLimit {
            store.clearMessages(channelId)
            store.updateChannel(channelId) { $0.syncedSeq = nil; $0.hasOlder = true }
            channel = store.channel(channelId) ?? channel
            reloads += 1
        }
        guard var since = channel.syncedSeq else {
            let page = try await api.history(channelId: channelId, beforeSeq: nil, limit: options.pageSize)
            for message in page.messages { store.upsertMessage(message) }
            store.updateChannel(channelId) { state in
                state.syncedSeq = page.channelLastSeq
                state.lastSeq = max(state.lastSeq, page.channelLastSeq)
                state.hasOlder = page.hasMore
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

    /// Scroll-up pagination: older messages by seq cursor.
    func loadOlder(_ channelId: String) async {
        _ = try? await enqueue { [self] in
            guard status == .online else { return }
            guard let channel = store.channel(channelId), channel.hasOlder else { return }
            let oldest = store.messages(channelId).compactMap(\.seq).first
            let page = try await api.history(channelId: channelId, beforeSeq: oldest, limit: options.pageSize)
            for message in page.messages { store.upsertMessage(message) }
            store.updateChannel(channelId) { $0.hasOlder = page.hasMore }
        }.value
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

    func retryFailed() async {
        for item in store.outbox where item.failed != nil { store.markOutboxFailed(item.clientMsgId, reason: nil) }
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

    /// Sends queued messages one at a time, in order (§9). Stops on temporary failures.
    func flushOutbox() async {
        if flushing || status != .online { return }
        flushing = true
        defer { flushing = false }
        for item in store.outbox where item.failed == nil {
            do {
                let (message, _) = try await api.postMessage(channelId: item.channelId, clientMsgId: item.clientMsgId, body: item.body, parentId: item.parentId,
                                                             attachmentIds: item.attachmentIds,
                                                             options: SendOptions(alsoInChannel: item.alsoInChannel ?? false, priority: item.priority,
                                                                                  ackRequested: item.ackRequested ?? false))
                store.upsertMessage(message)
                store.removeOutbox(item.clientMsgId)
            } catch {
                if let apiError = error as? ApiError, !apiError.isRetryable {
                    store.markOutboxFailed(item.clientMsgId, reason: apiError.code)
                    continue
                }
                return // resume after reconnect / next send
            }
        }
    }
}
