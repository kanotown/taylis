import Foundation

/// What the app and its Share Extension share (MOBILE_UI.md §20): the App Group `group.jp.chikuwachat.ios` holds the
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

/// An exclusive lock between the app and its extension: `flock` on a file in the App Group. The system drops it when
/// the process ends, so a killed extension never leaves it held. One lock per file; a second holder in the same
/// process waits too (each `acquire` opens its own descriptor).
final class FileLock {
    private var fd: Int32

    private init(fd: Int32) { self.fd = fd }

    deinit { release() }

    /// Takes the lock now or returns nil (another process or holder has it).
    static func tryAcquire(_ url: URL) -> FileLock? {
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        let fd = open(url.path, O_RDWR | O_CREAT | O_CLOEXEC, 0o600)
        guard fd >= 0 else { return nil }
        guard flock(fd, LOCK_EX | LOCK_NB) == 0 else {
            close(fd)
            return nil
        }
        return FileLock(fd: fd)
    }

    /// Waits for the lock (polling, without blocking a thread) up to `timeout`; nil when it stayed taken.
    static func acquire(_ url: URL, timeout: TimeInterval) async -> FileLock? {
        let deadline = Date().addingTimeInterval(timeout)
        while true {
            if let lock = tryAcquire(url) { return lock }
            if Date() >= deadline { return nil }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
    }

    func release() {
        guard fd >= 0 else { return }
        flock(fd, LOCK_UN)
        close(fd)
        fd = -1
    }
}
