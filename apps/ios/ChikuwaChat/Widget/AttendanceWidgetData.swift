import Foundation

// The 在室状況 widget (docs/PRESENCE.md §1–§9): what the app leaves in the App Group for it, the rules it draws by and
// the two calls it makes. Compiled into the app (which writes the snapshot, AppController+Widget.swift) and into the
// Widgets extension (which reads it, refreshes it from the server and switches my state from its buttons). Nothing
// secret goes here: the tokens stay in the shared Keychain group (Keychain.swift, ShareSession.swift).

/// A state as GET /attendance answers it (the app's AttendanceStateOut, which the extension does not compile).
struct AttendanceWidgetState: Codable, Equatable, Hashable, Identifiable {
    let id: String
    /// nil = the workspace's state; else the person whose own state it is.
    let ownerId: String?
    let label: String
    var icon: String?
    let emoji: String?
    let color: String
    /// in_room / on_site / off_site / gone.
    let kind: String
    let position: Int
    var archived: Bool

    init(id: String, ownerId: String?, label: String, icon: String?, emoji: String?, color: String, kind: String, position: Int,
         archived: Bool = false) {
        self.id = id
        self.ownerId = ownerId
        self.label = label
        self.icon = icon
        self.emoji = emoji
        self.color = color
        self.kind = kind
        self.position = position
        self.archived = archived
    }

    private enum CodingKeys: String, CodingKey { case id, ownerId, label, icon, emoji, color, kind, position, archived }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        ownerId = try c.decodeIfPresent(String.self, forKey: .ownerId)
        label = try c.decode(String.self, forKey: .label)
        icon = try c.decodeIfPresent(String.self, forKey: .icon)
        emoji = try c.decodeIfPresent(String.self, forKey: .emoji)
        color = try c.decode(String.self, forKey: .color)
        kind = try c.decode(String.self, forKey: .kind)
        position = try c.decode(Int.self, forKey: .position)
        archived = try c.decodeIfPresent(Bool.self, forKey: .archived) ?? false
    }
}

/// One person's current state (GET /attendance's `entries`, PUT /attendance/me's answer).
struct AttendanceWidgetEntry: Codable, Equatable {
    let userId: String
    let stateId: String
    var since: String?
    var note: String?
}

/// GET /attendance, as far as the widget reads it.
struct AttendanceWidgetBoard: Decodable, Equatable {
    let enabled: Bool
    var states: [AttendanceWidgetState] = []
    var entries: [AttendanceWidgetEntry] = []

    private enum CodingKeys: String, CodingKey { case enabled, states, entries }

    init(enabled: Bool, states: [AttendanceWidgetState] = [], entries: [AttendanceWidgetEntry] = []) {
        self.enabled = enabled
        self.states = states
        self.entries = entries
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        enabled = try c.decode(Bool.self, forKey: .enabled)
        states = try c.decodeIfPresent([AttendanceWidgetState].self, forKey: .states) ?? []
        entries = try c.decodeIfPresent([AttendanceWidgetEntry].self, forKey: .entries) ?? []
    }
}

/// Why the widget shows what it last knew instead of the server's answer.
enum AttendanceWidgetProblem: String, Codable, Equatable {
    /// No answer (offline, timeout) or a temporary server error: 「更新できません」.
    case offline
    /// The session ended (the refresh token was refused): open the app and sign in.
    case signedOut
    /// The server refused the change (a state deleted meanwhile, the board turned off): 「変更できませんでした」.
    case refused
}

