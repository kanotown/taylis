import UIKit
import XCTest
@testable import ChikuwaChat

/// M16c: the workspace list, its migration, duplicates, notification routing and the app badge (WORKSPACES.md).
final class WorkspacesTests: XCTestCase {
    private func defaults() -> UserDefaults {
        let name = "workspaces-tests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        return defaults
    }

    func testNormalizesWhatPeopleType() {
        XCTAssertEqual(Workspaces.normalize("chat.example.com"), "https://chat.example.com")
        XCTAssertEqual(Workspaces.normalize(" HTTPS://Chat.Example.com/ "), "https://chat.example.com")
        XCTAssertEqual(Workspaces.normalize("http://127.0.0.1:8000//"), "http://127.0.0.1:8000")
        XCTAssertEqual(Workspaces.normalize("https://example.com:443/chat/"), "https://example.com/chat")
        XCTAssertEqual(Workspaces.normalize("http://example.com:80"), "http://example.com")
        XCTAssertEqual(Workspaces.normalize("localhost:8000"), "https://localhost:8000")
        XCTAssertEqual(Workspaces.normalize("https://chat.example.com/?x=1#top"), "https://chat.example.com")
        XCTAssertEqual(Workspaces.normalize("http://[::1]:8000/"), "http://[::1]:8000")
        XCTAssertNil(Workspaces.normalize("ftp://example.com"))
        XCTAssertNil(Workspaces.normalize("https://user:pw@example.com"))
        XCTAssertNil(Workspaces.normalize("   "))
        XCTAssertNil(Workspaces.normalize("https://"))
        XCTAssertTrue(Workspaces.sameServer("https://Chat.example.com/", "chat.example.com"))
        XCTAssertFalse(Workspaces.sameServer("http://chat.example.com", "https://chat.example.com"))
        XCTAssertEqual(Workspaces.host("http://127.0.0.1:8000"), "127.0.0.1:8000")
        XCTAssertEqual(Workspaces.host("https://chat.example.com/x"), "chat.example.com")
    }

    func testTilesUseTheNameAndTheDesktopColour() {
        XCTAssertEqual(Workspaces.initials("テストチーム"), "テ")
        XCTAssertEqual(Workspaces.initials("ChikuwaChat"), "C")
        XCTAssertEqual(Workspaces.initials("dev team"), "DT")
        XCTAssertEqual(Workspaces.initials("dev-team"), "DT")
        XCTAssertEqual(Workspaces.initials("  "), "?")
        // Same hash and palette as apps/desktop/src/state/workspaces.ts.
        XCTAssertEqual(Workspaces.paletteIndex("921b4208-6ab5-4108-9ccf-9f40c3745d29"), 6)
        XCTAssertEqual(Workspaces.paletteIndex("01f9adaa-9971-404a-8985-de53986911c7"), 5)
        XCTAssertEqual(Workspace(serverUrl: "https://chat.example.com", username: "a").colorKey, "https://chat.example.com")
        XCTAssertEqual(Workspace(serverUrl: "https://chat.example.com", workspaceId: "w1", username: "a").colorKey, "w1")
    }

    func testMigratesTheSingleServerOfAnOlderInstallOnceKeepingItsSpelling() {
        let defaults = defaults()
        defaults.set("http://127.0.0.1:8000", forKey: "chikuwa.server")
        defaults.set("bob", forKey: "chikuwa.username")
        var asked: [String] = []
        let first = Workspaces.load(defaults) { asked.append($0); return true }
        XCTAssertEqual(asked, ["http://127.0.0.1:8000|bob"])
        XCTAssertEqual(first.list, [Workspace(serverUrl: "http://127.0.0.1:8000", name: "127.0.0.1:8000", username: "bob")])
        XCTAssertEqual(first.active, "http://127.0.0.1:8000")
        // The Keychain item and the local store keep their names.
        XCTAssertEqual(first.list[0].account, "http://127.0.0.1:8000|bob")
        // Saved now: a later load reads the list, not the old keys.
        defaults.set("someone-else", forKey: "chikuwa.username")
        XCTAssertEqual(Workspaces.load(defaults) { _ in true }.list.map(\.username), ["bob"])
    }

