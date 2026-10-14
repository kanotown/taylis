import Foundation

/// How a share ended for now.
enum ShareOutcome: Equatable {
    /// The message is posted (or was already: the same `client_msg_id`); the share is gone.
    case posted
    /// Kept: it is sent again when the app next starts or comes to the front.
    case pending(ShareFailure)
    /// Given up (the server refused it); the share is gone.
    case failed(ShareFailure)
    /// Another process is sending it right now.
    case busy
}

/// One upload task's end.
struct ShareUploadResult {
    var shareId: String
    var index: Int
    /// The HTTP status; 0 without an answer.
    var status: Int
    var data: Data
    var failedToConnect: Bool
}

/// Runs the uploads of a share. The real one is a background URLSession per share (BackgroundShareTransport); tests
/// use their own.
protocol ShareUploadTransport: AnyObject, Sendable {
    var onFinished: ((ShareUploadResult) -> Void)? { get set }
    var onProgress: ((String, Int, Int64) -> Void)? { get set }
    /// The items of the share whose upload still runs (started by this process or by one that ended).
    func running(shareId: String) async -> Set<Int>
    func start(shareId: String, index: Int, request: URLRequest, body: URL)
    /// This process lets the share go: running uploads go on in the system, and their end wakes the app.
    func detach(shareId: String)
}

