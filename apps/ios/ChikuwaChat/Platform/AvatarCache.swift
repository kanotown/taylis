import CryptoKit
import Observation
import UIKit

/// Profile pictures (M14a): fetched once per (user, version) through the API and kept in memory.
/// `versions` follows the store's users; a view asks `image(for:)` and gets the initials until it arrives.
@MainActor
@Observable
final class AvatarCache {
    static let shared = AvatarCache()

    private(set) var versions: [String: String] = [:]
    private var images: [String: UIImage] = [:]
    private var loading: Set<String> = []
    var fetcher: ((String) async throws -> Data)?

    func note(_ user: UserPublic) {
        if let version = user.avatarUpdatedAt { versions[user.id] = version } else { versions.removeValue(forKey: user.id) }
    }

    func reset() {
        versions = [:]
        images = [:]
        loading = []
        fetcher = nil
    }

    /// The cached picture; starts a fetch and returns nil until it arrives (or always, without a picture).
    func image(for id: String) -> UIImage? {
        guard let version = versions[id] else { return nil }
        let key = id + "|" + version
        if let image = images[key] { return image }
        guard let fetcher, !loading.contains(key) else { return nil }
        loading.insert(key)
        Task {
            defer { loading.remove(key) }
            let escaped = version.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? version
            if let data = try? await fetcher("/api/v1/users/\(id)/avatar?v=\(escaped)"), let image = UIImage(data: data) {
                images[key] = image
            }
        }
        return nil
    }
}

/// A custom emoji's picture as drawn (`CustomEmoji.decode`): the still image, and the frames of an animated one.
final class DecodedEmoji: @unchecked Sendable { // immutable
    let still: UIImage
    let animation: EmojiAnimation?

    init(still: UIImage, animation: EmojiAnimation? = nil) {
        self.still = still
        self.animation = animation
    }

    /// Bytes of its pixels (the memory cache's cost).
    var cost: Int {
        func bytes(_ image: UIImage) -> Int { Int(image.size.width * image.scale * image.size.height * image.scale) * 4 }
        return bytes(still) + (animation?.frames.reduce(0) { $0 + bytes($1) } ?? 0)
    }
}