/// What the widget draws: one workspace's board as I see it, written by the app and refreshed by the widget.
struct AttendanceWidgetSnapshot: Codable, Equatable {
    /// The server (the workspace list's key) and the account ("server|username", the Keychain items' name).
    var serverUrl: String
    var account: String
    var workspaceName: String
    var userId: String
    /// false while the board is off (or I am a guest): the widget says so and has no buttons.
    var available: Bool
    /// The workspace's states and everyone's own ones (deleted ones only while someone is in them), as the server sent.
    var states: [AttendanceWidgetState]
    /// The current rows of the people on the board (active, not guests, not bots: the server's GET /attendance
    /// already leaves the others out; the app filters with its user list).
    var entries: [AttendanceWidgetEntry]
    /// Icon key → SF Symbols name (the app's AttendanceIcons, apps/shared/attendance-icons.json), so the extension
    /// draws the same pictures without a copy of the table.
    var symbols: [String: String]
    /// Colour key → the badge's solid colour 0xRRGGBB (the app's AttendancePalette, attendance-badge-colors.json).
    var colors: [String: UInt32]
    var updatedAt: Date
    /// Set when the last refresh or change failed; nil once the server answered.
    var problem: AttendanceWidgetProblem?
    /// The people on the board, for the faces of those in the room (names and initials' colours; nil in a snapshot
    /// written before they were kept). The widget's own refresh keeps them: GET /attendance names nobody.
    var people: [WidgetPerson]? = nil

    /// The snapshot is old enough for the widget to ask the server again when it is drawn (it is also asked when a
    /// refresh failed).
    static let freshFor: TimeInterval = 5 * 60

    func needsRefresh(now: Date = Date()) -> Bool {
        problem != nil || now.timeIntervalSince(updatedAt) >= Self.freshFor
    }
}

/// The widget's rules: the same as the app's (UI/Attendance.swift, the web's ui/attendance.ts) where they meet.
enum AttendanceWidgetRules {
    /// The kind counted as 「在室」 (the header chip's and the board's 「在室 n 人」).
    static let countedKind = "in_room"
    static let goneKind = "gone"
    /// The medium widget's buttons: the first four of my buttons (the workspace's default four fit exactly).
    static let mediumButtonCount = 4
    /// The badge colour of an unknown key (the palette's gray).
    static let fallbackColor: UInt32 = 0x4B5563

    static func myEntry(_ snapshot: AttendanceWidgetSnapshot) -> AttendanceWidgetEntry? {
        snapshot.entries.first { $0.userId == snapshot.userId }
    }

    static func state(_ snapshot: AttendanceWidgetSnapshot, _ id: String?) -> AttendanceWidgetState? {
        guard let id else { return nil }
        return snapshot.states.first { $0.id == id }
    }

    /// My state now (nil: none yet).
    static func myState(_ snapshot: AttendanceWidgetSnapshot) -> AttendanceWidgetState? {
        state(snapshot, myEntry(snapshot)?.stateId)
    }

    private static let japanese = Locale(identifier: "ja")

    private static func byPosition(_ a: AttendanceWidgetState, _ b: AttendanceWidgetState) -> Bool {
        a.position != b.position ? a.position < b.position : a.label.compare(b.label, locale: japanese) == .orderedAscending
    }

    /// My buttons, as in the app (AttendanceRules.myChoices): the workspace's states, then mine (deleted ones are not
    /// offered), each in its order.
    static func choices(_ snapshot: AttendanceWidgetSnapshot) -> [AttendanceWidgetState] {
        let live = snapshot.states.filter { !$0.archived }
        let workspace = live.filter { $0.ownerId == nil }.sorted(by: byPosition)
        let mine = live.filter { $0.ownerId == snapshot.userId }.sorted(by: byPosition)
        return workspace + mine
    }

    /// The medium widget's buttons: the first few of my buttons.
    static func mediumButtons(_ snapshot: AttendanceWidgetSnapshot) -> [AttendanceWidgetState] {
        snapshot.available ? Array(choices(snapshot).prefix(mediumButtonCount)) : []
    }

    /// The first of my buttons of a kind.
    static func firstChoice(_ snapshot: AttendanceWidgetSnapshot, kind: String) -> AttendanceWidgetState? {
        choices(snapshot).first { $0.kind == kind }
    }

