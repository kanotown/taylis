import Foundation

// The 未読・メンション widget: the app icon's number in the workspace on screen (Store.badgeCount: the conversations that
// count — unread DMs, mentions, SYNC_PROTOCOL.md §10.5's badge rule — plus followed threads' unread mentions and fired
// reminders). The app writes the snapshot from its store (AppController+UnreadWidget
// .swift); the extension draws it and, while the app is away, checks the count with GET /sync/summary (the same rule on
// the server). There is no cheap call for the rows themselves, so they are the app's last ones. No message text is kept.

/// One conversation that counts.
struct UnreadWidgetRow: Codable, Equatable, Identifiable {
    /// The channel's id.
    let id: String
    /// 「#general」, or the people of a DM (as the app's lists name it).
    let name: String
    let isDm: Bool
    /// What it adds to the badge: a DM's unread messages, else its mentions (a muted DM: its mentions).
    let count: Int
    let mentions: Int
    /// The newest message's time (ISO 8601) and who wrote it (a group DM's or a channel's; nil for a 1:1 DM, my own, a
    /// system row).
    var lastAt: String?
    var lastSender: String?
    /// A 1:1 DM's other person (their initials on their colour as the row's picture); nil otherwise.
    var avatar: WidgetPerson? = nil
    /// A group DM (several people).
    var group: Bool? = nil
}

struct UnreadWidgetSnapshot: WidgetAccountSnapshot {
    var serverUrl: String
    var account: String
    var workspaceName: String
    var userId: String
    /// The badge: the rows' counts and `others` as the app wrote them, or the server's /sync/summary (+ `others`) after
    /// the widget checked.
    var total: Int
    /// What the app icon counts besides the conversations: unread mentions in followed threads and fired reminders
    /// (GET /sync/summary does not count them: kept as the app last knew them).
    var others: Int = 0
    /// Every conversation that counts, in the widget's order (UnreadWidgetRules.inOrder).
    var rows: [UnreadWidgetRow]
    /// When the app wrote the rows.
    var rowsAt: Date
    /// When the count was last known right (the app's write, or the server's answer).
    var updatedAt: Date
    var problem: WidgetProblem?

    /// The widget checks the count with the server when the snapshot is older (or the last check failed).
    static let freshFor: TimeInterval = 15 * 60

    func needsRefresh(now: Date = Date()) -> Bool {
        problem != nil || now.timeIntervalSince(updatedAt) >= Self.freshFor
    }
}

enum UnreadWidgetRules {
    /// Rows on the medium widget and on the lock screen's rectangle.
    static let mediumRows = 3
    static let rectangularRows = 2

    /// Newest first (the DM list's order), then by name.
    static func inOrder(_ a: UnreadWidgetRow, _ b: UnreadWidgetRow) -> Bool {
        let x = a.lastAt ?? "", y = b.lastAt ?? ""
        if x != y { return x > y }
        let byName = a.name.localizedStandardCompare(b.name)
        return byName == .orderedSame ? a.id < b.id : byName == .orderedAscending
    }

    static func rowsTotal(_ rows: [UnreadWidgetRow]) -> Int { rows.reduce(0) { $0 + $1.count } }

    /// Whether the rows still add up to the count (else the server's count is newer than the app's rows).
    static func rowsCurrent(_ snapshot: UnreadWidgetSnapshot) -> Bool { snapshot.total == rowsTotal(snapshot.rows) + snapshot.others }

    /// The mentions among the rows (the small widget's 「@ n」).
    static func mentions(_ snapshot: UnreadWidgetSnapshot) -> Int { snapshot.rows.reduce(0) { $0 + $1.mentions } }

    /// What the count is made of (「@3・DM 4・スレッドなど 1」): the channels' mentions, the DMs' counts, the followed
    /// threads' mentions and reminders. nil while the rows no longer add up to the count (the server's is newer).
    struct Breakdown: Equatable {
        var mentions: Int
        var dms: Int
        var others: Int
    }

