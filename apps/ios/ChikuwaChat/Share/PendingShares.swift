import Foundation

/// A share on its way (MOBILE_UI.md §21.4): what the Share Extension took in, kept in the App Group until the message
/// is posted. The files are copies in the share's own folder; `clientMsgId` makes the post idempotent, so whoever
/// sends it (the extension, the app woken by its background upload, the app on its next start) posts it once.
struct PendingShare: Codable, Equatable, Identifiable {
    var id: String
    /// The message's idempotency key (`client_msg_id`), fixed when the share is made.
    var clientMsgId: String
    var serverUrl: String
    /// "server|username": names the Keychain items of the session to send with.
    var account: String
    var channelId: String
    /// The destination's name as picked (「#general」, a DM's names), for a notice about the share.
    var channelTitle: String
    var parentId: String?
    var text: String
    var createdAt: Date
    var items: [Item]
    /// A 401 led to one refresh and one more try.
    var authRetried: Bool = false
    /// `attachment_invalid` on the post (the uploads expired, 24 h): uploaded once more.
    var reuploaded: Bool = false

    struct Item: Codable, Equatable {
        /// The copy's name in the share's `files/` folder.
        var file: String
        /// The name sent and shown.
        var filename: String
        var contentType: String
        var size: Int64
        /// The multipart boundary of the body written for it (`body-<index>`).
        var boundary: String
        /// Set once POST /attachments answered.
        var attachmentId: String? = nil
        /// The last upload's failure: an error code, "auth" (401) or "network".
        var error: String? = nil
    }

    var isUploaded: Bool { items.allSatisfy { $0.attachmentId != nil } }
    var totalBytes: Int64 { items.reduce(0) { $0 + $1.size } }
}

/// The folder of pending shares (`PendingShares/` in the App Group): `<id>/share.json`, `<id>/files/…` (the copies),
/// `<id>/body-<n>` (multipart bodies a background upload reads) and `<id>/claim.lock` (whoever sends it holds it).
struct PendingShareStore {
    let root: URL

    /// nil without the App Group.
    static let shared: PendingShareStore? = SharedContainer.url.map { PendingShareStore(root: $0.appendingPathComponent("PendingShares", isDirectory: true)) }

    /// How long a share is tried before it is given up (the app tells the person).
    static let lifetime: TimeInterval = 7 * 24 * 3600

    private var fm: FileManager { .default }

    func folder(_ id: String) -> URL { root.appendingPathComponent(id, isDirectory: true) }
    func filesFolder(_ id: String) -> URL { folder(id).appendingPathComponent("files", isDirectory: true) }
    func fileURL(_ share: PendingShare, _ index: Int) -> URL { filesFolder(share.id).appendingPathComponent(share.items[index].file) }
    func bodyURL(_ id: String, _ index: Int) -> URL { folder(id).appendingPathComponent("body-\(index)") }
    private func manifest(_ id: String) -> URL { folder(id).appendingPathComponent("share.json") }

    /// A new share's folder (its files are copied in before it is saved). Claim it first (`claim` makes the folder):
    /// an unclaimed folder without share.json is swept.
    func makeFolder(_ id: String) throws -> URL {
        try fm.createDirectory(at: filesFolder(id), withIntermediateDirectories: true)
        return folder(id)
    }

    func save(_ share: PendingShare) throws {
        try fm.createDirectory(at: folder(share.id), withIntermediateDirectories: true)
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        try encoder.encode(share).write(to: manifest(share.id), options: .atomic)
    }

    func load(_ id: String) -> PendingShare? {
        guard let data = try? Data(contentsOf: manifest(id)) else { return nil }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try? decoder.decode(PendingShare.self, from: data)
    }

    /// Every saved share, oldest first.
    func all() -> [PendingShare] {
        let ids = (try? fm.contentsOfDirectory(atPath: root.path)) ?? []
        return ids.compactMap(load).sorted { $0.createdAt < $1.createdAt }
    }

    func remove(_ id: String) { try? fm.removeItem(at: folder(id)) }

    /// The share's lock: held while one process sends it, so the app and the extension never send it at once.
    func claim(_ id: String) -> FileLock? { FileLock.tryAcquire(folder(id).appendingPathComponent("claim.lock")) }

    /// Shares older than `lifetime` are removed and returned (the app says they were not sent). A folder without
    /// share.json that nobody holds is a share sheet that closed or died before 送信 (the sheet claims its folder
    /// before anything is copied in, and holds it until the share is saved): it goes too. A share someone is
    /// sending right now is left alone.
    @discardableResult
    func sweep(now: Date = Date()) -> [PendingShare] {
        var expired: [PendingShare] = []
        let ids = (try? fm.contentsOfDirectory(atPath: root.path)) ?? []
        for id in ids {
            let share = load(id)
            if let share, now.timeIntervalSince(share.createdAt) <= Self.lifetime { continue }
            guard let lock = claim(id) else { continue }
            // Read again under the lock: the sheet may have saved it just before letting go.
            if let saved = load(id) {
                guard now.timeIntervalSince(saved.createdAt) > Self.lifetime else { lock.release(); continue }
                expired.append(saved)
            }
            remove(id)
            lock.release()
        }
        return expired
    }
}