    func testAnAccountWithoutItsRefreshTokenIsNotMigrated() {
        let defaults = defaults()
        defaults.set("https://chat.example.com", forKey: "chikuwa.server")
        defaults.set("bob", forKey: "chikuwa.username")
        XCTAssertEqual(Workspaces.load(defaults) { _ in false }, Workspaces.Saved(list: [], active: nil))
        // The login form still starts from them, as before.
        XCTAssertEqual(defaults.string(forKey: "chikuwa.server"), "https://chat.example.com")
    }

    func testRoundTripsTheListAndKeepsTheOldKeysOnTheActiveWorkspace() {
        let defaults = defaults()
        let list = [Workspace(serverUrl: "https://a.example.com", workspaceId: "w1", name: "A", username: "alice", userId: "u1", badge: 3, hasUnread: true),
                    Workspace(serverUrl: "https://b.example.com", username: "carol", signedOut: true)]
        Workspaces.save(Workspaces.Saved(list: list, active: "https://b.example.com"), to: defaults)
        XCTAssertEqual(Workspaces.load(defaults) { _ in true }, Workspaces.Saved(list: list, active: "https://b.example.com"))
        XCTAssertEqual(defaults.string(forKey: "chikuwa.workspace.active"), "https://b.example.com")
        XCTAssertEqual(defaults.string(forKey: "chikuwa.server"), "https://b.example.com")
        XCTAssertEqual(defaults.string(forKey: "chikuwa.username"), "carol")
        let json = defaults.string(forKey: "chikuwa.workspaces") ?? ""
        for key in ["serverUrl", "workspaceId", "name", "username", "userId", "signedOut", "badge", "hasUnread"] {
            XCTAssertTrue(json.contains("\"\(key)\""), key)
        }
        Workspaces.save(Workspaces.Saved(list: [], active: nil), to: defaults)
        XCTAssertEqual(Workspaces.load(defaults) { _ in true }, Workspaces.Saved(list: [], active: nil))
        XCTAssertNil(defaults.string(forKey: "chikuwa.server")) // nothing left to migrate again
    }

    func testSurvivesADamagedList() {
        let defaults = defaults()
        defaults.set("{oops", forKey: "chikuwa.workspaces")
        XCTAssertEqual(Workspaces.load(defaults) { _ in true }.list, [])
        defaults.set(#"[{"serverUrl":"https://a.example.com","username":"a","badge":"x"},{"nope":true},3,{"serverUrl":"https://a.example.com","username":"dup"}]"#,
                     forKey: "chikuwa.workspaces")
        defaults.set("https://gone.example.com", forKey: "chikuwa.workspace.active")
        let loaded = Workspaces.load(defaults) { _ in true }
        XCTAssertEqual(loaded.list, [Workspace(serverUrl: "https://a.example.com", name: "a.example.com", username: "a")])
        XCTAssertEqual(loaded.active, "https://a.example.com")
    }

    /// §5.1 (2026-11-16): a registered workspace is found by its address only; a workspace_id is a server's claim.
    func testFindsTheSameDeploymentByItsAddressOnly() {
        let list = [Workspace(serverUrl: "https://chat.example.com", workspaceId: "w1", username: "a"),
                    Workspace(serverUrl: "http://127.0.0.1:8000", username: "b")]
        XCTAssertNil(Workspaces.duplicate(of: "https://another-name.example.com", in: list), "the same workspace_id is not the same workspace")
        XCTAssertEqual(Workspaces.duplicate(of: "HTTP://127.0.0.1:8000/", in: list)?.serverUrl, "http://127.0.0.1:8000")
        XCTAssertEqual(Workspaces.duplicate(of: "chat.example.com", in: list)?.serverUrl, "https://chat.example.com")
        XCTAssertNil(Workspaces.duplicate(of: "https://new.example.com", in: list))
        XCTAssertNil(Workspaces.duplicate(of: "http://chat.example.com", in: list), "http and https are two addresses")
    }

