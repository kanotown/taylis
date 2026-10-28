import CryptoKit
import XCTest
@testable import ChikuwaChat

/// A drive upload server in memory (docs/DRIVE.md §6): sessions by client_upload_id, parts by number (bytes and their
/// SHA-256 checked), completion (200, or 202 then completed), and the review's 409s (§28) when a test asks for them.
final class FakeDriveUploadServer: @unchecked Sendable {
    struct Session {
        var id: String
        var clientUploadId: String
        var name: String
        var size: Int64
        var onConflict: String
        var status = "active"
        var parts: [Int: Data] = [:]
        var error: String?
        var itemId: String?
    }

    let lock = NSLock()
    var partSize: Int64 = 4
    var sessions: [String: Session] = [:]
    /// Names in the folder (a create with `fail` answers 409 drive_name_taken); value: the existing item's kind.
    var taken: [String: String] = [:]
    /// What the next completions answer instead of 200 (popped one by one): "202", "incomplete:<n>", "moved", "name".
    var completeAnswers: [String] = []
    /// GETs of a completing session answered "completing" this many times first.
    var completingPolls = 0
    var calls: [String] = []
    var deleted: [String] = []
    var creates: [[String: Any]] = []

    private func json(_ object: Any) -> Data { try! JSONSerialization.data(withJSONObject: object) }

    private func error(_ status: Int, _ code: String, details: [String: Any] = [:]) -> (Int, Data) {
        (status, json(["error": ["code": code, "message": code, "details": details]]))
    }

    private func out(_ session: Session) -> Data {
        let total = session.size == 0 ? 0 : Int((session.size + partSize - 1) / partSize)
        return json(["id": session.id, "client_upload_id": session.clientUploadId, "status": session.status, "part_size": partSize,
                     "parts_total": total, "received_parts": session.parts.keys.sorted(), "size_bytes": session.size,
                     "item_id": session.itemId as Any? ?? NSNull(), "error": session.error as Any? ?? NSNull()])
    }

    private func body(_ request: URLRequest) -> [String: Any] {
        let data = request.httpBodyStream.map { stream -> Data in
            stream.open()
            defer { stream.close() }
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable { let n = stream.read(&buffer, maxLength: 4096); if n <= 0 { break }; data.append(buffer, count: n) }
            return data
        } ?? request.httpBody ?? Data()
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    }

