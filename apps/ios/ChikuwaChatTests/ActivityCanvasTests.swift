import XCTest
@testable import ChikuwaChat

/// M77 (CANVAS.md §20.5): canvas mentions in the activity on the phone — the items read one at a time, the
/// `include=canvas_mention` on every activity call, the 📝 row's words, the row opening the canvas, and the badge
/// fetched again on canvas.mentioned.
@MainActor
final class ActivityCanvasTests: XCTestCase {
    private static let messageJson = """
    {"id": "m1", "channel_id": "c1", "sender_id": "u2", "seq": 5, "updated_seq": 7, "client_msg_id": "k", "body": "スライド v2 です",
     "created_at": "2026-10-02T01:00:00Z", "edited_at": null, "deleted": false}
    """

    private static let canvasJson = """
    {"item_id": "i1", "canvas_id": "cv1", "channel_id": "c1", "title": "週報", "excerpt": "…@加納 さん確認お願いします", "rev_id": "r1"}
    """

    // MARK: decoding

    func testACanvasItemDecodesAndBadOrUnknownItemsAreSkippedOneByOne() throws {
        let json = """
        {"items": [
          {"kind": "canvas_mention", "at": "2026-10-02T03:00:00Z", "message": null, "actor_ids": ["u2"], "emojis": [], "canvas": \(Self.canvasJson)},
          {"kind": "poll_vote", "at": "2026-10-02T02:50:00Z", "message": null, "actor_ids": ["u2"], "poll": {"id": "p"}},
          {"kind": "canvas_mention", "at": "2026-10-02T02:40:00Z", "message": null, "actor_ids": ["u2"]},
          {"kind": "canvas_mention", "at": "2026-10-02T02:35:00Z", "actor_ids": ["u2"], "canvas": {"canvas_id": "cv2"}},
          {"kind": "mention", "at": "2026-10-02T02:30:00Z", "message": {"id": "broken"}, "actor_ids": ["u2"]},
          42,
          {"kind": "mention", "at": "2026-10-02T02:00:00Z", "message": \(Self.messageJson), "actor_ids": ["u2"]}
         ], "next_cursor": "2026-10-02T02:00:00Z", "read_at": "2026-10-02T00:00:00Z"}
        """
        let page = try JSON.snakeDecoder.decode(ActivityListOut.self, from: Data(json.utf8))
        XCTAssertEqual(page.items.map(\.kind), ["canvas_mention", "mention"])
        let canvas = page.items[0]
        XCTAssertNil(canvas.message)
        XCTAssertEqual(canvas.canvas, ActivityCanvas(itemId: "i1", canvasId: "cv1", channelId: "c1", title: "週報",
                                                     excerpt: "…@加納 さん確認お願いします", revId: "r1"))
        XCTAssertEqual(canvas.id, "canvas_mention:i1")
        XCTAssertEqual(canvas.channelId, "c1")
        XCTAssertEqual(canvas.actorIds, ["u2"])
        XCTAssertEqual(page.items[1].id, "mention:m1")
        XCTAssertEqual(page.items[1].channelId, "c1")
        XCTAssertEqual(page.nextCursor, "2026-10-02T02:00:00Z")
        XCTAssertEqual(page.readAt, "2026-10-02T00:00:00Z")

        // A canvas item's words may be missing (its ids may not).
        let bare = try JSON.snakeDecoder.decode(ActivityItem.self, from: Data("""
        {"kind": "canvas_mention", "at": "2026-10-02T03:00:00Z", "canvas": {"item_id": "i2", "canvas_id": "cv1", "channel_id": "c1"}}
        """.utf8))
        XCTAssertEqual(bare.canvas?.title, "")
        XCTAssertEqual(bare.canvas?.excerpt, "")
        XCTAssertNil(bare.canvas?.revId)
        XCTAssertEqual(bare.actorIds, [])
    }

    func testAnUnknownKindWithAMessageIsLeftOutOfTheRows() throws {
        let json = """
        {"items": [
          {"kind": "poll_vote", "at": "2026-10-02T03:00:00Z", "message": \(Self.messageJson), "actor_ids": ["u2"]},
          {"kind": "canvas_mention", "at": "2026-10-02T02:00:00Z", "actor_ids": ["u2"], "canvas": \(Self.canvasJson)}
         ], "next_cursor": null, "read_at": "2026-10-02T00:00:00Z"}
        """
        let page = try JSON.snakeDecoder.decode(ActivityListOut.self, from: Data(json.utf8))
        XCTAssertEqual(page.items.count, 2)
        XCTAssertEqual(ActivityRules.append([], page.items).map(\.id), ["canvas_mention:i1"])
        // The same canvas item on the next page is not listed twice.
        XCTAssertEqual(ActivityRules.append(ActivityRules.append([], page.items), page.items).map(\.id), ["canvas_mention:i1"])
    }