/// Sends pending shares (MOBILE_UI.md §21.4): uploads every file of a share through POST /attachments (multipart
/// bodies on disk, uploaded by a background session so they go on after the share sheet closes), then posts one
/// message with the text and the attachment ids and the share's `client_msg_id`. The same code runs in the Share
/// Extension (right after 送信) and in the app (woken by the finished background uploads, and at every start and
/// return to the front for anything left), each holding the share's claim lock while it sends.
actor ShareProcessor {
    static let shared: ShareProcessor? = PendingShareStore.shared.map { ShareProcessor(store: $0, transport: BackgroundShareTransport()) }

    nonisolated let store: PendingShareStore
    nonisolated let transport: ShareUploadTransport
    private let makeApi: (PendingShare) -> ShareApi?
    private var claims: [String: FileLock] = [:]
    private var running: [String: Set<Int>] = [:]
    private var advancing: Set<String> = []
    private var waiters: [String: [CheckedContinuation<ShareOutcome, Never>]] = [:]
    /// Bytes sent per item, for the extension's progress bar.
    private(set) var sent: [String: [Int: Int64]] = [:]
    /// Every outcome of a share this process sent (the app shows a notice for a failure).
    private var outcomeHandler: ((PendingShare, ShareOutcome) -> Void)?

    /// Whose sessions a share's generation is checked against (AccountSessions).
    private let sessions: AccountSessions

    init(store: PendingShareStore, transport: ShareUploadTransport, sessions: AccountSessions = .shared,
         makeApi: @escaping (PendingShare) -> ShareApi? = { share in
             URL(string: share.serverUrl).map { ShareApi(baseUrl: $0, account: share.account, generation: share.generation ?? 0) }
         }) {
        self.store = store
        self.transport = transport
        self.sessions = sessions
        self.makeApi = makeApi
        transport.onFinished = { [weak self] result in
            guard let self else { return }
            Task { await self.uploadFinished(result) }
        }
        transport.onProgress = { [weak self] shareId, index, bytes in
            guard let self else { return }
            Task { await self.progressed(shareId, index, bytes) }
        }
    }

    func setOutcomeHandler(_ handler: @escaping (PendingShare, ShareOutcome) -> Void) { outcomeHandler = handler }

    /// The share's progress, 0…1 (uploaded items count whole).
    func progress(_ id: String) -> Double {
        guard let share = store.load(id), share.totalBytes > 0 else { return 0 }
        let done = share.items.enumerated().reduce(Int64(0)) { sum, entry in
            sum + (entry.element.attachmentId != nil ? entry.element.size : min(entry.element.size, sent[id]?[entry.offset] ?? 0))
        }
        return Double(done) / Double(share.totalBytes)
    }

    /// Sends the share as far as it goes now and answers how it ended.
    func send(_ id: String) async -> ShareOutcome {
        if claims[id] == nil {
            guard let lock = store.claim(id) else { return .busy }
            claims[id] = lock
        }
        return await withCheckedContinuation { continuation in
            waiters[id, default: []].append(continuation)
            if waiters[id]?.count == 1 { Task { await self.advance(id) } }
        }
    }

    /// Every saved share that nobody is sending (the app at start and on return to the front), oldest first.
    func resumeAll() async {
        let ids = store.all().map(\.id).filter { claims[$0] == nil }
        await withTaskGroup(of: Void.self) { group in
            for id in ids { group.addTask { _ = await self.send(id) } }
        }
    }

    /// The extension closes with uploads still running: they go on in the system, the share is let go here, and the
    /// app finishes it (woken when the uploads end, or at its next start).
    func detach(_ id: String) {
        transport.detach(shareId: id)
        running[id] = nil
        sent[id] = nil
        claims.removeValue(forKey: id)?.release()
        resume(id, .pending(.temporary("background")))
    }

    // MARK: steps

    private func advance(_ id: String) async {
        advancing.insert(id)
        defer { advancing.remove(id) }
        guard let first = store.load(id) else { return conclude(id, nil, .failed(.refused(status: 0, code: "share_missing"))) }
        guard isCurrent(first) else { return conclude(id, first, .failed(.notSignedIn)) }
        if first.isUploaded { return await post(first) }
        // Uploads an earlier process started may still run, or have ended while nobody listened: attaching to the
        // share's session delivers those ends first (uploadFinished), then what is still running is left alone.
        let inFlight = await transport.running(shareId: id)
        running[id, default: []].formUnion(inFlight)
        guard var share = store.load(id) else { return conclude(id, nil, .failed(.refused(status: 0, code: "share_missing"))) }
        let toStart = share.items.indices.filter { share.items[$0].attachmentId == nil && !(running[id]?.contains($0) ?? false) }
        if !toStart.isEmpty {
            guard let api = makeApi(share) else { return conclude(id, share, .failed(.notSignedIn)) }
            let token: String
            do {
                token = try await api.accessToken()
            } catch {
                return conclude(id, share, .pending(Self.failure(error)))
            }
            for index in toStart {
                let item = share.items[index]
                let body = store.bodyURL(id, index)
                do {
                    if !FileManager.default.fileExists(atPath: body.path) {
                        let head = Multipart.head(boundary: item.boundary, filename: item.filename, contentType: item.contentType)
                        _ = try Multipart.write(head: head, file: store.fileURL(share, index), tail: Multipart.tail(boundary: item.boundary), to: body)
                    }
                } catch {
                    // The copy is gone or the disk is full: this file cannot be sent.
                    return conclude(id, share, .failed(.refused(status: 0, code: "share_file_missing")))
                }
                share.items[index].error = nil
                running[id, default: []].insert(index)
                transport.start(shareId: id, index: index, request: api.uploadRequest(boundary: item.boundary, token: token), body: body)
            }
            try? store.save(share)
        }
        await decide(id)
    }

    private func progressed(_ id: String, _ index: Int, _ bytes: Int64) {
        sent[id, default: [:]][index] = bytes
    }

    private func uploadFinished(_ result: ShareUploadResult) async {
        let id = result.shareId
        running[id]?.remove(result.index)
        guard var share = store.load(id), share.items.indices.contains(result.index) else { return }
        if (200..<300).contains(result.status) {
            struct Uploaded: Decodable { let id: String }
            if let uploaded = try? JSON.snakeDecoder.decode(Uploaded.self, from: result.data) {
                share.items[result.index].attachmentId = uploaded.id
                share.items[result.index].error = nil
                try? FileManager.default.removeItem(at: store.bodyURL(id, result.index))
            } else {
                share.items[result.index].error = "decode_error"
            }
        } else if result.status == 401 {
            share.items[result.index].error = "auth"
        } else if result.status == 0 || result.failedToConnect {
            share.items[result.index].error = "network"
        } else {
            share.items[result.index].error = ShareApi.errorCode(result.data) ?? "http_\(result.status)"
            if result.status == 429 || result.status >= 500 { share.items[result.index].error = "temporary" }
        }
        try? store.save(share)
        // Only the process holding the claim goes on; another one's late event just leaves its record.
        guard claims[id] != nil, !advancing.contains(id) else { return }
        await decide(id)
    }

    /// Once nothing of the share runs: post, try once more, or conclude.
    private func decide(_ id: String) async {
        guard (running[id] ?? []).isEmpty, var share = store.load(id) else { return }
        if share.isUploaded { return await post(share) }
        let errors = share.items.compactMap(\.error)
        if let refused = errors.first(where: { !["auth", "network", "temporary", "decode_error"].contains($0) }) {
            return conclude(id, share, .failed(.refused(status: 400, code: refused)))
        }
        if errors.contains("auth"), !share.authRetried, let api = makeApi(share) {
            share.authRetried = true
            try? store.save(share)
            do {
                _ = try await api.refreshedToken(replacing: SharedTokens.access(account: share.account)?.token)
            } catch {
                return conclude(id, share, .pending(Self.failure(error)))
            }
            return await advance(id)
        }
        if errors.contains("auth") { return conclude(id, share, .pending(.notSignedIn)) }
        conclude(id, share, .pending(.temporary(errors.first ?? "network")))
    }

    /// The account is still in the session the share was made in: signed out (or signed in again) since, the share is
    /// given up instead of being sent with another session (MOBILE_UI.md §21.3).
    private func isCurrent(_ share: PendingShare) -> Bool {
        sessions.isCurrent(account: share.account, generation: share.generation ?? 0)
    }

    private func post(_ share: PendingShare) async {
        guard isCurrent(share) else { return conclude(share.id, share, .failed(.notSignedIn)) }
        guard let api = makeApi(share) else { return conclude(share.id, share, .pending(.notSignedIn)) }
        do {
            _ = try await api.postMessage(channelId: share.channelId, clientMsgId: share.clientMsgId, body: share.text,
                                          parentId: share.parentId, attachmentIds: share.items.compactMap(\.attachmentId))
            conclude(share.id, share, .posted)
        } catch ShareFailure.refused(_, "attachment_invalid") where !share.reuploaded && !share.items.isEmpty {
            // The uploads were not bound in time (24 h) or went: upload them once more.
            var again = share
            again.reuploaded = true
            for index in again.items.indices { again.items[index].attachmentId = nil }
            try? store.save(again)
            await advance(share.id)
        } catch {
            let failure = Self.failure(error)
            switch failure {
            case .refused: conclude(share.id, share, .failed(failure))
            default: conclude(share.id, share, .pending(failure))
            }
        }
    }

    private func conclude(_ id: String, _ share: PendingShare?, _ outcome: ShareOutcome) {
        switch outcome {
        case .posted, .failed: store.remove(id)
        case .pending, .busy: break
        }
        running[id] = nil
        sent[id] = nil
        transport.detach(shareId: id)
        claims.removeValue(forKey: id)?.release()
        if let share { outcomeHandler?(share, outcome) }
        resume(id, outcome)
    }

    private func resume(_ id: String, _ outcome: ShareOutcome) {
        for waiter in waiters.removeValue(forKey: id) ?? [] { waiter.resume(returning: outcome) }
    }

    static func failure(_ error: Error) -> ShareFailure {
        (error as? ShareFailure) ?? .temporary("network_error")
    }
}

