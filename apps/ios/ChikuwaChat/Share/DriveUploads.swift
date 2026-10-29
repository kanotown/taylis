import CryptoKit
import Foundation

// Phone uploads into the drive (docs/DRIVE.md §6, §29): files picked in the app or shared from another app go up in
// parts through a background URLSession, so they carry on after the app or the share sheet leaves the screen, and
// resume from the parts the server has after a restart. Shared by the app and the Share Extension (compiled into both).

/// The upload rules the desktop's queue follows (apps/desktop/src/drive/uploads.ts), kept pure for the tests.
enum DriveUploadRules {
    /// The server's part size (§6.2: 16 MiB). A file is cut into slices of this size when it is staged; a server that
    /// answers another size has them cut again (`DriveUploadStore.reslice`).
    static let sliceBytes: Int64 = 16 * 1024 * 1024
    /// How often a completion that names parts to send again (409 drive_upload_incomplete, §28.5) is answered by sending
    /// them (then the job fails with the reason).
    static let resendRounds = 3
    /// 202 completing: asked again every 2 s, at most this many times in one go (then on the next run).
    static let completePolls = 30
    static let completePollSeconds: Double = 2
    /// A network failure or a 5xx / 429 waits 2 s, doubling to 30 s.
    static func retryDelay(attempt: Int) -> Double { min(2 * pow(2, Double(max(0, attempt - 1))), 30) }

    /// The parts of a file of `size` bytes cut at `partSize` (none for an empty file).
    static func partCount(size: Int64, partSize: Int64) -> Int {
        guard size > 0, partSize > 0 else { return 0 }
        return Int((size + partSize - 1) / partSize)
    }

    /// Byte range [start, end) of part `number` (from 1).
    static func partRange(_ number: Int, size: Int64, partSize: Int64) -> Range<Int64> {
        let start = Int64(number - 1) * partSize
        return start..<min(size, start + partSize)
    }

    /// The part numbers still to send, lowest first.
    static func missing(total: Int, received: [Int]) -> [Int] {
        let have = Set(received)
        return total > 0 ? (1...total).filter { !have.contains($0) } : []
    }

    /// Bytes of the parts the server has.
    static func sentBytes(received: [Int], size: Int64, partSize: Int64) -> Int64 {
        Set(received).reduce(Int64(0)) { sum, number in
            let range = partRange(number, size: size, partSize: partSize)
            return sum + max(0, range.upperBound - range.lowerBound)
        }
    }

    /// CF5 (docs/CHANNEL_FILES.md §12.4): the server files posts by month in its zone (`CHANNEL_FILES_TZ`, default
    /// Asia/Tokyo; it is not sent to clients): the month folder 「2026-10」 a file over the attachment limit goes into.
    static let postsZone = TimeZone(identifier: "Asia/Tokyo") ?? .current

    static func monthName(_ date: Date, zone: TimeZone = postsZone) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let parts = calendar.dateComponents([.year, .month], from: date)
        return String(format: "%04d-%02d", parts.year ?? 0, parts.month ?? 0)
    }

    /// AL3 (docs/ALBUMS.md §12): a pick of hundreds of photos is read and staged this many at a time, each group a batch
    /// of its own that starts at once.
    static let pickGroup = 20

    /// A name for a file this device made (camera, a photo without one): 「IMG_20261024_150312.jpg」.
    static func photoName(_ date: Date = Date(), ext: String = "jpg") -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = "yyyyMMdd_HHmmss"
        return "IMG_\(formatter.string(from: date)).\(ext)"
    }
}

/// Where a batch goes: a folder of a drive I can write to.
struct DriveUploadTarget: Codable, Equatable, Hashable {
    var parentId: String
    var locationId: String
    /// Shown with the uploads (「研究室ドライブ › 論文」).
    var label: String
    /// CF5 (docs/CHANNEL_FILES.md §12.4): folders below `parentId` the server finds or makes when the file completes
    /// (`relative_dir`, the month 「2026-10」 under 「投稿のファイル」); nil for a folder picked in the drive.
    var relativeDir: String? = nil
}

/// CF5: the conversation a batch was started from (a file over the attachment limit). Once a job is done its `/d/` link
/// goes into that conversation's draft (the app's composer), or — `send`, the share sheet — is posted as a message of its
/// own (the processor, `client_msg_id` = the job's id); then the job is marked `linked`, so it happens once.
struct DriveUploadComposer: Codable, Equatable, Hashable {
    var channelId: String
    var parentId: String?
    var send: Bool? = nil
}

enum DriveUploadState: String, Codable, Equatable {
    /// Waiting for its turn (its session not made yet, or parts not handed to the system yet).
    case queued
    /// A file of that name is in the folder: the person answers (version / rename / skip).
    case asking
    /// Its parts are going up.
    case uploading
    /// Waiting for the network (or a server that is briefly unwell): tried again by itself.
    case waiting
    /// The server is joining the parts (202).
    case completing
    case done
    case skipped
    case failed
    case cancelled

