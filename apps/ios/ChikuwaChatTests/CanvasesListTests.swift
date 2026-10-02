import XCTest
@testable import ChikuwaChat

/// M78 (CANVAS.md §21.1): the home's 「キャンバス」 — GET /canvases page by page, the title filter, the canvases kept on
/// the device when the list cannot be read, and where a row opens.

private func meta(_ id: String, channel: String = "lab", title: String = "議事録", version: Int = 1, updatedAt: String = "2026-10-01T00:00:00Z",
                  updatedBy: String = "u2", isTab: Bool = false, tasks: (Int, Int) = (0, 0)) -> CanvasMeta {
    CanvasMeta(id: id, channelId: channel, title: title, version: version, headRevId: "\(id)-r\(version)", isChannelTab: isTab, editPolicy: "members",
               templateKey: nil, shareMessageId: nil, taskTotal: tasks.0, taskDone: tasks.1, createdBy: "u2", updatedBy: updatedBy,
               createdAt: "2026-10-01T00:00:00Z", updatedAt: updatedAt)
}

private func stamp(_ index: Int) -> String {
    // Newest first: a larger index is older.
    let date = Date(timeIntervalSince1970: 1_790_000_000 - Double(index) * 60)
    return ISO8601DateFormatter().string(from: date)
}

@MainActor
private func join(_ store: Store, _ id: String = "lab", member: Bool = true, type: String = "public") {
    let out = ChannelOut(id: id, type: type, name: id, topic: nil, purpose: nil, archived: false, createdBy: nil, lastSeq: 0, lastMessageAt: nil,
                         createdAt: "", updatedAt: "", membership: member ? MembershipOut(role: "member", joinedAt: "") : nil, dmUserIds: nil)
    _ = store.upsertChannel(out, isMember: member)
}

private final class FakeCanvasesApi: MyCanvasesApi {
    var pages: [String: CanvasPage] = [:]
    var error: Error?
    private(set) var calls: [(cursor: String?, limit: Int)] = []

    func myCanvases(cursor: String?, limit: Int) async throws -> CanvasPage {
        calls.append((cursor, limit))
        if let error { throw error }
        return pages[cursor ?? ""] ?? CanvasPage(items: [], nextCursor: nil)
    }
}

@MainActor
final class CanvasesListTests: XCTestCase {
    // MARK: the request

    func testTheRequestAsksForAPageAfterTheCursor() async throws {
        var seen: [URLComponents] = []
        StubProtocol.handler = { request in
            seen.append(URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!)
            return (200, Data("""
            {"items": [{"id": "cv1", "channel_id": "lab", "title": "週報", "version": 3, "head_rev_id": "r3", "is_channel_tab": true,
                        "edit_policy": "members", "template_key": null, "share_message_id": null, "task_total": 4, "task_done": 1,
                        "created_by": "u2", "updated_by": "u3", "created_at": "2026-10-01T00:00:00Z", "updated_at": "2026-10-02T00:00:00Z",
                        "deleted_at": null}],
             "next_cursor": "2026-10-02T00:00:00Z|cv1"}
            """.utf8))
        }
        defer { StubProtocol.handler = nil }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        let client = ApiClient(baseUrl: URL(string: "http://server")!, session: URLSession(configuration: configuration))
        client.accessToken = "a"
        let first = try await client.myCanvases(cursor: nil, limit: 50)
        _ = try await client.myCanvases(cursor: "2026-10-02T00:00:00Z|cv1", limit: 50)
        XCTAssertEqual(seen.map(\.path), ["/api/v1/canvases", "/api/v1/canvases"])
        XCTAssertEqual(seen[0].queryItems, [URLQueryItem(name: "limit", value: "50")])
        XCTAssertEqual(seen[1].queryItems, [URLQueryItem(name: "limit", value: "50"), URLQueryItem(name: "cursor", value: "2026-10-02T00:00:00Z|cv1")])
        XCTAssertEqual(first.nextCursor, "2026-10-02T00:00:00Z|cv1")
        XCTAssertEqual(first.items.first?.title, "週報")
        XCTAssertEqual(first.items.first?.updatedBy, "u3")
        XCTAssertEqual(first.items.first?.isChannelTab, true)
    }

    // MARK: paging

