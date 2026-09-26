import XCTest
@testable import ChikuwaChat

@MainActor
final class SyncEngineTests: XCTestCase {
    struct World {
        let server: FakeServer
        let alice: UserPublic
        let bob: UserPublic
        let channel: ChannelOut
        let store: Store
        let engine: SyncEngine
        let api: FakeServer.Api
    }

    private var notifications: [String] = []

    private func makeWorld(hold: Bool = false) -> World {
        let server = FakeServer()
        let alice = server.addUser("alice")
        let bob = server.addUser("bob")
        let channel = server.createChannel("general", ownerId: alice.id)
        server.join(channel.id, bob.id)
        let store = Store()
        var options = EngineOptions()
        options.pageSize = 3
        options.gapLimit = 5
        options.reconnectMin = 0
        options.sleep = { _ in }
        options.random = { 0.5 }
        let api = server.api(for: bob.id)
        let engine = SyncEngine(api: api, connect: server.connector(for: bob.id), wsUrl: URL(string: "ws://fake")!, store: store,
                                getAccessToken: { "token" }, options: options)
        engine.isActive = { false }
        engine.onNotify = { [weak self] message, _ in self?.notifications.append(message.body) }
        server.holdEvents = hold
        return World(server: server, alice: alice, bob: bob, channel: channel, store: store, engine: engine, api: api)
    }

    private func settle(_ engine: SyncEngine) async {
        for _ in 0..<50 {
            await engine.idle()
            await Task.yield()
        }
    }