    func handle(_ request: URLRequest) -> (Int, Data) {
        lock.lock()
        defer { lock.unlock() }
        let path = request.url!.path, method = request.httpMethod ?? "GET"
        calls.append("\(method) \(path)")
        if path == "/api/v1/auth/refresh" {
            return (200, Data(#"{"access_token":"access-2","refresh_token":"refresh-2","expires_in":900}"#.utf8))
        }
        if path == "/api/v1/drive/uploads", method == "POST" {
            let fields = body(request)
            creates.append(fields)
            let client = fields["client_upload_id"] as! String
            if let existing = sessions.values.first(where: { $0.clientUploadId == client }) { return (200, out(existing)) }
            let name = fields["name"] as! String, mode = fields["on_conflict"] as! String
            if let kind = taken[name], mode == "fail" || (mode == "version" && kind == "folder") {
                return error(409, "drive_name_taken", details: ["existing_kind": kind])
            }
            let session = Session(id: "up-\(sessions.count + 1)", clientUploadId: client, name: name, size: Int64(fields["size_bytes"] as! Int),
                                  onConflict: mode)
            sessions[session.id] = session
            return (201, out(session))
        }
        let parts = path.split(separator: "/").map(String.init) // api v1 drive uploads {id} [complete]
        guard parts.count >= 5, parts[3] == "uploads", var session = sessions[parts[4]] else { return error(404, "drive_upload_not_found") }
        if parts.count == 5, method == "GET" {
            if session.status == "completing" {
                if completingPolls > 0 { completingPolls -= 1 } else { session.status = "completed"; session.itemId = "item-\(session.id)" }
                sessions[session.id] = session
            }
            return (200, out(session))
        }
        if parts.count == 5, method == "DELETE" {
            deleted.append(session.id)
            session.status = "aborted"
            sessions[session.id] = session
            return (204, Data())
        }
        if parts.count == 5, method == "PATCH" {
            session.onConflict = body(request)["on_conflict"] as? String ?? session.onConflict
            session.error = nil
            sessions[session.id] = session
            return (200, out(session))
        }
        if parts.count == 6, parts[5] == "complete" {
            let total = session.size == 0 ? 0 : Int((session.size + partSize - 1) / partSize)
            guard session.parts.count == total else { return error(409, "drive_upload_incomplete", details: ["missing": []]) }
            let answer = completeAnswers.isEmpty ? "200" : completeAnswers.removeFirst()
            switch answer {
            case "202":
                session.status = "completing"
                sessions[session.id] = session
                return (202, json(["status": "completing", "item": NSNull(), "version_id": NSNull()]))
            case let bad where bad.hasPrefix("incomplete:"):
                let number = Int(bad.dropFirst("incomplete:".count))!
                session.parts[number] = nil
                sessions[session.id] = session
                return error(409, "drive_upload_incomplete", details: ["missing": [number]])
            case "moved":
                session.status = "aborted"
                session.error = "drive_upload_target_moved"
                sessions[session.id] = session
                return error(409, "drive_upload_target_moved")
            case "name":
                guard session.onConflict == "fail" else { fallthrough }
                session.error = "drive_name_taken"
                sessions[session.id] = session
                return error(409, "drive_name_taken", details: ["existing_kind": "file"])
            default:
                session.status = "completed"
                session.itemId = "item-\(session.id)"
                sessions[session.id] = session
                return (200, json(["status": "completed", "item": ["id": "item-\(session.id)"], "version_id": "v1"]))
            }
        }
        return error(404, "not_found")
    }

    /// A part as the server takes it (its SHA-256 checked).
    func put(uploadId: String, number: Int, bytes: Data, sha: String?) -> (Int, Data) {
        lock.lock()
        defer { lock.unlock() }
        calls.append("PUT part \(uploadId)/\(number)")
        guard var session = sessions[uploadId] else { return error(404, "drive_upload_not_found") }
        guard session.status == "active" else { return error(410, "drive_upload_expired") }
        let hex = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        guard sha == hex else { return error(422, "drive_part_invalid") }
        session.parts[number] = bytes
        sessions[uploadId] = session
        return (200, json(["part_number": number, "size_bytes": bytes.count]))
    }

    func session(named name: String) -> Session? {
        lock.lock()
        defer { lock.unlock() }
        return sessions.values.filter { $0.name == name }.sorted { $0.id < $1.id }.last
    }
}

/// Parts answered by the fake server at once (or failed when a test says so).
final class FakeDriveTransport: DriveUploadTransport, @unchecked Sendable {
    var onFinished: ((DriveUploadTaskResult) -> Void)?
    var onProgress: ((String, String, Int, Int64) -> Void)?
    let server: FakeDriveUploadServer
    /// Parts that fail without an answer the first time ("<job>#<n>" or any part with "*").
    var dropOnce: Set<String> = []
    var stillRunning: Set<String> = []
    private(set) var started: [(jobId: String, part: Int, request: URLRequest)] = []
    private(set) var cancelled: [String] = []
    private let lock = NSLock()

    init(server: FakeDriveUploadServer) { self.server = server }

    func running(batchId: String) async -> Set<String> { stillRunning }

    func start(batchId: String, jobId: String, part: Int, uploadId: String, request: URLRequest, body: URL) {
        let bytes = (try? Data(contentsOf: body)) ?? Data()
        lock.lock()
        started.append((jobId, part, request))
        let drop = dropOnce.remove("\(jobId)#\(part)") != nil || dropOnce.remove("*") != nil
        lock.unlock()
        let token = request.value(forHTTPHeaderField: "Authorization").map { String($0.dropFirst("Bearer ".count)) }
        let (status, data) = drop ? (0, Data()) : server.put(uploadId: uploadId, number: part, bytes: bytes,
                                                              sha: request.value(forHTTPHeaderField: "X-Content-SHA256"))
        DispatchQueue.global().async {
            self.onFinished?(DriveUploadTaskResult(batchId: batchId, jobId: jobId, part: part, uploadId: uploadId, status: status, data: data,
                                                   failedToConnect: drop, token: token))
        }
    }

    func cancel(batchId: String, jobId: String) {
        lock.lock()
        cancelled.append(jobId)
        lock.unlock()
    }

    func detach(batchId: String) {}

    var parts: [String] {
        lock.lock()
        defer { lock.unlock() }
        return started.map { "\($0.jobId)#\($0.part)" }
    }
}

final class DriveUploadRulesTests: XCTestCase {
    func testPartsRangesAndWhatIsMissing() {
        XCTAssertEqual(DriveUploadRules.partCount(size: 0, partSize: 4), 0)
        XCTAssertEqual(DriveUploadRules.partCount(size: 9, partSize: 4), 3)
        XCTAssertEqual(DriveUploadRules.partCount(size: 8, partSize: 4), 2)
        XCTAssertEqual(DriveUploadRules.partRange(3, size: 9, partSize: 4), 8..<9)
        XCTAssertEqual(DriveUploadRules.missing(total: 4, received: [2, 4]), [1, 3])
        XCTAssertEqual(DriveUploadRules.missing(total: 0, received: []), [])
        XCTAssertEqual(DriveUploadRules.sentBytes(received: [1, 3, 3], size: 9, partSize: 4), 5)
        XCTAssertEqual(DriveUploadRules.retryDelay(attempt: 1), 2)
        XCTAssertEqual(DriveUploadRules.retryDelay(attempt: 3), 8)
        XCTAssertEqual(DriveUploadRules.retryDelay(attempt: 9), 30)
        XCTAssertEqual(DriveUploadRules.photoName(Date(timeIntervalSince1970: 0)).count, "IMG_19700101_000000.jpg".count)
        XCTAssertTrue(DriveUploadRules.photoName().hasPrefix("IMG_"))
    }

    func testStagingCutsSlicesWithTheirHashesAndCutsAgainForAnotherPartSize() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("drive-uploads-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = DriveUploadStore(root: root)
        let source = root.appendingPathComponent("source.bin")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try Data("abcdefghij".utf8).write(to: source)
        let cut = try store.stage(file: source, batchId: "b", jobId: "j", sliceBytes: 4)
        XCTAssertEqual(cut.size, 10)
        XCTAssertEqual(cut.parts, 3)
        XCTAssertEqual(try Data(contentsOf: store.partURL("b", "j", 3)), Data("ij".utf8))
        XCTAssertEqual(cut.sha[0], DriveUploadStore.hex(Data("abcd".utf8)))
        let fromData = try store.stage(data: Data("abcdefghij".utf8), batchId: "b", jobId: "k", sliceBytes: 4)
        XCTAssertEqual(fromData.sha, cut.sha)
        let empty = try store.stage(data: Data(), batchId: "b", jobId: "e", sliceBytes: 4)
        XCTAssertEqual(empty.parts, 0)

        let job = DriveUploadJob(id: "j", clientUploadId: "c", name: "a", size: 10, partSize: 4, partsTotal: 3, sha: cut.sha)
        let again = try store.reslice(batchId: "b", job: job, to: 6)
        XCTAssertEqual(again.parts, 2)
        XCTAssertEqual(try Data(contentsOf: store.partURL("b", "j", 1)), Data("abcdef".utf8))
        XCTAssertEqual(try Data(contentsOf: store.partURL("b", "j", 2)), Data("ghij".utf8))
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.partURL("b", "j", 3).path))
        XCTAssertEqual(again.sha[1], DriveUploadStore.hex(Data("ghij".utf8)))
    }

