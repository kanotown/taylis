import SwiftUI
import XCTest
@testable import ChikuwaChat

/// M89 (docs/MEMBERSHIP.md §5): the join / leave lines (type "system" + system_event), the workspace settings, the
/// preview turned off and adding several people at once.
@MainActor
final class MembershipTests: XCTestCase {
    private let names = ["a": "Alice", "b": "Bob", "c": "Carol"]
    private func nameOf(_ id: String) -> String? { names[id] }

    private func line(_ kind: String, _ actor: String, _ ids: [String], body: String = "body") -> MessageState {
        var message = MessageOut(id: "m-\(kind)", channelId: "c1", senderId: actor, seq: 1, updatedSeq: 1, clientMsgId: nil, body: body,
                                 createdAt: "2026-10-03T10:00:00Z", editedAt: nil, deleted: false)
        message.type = "system"
        message.systemEvent = SystemEvent(kind: kind, actorId: actor, userIds: ids)
        return MessageState(message)
    }

    // MARK: 2. the line's text (the web's tests/membership.test.tsx `systemMessageText`)

    func testWritesEachKindFromTheDirectorysNames() {
        func text(_ m: MessageState) -> String { SystemMessage.text(body: m.body, event: m.systemEvent, nameOf: nameOf) }
        XCTAssertEqual(text(line("member_joined", "a", ["a"])), "Alice が参加しました")
        XCTAssertEqual(text(line("member_left", "a", ["a"])), "Alice が退出しました")
        XCTAssertEqual(text(line("members_added", "a", ["b", "c"])), "Alice が Bob、Carol を追加しました")
        XCTAssertEqual(text(line("member_removed", "a", ["b"])), "Alice が Bob を外しました")
    }

    func testFallsBackToTheBody() {
        XCTAssertEqual(SystemMessage.text(body: "old line", event: nil, nameOf: nameOf), "old line")
        XCTAssertEqual(SystemMessage.text(body: "new kind", event: SystemEvent(kind: "channel_renamed", actorId: "a"), nameOf: nameOf), "new kind")
        XCTAssertEqual(SystemMessage.text(body: "Alice が Zed を追加しました", event: SystemEvent(kind: "members_added", actorId: "a", userIds: ["zz"]),
                                          nameOf: nameOf), "Alice が Zed を追加しました")
        XCTAssertEqual(SystemMessage.text(body: "Zed が参加しました", event: SystemEvent(kind: "member_joined", actorId: "zz", userIds: ["zz"]),
                                          nameOf: nameOf), "Zed が参加しました")
    }

    func testARenamedPersonReadsWithTheNewName() {
        let store = Store()
        store.upsertUser(UserPublic(id: "a", username: "alice", displayName: "Alice", role: "member", deactivatedAt: nil, createdAt: "", updatedAt: ""))
        let m = line("member_joined", "a", ["a"], body: "Alice が参加しました")
        XCTAssertEqual(SystemMessage.text(m, users: store.users), "Alice が参加しました")
        store.upsertUser(UserPublic(id: "a", username: "alice", displayName: "Alicia", role: "member", deactivatedAt: nil, createdAt: "", updatedAt: ""))
        XCTAssertEqual(SystemMessage.text(m, users: store.users), "Alicia が参加しました")
    }

    // MARK: 1. the model and the local store

