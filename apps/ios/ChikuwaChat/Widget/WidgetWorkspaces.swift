import AppIntents
import Foundation
import UIKit
import WidgetKit

// Which workspace a widget shows (all three widgets): each placed widget has a choice, 「アプリで開いているワークスペース」
// (the default, and what a widget placed before the choice existed keeps: no configuration = follow the app) or one of
// the signed-in workspaces. The app leaves its workspace list in the App Group (Widget/workspaces.json: the same rows it
// keeps in UserDefaults, nothing secret) so the extension can offer them and draw their tiles; a workspace whose
// snapshot the app has not written yet starts from its row and the widget reads it from the server with that account's
// shared tokens. Compiled into the app (which writes the list) and into the Widgets extension.

/// The app's workspace list as the widgets see it.
struct WidgetWorkspaceIndex: Codable, Equatable {
    /// The workspace on screen (its account).
    var active: String?
    /// Every registered workspace in the app's order, signed out ones too (their tiles; a widget set to one shows the
    /// sign-in face).
    var workspaces: [Workspace]
}

enum WidgetWorkspaces {
    static let defaultFile: URL = (SharedContainer.url ?? FileManager.default.temporaryDirectory)
        .appendingPathComponent("Widget/workspaces.json")

    /// nil: the app has not written the list yet (a build before the choice).
    static func read(_ file: URL = defaultFile) -> WidgetWorkspaceIndex? {
        guard let data = try? Data(contentsOf: file) else { return nil }
        return try? JSONDecoder().decode(WidgetWorkspaceIndex.self, from: data)
    }

    /// Writes the list. Returns whether a widget would show anything different (a workspace came, went, signed in or
    /// out, was renamed or got another icon; the unread counts the app also keeps there do not count).
    @discardableResult
    static func save(_ index: WidgetWorkspaceIndex, to file: URL = defaultFile) -> Bool {
        let old = read(file)
        guard old != index else { return false }
        if let data = try? JSONEncoder().encode(index) {
            try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
            try? data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        }
        func shown(_ index: WidgetWorkspaceIndex?) -> [String] {
            (index?.workspaces ?? []).map { [$0.account, $0.name, "\($0.isSignedIn)", $0.iconVersion ?? "", $0.colorKey].joined(separator: "\u{1}") }
        }
        return shown(old) != shown(index)
    }

    /// The signed-in workspaces a widget can be set to, in the app's order. Before the app wrote its list (the first run
    /// after the update), the accounts the widgets' snapshots name.
    static func signedIn(_ file: URL = defaultFile, snapshots: () -> [Workspace] = WidgetWorkspaces.fromSnapshots) -> [Workspace] {
        guard let index = read(file) else { return snapshots() }
        return index.workspaces.filter(\.isSignedIn)
    }

    /// The workspace of `account` while it is signed in on this device (nil: signed out, removed, never here).
    static func workspace(account: String, _ file: URL = defaultFile, snapshots: () -> [Workspace] = WidgetWorkspaces.fromSnapshots) -> Workspace? {
        signedIn(file, snapshots: snapshots).first { $0.account == account }
    }

    /// Any workspace of the list by account (signed out ones too): the header of a snapshot the app wrote.
    static func known(account: String, _ file: URL = defaultFile) -> Workspace? {
        read(file)?.workspaces.first { $0.account == account }
    }

    /// The row a face's header draws: the shown snapshot's workspace, else (nothing to show) the chosen one's — signed
    /// out, its name over the sign-in face.
    static func header(_ selection: WidgetWorkspaceSelection, account: String?, _ file: URL = defaultFile) -> Workspace? {
        if let account { return known(account: account, file) }
        if case .account(let chosen) = selection { return known(account: chosen, file) }
        return nil
    }

    /// The workspaces the snapshots of the three widgets name (the accounts the app wrote before it wrote its list).
    static func fromSnapshots() -> [Workspace] {
        var seen: [String: Workspace] = [:]
        func add(_ serverUrl: String, _ account: String, _ name: String, _ userId: String) {
            guard seen[account] == nil, account.hasPrefix(serverUrl + "|") else { return }
            seen[account] = Workspace(serverUrl: serverUrl, name: name, username: String(account.dropFirst(serverUrl.count + 1)),
                                      userId: userId.isEmpty ? nil : userId)
        }
        for s in AttendanceWidgetStore.all().values { add(s.serverUrl, s.account, s.workspaceName, s.userId) }
        for s in UnreadWidgetStore.file.read().snapshots.values { add(s.serverUrl, s.account, s.workspaceName, s.userId) }
        for s in TodayWidgetStore.file.read().snapshots.values { add(s.serverUrl, s.account, s.workspaceName, s.userId) }
        return seen.values.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }
}

/// What a widget is set to show.
enum WidgetWorkspaceSelection: Equatable {
    /// The workspace on screen in the app (the default; a widget placed before the choice).
    case followApp
    /// One workspace (its account, "server|username").
    case account(String)

    init(_ entity: WidgetWorkspaceEntity?) {
        guard let entity, entity.id != WidgetWorkspaceEntity.followAppId else {
            self = .followApp
            return
        }
        self = .account(entity.id)
    }
}

/// The workspace a widget is set to, in its configuration (the system's widget editor lists them).
struct WidgetWorkspaceEntity: AppEntity, Identifiable, Hashable {
    static let followAppId = "follow-app"