/// Custom emoji pictures of one server (docs/EMOJI.md §10), so that they show at once and not after a request each
/// (2026-10-15, 「毎回読み込みに結構時間かかる」): each launch and each workspace switch started with an empty store and
/// asked the server for every emoji again, behind the launch's token refresh, through the shared 10 MB URLCache that
/// attachments and API answers also churn (and that drops them after the server's one day).
/// - Disk: the image as the server sent it, one file per emoji in Caches/emoji-images/<server digest>/ (workspaces never
///   share one), with the version it was fetched for. A size cap; the least recently used go first. Cleared when the
///   account signs out or the workspace is removed (`remove(server:)`).
/// - Memory: the decoded pictures (drawn at the stored height) in an NSCache shared by every screen of the server.
/// - Network: one request per emoji in flight, at most `maxConcurrent` at once, the most recently asked first (the cells
///   on screen in a picker being scrolled).
/// - Freshness: with a version from the server (`CustomEmojiOut.imageVersion`), a stored picture is that version for
///   good. Without one (servers before it), a picture older than `revalidateAfter` is shown and fetched again behind it
///   (`revalidate`), as the server's one-day HTTP cache did: a preset whose picture was replaced (§8.2) shows the new one.
actor EmojiImageCache {
    struct Loaded {
        let image: DecodedEmoji
        /// Shown from a disk copy older than `revalidateAfter` with no version to trust: fetch it again behind it.
        let stale: Bool
    }

    nonisolated let directory: URL
    nonisolated let capacity: Int
    nonisolated let maxConcurrent: Int
    nonisolated let revalidateAfter: TimeInterval
    private nonisolated let memory = Memory()
    /// Guards the directory against a write landing after `remove(server:)` deleted it.
    private nonisolated let gate = Gate()
    private var loads: [String: Task<Loaded?, Never>] = [:]
    private var revalidating: Set<String> = []
    private var running = 0
    private var waiting: [CheckedContinuation<Void, Never>] = []
    /// The bytes on disk, counted at the first write.
    private var bytes: Int?

    init(directory: URL, capacity: Int = 40 * 1024 * 1024, maxConcurrent: Int = 6, revalidateAfter: TimeInterval = 86_400) {
        self.directory = directory
        self.capacity = capacity
        self.maxConcurrent = maxConcurrent
        self.revalidateAfter = revalidateAfter
        memory.totalCostLimit = 48 * 1024 * 1024
    }

    // MARK: one per server

    @MainActor private static var instances: [String: EmojiImageCache] = [:]

    /// The cache of a server (its normalized URL, `Workspace.serverUrl`), kept while the app runs: a workspace switched
    /// back to finds its pictures still decoded.
    @MainActor static func forServer(_ serverUrl: String) -> EmojiImageCache {
        if let cache = instances[serverUrl] { return cache }
        let cache = EmojiImageCache(directory: directory(server: serverUrl))
        instances[serverUrl] = cache
        return cache
    }

    /// Sign-out or removal of the workspace: nothing of its pictures stays, in memory or on disk.
    @MainActor static func remove(server serverUrl: String) {
        let cache = instances.removeValue(forKey: serverUrl)
        cache?.memory.removeAllObjects()
        let gate = cache?.gate ?? Gate()
        gate.close { try? FileManager.default.removeItem(at: directory(server: serverUrl)) }
    }

    static func directory(server serverUrl: String) -> URL {
        let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        let digest = SHA256.hash(data: Data(serverUrl.utf8)).prefix(16).map { String(format: "%02x", $0) }.joined()
        return caches.appendingPathComponent("emoji-images", isDirectory: true).appendingPathComponent(digest, isDirectory: true)
    }

    /// The image's path: `?v=` names the version, so a long-lived HTTP cache answer is per version too.
    static func imagePath(id: String, version: String?) -> String {
        guard let version, let escaped = version.addingPercentEncoding(withAllowedCharacters: .alphanumerics) else {
            return "/api/v1/emoji/\(id)/image"
        }
        return "/api/v1/emoji/\(id)/image?v=\(escaped)"
    }

    // MARK: loading

    /// The decoded picture if it is in memory (no disk, no network).
    nonisolated func cached(id: String, version: String?, variant: String) -> DecodedEmoji? {
        memory.object(forKey: Self.memoryKey(id, version, variant))
    }

    /// The picture of emoji `id` (`version` from the server, nil if it sends none), decoded with `decode` (`variant`
    /// names how, e.g. inline or pack size): from memory, else the disk, else `fetch`. Callers asking for the same one
    /// at once share one load; nil when it cannot be had now (offline, not an image), nothing remembered.
    func image(id: String, version: String?, variant: String, decode: @escaping (Data) -> DecodedEmoji?,
               fetch: @escaping () async throws -> Data) async -> Loaded? {
        let key = Self.memoryKey(id, version, variant)
        if let hit = memory.object(forKey: key) { return Loaded(image: hit, stale: false) }
        if let load = loads[key as String] { return await load.value }
        let load = Task { await self.load(id: id, version: version, key: key, decode: decode, fetch: fetch) }
        loads[key as String] = load
        let loaded = await load.value
        loads[key as String] = nil
        return loaded
    }

    /// Fetches a stale picture again (once at a time per emoji). The new picture when it changed, else nil.
    func revalidate(id: String, variant: String, decode: @escaping (Data) -> DecodedEmoji?,
                    fetch: @escaping () async throws -> Data) async -> DecodedEmoji? {
        guard revalidating.insert(id).inserted else { return nil }
        defer { revalidating.remove(id) }
        guard let data = await download(fetch) else { return nil }
        let previous = Self.read(file(id))
        write(id: id, version: nil, data: data) // a fresh date even when unchanged
        guard previous?.data != data, let decoded = await Self.decodeOff(data, decode) else { return nil }
        memory.setObject(decoded, forKey: Self.memoryKey(id, nil, variant), cost: decoded.cost)
        return decoded
    }

    private func load(id: String, version: String?, key: NSString, decode: @escaping (Data) -> DecodedEmoji?,
                      fetch: @escaping () async throws -> Data) async -> Loaded? {
        if let stored = await Self.readOff(file(id)), version == nil || stored.version == version,
           let decoded = await Self.decodeOff(stored.data, decode) {
            memory.setObject(decoded, forKey: key, cost: decoded.cost)
            return Loaded(image: decoded, stale: version == nil && Date().timeIntervalSince(stored.written) > revalidateAfter)
        }
        guard let data = await download(fetch), let decoded = await Self.decodeOff(data, decode) else { return nil }
        write(id: id, version: version, data: data)
        memory.setObject(decoded, forKey: key, cost: decoded.cost)
        return Loaded(image: decoded, stale: false)
    }

    /// One request, waiting for a slot: at most `maxConcurrent` run, and a freed slot goes to the latest asked.
    private func download(_ fetch: () async throws -> Data) async -> Data? {
        if running < maxConcurrent {
            running += 1
        } else {
            await withCheckedContinuation { waiting.append($0) } // the slot is handed over with `running` unchanged
        }
        defer {
            if waiting.isEmpty { running -= 1 } else { waiting.removeLast().resume() }
        }
        return try? await fetch()
    }

    // MARK: disk

    /// A file: the version (UTF-8, no newline; "" for none), a newline, then the image as the server sent it.
    private nonisolated func file(_ id: String) -> URL {
        directory.appendingPathComponent(id.replacingOccurrences(of: "/", with: "_"), isDirectory: false)
    }

    struct Stored {
        let version: String
        let data: Data
        /// When it was fetched (the file's creation: an atomic write makes a new file).
        let written: Date
    }

    nonisolated static func read(_ url: URL) -> Stored? {
        guard let raw = FileManager.default.contents(atPath: url.path), let newline = raw.firstIndex(of: 0x0A) else { return nil }
        let attributes = try? FileManager.default.attributesOfItem(atPath: url.path)
        let written = attributes?[.creationDate] as? Date ?? .distantPast
        // Least recently used: a read moves it to the back (at most hourly, not a write per draw).
        if let used = attributes?[.modificationDate] as? Date, Date().timeIntervalSince(used) > 3600 {
            try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: url.path)
        }
        return Stored(version: String(decoding: raw[raw.startIndex..<newline], as: UTF8.self),
                      data: Data(raw[raw.index(after: newline)...]), written: written)
    }

    private nonisolated static func readOff(_ url: URL) async -> Stored? {
        await Task.detached(priority: .userInitiated) { read(url) }.value
    }

    private nonisolated static func decodeOff(_ data: Data, _ decode: @escaping (Data) -> DecodedEmoji?) async -> DecodedEmoji? {
        await Task.detached(priority: .userInitiated) { decode(data) }.value
    }

    private func write(id: String, version: String?, data: Data) {
        let header = (version ?? "").replacingOccurrences(of: "\n", with: " ")
        let url = file(id)
        let previous = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
        var written = false
        gate.whileOpen {
            try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            written = (try? (Data(header.utf8) + Data([0x0A]) + data).write(to: url, options: .atomic)) != nil
        }
        guard written else { return }
        if bytes == nil { bytes = Self.entries(directory).reduce(0) { $0 + $1.size } } else { bytes! += header.utf8.count + 1 + data.count - previous }
        if let total = bytes, total > capacity { trim() }
    }

    /// Down to three quarters of the cap, the least recently used first.
    private func trim() {
        var total = 0
        let entries = Self.entries(directory).sorted { $0.used > $1.used } // newest first: those are kept
        for entry in entries {
            if total + entry.size <= capacity * 3 / 4 {
                total += entry.size
            } else {
                try? FileManager.default.removeItem(at: entry.url)
            }
        }
        bytes = total
    }

    private static func entries(_ directory: URL) -> [(url: URL, size: Int, used: Date)] {
        let keys: [URLResourceKey] = [.fileSizeKey, .contentModificationDateKey]
        let urls = (try? FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: keys)) ?? []
        return urls.map { url in
            let values = try? url.resourceValues(forKeys: Set(keys))
            return (url, values?.fileSize ?? 0, values?.contentModificationDate ?? .distantPast)
        }
    }

    private static func memoryKey(_ id: String, _ version: String?, _ variant: String) -> NSString {
        "\(id)|\(version ?? "")|\(variant)" as NSString
    }

    /// Writes to the directory happen only while it is open; closing (sign-out) waits for one under way.
    final class Gate: @unchecked Sendable { // under its lock
        private let lock = NSLock()
        private var closed = false

        func whileOpen(_ body: () -> Void) {
            lock.lock()
            defer { lock.unlock() }
            if !closed { body() }
        }

        func close(_ body: () -> Void) {
            lock.lock()
            defer { lock.unlock() }
            closed = true
            body()
        }
    }

    /// NSCache is safe from any thread.
    final class Memory: NSCache<NSString, DecodedEmoji>, @unchecked Sendable {}
}