    func testDecodesSystemEventAndKeepsItInTheStore() throws {
        let json = """
        {"id":"m1","channel_id":"c1","sender_id":"a","seq":4,"updated_seq":4,"client_msg_id":null,"body":"Alice が Bob を追加しました",
         "created_at":"2026-10-03T10:00:00Z","edited_at":null,"deleted":false,"type":"system",
         "system_event":{"kind":"members_added","actor_id":"a","user_ids":["b"]}}
        """
        let message = try JSON.snakeDecoder.decode(MessageOut.self, from: Data(json.utf8))
        XCTAssertEqual(message.type, "system")
        XCTAssertEqual(message.systemEvent, SystemEvent(kind: "members_added", actorId: "a", userIds: ["b"]))
        // A person's post, and an older server: none.
        let plain = try JSON.snakeDecoder.decode(MessageOut.self, from: Data(json.replacingOccurrences(of: #""system_event":{"kind":"members_added","actor_id":"a","user_ids":["b"]}"#, with: #""other":0"#).utf8))
        XCTAssertNil(plain.systemEvent)
        let null = try JSON.snakeDecoder.decode(MessageOut.self, from: Data(json.replacingOccurrences(of: #"{"kind":"members_added","actor_id":"a","user_ids":["b"]}"#, with: "null").utf8))
        XCTAssertNil(null.systemEvent)

        // Written to disk as JSON (SQLiteStore's messages.json) and read back after a restart: the event stays.
        let state = MessageState(message)
        XCTAssertTrue(state.isSystem)
        let restored = try JSON.plainDecoder.decode(MessageState.self, from: JSON.plainEncoder.encode(state))
        XCTAssertEqual(restored.systemEvent, message.systemEvent)
        XCTAssertEqual(MessageOut(restored)?.systemEvent, message.systemEvent)
        // A row persisted before M89 has no event: its body shows.
        var old = try XCTUnwrap(JSONSerialization.jsonObject(with: JSON.plainEncoder.encode(state)) as? [String: Any])
        old.removeValue(forKey: "systemEvent"); old.removeValue(forKey: "system_event")
        let legacy = try JSON.plainDecoder.decode(MessageState.self, from: JSONSerialization.data(withJSONObject: old))
        XCTAssertNil(legacy.systemEvent)
        XCTAssertEqual(SystemMessage.text(legacy, users: [:]), "Alice が Bob を追加しました")

        let store = Store()
        store.upsertMessage(message)
        let reopened = Store.fromSnapshot(store.snapshot())
        XCTAssertEqual(reopened.message("c1", id: "m1")?.systemEvent, message.systemEvent)
    }

    func testWorkspaceSettingsDecodeWithDefaults() throws {
        let both = try JSON.snakeDecoder.decode(WorkspaceSettings.self, from: Data(#"{"show_membership_messages":false,"preview_before_join":false}"#.utf8))
        XCTAssertEqual(both, WorkspaceSettings(showMembershipMessages: false, previewBeforeJoin: false))
        XCTAssertEqual(try JSON.snakeDecoder.decode(WorkspaceSettings.self, from: Data("{}".utf8)), .defaults)
        let store = Store()
        XCTAssertTrue(store.workspaceSettings.previewBeforeJoin)
        store.setWorkspaceSettings(WorkspaceSettings(previewBeforeJoin: false))
        XCTAssertFalse(store.workspaceSettings.previewBeforeJoin)
        store.setWorkspaceSettings(nil) // a server before M88
        XCTAssertEqual(store.workspaceSettings, .defaults)
    }

    // MARK: 3. never grouped

    func testASystemLineIsNeverGrouped() {
        func post(_ id: String, _ sender: String, at: String, type: String = "user") -> MessageState {
            var message = MessageOut(id: id, channelId: "c1", senderId: sender, seq: Int(id.dropFirst())!, updatedSeq: 1, clientMsgId: nil, body: id,
                                     createdAt: at, editedAt: nil, deleted: false)
            message.type = type
            return MessageState(message)
        }
        let rows = [post("m1", "a", at: "2026-10-03T10:00:00Z"),
                    post("m2", "a", at: "2026-10-03T10:00:10Z", type: "system"),
                    post("m3", "a", at: "2026-10-03T10:00:20Z", type: "system"),
                    post("m4", "a", at: "2026-10-03T10:00:30Z")]
        let now = ISO8601DateFormatter().date(from: "2026-10-03T12:00:00Z")!
        let compact = Timeline.build(rows, firstUnreadAfterSeq: nil, meId: nil, grouping: true, now: now).compactMap { item -> Bool? in
            if case .message(_, let compact) = item { return compact } else { return nil }
        }
        XCTAssertEqual(compact, [false, false, false, false])
    }

    // MARK: 4. unread and notifications through the engine

    private func world() -> (FakeServer, UserPublic, UserPublic, ChannelOut, Store, SyncEngine) {
        let server = FakeServer()
        let alice = server.addUser("alice")
        let bob = server.addUser("bob")
        let channel = server.createChannel("general", ownerId: alice.id)
        server.join(channel.id, bob.id)
        let store = Store()
        var options = EngineOptions()
        options.sleep = { _ in }
        options.reconnectMin = 0
        let engine = SyncEngine(api: server.api(for: bob.id), connect: server.connector(for: bob.id), wsUrl: URL(string: "ws://fake")!, store: store,
                                getAccessToken: { "t" }, options: options)
        engine.isActive = { false }
        return (server, alice, bob, channel, store, engine)
    }

    private func settle(_ engine: SyncEngine) async {
        for _ in 0..<50 {
            await engine.idle()
            await Task.yield()
        }
    }

    func testASystemLineNeitherNotifiesNorCountsAsUnread() async throws {
        let (server, alice, bob, channel, store, engine) = world()
        var notified: [String] = []
        engine.onNotify = { message, _ in notified.append(message.body) }
        server.notificationDefault[bob.id] = "all"
        await engine.start()
        await settle(engine)
        await engine.openChannel(channel.id)
        await settle(engine)
        let carol = server.addUser("carol")
        try server.post(channelId: channel.id, senderId: alice.id, body: "Alice が Carol を追加しました", type: "system", advanceRead: false,
                        systemEvent: SystemEvent(kind: "members_added", actorId: alice.id, userIds: [carol.id]))
        await settle(engine)
        try server.post(channelId: channel.id, senderId: alice.id, body: "hello")
        await settle(engine)
        XCTAssertEqual(notified, ["hello"]) // level all: the post notifies, the line does not
        XCTAssertEqual(store.channel(channel.id)?.unreadCount, 1)
        let held = store.messages(channel.id).first { $0.type == "system" }
        XCTAssertEqual(held?.systemEvent?.userIds, [carol.id])
        engine.stop()
    }

    func testSettingsComeWithBootstrapAndFollowTheEvent() async throws {
        let (server, _, _, _, store, engine) = world()
        server.workspaceSettings = WorkspaceSettings(showMembershipMessages: true, previewBeforeJoin: false)
        await engine.start()
        await settle(engine)
        XCTAssertFalse(store.workspaceSettings.previewBeforeJoin)
        server.emitWorkspaceSettings(WorkspaceSettings(showMembershipMessages: false, previewBeforeJoin: true))
        await settle(engine)
        XCTAssertEqual(store.workspaceSettings, WorkspaceSettings(showMembershipMessages: false, previewBeforeJoin: true))
        engine.stop()
    }

    func testAServerBeforeM88LeavesTheDefaults() async throws {
        let (_, _, _, _, store, engine) = world()
        store.setWorkspaceSettings(WorkspaceSettings(previewBeforeJoin: false))
        await engine.start()
        await settle(engine)
        XCTAssertEqual(store.workspaceSettings, .defaults)
        engine.stop()
    }

    // MARK: 5. the preview turned off

    func testThePreviewIsRefusedByTheSettingOrTheServer() {
        XCTAssertFalse(PreviewJoin.refused(previewBeforeJoin: true, refusedByServer: false))
        XCTAssertTrue(PreviewJoin.refused(previewBeforeJoin: false, refusedByServer: false))
        XCTAssertTrue(PreviewJoin.refused(previewBeforeJoin: true, refusedByServer: true))
        XCTAssertTrue(PreviewJoin.isRefusal(ApiError.api(status: 403, code: "preview_disabled", message: "")))
        XCTAssertFalse(PreviewJoin.isRefusal(ApiError.api(status: 403, code: "not_channel_member", message: "")))
        XCTAssertFalse(PreviewJoin.isRefusal(ApiError.network(URLError(.notConnectedToInternet))))
        XCTAssertEqual(ErrorMessages.byCode["preview_disabled"], PreviewJoin.refusedTitle)
        XCTAssertNotNil(ErrorMessages.byCode["system_message_readonly"])
    }

    // MARK: 6. adding several people

    private func client() -> ApiClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        let client = ApiClient(baseUrl: URL(string: "http://server")!, session: URLSession(configuration: configuration))
        client.accessToken = "a"
        return client
    }

    private static func member(_ id: String) -> String { #"{"user_id":"\#(id)","role":"member","joined_at":""}"# }

    func testSeveralPeopleGoInOneBatch() async throws {
        var requests: [(String, String)] = []
        StubProtocol.handler = { request in
            let body = request.httpBodyStream.map { stream -> Data in
                stream.open()
                defer { stream.close() }
                var data = Data()
                var buffer = [UInt8](repeating: 0, count: 1024)
                while stream.hasBytesAvailable { let n = stream.read(&buffer, maxLength: 1024); if n <= 0 { break }; data.append(buffer, count: n) }
                return data
            } ?? request.httpBody ?? Data()
            requests.append((request.url!.path, String(decoding: body, as: UTF8.self)))
            return (200, Data("[\(Self.member("b")),\(Self.member("c"))]".utf8))
        }
        let added = try await client().addMembers(channelId: "c1", userIds: ["b", "c"])
        XCTAssertEqual(added.map(\.userId), ["b", "c"])
        XCTAssertEqual(requests.map(\.0), ["/api/v1/channels/c1/members/batch"])
        XCTAssertTrue(requests[0].1.contains(#""user_ids":["b","c"]"#), requests[0].1)
    }

    func testAServerBeforeM88IsAskedOneByOne() async throws {
        var paths: [String] = []
        StubProtocol.handler = { request in
            paths.append(request.url!.path)
            if request.url!.path.hasSuffix("/batch") {
                return (405, Data(#"{"error":{"code":"method_not_allowed","message":"Method Not Allowed","details":{}}}"#.utf8))
            }
            return (201, Data(Self.member("x").utf8))
        }
        let added = try await client().addMembers(channelId: "c1", userIds: ["b", "c"])
        XCTAssertEqual(added.count, 2)
        XCTAssertEqual(paths, ["/api/v1/channels/c1/members/batch", "/api/v1/channels/c1/members", "/api/v1/channels/c1/members"])
    }

    func testOnePersonGoesTheOldWay() async throws {
        var paths: [String] = []
        StubProtocol.handler = { request in
            paths.append(request.url!.path)
            return (201, Data(Self.member("b").utf8))
        }
        _ = try await client().addMembers(channelId: "c1", userIds: ["b"])
        XCTAssertEqual(paths, ["/api/v1/channels/c1/members"])
    }

    // MARK: 3. the row (snapshot-style: rendered off screen)

    func testTheSystemRowRendersAsOneCentredLine() throws {
        let store = Store()
        store.upsertUser(UserPublic(id: "a", username: "alice", displayName: "Alice", role: "member", deactivatedAt: nil, createdAt: "", updatedAt: ""))
        let row = SystemMessageRow(message: line("member_joined", "a", ["a"]), store: store, margin: 12).frame(width: 390)
        let renderer = ImageRenderer(content: row)
        renderer.scale = 2
        let image = try XCTUnwrap(renderer.uiImage)
        // One line of caption text with its padding: well under two lines' height.
        XCTAssertGreaterThan(image.size.height, 10)
        XCTAssertLessThan(image.size.height, 40)
    }
}
