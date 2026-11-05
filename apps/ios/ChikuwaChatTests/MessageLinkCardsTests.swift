import SwiftUI
import UIKit
import XCTest
@testable import ChikuwaChat

/// M185 (docs/LINK_PREVIEWS.md §8): message link cards and removing a preview on the phone. Which cards a body shows and
/// the removed cards' keys (the shared cases, apps/shared/link-cards.json), `hidden_previews` coming and going, asking
/// for the cards in batches with the session's answers, what a card shows, its frame, and who removes one (with
/// 「元に戻す」).
@MainActor
final class MessageLinkCardsTests: XCTestCase {
    private var window: UIWindow?
    private var host: UIHostingController<AnyView>?

    override func tearDown() {
        window?.isHidden = true
        window = nil
        host = nil
        StubProtocol.handler = nil
    }

    // MARK: the shared cases

    private struct Vectors: Decodable {
        struct Key: Decodable { let url: String; let key: String? }
        struct Card: Decodable, Equatable { let id: String; let url: String }
        struct Case: Decodable {
            let name: String
            let body: String
            let selfId: String?
            let hidden: [String]?
            let call: Bool?
            let messages: [Card]
            let external: String?
        }
        let baseUrl: String
        let keys: [Key]
        let cards: [Case]
    }

    private func vectors() throws -> Vectors {
        // The repository's own file (the simulator reads the Mac's disk).
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("shared/link-cards.json")
        return try JSON.snakeDecoder.decode(Vectors.self, from: Data(contentsOf: url))
    }

    func testEverySharedKeyCase() throws {
        let v = try vectors()
        XCTAssertGreaterThanOrEqual(v.keys.count, 10)
        for c in v.keys {
            XCTAssertEqual(MessageLinkCards.previewKey(c.url), c.key, c.url)
        }
    }

    func testEverySharedCardCase() throws {
        let v = try vectors()
        let base = try XCTUnwrap(URL(string: v.baseUrl))
        XCTAssertGreaterThanOrEqual(v.cards.count, 12)
        for c in v.cards {
            let selection = MessageLinkCards.of(body: c.body, base: base, selfId: c.selfId, hidden: c.hidden ?? [], call: c.call ?? false)
            XCTAssertEqual(selection.messages.map { Vectors.Card(id: $0.id, url: $0.url) }, c.messages, c.name)
            XCTAssertEqual(selection.external, c.external, c.name)
        }
    }

    func testThisServersCanvasEventAndPageLinksGetNoOpenGraphCardAndThePlainLinkAfterThemDoes() {
        let base = URL(string: "https://chat.example.com")!
        let canvas = "https://chat.example.com/c/0190a1b2-0000-7000-8000-0000000000c1"
        let page = "https://chat.example.com/p/0190a1b2-0000-7000-8000-0000000000f1"
        XCTAssertEqual(MessageLinkCards.of(body: "\(canvas) \(page) https://example.com/", base: base).external, "https://example.com/")
        XCTAssertNil(MessageLinkCards.of(body: canvas, base: base).external)
        // Not logged in anywhere: every link is an ordinary one.
        XCTAssertEqual(MessageLinkCards.of(body: "https://chat.example.com/m/0190a1b2-0000-7000-8000-00000000000a", base: nil).external,
                       "https://chat.example.com/m/0190a1b2-0000-7000-8000-00000000000a")
    }

    func testARowBeingSentDeletedOrASystemLineShowsNoCards() {
        let base = URL(string: "http://server")!
        let body = "http://server/m/0190a1b2-0000-7000-8000-00000000000a https://example.com/"
        var row = message(body)
        XCTAssertEqual(MessageLinkCards.of(row, base: base).messages.count, 1)
        XCTAssertEqual(MessageLinkCards.of(row, base: base).external, "https://example.com/")
        row.pending = true
        XCTAssertEqual(MessageLinkCards.of(row, base: base), MessageLinkCards.Selection())
        row = message(body)
        row.type = "system"
        XCTAssertEqual(MessageLinkCards.of(row, base: base), MessageLinkCards.Selection())
        row = message(body)
        row.hiddenPreviews = ["https://example.com/"]
        XCTAssertNil(MessageLinkCards.of(row, base: base).external, "removed: no card, nothing in its place")
    }

    // MARK: hidden_previews

