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

    func testFindsTheSameDeploymentByWorkspaceIdOrAddress() {
        let list = [Workspace(serverUrl: "https://chat.example.com", workspaceId: "w1", username: "a"),
                    Workspace(serverUrl: "http://127.0.0.1:8000", username: "b")]
        XCTAssertEqual(Workspaces.duplicate(of: "https://another-name.example.com", workspaceId: "w1", in: list)?.serverUrl, "https://chat.example.com")
        XCTAssertEqual(Workspaces.duplicate(of: "HTTP://127.0.0.1:8000/", workspaceId: "w9", in: list)?.serverUrl, "http://127.0.0.1:8000")
        XCTAssertNil(Workspaces.duplicate(of: "https://new.example.com", workspaceId: "w9", in: list))
        XCTAssertNil(Workspaces.duplicate(of: "https://new.example.com", workspaceId: nil, in: list))
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
}
