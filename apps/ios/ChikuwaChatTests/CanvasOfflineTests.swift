import XCTest
@testable import ChikuwaChat

/// M74 (CANVAS.md §19.1): canvases kept on the device to read offline, and erasing a version's body.

private let NOTES = "# 議事録\n## 決定事項\n来週までに研究計画を提出する。\n\n## TODO\n- [ ] 資料"

@MainActor
private func member(_ store: Store, _ id: String = "lab", role: String = "member") {
    let out = ChannelOut(id: id, type: "public", name: id, topic: nil, purpose: nil, archived: false, createdBy: nil, lastSeq: 0,
                         lastMessageAt: nil, createdAt: "", updatedAt: "", membership: MembershipOut(role: role, joinedAt: ""), dmUserIds: nil)
    _ = store.upsertChannel(out, isMember: true)
}

private func canvas(_ id: String, channel: String = "lab", version: Int = 1, head: String? = nil, title: String = "議事録",
                    body: String = NOTES, updatedAt: String = "2026-10-01T00:00:00Z") -> CanvasOut {
    CanvasOut(id: id, channelId: channel, title: title, version: version, headRevId: head ?? "\(id)-r\(version)", isChannelTab: false,
              editPolicy: "members", templateKey: nil, shareMessageId: nil, taskTotal: 1, taskDone: 0, createdBy: "alice", updatedBy: "alice",
              createdAt: "2026-10-01T00:00:00Z", updatedAt: updatedAt, body: body)
}

private func temporaryDatabase() throws -> (SQLitePersistence, String) {
    let path = FileManager.default.temporaryDirectory.appendingPathComponent("canvas-cache-\(UUID().uuidString).db").path
    return (try SQLitePersistence(db: SQLiteDatabase(path: path)), path)
}

@MainActor
final class CanvasCacheStoreTests: XCTestCase {
    func testAKeptCanvasSurvivesARestartAndAnOlderVersionDoesNotReplaceIt() throws {
        let (persistence, path) = try temporaryDatabase()
        defer { try? FileManager.default.removeItem(atPath: path) }
        let store = Store(persistence: persistence)
        member(store)
        let savedAt = Date(timeIntervalSince1970: 1_790_000_000)
        store.cacheCanvas(canvas("c1", version: 3), now: savedAt)
        store.cacheCanvas(canvas("c1", version: 2, body: "古い"), now: savedAt.addingTimeInterval(60))
        XCTAssertEqual(store.cachedCanvas("c1")?.canvas.body, NOTES)
        XCTAssertEqual(store.cachedCanvas("c1")?.canvas.version, 3)
        XCTAssertEqual(store.cachedCanvas("c1")?.savedAt, savedAt)
        // A 304 moves 「最後に読み込んだ時点」.
        store.touchCachedCanvas("c1", now: savedAt.addingTimeInterval(120))
        persistence.close()

        let reopened = Store(persistence: try SQLitePersistence(db: SQLiteDatabase(path: path)))
        reopened.load()
        let kept = try XCTUnwrap(reopened.cachedCanvas("c1"))
        XCTAssertEqual(kept.canvas.body, NOTES)
        XCTAssertEqual(kept.canvas.headRevId, "c1-r3")
        XCTAssertEqual(kept.canvas.title, "議事録")
        XCTAssertEqual(kept.savedAt.timeIntervalSince1970, savedAt.addingTimeInterval(120).timeIntervalSince1970, accuracy: 0.001)
        XCTAssertEqual(reopened.cachedCanvases(of: "lab").map(\.id), ["c1"])
    }

