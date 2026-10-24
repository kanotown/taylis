import Foundation

/// One part upload's end (a background task's).
struct DriveUploadTaskResult {
    var batchId: String
    var jobId: String
    var part: Int
    /// The session the part was sent to (a late answer for an earlier session is dropped).
    var uploadId: String
    /// The HTTP status; 0 without an answer, -1 when the task was cancelled.
    var status: Int
    var data: Data
    var failedToConnect: Bool
    /// The access token the part was sent with (a 401 refreshes from it).
    var token: String?
}

/// Runs the part uploads of a batch. The real one is a background URLSession per batch (BackgroundDriveTransport); the
/// tests answer at once.
protocol DriveUploadTransport: AnyObject, Sendable {
    var onFinished: ((DriveUploadTaskResult) -> Void)? { get set }
    var onProgress: ((String, String, Int, Int64) -> Void)? { get set }
    /// The parts of the batch still running ("<job>#<part>"), started by this process or by one that ended.
    func running(batchId: String) async -> Set<String>
    func start(batchId: String, jobId: String, part: Int, uploadId: String, request: URLRequest, body: URL)
    /// Stops a job's running parts (cancelled, failed, its session gone).
    func cancel(batchId: String, jobId: String)
    /// This process lets the batch go: running parts go on in the system, and their end wakes the app.
    func detach(batchId: String)
}

/// A server error's code and details (`{"error": {"code", "message", "details"}}`).
struct DriveServerError: Equatable {
    var status: Int
    var code: String
    var existingKind: String?

    init(status: Int, data: Data) {
        self.status = status
        let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        let error = object?["error"] as? [String: Any]
        code = error?["code"] as? String ?? "http_\(status)"
        existingKind = (error?["details"] as? [String: Any])?["existing_kind"] as? String
    }

    /// 429 and 5xx: the server is briefly unwell; tried again.
    var isTemporary: Bool { status == 0 || status == 429 || status >= 500 }
    /// The session is gone (a day without parts, cancelled elsewhere): start over with a new one.
    var sessionGone: Bool { code == "drive_upload_expired" || code == "drive_upload_not_found" || status == 410 }
}

extension ShareApi {
    /// A drive call with the shared tokens: a 401 token_expired refreshes once; any other answer is returned as it is
    /// (the caller reads its error). Network failures throw ShareFailure.temporary.
    func driveCall(_ method: String, _ path: String, json: [String: Any]? = nil, timeout: TimeInterval = 30) async throws -> (Data, Int) {
        var token = try await accessToken()
        var retried = false
        while true {
            let (data, status) = try await send(path: path, method: method, json: json, token: token, timeout: timeout)
            if status == 401 {
                guard !retried, Self.errorCode(data) == "token_expired" else { throw ShareFailure.notSignedIn }
                retried = true
                token = try await refreshedToken(replacing: token)
                continue
            }
            return (data, status)
        }
    }

    /// PUT /drive/uploads/{id}/parts/{n}: the slice's bytes (from its file, by a background task) and their SHA-256.
    func partRequest(uploadId: String, number: Int, sha256: String, token: String) -> URLRequest {
        var request = URLRequest(url: URL(string: "/api/v1/drive/uploads/\(uploadId)/parts/\(number)", relativeTo: baseUrl)!.absoluteURL)
        request.httpMethod = "PUT"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue(language, forHTTPHeaderField: "Accept-Language")
        request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        request.setValue(sha256, forHTTPHeaderField: "X-Content-SHA256")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return request
    }
}