    func testSweepDropsFinishedBatchesAfterADayAndAnyAfterAWeek() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("drive-uploads-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = DriveUploadStore(root: root)
        let now = Date()
        func batch(_ id: String, age: TimeInterval, state: DriveUploadState) -> DriveUploadBatch {
            DriveUploadBatch(id: id, serverUrl: "http://s", account: "a", generation: 0,
                             target: DriveUploadTarget(parentId: "p", locationId: "l", label: "x"), createdAt: now.addingTimeInterval(-age),
                             jobs: [DriveUploadJob(id: "j-\(id)", clientUploadId: "c", name: "n", size: 1, state: state, partsTotal: 1)])
        }
        try store.save(batch("done-old", age: 2 * 86400, state: .done))
        try store.save(batch("done-new", age: 3600, state: .done))
        try store.save(batch("asking", age: 2 * 86400, state: .asking))
        try store.save(batch("ancient", age: 8 * 86400, state: .asking))
        store.sweep(now: now)
        XCTAssertEqual(Set(store.all().map(\.id)), ["done-new", "asking"])
    }
}

/// Background time that never runs out: a batch's claim (a FileLock) stays held for the whole test, whatever the host
/// app's state (its own background tasks may expire in a long run).
private final class LastingActivities: BackgroundActivityProvider, @unchecked Sendable {
    private final class Activity: BackgroundActivity, @unchecked Sendable { func end() {} }
    func begin(_ name: String, expired: @escaping () -> Void) -> BackgroundActivity? { Activity() }
}