    func testBootstrapLoadsLatestPageOfTheOpenedChannel() async throws {
        let w = makeWorld()
        for i in 1...5 { try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "m\(i)") }
        await w.engine.openChannel(w.channel.id)
        await w.engine.start()
        await settle(w.engine)
        XCTAssertEqual(w.engine.status, .online)
        XCTAssertEqual(w.store.me?.username, "bob")
        XCTAssertEqual(w.store.messages(w.channel.id).map(\.body), ["m3", "m4", "m5"])
        XCTAssertEqual(w.store.channel(w.channel.id)?.syncedSeq, 5)
        await w.engine.loadOlder(w.channel.id)
        XCTAssertEqual(w.store.messages(w.channel.id).map(\.body), ["m1", "m2", "m3", "m4", "m5"])
        XCTAssertEqual(w.store.channel(w.channel.id)?.hasOlder, false)
        w.engine.stop()
    }

    func testContiguousEventsAndGapDetection() async throws {
        let w = makeWorld()
        await w.engine.start()
        await w.engine.openChannel(w.channel.id)
        try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "m1")
        await settle(w.engine)
        XCTAssertEqual(w.store.messages(w.channel.id).map(\.body), ["m1"])
        w.server.sockets(of: w.bob.id).first?.dropNext = 2
        try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "m2")
        try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "m3")
        await settle(w.engine)
        XCTAssertEqual(w.store.messages(w.channel.id).map(\.body), ["m1"])
        try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "m4") // gap → catch_up
        await settle(w.engine)
        XCTAssertEqual(w.store.messages(w.channel.id).map(\.body), ["m1", "m2", "m3", "m4"])
        XCTAssertEqual(w.store.channel(w.channel.id)?.syncedSeq, 4)
        w.engine.stop()
    }

    func testEventsDuringBootstrapAreBuffered() async throws {
        let w = makeWorld(hold: true)
        await w.engine.openChannel(w.channel.id)
        let started = Task { await w.engine.start() }
        await Task.yield()
        w.server.holdEvents = false
        try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "during")
        await started.value
        await settle(w.engine)
        XCTAssertEqual(w.store.messages(w.channel.id).map(\.body), ["during"])
        w.engine.stop()
    }

    func testOptimisticSendRetriesWithoutDuplicates() async throws {
        let w = makeWorld()
        await w.engine.start()
        await w.engine.openChannel(w.channel.id)
        w.api.pendingFailure = ApiError.network(URLError(.notConnectedToInternet))
        await w.engine.send(w.channel.id, body: "hello")
        XCTAssertEqual(w.store.outbox.count, 1)
        XCTAssertEqual(w.store.messages(w.channel.id).map { ($0.body, $0.pending) }.map { "\($0.0):\($0.1)" }, ["hello:true"])
        await w.engine.flushOutbox()
        await settle(w.engine)
        XCTAssertEqual(w.store.outbox.count, 0)
        XCTAssertEqual(w.store.messages(w.channel.id).map { "\($0.body):\($0.seq ?? -1):\($0.pending)" }, ["hello:1:false"])
        XCTAssertEqual(w.server.channels[w.channel.id]?.messages.count, 1)
        w.engine.stop()
    }

    func testPermanentFailureCanBeDiscarded() async throws {
        let w = makeWorld()
        await w.engine.start()
        w.api.pendingFailure = ApiError.api(status: 409, code: "channel_archived", message: "archived")
        await w.engine.send(w.channel.id, body: "nope")
        XCTAssertEqual(w.store.outbox.first?.failed, "channel_archived")
        XCTAssertEqual(w.store.messages(w.channel.id).first?.failed, true)
        w.engine.discardFailed(w.store.outbox.first!.clientMsgId)
        XCTAssertEqual(w.store.outbox.count, 0)
        XCTAssertEqual(w.store.messages(w.channel.id).count, 0)
        w.engine.stop()
    }

    func testReconnectRecoversMissedEvents() async throws {
        let w = makeWorld()
        await w.engine.start()
        await w.engine.openChannel(w.channel.id)
        try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "m1")
        await settle(w.engine)
        w.server.disconnect(w.bob.id)
        try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "m2")
        try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "m3")
        for _ in 0..<50 where w.engine.status != .online { await settle(w.engine) }
        await settle(w.engine)
        XCTAssertEqual(w.engine.status, .online)
        XCTAssertEqual(w.engine.reconnects, 1)
        XCTAssertEqual(w.store.messages(w.channel.id).map(\.body), ["m1", "m2", "m3"])
        w.engine.stop()
    }

    func testSessionRevocationSignsOut() async throws {
        let w = makeWorld()
        var signedOut = false
        w.engine.onSignedOut = { signedOut = true }
        await w.engine.start()
        w.server.revokeSession(w.bob.id)
        await settle(w.engine)
        XCTAssertEqual(w.engine.status, .signedOut)
        XCTAssertTrue(signedOut)
    }

    func testDirectMessagesNotifyWhenInactive() async throws {
        let w = makeWorld()
        let dm = w.server.createChannel("", ownerId: w.alice.id, type: "dm")
        w.server.join(dm.id, w.bob.id)
        await w.engine.start()
        try w.server.post(channelId: dm.id, senderId: w.alice.id, body: "psst")
        await settle(w.engine)
        XCTAssertEqual(notifications, ["psst"])
        XCTAssertEqual(w.store.channel(dm.id)?.lastSeq, 1)
        w.engine.stop()
    }

    func testResumesFromPersistedSnapshot() async throws {
        let w = makeWorld()
        await w.engine.start()
        await w.engine.openChannel(w.channel.id)
        try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "m1")
        await settle(w.engine)
        w.engine.stop()
        try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "m2")
        let restored = Store.fromSnapshot(w.store.snapshot())
        var options = EngineOptions()
        options.pageSize = 3
        options.sleep = { _ in }
        let second = SyncEngine(api: w.server.api(for: w.bob.id), connect: w.server.connector(for: w.bob.id), wsUrl: URL(string: "ws://fake")!,
                                store: restored, getAccessToken: { "t" }, options: options)
        await second.openChannel(w.channel.id)
        await second.start()
        await settle(second)
        XCTAssertEqual(restored.messages(w.channel.id).map(\.body), ["m1", "m2"])
        XCTAssertEqual(restored.channel(w.channel.id)?.syncedSeq, 2)
        second.stop()
    }

    func testBrowsablePublicChannelsAndJoining() async throws {
        let server = FakeServer()
        let alice = server.addUser("alice")
        let bob = server.addUser("bob")
        let general = server.createChannel("general", ownerId: alice.id)
        let secret = server.createChannel("secret", ownerId: alice.id, type: "private")
        let store = Store()
        var options = EngineOptions()
        options.sleep = { _ in }
        let engine = SyncEngine(api: server.api(for: bob.id), connect: server.connector(for: bob.id), wsUrl: URL(string: "ws://fake")!, store: store,
                                getAccessToken: { "t" }, options: options)
        await engine.start()
        await settle(engine)
        XCTAssertEqual(store.channel(general.id)?.isMember, false)
        XCTAssertNil(store.channel(secret.id))
        server.join(general.id, bob.id)
        server.emitMembership(general.id, bob.id)
        await settle(engine)
        XCTAssertEqual(store.channel(general.id)?.isMember, true)
        engine.stop()
    }
}