/// Sends the drive's upload batches (docs/DRIVE.md §6, §29), with the desktop queue's rules (uploads.ts):
///
/// - A job's session is made with `on_conflict: fail` first: a name already in the folder answers 409 drive_name_taken
///   before any byte goes, the job asks (version / rename / skip; the answer may cover the rest of the batch) and the
///   session is made again with the same `client_upload_id`.
/// - Every part the server does not have is handed to the batch's background URLSession at once (each slice is its own
///   file), so they go on while the app or the share sheet is gone; the system wakes the app when they end.
/// - When every part is in, the session is completed: 200 done, or 202 and asked again every 2 s. 409
///   drive_upload_incomplete re-reads the session and sends the parts it no longer lists (3 rounds), 409
///   drive_upload_target_moved ends the job (never started again by itself), a session that is gone starts over.
/// - Network failures, 429 and 5xx wait (2 s doubling to 30 s) and read the session again before going on.
///
/// The app and the Share Extension run the same code; whoever holds the batch's claim (a FileLock in the App Group)
/// drives it, another process's late events are left alone (the holder reads the session from the server).
actor DriveUploadProcessor {
    static let shared: DriveUploadProcessor? = DriveUploadStore.shared.map { DriveUploadProcessor(store: $0, transport: BackgroundDriveTransport()) }

    typealias Observer = @Sendable ([DriveUploadBatch], [String: Int64]) -> Void

    nonisolated let store: DriveUploadStore
    nonisolated let transport: DriveUploadTransport
    private let makeApi: (DriveUploadBatch) -> ShareApi?
    private let sessions: AccountSessions
    private let pause: @Sendable (Double) async -> Void
    private var claims: [String: FileLock] = [:]
    /// Parts running in the system, per batch ("<job>#<part>").
    private var running: [String: Set<String>] = [:]
    /// Batches whose running parts were asked of the system in this process.
    private var attached: Set<String> = []
    /// Bytes sent of the running parts ("<job>#<part>").
    private var inflight: [String: Int64] = [:]
    /// Jobs whose session was read from the server in this process (else it is read before going on).
    private var synced: Set<String> = []
    private var retryAt: [String: Date] = [:]
    private var retryTasks: [String: Task<Void, Never>] = [:]
    private var authFailures: [String: Int] = [:]
    private var advancing: Set<String> = []
    private var again: Set<String> = []
    private var observers: [UUID: Observer] = [:]
    private var lastNote = Date.distantPast
    private var noteScheduled = false
    var now: @Sendable () -> Date = { Date() }

    init(store: DriveUploadStore, transport: DriveUploadTransport, sessions: AccountSessions = .shared,
         pause: @escaping @Sendable (Double) async -> Void = { seconds in try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000)) },
         makeApi: @escaping (DriveUploadBatch) -> ShareApi? = { batch in
             URL(string: batch.serverUrl).map { ShareApi(baseUrl: $0, account: batch.account, generation: batch.generation) }
         }) {
        self.store = store
        self.transport = transport
        self.sessions = sessions
        self.pause = pause
        self.makeApi = makeApi
        transport.onFinished = { [weak self] result in
            guard let self else { return }
            Task { await self.partFinished(result) }
        }
        transport.onProgress = { [weak self] batchId, jobId, part, bytes in
            guard let self else { return }
            Task { await self.progressed(batchId, jobId, part, bytes) }
        }
    }

    // MARK: watching

    /// Called after every change with every batch and the bytes in flight per job (a token to stop with `unobserve`).
    @discardableResult
    func observe(_ observer: @escaping Observer) -> UUID {
        let id = UUID()
        observers[id] = observer
        observer(store.all(), inflightByJob())
        return id
    }

    func unobserve(_ id: UUID) { observers[id] = nil }

    private func inflightByJob() -> [String: Int64] {
        var out: [String: Int64] = [:]
        for (key, bytes) in inflight {
            guard let job = key.split(separator: "#").first else { continue }
            out[String(job), default: 0] += bytes
        }
        return out
    }

    private func notify() {
        guard !observers.isEmpty else { return }
        let batches = store.all(), bytes = inflightByJob()
        for observer in observers.values { observer(batches, bytes) }
        lastNote = now()
    }

    /// Progress is said at most four times a second.
    private func notifySoon() {
        guard !noteScheduled else { return }
        let wait = max(0, 0.25 - now().timeIntervalSince(lastNote))
        noteScheduled = true
        Task {
            if wait > 0 { try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000)) }
            self.noteDue()
        }
    }

    private func noteDue() {
        noteScheduled = false
        notify()
    }

    // MARK: the calls

    /// A batch staged on disk starts.
    func add(_ batch: DriveUploadBatch) async {
        if store.load(batch.id) == nil { try? store.save(batch) }
        await run(batch.id)
    }

    /// Drives the batch as far as it goes now (this process takes its claim; another holding it is left alone).
    func run(_ id: String) async {
        guard holdClaim(id) else { return }
        await advance(id)
    }

    /// Every batch nobody drives (the app at start, back in front, the network back).
    func resumeAll() async {
        retryAt.removeAll()
        for batch in store.all() where !batch.isFinished {
            await run(batch.id)
        }
    }

    /// The person's answer to a name taken; `all` answers the rest of the batch the same way.
    func answer(batchId: String, jobId: String, choice: DriveConflictChoice, all: Bool) async {
        guard holdClaim(batchId), var batch = store.load(batchId) else { return }
        if all { batch.conflictAnswer = choice }
        var aborts: [String] = []
        for index in batch.jobs.indices where batch.jobs[index].id == jobId || (all && batch.jobs[index].state == .asking) {
            if choice == .skip {
                if let uploadId = batch.jobs[index].uploadId { aborts.append(uploadId) }
                batch.jobs[index].state = .skipped
                store.removeParts(batchId, batch.jobs[index].id)
            } else {
                // A folder of that name takes no version (「残りすべてに」 keeps both for it).
                let folder = batch.jobs[index].existingKind == "folder"
                batch.jobs[index].onConflict = (choice == .version && folder ? DriveConflictChoice.rename : choice).rawValue
                batch.jobs[index].state = .queued
            }
            batch.jobs[index].existingKind = nil
        }
        try? store.save(batch)
        notify()
        if let api = makeApi(batch) {
            for uploadId in aborts { _ = try? await api.driveCall("DELETE", "/api/v1/drive/uploads/\(uploadId)") }
        }
        await advance(batchId)
    }

    /// Stops a job and drops the server's session (its parts are deleted there).
    func cancel(batchId: String, jobId: String) async {
        guard holdClaim(batchId), let batch = store.load(batchId), let job = batch.jobs.first(where: { $0.id == jobId }), !job.state.isFinished else { return }
        stopParts(batchId, jobId)
        update(batchId, jobId) { $0.state = .cancelled; $0.error = nil }
        store.removeParts(batchId, jobId)
        if let uploadId = job.uploadId, let api = makeApi(batch) {
            _ = try? await api.driveCall("DELETE", "/api/v1/drive/uploads/\(uploadId)")
        }
        await advance(batchId)
    }

    /// A failed job tried again (into the same folder: a session that ended starts over).
    func retry(batchId: String, jobId: String) async {
        guard holdClaim(batchId) else { return }
        update(batchId, jobId) { job in
            guard job.state == .failed || job.state == .waiting else { return }
            if job.error == "drive_upload_target_moved" {
                // Its session ended (§28.1): a new one into the same folder, wherever that is now.
                job.uploadId = nil
                job.clientUploadId = UUID().uuidString.lowercased()
                job.received = []
            }
            job.state = .queued
            job.error = nil
            job.attempts = 0
            job.resendRounds = 0
        }
        synced.remove(jobId)
        retryAt[jobId] = nil
        authFailures[jobId] = nil
        await advance(batchId)
    }

    /// Takes a finished (or failed) job out of the list, with its slices.
    func discard(batchId: String, jobId: String) {
        guard var batch = store.load(batchId), let job = batch.jobs.first(where: { $0.id == jobId }),
              job.state.isFinished || job.state == .asking else { return }
        batch.jobs.removeAll { $0.id == jobId }
        store.removeParts(batchId, jobId)
        if batch.jobs.isEmpty {
            finishBatch(batchId)
            store.remove(batchId)
        } else {
            try? store.save(batch)
        }
        notify()
    }

    /// 「完了したものを消す」: the account's done, skipped and cancelled jobs.
    func clearFinished(account: String) {
        for var batch in store.all() where batch.account == account {
            let finished = batch.jobs.filter { [.done, .skipped, .cancelled].contains($0.state) }
            guard !finished.isEmpty else { continue }
            for job in finished { store.removeParts(batch.id, job.id) }
            batch.jobs.removeAll { [.done, .skipped, .cancelled].contains($0.state) }
            if batch.jobs.isEmpty {
                finishBatch(batch.id)
                store.remove(batch.id)
            } else {
                try? store.save(batch)
            }
        }
        notify()
    }

    /// The network came back: waiting jobs go on now.
    func online() async {
        retryAt.removeAll()
        for batch in store.all() where batch.jobs.contains(where: { $0.state == .waiting }) {
            await run(batch.id)
        }
    }

    /// The Share Extension closes with parts still running: they go on in the system, the batch is let go here, and the
    /// app finishes it (woken when they end, or at its next start).
    func detach(_ batchId: String) {
        transport.detach(batchId: batchId)
        running[batchId] = nil
        attached.remove(batchId)
        claims.removeValue(forKey: batchId)?.release()
    }

    /// Whether this process drives the batch now.
    func isDriving(_ batchId: String) -> Bool { claims[batchId]?.isHeld ?? false }

    // MARK: claim

    private func holdClaim(_ id: String) -> Bool {
        if let claim = claims[id], claim.isHeld { return true }
        claims[id] = nil
        attached.remove(id)
        guard let lock = store.claim(id) else { return false }
        claims[id] = lock
        return true
    }

    private func finishBatch(_ id: String) {
        transport.detach(batchId: id)
        running[id] = nil
        attached.remove(id)
        retryTasks.removeValue(forKey: id)?.cancel()
        claims.removeValue(forKey: id)?.release()
    }

    // MARK: state on disk (loaded, changed and saved without a suspension between, so no answer is lost)

    private func job(_ batchId: String, _ jobId: String) -> DriveUploadJob? {
        store.load(batchId)?.jobs.first { $0.id == jobId }
    }

    @discardableResult
    private func update(_ batchId: String, _ jobId: String, _ change: (inout DriveUploadJob) -> Void) -> DriveUploadJob? {
        guard var batch = store.load(batchId), let index = batch.jobs.firstIndex(where: { $0.id == jobId }) else { return nil }
        change(&batch.jobs[index])
        try? store.save(batch)
        return batch.jobs[index]
    }

    // MARK: steps

    private func advance(_ id: String) async {
        if advancing.contains(id) {
            again.insert(id)
            return
        }
        advancing.insert(id)
        repeat {
            again.remove(id)
            await step(id)
        } while again.contains(id)
        advancing.remove(id)
        notify()
    }

    private func step(_ id: String) async {
        guard let batch = store.load(id) else {
            finishBatch(id)
            return
        }
        // Signed out or in again since it was picked: given up, nothing goes with another session.
        guard sessions.isCurrent(account: batch.account, generation: batch.generation) else {
            for job in batch.jobs { transport.cancel(batchId: id, jobId: job.id) }
            finishBatch(id)
            store.remove(id)
            return
        }
        if batch.isFinished {
            finishBatch(id)
            return
        }
        guard let api = makeApi(batch) else { return }
        if !attached.contains(id) {
            running[id, default: []].formUnion(await transport.running(batchId: id))
            attached.insert(id)
        }
        for jobId in batch.jobs.map(\.id) {
            await stepJob(id, jobId, api: api)
        }
        if store.load(id)?.isFinished == true { finishBatch(id) }
    }

    private func isRunning(_ batchId: String, _ jobId: String) -> Bool {
        running[batchId]?.contains { $0.hasPrefix(jobId + "#") } ?? false
    }

    private func stepJob(_ batchId: String, _ jobId: String, api: ShareApi) async {
        guard let batch = store.load(batchId), var job = batch.jobs.first(where: { $0.id == jobId }), job.state.isActive else { return }
        if job.state == .waiting, let due = retryAt[jobId], due > now() { return }
        do {
            if job.uploadId == nil {
                guard try await createSession(batch, job, api: api) else { return }
                guard let fresh = self.job(batchId, jobId), fresh.state.isActive else { return }
                job = fresh
            } else if !synced.contains(jobId) {
                guard try await readSession(batchId, job, api: api) else { return }
                guard let fresh = self.job(batchId, jobId), fresh.state.isActive else { return }
                job = fresh
            }
            guard let uploadId = job.uploadId else { return }
            if job.state == .completing {
                await poll(batchId, jobId, uploadId: uploadId, api: api)
                return
            }
            let missing = DriveUploadRules.missing(total: job.partsTotal, received: job.received)
                .filter { !(running[batchId]?.contains("\(jobId)#\($0)") ?? false) }
            if !missing.isEmpty {
                let token = try await api.accessToken()
                for number in missing {
                    let body = store.partURL(batchId, jobId, number)
                    guard FileManager.default.fileExists(atPath: body.path), job.sha.indices.contains(number - 1) else {
                        fail(batchId, jobId, "read_failed")
                        return
                    }
                    running[batchId, default: []].insert("\(jobId)#\(number)")
                    transport.start(batchId: batchId, jobId: jobId, part: number, uploadId: uploadId,
                                    request: api.partRequest(uploadId: uploadId, number: number, sha256: job.sha[number - 1], token: token), body: body)
                }
                update(batchId, jobId) { $0.state = .uploading; $0.error = nil }
                return
            }
            guard !isRunning(batchId, jobId) else { return }
            try await complete(batchId, jobId, uploadId: uploadId, api: api)
        } catch {
            wait(batchId, jobId, error: error)
        }
    }

    /// POST /drive/uploads. Returns whether the job goes on now.
    private func createSession(_ batch: DriveUploadBatch, _ job: DriveUploadJob, api: ShareApi) async throws -> Bool {
        let body: [String: Any] = [
            "client_upload_id": job.clientUploadId, "parent_id": batch.target.parentId, "name": job.name, "size_bytes": job.size,
            "on_conflict": job.onConflict, "content_modified_ms": job.modifiedMs.map { $0 as Any } ?? NSNull(),
        ]
        let (data, status) = try await api.driveCall("POST", "/api/v1/drive/uploads", json: body)
        if (200..<300).contains(status), let session = try? JSON.snakeDecoder.decode(DriveUploadSessionOut.self, from: data) {
            return take(batch.id, job.id, session)
        }
        let error = DriveServerError(status: status, data: data)
        if status == 409, error.code == "drive_name_taken", job.onConflict == "fail" {
            conflict(batch.id, job.id, existingKind: error.existingKind, onComplete: false)
            return false
        }
        if error.isTemporary { throw ShareFailure.temporary(error.code) }
        fail(batch.id, job.id, error.code)
        return false
    }

    /// The session as the server has it now (after a restart, a lost connection). Returns whether the job goes on.
    private func readSession(_ batchId: String, _ job: DriveUploadJob, api: ShareApi) async throws -> Bool {
        guard let uploadId = job.uploadId else { return true }
        let (data, status) = try await api.driveCall("GET", "/api/v1/drive/uploads/\(uploadId)")
        if (200..<300).contains(status), let session = try? JSON.snakeDecoder.decode(DriveUploadSessionOut.self, from: data) {
            switch session.status {
            case "completed":
                done(batchId, job.id, itemId: session.itemId)
                return false
            case "completing":
                synced.insert(job.id)
                update(batchId, job.id) { $0.state = .completing }
                return true
            case "active":
                if session.error == "drive_name_taken", job.onConflict == "fail" {
                    conflict(batchId, job.id, existingKind: nil, onComplete: true)
                    return false
                }
                return take(batchId, job.id, session)
            default:
                if session.error == "drive_upload_target_moved" {
                    fail(batchId, job.id, "drive_upload_target_moved")
                } else {
                    restart(batchId, job.id)
                }
                return false
            }
        }
        let error = DriveServerError(status: status, data: data)
        if error.sessionGone || status == 404 {
            restart(batchId, job.id)
            return false
        }
        if error.isTemporary { throw ShareFailure.temporary(error.code) }
        fail(batchId, job.id, error.code)
        return false
    }

    /// The server's session for the job: its parts (cut again when the size differs from the slices').
    private func take(_ batchId: String, _ jobId: String, _ session: DriveUploadSessionOut) -> Bool {
        guard var job = self.job(batchId, jobId) else { return false }
        if session.partSize != job.partSize, session.partsTotal > 0 {
            do {
                let cut = try store.reslice(batchId: batchId, job: job, to: session.partSize)
                job.sha = cut.sha
            } catch {
                fail(batchId, jobId, "read_failed")
                return false
            }
        }
        let sha = job.sha
        synced.insert(jobId)
        update(batchId, jobId) { job in
            job.uploadId = session.id
            job.partSize = session.partSize
            job.partsTotal = session.partsTotal
            job.received = session.receivedParts
            job.sha = sha
            job.state = .uploading
            job.error = nil
        }
        return true
    }

    /// A name taken: the batch's answer for the rest when given, else the question.
    private func conflict(_ batchId: String, _ jobId: String, existingKind: String?, onComplete: Bool) {
        guard let batch = store.load(batchId) else { return }
        if var answer = batch.conflictAnswer {
            // A folder of that name takes no version: the batch's 「上書き」 keeps both for it.
            if answer == .version, existingKind == "folder" { answer = .rename }
            if answer == .skip {
                update(batchId, jobId) { $0.state = .skipped }
                store.removeParts(batchId, jobId)
            } else {
                update(batchId, jobId) { $0.onConflict = answer.rawValue; $0.askedOnComplete = onComplete; $0.state = .queued }
                again.insert(batchId)
            }
            return
        }
        update(batchId, jobId) { job in
            job.state = .asking
            job.existingKind = existingKind
            job.askedOnComplete = onComplete
        }
    }

    private func complete(_ batchId: String, _ jobId: String, uploadId: String, api: ShareApi) async throws {
        guard let job = self.job(batchId, jobId) else { return }
        if job.askedOnComplete, job.onConflict != "fail" {
            // Answered after the completion found the name taken: the session takes the answer, then completes.
            let (data, status) = try await api.driveCall("PATCH", "/api/v1/drive/uploads/\(uploadId)", json: ["on_conflict": job.onConflict])
            guard (200..<300).contains(status) else {
                let error = DriveServerError(status: status, data: data)
                if error.isTemporary { throw ShareFailure.temporary(error.code) }
                if error.sessionGone { restart(batchId, jobId) } else { fail(batchId, jobId, error.code) }
                return
            }
            update(batchId, jobId) { $0.askedOnComplete = false }
        }
        update(batchId, jobId) { $0.state = .completing; $0.error = nil }
        let (data, status) = try await api.driveCall("POST", "/api/v1/drive/uploads/\(uploadId)/complete", timeout: 60)
        if status == 200, let out = try? JSON.snakeDecoder.decode(DriveUploadCompleteOut.self, from: data), out.status == "completed" {
            done(batchId, jobId, itemId: out.item?.id)
            return
        }
        if (200..<300).contains(status) {
            await poll(batchId, jobId, uploadId: uploadId, api: api)
            return
        }
        let error = DriveServerError(status: status, data: data)
        switch error.code {
        case "drive_name_taken" where job.onConflict == "fail":
            conflict(batchId, jobId, existingKind: error.existingKind, onComplete: true)
        case "drive_upload_incomplete":
            // Parts whose bytes the store holds differently (§28.5): read the session (they are no longer listed) and
            // send them again, then complete again. A few rounds at most.
            guard job.resendRounds < DriveUploadRules.resendRounds else {
                fail(batchId, jobId, error.code)
                return
            }
            update(batchId, jobId) { $0.resendRounds += 1; $0.state = .uploading }
            synced.remove(jobId)
            again.insert(batchId)
        case "drive_upload_target_moved":
            // Its folder went to another drive (§28.1): not started again by itself (the person picks where it goes).
            fail(batchId, jobId, error.code)
        case "drive_upload_not_active":
            // Completing already (another device, a request that was faster): ask.
            await poll(batchId, jobId, uploadId: uploadId, api: api)
        default:
            if error.sessionGone || status == 404 {
                restart(batchId, jobId)
            } else if error.isTemporary {
                throw ShareFailure.temporary(error.code)
            } else {
                fail(batchId, jobId, error.code)
            }
        }
    }

    /// 202: the parts are being joined; the session is asked again until it says how it ended.
    private func poll(_ batchId: String, _ jobId: String, uploadId: String, api: ShareApi) async {
        update(batchId, jobId) { $0.state = .completing }
        for _ in 0..<DriveUploadRules.completePolls {
            await pause(DriveUploadRules.completePollSeconds)
            guard let job = self.job(batchId, jobId), job.state == .completing else { return }
            let answer: (Data, Int)
            do {
                answer = try await api.driveCall("GET", "/api/v1/drive/uploads/\(uploadId)")
            } catch {
                wait(batchId, jobId, error: error)
                return
            }
            let (data, status) = answer
            guard (200..<300).contains(status), let session = try? JSON.snakeDecoder.decode(DriveUploadSessionOut.self, from: data) else {
                let error = DriveServerError(status: status, data: data)
                if error.sessionGone || status == 404 { restart(batchId, jobId) } else if !error.isTemporary { fail(batchId, jobId, error.code) }
                continue
            }
            switch session.status {
            case "completed":
                done(batchId, jobId, itemId: session.itemId)
                return
            case "completing":
                continue
            case "active":
                if session.error == "drive_name_taken", job.onConflict == "fail" {
                    conflict(batchId, jobId, existingKind: nil, onComplete: true)
                } else if let code = session.error, code != "drive_upload_incomplete" {
                    fail(batchId, jobId, code)
                } else {
                    // Back to active (parts to send again, §28.5): read it and go on.
                    synced.remove(jobId)
                    update(batchId, jobId) { $0.state = .uploading }
                    again.insert(batchId)
                }
                return
            default:
                if session.error == "drive_upload_target_moved" { fail(batchId, jobId, "drive_upload_target_moved") } else { restart(batchId, jobId) }
                return
            }
        }
        // Still joining: asked again on the next run.
        scheduleRetry(batchId, after: 10)
    }

    // MARK: endings

    private func done(_ batchId: String, _ jobId: String, itemId: String?) {
        stopParts(batchId, jobId)
        update(batchId, jobId) { job in
            job.state = .done
            job.itemId = itemId
            job.error = nil
            job.received = job.partsTotal > 0 ? Array(1...job.partsTotal) : []
        }
        store.removeParts(batchId, jobId)
    }

    /// Failed with the reason (its slices stay for 「再試行」 until the job is taken out of the list).
    private func fail(_ batchId: String, _ jobId: String, _ code: String) {
        stopParts(batchId, jobId)
        update(batchId, jobId) { $0.state = .failed; $0.error = code }
    }

    /// The session is gone: a new one (new idempotency key) from the first part.
    private func restart(_ batchId: String, _ jobId: String) {
        stopParts(batchId, jobId)
        synced.remove(jobId)
        update(batchId, jobId) { job in
            job.uploadId = nil
            job.clientUploadId = UUID().uuidString.lowercased()
            job.received = []
            job.state = .queued
            job.askedOnComplete = false
        }
        again.insert(batchId)
    }

    /// No answer, or a server briefly unwell: wait and go on (reading the session first).
    private func wait(_ batchId: String, _ jobId: String, error: Error) {
        if case ShareFailure.notSignedIn = error {
            update(batchId, jobId) { $0.state = .waiting; $0.error = "auth" }
            return
        }
        synced.remove(jobId)
        let job = update(batchId, jobId) { job in
            job.state = .waiting
            job.error = "network"
            job.attempts += 1
        }
        let delay = DriveUploadRules.retryDelay(attempt: job?.attempts ?? 1)
        retryAt[jobId] = now().addingTimeInterval(delay)
        scheduleRetry(batchId, after: delay)
    }

    private func stopParts(_ batchId: String, _ jobId: String) {
        transport.cancel(batchId: batchId, jobId: jobId)
        running[batchId] = running[batchId]?.filter { !$0.hasPrefix(jobId + "#") }
        for key in inflight.keys where key.hasPrefix(jobId + "#") { inflight[key] = nil }
    }

    private func scheduleRetry(_ batchId: String, after seconds: Double) {
        guard retryTasks[batchId] == nil else { return }
        retryTasks[batchId] = Task { [pause] in
            await pause(seconds)
            await self.retryDue(batchId)
        }
    }

    private func retryDue(_ batchId: String) async {
        retryTasks[batchId] = nil
        guard !Task.isCancelled, holdClaim(batchId) else { return }
        for job in store.load(batchId)?.jobs ?? [] { retryAt[job.id] = nil }
        await advance(batchId)
    }

    // MARK: part ends

    private func progressed(_ batchId: String, _ jobId: String, _ part: Int, _ bytes: Int64) {
        guard claims[batchId] != nil else { return }
        inflight["\(jobId)#\(part)"] = bytes
        notifySoon()
    }

    func partFinished(_ result: DriveUploadTaskResult) async {
        let key = "\(result.jobId)#\(result.part)"
        running[result.batchId]?.remove(key)
        inflight[key] = nil
        // Only the process driving the batch records it; another's late event is read from the server by the driver.
        guard claims[result.batchId] != nil, holdClaim(result.batchId),
              let job = job(result.batchId, result.jobId), job.state.isActive, job.uploadId == result.uploadId else { return }
        if result.status == -1 {
            // Cancelled by the system (this process's own cancellations end or restart the job): sent again.
            await advance(result.batchId)
            return
        }
        let error = DriveServerError(status: result.status, data: result.data)
        switch result.status {
        case 200..<300:
            authFailures[result.jobId] = nil
            update(result.batchId, result.jobId) { job in
                if !job.received.contains(result.part) { job.received.append(result.part) }
                job.attempts = 0
                if job.state == .waiting { job.state = .uploading; job.error = nil }
            }
        case 401:
            let failures = (authFailures[result.jobId] ?? 0) + 1
            authFailures[result.jobId] = failures
            guard failures <= 2, let batch = store.load(result.batchId), let api = makeApi(batch) else {
                update(result.batchId, result.jobId) { $0.state = .waiting; $0.error = "auth" }
                break
            }
            do {
                _ = try await api.refreshedToken(replacing: result.token)
            } catch {
                wait(result.batchId, result.jobId, error: error)
            }
        case 404, 410:
            restart(result.batchId, result.jobId)
        case 409:
            // drive_upload_not_active: completing elsewhere; read the session.
            synced.remove(result.jobId)
        default:
            if result.failedToConnect || error.isTemporary {
                wait(result.batchId, result.jobId, error: ShareFailure.temporary(error.code))
            } else {
                fail(result.batchId, result.jobId, error.code)
            }
        }
        await advance(result.batchId)
    }
}