final class DriveUploadProcessorTests: XCTestCase {
    private var root: URL!
    private var account: String!
    private var server: FakeDriveUploadServer!
    private var previousActivities: BackgroundActivityProvider!
    /// The processors a test made, kept for the whole test: the transport holds its processor weakly (as the real one
    /// does; the app keeps `DriveUploadProcessor.shared`), so one dropped once `run` returns would miss the part ends
    /// still on their way (answered on another queue; late under a full run's load).
    private var processors: [DriveUploadProcessor] = []

    override func setUp() {
        previousActivities = FileLock.activities
        FileLock.activities = LastingActivities()
        root = FileManager.default.temporaryDirectory.appendingPathComponent("drive-batches-\(UUID().uuidString)", isDirectory: true)
        account = "http://drive.test|tester-\(UUID().uuidString)"
        server = FakeDriveUploadServer()
        SharedTokens.store(account: account, accessToken: "access-1", expiresIn: 900, refreshToken: "refresh-1")
        let server = server!
        StubProtocol.handler = { server.handle($0) }
    }

    override func tearDown() {
        StubProtocol.handler = nil
        processors = []
        Keychain.delete(account: account)
        try? FileManager.default.removeItem(at: root)
        FileLock.activities = previousActivities
    }

    private var store: DriveUploadStore { DriveUploadStore(root: root) }

    private func processor(_ transport: FakeDriveTransport) -> DriveUploadProcessor {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        let session = URLSession(configuration: configuration)
        let account = account!
        let processor = DriveUploadProcessor(store: store, transport: transport, pause: { _ in }) { batch in
            let api = ShareApi(baseUrl: URL(string: batch.serverUrl)!, account: account, language: "ja", session: session)
            api.lockProvider = { nil }
            api.refreshRetryDelays = []
            return api
        }
        processors.append(processor)
        return processor
    }