    func testPagesOfFiftyAppendWithoutRepeatsUntilTheLastOne() async {
        let store = Store()
        join(store)
        let api = FakeCanvasesApi()
        let firstPage = (0..<50).map { meta("cv\($0)", updatedAt: stamp($0)) }
        api.pages[""] = CanvasPage(items: firstPage, nextCursor: "p2")
        // The second page repeats the last of the first (a canvas saved meanwhile moves between pages).
        api.pages["p2"] = CanvasPage(items: [meta("cv49", updatedAt: stamp(49)), meta("cv50", updatedAt: stamp(50))], nextCursor: nil)
        let model = CanvasesModel()
        XCTAssertNil(model.items)

        await model.reload(api: api, store: store)
        XCTAssertEqual(model.items?.count, 50)
        XCTAssertEqual(model.cursor, "p2")
        XCTAssertFalse(model.offline)
        XCTAssertEqual(api.calls.map(\.limit), [CanvasesModel.pageSize])
        XCTAssertEqual(CanvasesModel.pageSize, 50)

        let failure = await model.loadMore(api: api)
        XCTAssertNil(failure)
        XCTAssertEqual(model.items?.count, 51)
        XCTAssertEqual(model.items?.last?.id, "cv50")
        XCTAssertNil(model.cursor)
        XCTAssertEqual(api.calls.map(\.cursor), [nil, "p2"])
        // The last page read: nothing more is asked.
        _ = await model.loadMore(api: api)
        XCTAssertEqual(api.calls.count, 2)

        // Pull to refresh: the first page again, the list replaced.
        api.pages[""] = CanvasPage(items: [meta("new", updatedAt: stamp(-1))], nextCursor: nil)
        await model.reload(api: api, store: store)
        XCTAssertEqual(model.items?.map(\.id), ["new"])
    }

    func testANextPageThatFailsKeepsTheListAndTheCursor() async {
        let store = Store()
        join(store)
        let api = FakeCanvasesApi()
        api.pages[""] = CanvasPage(items: [meta("cv1")], nextCursor: "p2")
        let model = CanvasesModel()
        await model.reload(api: api, store: store)
        api.error = ApiError.network(URLError(.notConnectedToInternet))
        let failure = await model.loadMore(api: api)
        XCTAssertNotNil(failure)
        XCTAssertEqual(model.items?.map(\.id), ["cv1"])
        XCTAssertEqual(model.cursor, "p2") // scrolling to the end tries again
        XCTAssertFalse(model.offline)
    }

    // MARK: what the list shows

    func testRowsTakeNewerMetadataAndDropTrashedAndLeftConversations() async {
        let store = Store()
        join(store, "lab")
        join(store, "seminar")
        join(store, "gone", member: false)
        let api = FakeCanvasesApi()
        api.pages[""] = CanvasPage(items: [meta("a", channel: "lab", title: "週報", updatedAt: stamp(1)),
                                           meta("b", channel: "seminar", title: "輪講", updatedAt: stamp(2)),
                                           meta("c", channel: "gone", title: "退出した会話", updatedAt: stamp(3)),
                                           meta("d", channel: "lab", title: "ゴミ箱", updatedAt: stamp(4))],
                                    nextCursor: nil)
        let model = CanvasesModel()
        await model.reload(api: api, store: store)
        XCTAssertEqual(model.rows(store: store, query: "").map(\.id), ["a", "b", "d"])

        // The conversation opened here since: its list knows 「輪講」 renamed and saved later (the larger version), and 「ゴミ箱」
        // went to the trash (not in the conversation's list any more).
        store.setCanvases("lab", [meta("a", channel: "lab", title: "週報", updatedAt: stamp(1))])
        store.setCanvases("seminar", [meta("b", channel: "seminar", title: "輪講 第3回", version: 2, updatedAt: stamp(-5))])
        XCTAssertEqual(model.rows(store: store, query: "").map(\.id), ["b", "a"])
        XCTAssertEqual(model.rows(store: store, query: "").first?.title, "輪講 第3回")
        // An older version known here does not replace the page's.
        store.setCanvases("lab", [meta("a", channel: "lab", title: "古い題名", version: 0, updatedAt: stamp(1))])
        XCTAssertEqual(model.rows(store: store, query: "").last?.title, "週報")
    }