    /// Nothing more happens to it (failed may be retried by hand).
    var isFinished: Bool { [.done, .skipped, .cancelled, .failed].contains(self) }
    var isActive: Bool { !isFinished && self != .asking }
}

enum DriveConflictChoice: String, Codable, Equatable {
    case version, rename, skip
}

/// One file of a batch.
struct DriveUploadJob: Codable, Equatable, Identifiable {
    var id: String
    /// The session's idempotency key (§6.2): made again only when the session is gone (expired, cancelled).
    var clientUploadId: String
    var uploadId: String?
    var name: String
    var contentType: String?
    var size: Int64
    /// The file's own time (ms), when known (shown only, §6.2).
    var modifiedMs: Int64?
    /// fail (ask on a name taken) / version / rename.
    var onConflict: String = "fail"
    var state: DriveUploadState = .queued
    /// The size the slices on disk were cut at (the session's part size once it is known).
    var partSize: Int64 = DriveUploadRules.sliceBytes
    var partsTotal: Int
    /// Part numbers the server has.
    var received: [Int] = []
    /// Each slice's SHA-256 (hex), part 1 first.
    var sha: [String] = []
    /// The server's error code (or "network", "auth", "read_failed") while failed or waiting.
    var error: String?
    /// The kind of the item holding the name ("file" / "folder"), while asking.
    var existingKind: String?
    /// The question came on completing (the session exists: answered by PATCH, not by making it again).
    var askedOnComplete = false
    /// The made item, once done.
    var itemId: String?
    var resendRounds = 0
    var attempts = 0
    /// CF5: its link went into the composer's draft (or its row was taken out of the composer); nil before.
    var linked: Bool? = nil

    var sentBytes: Int64 {
        state == .done ? size : DriveUploadRules.sentBytes(received: received, size: size, partSize: partSize)
    }
}

/// One pick in the app, or one share sheet: its files, where they go, whose session sends them.
struct DriveUploadBatch: Codable, Equatable, Identifiable {
    var id: String
    var serverUrl: String
    /// "server|username": the Keychain items of the session to send with.
    var account: String
    /// The account's session it was made in (AccountSessions): signed out or in again since, it is dropped.
    var generation: Int
    var target: DriveUploadTarget
    var createdAt: Date
    var jobs: [DriveUploadJob]
    /// 「残りすべてに同じ操作」: the answer for the rest of the batch.
    var conflictAnswer: DriveConflictChoice?
    /// CF5: started from a conversation's composer (nil: from the drive, the share sheet).
    var composer: DriveUploadComposer? = nil

    var isFinished: Bool { jobs.allSatisfy(\.state.isFinished) }
    /// CF5: the share sheet's done files whose link message is not posted yet.
    var unposted: [DriveUploadJob] { composer?.send == true ? jobs.filter { $0.state == .done && $0.linked != true } : [] }
}

/// GET /drive/uploads/{id} (and POST /drive/uploads, PATCH).
struct DriveUploadSessionOut: Codable, Equatable {
    let id: String
    let clientUploadId: String
    let status: String
    let partSize: Int64
    let partsTotal: Int
    let receivedParts: [Int]
    let sizeBytes: Int64
    var itemId: String?
    var error: String?
}

/// POST /drive/uploads/{id}/complete: 200 completed (with the item; null when I can no longer read it, §28.3) or 202.
struct DriveUploadCompleteOut: Codable, Equatable {
    struct Item: Codable, Equatable { let id: String }
    let status: String
    var item: Item?
}

/// The batches on disk, in the App Group (`DriveUploads/`): `<batch>/batch.json`, `<batch>/<job>/part-<n>` (the slices a
/// background upload task reads) and `<batch>/claim.lock` (whoever drives the batch holds it).
struct DriveUploadStore {
    let root: URL

    /// nil without the App Group.
    static let shared: DriveUploadStore? = SharedContainer.url.map { DriveUploadStore(root: $0.appendingPathComponent("DriveUploads", isDirectory: true)) }

    /// A finished batch stays listed (done, failed) this long, unless cleared.
    static let keepFinished: TimeInterval = 24 * 3600
    /// A batch that never finishes (asked and never answered, failed and never retried) goes after this.
    static let lifetime: TimeInterval = 7 * 24 * 3600

    private var fm: FileManager { .default }

    func folder(_ batchId: String) -> URL { root.appendingPathComponent(batchId, isDirectory: true) }
    func partsFolder(_ batchId: String, _ jobId: String) -> URL { folder(batchId).appendingPathComponent(jobId, isDirectory: true) }
    func partURL(_ batchId: String, _ jobId: String, _ number: Int) -> URL { partsFolder(batchId, jobId).appendingPathComponent("part-\(number)") }
    private func manifest(_ batchId: String) -> URL { folder(batchId).appendingPathComponent("batch.json") }