    func testHiddenPreviewsDecodeAreKeptWithTheRowAndAreEmptyFromAnOlderServer() throws {
        let old = #"{"id":"m1","channel_id":"c1","sender_id":"11111111-1111-4111-8111-111111111111","seq":1,"updated_seq":1,"client_msg_id":null,"body":"x","#
            + #""created_at":"2026-11-05T00:00:00Z","edited_at":null,"deleted":false}"#
        XCTAssertEqual(try JSON.snakeDecoder.decode(MessageOut.self, from: Data(old.utf8)).hiddenPreviews, [])
        let null = old.replacingOccurrences(of: #""deleted":false}"#, with: #""deleted":false,"hidden_previews":null}"#)
        XCTAssertEqual(try JSON.snakeDecoder.decode(MessageOut.self, from: Data(null.utf8)).hiddenPreviews, [])
        let new = old.replacingOccurrences(of: #""deleted":false}"#, with: #""deleted":false,"hidden_previews":["https://example.com/"]}"#)
        let out = try JSON.snakeDecoder.decode(MessageOut.self, from: Data(new.utf8))
        XCTAssertEqual(out.hiddenPreviews, ["https://example.com/"])
        // The device's database (plain JSON of the row) keeps it; rows written before M185 have none.
        let row = MessageState(out)
        let stored = try JSON.plainDecoder.decode(MessageState.self, from: JSON.plainEncoder.encode(row))
        XCTAssertEqual(stored.hiddenPreviews, ["https://example.com/"])
        var legacy = try XCTUnwrap(JSONSerialization.jsonObject(with: JSON.plainEncoder.encode(row)) as? [String: Any])
        legacy.removeValue(forKey: "hiddenPreviews")
        XCTAssertEqual(try JSON.plainDecoder.decode(MessageState.self, from: JSONSerialization.data(withJSONObject: legacy)).hiddenPreviews, [])
        // And back into the server's shape (thread rows built from the timeline).
        XCTAssertEqual(MessageOut(row)?.hiddenPreviews, ["https://example.com/"])
    }

    func testAPreviewThatCannotBeReadKeepsOnlyItsIdAndState() throws {
        let json = #"""
        {"items":[
          {"id":"0190A1B2-0000-7000-8000-00000000000A","state":"ok","channel_id":"c1","channel_type":"public","channel_name":"general",
           "parent_id":null,"sender_id":"11111111-1111-4111-8111-111111111111","created_at":"2026-11-05T01:24:00Z","edited_at":null,"excerpt":"こんにちは","excerpt_truncated":false,
           "attachment_count":1,"attachment_types":["image/png"],"thumbnail_attachment_id":"a1"},
          {"id":"0190a1b2-0000-7000-8000-00000000000b","state":"unavailable","channel_id":"c9","sender_id":"u9","excerpt":"secret"},
          {"id":"0190a1b2-0000-7000-8000-00000000000c","state":"deleted"},
          {"id":"0190a1b2-0000-7000-8000-00000000000d","state":"something_new","excerpt":"?"}
        ]}
        """#
        let items = try JSON.snakeDecoder.decode(MessagePreviewsOut.self, from: Data(json.utf8)).items
        XCTAssertEqual(items[0].id, "0190a1b2-0000-7000-8000-00000000000a", "ids in lower case, as the links give them")
        XCTAssertEqual(items[0].channelName, "general")
        XCTAssertEqual(items[0].attachmentTypes, ["image/png"])
        XCTAssertEqual(items[0].thumbnailAttachmentId, "a1")
        XCTAssertEqual(items[1], MessagePreviewOut(id: "0190a1b2-0000-7000-8000-00000000000b", state: "unavailable"))
        XCTAssertEqual(items[2], MessagePreviewOut(id: "0190a1b2-0000-7000-8000-00000000000c", state: "deleted"))
        XCTAssertEqual(items[3], MessagePreviewOut(id: "0190a1b2-0000-7000-8000-00000000000d", state: "unavailable"))
        XCTAssertEqual(MessageCardSlot.of(.init(preview: items[0], at: Date())), .card(items[0]))
        XCTAssertEqual(MessageCardSlot.of(.init(preview: items[1], at: Date())), .unavailable)
        XCTAssertEqual(MessageCardSlot.of(.init(preview: items[2], at: Date())), .deleted)
        XCTAssertEqual(MessageCardSlot.of(nil), .loading)
        XCTAssertEqual(MessageCardSlot.of(.init(preview: nil, at: Date(), failedAt: Date())), .none)
    }

    /// SYNC_PROTOCOL.md §6: change "previews" is a message.updated like any other: the row is replaced.
    func testARemovalFromAnotherDeviceArrivesAsAMessageUpdate() async throws {
        let server = FakeServer()
        let alice = server.addUser("alice")
        let bob = server.addUser("bob")
        let channel = server.createChannel("general", ownerId: alice.id)
        server.join(channel.id, bob.id)
        let store = Store()
        var options = EngineOptions()
        options.reconnectMin = 0
        options.sleep = { _ in }
        options.random = { 0.5 }
        let engine = SyncEngine(api: server.api(for: bob.id), connect: server.connector(for: bob.id), wsUrl: URL(string: "ws://fake")!, store: store,
                                getAccessToken: { "token" }, options: options)
        engine.isActive = { false }
        await engine.start()
        await engine.openChannel(channel.id)
        await settle(engine)

        let (post, _) = try server.post(channelId: channel.id, senderId: alice.id, body: "見て https://Example.com/page#top")
        await settle(engine)
        let row = try XCTUnwrap(store.message(channel.id, id: post.id))
        XCTAssertEqual(MessageLinkCards.of(row, base: URL(string: "http://server")).external, "https://Example.com/page#top")

        let updated = try XCTUnwrap(server.setHiddenPreviews(channelId: channel.id, messageId: post.id, ["https://example.com/page"]))
        await settle(engine)
        let hidden = try XCTUnwrap(store.message(channel.id, id: post.id))
        XCTAssertEqual(hidden.hiddenPreviews, ["https://example.com/page"])
        XCTAssertEqual(hidden.updatedSeq, updated.updatedSeq)
        XCTAssertNil(MessageLinkCards.of(hidden, base: URL(string: "http://server")).external)
        XCTAssertEqual(store.channel(channel.id)?.syncedSeq, updated.updatedSeq)

        server.setHiddenPreviews(channelId: channel.id, messageId: post.id, [])
        await settle(engine)
        XCTAssertEqual(store.message(channel.id, id: post.id)?.hiddenPreviews, [])
        engine.stop()
    }

    // MARK: asking for the cards (§3.3)

    func testCardsAskedWithinAMomentGoInOneRequestTwentyAtATimeAndStayFiveMinutes() async throws {
        let calls = Calls()
        StubProtocol.handler = { request in
            let ids = Self.ids(of: request)
            calls.add(ids)
            return (200, Self.answer(ids, state: "unavailable"))
        }
        let previews = MessagePreviews()
        var clock = Date(timeIntervalSince1970: 1_800_000_000)
        previews.now = { clock }
        let api = makeApi()
        let ids = (0..<25).map { String(format: "0190a1b2-0000-7000-8000-%012d", $0) }
        for id in ids { previews.request(id, api: api) }
        previews.request(ids[0], api: api) // asked twice in the moment: once
        try await waitUntil { previews.entries.count == 25 }
        XCTAssertEqual(calls.all, [Array(ids[0..<20]), Array(ids[20..<25])])
        XCTAssertEqual(MessageCardSlot.of(previews.entries[ids[24]]), .unavailable)

        // Fresh: drawn again (the row back on screen), not asked again.
        clock += 4 * 60
        for id in ids.prefix(3) { previews.request(id, api: api) }
        try await Task.sleep(for: .milliseconds(150))
        XCTAssertEqual(calls.all.count, 2)

        // Five minutes on: asked again when drawn, the old card shown meanwhile.
        clock += 61
        previews.request(ids[3], api: api)
        XCTAssertEqual(MessageCardSlot.of(previews.entries[ids[3]]), .unavailable)
        try await waitUntil { calls.all.count == 3 }
        XCTAssertEqual(calls.all.last, [ids[3]])
    }

    func testAFailureShowsNoCardAndIsAskedAgainAfterAMinute() async throws {
        let id = "0190a1b2-0000-7000-8000-00000000000a"
        let calls = Calls()
        let status = Locked(429)
        StubProtocol.handler = { request in
            let ids = Self.ids(of: request)
            calls.add(ids)
            let code = status.value
            if code != 200 { return (code, Data(#"{"error":{"code":"rate_limited","message":"slow down","details":{}}}"#.utf8)) }
            return (200, Self.answer(ids, state: "deleted"))
        }
        let previews = MessagePreviews()
        var clock = Date(timeIntervalSince1970: 1_800_000_000)
        previews.now = { clock }
        let api = makeApi()
        previews.request(id, api: api)
        XCTAssertEqual(MessageCardSlot.of(previews.entries[id]), .loading, "the frame while it is asked")
        try await waitUntil { previews.entries[id] != nil }
        XCTAssertEqual(MessageCardSlot.of(previews.entries[id]), .none, "429: no card (the link in the text still opens it)")

        clock += 59
        previews.request(id, api: api)
        try await Task.sleep(for: .milliseconds(150))
        XCTAssertEqual(calls.all.count, 1, "not again within the minute")

        status.value = 200
        clock += 2
        previews.request(id, api: api)
        try await waitUntil { MessageCardSlot.of(previews.entries[id]) == .deleted }
        XCTAssertEqual(calls.all.count, 2)

        // A later failure keeps the card known before (stale, asked again, refused).
        status.value = 503
        clock += 6 * 60
        previews.request(id, api: api)
        try await waitUntil { calls.all.count == 3 && previews.entries[id]?.failedAt != nil }
        XCTAssertEqual(MessageCardSlot.of(previews.entries[id]), .deleted)
        XCTAssertFalse(previews.wanted(id))
    }

    // MARK: what a card shows (§5)

    private let users: [String: UserPublic] = [
        "11111111-1111-4111-8111-111111111111": UserPublic(id: "11111111-1111-4111-8111-111111111111", username: "kano", displayName: "加納", role: "member", deactivatedAt: nil, createdAt: "", updatedAt: ""),
        "22222222-2222-4222-8222-222222222222": UserPublic(id: "22222222-2222-4222-8222-222222222222", username: "ebi", displayName: "海老", role: "member", deactivatedAt: nil, createdAt: "", updatedAt: ""),
    ]

    func testTheExcerptIsUpToFourPlainLinesWithNames() {
        XCTAssertEqual(MessageLinkCards.excerptText("**決定** <@11111111-1111-4111-8111-111111111111> と <@ffffffff-ffff-4fff-8fff-ffffffffffff>\n\n> 引用\n- 項目", truncated: false, users: users),
                       "決定 @加納 と @メンバー\n引用\n項目")
        XCTAssertEqual(MessageLinkCards.excerptText("1\n2\n\n3\n```\n4\n```\n5", truncated: false, users: users), "1\n2\n3\n4…")
        XCTAssertEqual(MessageLinkCards.excerptText("1\n2", truncated: true, users: users), "1\n2…", "the server cut it")
        XCTAssertEqual(MessageLinkCards.excerptText("", truncated: false, users: users), "")
    }

    func testWithoutTextTheCardSaysWhatWasSentAndAHeldRowWins() {
        var preview = MessagePreviewOut(id: "m9", state: "ok")
        preview.attachmentTypes = ["image/png", "image/jpeg"]
        preview.attachmentCount = 2
        XCTAssertEqual(MessageLinkCards.cardText(preview, live: nil, users: users), "画像を 2 枚送信しました")
        preview.attachmentTypes = ["image/png"]
        preview.attachmentCount = 12 // more than the ten types sent
        XCTAssertEqual(MessageLinkCards.cardText(preview, live: nil, users: users), "画像を 12 枚送信しました")
        preview.excerpt = "古い本文"
        var live = message("編集した本文 <@22222222-2222-4222-8222-222222222222>")
        XCTAssertEqual(MessageLinkCards.cardText(preview, live: live, users: users), "編集した本文 @海老")
        live.body = ""
        live.attachments = [attachment("f1", "application/pdf")]
        XCTAssertEqual(MessageLinkCards.cardText(preview, live: live, users: users), "ファイルを送信しました")
    }

    func testTheThumbnailOfAHeldRowIsTheFirstPhotoStillInTheChannelsDrive() {
        var moved = attachment("p1", "image/png", thumbnail: true)
        moved.drive = AttachmentDriveOut(state: "moved")
        var video = attachment("v1", "video/mp4")
        video.hasPoster = true
        XCTAssertEqual(MessageLinkCards.thumbnail([attachment("f1", "application/pdf"), moved, video]), "v1")
        XCTAssertNil(MessageLinkCards.thumbnail([attachment("f1", "application/pdf")]))
    }

    func testTheConversationLine() {
        let store = Store()
        store.setMe(me("me"))
        for user in users.values { store.upsertUser(user) }
        var preview = MessagePreviewOut(id: "m1", state: "ok")
        preview.channelId = "c1"
        preview.channelType = "public"
        preview.channelName = "general"
        XCTAssertEqual(MessageLinkCards.conversation(preview, channel: nil, store: store), "#general")
        preview.parentId = "p1"
        XCTAssertEqual(MessageLinkCards.conversation(preview, channel: nil, store: store), "#general のスレッド")
        preview.channelType = "dm"
        preview.channelName = nil
        preview.parentId = nil
        XCTAssertEqual(MessageLinkCards.conversation(preview, channel: nil, store: store), "ダイレクトメッセージ", "not in my list")
        let dm = ChannelState(channel: ChannelOut(id: "c1", type: "dm", name: nil, topic: nil, purpose: nil, archived: false, createdBy: nil, lastSeq: 0,
                                                  lastMessageAt: nil, createdAt: "", updatedAt: "", membership: nil, dmUserIds: ["me", "22222222-2222-4222-8222-222222222222"]),
                              isMember: true, syncedSeq: nil, lastSeq: 0, hasOlder: false)
        XCTAssertEqual(MessageLinkCards.conversation(preview, channel: dm, store: store), "海老", "the other person, from my list")
        preview.parentId = "p1"
        XCTAssertEqual(MessageLinkCards.conversation(preview, channel: dm, store: store), "海老 のスレッド")
    }

    func testTheTimeReadsAsOnTheDesktop() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Tokyo")!
        let now = parseIsoDate("2026-11-05T09:00:00Z")!
        XCTAssertEqual(MessageLinkCards.timeLabel("2026-11-05T01:24:00Z", now: now, calendar: calendar), "今日 10:24")
        XCTAssertEqual(MessageLinkCards.timeLabel("2026-11-04T00:05:00Z", now: now, calendar: calendar), "昨日 09:05")
        XCTAssertNil(MessageLinkCards.timeLabel(nil, now: now, calendar: calendar))
    }

    /// The card's frame comes before its answer and the answer fills it (the M11g card's lesson, §8 3.): loading, a short
    /// readable card and 「表示できないメッセージ」 are as tall; the rows' cards go in one request.
    func testTheCardHoldsItsFrameUntilItsAnswerComes() throws {
        let readable = "0190a1b2-0000-7000-8000-00000000000a"
        let hidden = "0190a1b2-0000-7000-8000-00000000000b"
        let calls = Calls()
        StubProtocol.handler = { request in
            let ids = Self.ids(of: request)
            calls.add(ids)
            let items = ids.map { id in
                id == readable
                    ? #"{"id":"\#(id)","state":"ok","channel_id":"c1","channel_type":"public","channel_name":"general","sender_id":"11111111-1111-4111-8111-111111111111","#
                        + #""created_at":"2026-11-05T01:24:00Z","excerpt":"了解です","excerpt_truncated":false}"#
                    : #"{"id":"\#(id)","state":"unavailable"}"#
            }
            return (200, Data(#"{"items":[\#(items.joined(separator: ","))]}"#.utf8))
        }
        let controller = controller()
        for user in users.values { controller.store.upsertUser(user) }
        let plain = show(VStack(alignment: .leading, spacing: 0) {
            MessageRow(message: message("前の話", id: "m3"), controller: controller).equatable()
            MessageRow(message: message("こちら", id: "m4"), controller: controller).equatable()
        })()
        let first = message("前の話 http://server/m/\(readable)", id: "m1")
        let second = message("こちら http://server/m/\(hidden)", id: "m2")
        let heights = show(VStack(alignment: .leading, spacing: 0) {
            MessageRow(message: first, controller: controller).equatable()
            MessageRow(message: second, controller: controller).equatable()
        })
        let before = heights()
        XCTAssertEqual(controller.messageCardSlot(readable), .loading)

        spin(until: { controller.store.messagePreviews.entries.count == 2 })

        XCTAssertEqual(calls.all.count, 1, "the rows' cards in one request")
        XCTAssertEqual(Set(calls.all.first ?? []), [readable, hidden])
        XCTAssertEqual(controller.messageCardSlot(hidden), .unavailable)
        guard case .card = controller.messageCardSlot(readable) else { return XCTFail("the readable card") }
        XCTAssertGreaterThan(before, plain + 2 * 60, "each row holds the card's frame from the start")
        XCTAssertEqual(heights(), before, accuracy: 1, "the answers fill the frames: the rows do not grow")
    }

    /// Every state of the card, light and dark, under the rows that link to them. Run with TEST_RUNNER_SNAPSHOT_DIR=<dir>
    /// to look at them.
    func testSnapshotsOfEveryState() throws {
        let ids = (1...6).map { String(format: "0190a1b2-0000-7000-8000-%012d", $0) }
        let dm = "0190a1b2-0000-7000-8000-0000000000dd"
        let photo = UIGraphicsImageRenderer(size: CGSize(width: 64, height: 64)).pngData { context in
            UIColor.systemTeal.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 64, height: 64))
        }
        StubProtocol.handler = { request in
            switch request.url?.path {
            case "/api/v1/messages/previews":
                let sender = "11111111-1111-4111-8111-111111111111"
                let items = Self.ids(of: request).map { id -> String in
                    switch id {
                    case ids[0]:
                        return #"{"id":"\#(id)","state":"ok","channel_id":"c1","channel_type":"public","channel_name":"general","sender_id":"\#(sender)","#
                            + #""created_at":"2026-11-05T01:24:00Z","excerpt":"**来週の輪講**は <@\#(sender)> の担当です。\n\n資料は共有ドライブに置きました。\n質問はスレッドへ\n4 行目\n5 行目","#
                            + #""excerpt_truncated":false,"attachment_count":1,"attachment_types":["image/png"],"thumbnail_attachment_id":"a1"}"#
                    case ids[1]:
                        return #"{"id":"\#(id)","state":"ok","channel_id":"\#(dm)","channel_type":"dm","sender_id":"22222222-2222-4222-8222-222222222222","#
                            + #""parent_id":"p1","created_at":"2026-11-04T00:05:00Z","excerpt":"","attachment_count":2,"attachment_types":["image/png","image/png"]}"#
                    case ids[2]: return #"{"id":"\#(id)","state":"unavailable"}"#
                    case ids[3]: return #"{"id":"\#(id)","state":"deleted"}"#
                    case ids[4]:
                        return #"{"id":"\#(id)","state":"ok","channel_id":"c1","channel_type":"private","channel_name":"lab","sender_id":"33333333-3333-4333-8333-333333333333","#
                            + #""created_at":"2026-10-01T03:00:00Z","excerpt":"見せたくない話","excerpt_truncated":false}"#
                    default: return #"{"id":"\#(id)","state":"ok"}"#
                    }
                }
                Thread.sleep(forTimeInterval: 0.05)
                return (200, Data(#"{"items":[\#(items.joined(separator: ","))]}"#.utf8))
            case "/api/v1/attachments/a1/thumbnail":
                return (200, photo)
            case "/api/v1/link-previews":
                return (200, Data(#"{"url":"https://www.python.org/","status":"ok","title":"Welcome to Python.org","description":"The official home","#
                    .utf8) + Data(#""image_url":null,"site_name":"Python.org","fetched_at":"2026-11-05T00:00:00Z"}"#.utf8))
            default:
                return (404, Data())
            }
        }
        let controller = controller()
        for user in users.values { controller.store.upsertUser(user) }
        controller.store.upsertUser(UserPublic(id: "33333333-3333-4333-8333-333333333333", username: "spam", displayName: "迷惑", role: "member",
                                               deactivatedAt: nil, createdAt: "", updatedAt: ""))
        controller.store.setBlocked("33333333-3333-4333-8333-333333333333", on: true)
        _ = controller.store.upsertChannel(ChannelOut(id: dm, type: "dm", name: nil, topic: nil, purpose: nil, archived: false, createdBy: nil, lastSeq: 0,
                                                      lastMessageAt: nil, createdAt: "", updatedAt: "", membership: nil,
                                                      dmUserIds: ["me", "22222222-2222-4222-8222-222222222222"]), isMember: true)
        // The loading frame: a card never answered (asked for from another row's link that the stub leaves out).
        let rows = [
            message("前の話 http://server/m/\(ids[0]) と https://www.python.org/", id: "m1"),
            message("http://server/m/\(ids[1])\nhttp://server/m/\(ids[2])", id: "m2"),
            message("http://server/m/\(ids[3]) http://server/m/\(ids[4])", id: "m3"),
        ]
        let view = ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(rows) { row in MessageRow(message: row, controller: controller, margin: 16).equatable() }
                MessageLinkCard(controller: controller, messageId: ids[5]).padding(.horizontal, 62)
            }
        }
        for style in [UIUserInterfaceStyle.light, .dark] {
            let image = try render(view, style: style, name: "link-cards/\(style == .dark ? "dark" : "light").png")
            XCTAssertGreaterThan(image.size.height, 0)
        }
        XCTAssertEqual(controller.messageCardSlot(ids[5]), .loading)
        guard case .card = controller.messageCardSlot(ids[0]) else { return XCTFail("answered") }
    }

    private func render<V: View>(_ view: V, size: CGSize = CGSize(width: 393, height: 852), style: UIUserInterfaceStyle, name: String) throws -> UIImage {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        let window = scene.map { UIWindow(windowScene: $0) } ?? UIWindow(frame: CGRect(origin: .zero, size: size))
        window.frame = CGRect(origin: .zero, size: size)
        window.overrideUserInterfaceStyle = style
        let host = UIHostingController(rootView: view)
        host.view.backgroundColor = .systemBackground
        window.rootViewController = host
        window.makeKeyAndVisible()
        host.view.frame = window.bounds
        host.view.layoutIfNeeded()
        RunLoop.current.run(until: Date().addingTimeInterval(1.0))
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { context in
            if !window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) { window.layer.render(in: context.cgContext) }
        }
        window.isHidden = true
        if let dir = ProcessInfo.processInfo.environment["SNAPSHOT_DIR"], let data = image.pngData() {
            let url = URL(fileURLWithPath: dir).appendingPathComponent(name)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: url)
            print("snapshot written: \(url.path)")
        }
        return image
    }

    // MARK: removing a card (§4)

    func testOnlyTheSenderOrAnAdministratorRemovesASentMessagesCards() {
        let sent = message("x")
        XCTAssertTrue(MessageLinkCards.canRemove(sent, meId: "me", isAdmin: false, readOnly: false))
        XCTAssertFalse(MessageLinkCards.canRemove(sent, meId: "someone", isAdmin: false, readOnly: false))
        XCTAssertTrue(MessageLinkCards.canRemove(sent, meId: "someone", isAdmin: true, readOnly: false), "an administrator, anyone's")
        XCTAssertFalse(MessageLinkCards.canRemove(sent, meId: "me", isAdmin: true, readOnly: true), "not in a channel read before joining")
        XCTAssertFalse(MessageLinkCards.canRemove(sent, meId: nil, isAdmin: false, readOnly: false))
        var pending = message("x")
        pending.pending = true
        pending.seq = nil
        XCTAssertFalse(MessageLinkCards.canRemove(pending, meId: "me", isAdmin: false, readOnly: false), "not sent yet")
        var system = message("x")
        system.type = "system"
        XCTAssertFalse(MessageLinkCards.canRemove(system, meId: "me", isAdmin: true, readOnly: false))
    }

    func testTheLongPressOffersTheCardsShownNow() {
        let controller = controller()
        for user in users.values { controller.store.upsertUser(user) }
        let shown = "0190a1b2-0000-7000-8000-00000000000a"
        let failed = "0190a1b2-0000-7000-8000-00000000000b"
        let blocked = "0190a1b2-0000-7000-8000-00000000000c"
        let row = message("http://server/m/\(shown) http://server/m/\(failed) http://server/m/\(blocked) https://example.com/page")
        XCTAssertEqual(controller.shownCards(row).map(\.label), ["メッセージを読み込み中…", "メッセージを読み込み中…", "メッセージを読み込み中…", "example.com"],
                       "the frames while they are asked, the Open Graph card's too")
        let previews = controller.store.messagePreviews
        StubProtocol.handler = { request in
            let ids = Self.ids(of: request)
            if ids == [failed] { return (503, Data()) }
            let items = ids.map { id in
                #"{"id":"\#(id)","state":"ok","channel_id":"c1","channel_type":"public","channel_name":"general","sender_id":"\#(id == blocked ? "22222222-2222-4222-8222-222222222222" : "11111111-1111-4111-8111-111111111111")"}"#
            }
            return (200, Data(#"{"items":[\#(items.joined(separator: ","))]}"#.utf8))
        }
        previews.request(shown, api: controller.api)
        previews.request(blocked, api: controller.api)
        spin(until: { previews.entries.count == 2 })
        previews.request(failed, api: controller.api)
        spin(until: { previews.entries.count == 3 })
        controller.store.setBlocked("22222222-2222-4222-8222-222222222222", on: true)
        controller.store.setLinkPreview("https://example.com/page", LinkPreviewOut(url: "https://example.com/page", status: "ok", title: "例のページ",
                                                                                   description: nil, imageUrl: nil, siteName: "Example", fetchedAt: ""))
        XCTAssertEqual(controller.shownCards(row), [
            ShownLinkCard(url: "http://server/m/\(shown)", label: "加納 · #general"),
            ShownLinkCard(url: "http://server/m/\(blocked)", label: "ブロック中のユーザーのメッセージ"),
            ShownLinkCard(url: "https://example.com/page", label: "例のページ"),
        ])
    }

    func testRemovingReplacesTheRowAndSaysSoWithUndo() async throws {
        let sent = Calls()
        let version = Locked(1)
        StubProtocol.handler = { request in
            guard request.httpMethod == "PUT", request.url?.path == "/api/v1/messages/m1/previews/hidden" else { return (404, Data()) }
            let body = Self.body(of: request)
            let hidden = body["hidden"] as? Bool ?? false
            sent.add([body["url"] as? String ?? "", hidden ? "hidden" : "shown"])
            version.value += 1
            let keys = hidden ? #"["https://example.com/page"]"# : "[]"
            return (200, Data((#"{"id":"m1","channel_id":"c1","sender_id":"me","seq":1,"updated_seq":\#(version.value),"client_msg_id":null,"#
                + #""body":"見て https://Example.com/page#top","created_at":"2026-11-05T00:00:00Z","edited_at":null,"deleted":false,"#
                + #""hidden_previews":\#(keys)}"#).utf8))
        }
        let controller = controller()
        let row = message("見て https://Example.com/page#top")
        _ = controller.store.upsertMessage(row)

        let ok = await controller.setPreviewHidden(row, url: "https://Example.com/page#top", hidden: true)
        XCTAssertTrue(ok)
        XCTAssertEqual(sent.all, [["https://Example.com/page#top", "hidden"]], "the link as written; no confirmation first")
        XCTAssertEqual(controller.store.message("c1", id: "m1")?.hiddenPreviews, ["https://example.com/page"])
        XCTAssertEqual(controller.store.message("c1", id: "m1")?.updatedSeq, 2)
        XCTAssertEqual(controller.notice, "プレビューを削除しました")
        let undo = try XCTUnwrap(controller.noticeAction)
        XCTAssertEqual(undo.notice, "プレビューを削除しました")
        XCTAssertEqual(undo.label, "元に戻す")

        undo.run()
        try await waitUntil { controller.store.message("c1", id: "m1")?.hiddenPreviews == [] }
        XCTAssertEqual(sent.all.last, ["https://Example.com/page#top", "shown"])
        XCTAssertEqual(controller.store.message("c1", id: "m1")?.updatedSeq, 3)
    }

    func testARefusalShowsTheErrorAndLeavesTheRow() async {
        StubProtocol.handler = { _ in
            (403, Data(#"{"error":{"code":"not_message_owner","message":"no","details":{}}}"#.utf8))
        }
        let controller = controller()
        let row = message("見て https://example.com/page")
        _ = controller.store.upsertMessage(row)
        let ok = await controller.setPreviewHidden(row, url: "https://example.com/page", hidden: true)
        XCTAssertFalse(ok)
        XCTAssertNotNil(controller.error)
        XCTAssertNil(controller.notice)
        XCTAssertEqual(controller.store.message("c1", id: "m1")?.hiddenPreviews, [])
    }

    // MARK: helpers

    /// What the stub saw (written from URLProtocol's thread).
    private final class Calls: @unchecked Sendable {
        private let lock = NSLock()
        private var calls: [[String]] = []
        func add(_ call: [String]) { lock.lock(); calls.append(call); lock.unlock() }
        var all: [[String]] { lock.lock(); defer { lock.unlock() }; return calls }
    }

    private final class Locked<Value>: @unchecked Sendable {
        private let lock = NSLock()
        private var stored: Value
        init(_ value: Value) { stored = value }
        var value: Value {
            get { lock.lock(); defer { lock.unlock() }; return stored }
            set { lock.lock(); stored = newValue; lock.unlock() }
        }
    }

    nonisolated private static func body(of request: URLRequest) -> [String: Any] {
        let data = request.httpBodyStream.map { stream -> Data in
            stream.open(); defer { stream.close() }
            var data = Data(); var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable { let n = stream.read(&buffer, maxLength: buffer.count); if n <= 0 { break }; data.append(buffer, count: n) }
            return data
        } ?? request.httpBody ?? Data()
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    }

    nonisolated private static func ids(of request: URLRequest) -> [String] {
        guard request.httpMethod == "POST", request.url?.path == "/api/v1/messages/previews" else { return [] }
        return body(of: request)["ids"] as? [String] ?? []
    }

    nonisolated private static func answer(_ ids: [String], state: String) -> Data {
        Data(#"{"items":[\#(ids.map { #"{"id":"\#($0)","state":"\#(state)"}"# }.joined(separator: ","))]}"#.utf8)
    }

    private func makeApi() -> ApiClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        let api = ApiClient(baseUrl: URL(string: "http://server")!, session: URLSession(configuration: configuration))
        api.accessToken = "a"
        return api
    }

    private func me(_ id: String, role: String = "member") -> UserMe {
        UserMe(id: id, username: id, displayName: "Kano", role: role, deactivatedAt: nil, createdAt: "", updatedAt: "", email: nil, mustChangePassword: false)
    }

    private func controller() -> AppController {
        let controller = AppController(defaults: UserDefaults(suiteName: "link-cards-\(UUID().uuidString)")!)
        controller.api = makeApi()
        controller.store.setMe(me("me"))
        return controller
    }

    private func message(_ body: String, id: String = "m1") -> MessageState {
        var message = MessageState(placeholderFor: "k-\(id)", channelId: "c1", senderId: "me", body: body, createdAt: "2026-11-05T00:00:00Z")
        message.id = id
        message.seq = 1
        message.updatedSeq = 1
        message.pending = false
        return message
    }

    private func attachment(_ id: String, _ type: String, thumbnail: Bool = false) -> AttachmentOut {
        AttachmentOut(id: id, filename: "f", contentType: type, sizeBytes: 1, width: nil, height: nil, hasThumbnail: thumbnail, status: "attached", createdAt: "")
    }

    private func settle(_ engine: SyncEngine) async {
        for _ in 0..<50 {
            await engine.idle()
            await Task.yield()
        }
    }

    private func waitUntil(_ done: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(3)
        while !done() && Date() < deadline { try await Task.sleep(for: .milliseconds(20)) }
        XCTAssertTrue(done(), "timed out")
    }

    private func spin(until done: () -> Bool) {
        let deadline = Date().addingTimeInterval(3)
        while !done() && Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.05)) }
        RunLoop.current.run(until: Date().addingTimeInterval(0.3))
    }

    /// The view's height in a window, as in the conversation (LinkPreviewRowTests).
    private func show<Content: View>(_ view: Content, width: CGFloat = 393) -> () -> CGFloat {
        let size = CGSize(width: width, height: 900)
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        let window = scene.map { UIWindow(windowScene: $0) } ?? UIWindow(frame: CGRect(origin: .zero, size: size))
        window.frame = CGRect(origin: .zero, size: size)
        let host = UIHostingController(rootView: AnyView(VStack(alignment: .leading, spacing: 0) {
            Text("above")
            view
            Text("below")
            Spacer()
        }))
        window.rootViewController = host
        window.makeKeyAndVisible()
        self.window = window
        self.host = host
        host.view.frame = window.bounds
        host.view.layoutIfNeeded()
        let fits = CGSize(width: size.width, height: UIView.layoutFittingCompressedSize.height)
        return {
            host.view.layoutIfNeeded()
            return host.sizeThatFits(in: fits).height
        }
    }
}