    /// A batch of files (name → bytes) cut at the server's part size (4 bytes here).
    @discardableResult
    private func batch(_ id: String, _ files: [(String, String)]) throws -> DriveUploadBatch {
        var jobs: [DriveUploadJob] = []
        for (index, (name, text)) in files.enumerated() {
            let cut = try store.stage(data: Data(text.utf8), batchId: id, jobId: "j\(index)", sliceBytes: 4)
            jobs.append(DriveUploadJob(id: "j\(index)", clientUploadId: "client-\(id)-\(index)", name: name, size: cut.size,
                                       partSize: 4, partsTotal: cut.parts, sha: cut.sha))
        }
        let batch = DriveUploadBatch(id: id, serverUrl: "http://drive.test", account: account, generation: 0,
                                     target: DriveUploadTarget(parentId: "folder-1", locationId: "loc", label: "研究室ドライブ › 論文"),
                                     createdAt: Date(), jobs: jobs)
        try store.save(batch)
        return batch
    }

    /// Waits until the batch's jobs settle (the parts are answered on another queue).
    private func settled(_ id: String, timeout: TimeInterval = 15, _ done: (DriveUploadBatch) -> Bool = { $0.isFinished }) async throws -> DriveUploadBatch {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let batch = store.load(id), done(batch) { return batch }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        return try XCTUnwrap(store.load(id), "batch gone")
    }

