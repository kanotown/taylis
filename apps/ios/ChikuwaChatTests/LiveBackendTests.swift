import XCTest
@testable import ChikuwaChat

/// Runs the real ApiClient + SyncEngine + WebSocketTransport against a live backend.
/// Enabled with TEST_RUNNER_LIVE_URL / TEST_RUNNER_LIVE_PASS (users dtuser1 / dtuser2), e.g. the compose stack.
@MainActor
final class LiveBackendTests: XCTestCase {
    func testLoginSyncRealtimeAndSend() async throws {
        let environment = ProcessInfo.processInfo.environment
        guard let liveUrl = environment["LIVE_URL"], let url = URL(string: liveUrl) else {
            throw XCTSkip("LIVE_URL not set")
        }
        let password = environment["LIVE_PASS"] ?? ""
        let alice = ApiClient(baseUrl: url)
        let bob = ApiClient(baseUrl: url)
        _ = try await alice.login(username: "dtuser1", password: password, device: DeviceInfo(platform: "ios", deviceName: "live-test", appVersion: "0.1.0"))
        _ = try await bob.login(username: "dtuser2", password: password, device: DeviceInfo(platform: "ios", deviceName: "live-test", appVersion: "0.1.0"))
        let channel = try await alice.createChannel(name: "ios-" + String(Int(Date().timeIntervalSince1970)), type: "public")
        _ = try await bob.joinChannel(id: channel.id)

        let store = Store()
        var options = EngineOptions()
        options.sleep = { _ in }
        let engine = SyncEngine(api: bob, connect: { url, _ in try await WebSocketTransport.connect(url: url) }, wsUrl: bob.wsUrl,
                                store: store, getAccessToken: { bob.accessToken }, options: options)
        await engine.openChannel(channel.id)
        await engine.start()
        await engine.idle()
        XCTAssertEqual(engine.status, .online)
        XCTAssertEqual(store.me?.username, "dtuser2")
        XCTAssertEqual(store.channel(channel.id)?.isMember, true)

        _ = try await alice.postMessage(channelId: channel.id, clientMsgId: UUID().uuidString.lowercased(), body: "hello from the real server")
        for _ in 0..<100 where store.messages(channel.id).count < 1 {
            try await Task.sleep(nanoseconds: 50_000_000)
            await engine.idle()
        }
        XCTAssertEqual(store.messages(channel.id).map(\.body), ["hello from the real server"])
        XCTAssertEqual(store.channel(channel.id)?.syncedSeq, 1)

        await engine.send(channel.id, body: "reply from the iOS engine")
        for _ in 0..<100 where store.channel(channel.id)?.syncedSeq != 2 {
            try await Task.sleep(nanoseconds: 50_000_000)
            await engine.idle()
        }
        let history = try await alice.history(channelId: channel.id, beforeSeq: nil, limit: 10)
        XCTAssertEqual(history.messages.map(\.body), ["reply from the iOS engine", "hello from the real server"])
        XCTAssertTrue(store.messages(channel.id).allSatisfy { !$0.pending })

        engine.stop()
        await alice.logout()
        await bob.logout()
    }
}
