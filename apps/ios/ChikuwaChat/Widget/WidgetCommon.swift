import Foundation

// What the 未読・メンション and 今日の予定・締切 widgets share with each other (and with the app, which writes their
// snapshots): the per-account snapshot file in the App Group and the links into the app. Compiled into the app and into
// the Widgets extension, as AttendanceWidgetData.swift.

/// A snapshot one account's widget draws: kept per account, the one on screen in the app first.
protocol WidgetAccountSnapshot: Codable, Equatable {
    var account: String { get }
    var updatedAt: Date { get set }
}

/// Why a widget shows what it last knew (the 在室状況 widget's words: 「更新できません」, 「サインインし直してください」).
typealias WidgetProblem = AttendanceWidgetProblem

/// The snapshots of one widget kind in a file of the App Group (Widget/<name>.json): one per account and which account
/// the app has on screen. A file, not the group's UserDefaults, for the reason AttendanceWidgetStore gives (the
/// extension's process kept reading a cached copy).
struct WidgetSnapshotFile<Snapshot: WidgetAccountSnapshot> {
    let url: URL

    init(url: URL) { self.url = url }

    init(name: String) {
        url = (SharedContainer.url ?? FileManager.default.temporaryDirectory).appendingPathComponent("Widget/\(name).json")
    }

    struct Contents: Codable, Equatable {
        var active: String?
        var snapshots: [String: Snapshot] = [:]
    }

    func read() -> Contents {
        guard let data = try? Data(contentsOf: url), let contents = try? JSONDecoder().decode(Contents.self, from: data) else { return Contents() }
        return contents
    }

    private func write(_ contents: Contents) {
        guard let data = try? JSONEncoder().encode(contents) else { return }
        try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    /// The workspace on screen in the app, else the one written last (among the accounts `included` keeps).
    func current(_ included: (String) -> Bool = { _ in true }) -> Snapshot? {
        let contents = read()
        if let active = contents.active, included(active), let snapshot = contents.snapshots[active] { return snapshot }
        return contents.snapshots.values.filter { included($0.account) }.max { $0.updatedAt < $1.updatedAt }
    }

    func snapshot(account: String) -> Snapshot? { read().snapshots[account] }

    /// Saves one account's snapshot. Returns whether anything but its time changed (the caller reloads the widget then).
    @discardableResult
    func save(_ snapshot: Snapshot, active: Bool = false) -> Bool {
        var contents = read()
        var changed = false
        if active, contents.active != snapshot.account {
            contents.active = snapshot.account
            changed = true
        }
        if var old = contents.snapshots[snapshot.account] {
            old.updatedAt = snapshot.updatedAt
            if old != snapshot { changed = true }
        } else {
            changed = true
        }
        contents.snapshots[snapshot.account] = snapshot
        write(contents)
        return changed
    }

    /// The account left this device (signed out or removed). Returns whether there was anything of it.
    @discardableResult
    func remove(account: String) -> Bool {
        var contents = read()
        guard contents.snapshots.removeValue(forKey: account) != nil || contents.active == account else { return false }
        if contents.active == account { contents.active = nil }
        write(contents)
        return true
    }
}

/// The widgets' links into the app, on the scheme the app already uses (Sso.swift, the 在室状況 widget):
/// - `chikuwachat://attendance?server=…` — 「在室状況」 (AttendanceWidgetLink)
/// - `chikuwachat://open?server=…` — the app in that workspace, as the app icon opens it
/// - `chikuwachat://channel/<id>?server=…` — a conversation
/// - `chikuwachat://calendar?server=…`, `chikuwachat://tasks?server=…` — 「カレンダー」, 「タスク」
/// - `chikuwachat://event/<id>?channel=<id>&server=…`, `chikuwachat://task/<id>?channel=<id>&server=…` — an event or a
///   task, opened as its notification opens it (in its channel's tab, or the calendar / 「自分のタスク」 for my own)
/// Every link names the workspace (`server`, its URL as the workspace list keys it); the app switches to it first.
enum WidgetLink: Equatable {
    case attendance(server: String?)
    case open(server: String?)
    case channel(id: String, server: String?)
    case calendar(server: String?)
    case tasks(server: String?)
    case event(id: String, channelId: String?, server: String?)
    case task(id: String, channelId: String?, server: String?)

    var server: String? {
        switch self {
        case .attendance(let server), .open(let server), .calendar(let server), .tasks(let server): server
        case .channel(_, let server), .event(_, _, let server), .task(_, _, let server): server
        }
    }

    var url: URL {
        var components = URLComponents()
        components.scheme = AttendanceWidgetLink.scheme
        var items: [URLQueryItem] = []
        switch self {
        case .attendance(let server): return AttendanceWidgetLink.url(serverUrl: server)
        case .open: components.host = "open"
        case .calendar: components.host = "calendar"
        case .tasks: components.host = "tasks"
        case .channel(let id, _):
            components.host = "channel"
            components.path = "/" + id
        case .event(let id, let channelId, _), .task(let id, let channelId, _):
            components.host = { if case .event = self { return "event" } else { return "task" } }()
            components.path = "/" + id
            if let channelId { items.append(URLQueryItem(name: "channel", value: channelId)) }
        }
        if let server { items.append(URLQueryItem(name: "server", value: server)) }
        if !items.isEmpty { components.queryItems = items }
        return components.url!
    }

    /// nil: not a widget's link (the sign-in redirect, another scheme, a link without its id).
    static func parse(_ url: URL) -> WidgetLink? {
        guard url.scheme?.lowercased() == AttendanceWidgetLink.scheme, let host = url.host?.lowercased() else { return nil }
        if let server = AttendanceWidgetLink.parse(url) { return .attendance(server: server) }
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        func value(_ name: String) -> String? { query.first { $0.name == name }?.value.flatMap { $0.isEmpty ? nil : $0 } }
        let server = value("server")
        let id = url.pathComponents.dropFirst().first.flatMap { $0.isEmpty ? nil : $0 }
        switch host {
        case "open": return .open(server: server)
        case "calendar": return .calendar(server: server)
        case "tasks": return .tasks(server: server)
        case "channel": return id.map { .channel(id: $0, server: server) }
        case "event": return id.map { .event(id: $0, channelId: value("channel"), server: server) }
        case "task": return id.map { .task(id: $0, channelId: value("channel"), server: server) }
        default: return nil
        }
    }
}

extension ShareApi {
    /// A GET with query items (the `+` of a time zone offset escaped, which URLComponents leaves as it is).
    func getJSON<T: Decodable>(_ path: String, query: [URLQueryItem]) async throws -> T {
        var components = URLComponents()
        components.path = path
        components.queryItems = query
        let encoded = (components.percentEncodedQuery ?? "").replacingOccurrences(of: "+", with: "%2B")
        return try await getJSON(path + (encoded.isEmpty ? "" : "?" + encoded))
    }
}

extension WidgetProblem {
    /// A refresh's failure, as the 在室状況 widget words it (a refusal other than the session's is 「更新できません」 too:
    /// the widget changes nothing, so there is nothing that 「変更できませんでした」).
    init(_ failure: ShareFailure) {
        switch failure {
        case .notSignedIn: self = .signedOut
        case .temporary, .refused: self = .offline
        }
    }
}