    func testSendsEveryPartWithItsHashThenCompletes() async throws {
        let transport = FakeDriveTransport(server: server)
        try batch("b1", [("報告.pdf", "0123456789"), ("empty.txt", "")])
        await processor(transport).run("b1")
        let done = try await settled("b1")
        XCTAssertEqual(done.jobs.map(\.state), [.done, .done])
        XCTAssertEqual(done.jobs[0].itemId, "item-up-1")
        XCTAssertEqual(transport.parts.sorted(), ["j0#1", "j0#2", "j0#3"], "an empty file has no parts")
        let request = try XCTUnwrap(transport.started.first?.request)
        XCTAssertEqual(request.httpMethod, "PUT")
        XCTAssertEqual(request.url?.path, "/api/v1/drive/uploads/up-1/parts/\(transport.started[0].part)")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer access-1")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/octet-stream")
        XCTAssertEqual(server.session(named: "報告.pdf")?.parts[3], Data("89".utf8))
        let create = try XCTUnwrap(server.creates.first)
        XCTAssertEqual(create["client_upload_id"] as? String, "client-b1-0")
        XCTAssertEqual(create["parent_id"] as? String, "folder-1")
        XCTAssertEqual(create["on_conflict"] as? String, "fail")
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.partsFolder("b1", "j0").path), "a done job's slices go")
    }

    func testANameTakenAsksAndTheAnswerMakesTheSessionAgainWithTheSameKey() async throws {
        server.taken = ["議事録.docx": "file", "資料": "folder"]
        let transport = FakeDriveTransport(server: server)
        try batch("b2", [("議事録.docx", "abcdef"), ("資料", "xyz"), ("other.txt", "123")])
        let processor = processor(transport)
        await processor.run("b2")
        var batch = try await settled("b2") { $0.jobs.filter { $0.state == .asking }.count == 2 && $0.jobs[2].state == .done }
        XCTAssertEqual(batch.jobs.map(\.state), [.asking, .asking, .done])
        let question = try XCTUnwrap(DriveUploadQuestion.first(in: [batch]))
        XCTAssertEqual(question.name, "議事録.docx")
        XCTAssertEqual(question.existingKind, "file")
        XCTAssertEqual(question.place, "研究室ドライブ › 論文")
        XCTAssertEqual(question.remaining, 1)
        XCTAssertTrue(transport.parts.allSatisfy { $0.hasPrefix("j2#") }, "nothing is sent before the answer")

        await processor.answer(batchId: "b2", jobId: "j0", choice: .version, all: false)
        batch = try await settled("b2") { $0.jobs[0].state == .done }
        XCTAssertEqual(batch.jobs[0].state, .done)
        let creates = server.creates.filter { $0["name"] as? String == "議事録.docx" }
        XCTAssertEqual(creates.map { $0["on_conflict"] as? String }, ["fail", "version"])
        XCTAssertEqual(Set(creates.map { $0["client_upload_id"] as? String }), ["client-b2-0"])

        // A folder of that name takes no version: the question offers rename and skip.
        XCTAssertEqual(DriveUploadQuestion.first(in: [batch])?.existingKind, "folder")
        await processor.answer(batchId: "b2", jobId: "j1", choice: .skip, all: false)
        batch = try await settled("b2")
        XCTAssertEqual(batch.jobs.map(\.state), [.done, .skipped, .done])
    }

    func testTheAnswerForTheRestOfTheBatchAnswersTheNextConflictsToo() async throws {
        server.taken = ["a.txt": "file", "b.txt": "file", "c.txt": "folder"]
        let transport = FakeDriveTransport(server: server)
        try batch("b3", [("a.txt", "1"), ("b.txt", "2"), ("c.txt", "3")])
        let processor = processor(transport)
        await processor.run("b3")
        _ = try await settled("b3") { $0.jobs.allSatisfy { $0.state == .asking } }
        await processor.answer(batchId: "b3", jobId: "j0", choice: .version, all: true)
        let batch = try await settled("b3")
        XCTAssertEqual(batch.jobs.map(\.state), [.done, .done, .done])
        XCTAssertEqual(batch.conflictAnswer, .version)
        XCTAssertEqual(server.session(named: "b.txt")?.onConflict, "version")
        XCTAssertEqual(server.session(named: "c.txt")?.onConflict, "rename", "a folder of that name keeps both")
    }

    func testACompletionAnsweringAcceptedIsAskedAgainUntilDone() async throws {
        server.completeAnswers = ["202"]
        server.completingPolls = 2
        let transport = FakeDriveTransport(server: server)
        try batch("b4", [("big.bin", "0123456789")])
        await processor(transport).run("b4")
        let batch = try await settled("b4")
        XCTAssertEqual(batch.jobs[0].state, .done)
        XCTAssertEqual(server.calls.filter { $0 == "GET /api/v1/drive/uploads/up-1" }.count, 3)
    }

    func testPartsTheStoreLostAreSentAgainThenTheCompletionIsRepeated() async throws {
        server.completeAnswers = ["incomplete:2"]
        let transport = FakeDriveTransport(server: server)
        try batch("b5", [("paper.pdf", "0123456789")])
        await processor(transport).run("b5")
        let batch = try await settled("b5")
        XCTAssertEqual(batch.jobs[0].state, .done)
        XCTAssertEqual(transport.parts.filter { $0 == "j0#2" }.count, 2, "part 2 went again")
        XCTAssertEqual(transport.parts.filter { $0 == "j0#1" }.count, 1)
        XCTAssertEqual(server.calls.filter { $0.hasSuffix("/complete") }.count, 2)
    }

    func testAFolderMovedToAnotherDriveFailsTheJobWithoutStartingAgain() async throws {
        server.completeAnswers = ["moved"]
        let transport = FakeDriveTransport(server: server)
        try batch("b6", [("x.pdf", "0123456789")])
        let processor = processor(transport)
        await processor.run("b6")
        let batch = try await settled("b6")
        XCTAssertEqual(batch.jobs[0].state, .failed)
        XCTAssertEqual(batch.jobs[0].error, "drive_upload_target_moved")
        XCTAssertEqual(server.creates.count, 1, "not started again by itself")
        XCTAssertTrue(FileManager.default.fileExists(atPath: store.partURL("b6", "j0", 1).path), "kept for 再試行")

        // 再試行: a new session into the same folder.
        await processor.retry(batchId: "b6", jobId: "j0")
        let again = try await settled("b6") { $0.jobs[0].state == .done }
        XCTAssertEqual(again.jobs[0].state, .done)
        XCTAssertEqual(server.creates.count, 2)
        XCTAssertNotEqual(server.creates[1]["client_upload_id"] as? String, "client-b6-0")
    }

    func testAfterARestartOnlyThePartsTheServerLacksAreSent() async throws {
        let transport = FakeDriveTransport(server: server)
        var made = try batch("b7", [("resume.bin", "0123456789")])
        // The session exists with part 1 in (an earlier run of the app); this process knows nothing of it yet.
        let created = server.handle({
            var request = URLRequest(url: URL(string: "http://drive.test/api/v1/drive/uploads")!)
            request.httpMethod = "POST"
            request.httpBody = try! JSONSerialization.data(withJSONObject: ["client_upload_id": "client-b7-0", "parent_id": "folder-1",
                                                                           "name": "resume.bin", "size_bytes": 10, "on_conflict": "fail"])
            return request
        }())
        XCTAssertEqual(created.0, 201)
        _ = server.put(uploadId: "up-1", number: 1, bytes: Data("0123".utf8), sha: made.jobs[0].sha[0])
        made.jobs[0].uploadId = "up-1"
        made.jobs[0].state = .uploading
        try store.save(made)
        await processor(transport).run("b7")
        let batch = try await settled("b7")
        XCTAssertEqual(batch.jobs[0].state, .done)
        XCTAssertEqual(transport.parts.sorted(), ["j0#2", "j0#3"])
    }

    func testAnExpiredSessionStartsOverWithANewKey() async throws {
        let transport = FakeDriveTransport(server: server)
        var made = try batch("b8", [("old.bin", "0123")])
        made.jobs[0].uploadId = "up-gone"
        try store.save(made)
        await processor(transport).run("b8")
        let batch = try await settled("b8")
        XCTAssertEqual(batch.jobs[0].state, .done)
        XCTAssertNotEqual(batch.jobs[0].clientUploadId, "client-b8-0")
        XCTAssertEqual(server.creates.count, 1)
    }

    func testANetworkFailureWaitsThenSendsThePartAgain() async throws {
        let transport = FakeDriveTransport(server: server)
        transport.dropOnce = ["j0#2"]
        try batch("b9", [("flaky.bin", "0123456789")])
        await processor(transport).run("b9")
        let batch = try await settled("b9")
        XCTAssertEqual(batch.jobs[0].state, .done)
        XCTAssertEqual(transport.parts.filter { $0 == "j0#2" }.count, 2)
    }

    func testCancelDropsTheServersSession() async throws {
        server.taken = ["keep.txt": "file"]
        let transport = FakeDriveTransport(server: server)
        try batch("b10", [("keep.txt", "abc")])
        let processor = processor(transport)
        await processor.run("b10")
        _ = try await settled("b10") { $0.jobs[0].state == .asking }
        await processor.answer(batchId: "b10", jobId: "j0", choice: .rename, all: false)
        _ = try await settled("b10")
        // A finished job is left alone; a running one is stopped and its session dropped.
        server.taken = [:]
        try batch("b11", [("stop.bin", "0123456789")])
        transport.stillRunning = []
        server.completeAnswers = ["202"]
        server.completingPolls = 1000
        await processor.run("b11")
        _ = try await settled("b11") { $0.jobs[0].state == .completing }
        await processor.cancel(batchId: "b11", jobId: "j0")
        let batch = try await settled("b11")
        XCTAssertEqual(batch.jobs[0].state, .cancelled)
        XCTAssertEqual(server.deleted, ["up-2"])
        XCTAssertTrue(transport.cancelled.contains("j0"))
    }

    func testABatchOfAnAccountThatSignedOutIsDropped() async throws {
        let transport = FakeDriveTransport(server: server)
        var made = try batch("b12", [("a.txt", "1")])
        made.generation = 7 // another session than the account's
        try store.save(made)
        await processor(transport).run("b12")
        XCTAssertNil(store.load("b12"))
        XCTAssertTrue(transport.parts.isEmpty)
    }
}