    func testOnlyConversationsIAmAMemberOfAreKept() throws {
        let (persistence, path) = try temporaryDatabase()
        defer { try? FileManager.default.removeItem(atPath: path) }
        let store = Store(persistence: persistence)
        member(store, "lab")
        member(store, "seminar")
        store.cacheCanvas(canvas("c1", channel: "lab"))
        store.cacheCanvas(canvas("c2", channel: "seminar"))
        store.cacheCanvas(canvas("c3", channel: "elsewhere")) // not a conversation of mine: never kept
        XCTAssertNil(store.cachedCanvas("c3"))
        // Leaving a conversation (Store.removeChannel) drops its canvases with their unsaved edits.
        store.setPendingCanvas("c1", CanvasPendingState(channelId: "lab", baseRevId: "c1-r1", synced: NOTES, text: NOTES + "x", version: 1, inFlight: nil))
        store.removeChannel("lab")
        XCTAssertNil(store.cachedCanvas("c1"))
        XCTAssertNil(store.pendingCanvas("c1"))
        XCTAssertEqual(store.cachedCanvasIds, ["c2"])
        // A conversation left while the app was closed: its canvases go at the next start.
        store.updateChannel("seminar") { $0.isMember = false }
        persistence.close()
        let reopened = Store(persistence: try SQLitePersistence(db: SQLiteDatabase(path: path)))
        reopened.load()
        XCTAssertTrue(reopened.cachedCanvasIds.isEmpty)
    }

    func testTheOldestPastTheCapGo() {
        let store = Store()
        member(store)
        let start = Date(timeIntervalSince1970: 1_790_000_000)
        for index in 0..<(cachedCanvasLimit + 3) {
            store.cacheCanvas(canvas(String(format: "c%03d", index)), now: start.addingTimeInterval(Double(index)))
        }
        XCTAssertEqual(store.cachedCanvasIds.count, cachedCanvasLimit)
        XCTAssertNil(store.cachedCanvas("c000"))
        XCTAssertNil(store.cachedCanvas("c002"))
        XCTAssertNotNil(store.cachedCanvas("c003"))
        // Reading one again makes it recent: the next one past the cap is another.
        store.cacheCanvas(canvas("c003", version: 2), now: start.addingTimeInterval(1000))
        store.cacheCanvas(canvas("new"), now: start.addingTimeInterval(1001))
        XCTAssertNotNil(store.cachedCanvas("c003"))
        XCTAssertNil(store.cachedCanvas("c004"))
    }

    func testSignOutTakesTheKeptCanvasesWithTheDatabase() throws {
        let profile = "https://offline.example.jp|m74-\(UUID().uuidString)"
        let persistence = try SQLitePersistence.open(profile: profile)
        let store = Store(persistence: persistence)
        member(store)
        store.cacheCanvas(canvas("c1"))
        XCTAssertNotNil(store.cachedCanvas("c1"))
        // AppController.forget: the store closes, the account's database files go (SYNC_PROTOCOL.md §11).
        store.close()
        SQLitePersistence.destroy(profile: profile)
        let again = try SQLitePersistence.open(profile: profile)
        defer {
            again.close()
            SQLitePersistence.destroy(profile: profile)
        }
        let fresh = Store(persistence: again)
        fresh.load()
        XCTAssertTrue(fresh.cachedCanvasIds.isEmpty)
        XCTAssertTrue(try again.loadCachedCanvasIndex().isEmpty)
    }
}

@MainActor
final class CanvasOfflineSaverTests: XCTestCase {
    private var cleanups: [() -> Void] = []

    override func tearDown() async throws {
        for cleanup in cleanups { cleanup() }
        cleanups = []
    }

    private func options() -> CanvasSaverOptions {
        var options = CanvasSaverOptions()
        options.retryDelays = [1]
        return options
    }

    /// A hub over a store that keeps bob's copy of alice's canvas (read at `savedAt`).
    private func harness(cachedVersion: Bool = true) -> (FakeCanvasServer, FakeCanvasApi, ManualCanvasClock, Store, CanvasHub, CanvasOut) {
        let server = FakeCanvasServer()
        let made = server.create(by: "alice", channelId: "lab", body: NOTES)
        let api = FakeCanvasApi(server: server, userId: "bob")
        let clock = ManualCanvasClock()
        let store = Store()
        member(store)
        if cachedVersion { store.cacheCanvas(made, now: Date(timeIntervalSince1970: 1_790_000_000)) }
        let hub = CanvasHub(api: api, store: store, clock: clock, options: options())
        cleanups.append {
            hub.stop()
            clock.drain()
        }
        return (server, api, clock, store, hub, made)
    }

