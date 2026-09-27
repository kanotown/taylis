import XCTest
@testable import ChikuwaChat

/// Drafts shared by my devices (M15d); same scenarios as the desktop tests.
@MainActor
final class DraftSyncTests: XCTestCase {
    private struct Devices {
        let server: FakeServer
        let bob: UserPublic
        let channel: ChannelOut
        let laptop: Store
        let phone: Store
        let a: SyncEngine
        let b: SyncEngine
    }

    private func engine(_ server: FakeServer, _ userId: String, _ store: Store) -> SyncEngine {
        var options = EngineOptions()
        options.sleep = { _ in }
        options.draftSave = 60 // saved only when a test says so (flushDrafts), or at once when emptied
        return SyncEngine(api: server.api(for: userId), connect: server.connector(for: userId), wsUrl: URL(string: "ws://fake")!, store: store,
                          getAccessToken: { "t" }, options: options)
    }

    private func settle(_ engines: SyncEngine...) async {
        for _ in 0..<30 {
            for engine in engines {
                await engine.idle()
                await engine.drafts.idle()
            }
            await Task.yield()
        }
    }

    private func devices() async -> Devices {
        let server = FakeServer()
        let alice = server.addUser("alice")
        let bob = server.addUser("bob")
        let channel = server.createChannel("general", ownerId: alice.id)
        server.join(channel.id, bob.id)
        let laptop = Store()
        let phone = Store()
        let a = engine(server, bob.id, laptop)
        let b = engine(server, bob.id, phone)
        await a.start()
        await b.start()
        await settle(a, b)
        return Devices(server: server, bob: bob, channel: channel, laptop: laptop, phone: phone, a: a, b: b)
    }

    func testDraftReachesMyOtherDeviceAndGoesAwayOnceSent() async throws {
        let d = await devices()
        d.laptop.setDraft(d.channel.id) { $0.text = "書きかけ" }
        XCTAssertTrue(d.laptop.draft(d.channel.id).isDirty)
        await d.a.flushDrafts()
        await settle(d.a, d.b)
        XCTAssertEqual(d.server.drafts(of: d.bob.id).map(\.body), ["書きかけ"])
        XCTAssertFalse(d.laptop.draft(d.channel.id).isDirty)
        XCTAssertEqual(d.phone.draft(d.channel.id).text, "書きかけ")
        XCTAssertEqual(d.phone.listDrafts().map(\.draft.text), ["書きかけ"])

        d.laptop.setDraft(d.channel.id) { $0 = Draft() } // sending empties the composer: deleted at once
        for _ in 0..<5 { try await Task.sleep(nanoseconds: 20_000_000); await settle(d.a, d.b) }
        XCTAssertEqual(d.server.drafts(of: d.bob.id), [])
        XCTAssertEqual(d.phone.draft(d.channel.id).text, "")
        XCTAssertTrue(d.laptop.draftEntries().isEmpty)
        d.a.stop()
        d.b.stop()
    }

    func testUnsavedEditsHereWinOverAnotherDevicesSave() async {
        let d = await devices()
        d.phone.setDraft(d.channel.id) { $0.text = "スマホで書いた" }
        d.laptop.setDraft(d.channel.id) { $0.text = "PC で書いた" }
        await d.a.flushDrafts()
        await settle(d.a, d.b)
        XCTAssertEqual(d.phone.draft(d.channel.id).text, "スマホで書いた")
        await d.b.flushDrafts()
        await settle(d.a, d.b)
        XCTAssertEqual(d.laptop.draft(d.channel.id).text, "スマホで書いた")
        d.a.stop()
        d.b.stop()
    }

    func testBootstrapTakesServerDraftsPushesOlderOnesAndForgetsDeletedOnes() async {
        let d = await devices()
        let other = d.server.createChannel("random", ownerId: d.bob.id)
        d.laptop.setDraft(d.channel.id) { $0.text = "共有される" }
        await d.a.flushDrafts()

        let tablet = Store()
        tablet.setDraft(other.id) { $0.text = "昔の下書き" }
        tablet.markDraftSaved(other.id, parentId: nil, text: "昔の下書き", updatedAt: nil) // as if written before M15d
        tablet.applyRemoteDraft(d.channel.id, parentId: "gone-parent", body: "消された", updatedAt: "2026-09-27T00:00:00Z")
        let c = engine(d.server, d.bob.id, tablet)
        await c.start()
        await settle(c)
        XCTAssertEqual(tablet.draft(d.channel.id).text, "共有される")
        XCTAssertEqual(tablet.draft(d.channel.id, parentId: "gone-parent").text, "")
        XCTAssertEqual(d.server.drafts(of: d.bob.id).map(\.body).sorted(), ["共有される", "昔の下書き"])
        d.a.stop()
        d.b.stop()
        c.stop()
    }
}