    func testTheFilterMatchesTitlesInAnyCaseAndWidth() async {
        let store = Store()
        join(store)
        let api = FakeCanvasesApi()
        api.pages[""] = CanvasPage(items: [meta("a", title: "ABC 計画"), meta("b", title: "ｶﾅ の議事録"), meta("c", title: "週報")], nextCursor: "p2")
        let model = CanvasesModel()
        await model.reload(api: api, store: store)
        XCTAssertEqual(model.rows(store: store, query: "abc").map(\.id), ["a"])
        XCTAssertEqual(model.rows(store: store, query: "ＡＢＣ").map(\.id), ["a"]) // full-width
        XCTAssertEqual(model.rows(store: store, query: " カナ ").map(\.id), ["b"]) // half-width kana, spaces around
        XCTAssertEqual(model.rows(store: store, query: "本文の語").map(\.id), [])
        XCTAssertEqual(model.rows(store: store, query: "  ").count, 3)

        // Submitting searches the bodies: the search's 「キャンバス」 tab with the words.
        XCTAssertEqual(CanvasesModel.bodySearch(" 研究計画 "), SearchParams(q: "研究計画"))
        XCTAssertNil(CanvasesModel.bodySearch("   "))
    }

    // MARK: offline

    func testAFailedFirstPageShowsTheKeptCanvasesMarkedOffline() async {
        let store = Store()
        join(store, "lab")
        join(store, "seminar")
        store.cacheCanvas(CanvasOut(id: "k1", channelId: "lab", title: "議事録", version: 2, headRevId: "r2", isChannelTab: false, editPolicy: "members",
                                    templateKey: nil, shareMessageId: nil, taskTotal: 0, taskDone: 0, createdBy: "u2", updatedBy: "u2",
                                    createdAt: "", updatedAt: stamp(5), body: "# 議事録"))
        store.cacheCanvas(CanvasOut(id: "k2", channelId: "seminar", title: "輪講", version: 1, headRevId: "r1", isChannelTab: false, editPolicy: "members",
                                    templateKey: nil, shareMessageId: nil, taskTotal: 0, taskDone: 0, createdBy: "u2", updatedBy: "u2",
                                    createdAt: "", updatedAt: stamp(1), body: "本文"))
        let api = FakeCanvasesApi()
        api.error = ApiError.network(URLError(.notConnectedToInternet))
        let model = CanvasesModel()
        let said = await model.reload(api: api, store: store)
        XCTAssertNil(said) // the mark says it
        XCTAssertTrue(model.offline)
        XCTAssertNil(model.cursor)
        XCTAssertEqual(model.rows(store: store, query: "").map(\.id), ["k2", "k1"])
        XCTAssertEqual(model.rows(store: store, query: "輪").map(\.id), ["k2"])
        // No more pages offline.
        _ = await model.loadMore(api: api)
        XCTAssertEqual(api.calls.count, 1)

        // A server trouble does the same; the connection back reads the list and the mark goes.
        api.error = ApiError.api(status: 503, code: "unavailable", message: "")
        await model.reload(api: api, store: store)
        XCTAssertTrue(model.offline)
        api.error = nil
        api.pages[""] = CanvasPage(items: [meta("cv1", updatedAt: stamp(0))], nextCursor: "p2")
        await model.reload(api: api, store: store)
        XCTAssertFalse(model.offline)
        XCTAssertEqual(model.items?.map(\.id), ["cv1"])
        XCTAssertEqual(model.cursor, "p2")

        // Without a client (signed out of the server for now): the kept ones too.
        let alone = CanvasesModel()
        await alone.reload(api: nil, store: store)
        XCTAssertTrue(alone.offline)
        XCTAssertEqual(alone.items?.count, 2)
    }

    func testARefreshThatFailsKeepsTheServersListAndSaysSo() async {
        let store = Store()
        join(store)
        store.cacheCanvas(CanvasOut(id: "kept", channelId: "lab", title: "議事録", version: 1, headRevId: "r1", isChannelTab: false, editPolicy: "members",
                                    templateKey: nil, shareMessageId: nil, taskTotal: 0, taskDone: 0, createdBy: "u2", updatedBy: "u2",
                                    createdAt: "", updatedAt: "", body: "x"))
        let api = FakeCanvasesApi()
        api.pages[""] = CanvasPage(items: [meta("cv1"), meta("cv2")], nextCursor: "p2")
        let model = CanvasesModel()
        await model.reload(api: api, store: store)
        api.error = ApiError.network(URLError(.timedOut))
        let said = await model.reload(api: api, store: store)
        XCTAssertNotNil(said)
        XCTAssertFalse(model.offline)
        XCTAssertEqual(model.items?.map(\.id), ["cv1", "cv2"])
        XCTAssertEqual(model.cursor, "p2")
    }