    /// The small widget's one button (and the control's toggle): arriving and leaving are the day's two moves, so it
    /// offers the first 「帰宅」-kind state while I am in the room (any in_room state), else the first 「在室」-kind one.
    /// nil while the board has no state of that kind (or is off).
    static func toggleTarget(_ snapshot: AttendanceWidgetSnapshot) -> AttendanceWidgetState? {
        guard snapshot.available else { return nil }
        let inRoom = myState(snapshot)?.kind == countedKind
        return firstChoice(snapshot, kind: inRoom ? goneKind : countedKind)
    }

    /// Whether the control shows 「on」: my state is of the in_room kind.
    static func isInRoom(_ snapshot: AttendanceWidgetSnapshot) -> Bool { myState(snapshot)?.kind == countedKind }

    /// The people in the room (an in_room-kind state), as the face pile shows them: me first, then by arrival (who came
    /// first), then by name. Someone the snapshot has no name for is a grey 「?」.
    static func inRoomPeople(_ snapshot: AttendanceWidgetSnapshot) -> [AttendanceWidgetPersonEntry] {
        let counted = Set(snapshot.states.filter { $0.kind == countedKind }.map(\.id))
        let people = Dictionary((snapshot.people ?? []).map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        return snapshot.entries.filter { counted.contains($0.stateId) }
            .map { AttendanceWidgetPersonEntry(person: people[$0.userId] ?? .unknown($0.userId), since: $0.since ?? "", me: $0.userId == snapshot.userId) }
            .sorted { a, b in
                if a.me != b.me { return a.me }
                if a.since != b.since { return a.since < b.since }
                return a.person.name.localizedStandardCompare(b.person.name) == .orderedAscending
            }
    }

    /// The snapshot of a workspace the app has written none for yet (a widget set to it): nothing known but who I am,
    /// read from the server at once (`updatedAt` long ago). The icon and colour tables are the app's, copied from
    /// another workspace's snapshot.
    static func seed(_ workspace: Workspace, tables: AttendanceWidgetSnapshot?) -> AttendanceWidgetSnapshot {
        AttendanceWidgetSnapshot(serverUrl: workspace.serverUrl, account: workspace.account, workspaceName: workspace.name,
                                 userId: workspace.userId ?? "", available: true, states: [], entries: [],
                                 symbols: tables?.symbols ?? [:], colors: tables?.colors ?? [:], updatedAt: .distantPast, problem: nil)
    }

    /// Not read yet: a seed whose first read has not come back.
    static func isLoading(_ snapshot: AttendanceWidgetSnapshot) -> Bool { snapshot.available && snapshot.states.isEmpty }

    /// 「在室 n 人」: the people on the board whose state is of the in_room kind (the app's AttendanceRules.inRoomCount;
    /// `entries` holds only the people on the board).
    static func inRoomCount(_ snapshot: AttendanceWidgetSnapshot) -> Int {
        let counted = Set(snapshot.states.filter { $0.kind == countedKind }.map(\.id))
        return snapshot.entries.filter { counted.contains($0.stateId) }.count
    }

    /// The note a button sends, as in the app (AttendanceRules.noteForChoice): pressing my current state keeps my
    /// note, another state starts without one. The widget never edits the note.
    static func noteForChoice(_ snapshot: AttendanceWidgetSnapshot, stateId: String) -> String? {
        guard let mine = myEntry(snapshot), mine.stateId == stateId else { return nil }
        return mine.note
    }

    /// PUT /attendance/me's body (`note` null = none).
    static func setBody(stateId: String, note: String?) -> [String: Any] {
        ["state_id": stateId, "note": note.map { $0 as Any } ?? NSNull()]
    }

    enum Glyph: Equatable {
        case symbol(String)
        case emoji(String)
        case none
    }

    /// A state's picture: its icon's SF Symbol, else its emoji (a Unicode one: a custom `:name:` emoji cannot be drawn
    /// in the widget), else nothing (the name alone).
    static func glyph(_ state: AttendanceWidgetState, symbols: [String: String]) -> Glyph {
        if let key = state.icon, let symbol = symbols[key] { return .symbol(symbol) }
        if let emoji = state.emoji?.trimmingCharacters(in: .whitespaces), !emoji.isEmpty, !emoji.hasPrefix(":") { return .emoji(emoji) }
        return .none
    }

    /// A state's badge colour.
    static func color(_ state: AttendanceWidgetState, colors: [String: UInt32]) -> UInt32 {
        colors[state.color] ?? colors["gray"] ?? fallbackColor
    }

    /// After my change was answered: my row replaced, the problem gone. False when the state is not in the snapshot (a
    /// new own state): read the board again.
    static func applying(_ entry: AttendanceWidgetEntry, to snapshot: AttendanceWidgetSnapshot, now: Date = Date()) -> (AttendanceWidgetSnapshot, Bool) {
        var next = snapshot
        if let index = next.entries.firstIndex(where: { $0.userId == entry.userId }) {
            next.entries[index] = entry
        } else {
            next.entries.append(entry)
        }
        next.problem = nil
        next.updatedAt = now
        return (next, snapshot.states.contains { $0.id == entry.stateId })
    }

    /// The server's board replaces what the snapshot knew (`enabled: false`: the board is off).
    static func applying(_ board: AttendanceWidgetBoard, to snapshot: AttendanceWidgetSnapshot, now: Date = Date()) -> AttendanceWidgetSnapshot {
        var next = snapshot
        next.available = board.enabled
        next.states = board.states
        next.entries = board.entries
        next.problem = nil
        next.updatedAt = now
        return next
    }

    /// The snapshot with a failed refresh or change noted (what it showed stays).
    static func failed(_ snapshot: AttendanceWidgetSnapshot, _ failure: ShareFailure) -> AttendanceWidgetSnapshot {
        var next = snapshot
        switch failure {
        case .temporary: next.problem = .offline
        case .notSignedIn: next.problem = .signedOut
        case .refused(_, let code):
            if code == "guest_restricted" || code == "attendance_disabled" {
                next.available = false
                next.problem = nil
            } else {
                next.problem = .refused
            }
        }
        return next
    }

    /// Which workspace the widget shows: the one on screen in the app when it has the board, else the one whose board
    /// was seen last, else the one on screen (to say the board is off there).
    static func select(_ snapshots: [String: AttendanceWidgetSnapshot], active: String?) -> AttendanceWidgetSnapshot? {
        if let active, let snapshot = snapshots[active], snapshot.available { return snapshot }
        if let latest = snapshots.values.filter(\.available).max(by: { $0.updatedAt < $1.updatedAt }) { return latest }
        return active.flatMap { snapshots[$0] }
    }
}

/// One face of the pile.
struct AttendanceWidgetPersonEntry: Equatable, Identifiable {
    let person: WidgetPerson
    let since: String
    let me: Bool