    // MARK: query parameters

    private func makeClient() -> ApiClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        return ApiClient(baseUrl: URL(string: "http://server")!, session: URLSession(configuration: configuration))
    }

    func testEveryActivityCallAsksForCanvasItems() async throws {
        var requests: [(method: String, path: String, query: [URLQueryItem])] = []
        StubProtocol.handler = { request in
            let components = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!
            requests.append((request.httpMethod ?? "", components.path, components.queryItems ?? []))
            switch components.path {
            case "/api/v1/activity":
                return (200, Data(#"{"items": [], "next_cursor": null, "read_at": "2026-10-02T00:00:00Z"}"#.utf8))
            case "/api/v1/sync/bootstrap":
                return (200, Data("""
                {"server_time": "2026-10-02T00:00:00Z",
                 "me": {"id": "u1", "username": "kano", "display_name": "加納", "role": "member", "deactivated_at": null, "created_at": "",
                        "updated_at": "", "email": null, "must_change_password": false},
                 "users": [], "channels": [],
                 "limits": {"max_message_length": 20000, "max_attachment_bytes": 1, "max_attachments_per_message": 10},
                 "activity": {"read_at": "2026-10-02T00:00:00Z", "unread_count": 1, "mention_unread": true}}
                """.utf8))
            default:
                return (200, Data(#"{"read_at": "2026-10-02T00:00:00Z", "unread_count": 1, "mention_unread": true}"#.utf8))
            }
        }
        defer { StubProtocol.handler = nil }
        let client = makeClient()
        client.accessToken = "a"
        _ = try await client.listActivity(filter: "mentions", cursor: "2026-10-02T01:00:00Z", limit: 50)
        _ = try await client.activitySummary()
        _ = try await client.markActivityRead(readAt: "2026-10-02T01:00:00Z")
        let bootstrap = try await client.bootstrap()
        XCTAssertEqual(bootstrap.activity?.unreadCount, 1)

        XCTAssertEqual(requests.map { "\($0.method) \($0.path)" },
                       ["GET /api/v1/activity", "GET /api/v1/activity/summary", "PUT /api/v1/activity/read", "GET /api/v1/sync/bootstrap"])
        // M112: reservation notices too; M122: wiki pages.
        let kinds = ["canvas_mention", "reservation", "page_mention", "page_shared"]
        let include = kinds.map { URLQueryItem(name: "include", value: $0) }
        XCTAssertEqual(requests[0].query, [URLQueryItem(name: "filter", value: "mentions"), URLQueryItem(name: "limit", value: "50"),
                                           URLQueryItem(name: "cursor", value: "2026-10-02T01:00:00Z")] + include)
        XCTAssertEqual(requests[1].query, include)
        XCTAssertEqual(requests[2].query, include)
        XCTAssertEqual(requests[3].query, kinds.map { URLQueryItem(name: "activity_include", value: $0) })
    }

    // MARK: the row

    private func canvasItem(title: String = "週報", channelId: String = "c1") -> ActivityItem {
        ActivityItem(kind: "canvas_mention", at: "2026-10-02T03:00:00Z", message: nil, actorIds: ["u2"],
                     canvas: ActivityCanvas(itemId: "i1", canvasId: "cv1", channelId: channelId, title: title, excerpt: "…@加納 さん確認お願いします",
                                            revId: "r1"))
    }

    func testTheCanvasRowSaysWhoWhichCanvasWhereAndTheExcerpt() {
        let nameOf: (String) -> String = { $0 == "u2" ? "山田" : "メンバー" }
        let item = canvasItem()
        XCTAssertTrue(ActivityRules.headline(item, nameOf: nameOf) == ("山田", " が「週報」であなたをメンションしました"))
        XCTAssertEqual(ActivityRules.headlineText(item, nameOf: nameOf), "山田 が「週報」であなたをメンションしました")
        XCTAssertEqual(ActivityRules.whereText(item, conversation: "#輪講"), "#輪講 のキャンバス")
        XCTAssertEqual(ActivityRules.excerpt(item, users: [:]), "…@加納 さん確認お願いします")
        // Untitled: as the push says it.
        XCTAssertEqual(ActivityRules.headlineText(canvasItem(title: "  "), nameOf: nameOf), "山田 が「キャンバス」であなたをメンションしました")
        // A message's row is as before.
        let message = MessageOut(id: "m1", channelId: "c1", senderId: "u2", seq: 1, updatedSeq: 1, clientMsgId: nil, body: "**見て**", createdAt: "",
                                 editedAt: nil, deleted: false)
        let mention = ActivityItem(kind: "mention", at: "2026-10-02T03:00:00Z", message: message, actorIds: ["u2"])
        XCTAssertEqual(ActivityRules.excerpt(mention, users: [:]), "見て")
        XCTAssertEqual(ActivityRules.whereText(mention, conversation: "#輪講"), "#輪講")
        // Read like the other kinds: after the read position, a dot.
        XCTAssertTrue(ActivityRules.isUnread(item, readAt: "2026-10-02T02:59:59Z"))
        XCTAssertFalse(ActivityRules.isUnread(item, readAt: "2026-10-02T03:00:00Z"))
    }

    // MARK: opening it

    private func controller(member: Bool) -> AppController {
        let controller = AppController()
        let out = ChannelOut(id: "c1", type: "public", name: "lab", topic: nil, purpose: nil, archived: false, createdBy: nil, lastSeq: 0,
                             lastMessageAt: nil, createdAt: "", updatedAt: "", membership: member ? MembershipOut(role: "member", joinedAt: "") : nil,
                             dmUserIds: nil)
        controller.store.upsertChannel(out, isMember: member)
        return controller
    }

    /// M34: what an activity row opens goes on the activity tab's own stack, so the row chooses the canvas and leaves the
    /// pushing to the tab (true); it does not land on home / DM as the push and the notice do (no chikuwaOpenChannel).
    func testTheRowChoosesTheCanvasForTheActivityStack() async {
        let controller = controller(member: true)
        var landed: [String] = []
        let observer = NotificationCenter.default.addObserver(forName: .chikuwaOpenChannel, object: nil, queue: nil) { note in
            if let id = note.userInfo?["id"] as? String { landed.append(id) }
        }
        defer { NotificationCenter.default.removeObserver(observer) }
        let pushes = await controller.openActivityCanvas(canvasItem())
        XCTAssertTrue(pushes)
        XCTAssertEqual(controller.canvasOpen, CanvasOpen(canvasId: "cv1", channelId: "c1"))
        XCTAssertNil(controller.canvasLink)
        XCTAssertEqual(landed, [])
        // The M73 path (the foreground notice) still lands on the conversation's own tab.
        controller.canvasOpen = nil
        await controller.openCanvas("cv1", channelId: "c1")
        XCTAssertEqual(landed, ["c1"])
    }

    func testARowOfAConversationNotHereOpensTheCanvasSheet() async {
        let controller = controller(member: false)
        let pushes = await controller.openActivityCanvas(canvasItem())
        XCTAssertFalse(pushes)
        XCTAssertNil(controller.canvasOpen)
        XCTAssertEqual(controller.canvasLink, CanvasLinkTarget(id: "cv1"))
        // A message's row opens nothing here (it goes to its message).
        let other = AppController()
        let none = await other.openActivityCanvas(ActivityItem(kind: "mention", at: "2026-10-02T03:00:00Z", message: nil, actorIds: []))
        XCTAssertFalse(none)
        XCTAssertNil(other.canvasOpen)
        XCTAssertNil(other.canvasLink)
    }

    // MARK: the badge

    func testCanvasMentionedFetchesTheBadgeAgain() async throws {
        let server = FakeServer()
        let alice = server.addUser("alice")
        let bob = server.addUser("bob")
        let channel = server.createChannel("general", ownerId: alice.id)
        server.join(channel.id, bob.id)
        server.activity[bob.id] = ActivitySummary(readAt: "2026-10-02T00:00:00Z", unreadCount: 0, mentionUnread: false)
        let store = Store()
        var options = EngineOptions()
        options.reconnectMin = 0
        options.sleep = { _ in }
        options.random = { 0.5 }
        let api = server.api(for: bob.id)
        let engine = SyncEngine(api: api, connect: server.connector(for: bob.id), wsUrl: URL(string: "ws://fake")!, store: store,
                                getAccessToken: { "token" }, options: options)
        engine.isActive = { false }
        func settle() async {
            for _ in 0..<50 {
                await engine.idle()
                await Task.yield()
            }
            await engine.flushActivity()
        }
        await engine.start()
        await settle()
        let summaries = { api.calls.filter { $0 == "activitySummary" }.count }
        XCTAssertEqual(summaries(), 0)

        server.activity[bob.id] = ActivitySummary(readAt: "2026-10-02T00:00:00Z", unreadCount: 1, mentionUnread: true)
        let socket = try XCTUnwrap(server.sockets.first { $0.userId == bob.id })
        socket.deliver(.object(["type": .string("event"), "id": .number(20_001), "event": .string("canvas.mentioned"), "ts": .string("2026-10-02T03:00:00Z"),
                                "channel_id": .null, "seq": .null,
                                "data": .object(["canvas_id": .string("cv1"), "channel_id": .string(channel.id), "rev_id": .string("r1"),
                                                 "title": .string("週報"), "by_user_id": .string(alice.id)])]))
        await settle()
        XCTAssertEqual(summaries(), 1)
        XCTAssertEqual(store.activity, ActivitySummary(readAt: "2026-10-02T00:00:00Z", unreadCount: 1, mentionUnread: true))
        engine.stop()
    }
}