    /// §5.1: GET /server's later answers rename the workspace and change its icon, never its first workspace_id.
    func testTheFirstWorkspaceIdStays() {
        let entry = Workspace(serverUrl: "https://a.example", workspaceId: "wa", name: "A", username: "x", iconVersion: "1")
        let later = Workspaces.refreshed(entry, name: "A2", workspaceId: "wb", iconVersion: .some("2"))
        XCTAssertEqual(later.workspaceId, "wa")
        XCTAssertEqual(later.name, "A2")
        XCTAssertEqual(later.iconVersion, "2")
        XCTAssertEqual(Workspaces.refreshed(entry, name: "A", workspaceId: "wa", iconVersion: nil).iconVersion, "1", "a server before M93")
        XCTAssertNil(Workspaces.refreshed(entry, name: "A", workspaceId: "wa", iconVersion: .some(nil)).iconVersion, "the icon removed")
        // Not known yet (GET /server failed at the sign-in): the first answer is recorded.
        let unknown = Workspace(serverUrl: "https://a.example", username: "x")
        XCTAssertEqual(Workspaces.refreshed(unknown, name: "A", workspaceId: "wa", iconVersion: nil).workspaceId, "wa")
    }

    /// §7: two workspaces with one id (a server claims another's): a notification with it switches to neither, and
    /// neither's sign-out clears notifications by it.
    func testANotificationWhoseIdTwoWorkspacesHaveGoesNowhere() {
        let list = [Workspace(serverUrl: "https://a", workspaceId: "wb", username: "x"),
                    Workspace(serverUrl: "https://b", workspaceId: "wb", username: "y"),
                    Workspace(serverUrl: "https://c", workspaceId: "wc", username: "z")]
        let has: (Workspace, String) -> Bool = { _, _ in true }
        XCTAssertNil(Workspaces.route(PushPayload(workspaceId: "wb", channelId: "ch"), list: list, active: "https://c", hasChannel: has))
        XCTAssertEqual(Workspaces.route(PushPayload(workspaceId: "wc", channelId: "ch"), list: list, active: "https://a", hasChannel: has)?.serverUrl,
                       "https://c")
        XCTAssertFalse(Workspaces.ownsNotifications(list[0], in: list))
        XCTAssertFalse(Workspaces.ownsNotifications(list[1], in: list))
        XCTAssertTrue(Workspaces.ownsNotifications(list[2], in: list))
        XCTAssertTrue(Workspaces.ownsNotifications(list[0], in: [list[0], list[2]]))
        // Reading a channel clears that workspace's notifications of it, not another server's channel with the same id.
        XCTAssertTrue(PushPayload(workspaceId: "wa", channelId: "ch").isOf(channelId: "ch", workspaceId: "wa"))
        XCTAssertFalse(PushPayload(workspaceId: "wz", channelId: "ch").isOf(channelId: "ch", workspaceId: "wa"))
        XCTAssertFalse(PushPayload(workspaceId: "wa", channelId: "other").isOf(channelId: "ch", workspaceId: "wa"))
        XCTAssertTrue(PushPayload(channelId: "ch").isOf(channelId: "ch", workspaceId: "wa"), "a server without workspace_id")
        XCTAssertTrue(PushPayload(workspaceId: "wa", channelId: "ch").isOf(channelId: "ch", workspaceId: nil), "an id not known yet")
    }

    // MARK: §5.1: credentials go only to the address typed (the hostile-server review, 2026-11-16)

    private final class Recorded: @unchecked Sendable { var logins: [String] = []; var serverInfo: [String] = [] }