    var id: String { person.id }
}

/// The widget's link into the app: `chikuwachat://attendance?server=<server URL>` opens 「在室状況」 in that workspace
/// (the scheme the app already uses for its sign-in redirect, Sso.swift).
enum AttendanceWidgetLink {
    static let scheme = "chikuwachat"
    static let host = "attendance"

    static func url(serverUrl: String?) -> URL {
        var components = URLComponents()
        components.scheme = scheme
        components.host = host
        if let serverUrl { components.queryItems = [URLQueryItem(name: "server", value: serverUrl)] }
        return components.url!
    }

    /// nil: not the widget's link; `.some(nil)`: the link without a workspace.
    static func parse(_ url: URL) -> String?? {
        guard url.scheme?.lowercased() == scheme, url.host?.lowercased() == host else { return nil }
        let server = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "server" }?.value
        return .some(server.flatMap { $0.isEmpty ? nil : $0 })
    }
}

/// The snapshots in a file of the App Group's folder (Widget/attendance.json): one per account, and which account the
/// app has on screen. A file, not the group's UserDefaults: a process that has the defaults open (the widget extension
/// stays alive between reloads) may keep reading its cached copy for a while after another process (the app, or the
/// intent run in the app's process) wrote, and the widget then showed the state from before a button press.
enum AttendanceWidgetStore {
    /// The kind of the home-screen / lock-screen widget (WidgetCenter reloads it).
    static let widgetKind = "jp.chikuwachat.ios.attendance"
    /// The Control Center / lock-screen control (iOS 18).
    static let controlKind = "jp.chikuwachat.ios.attendance.toggle"

