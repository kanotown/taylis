import Foundation

/// What the app and its Share Extension share (MOBILE_UI.md §21): the App Group `group.jp.chikuwachat.ios` holds the
/// workspace list, the recent conversations of each account, the UI language and the shares waiting to be sent.
/// Nothing secret goes here: tokens stay in the Keychain (Keychain.swift).
enum SharedContainer {
    /// The Info.plist's `TaylisAppGroup`.
    static let groupId: String = (Bundle.main.object(forInfoDictionaryKey: "TaylisAppGroup") as? String) ?? "group.jp.chikuwachat.ios"

    /// The group's folder; nil when the build is not entitled to it.
    static let url: URL? = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: groupId)

    /// The group's defaults (the app's own standard defaults when there is no group, so the app keeps working).
    static let defaults: UserDefaults = UserDefaults(suiteName: groupId) ?? .standard

    static let workspacesKey = "share.workspaces"
    static let languageKey = "share.language"
    static let limitsKey = "share.limits"

    /// The workspaces as the app last saved them (Workspaces.save mirrors them here).
    static func workspaces(_ defaults: UserDefaults = defaults) -> [Workspace] {
        guard let data = defaults.data(forKey: workspacesKey) else { return [] }
        return (try? JSONDecoder().decode([Workspace].self, from: data)) ?? []
    }

    static func saveWorkspaces(_ list: [Workspace], active: String?, to defaults: UserDefaults = defaults) {
        // The active one first: the share sheet starts in it.
        let ordered = list.filter { $0.serverUrl == active } + list.filter { $0.serverUrl != active }
        if let data = try? JSONEncoder().encode(ordered) { defaults.set(data, forKey: workspacesKey) }
    }

    /// The UI language the app is in ("ja" / "en" / "zh-Hans"): the extension follows the in-app choice.
    static func language(_ defaults: UserDefaults = defaults) -> String? { defaults.string(forKey: languageKey) }
    static func saveLanguage(_ language: String, to defaults: UserDefaults = defaults) {
        if defaults.string(forKey: languageKey) != language { defaults.set(language, forKey: languageKey) }
    }

    /// The server's attachment limits of an account (bootstrap's `limits`), for checking a share before it goes.
    static func limits(account: String, _ defaults: UserDefaults = defaults) -> ShareLimits? {
        guard let data = (defaults.dictionary(forKey: limitsKey) ?? [:])[account] as? Data else { return nil }
        return try? JSONDecoder().decode(ShareLimits.self, from: data)
    }

    static func saveLimits(_ limits: ShareLimits, account: String, to defaults: UserDefaults = defaults) {
        var all = defaults.dictionary(forKey: limitsKey) ?? [:]
        guard let data = try? JSONEncoder().encode(limits), all[account] as? Data != data else { return }
        all[account] = data
        defaults.set(all, forKey: limitsKey)
    }

    /// An account's cached things go when it leaves this device.
    static func forget(account: String, _ defaults: UserDefaults = defaults) {
        var all = defaults.dictionary(forKey: limitsKey) ?? [:]
        all.removeValue(forKey: account)
        defaults.set(all, forKey: limitsKey)
        ShareDestinations.clearRecent(account: account, defaults)
    }
}

/// bootstrap's attachment limits (SECURITY.md §4: 100 MB and 10 files by default).
struct ShareLimits: Codable, Equatable {
    var maxAttachmentBytes: Int64
    var maxAttachmentsPerMessage: Int

    static let fallback = ShareLimits(maxAttachmentBytes: 100 * 1024 * 1024, maxAttachmentsPerMessage: 10)
}

/// Background time for a process that holds an App Group lock. iOS kills a suspended process that still holds a file
/// lock in a shared container (`RUNNINGBOARD 0xdead10cc`, TestFlight builds 115 and 119, 2026-10-13/14: the app went
/// to the background in the middle of a token refresh, which held `Locks/tokens.lock` across its request). So every
/// FileLock comes with an activity that keeps the process running while it is held, and when that time runs out the
/// lock is let go at once (MOBILE_UI.md §21.3). The app uses UIApplication's background tasks (AppDelegate); the
/// extensions, which cannot reach UIApplication, use ProcessInfo's expiring activities.
protocol BackgroundActivityProvider: AnyObject {
    /// Starts an activity named `name`. `expired` is called (on any thread) when the process is about to be suspended:
    /// it lets go of what it holds; the activity is ended right after it. nil: no background time is left now.
    func begin(_ name: String, expired: @escaping () -> Void) -> BackgroundActivity?
}

/// One running activity; `end` is called once the work (or the lock) is over. Ending twice does nothing.
protocol BackgroundActivity: AnyObject {
    func end()
}

/// `ProcessInfo.performExpiringActivity`, for the extensions (and the app before it has launched): the activity lasts
/// while its block runs, so the block waits on a semaphore until `end`; the system calls the block again with
/// `expired` = true when the time is up (or at once when it grants none).
final class ExpiringActivityProvider: BackgroundActivityProvider {
    private final class Activity: BackgroundActivity, @unchecked Sendable {
        let lock = NSLock()
        var granted: Bool?
        var ended = false
        let done = DispatchSemaphore(value: 0)

        func end() {
            lock.lock()
            let first = !ended
            ended = true
            lock.unlock()
            if first { done.signal() }
        }
    }

