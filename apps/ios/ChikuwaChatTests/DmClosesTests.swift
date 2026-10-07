import XCTest
@testable import ChikuwaChat

/// M141 (SYNC_PROTOCOL.md §7.9, DATA_MODEL.md conversation_closes, 「会話を閉じる」): closed DMs leave every DM list
/// (favorites and my own sections too) until a new timeline message or an explicit open; closing is optimistic (hidden,
/// unpinned, read) and goes back when the server refuses.
@MainActor
final class DmClosesTests: XCTestCase {
    private func channel(_ id: String, type: String = "public", dm: [String]? = nil, day: Int = 1, unread: Int = 0) -> ChannelState {
        let out = ChannelOut(id: id, type: type, name: dm == nil ? id : nil, topic: nil, purpose: nil, archived: false, createdBy: nil, lastSeq: 5,
                             lastMessageAt: String(format: "2026-09-%02dT00:00:00Z", day), createdAt: "2026-01-01T00:00:00Z", updatedAt: "",
                             membership: nil, dmUserIds: dm)
        return ChannelState(channel: out, isMember: true, syncedSeq: nil, lastSeq: 5, lastReadSeq: 5 - unread, unreadCount: unread,
                            mentionCount: unread > 0 ? 1 : 0, hasOlder: true)
    }

    private func dm(_ id: String, day: Int, unread: Int = 0) -> ChannelState { channel(id, type: "dm", dm: ["me", id], day: day, unread: unread) }

    private var sample: [ChannelState] {
        [
            channel("general"),
            dm("a", day: 1), dm("b", day: 2), dm("c", day: 3, unread: 2),
            channel("group", type: "group_dm", dm: ["me", "a", "b"], day: 4),
            channel("notes", type: "dm", dm: ["me"], day: 5),
        ]
    }

    // MARK: hiding

    func testTheDmTabLeavesClosedOnesOutAndShowsNoPlaceholderForMyClosedNotes() {
        XCTAssertEqual(DMList.ordered(sample, meId: "me", closed: ["b", "group"]).map(\.id), ["notes", "c", "a"])
        // A closed one stays out even when pinned.
        XCTAssertEqual(DMList.ordered(sample, meId: "me", pins: ["b", "a"], closed: ["b"]).map(\.id), ["a", "notes", "group", "c"])
        // My DM with myself closed: hidden, and it exists, so no row stands in for it.
        XCTAssertEqual(DMList.ordered(sample, meId: "me", closed: ["notes"]).map(\.id), ["group", "c", "b", "a"])
        XCTAssertFalse(DMList.notesMissing(sample, meId: "me"))
    }

    func testTheHomeHidesClosedOnesInEverySection() {
        let section = SidebarSectionOut(id: "s1", name: "研究", position: 0, channelIds: ["general", "b"], collapsed: false)
        var input = HomeSections.Input(channels: sample, meId: "me", favorites: ["a"], dmPins: ["c"], sections: [section])
        input.closedDms = ["a", "b", "c", "notes"]
        let layout = HomeSections.build(input)
        XCTAssertEqual(layout.favorites.ids, [])
        XCTAssertEqual(layout.custom.first?.rows.ids, ["general"])
        XCTAssertEqual(layout.dms.ids, ["group"])
        XCTAssertFalse(layout.notesRow)  // my notes exist, closed: no placeholder
        // 「未読をまとめる」: a closed one is not there either.
        input.groupUnread = true
        input.closedDms = ["c"]
        XCTAssertFalse(HomeSections.build(input).unread.map(\.id).contains("c"))
        // Open again: back where it was (its star and section kept).
        input.closedDms = []
        input.groupUnread = false
        let open = HomeSections.build(input)
        XCTAssertEqual(open.favorites.ids, ["a"])
        XCTAssertEqual(open.custom.first?.rows.ids.contains("b"), true)
        XCTAssertEqual(open.dms.ids.first, "c")
    }

    // MARK: the store