    /// The file in the App Group (the app's own temporary folder when the build is not entitled to the group).
    static let defaultFile: URL = (SharedContainer.url ?? FileManager.default.temporaryDirectory)
        .appendingPathComponent("Widget/attendance.json")

    struct Contents: Codable, Equatable {
        var active: String?
        var snapshots: [String: AttendanceWidgetSnapshot] = [:]
    }

    static func read(_ file: URL = defaultFile) -> Contents {
        guard let data = try? Data(contentsOf: file), let contents = try? JSONDecoder().decode(Contents.self, from: data) else { return Contents() }
        return contents
    }

    private static func write(_ contents: Contents, _ file: URL) {
        guard let data = try? JSONEncoder().encode(contents) else { return }
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    static func all(_ file: URL = defaultFile) -> [String: AttendanceWidgetSnapshot] { read(file).snapshots }

    static func active(_ file: URL = defaultFile) -> String? { read(file).active }

    static func current(_ file: URL = defaultFile) -> AttendanceWidgetSnapshot? {
        let contents = read(file)
        return AttendanceWidgetRules.select(contents.snapshots, active: contents.active)
    }

    static func snapshot(account: String, _ file: URL = defaultFile) -> AttendanceWidgetSnapshot? {
        read(file).snapshots[account]
    }

    /// What a widget set to `selection` draws (WidgetSnapshotFile.resolve's rule: the app's choice among the signed-in
    /// workspaces, or the chosen workspace's snapshot, a seed when there is none yet; nil when it is signed out or gone).
    static func resolve(_ selection: WidgetWorkspaceSelection, _ file: URL = defaultFile,
                        workspace: (String) -> Workspace? = { WidgetWorkspaces.signedInWorkspace(account: $0) }) -> AttendanceWidgetSnapshot? {
        switch selection {
        case .followApp:
            let contents = read(file)
            return AttendanceWidgetRules.select(contents.snapshots.filter { workspace($0.key) != nil }, active: contents.active)
        case .account(let account):
            guard let row = workspace(account) else { return nil }
            if let stored = snapshot(account: account, file) { return stored }
            let seed = AttendanceWidgetRules.seed(row, tables: all(file).values.first { !$0.symbols.isEmpty })
            save(seed, to: file)
            return seed
        }
    }

    /// Saves one account's snapshot. Returns whether anything but its time changed (the caller reloads the widget then).
    @discardableResult
    static func save(_ snapshot: AttendanceWidgetSnapshot, active: Bool = false, to file: URL = defaultFile) -> Bool {
        var contents = read(file)
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
        write(contents, file)
        return changed
    }

    /// The account left this device (signed out or removed).
    static func remove(account: String, _ file: URL = defaultFile) {
        var contents = read(file)
        guard contents.snapshots.removeValue(forKey: account) != nil || contents.active == account else { return }
        if contents.active == account { contents.active = nil }
        write(contents, file)
    }
}

/// The widget's two calls, with the tokens the app shares (a 401 token_expired refreshes under the shared lock).
extension ShareApi {
    /// GET /attendance (`enabled: false` while off; 403 guest_restricted for a guest).
    func attendanceBoard() async throws -> AttendanceWidgetBoard { try await getJSON("/api/v1/attendance") }

    /// PUT /attendance/me: my state, with the note the app's rule keeps (AttendanceWidgetRules.noteForChoice).
    func setMyAttendance(stateId: String, note: String?) async throws -> AttendanceWidgetEntry {
        let body = AttendanceWidgetRules.setBody(stateId: stateId, note: note)
        let (data, _) = try await authorized { token in
            try await self.send(path: Self.setAttendancePath, method: "PUT", json: body, token: token, timeout: 20)
        }
        do { return try JSON.snakeDecoder.decode(AttendanceWidgetEntry.self, from: data) } catch { throw ShareFailure.temporary("decode_error") }
    }