    func begin(_ name: String, expired: @escaping () -> Void) -> BackgroundActivity? {
        let activity = Activity()
        let decided = DispatchSemaphore(value: 0)
        ProcessInfo.processInfo.performExpiringActivity(withReason: name) { isExpired in
            activity.lock.lock()
            let undecided = activity.granted == nil
            if undecided { activity.granted = !isExpired }
            activity.lock.unlock()
            if isExpired {
                // Refused from the start: nothing was handed out. Later: the holder lets go now, before this returns.
                if undecided { decided.signal() } else { expired(); activity.end() }
                return
            }
            decided.signal()
            activity.done.wait()
        }
        decided.wait()
        activity.lock.lock()
        let granted = activity.granted == true
        activity.lock.unlock()
        return granted ? activity : nil
    }
}

/// An exclusive lock between the app and its extensions: `flock` on a file in the App Group. The system drops it when
/// the process ends, so a killed extension never leaves it held. One lock per file; a second holder in the same
/// process waits too (each `acquire` opens its own descriptor).
///
/// A held lock always runs under a background activity (`activities`): the process is not suspended while it holds
/// it, and when the activity expires the lock is released right there (`isHeld` turns false, then the `onExpiration`
/// handlers run). No lock is taken when the process has no background time left to hold it in.
final class FileLock: @unchecked Sendable {
    /// Where locks get their background time: the app sets UIApplication's at launch (AppDelegate).
    static var activities: BackgroundActivityProvider = ExpiringActivityProvider()

    private let state = NSLock()
    private var fd: Int32
    private var activity: BackgroundActivity?
    private var expirationHandlers: [() -> Void] = []
    private var expiredNow = false

    private init(fd: Int32) { self.fd = fd }

    deinit { release() }

    private enum Attempt {
        case acquired(FileLock)
        /// Someone else holds it.
        case busy
        /// No lock can be had now: the file cannot be opened, or the process has no background time to hold it in.
        case unavailable
    }

    private static func attempt(_ url: URL, activities: BackgroundActivityProvider) -> Attempt {
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let fd = open(url.path, O_RDWR | O_CREAT | O_CLOEXEC, 0o600)
        guard fd >= 0 else { return .unavailable }
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else {
            close(fd)
            return .busy
        }
        let lock = FileLock(fd: fd)
        guard let activity = activities.begin("Taylis lock \(url.lastPathComponent)", expired: { [weak lock] in lock?.expire() }) else {
            lock.release()
            return .unavailable
        }
        lock.state.lock()
        let stillHeld = lock.fd >= 0
        if stillHeld { lock.activity = activity }
        lock.state.unlock()
        // Expired in the moment between the two (the lock is already let go): the activity ends too.
        guard stillHeld else {
            activity.end()
            return .unavailable
        }
        return .acquired(lock)
    }

    /// Takes the lock now or returns nil (another process or holder has it, or there is no background time to hold it in).
    static func tryAcquire(_ url: URL, activities: BackgroundActivityProvider = FileLock.activities) -> FileLock? {
        if case .acquired(let lock) = attempt(url, activities: activities) { return lock }
        return nil
    }

    /// Waits for the lock (polling, without blocking a thread) up to `timeout`; nil when it stayed taken or cannot be
    /// held now.
    static func acquire(_ url: URL, timeout: TimeInterval, activities: BackgroundActivityProvider = FileLock.activities) async -> FileLock? {
        let deadline = Date().addingTimeInterval(timeout)
        while true {
            switch attempt(url, activities: activities) {
            case .acquired(let lock): return lock
            case .unavailable: return nil
            case .busy: break
            }
            if Date() >= deadline || Task.isCancelled { return nil }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
    }

    /// Waits for the lock on the calling thread (polling every few milliseconds) up to `timeout`, for a lock held only
    /// for a moment (AccountSessions); nil when it stayed taken or cannot be held now.
    static func acquireNow(_ url: URL, timeout: TimeInterval, activities: BackgroundActivityProvider = FileLock.activities) -> FileLock? {
        let deadline = Date().addingTimeInterval(timeout)
        while true {
            switch attempt(url, activities: activities) {
            case .acquired(let lock): return lock
            case .unavailable: return nil
            case .busy: break
            }
            if Date() >= deadline { return nil }
            usleep(2_000)
        }
    }

    /// Whether this holder still has the lock (false after `release`, and once the background time ran out).
    var isHeld: Bool {
        state.lock()
        defer { state.unlock() }
        return fd >= 0
    }

    /// Whether the lock was let go because the background time ran out.
    var expired: Bool {
        state.lock()
        defer { state.unlock() }
        return expiredNow
    }

    /// Runs `handler` (on any thread) when the lock is let go because the background time ran out; at once when it
    /// already was. Not after a plain `release`.
    func onExpiration(_ handler: @escaping () -> Void) {
        state.lock()
        let already = expiredNow
        if !already { expirationHandlers.append(handler) }
        state.unlock()
        if already { handler() }
    }

    /// The process is about to be suspended: the lock goes now, then the holder hears of it.
    private func expire() {
        state.lock()
        let held = fd >= 0
        if held { expiredNow = true }
        let handlers = held ? expirationHandlers : []
        state.unlock()
        release()
        handlers.forEach { $0() }
    }

    /// Lets go of the lock and closes the file, then ends the background activity. Safe to call more than once and
    /// from any thread.
    func release() {
        state.lock()
        let fd = self.fd
        self.fd = -1
        let activity = self.activity
        self.activity = nil
        expirationHandlers = []
        state.unlock()
        if fd >= 0 {
            flock(fd, LOCK_UN)
            close(fd)
        }
        activity?.end()
    }
}