    /// Two servers on the stub: A (hostile) answers GET /server with B's workspace_id; B with its own. Every login is
    /// refused (nothing signs in), and recorded with the host it went to.
    @MainActor
    private func twoServers(_ recorded: Recorded) {
        StubProtocol.handler = { request in
            let host = request.url?.host ?? ""
            switch request.url?.path {
            case "/api/v1/server":
                recorded.serverInfo.append(host)
                let name = host.hasPrefix("a.") ? "A" : "B"
                return (200, Data(#"{"product":"chikuwachat","workspace_id":"wb","name":"\#(name)","api_version":"1"}"#.utf8))
            case "/api/v1/auth/login":
                recorded.logins.append(host)
                return (401, Data(#"{"error":{"code":"invalid_credentials","message":"Invalid","details":{}}}"#.utf8))
            default:
                return (404, Data(#"{"detail":"Not Found"}"#.utf8))
            }
        }
    }

    @MainActor
    private func controller(_ list: [Workspace], active: String?) -> AppController {
        let defaults = defaults()
        Workspaces.save(Workspaces.Saved(list: list, active: active), to: defaults)
        let controller = AppController(defaults: defaults)
        controller.loadWorkspacesForTesting()
        return controller
    }

    /// The exploit: A claimed B's id when it was added, then signed out. Adding B sent the password (and the 2FA code) to
    /// A's saved address. Now it goes to B's, and A's entry stays as it was.
    @MainActor
    func testAddingAServerWhoseIdAnotherClaimsSignsInToTheAddressTyped() async {
        let hostile = Workspace(serverUrl: "https://a.example", workspaceId: "wb", name: "A", username: "alice", signedOut: true)
        let controller = controller([hostile], active: hostile.serverUrl)
        URLProtocol.registerClass(StubProtocol.self)
        defer { URLProtocol.unregisterClass(StubProtocol.self); StubProtocol.handler = nil }
        let recorded = Recorded()
        twoServers(recorded)

        let outcome = await controller.signIn(server: "https://b.example", username: "bob", password: "secret", adding: true)
        if case .failed = outcome {} else { XCTFail("\(outcome)") }
        XCTAssertEqual(recorded.logins, ["b.example"])
        let withCode = await controller.signIn(server: "b.example", username: "bob", password: "secret", totpCode: "123456", adding: true)
        if case .failed = withCode {} else { XCTFail("\(withCode)") }
        XCTAssertEqual(recorded.logins, ["b.example", "b.example"])
        XCTAssertEqual(controller.workspaces, [hostile], "A's entry is untouched")

        // A signed in: adding B no longer switches to A instead.
        let signedIn = Workspace(serverUrl: "https://a.example", workspaceId: "wb", name: "A", username: "alice")
        let other = self.controller([signedIn], active: nil)
        recorded.logins = []
        let second = await other.signIn(server: "https://b.example", username: "bob", password: "secret", adding: true)
        XCTAssertNotEqual(second, .switched)
        XCTAssertEqual(recorded.logins, ["b.example"])
        XCTAssertEqual(other.workspaces, [signedIn])

        // Google: the sign-in sheet opens on B, not on A.
        let sheet = FakeWebAuthenticator { _ in throw WebAuthenticationError.cancelled }
        _ = await controller.signInWithGoogle(server: "https://b.example", adding: true, authenticator: sheet)
        XCTAssertEqual(sheet.opened.map { $0.url.host }, ["b.example"])
        // The same address (another spelling) is the registered workspace: signed in to again at its own address.
        recorded.logins = []
        _ = await controller.signIn(server: "HTTPS://A.example/", username: "alice", password: "pw", adding: true)
        XCTAssertEqual(recorded.logins, ["a.example"])
    }

    /// GET /server read again does not change a workspace_id recorded before (a server cannot take another's).
    @MainActor
    func testRefreshingServerInfoKeepsTheRecordedId() async {
        let mine = Workspace(serverUrl: "https://a.example", workspaceId: "wa", name: "A", username: "alice", signedOut: true)
        let fresh = Workspace(serverUrl: "https://b.example", name: "b.example", username: "bob", signedOut: true)
        let controller = controller([mine, fresh], active: mine.serverUrl)
        URLProtocol.registerClass(StubProtocol.self)
        defer { URLProtocol.unregisterClass(StubProtocol.self); StubProtocol.handler = nil }
        let recorded = Recorded()
        twoServers(recorded)
        await controller.refreshServerInfo()
        XCTAssertEqual(Set(recorded.serverInfo), ["a.example", "b.example"])
        XCTAssertEqual(controller.workspaces.map(\.workspaceId), ["wa", "wb"], "A keeps its id; B records its first")
        XCTAssertEqual(controller.workspaces.map(\.name), ["A", "B"])
    }

    func testRoutesANotificationToItsWorkspace() {
        let list = [Workspace(serverUrl: "https://a", workspaceId: "wa", username: "x"),
                    Workspace(serverUrl: "https://b", workspaceId: "wb", username: "y"),
                    Workspace(serverUrl: "https://c", username: "z")]
        let stores: [String: Set<String>] = ["https://b": ["ch-b"], "https://c": ["ch-c"]]
        let has: (Workspace, String) -> Bool = { stores[$0.serverUrl]?.contains($1) ?? false }
        func route(_ payload: PushPayload, active: String? = "https://a") -> String? {
            Workspaces.route(payload, list: list, active: active, hasChannel: has)?.serverUrl
        }
        XCTAssertEqual(route(PushPayload(workspaceId: "wb", channelId: "ch-x")), "https://b")
        // An id this device does not know (old server, restored deployment): the store that has the channel.
        XCTAssertEqual(route(PushPayload(workspaceId: "gone", channelId: "ch-c")), "https://c")
        XCTAssertEqual(route(PushPayload(channelId: "ch-b")), "https://b")
        // Nothing to go by: the active workspace.
        XCTAssertEqual(route(PushPayload(channelId: "nowhere")), "https://a")
        XCTAssertEqual(route(PushPayload(), active: "https://c"), "https://c")
        XCTAssertNil(Workspaces.route(PushPayload(), list: [], active: nil, hasChannel: has))

        // Routing fields sit outside `aps`; the badge is that server's count.
        let userInfo: [AnyHashable: Any] = ["aps": ["alert": ["title": "#general", "body": "hi"], "badge": 4, "thread-id": "ch"],
                                            "kind": "message", "workspace_id": "wb", "channel_id": "ch", "message_id": "m", "seq": 3]
        XCTAssertEqual(PushPayload(userInfo: userInfo), PushPayload(workspaceId: "wb", channelId: "ch", messageId: "m", badge: 4, kind: "message"))
        XCTAssertEqual(PushPayload(userInfo: ["workspace_id": "", "channel_id": NSNull()]), PushPayload())
    }

    func testOnlyTheConversationOpenInTheActiveWorkspaceStaysQuiet() {
        let active = Workspace(serverUrl: "https://a", workspaceId: "wa", username: "x")
        let other = Workspace(serverUrl: "https://b", workspaceId: "wb", username: "y")
        let open = PushPayload(workspaceId: "wa", channelId: "ch-open")
        XCTAssertFalse(Workspaces.shouldPresent(open, target: active, active: "https://a", openChannelId: "ch-open"))
        XCTAssertTrue(Workspaces.shouldPresent(PushPayload(workspaceId: "wa", channelId: "ch-other"), target: active, active: "https://a", openChannelId: "ch-open"))
        XCTAssertTrue(Workspaces.shouldPresent(open, target: active, active: "https://a", openChannelId: nil)) // no conversation open
        // Another workspace's notification always shows, even for a channel id that is open here.
        XCTAssertTrue(Workspaces.shouldPresent(PushPayload(workspaceId: "wb", channelId: "ch-open"), target: other, active: "https://a", openChannelId: "ch-open"))
        XCTAssertTrue(Workspaces.shouldPresent(PushPayload(), target: active, active: "https://a", openChannelId: "ch-open"))
    }

    func testTheAppBadgeAddsTheLastKnownCountsOfTheOthers() {
        let list = [Workspace(serverUrl: "https://a", username: "x", badge: 9),
                    Workspace(serverUrl: "https://b", username: "y", badge: 2, hasUnread: true),
                    Workspace(serverUrl: "https://c", username: "z", signedOut: true, badge: 5),
                    Workspace(serverUrl: "https://d", username: "w")]
        // The open workspace counts live (not its saved 9); a signed-out one adds nothing.
        XCTAssertEqual(Workspaces.appBadge(activeBadge: 3, active: "https://a", list: list), 5)
        XCTAssertEqual(Workspaces.appBadge(activeBadge: 0, active: "https://d", list: list), 11)
        XCTAssertEqual(list.map(\.hasNews), [true, true, false, false])
    }

    // MARK: M114 reorder on the phone (WORKSPACES.md §5.4)

    func testReordersLikeAListMoveAndAStepUpOrDown() {
        let list = ["a", "b", "c", "d"].map { Workspace(serverUrl: "https://\($0)", username: "u") }
        func hosts(_ moved: [Workspace]) -> String { moved.map { Workspaces.host($0.serverUrl) }.joined() }
        // List.onMove's offsets: the destination counts the rows before the move.
        XCTAssertEqual(hosts(Workspaces.moved(list, fromOffsets: [0], toOffset: 3)), "bcad")
        XCTAssertEqual(hosts(Workspaces.moved(list, fromOffsets: [3], toOffset: 0)), "dabc")
        XCTAssertEqual(hosts(Workspaces.moved(list, fromOffsets: [1], toOffset: 4)), "acdb")
        XCTAssertEqual(hosts(Workspaces.moved(list, fromOffsets: [2], toOffset: 2)), "abcd")
        XCTAssertEqual(hosts(Workspaces.moved(list, "https://c", by: -1)), "acbd")
        XCTAssertEqual(hosts(Workspaces.moved(list, "https://a", by: -1)), "abcd") // the top stays
        XCTAssertEqual(hosts(Workspaces.moved(list, "https://d", by: 1)), "abcd")
        XCTAssertEqual(hosts(Workspaces.moved(list, "https://x", by: 1)), "abcd")
    }

    func testTheReorderedListIsWhatTheNextStartLoads() {
        let store = defaults()
        let list = ["a", "b", "c"].map { Workspace(serverUrl: "https://\($0)", username: "u") }
        Workspaces.save(Workspaces.Saved(list: Workspaces.moved(list, "https://c", by: -1), active: "https://a"), to: store)
        let saved = Workspaces.load(store, hasCredentials: { _ in true })
        XCTAssertEqual(saved.list.map(\.serverUrl), ["https://a", "https://c", "https://b"])
        XCTAssertEqual(saved.active, "https://a")
    }

    // MARK: M93 workspace icon (WORKSPACES.md §3.4.1)

    func testServerInfoTellsAMissingIconVersionFromNone() throws {
        let with = try JSON.snakeDecoder.decode(ServerInfoOut.self, from: Data(#"{"product":"chikuwachat","workspace_id":"w1","name":"加納研究室","icon_version":"0192abc"}"#.utf8))
        XCTAssertEqual(with.iconVersion, "0192abc")
        XCTAssertTrue(with.hasIconVersion)
        let none = try JSON.snakeDecoder.decode(ServerInfoOut.self, from: Data(#"{"workspace_id":"w1","name":"A","icon_version":null}"#.utf8))
        XCTAssertNil(none.iconVersion)
        XCTAssertTrue(none.hasIconVersion)
        let old = try JSON.snakeDecoder.decode(ServerInfoOut.self, from: Data(#"{"workspace_id":"w1","name":"A"}"#.utf8))
        XCTAssertNil(old.iconVersion)
        XCTAssertFalse(old.hasIconVersion) // a server before M93: the saved version stays
        XCTAssertEqual(with, ServerInfoOut(product: "chikuwachat", workspaceId: "w1", name: "加納研究室", iconVersion: "0192abc"))
    }

    func testWorkspaceSettingsCarryTheIconVersion() throws {
        let settings = try JSON.snakeDecoder.decode(WorkspaceSettings.self, from: Data(#"{"show_membership_messages":true,"preview_before_join":true,"icon_version":"v2"}"#.utf8))
        XCTAssertEqual(settings, WorkspaceSettings(iconVersion: "v2"))
        let removed = try JSON.snakeDecoder.decode(WorkspaceSettings.self, from: Data(#"{"icon_version":null}"#.utf8))
        XCTAssertEqual(removed, WorkspaceSettings(iconVersion: .some(nil)))
        XCTAssertFalse(try JSON.snakeDecoder.decode(WorkspaceSettings.self, from: Data("{}".utf8)).hasIconVersion)
    }

    @MainActor
    func testStoreReportsTheIconOnlyWhenTheServerSendsIt() {
        let store = Store()
        var seen: [String?] = []
        store.onWorkspaceIcon = { seen.append($0) }
        store.setWorkspaceSettings(WorkspaceSettings(iconVersion: "v1"))   // bootstrap
        store.setWorkspaceSettings(WorkspaceSettings(iconVersion: .some(nil))) // the admin removed it
        store.setWorkspaceSettings(WorkspaceSettings())                       // a server before M93
        store.setWorkspaceSettings(nil)                                       // a server before M88
        XCTAssertEqual(seen, ["v1", nil])
    }

    func testTheIconVersionIsSavedWithTheWorkspace() throws {
        let defaults = defaults()
        let entry = Workspace(serverUrl: "https://a.example.com", workspaceId: "w1", name: "A", username: "alice", iconVersion: "v3")
        Workspaces.save(Workspaces.Saved(list: [entry], active: entry.serverUrl), to: defaults)
        XCTAssertEqual(Workspaces.load(defaults) { _ in true }.list.first?.iconVersion, "v3")
    }

    func testTheIconPathCarriesTheVersion() {
        XCTAssertEqual(ApiClient.serverIconPath(version: "0192-abc"), "/api/v1/server/icon?v=0192-abc")
        XCTAssertEqual(ApiClient.serverIconPath(version: "a&b=c"), "/api/v1/server/icon?v=a%26b%3Dc")
    }

    @MainActor
    func testIconCacheFetchesOncePerVersionWithoutSigningIn() async throws {
        let cache = WorkspaceIconCache()
        var asked: [String] = []
        let png = UIGraphicsImageRenderer(size: CGSize(width: 2, height: 2)).pngData { _ in }
        cache.fetcher = { server, version in
            asked.append(server + "|" + version)
            return png
        }
        var workspace = Workspace(serverUrl: "https://a.example.com", name: "A", username: "alice")
        XCTAssertNil(cache.image(for: workspace)) // no icon: the letter tile, nothing fetched
        workspace.iconVersion = "v1"
        XCTAssertNil(cache.image(for: workspace)) // loading
        for _ in 0..<50 where cache.image(for: workspace) == nil { try await Task.sleep(nanoseconds: 10_000_000) }
        XCTAssertNotNil(cache.image(for: workspace))
        workspace.iconVersion = "v2" // an admin changed it
        for _ in 0..<50 where cache.image(for: workspace) == nil { try await Task.sleep(nanoseconds: 10_000_000) }
        XCTAssertNotNil(cache.image(for: workspace))
        XCTAssertEqual(asked, ["https://a.example.com|v1", "https://a.example.com|v2"])
    }
}