/// A background URLSession per batch (`jp.chikuwachat.ios.drive.<batch>`, container = the App Group): its part uploads
/// go on when the app or the share sheet leaves the screen, and when they end with no process listening the system
/// wakes the app (AppDelegate.handleEventsForBackgroundURLSession), which attaches to the same session and goes on.
final class BackgroundDriveTransport: NSObject, DriveUploadTransport, URLSessionDataDelegate, @unchecked Sendable {
    static let identifierPrefix = "jp.chikuwachat.ios.drive."

    var onFinished: ((DriveUploadTaskResult) -> Void)?
    var onProgress: ((String, String, Int, Int64) -> Void)?
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

    static func batchId(ofSession identifier: String?) -> String? {
        guard let identifier, identifier.hasPrefix(identifierPrefix) else { return nil }
        return String(identifier.dropFirst(identifierPrefix.count))
    }

    private func session(_ batchId: String) -> URLSession {
        lock.lock()
        defer { lock.unlock() }
        if let session = sessions[batchId] { return session }
        let configuration = URLSessionConfiguration.background(withIdentifier: Self.identifierPrefix + batchId)
        configuration.sharedContainerIdentifier = SharedContainer.groupId
        configuration.isDiscretionary = false
        configuration.sessionSendsLaunchEvents = true
        configuration.timeoutIntervalForResource = 24 * 3600
        // A few parts at a time (the server takes 240 a minute per person, §6.2).
        configuration.httpMaximumConnectionsPerHost = 3
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: queue)
        sessions[batchId] = session
        return session
    }

    func running(batchId: String) async -> Set<String> {
        let session = session(batchId)
        // Ends that happened while no process listened arrive right after attaching; let them through first.
        try? await Task.sleep(nanoseconds: 1_000_000_000)
        let tasks = await session.allTasks
        return Set(tasks.filter { $0.state == .running || $0.state == .suspended }.compactMap(Self.parse).map { "\($0.jobId)#\($0.part)" })
    }

    func start(batchId: String, jobId: String, part: Int, uploadId: String, request: URLRequest, body: URL) {
        let task = session(batchId).uploadTask(with: request, fromFile: body)
        task.taskDescription = "\(jobId)#\(part)#\(uploadId)"
        task.resume()
    }

    func cancel(batchId: String, jobId: String) {
        lock.lock()
        let session = sessions[batchId]
        lock.unlock()
        session?.getAllTasks { tasks in
            for task in tasks where task.taskDescription?.hasPrefix(jobId + "#") == true { task.cancel() }
        }
    }

    func detach(batchId: String) {
        lock.lock()
        let session = sessions.removeValue(forKey: batchId)
        lock.unlock()
        session?.finishTasksAndInvalidate()
    }

    /// The app was woken for this session: attach to it so its events are delivered.
    func attach(identifier: String) {
        if let batchId = Self.batchId(ofSession: identifier) { _ = session(batchId) }
    }

    private func key(_ session: URLSession, _ task: URLSessionTask) -> String {
        "\(session.configuration.identifier ?? "")#\(task.taskIdentifier)"
    }

    /// "<job>#<part>#<upload id>".
    private static func parse(_ task: URLSessionTask) -> (jobId: String, part: Int, uploadId: String)? {
        let fields = (task.taskDescription ?? "").split(separator: "#", omittingEmptySubsequences: false)
        guard fields.count == 3, let part = Int(fields[1]) else { return nil }
        return (String(fields[0]), part, String(fields[2]))
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        lock.lock()
        buffers[key(session, dataTask), default: Data()].append(data)
        lock.unlock()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64, totalBytesSent: Int64,
                    totalBytesExpectedToSend: Int64) {
        guard let batchId = Self.batchId(ofSession: session.configuration.identifier), let parsed = Self.parse(task) else { return }
        onProgress?(batchId, parsed.jobId, parsed.part, totalBytesSent)
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        lock.lock()
        let data = buffers.removeValue(forKey: key(session, task)) ?? Data()
        lock.unlock()
        guard let batchId = Self.batchId(ofSession: session.configuration.identifier), let parsed = Self.parse(task) else { return }
        let cancelled = (error as? URLError)?.code == .cancelled
        let status = cancelled ? -1 : error == nil ? (task.response as? HTTPURLResponse)?.statusCode ?? 0 : 0
        let token = task.originalRequest?.value(forHTTPHeaderField: "Authorization").map { String($0.dropFirst("Bearer ".count)) }
        onFinished?(DriveUploadTaskResult(batchId: batchId, jobId: parsed.jobId, part: parsed.part, uploadId: parsed.uploadId, status: status,
                                          data: data, failedToConnect: error != nil && !cancelled, token: token))
    }

    func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        guard let batchId = Self.batchId(ofSession: session.configuration.identifier) else { return }
        onEventsDelivered?(batchId)
    }
}