    func testARefusalIsSaidAndTheKeptCanvasesDoNotHideIt() async {
        let store = Store()
        join(store)
        store.cacheCanvas(CanvasOut(id: "kept", channelId: "lab", title: "議事録", version: 1, headRevId: "r1", isChannelTab: false, editPolicy: "members",
                                    templateKey: nil, shareMessageId: nil, taskTotal: 0, taskDone: 0, createdBy: "u2", updatedBy: "u2",
                                    createdAt: "", updatedAt: "", body: "x"))
        let api = FakeCanvasesApi()
        api.error = ApiError.api(status: 403, code: "forbidden", message: "")
        let model = CanvasesModel()
        await model.reload(api: api, store: store)
        XCTAssertFalse(model.offline)
        XCTAssertNotNil(model.failure)
        XCTAssertEqual(model.items, [])
    }

    // MARK: a row

    func testARowSaysTitleWhereWhoAndWhenToVoiceOver() {
        let store = Store()
        join(store, "lab")
        store.upsertUser(UserPublic(id: "u2", username: "yamada", displayName: "山田", role: "member", deactivatedAt: nil, createdAt: "", updatedAt: ""))
        let canvas = meta("a", title: "週報", updatedAt: "2026-10-02T05:30:00Z", isTab: true, tasks: (5, 2))
        let now = ISO8601DateFormatter().date(from: "2026-10-02T06:00:00Z")!
        let stamp = SearchResultRow.stamp(canvas.updatedAt, now: now)
        XCTAssertEqual(CanvasesModel.spoken(canvas, store: store, now: now), "週報、会話のタブ、#lab、山田 が更新、\(stamp)、タスク 5 件中 2 件完了")
        XCTAssertEqual(CanvasesModel.editor(meta("b", updatedBy: "stranger"), store: store), "メンバー")
        XCTAssertEqual(CanvasesModel.conversation(meta("b", channel: "unknown"), store: store), "会話")
        XCTAssertEqual(CanvasesModel.title(meta("b", title: "  ")), "無題のキャンバス")
        XCTAssertEqual(CanvasesModel.spoken(meta("b", title: "メモ"), store: store, now: now).hasSuffix("山田 が更新、\(SearchResultRow.stamp("2026-10-01T00:00:00Z", now: now))"), true)
    }

    // MARK: opening a row

    func testARowOpensTheCanvasTabOnTheHomeStackOrItsSheet() async {
        let controller = AppController()
        join(controller.store, "lab")
        join(controller.store, "public-not-joined", member: false)
        var landed: [String] = []
        let observer = NotificationCenter.default.addObserver(forName: .chikuwaOpenChannel, object: nil, queue: nil) { note in
            if let id = note.userInfo?["id"] as? String { landed.append(id) }
        }
        defer { NotificationCenter.default.removeObserver(observer) }

        // My conversation: the canvas chosen for its 「キャンバス」 tab; the list pushes the conversation on its own stack.
        let pushes = await controller.openListedCanvas(meta("a", channel: "lab"))
        XCTAssertTrue(pushes)
        XCTAssertEqual(controller.canvasOpen, CanvasOpen(canvasId: "a", channelId: "lab"))
        XCTAssertNil(controller.canvasLink)
        XCTAssertEqual(landed, []) // not landed on home / DM afresh: Back returns to the list

        // A conversation not on this device, or not mine: the canvas's own sheet (as a /c/ link).
        controller.canvasOpen = nil
        let elsewhere = await controller.openListedCanvas(meta("b", channel: "not-here"))
        XCTAssertFalse(elsewhere)
        XCTAssertNil(controller.canvasOpen)
        XCTAssertEqual(controller.canvasLink, CanvasLinkTarget(id: "b"))
        controller.canvasLink = nil
        let notMine = await controller.openListedCanvas(meta("c", channel: "public-not-joined"))
        XCTAssertFalse(notMine)
        XCTAssertEqual(controller.canvasLink, CanvasLinkTarget(id: "c"))
    }

    // MARK: the tile

    func testTheHomeHasACanvasTileAfterFiles() {
        let tiles = HomeTile.tiles(threads: ThreadSummary(unreadCount: 0, mentionCount: 0), drafts: 0, saved: 0, firedReminders: 0)
        let tile = tiles.last
        XCTAssertEqual(tile?.kind, .canvases)
        XCTAssertEqual(tiles[tiles.count - 2].kind, .files)
        XCTAssertEqual(tile?.title, "キャンバス")
        XCTAssertNil(tile?.count)
        XCTAssertEqual(tile?.dimmed, false)
        XCTAssertEqual(tile?.accessibilityValue, "")
        XCTAssertEqual(tile?.selectionId, CanvasesView.selectionId)
    }
}