    func save(_ batch: DriveUploadBatch) throws {
        try fm.createDirectory(at: folder(batch.id), withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        try encoder.encode(batch).write(to: manifest(batch.id), options: .atomic)
    }

    func load(_ batchId: String) -> DriveUploadBatch? {
        guard let data = try? Data(contentsOf: manifest(batchId)) else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try? decoder.decode(DriveUploadBatch.self, from: data)
    }

    /// Every batch, oldest first.
    func all() -> [DriveUploadBatch] {
        let ids = (try? fm.contentsOfDirectory(atPath: root.path)) ?? []
        return ids.compactMap(load).sorted { $0.createdAt < $1.createdAt }
    }

    func remove(_ batchId: String) { try? fm.removeItem(at: folder(batchId)) }

    /// A job's slices go once it is finished (done, skipped, cancelled, failed for good).
    func removeParts(_ batchId: String, _ jobId: String) { try? fm.removeItem(at: partsFolder(batchId, jobId)) }

    func claim(_ batchId: String) -> FileLock? { FileLock.tryAcquire(folder(batchId).appendingPathComponent("claim.lock")) }

    /// Batches past their time: finished ones after a day, any after a week; folders without batch.json that nobody
    /// holds (a pick or a share sheet that died while staging) after an hour. A batch someone drives is left alone.
    func sweep(now: Date = Date()) {
        let ids = (try? fm.contentsOfDirectory(atPath: root.path)) ?? []
        for id in ids {
            let batch = load(id)
            if let batch {
                let age = now.timeIntervalSince(batch.createdAt)
                let stale = age > Self.lifetime || (batch.isFinished && age > Self.keepFinished)
                guard stale else { continue }
            } else {
                let made = (try? fm.attributesOfItem(atPath: folder(id).path)[.modificationDate] as? Date) ?? .distantPast
                guard now.timeIntervalSince(made) > 3600 else { continue }
            }
            guard let lock = claim(id) else { continue }
            remove(id)
            lock.release()
        }
    }

    // MARK: staging

    /// Cuts a file into the job's slices (streamed: at most one slice in memory), with each slice's SHA-256. Returns
    /// the size, the slice count and the hashes.
    func stage(file source: URL, batchId: String, jobId: String, sliceBytes: Int64 = DriveUploadRules.sliceBytes) throws -> (size: Int64, parts: Int, sha: [String]) {
        let dir = partsFolder(batchId, jobId)
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        let handle = try FileHandle(forReadingFrom: source)
        defer { try? handle.close() }
        var size: Int64 = 0
        var hashes: [String] = []
        var number = 0
        while true {
            let chunk = try autoreleasepool { try handle.read(upToCount: Int(sliceBytes)) ?? Data() }
            if chunk.isEmpty { break }
            number += 1
            try chunk.write(to: partURL(batchId, jobId, number), options: .atomic)
            hashes.append(Self.hex(chunk))
            size += Int64(chunk.count)
            if Int64(chunk.count) < sliceBytes { break }
        }
        return (size, number, hashes)
    }

    /// The same for bytes in memory (a photo re-encoded as JPEG, the camera's picture).
    func stage(data: Data, batchId: String, jobId: String, sliceBytes: Int64 = DriveUploadRules.sliceBytes) throws -> (size: Int64, parts: Int, sha: [String]) {
        let dir = partsFolder(batchId, jobId)
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        var hashes: [String] = []
        var number = 0
        var offset = 0
        while offset < data.count {
            let end = min(data.count, offset + Int(sliceBytes))
            let chunk = data.subdata(in: offset..<end)
            number += 1
            try chunk.write(to: partURL(batchId, jobId, number), options: .atomic)
            hashes.append(Self.hex(chunk))
            offset = end
        }
        return (Int64(data.count), number, hashes)
    }

    /// The server answered another part size than the slices were cut at: cut them again (read in order, written anew).
    func reslice(batchId: String, job: DriveUploadJob, to partSize: Int64) throws -> (parts: Int, sha: [String]) {
        let dir = partsFolder(batchId, job.id)
        let fresh = folder(batchId).appendingPathComponent(job.id + ".new", isDirectory: true)
        try? fm.removeItem(at: fresh)
        try fm.createDirectory(at: fresh, withIntermediateDirectories: true)
        var pending = Data()
        var hashes: [String] = []
        var number = 0
        func flush(_ chunk: Data) throws {
            number += 1
            try chunk.write(to: fresh.appendingPathComponent("part-\(number)"), options: .atomic)
            hashes.append(Self.hex(chunk))
        }
        if job.partsTotal > 0 {
            for old in 1...job.partsTotal {
                pending.append(try Data(contentsOf: partURL(batchId, job.id, old)))
                while Int64(pending.count) >= partSize {
                    try flush(pending.prefix(Int(partSize)))
                    pending = Data(pending.dropFirst(Int(partSize)))
                }
            }
        }
        if !pending.isEmpty { try flush(pending) }
        try fm.removeItem(at: dir)
        try fm.moveItem(at: fresh, to: dir)
        return (number, hashes)
    }

    static func hex(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
}