    func testStoreAndBootstrap() throws {
        let store = Store()
        store.replaceClosedDms(nil)  // a server before M141
        XCTAssertFalse(store.closedDmsSupported)
        store.replaceClosedDms(["a"])
        XCTAssertTrue(store.closedDmsSupported)
        store.setDmClosed("b", closed: true)
        XCTAssertEqual(store.closedDms, ["a", "b"])
        store.setDmClosed("a", closed: false)
        XCTAssertEqual(store.closedDms, ["b"])
        store.replaceClosedDms([])
        XCTAssertTrue(store.closedDms.isEmpty)

        struct Closed: Decodable { var closedDms: [String]? }
        XCTAssertEqual(try JSON.snakeDecoder.decode(Closed.self, from: Data(#"{"closed_dms": ["c1"]}"#.utf8)).closedDms, ["c1"])
        XCTAssertNil(try JSON.snakeDecoder.decode(Closed.self, from: Data("{}".utf8)).closedDms)
        XCTAssertEqual(try JSON.snakeDecoder.decode(DmCloseStateOut.self, from: Data(#"{"channel_id": "c1", "closed": false, "closed_at": null}"#.utf8)),
                       DmCloseStateOut(channelId: "c1", closed: false))
    }

    // MARK: closing (optimistic, rolled back when refused) and opening explicitly

    override func tearDown() {
        StubProtocol.handler = nil
        super.tearDown()
    }

    private func client(_ reply: @escaping (URLRequest) -> (Int, String)) -> ApiClient {
        StubProtocol.handler = { request in
            let (status, body) = reply(request)
            return (status, Data(body.utf8))
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        return ApiClient(baseUrl: URL(string: "http://server")!, session: URLSession(configuration: configuration))
    }

    private func controller(with channels: [ChannelState]) -> AppController {
        let controller = AppController()
        for state in channels {
            controller.store.upsertChannel(state.channel, isMember: true)
            controller.store.updateChannel(state.id) { stored in
                stored.lastSeq = state.lastSeq
                stored.lastReadSeq = state.lastReadSeq
                stored.unreadCount = state.unreadCount
                stored.mentionCount = state.mentionCount
            }
        }
        controller.store.replaceClosedDms([])
        return controller
    }

    func testClosingHidesUnpinsAndReadsAtOnceAndTellsTheScreens() async {
        let controller = controller(with: [dm("c", day: 3, unread: 2), dm("d", day: 4)])
        controller.store.replaceDmPins(["d", "c"])
        var requests: [String] = []
        controller.api = client { request in
            requests.append("\(request.httpMethod!) \(request.url!.path)")
            return (200, #"{"channel_id":"c","closed":true,"closed_at":"2026-10-07T00:00:00Z"}"#)
        }
        let posted = expectation(forNotification: .chikuwaCloseConversation, object: nil) { ($0.userInfo?["id"] as? String) == "c" }
        await controller.closeDm("c")
        await fulfillment(of: [posted], timeout: 1)
        XCTAssertEqual(requests, ["PUT /api/v1/channels/c/close"])
        XCTAssertTrue(controller.store.isDmClosed("c"))
        XCTAssertEqual(controller.store.dmPins, ["d"])
        let state = controller.store.channel("c")
        XCTAssertEqual(state?.unreadCount, 0)
        XCTAssertEqual(state?.mentionCount, 0)
        XCTAssertEqual(state?.lastReadSeq, 5)
        XCTAssertNil(controller.error)
    }

    func testARefusedCloseIsUndone() async {
        let controller = controller(with: [dm("c", day: 3, unread: 2), dm("d", day: 4)])
        controller.store.replaceDmPins(["c", "d"])
        controller.api = client { _ in (409, #"{"error":{"code":"dm_close_not_dm","message":"Only DMs"}}"#) }
        await controller.closeDm("c")
        XCTAssertFalse(controller.store.isDmClosed("c"))
        XCTAssertEqual(controller.store.dmPins, ["c", "d"])  // back in its place
        let state = controller.store.channel("c")
        XCTAssertEqual(state?.unreadCount, 2)
        XCTAssertEqual(state?.mentionCount, 1)
        XCTAssertEqual(state?.lastReadSeq, 3)
        XCTAssertNotNil(controller.error)
    }

    func testAChannelIsNeverClosed() async {
        let controller = controller(with: [channel("general")])
        var asked = false
        controller.api = client { _ in asked = true; return (200, "{}") }
        await controller.closeDm("general")
        XCTAssertFalse(asked)
        XCTAssertFalse(controller.store.isDmClosed("general"))
    }

    func testAnExplicitOpenReopensAClosedOneOnly() async {
        let controller = controller(with: [dm("c", day: 3), dm("d", day: 4)])
        controller.store.replaceClosedDms(["c"])
        let deleted = expectation(description: "DELETE")
        var requests: [String] = []
        controller.api = client { request in
            requests.append("\(request.httpMethod!) \(request.url!.path)")
            deleted.fulfill()
            return (200, #"{"channel_id":"c","closed":false,"closed_at":null}"#)
        }
        controller.reopenDmIfClosed("d")  // not closed: nothing asked
        controller.reopenDmIfClosed("c")
        XCTAssertFalse(controller.store.isDmClosed("c"))  // at once
        await fulfillment(of: [deleted], timeout: 2)
        XCTAssertEqual(requests, ["DELETE /api/v1/channels/c/close"])
    }

    // MARK: the engine: dm_close.updated and a new timeline message

    private func settle(_ engine: SyncEngine) async {
        for _ in 0..<50 {
            await engine.idle()
            await Task.yield()
        }
    }

    func testEventsCloseAndOpenAndANewTimelineMessageOpens() async throws {
        let server = FakeServer()
        let alice = server.addUser("alice")
        let bob = server.addUser("bob")
        let dmId = server.createChannel("", ownerId: alice.id, type: "dm").id
        server.join(dmId, bob.id)
        let (first, _) = try server.post(channelId: dmId, senderId: alice.id, body: "はじめまして")
        let store = Store()
        var options = EngineOptions()
        options.sleep = { _ in }
        options.reconnectMin = 0
        let engine = SyncEngine(api: server.api(for: bob.id), connect: server.connector(for: bob.id), wsUrl: URL(string: "ws://fake")!, store: store,
                                getAccessToken: { "token" }, options: options)
        engine.isActive = { false }
        await engine.start()
        await settle(engine)
        XCTAssertFalse(store.closedDmsSupported)  // this fake server sends no closed_dms (an older server)

        // dm_close.updated from another of my devices closes it here; and opens it again.
        let event = { (closed: Bool) in
            server.emitEvent([bob.id], "dm_close.updated", channelId: nil,
                             data: .object(["channel_id": .string(dmId), "closed": .bool(closed), "at": .string("2026-10-07T00:00:00Z")]))
        }
        event(true)
        await settle(engine)
        XCTAssertTrue(store.isDmClosed(dmId))
        event(false)
        await settle(engine)
        XCTAssertFalse(store.isDmClosed(dmId))

        // A thread-only reply does not open it; a reply also sent to the conversation and a new message do.
        event(true)
        await settle(engine)
        _ = try server.post(channelId: dmId, senderId: alice.id, body: "スレッドだけ", parentId: first.id)
        await settle(engine)
        XCTAssertTrue(store.isDmClosed(dmId))
        _ = try server.post(channelId: dmId, senderId: alice.id, body: "こんにちは")
        await settle(engine)
        XCTAssertFalse(store.isDmClosed(dmId))
        engine.stop()
    }
}