/// A background URLSession per share (`jp.chikuwachat.ios.share.<id>`, container = the App Group): its uploads go on
/// when the share sheet closes, and when they end with no process listening the system wakes the app
/// (AppDelegate.handleEventsForBackgroundURLSession), which attaches to the same session and finishes the share.
final class BackgroundShareTransport: NSObject, ShareUploadTransport, URLSessionDataDelegate, @unchecked Sendable {
    static let identifierPrefix = "jp.chikuwachat.ios.share."

    var onFinished: ((ShareUploadResult) -> Void)?
    var onProgress: ((String, Int, Int64) -> Void)?
    /// The system delivered every event of a session the app was woken for.
    var onEventsDelivered: ((String) -> Void)?

    private let lock = NSLock()
    private var sessions: [String: URLSession] = [:]
    private var buffers: [String: Data] = [:]
    private let queue: OperationQueue = {
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1
        return queue
    }()

    static func shareId(ofSession identifier: String?) -> String? {
        guard let identifier, identifier.hasPrefix(identifierPrefix) else { return nil }
        return String(identifier.dropFirst(identifierPrefix.count))
    }

    private func session(_ shareId: String) -> URLSession {
        lock.lock()
        defer { lock.unlock() }
        if let session = sessions[shareId] { return session }
        let configuration = URLSessionConfiguration.background(withIdentifier: Self.identifierPrefix + shareId)
        configuration.sharedContainerIdentifier = SharedContainer.groupId
        configuration.isDiscretionary = false
        configuration.sessionSendsLaunchEvents = true
        configuration.timeoutIntervalForResource = 24 * 3600
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
        sessions[shareId] = session
        return session
    }

    func running(shareId: String) async -> Set<Int> {
        let session = session(shareId)
        // Ends that happened while no process listened arrive right after attaching; let them through first.
        try? await Task.sleep(nanoseconds: 1_000_000_000)
        let tasks = await session.allTasks
        return Set(tasks.filter { $0.state == .running || $0.state == .suspended }.compactMap { $0.taskDescription.flatMap(Int.init) })
    }

    func start(shareId: String, index: Int, request: URLRequest, body: URL) {
        let task = session(shareId).uploadTask(with: request, fromFile: body)
        task.taskDescription = String(index)
        task.resume()
    }

    func detach(shareId: String) {
        lock.lock()
        let session = sessions.removeValue(forKey: shareId)
        lock.unlock()
        session?.finishTasksAndInvalidate()
    }

    /// The app was woken for this session: attach to it so its events are delivered.
    func attach(identifier: String) {
        if let shareId = Self.shareId(ofSession: identifier) { _ = session(shareId) }
    }

    private func key(_ session: URLSession, _ task: URLSessionTask) -> String {
        "\(session.configuration.identifier ?? "")#\(task.taskIdentifier)"
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.lock()
        buffers[key(session, dataTask), default: Data()].append(data)
        lock.unlock()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64, totalBytesSent: Int64,
                    totalBytesExpectedToSend: Int64) {
        guard let shareId = Self.shareId(ofSession: session.configuration.identifier), let index = task.taskDescription.flatMap(Int.init) else { return }
        onProgress?(shareId, index, totalBytesSent)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock()
        let data = buffers.removeValue(forKey: key(session, task)) ?? Data()
        lock.unlock()
        guard let shareId = Self.shareId(ofSession: session.configuration.identifier), let index = task.taskDescription.flatMap(Int.init) else { return }
        let status = (task.response as? HTTPURLResponse)?.statusCode ?? 0
        onFinished?(ShareUploadResult(shareId: shareId, index: index, status: error == nil ? status : 0, data: data, failedToConnect: error != nil))
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        guard let shareId = Self.shareId(ofSession: session.configuration.identifier) else { return }
        onEventsDelivered?(shareId)
    }
}