    /// The account ("server|username"), or `followAppId`.
    let id: String
    let name: String
    /// 「kano @ lab.example.jp」.
    var detail: String?

    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "ワークスペース")
    static var defaultQuery = WidgetWorkspaceQuery()

    var displayRepresentation: DisplayRepresentation {
        if id == Self.followAppId { return DisplayRepresentation(title: "アプリで開いているワークスペース") }
        if let detail { return DisplayRepresentation(title: "\(name)", subtitle: "\(detail)") }
        return DisplayRepresentation(title: "\(name)")
    }

    static var followApp: WidgetWorkspaceEntity { WidgetWorkspaceEntity(id: followAppId, name: widgetText("アプリで開いているワークスペース")) }

    init(id: String, name: String, detail: String? = nil) {
        self.id = id
        self.name = name
        self.detail = detail
    }

    init(_ workspace: Workspace) {
        self.init(id: workspace.account, name: workspace.name, detail: "\(workspace.signInName) @ \(workspace.host)")
    }

    /// The choices, the default first: 「アプリで開いているワークスペース」, then every signed-in workspace.
    static func all(_ file: URL = WidgetWorkspaces.defaultFile, snapshots: () -> [Workspace] = WidgetWorkspaces.fromSnapshots) -> [WidgetWorkspaceEntity] {
        [followApp] + WidgetWorkspaces.signedIn(file, snapshots: snapshots).map(WidgetWorkspaceEntity.init)
    }

    /// The entities of saved identifiers: a workspace that left the device keeps its id (the widget shows the sign-in
    /// face, not another workspace).
    static func resolve(_ identifiers: [String], _ file: URL = WidgetWorkspaces.defaultFile,
                        snapshots: () -> [Workspace] = WidgetWorkspaces.fromSnapshots) -> [WidgetWorkspaceEntity] {
        let list = all(file, snapshots: snapshots)
        return identifiers.map { id in
            if let known = list.first(where: { $0.id == id }) { return known }
            if let row = WidgetWorkspaces.known(account: id, file) { return WidgetWorkspaceEntity(row) }
            return WidgetWorkspaceEntity(id: id, name: widgetText("サインインしていないワークスペース"))
        }
    }
}

struct WidgetWorkspaceQuery: EntityQuery {
    init() {}

    func entities(for identifiers: [String]) async throws -> [WidgetWorkspaceEntity] { WidgetWorkspaceEntity.resolve(identifiers) }

    func suggestedEntities() async throws -> [WidgetWorkspaceEntity] { WidgetWorkspaceEntity.all() }

    func defaultResult() async -> WidgetWorkspaceEntity? { .followApp }
}

/// The three widgets' configuration: the workspace.
struct WidgetWorkspaceIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "ワークスペース"
    static var description = IntentDescription("ウィジェットに出すワークスペース。")

    /// nil (a widget placed before the choice) = 「アプリで開いているワークスペース」.
    @Parameter(title: "ワークスペース") var workspace: WidgetWorkspaceEntity?

    init() {}

    init(workspace: WidgetWorkspaceEntity?) {
        self.workspace = workspace
    }

    var selection: WidgetWorkspaceSelection { WidgetWorkspaceSelection(workspace) }
}

extension WidgetSnapshotFile {
    /// The snapshot a widget set to `selection` draws: the app's choice (`current()`), or the chosen workspace's —
    /// started from its row (`seed`) when the app has written none yet, so the widget reads it from the server. nil:
    /// nothing to show (the chosen workspace is signed out or gone: the sign-in face).
    func resolve(_ selection: WidgetWorkspaceSelection, workspace: (String) -> Workspace?, seed: (Workspace) -> Snapshot) -> Snapshot? {
        switch selection {
        case .followApp:
            return current()
        case .account(let account):
            guard let row = workspace(account) else { return nil }
            if let stored = snapshot(account: account) { return stored }
            let started = seed(row)
            save(started)
            return started
        }
    }
}

/// The workspace icons (WORKSPACES.md §3.4) the app has loaded, as files in the App Group (Widget/icons/), so the
/// widgets' headers show the same tile as the app's switcher without a request of their own.
enum WidgetWorkspaceIcons {
    static let folder: URL = (SharedContainer.url ?? FileManager.default.temporaryDirectory).appendingPathComponent("Widget/icons")

    /// One file per (server, version): `<hash of the server>-<version>.png`.
    static func file(serverUrl: String, version: String, in folder: URL = folder) -> URL {
        folder.appendingPathComponent("\(serverKey(serverUrl))-\(version.filter { $0.isLetter || $0.isNumber || $0 == "-" }).png")
    }

    static func serverKey(_ serverUrl: String) -> String {
        var hash: UInt64 = 0xcbf29ce484222325
        for byte in serverUrl.utf8 {
            hash ^= UInt64(byte)
            hash = hash &* 0x100000001b3
        }
        return String(hash, radix: 16)
    }

    /// Keeps the icon the app loaded (the older versions of that server go). Reloads the widgets when it is new.
    static func store(_ data: Data, serverUrl: String, version: String, in folder: URL = folder) {
        let target = file(serverUrl: serverUrl, version: version, in: folder)
        guard !FileManager.default.fileExists(atPath: target.path) else { return }
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let prefix = serverKey(serverUrl) + "-"
        for old in (try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? [] where old.hasPrefix(prefix) {
            try? FileManager.default.removeItem(at: folder.appendingPathComponent(old))
        }
        try? data.write(to: target, options: [.atomic])
        WidgetCenter.shared.reloadAllTimelines()
    }

    /// The icon of a workspace's current version, when the app has kept it.
    static func image(for workspace: Workspace, in folder: URL = folder) -> UIImage? {
        guard let version = workspace.iconVersion, !version.isEmpty else { return nil }
        return UIImage(contentsOfFile: file(serverUrl: workspace.serverUrl, version: version, in: folder).path)
    }
}
