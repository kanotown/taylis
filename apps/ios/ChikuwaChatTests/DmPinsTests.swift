import XCTest
@testable import ChikuwaChat

/// M118 (DATA_MODEL.md conversation_pins, 「DM の固定」): pinned DMs first in pin order, then my DM with myself, then the
/// section's sort; the store's pins from bootstrap, events and a refused tap.
@MainActor
final class DmPinsTests: XCTestCase {
    private func channel(_ id: String, type: String = "public", dm: [String]? = nil, day: Int = 1, unread: Int = 0) -> ChannelState {
        let out = ChannelOut(id: id, type: type, name: dm == nil ? id : nil, topic: nil, purpose: nil, archived: false, createdBy: nil, lastSeq: 0,
                             lastMessageAt: String(format: "2026-09-%02dT00:00:00Z", day), createdAt: "2026-01-01T00:00:00Z", updatedAt: "",
                             membership: nil, dmUserIds: dm)
        return ChannelState(channel: out, isMember: true, syncedSeq: nil, lastSeq: 0, lastReadSeq: 0, unreadCount: unread, mentionCount: 0, hasOlder: true)
    }

    private func dm(_ id: String, day: Int, unread: Int = 0) -> ChannelState { channel(id, type: "dm", dm: ["me", id], day: day, unread: unread) }

    private var sample: [ChannelState] {
        [
            channel("general"),
            dm("a", day: 1), dm("b", day: 2), dm("c", day: 3), dm("d", day: 4), dm("e", day: 5), dm("f", day: 6), dm("g", day: 7),
            channel("group", type: "group_dm", dm: ["me", "a", "b"], day: 8),
            channel("notes", type: "dm", dm: ["me"], day: 9),
        ]
    }

    func testDmTabOrder() {
        // Without pins: my DM with myself, then the newest.
        XCTAssertEqual(DMList.ordered(sample, meId: "me").map(\.id), ["notes", "group", "g", "f", "e", "d", "c", "b", "a"])
        // Pins first in pin order (oldest pin first), then my notes, then the rest newest first.
        XCTAssertEqual(DMList.ordered(sample, meId: "me", pins: ["b", "group"]).map(\.id), ["b", "group", "notes", "g", "f", "e", "d", "c", "a"])
        // My notes pinned: in their pin place. A pin of a conversation I left, or of a channel, is skipped.
        XCTAssertEqual(DMList.ordered(sample, meId: "me", pins: ["gone", "a", "notes", "general"]).map(\.id).prefix(3), ["a", "notes", "group"])
    }

    func testHomeDmSection() {
        let input = HomeSections.Input(channels: sample, meId: "me", dmPins: ["a", "b"])
        let layout = HomeSections.build(input)
        // Pins always show (outside the limit of five), then my notes, then the newest five.
        XCTAssertEqual(layout.dms.ids, ["a", "b", "notes", "group", "g", "f", "e", "d"])
        XCTAssertTrue(layout.moreDms)

        // Folded: only what is unread, pins first among them.
        var folded = input
        folded.channels = sample.map { $0.id == "b" || $0.id == "g" ? dm($0.id, day: 1, unread: 1) : $0 }
        folded.folded = ["dms"]
        XCTAssertEqual(HomeSections.build(folded).dms.ids, ["b", "g"])

        // 「手動」: pins first, then my own order (my notes where I put them).
        var manual = input
        manual.defaults = [SidebarDefaultOut(key: "dms", sort: "manual", manualOrder: ["c", "notes", "b"])]
        XCTAssertEqual(Array(HomeSections.build(manual).dms.ids.prefix(4)), ["a", "b", "c", "notes"])
    }

    func testPinsFirstInOtherSections() {
        let section = SidebarSectionOut(id: "s1", name: "研究", position: 0, channelIds: ["general", "c", "d"], collapsed: false)
        let layout = HomeSections.build(HomeSections.Input(channels: sample, meId: "me", favorites: ["e", "f", "general"], dmPins: ["d", "f"],
                                                           sections: [section]))
        XCTAssertEqual(layout.favorites.ids.first, "f")
        XCTAssertEqual(layout.custom.first?.rows.ids.first, "d")
        // Pins never pull a channel along.
        XCTAssertEqual(SidebarOrder.pinnedFirst(sample, pins: ["general"]).map(\.id), sample.map(\.id))
    }