    static let setAttendancePath = "/api/v1/attendance/me"
}

/// What the widget's buttons and the control do (in the extension's process): the change goes to the server and the
/// snapshot follows its answer; a failure keeps what was shown, with the problem noted.
enum AttendanceWidgetActions {
    /// My state → `stateId` in the account's workspace. Returns the snapshot as saved (nil: nothing to act on, or the
    /// account signed out — or in again — while the change was on its way: nothing is saved then, WIDGETS.md).
    @discardableResult
    static func setState(_ stateId: String, account: String, file: URL = AttendanceWidgetStore.defaultFile,
                         sessions: AccountSessions = .shared,
                         makeApi: (AttendanceWidgetSnapshot) -> ShareApi? = { api(for: $0) }) async -> AttendanceWidgetSnapshot? {
        let generation = sessions.generation(account: account)
        guard let snapshot = AttendanceWidgetStore.snapshot(account: account, file), snapshot.available else { return nil }
        guard let api = makeApi(snapshot) else { return nil }
        let note = AttendanceWidgetRules.noteForChoice(snapshot, stateId: stateId)
        var next: AttendanceWidgetSnapshot
        do {
            let entry = try await api.setMyAttendance(stateId: stateId, note: note)
            let (applied, known) = AttendanceWidgetRules.applying(entry, to: snapshot)
            next = applied
            if !known, let board = try? await api.attendanceBoard() { next = AttendanceWidgetRules.applying(board, to: next) }
        } catch let failure as ShareFailure {
            next = AttendanceWidgetRules.failed(snapshot, failure)
        } catch {
            next = AttendanceWidgetRules.failed(snapshot, .temporary("unknown"))
        }
        let saved = sessions.ifCurrent(account: account, generation: generation) { _ = AttendanceWidgetStore.save(next, to: file) }
        return saved ? next : nil
    }

    /// The board read again (the widget's timeline, when the snapshot is old or the last try failed). Saved only while
    /// the account is still in the session the refresh started in (AccountSessions); nil otherwise.
    @discardableResult
    static func refresh(account: String, file: URL = AttendanceWidgetStore.defaultFile, sessions: AccountSessions = .shared,
                        makeApi: (AttendanceWidgetSnapshot) -> ShareApi? = { api(for: $0) }) async -> AttendanceWidgetSnapshot? {
        let generation = sessions.generation(account: account)
        guard let snapshot = AttendanceWidgetStore.snapshot(account: account, file), let api = makeApi(snapshot) else { return nil }
        let next: AttendanceWidgetSnapshot
        do {
            next = AttendanceWidgetRules.applying(try await api.attendanceBoard(), to: snapshot)
        } catch let failure as ShareFailure {
            next = AttendanceWidgetRules.failed(snapshot, failure)
        } catch {
            next = AttendanceWidgetRules.failed(snapshot, .temporary("unknown"))
        }
        var result: AttendanceWidgetSnapshot?
        sessions.ifCurrent(account: account, generation: generation) {
            // The app wrote a newer one meanwhile (it is on screen and synced): that one stays.
            if let stored = AttendanceWidgetStore.snapshot(account: account, file), stored.updatedAt > snapshot.updatedAt {
                result = stored
            } else {
                AttendanceWidgetStore.save(next, to: file)
                result = next
            }
        }
        return result
    }

    static func api(for snapshot: AttendanceWidgetSnapshot) -> ShareApi? {
        guard let url = URL(string: snapshot.serverUrl) else { return nil }
        let api = ShareApi(baseUrl: url, account: snapshot.account)
        api.refreshRetryDelays = [1] // a widget's intent has a few seconds, not the share's half minute
        return api
    }
}
