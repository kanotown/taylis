import Foundation
import Observation

/// The server API the engine needs (implemented by ApiClient and by the test fake).
@MainActor
protocol SyncApi: AnyObject {
    func bootstrap() async throws -> BootstrapOut
    func history(channelId: String, beforeSeq: Int?, limit: Int) async throws -> HistoryOut
    func delta(channelId: String, sinceSeq: Int, limit: Int) async throws -> DeltaOut
    func postMessage(channelId: String, clientMsgId: String, body: String) async throws -> (MessageOut, Bool)
    func publicChannels() async throws -> [ChannelOut]
    func markRead(channelId: String, lastReadSeq: Int) async throws -> ReadStateOut
}

enum EngineStatus: String { case idle, connecting, online, offline, signedOut }

struct EngineOptions {
    var pageSize = 50
    var gapLimit = 5000
    var deltaLimit = 200
    var helloTimeout: TimeInterval = 10
    var reconnectMin: TimeInterval = 1
    var reconnectMax: TimeInterval = 30
    /// §10: read marks are debounced so scrolling does not spam the server.
    var readDebounce: TimeInterval = 1
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
    var isActive: () -> Bool = { true }

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

    init(api: SyncApi, connect: @escaping WsConnector, wsUrl: URL, store: Store,
         getAccessToken: @escaping () -> String?, options: EngineOptions = EngineOptions()) {
        self.api = api
        self.connect = connect
        self.wsUrl = wsUrl
        self.store = store
        self.getAccessToken = getAccessToken
        self.options = options
    }

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
        if status == .online { Task { await flushOutbox() } }
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
        heartbeatTask = nil
        pongTask = nil
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
        onBadge?(store.badgeCount)
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
            if isMember || payload.channel.type == "public" { store.upsertChannel(payload.channel, isMember: isMember) }
        case "channel.archived":
            if let id = frame.data["channel_id"]?.stringValue {
                store.updateChannel(id) { state in
                    state.channel = ChannelOut(id: state.channel.id, type: state.channel.type, name: state.channel.name, topic: state.channel.topic,
                                               purpose: state.channel.purpose, archived: true, createdBy: state.channel.createdBy, lastSeq: state.channel.lastSeq,
                                               lastMessageAt: state.channel.lastMessageAt, createdAt: state.channel.createdAt, updatedAt: state.channel.updatedAt,
                                               membership: state.channel.membership, dmUserIds: state.channel.dmUserIds)
                }
            }
        case "channel.member_removed":
            if let me = store.me, frame.data["user_id"]?.stringValue == me.id, let id = frame.data["channel_id"]?.stringValue { store.removeChannel(id) }
        case "user.created", "user.updated", "user.deactivated":
            struct Payload: Decodable { let user: UserPublic }
            store.upsertUser(try frame.data.decode(Payload.self).user)
        case "read.updated":
            if let id = frame.data["channel_id"]?.stringValue { applyReadState(id, try frame.data.decode(ReadStateOut.self)) }
        case "session.revoked":
            signOut()
        default:
            break
        }
    }

    // MARK: §7.4 live timeline events

    private func applyTimelineEvent(_ frame: EventFrame) async throws {
        guard let channelId = frame.channelId, let seq = frame.seq, let channel = store.channel(channelId) else { return }
        struct Payload: Decodable { let message: MessageOut }
        let message = try frame.data.decode(Payload.self).message
        let isNew = frame.event == "message.created"

        guard let synced = channel.syncedSeq else {
            store.updateChannel(channelId) { $0.lastSeq = max($0.lastSeq, seq) }
            if isNew { countUnread(message); maybeNotify(message, channel) }
            return
        }
        if seq == synced + 1 {
            store.upsertMessage(message)
            store.updateChannel(channelId) { $0.syncedSeq = seq; $0.lastSeq = max($0.lastSeq, seq) }
            if isNew { countUnread(message); maybeNotify(message, channel) }
        } else if seq > synced + 1 {
            store.updateChannel(channelId) { $0.lastSeq = max($0.lastSeq, seq) }
            try await catchUp(channelId)
            if isNew { countUnread(message); maybeNotify(message, channel) }
        }
        // seq <= synced: already applied.
    }

    /// §7.4 / §10: my own message is read; someone else's is unread until read.updated says otherwise.
    private func countUnread(_ message: MessageOut) {
        guard let me = store.me else { return }
        if message.senderId == me.id {
            store.updateChannel(message.channelId) { $0.lastReadSeq = max($0.lastReadSeq, message.seq); $0.unreadCount = 0; $0.mentionCount = 0 }
        } else {
            store.updateChannel(message.channelId) { state in
                guard message.seq > state.lastReadSeq else { return }
                state.unreadCount += 1
                if message.mentions(me.id) { state.mentionCount += 1 }
            }
        }
        onBadge?(store.badgeCount)
    }

    private func applyReadState(_ channelId: String, _ state: ReadStateOut) {
        guard store.channel(channelId) != nil else { return }
        store.updateChannel(channelId) {
            $0.lastReadSeq = max($0.lastReadSeq, state.lastReadSeq)
            $0.unreadCount = state.unreadCount
            $0.mentionCount = state.mentionCount
        }
        if state.unreadCount == 0 { onRead?(channelId) }
        onBadge?(store.badgeCount)
    }

    /// DMs always notify; channels only when I am mentioned (PUSH_NOTIFICATIONS.md §4 defaults).
    private func maybeNotify(_ message: MessageOut, _ channel: ChannelState) {
        guard let me = store.me, message.senderId != me.id else { return }
        if !channel.channel.isDm && !message.mentions(me.id) { return }
        if isActive() && currentChannelId == channel.id { return }
        onNotify?(message, channel)
    }

    // MARK: §7.3 catch_up

    func openChannel(_ channelId: String) async {
        currentChannelId = channelId
        _ = try? await enqueue { [self] in
            guard let channel = store.channel(channelId) else { return }
            if channel.syncedSeq == nil || (channel.syncedSeq ?? 0) < channel.lastSeq { try await catchUp(channelId) }
            markRead(channelId, seq: store.channel(channelId)?.lastSeq ?? channel.lastSeq)
        }.value
    }

    /// §10: move the local position at once (monotonic), then PUT after a debounce; the server's answer wins.
    func markRead(_ channelId: String, seq: Int) {
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
            guard let channel = store.channel(channelId), channel.hasOlder else { return }
            let oldest = store.messages(channelId).compactMap(\.seq).first
            let page = try await api.history(channelId: channelId, beforeSeq: oldest, limit: options.pageSize)
            for message in page.messages { store.upsertMessage(message) }
            store.updateChannel(channelId) { $0.hasOlder = page.hasMore }
        }.value
    }

    // MARK: §9 optimistic send

    func send(_ channelId: String, body: String, clientMsgId: String? = nil) async {
        let clientMsgId = clientMsgId ?? options.newId()
        let createdAt = options.now()
        store.addOutbox(OutboxItem(clientMsgId: clientMsgId, channelId: channelId, body: body, createdAt: createdAt, failed: nil))
        store.putPlaceholder(MessageState(placeholderFor: clientMsgId, channelId: channelId, senderId: store.me?.id ?? "", body: body, createdAt: createdAt))
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
        if flushing { return }
        flushing = true
        defer { flushing = false }
        for item in store.outbox where item.failed == nil {
            do {
                let (message, _) = try await api.postMessage(channelId: item.channelId, clientMsgId: item.clientMsgId, body: item.body)
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