    func testOfflineTheKeptCopyShowsWithItsTimeAndEditsSaveOnItsHeadOnceOnline() async throws {
        let (server, api, clock, store, hub, made) = harness()
        api.getFail = [ApiError.network(URLError(.notConnectedToInternet))]
        let saver = try XCTUnwrap(hub.hold(made.id, channelId: "lab"))
        // At once, before the server answers: the kept copy.
        XCTAssertEqual(saver.text, NOTES)
        XCTAssertEqual(saver.status, .saved)
        XCTAssertEqual(saver.cachedAt, Date(timeIntervalSince1970: 1_790_000_000))
        await saver.settled()
        XCTAssertEqual(api.gets, [made.version]) // If-None-Match with the kept version
        XCTAssertTrue(saver.offlineCopy)
        XCTAssertFalse(saver.loadFailed)

        // Typed offline: the save loop goes on as before (pending, same key), written on the kept head.
        api.fail = [.down]
        saver.edit(NOTES + "\n- [ ] 予稿")
        await saver.flush()
        XCTAssertEqual(saver.status, .offline)
        XCTAssertEqual(api.calls.first?.baseRevId, made.headRevId)
        XCTAssertEqual(store.pendingCanvas(made.id)?.inFlight?.sent, NOTES + "\n- [ ] 予稿")
        // Meanwhile alice changed another part: online, the server merges both.
        try server.saveOnHead("alice", made.id, "# 議事録 (第 3 回)" + NOTES.dropFirst("# 議事録".count))
        hub.online()
        await saver.settled()
        await clock.advance(0)
        await saver.settled()
        XCTAssertEqual(api.calls.count, 2)
        XCTAssertEqual(api.calls[1].clientSaveId, api.calls[0].clientSaveId) // same key
        XCTAssertEqual(saver.status, .saved)
        XCTAssertFalse(saver.offlineCopy)
        XCTAssertNil(saver.cachedAt)
        XCTAssertTrue(saver.text.hasPrefix("# 議事録 (第 3 回)"))
        XCTAssertTrue(saver.text.hasSuffix("- [ ] 予稿"))
        // The kept copy is now the server's merged head.
        XCTAssertEqual(store.cachedCanvas(made.id)?.canvas.headRevId, server.head(made.id).headRevId)
        XCTAssertEqual(store.cachedCanvas(made.id)?.canvas.body, saver.text)
    }

    func testOnlineAnUnchangedCopyIsConfirmedAndANewerOneReplacesIt() async throws {
        let (server, api, _, store, hub, made) = harness()
        let saver = try XCTUnwrap(hub.hold(made.id, channelId: "lab"))
        await saver.settled()
        XCTAssertEqual(api.gets, [made.version])
        XCTAssertNil(saver.cachedAt) // 304: the copy is the current one
        XCTAssertFalse(saver.offlineCopy)
        XCTAssertGreaterThan(try XCTUnwrap(store.cachedCanvas(made.id)).savedAt, Date(timeIntervalSince1970: 1_790_000_000)) // touched now
        hub.release(made.id)
        await saver.settled()

        // Changed since: shown first, then the new version.
        let other = harness()
        try other.0.saveOnHead("alice", other.5.id, NOTES + "\n追記")
        let second = try XCTUnwrap(other.4.hold(other.5.id, channelId: "lab"))
        XCTAssertEqual(second.text, NOTES)
        await second.settled()
        XCTAssertEqual(second.text, NOTES + "\n追記")
        XCTAssertEqual(other.3.cachedCanvas(other.5.id)?.canvas.body, NOTES + "\n追記")
        _ = server
    }

    func testWithoutAKeptCopyTheFirstReadIsAsBeforeAndItsAnswerIsKept() async throws {
        let (_, api, _, store, hub, made) = harness(cachedVersion: false)
        api.getFail = [ApiError.network(URLError(.notConnectedToInternet))]
        let saver = try XCTUnwrap(hub.hold(made.id, channelId: "lab"))
        await saver.settled()
        XCTAssertTrue(saver.loadFailed) // 再読み込み, as before M74
        XCTAssertNil(saver.cachedAt)
        await saver.reload()
        XCTAssertEqual(saver.text, NOTES)
        XCTAssertEqual(store.cachedCanvas(made.id)?.canvas.body, NOTES)
    }

