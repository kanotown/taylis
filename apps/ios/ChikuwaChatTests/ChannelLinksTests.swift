import XCTest
@testable import ChikuwaChat

/// Links pinned to the top of a conversation (M15f).
@MainActor
final class ChannelLinksTests: XCTestCase {
    func testOnlyHttpLinksAreAccepted() {
        XCTAssertTrue(ChannelLinks.validUrl("https://example.com/doc"))
        XCTAssertTrue(ChannelLinks.validUrl(" http://grafana.local/d/1 "))
        for bad in ["javascript:alert(1)", "data:text/html,x", "ftp://example.com", "https://", "https://a b", "example.com"] {
            XCTAssertFalse(ChannelLinks.validUrl(bad), bad)
        }
    }

    func testLinksLoadWhenTheConversationOpensAndFollowChanges() async {
        let server = FakeServer()
        let alice = server.addUser("alice")
        let bob = server.addUser("bob")
        let channel = server.createChannel("general", ownerId: alice.id)
        server.join(channel.id, bob.id)
        server.setLinks(channel.id, titles: ["設計書"])
        let store = Store()
        var options = EngineOptions()
        options.sleep = { _ in }
        let engine = SyncEngine(api: server.api(for: bob.id), connect: server.connector(for: bob.id), wsUrl: URL(string: "ws://fake")!, store: store,
                                getAccessToken: { "t" }, options: options)
        await engine.start()
        await engine.idle()
        XCTAssertEqual(store.linksOf(channel.id), []) // not part of bootstrap
        await engine.openChannel(channel.id)
        for _ in 0..<20 { await Task.yield() }
        XCTAssertEqual(store.linksOf(channel.id).map(\.title), ["設計書"])
        server.setLinks(channel.id, titles: ["設計書", "監視"])
        await engine.idle()
        for _ in 0..<20 { await Task.yield() }
        XCTAssertEqual(store.linksOf(channel.id).map(\.title), ["設計書", "監視"])
        engine.stop()
    }
}