    static func breakdown(_ snapshot: UnreadWidgetSnapshot) -> Breakdown? {
        guard rowsCurrent(snapshot) else { return nil }
        let dms = snapshot.rows.filter(\.isDm).reduce(0) { $0 + $1.count }
        return Breakdown(mentions: rowsTotal(snapshot.rows) - dms, dms: dms, others: snapshot.others)
    }

    /// The snapshot of a workspace the app has written none for yet (a widget set to it): the count the app last knew
    /// for it (its switcher's), no rows, checked with the server at once.
    static func seed(_ workspace: Workspace) -> UnreadWidgetSnapshot {
        UnreadWidgetSnapshot(serverUrl: workspace.serverUrl, account: workspace.account, workspaceName: workspace.name,
                             userId: workspace.userId ?? "", total: workspace.badge ?? 0, others: 0, rows: [], rowsAt: .distantPast,
                             updatedAt: .distantPast, problem: nil)
    }

    /// The app has never listed this workspace's conversations (a seed): the count stands alone.
    static func hasRows(_ snapshot: UnreadWidgetSnapshot) -> Bool { snapshot.rowsAt != .distantPast }

    /// The server's count of the conversations (GET /sync/summary's `badge`): 0 means they were all read elsewhere, so
    /// the rows go; the app's rows stay otherwise (the widget says how old they are when they no longer add up).
    static func applying(summaryBadge badge: Int, to snapshot: UnreadWidgetSnapshot, now: Date = Date()) -> UnreadWidgetSnapshot {
        var next = snapshot
        next.total = max(0, badge) + snapshot.others
        if badge <= 0 { next.rows = [] }
        next.problem = nil
        next.updatedAt = now
        return next
    }

    static func failed(_ snapshot: UnreadWidgetSnapshot, _ failure: ShareFailure) -> UnreadWidgetSnapshot {
        var next = snapshot
        next.problem = WidgetProblem(failure)
        return next
    }
}

enum UnreadWidgetStore {
    static let widgetKind = "jp.chikuwachat.ios.unread"
    static let file = WidgetSnapshotFile<UnreadWidgetSnapshot>(name: "unread")
}

extension ShareApi {
    struct UnreadSummary: Decodable, Equatable {
        let badge: Int
        let hasUnread: Bool
    }

    /// GET /sync/summary: the workspace's badge by the app's rule (WORKSPACES.md §6).
    func unreadSummary() async throws -> UnreadSummary { try await getJSON("/api/v1/sync/summary") }
}

enum UnreadWidgetActions {
    /// The count checked with the server (the widget's timeline, when the snapshot is old or the last try failed).
    @discardableResult
    static func refresh(account: String, file: WidgetSnapshotFile<UnreadWidgetSnapshot> = UnreadWidgetStore.file,
                        makeApi: (String, String) -> ShareApi? = WidgetApis.make) async -> UnreadWidgetSnapshot? {
        guard let snapshot = file.snapshot(account: account), let api = makeApi(snapshot.serverUrl, snapshot.account) else { return nil }
        let next: UnreadWidgetSnapshot
        do {
            next = UnreadWidgetRules.applying(summaryBadge: try await api.unreadSummary().badge, to: snapshot)
        } catch let failure as ShareFailure {
            next = UnreadWidgetRules.failed(snapshot, failure)
        } catch {
            next = UnreadWidgetRules.failed(snapshot, .temporary("unknown"))
        }
        // The app wrote a newer one meanwhile: that one stays.
        if let stored = file.snapshot(account: account), stored.updatedAt > snapshot.updatedAt { return stored }
        file.save(next)
        return next
    }
}

/// The widgets' API clients: the shared tokens of an account (as the 在室状況 widget's, a short refresh retry).
enum WidgetApis {
    static func make(serverUrl: String, account: String) -> ShareApi? {
        guard let url = URL(string: serverUrl) else { return nil }
        let api = ShareApi(baseUrl: url, account: account)
        api.refreshRetryDelays = [1]
        return api
    }
}