    func testTheTrashAndA404DropTheKeptCopy() async throws {
        let (server, _, _, store, hub, made) = harness()
        hub.applyEvent("canvas.deleted", .object(["canvas_id": .string(made.id), "channel_id": .string("lab")]))
        XCTAssertNil(store.cachedCanvas(made.id))

        let other = harness()
        other.0.canvases[other.5.id]?.deleted = true
        let saver = try XCTUnwrap(other.4.hold(other.5.id, channelId: "lab"))
        await saver.settled()
        XCTAssertEqual(saver.status, .gone)
        XCTAssertNil(other.3.cachedCanvas(other.5.id))
        _ = server
    }

    func testTheTabListFallsBackToTheKeptCanvasesWhenItCannotBeLoaded() async {
        let (_, api, _, store, hub, made) = harness()
        api.listFail = [ApiError.network(URLError(.notConnectedToInternet))]
        await hub.loadList("lab")
        XCTAssertEqual(store.canvasesOf("lab")?.map(\.id), [made.id])
        XCTAssertNil(store.canvasListFailure("lab"))
        // A refusal is an answer: no stand-in.
        let other = harness()
        other.1.listFail = [ApiError.api(status: 404, code: "not_found", message: "")]
        await other.4.loadList("lab")
        XCTAssertNil(other.3.canvasesOf("lab"))
        XCTAssertEqual(other.3.canvasListFailure("lab"), .unsupported)
        // Nothing kept: the failure shows as before.
        let bare = harness(cachedVersion: false)
        bare.1.listFail = [ApiError.network(URLError(.notConnectedToInternet))]
        await bare.4.loadList("lab")
        XCTAssertEqual(bare.3.canvasListFailure("lab"), .failed)
    }

    func testOpeningByIdUsesTheKeptCopyOnlyForAConversationOfMine() {
        let store = Store()
        member(store)
        XCTAssertNil(CanvasOffline.openFromCache("c1", store: store))
        store.cacheCanvas(canvas("c1"))
        XCTAssertEqual(CanvasOffline.openFromCache("c1", store: store), "lab")
        store.updateChannel("lab") { $0.isMember = false }
        XCTAssertNil(CanvasOffline.openFromCache("c1", store: store))
    }

    func testTheNoticeSaysWhenTheCopyWasRead() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Asia/Tokyo")!
        let date = ISO8601DateFormatter().date(from: "2026-10-02T05:30:00Z")!
        XCTAssertEqual(CanvasOffline.notice(savedAt: date, calendar: calendar), "オフライン — 最後に読み込んだ時点（2026年10月2日 (金) 14:30）の内容です")
    }
}

// MARK: - erasing a version's body (§4.7 / §4.9)

@MainActor
final class CanvasEraseTests: XCTestCase {
    private func channel(type: String = "public", role: String? = "member", archived: Bool = false) -> ChannelState {
        let out = ChannelOut(id: "c", type: type, name: "lab", topic: nil, purpose: nil, archived: archived, createdBy: nil, lastSeq: 0,
                             lastMessageAt: nil, createdAt: "", updatedAt: "", membership: role.map { MembershipOut(role: $0, joinedAt: "") },
                             dmUserIds: type == "dm" ? ["me", "alice"] : nil)
        return ChannelState(channel: out, isMember: true, syncedSeq: nil, lastSeq: 0, hasOlder: false)
    }

    private let me = CanvasRights.Actor(id: "me", isAdmin: false, isGuest: false)
    private let admin = CanvasRights.Actor(id: "me", isAdmin: true, isGuest: false)