    func testStorePins() {
        let store = Store()
        XCTAssertFalse(store.dmPinsSupported)
        store.replaceDmPins(nil)  // a server before M118
        XCTAssertFalse(store.dmPinsSupported)
        store.replaceDmPins(["a", "b"])
        XCTAssertTrue(store.dmPinsSupported)
        // dm_pin.updated: a new pin goes last, one already there keeps its place, an unpin drops it.
        store.setDmPin("c", on: true)
        store.setDmPin("a", on: true)
        XCTAssertEqual(store.dmPins, ["a", "b", "c"])
        store.setDmPin("b", on: false)
        XCTAssertEqual(store.dmPins, ["a", "c"])
        // A refused unpin puts it back where it was; a refused pin takes it out.
        store.setDmPin("a", on: false)
        store.restoreDmPin("a", at: 0)
        XCTAssertEqual(store.dmPins, ["a", "c"])
        store.setDmPin("x", on: true)
        store.restoreDmPin("x", at: nil)
        XCTAssertEqual(store.dmPins, ["a", "c"])
    }

    func testBootstrapField() throws {
        struct Pins: Decodable { var dmPins: [String]? }
        XCTAssertEqual(try JSON.snakeDecoder.decode(Pins.self, from: Data(#"{"dm_pins": ["c1", "c2"]}"#.utf8)).dmPins, ["c1", "c2"])
        XCTAssertNil(try JSON.snakeDecoder.decode(Pins.self, from: Data("{}".utf8)).dmPins)
        XCTAssertEqual(try JSON.snakeDecoder.decode(DmPinStateOut.self, from: Data(#"{"channel_id": "c1", "pinned": true}"#.utf8)),
                       DmPinStateOut(channelId: "c1", pinned: true))
    }
}

/// DATA_MODEL.md sidebar_sections 「1 つの会話は 1 か所」 (2026-10-07, user report: a starred conversation moved into a new
/// section seemed to do nothing): a conversation is in お気に入り or in one of my sections, never both. The server applies
/// the rule; the controller applies it here at once (and puts it back when refused).
@MainActor
final class SidebarOnePlaceTests: XCTestCase {
    private static let section = #"[{"id":"s1","name":"研究","position":0,"channel_ids":["c1","c2"],"collapsed":false,"sort":"name","manual_order":[]}]"#
    private static let refused = #"{"error":{"code":"section_not_found","message":"Section not found"}}"#

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

    func testANewSectionMadeWithStarredConversationsTakesThemOutOfFavorites() async {
        let controller = AppController()
        controller.api = client { _ in (201, Self.section) }
        controller.store.replaceFavorites(["c1", "c3"])
        let made = await controller.createSection("研究", emoji: nil, channelIds: ["c1", "c2"])
        XCTAssertTrue(made)
        XCTAssertEqual(controller.store.sectionOf("c1"), "s1")
        XCTAssertEqual(controller.store.favorites, ["c3"])
    }

    func testMovingAStarredConversationIntoASectionUnstarsItUnlessRefused() async {
        let controller = AppController()
        var refuse = false
        controller.api = client { _ in refuse ? (404, Self.refused) : (200, Self.section) }
        controller.store.replaceFavorites(["c1", "c2"])
        let moved = await controller.moveToSection("c1", sectionId: "s1")
        XCTAssertTrue(moved)
        XCTAssertFalse(controller.store.isFavorite("c1"))
        refuse = true
        let refusedMove = await controller.moveToSection("c2", sectionId: "s1")
        XCTAssertFalse(refusedMove)
        XCTAssertTrue(controller.store.isFavorite("c2"))
        XCTAssertNotNil(controller.error)
    }

    func testStarringTakesAConversationOutOfItsSectionAndARefusalPutsItBack() async {
        let controller = AppController()
        var refuse = false
        controller.api = client { request in
            refuse ? (403, #"{"error":{"code":"not_a_member","message":"no"}}"#) : (201, #"{"channel_id":"\#(request.url!.pathComponents[4])","favorite":true}"#)
        }
        controller.store.replaceSidebar([SidebarSectionOut(id: "s1", name: "研究", position: 0, channelIds: ["c1", "c2"])])
        await controller.toggleFavorite("c1")
        XCTAssertTrue(controller.store.isFavorite("c1"))
        XCTAssertEqual(controller.store.sidebarSections.first?.channelIds, ["c2"])
        refuse = true
        await controller.toggleFavorite("c2")
        XCTAssertFalse(controller.store.isFavorite("c2"))
        XCTAssertEqual(controller.store.sidebarSections.first?.channelIds, ["c2"])
    }
}