    func testOwnersAndAdministratorsEraseAndInADmItsCreator() {
        let alices = (createdBy: "alice", editPolicy: "members")
        let mine = (createdBy: "me", editPolicy: "members")
        XCTAssertFalse(CanvasRights.of(channel(), actor: me, canvas: alices).erase)
        XCTAssertFalse(CanvasRights.of(channel(), actor: me, canvas: mine).erase) // the creator manages, but does not erase
        XCTAssertTrue(CanvasRights.of(channel(role: "owner"), actor: me, canvas: alices).erase)
        XCTAssertTrue(CanvasRights.of(channel(), actor: admin, canvas: alices).erase)
        XCTAssertFalse(CanvasRights.of(channel(role: "owner", archived: true), actor: admin, canvas: alices).erase)
        XCTAssertTrue(CanvasRights.of(channel(type: "dm", role: nil), actor: me, canvas: mine).erase)
        XCTAssertFalse(CanvasRights.of(channel(type: "dm", role: nil), actor: me, canvas: alices).erase)
        XCTAssertFalse(CanvasRights.of(channel(type: "dm", role: nil), actor: admin, canvas: alices).erase)
    }

    private func revision(_ id: String, kind: String = "save") -> CanvasRevisionMeta {
        CanvasRevisionMeta(id: id, canvasId: "c1", version: 1, kind: kind, parentRevId: nil, authorId: "alice", title: "議事録", label: nil,
                           linesAdded: 1, linesRemoved: 0, createdAt: "2026-10-01T00:00:00Z")
    }

    func testNeverOnTheCurrentVersionNorOneAlreadyErased() {
        let rights = CanvasRights(erase: true)
        XCTAssertTrue(CanvasHistoryModel.offersErase(revision("r1"), headId: "r2", rights: rights))
        XCTAssertFalse(CanvasHistoryModel.offersErase(revision("r2"), headId: "r2", rights: rights))
        XCTAssertFalse(CanvasHistoryModel.offersErase(revision("r1", kind: "erased"), headId: "r2", rights: rights))
        XCTAssertFalse(CanvasHistoryModel.offersErase(revision("r1"), headId: "r2", rights: CanvasRights(edit: true, manage: true)))
    }

    func testAnErasedVersionReplacesItsRowAndItsBodyIsNotKept() {
        let model = CanvasHistoryModel(canvasId: "c1", rows: [revision("r2"), revision("r1")], bodies: ["r1": "秘密", "r2": "今"])
        model.erased(revision("r1", kind: "erased"))
        XCTAssertEqual(model.rows?.map(\.kind), ["save", "erased"])
        XCTAssertNil(model.bodies["r1"])
        XCTAssertEqual(model.bodies["r2"], "今")
    }

    func testTheRequestIsADeleteOnTheVersion() async throws {
        var seen: (method: String?, path: String?) = (nil, nil)
        StubProtocol.handler = { request in
            seen = (request.httpMethod, request.url?.path)
            return (200, Data(#"{"id":"r1","canvas_id":"c1","version":2,"kind":"erased","parent_rev_id":null,"author_id":"alice","title":"議事録","label":null,"lines_added":0,"lines_removed":0,"created_at":"2026-10-01T00:00:00Z"}"#.utf8))
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        let client = ApiClient(baseUrl: URL(string: "http://server")!, session: URLSession(configuration: configuration))
        client.accessToken = "a"
        let erased = try await client.eraseCanvasRevision(id: "c1", revisionId: "r1")
        XCTAssertEqual(seen.method, "DELETE")
        XCTAssertEqual(seen.path, "/api/v1/canvases/c1/revisions/r1")
        XCTAssertEqual(erased.kind, "erased")
        // The current version: 409 canvas_revision_is_head, shown with the shared error words.
        StubProtocol.handler = { _ in (409, Data(#"{"error":{"code":"canvas_revision_is_head","message":"m","details":{}}}"#.utf8)) }
        do {
            _ = try await client.eraseCanvasRevision(id: "c1", revisionId: "r2")
            XCTFail("expected 409")
        } catch let error as ApiError {
            XCTAssertEqual(error.code, "canvas_revision_is_head")
            XCTAssertEqual(ErrorMessages.byCode[error.code], "現在の版は消去できません。先に本文を直してください")
        }
    }
}
