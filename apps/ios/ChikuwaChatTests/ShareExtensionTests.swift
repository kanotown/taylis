import XCTest
@testable import ChikuwaChat

/// MOBILE_UI.md §21: the code the app shares with its Share Extension (destinations, the pending-share queue, the
/// idempotent post, the shared tokens and the Keychain migration).
final class ShareDestinationTests: XCTestCase {
    private func channel(_ id: String, _ type: String, name: String? = nil, archived: Bool = false, last: String? = nil, dm: [String]? = nil,
                         policy: String? = nil, role: String? = "member") -> ShareApi.Channel {
        ShareApi.Channel(id: id, type: type, name: name, archived: archived, lastMessageAt: last, dmUserIds: dm, postingPolicy: policy,
                         membership: role.map { ShareApi.Channel.Membership(role: $0) })
    }

    private let users = [
        ShareApi.User(id: "me", username: "kano", displayName: "加納", role: "member"),
        ShareApi.User(id: "u2", username: "ebi", displayName: "海老", role: "member"),
        ShareApi.User(id: "u3", username: "alice", displayName: "Alice", role: "member"),
    ]

    func testBuildKeepsPostableConversationsNewestFirstWithDmNames() {
        let list = ShareDestinations.build(channels: [
            channel("c1", "public", name: "general", last: "2026-10-01T00:00:00Z"),
            channel("c2", "private", name: "lab", last: "2026-10-05T00:00:00Z"),
            channel("c3", "public", name: "old", archived: true, last: "2026-10-09T00:00:00Z"),
            channel("c4", "public", name: "news", last: "2026-10-08T00:00:00Z", policy: "owners"),
            channel("c5", "public", name: "mine", last: "2026-10-07T00:00:00Z", policy: "owners", role: "owner"),
            channel("d1", "dm", last: "2026-10-06T00:00:00Z", dm: ["me", "u2"]),
            channel("d2", "group_dm", last: nil, dm: ["me", "u2", "u3"]),
            channel("d3", "dm", last: "2026-09-01T00:00:00Z", dm: ["me"]),
        ], users: users, meId: "me", isAdmin: false)
        XCTAssertEqual(list.map(\.id), ["c5", "d1", "c2", "c1", "d3", "d2"])
        XCTAssertEqual(list.first { $0.id == "d1" }?.title, "海老")
        XCTAssertEqual(list.first { $0.id == "d2" }?.title, "海老, Alice")
        XCTAssertEqual(list.first { $0.id == "d3" }?.title, "加納") // notes to self
        XCTAssertEqual(list.first { $0.id == "c2" }?.title, "#lab")
        XCTAssertEqual(list.first { $0.id == "d2" }?.keywords, "ebi alice")
        // An admin may post in an announcement channel.
        let admin = ShareDestinations.build(channels: [channel("c4", "public", name: "news", policy: "owners")], users: users, meId: "me", isAdmin: true)
        XCTAssertEqual(admin.map(\.id), ["c4"])
    }

    func testSearchMatchesEveryWordIgnoringCaseAndWidthAndPutsPrefixMatchesFirst() {
        let list = [
            ShareDestination(id: "1", title: "#lab-general", kind: "public"),
            ShareDestination(id: "2", title: "#general", kind: "public"),
            ShareDestination(id: "3", title: "海老", kind: "dm", keywords: "ebi"),
            ShareDestination(id: "4", title: "#ゼミ2026", kind: "private"),
        ]
        XCTAssertEqual(ShareDestinations.search("GEN", in: list).map(\.id), ["2", "1"])
        XCTAssertEqual(ShareDestinations.search("ｇｅｎｅｒａｌ lab", in: list).map(\.id), ["1"])
        XCTAssertEqual(ShareDestinations.search("ebi", in: list).map(\.id), ["3"])
        XCTAssertEqual(ShareDestinations.search("ゼミ２０２６", in: list).map(\.id), ["4"])
        XCTAssertEqual(ShareDestinations.search("  ", in: list).map(\.id), ["1", "2", "3", "4"])
        XCTAssertEqual(ShareDestinations.search("nothing", in: list), [])
    }

    func testRecentCacheRoundTripsPerAccountAndIsCleared() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "share-tests-\(UUID().uuidString)"))
        let a = [ShareDestination(id: "1", title: "#a", kind: "public", lastMessageAt: "2026-10-01T00:00:00Z")]
        ShareDestinations.saveRecent(a, account: "s|kano", to: defaults)
        ShareDestinations.saveRecent([], account: "t|ebi", to: defaults)
        XCTAssertEqual(ShareDestinations.recent(account: "s|kano", defaults), a)
        XCTAssertEqual(ShareDestinations.recent(account: "t|ebi", defaults), [])
        SharedContainer.forget(account: "s|kano", defaults)
        XCTAssertEqual(ShareDestinations.recent(account: "s|kano", defaults), [])
    }

    func testWorkspaceMirrorPutsTheActiveOneFirst() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "share-tests-\(UUID().uuidString)"))
        let list = [Workspace(serverUrl: "https://a", username: "kano"), Workspace(serverUrl: "https://b", username: "ebi", signedOut: true)]
        SharedContainer.saveWorkspaces(list, active: "https://b", to: defaults)
        XCTAssertEqual(SharedContainer.workspaces(defaults).map(\.serverUrl), ["https://b", "https://a"])
        XCTAssertEqual(SharedContainer.workspaces(defaults).first?.isSignedIn, false)
    }

    @MainActor
    func testModelShowsRecentThenSearchesEveryConversationOnceLoaded() async {
        var fetches = 0
        let recent = [ShareDestination(id: "1", title: "#general", kind: "public"), ShareDestination(id: "gone", title: "#left", kind: "public")]
        let model = ShareDestinationModel(account: "s|kano", recent: recent) {
            fetches += 1
            return [ShareDestination(id: "1", title: "#general", kind: "public"), ShareDestination(id: "2", title: "#gen-lab", kind: "private")]
        }
        XCTAssertEqual(model.results.map(\.id), ["1", "gone"])
        model.query = "gen"
        XCTAssertEqual(model.results.map(\.id), ["1"]) // the recent ones until everything is loaded
        await model.loadAll()
        await model.loadAll()
        XCTAssertEqual(fetches, 1)
        XCTAssertEqual(model.results.map(\.id), ["1", "2"])
        model.query = ""
        XCTAssertEqual(model.results.map(\.id), ["1"]) // a conversation left since the app wrote the cache goes
    }

    @MainActor
    func testModelWithoutCacheListsEverythingAndReportsAFailure() async {
        let empty = ShareDestinationModel(account: "s|kano", recent: []) { [ShareDestination(id: "9", title: "#x", kind: "public")] }
        await empty.loadAll()
        XCTAssertEqual(empty.results.map(\.id), ["9"])
        let failing = ShareDestinationModel(account: "s|kano", recent: []) { throw ShareFailure.notSignedIn }
        await failing.loadAll()
        XCTAssertEqual(failing.failure, .notSignedIn)
        XCTAssertNil(failing.all)
    }
}

final class PendingShareStoreTests: XCTestCase {
    private var root: URL!

    override func setUp() {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("pending-\(UUID().uuidString)", isDirectory: true)
    }

    override func tearDown() { try? FileManager.default.removeItem(at: root) }

    static func share(_ id: String, created: Date = Date(), items: Int = 1) -> PendingShare {
        PendingShare(id: id, clientMsgId: "cm-\(id)", serverUrl: "http://share.test", account: "acc", channelId: "c1", channelTitle: "#general",
                     parentId: nil, text: "hello", createdAt: created,
                     items: (0..<items).map { PendingShare.Item(file: "\($0)-f.pdf", filename: "f\($0).pdf", contentType: "application/pdf",
                                                                size: 3, boundary: "b\($0)") })
    }

    func testSavesLoadsAndListsOldestFirst() throws {
        let store = PendingShareStore(root: root)
        try store.save(Self.share("b", created: Date(timeIntervalSince1970: 200)))
        try store.save(Self.share("a", created: Date(timeIntervalSince1970: 100)))
        _ = try store.makeFolder("staging") // no share.json: not a share
        XCTAssertEqual(store.all().map(\.id), ["a", "b"])
        XCTAssertEqual(store.load("a"), Self.share("a", created: Date(timeIntervalSince1970: 100)))
        store.remove("a")
        XCTAssertNil(store.load("a"))
    }

    func testClaimIsExclusiveUntilReleased() throws {
        let store = PendingShareStore(root: root)
        try store.save(Self.share("x"))
        let first = try XCTUnwrap(store.claim("x"))
        XCTAssertNil(store.claim("x"))
        first.release()
        XCTAssertNotNil(store.claim("x"))
    }

    func testSweepDropsExpiredSharesAndAbandonedFoldersButNotClaimedOnes() throws {
        let store = PendingShareStore(root: root)
        let now = Date()
        try store.save(Self.share("old", created: now.addingTimeInterval(-8 * 24 * 3600)))
        try store.save(Self.share("busy", created: now.addingTimeInterval(-8 * 24 * 3600)))
        try store.save(Self.share("new", created: now.addingTimeInterval(-6 * 24 * 3600)))
        _ = try store.makeFolder("abandoned")
        let open = store.claim("staging") // a share sheet still open
        _ = try store.makeFolder("staging")
        let lock = store.claim("busy")
        let expired = store.sweep(now: now)
        XCTAssertEqual(expired.map(\.id), ["old"])
        XCTAssertEqual(Set(store.all().map(\.id)), ["busy", "new"])
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.folder("abandoned").path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: store.folder("staging").path))
        lock?.release()
        open?.release()
    }
}

/// Uploads answered at once by the test.
final class FakeShareTransport: ShareUploadTransport, @unchecked Sendable {
    var onFinished: ((ShareUploadResult) -> Void)?
    var onProgress: ((String, Int, Int64) -> Void)?
    var answer: (Int, URLRequest) -> (Int, String) = { index, _ in (201, #"{"id":"att-\#(index)"}"#) }
    private(set) var started: [(index: Int, request: URLRequest, body: Data)] = []
    var stillRunning: Set<Int> = []
    private(set) var detached: [String] = []
    private let lock = NSLock()

    func running(shareId: String) async -> Set<Int> { stillRunning }

    func start(shareId: String, index: Int, request: URLRequest, body: URL) {
        let data = (try? Data(contentsOf: body)) ?? Data()
        lock.lock()
        started.append((index, request, data))
        lock.unlock()
        let (status, text) = answer(index, request)
        DispatchQueue.global().async {
            self.onFinished?(ShareUploadResult(shareId: shareId, index: index, status: max(status, 0), data: Data(text.utf8), failedToConnect: status < 0))
        }
    }

    func detach(shareId: String) {
        lock.lock()
        detached.append(shareId)
        lock.unlock()
    }
}

final class ShareProcessorTests: XCTestCase {
    private var root: URL!
    private var account: String!
    private var posts: [[String: Any]] = []
    private var refreshes = 0

    override func setUp() {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("pending-\(UUID().uuidString)", isDirectory: true)
        account = "http://share.test|tester-\(UUID().uuidString)"
        posts = []
        refreshes = 0
        SharedTokens.store(account: account, accessToken: "access-1", expiresIn: 900, refreshToken: "refresh-1")
    }

    override func tearDown() {
        StubProtocol.handler = nil
        Keychain.delete(account: account)
        try? FileManager.default.removeItem(at: root)
    }

    private func processor(_ transport: FakeShareTransport) -> ShareProcessor {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        let session = URLSession(configuration: configuration)
        let account = account!
        return ShareProcessor(store: PendingShareStore(root: root), transport: transport) { share in
            let api = ShareApi(baseUrl: URL(string: share.serverUrl)!, account: account, language: "ja", session: session)
            api.lockProvider = { nil }
            api.refreshRetryDelays = []
            return api
        }
    }

    /// A share with `count` files on disk.
    private func saveShare(_ id: String, count: Int = 2) throws -> PendingShare {
        let store = PendingShareStore(root: root)
        _ = try store.makeFolder(id)
        var share = PendingShareStoreTests.share(id, items: count)
        share.account = account
        for index in 0..<count { try Data("pdf\(index)".utf8).write(to: store.fileURL(share, index)) }
        try store.save(share)
        return share
    }

    /// The server: POST /messages answers `postStatus` (the same client_msg_id twice answers 200), refresh rotates.
    private func serve(postStatus: @escaping () -> (Int, String) = { (201, #"{"id":"m1"}"#) }) {
        StubProtocol.handler = { [self] request in
            if request.url!.path == "/api/v1/auth/refresh" {
                refreshes += 1
                return (200, Data(#"{"access_token":"access-2","refresh_token":"refresh-2","expires_in":900}"#.utf8))
            }
            if request.url!.path.hasSuffix("/messages") {
                let body = request.httpBodyStream.map { stream -> Data in
                    stream.open()
                    defer { stream.close() }
                    var data = Data()
                    var buffer = [UInt8](repeating: 0, count: 4096)
                    while stream.hasBytesAvailable { let n = stream.read(&buffer, maxLength: 4096); if n <= 0 { break }; data.append(buffer, count: n) }
                    return data
                } ?? request.httpBody ?? Data()
                let fields = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any] ?? [:]
                posts.append(fields)
                let (status, text) = postStatus()
                return (status, Data(text.utf8))
            }
            return (404, Data())
        }
    }

    func testUploadsEveryFileThenPostsOneMessageWithTheIdempotencyKey() async throws {
        serve()
        let transport = FakeShareTransport()
        let share = try saveShare("s1")
        let outcome = await processor(transport).send("s1")
        XCTAssertEqual(outcome, .posted)
        XCTAssertEqual(transport.started.map(\.index).sorted(), [0, 1])
        let first = try XCTUnwrap(transport.started.first { $0.index == 0 })
        XCTAssertEqual(first.request.value(forHTTPHeaderField: "Authorization"), "Bearer access-1")
        XCTAssertEqual(first.request.value(forHTTPHeaderField: "Content-Type"), "multipart/form-data; boundary=b0")
        XCTAssertEqual(first.request.url?.path, "/api/v1/attachments")
        let body = String(decoding: first.body, as: UTF8.self)
        XCTAssertTrue(body.hasPrefix("--b0\r\nContent-Disposition: form-data; name=\"file\"; filename=\"f0.pdf\""))
        XCTAssertTrue(body.contains("pdf0\r\n--b0--"))
        XCTAssertEqual(posts.count, 1)
        XCTAssertEqual(posts.first?["client_msg_id"] as? String, share.clientMsgId)
        XCTAssertEqual(posts.first?["attachment_ids"] as? [String], ["att-0", "att-1"])
        XCTAssertEqual(posts.first?["body"] as? String, "hello")
        XCTAssertNil(PendingShareStore(root: root).load("s1"), "a posted share is gone")
    }

    func testAPostWithoutAnswerStaysPendingAndTheRetryPostsWithTheSameKeyWithoutUploadingAgain() async throws {
        var answers: [(Int, String)] = [(-1, ""), (200, #"{"id":"m1"}"#)]
        serve { answers.removeFirst() }
        let transport = FakeShareTransport()
        let share = try saveShare("s2")
        let processor = processor(transport)
        let first = await processor.send("s2")
        XCTAssertEqual(first, .pending(.temporary("network_error")))
        let kept = try XCTUnwrap(PendingShareStore(root: root).load("s2"))
        XCTAssertEqual(kept.items.map(\.attachmentId), ["att-0", "att-1"])
        let second = await processor.send("s2")
        XCTAssertEqual(second, .posted)
        XCTAssertEqual(transport.started.count, 2, "uploaded once")
        XCTAssertEqual(posts.map { $0["client_msg_id"] as? String }, [share.clientMsgId, share.clientMsgId])
    }

    func testAnUploadTheServerRefusesFailsTheShare() async throws {
        serve()
        let transport = FakeShareTransport()
        transport.answer = { index, _ in
            index == 1 ? (413, #"{"error":{"code":"attachment_too_large","message":"x","details":{}}}"#) : (201, #"{"id":"att-0"}"#)
        }
        _ = try saveShare("s3")
        var reported: [ShareOutcome] = []
        let processor = processor(transport)
        await processor.setOutcomeHandler { _, outcome in reported.append(outcome) }
        let outcome = await processor.send("s3")
        XCTAssertEqual(outcome, .failed(.refused(status: 400, code: "attachment_too_large")))
        XCTAssertEqual(reported, [outcome])
        XCTAssertTrue(posts.isEmpty)
        XCTAssertNil(PendingShareStore(root: root).load("s3"))
    }

    func testAnUploadAfterTheNetworkDroppedStaysPendingWithItsFiles() async throws {
        serve()
        let transport = FakeShareTransport()
        transport.answer = { _, _ in (-1, "") }
        _ = try saveShare("s4", count: 1)
        let outcome = await processor(transport).send("s4")
        XCTAssertEqual(outcome, .pending(.temporary("network")))
        let kept = try XCTUnwrap(PendingShareStore(root: root).load("s4"))
        XCTAssertNil(kept.items[0].attachmentId)
        XCTAssertTrue(FileManager.default.fileExists(atPath: PendingShareStore(root: root).fileURL(kept, 0).path))
    }

    func testAnExpiredTokenOnUploadRefreshesOnceAndUploadsAgain() async throws {
        serve()
        let transport = FakeShareTransport()
        transport.answer = { index, request in
            request.value(forHTTPHeaderField: "Authorization") == "Bearer access-1"
                ? (401, #"{"error":{"code":"token_expired","message":"x","details":{}}}"#) : (201, #"{"id":"att-\#(index)"}"#)
        }
        _ = try saveShare("s5", count: 1)
        let outcome = await processor(transport).send("s5")
        XCTAssertEqual(outcome, .posted)
        XCTAssertEqual(refreshes, 1)
        XCTAssertEqual(transport.started.map { $0.request.value(forHTTPHeaderField: "Authorization") }, ["Bearer access-1", "Bearer access-2"])
        XCTAssertEqual(SharedTokens.refreshToken(account: account), "refresh-2", "the rotated token is stored for the app")
    }

    func testExpiredUploadsAreUploadedOnceMoreWhenThePostSaysAttachmentInvalid() async throws {
        var answers: [(Int, String)] = [(400, #"{"error":{"code":"attachment_invalid","message":"x","details":{}}}"#), (201, #"{"id":"m1"}"#)]
        serve { answers.removeFirst() }
        let transport = FakeShareTransport()
        _ = try saveShare("s6", count: 1)
        let outcome = await processor(transport).send("s6")
        XCTAssertEqual(outcome, .posted)
        XCTAssertEqual(transport.started.count, 2)
        XCTAssertEqual(posts.count, 2)
    }

    func testAShareAnotherProcessSendsIsLeftAlone() async throws {
        _ = try saveShare("s7")
        let held = PendingShareStore(root: root).claim("s7")
        let outcome = await processor(FakeShareTransport()).send("s7")
        XCTAssertEqual(outcome, .busy)
        held?.release()
    }

    func testUploadsStillRunningFromAnEarlierProcessAreNotStartedAgain() async throws {
        serve()
        let transport = FakeShareTransport()
        transport.stillRunning = [0]
        _ = try saveShare("s8")
        let processor = processor(transport)
        let task = Task { await processor.send("s8") }
        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertEqual(transport.started.map(\.index), [1])
        // The earlier upload ends now (its event reaches this process).
        transport.onFinished?(ShareUploadResult(shareId: "s8", index: 0, status: 201, data: Data(#"{"id":"att-early"}"#.utf8), failedToConnect: false))
        let outcome = await task.value
        XCTAssertEqual(outcome, .posted)
        XCTAssertEqual(posts.first?["attachment_ids"] as? [String], ["att-early", "att-1"])
    }

    func testDetachLetsTheShareGoForTheApp() async throws {
        _ = try saveShare("s9")
        let transport = FakeShareTransport()
        transport.stillRunning = [0, 1] // nothing ends while the sheet is open
        let processor = processor(transport)
        let task = Task { await processor.send("s9") }
        try await Task.sleep(nanoseconds: 300_000_000)
        await processor.detach("s9")
        let outcome = await task.value
        XCTAssertEqual(outcome, .pending(.temporary("background")))
        XCTAssertNotNil(PendingShareStore(root: root).claim("s9"), "the app can claim it now")
        XCTAssertTrue(transport.detached.contains("s9"))
    }
}

final class SharedTokenTests: XCTestCase {
    private var account: String!

    override func setUp() { account = "http://share.test|tokens-\(UUID().uuidString)" }

    override func tearDown() {
        StubProtocol.handler = nil
        Keychain.delete(account: account)
    }

    private func api() -> ShareApi {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        let api = ShareApi(baseUrl: URL(string: "http://share.test")!, account: account, language: "ja", session: URLSession(configuration: configuration))
        api.lockProvider = { nil }
        api.refreshRetryDelays = []
        return api
    }

    func testStoredTokensRoundTripAndDeleteTakesBoth() {
        let now = Date()
        SharedTokens.store(account: account, accessToken: "a", expiresIn: 900, refreshToken: "r", now: now)
        XCTAssertEqual(SharedTokens.refreshToken(account: account), "r")
        let access = SharedTokens.access(account: account)
        XCTAssertEqual(access?.token, "a")
        XCTAssertEqual(access?.expiresAt.timeIntervalSince1970 ?? 0, now.addingTimeInterval(900).timeIntervalSince1970, accuracy: 0.01)
        Keychain.delete(account: account)
        XCTAssertNil(SharedTokens.refreshToken(account: account))
        XCTAssertNil(SharedTokens.access(account: account))
    }

    func testAValidStoredAccessTokenIsUsedWithoutARefresh() async throws {
        SharedTokens.store(account: account, accessToken: "a1", expiresIn: 900, refreshToken: "r1")
        StubProtocol.handler = { _ in XCTFail("no request expected"); return (500, Data()) }
        let token = try await api().accessToken()
        XCTAssertEqual(token, "a1")
    }

    func testAnExpiredAccessTokenRefreshesFromTheStoredRefreshTokenAndStoresBoth() async throws {
        SharedTokens.store(account: account, accessToken: "a1", expiresIn: 10, refreshToken: "r1")
        var sent: [String] = []
        StubProtocol.handler = { request in
            let body = request.httpBodyStream.map { stream -> Data in
                stream.open(); defer { stream.close() }
                var buffer = [UInt8](repeating: 0, count: 1024)
                let n = stream.read(&buffer, maxLength: 1024)
                return Data(buffer.prefix(max(n, 0)))
            } ?? Data()
            sent.append(((try? JSONSerialization.jsonObject(with: body)) as? [String: String])?["refresh_token"] ?? "")
            return (200, Data(#"{"access_token":"a2","refresh_token":"r2","expires_in":900}"#.utf8))
        }
        let token = try await api().accessToken()
        XCTAssertEqual(token, "a2")
        XCTAssertEqual(sent, ["r1"])
        XCTAssertEqual(SharedTokens.refreshToken(account: account), "r2")
        XCTAssertEqual(SharedTokens.access(account: account)?.token, "a2")
    }

    func testARefreshAnotherProcessDidMeanwhileIsUsedAsItIs() async throws {
        // The extension's token was refused; under the lock it finds the app already stored a new one.
        SharedTokens.store(account: account, accessToken: "app-new", expiresIn: 900, refreshToken: "r9")
        StubProtocol.handler = { _ in XCTFail("no refresh expected"); return (500, Data()) }
        let token = try await api().refreshedToken(replacing: "ext-old")
        XCTAssertEqual(token, "app-new")
    }

    func testARefusedRefreshMeansSignInAgain() async {
        SharedTokens.store(account: account, accessToken: "a1", expiresIn: 0, refreshToken: "r1")
        StubProtocol.handler = { _ in (401, Data(#"{"error":{"code":"session_revoked","message":"x","details":{}}}"#.utf8)) }
        do {
            _ = try await api().accessToken()
            XCTFail("expected notSignedIn")
        } catch {
            XCTAssertEqual(error as? ShareFailure, .notSignedIn)
        }
    }

    /// The app's ApiClient refreshes from the refresh token the Keychain holds now: the extension may have rotated it
    /// (a rotated token used again would end the session, SECURITY.md §2.3).
    @MainActor
    func testTheAppsRefreshStartsFromTheTokenTheExtensionRotated() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        let client = ApiClient(baseUrl: URL(string: "http://share.test")!, session: URLSession(configuration: configuration))
        client.refreshToken = "app-old"
        client.sharedAccount = account
        SharedTokens.store(account: account, accessToken: "x", expiresIn: 900, refreshToken: "ext-rotated")
        var sent: [String] = []
        StubProtocol.handler = { request in
            let body = request.httpBodyStream.map { stream -> Data in
                stream.open(); defer { stream.close() }
                var buffer = [UInt8](repeating: 0, count: 1024)
                let n = stream.read(&buffer, maxLength: 1024)
                return Data(buffer.prefix(max(n, 0)))
            } ?? request.httpBody ?? Data()
            sent.append(((try? JSONSerialization.jsonObject(with: body)) as? [String: String])?["refresh_token"] ?? "")
            return (200, Data("""
            {"access_token":"a3","refresh_token":"r3","token_type":"bearer","expires_in":900,"session_id":"s",
             "device":{"id":"d","platform":"ios","device_name":null,"app_version":null,"enabled":true,"disabled_reason":null,"last_seen_at":null,"created_at":"","updated_at":""},
             "user":{"id":"u","username":"alice","display_name":"Alice","role":"member","deactivated_at":null,"created_at":"","updated_at":"","email":null,"must_change_password":false}}
            """.utf8))
        }
        let account = account!
        client.onTokens = { tokens in
            SharedTokens.store(account: account, accessToken: tokens.accessToken, expiresIn: tokens.expiresIn, refreshToken: tokens.refreshToken)
        }
        _ = try await client.refresh()
        XCTAssertEqual(sent, ["ext-rotated"])
        XCTAssertEqual(client.refreshToken, "r3")
        XCTAssertEqual(SharedTokens.refreshToken(account: account), "r3")
        XCTAssertEqual(SharedTokens.access(account: account)?.token, "a3")
    }
}

final class KeychainMigrationTests: XCTestCase {
    private let service = "jp.chikuwachat.ios.tests.migration"

    override func tearDown() {
        for item in Keychain.items(service: service) { Keychain.delete(account: item.account, service: service) }
    }

    /// The app's own group (an older build's items): `<team>.jp.chikuwachat.ios`.
    private var legacyGroup: String? {
        Keychain.sharedGroup.map { $0.replacingOccurrences(of: ".shared", with: "") }
    }

    func testItemsMoveIntoTheSharedGroupKeepingTheirValues() throws {
        let shared = try XCTUnwrap(Keychain.sharedGroup, "the test host carries TaylisKeychainGroup")
        let legacy = try XCTUnwrap(legacyGroup)
        let status = Keychain.set(account: "https://a|kano", value: "refresh-old-build", service: service, group: legacy)
        if status == errSecMissingEntitlement { throw XCTSkip("this simulator build has no keychain access groups") }
        XCTAssertEqual(status, errSecSuccess)
        XCTAssertEqual(Keychain.items(service: service).first?.group, legacy)
        let moved = Keychain.migrateToSharedGroup(service: service)
        XCTAssertEqual(moved, ["https://a|kano"])
        XCTAssertEqual(Keychain.items(service: service).map(\.group), [shared])
        XCTAssertEqual(Keychain.get(account: "https://a|kano", service: service), "refresh-old-build", "nobody is signed out")
        XCTAssertEqual(Keychain.migrateToSharedGroup(service: service), [], "nothing left to move")
    }

    func testANewItemGoesStraightIntoTheSharedGroup() throws {
        let shared = try XCTUnwrap(Keychain.sharedGroup)
        Keychain.set(account: "https://b|ebi", value: "r", service: service)
        let item = try XCTUnwrap(Keychain.items(service: service).first)
        if item.group != shared, Keychain.set(account: "probe", value: "x", service: service, group: shared) == errSecMissingEntitlement {
            throw XCTSkip("this simulator build has no keychain access groups")
        }
        XCTAssertEqual(item.group, shared)
    }
}

/// REVIEW-v0.1.62 #4: the session generation (AccountSessions) the app moves on sign-in and sign-out, and the extension's
/// refresh that drops an answer of an older session (no network: the stub signs out while the request is on its way).
final class SessionGenerationTests: XCTestCase {
    private var account: String!
    private var folder: URL!
    private var sessions: AccountSessions!

    override func setUp() {
        account = "http://share.test|generation-\(UUID().uuidString)"
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("sessions-\(UUID().uuidString)", isDirectory: true)
        sessions = AccountSessions(file: folder.appendingPathComponent("sessions.json"), lockURL: folder.appendingPathComponent("sessions.lock"))
    }

    override func tearDown() {
        StubProtocol.handler = nil
        Keychain.delete(account: account)
        try? FileManager.default.removeItem(at: folder)
    }

    private func api() -> ShareApi {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        let api = ShareApi(baseUrl: URL(string: "http://share.test")!, account: account, language: "ja",
                           session: URLSession(configuration: configuration), sessions: sessions)
        api.lockProvider = { nil }
        api.refreshRetryDelays = []
        return api
    }

    private static let rotated = Data(#"{"access_token":"old-a2","refresh_token":"old-r2","expires_in":900}"#.utf8)

    func testSignInAndSignOutMoveTheGenerationAndARecordlessAccountFollowsTheKeychain() {
        XCTAssertEqual(sessions.generation(account: account), 0)
        XCTAssertFalse(sessions.isSignedIn(account: account), "no record, no token")
        SharedTokens.store(account: account, accessToken: "a", expiresIn: 900, refreshToken: "r")
        XCTAssertTrue(sessions.isSignedIn(account: account), "an install from before the record: its token says")
        XCTAssertTrue(sessions.isCurrent(account: account, generation: 0))

        let first = SharedTokens.signIn(account: account, accessToken: "a1", expiresIn: 900, refreshToken: "r1", sessions: sessions)
        XCTAssertEqual(first, 1)
        XCTAssertTrue(sessions.isCurrent(account: account, generation: 1))
        XCTAssertFalse(sessions.isCurrent(account: account, generation: 0))
        XCTAssertEqual(SharedTokens.refreshToken(account: account), "r1")

        SharedTokens.signOut(account: account, sessions: sessions)
        XCTAssertEqual(sessions.generation(account: account), 2)
        XCTAssertFalse(sessions.isSignedIn(account: account))
        XCTAssertFalse(sessions.isCurrent(account: account, generation: 2), "signed out: no generation is current")
        XCTAssertNil(SharedTokens.refreshToken(account: account))
        XCTAssertFalse(SharedTokens.commit(account: account, generation: 1, accessToken: "x", expiresIn: 900, refreshToken: "y", sessions: sessions))
        XCTAssertNil(SharedTokens.refreshToken(account: account), "nothing stored after the sign-out")
    }

    func testARefreshAnsweredAfterTheSignOutRestoresNoToken() async {
        SharedTokens.signIn(account: account, accessToken: "old-a1", expiresIn: 0, refreshToken: "old-r1", sessions: sessions)
        let account = account!, sessions = sessions!
        StubProtocol.handler = { _ in
            // The app signs out while the refresh is on its way; then the server's (late) answer arrives.
            SharedTokens.signOut(account: account, sessions: sessions)
            return (200, Self.rotated)
        }
        do {
            _ = try await api().accessToken()
            XCTFail("expected notSignedIn")
        } catch {
            XCTAssertEqual(error as? ShareFailure, .notSignedIn)
        }
        XCTAssertNil(SharedTokens.refreshToken(account: account), "the deleted refresh token stays deleted")
        XCTAssertNil(SharedTokens.access(account: account), "and the access token")
    }

    func testARefreshAnsweredAfterASignInAgainLeavesTheNewSessionsTokens() async {
        SharedTokens.signIn(account: account, accessToken: "old-a1", expiresIn: 0, refreshToken: "old-r1", sessions: sessions)
        let account = account!, sessions = sessions!
        StubProtocol.handler = { _ in
            SharedTokens.signOut(account: account, sessions: sessions)
            SharedTokens.signIn(account: account, accessToken: "new-a", expiresIn: 900, refreshToken: "new-r", sessions: sessions)
            return (200, Self.rotated)
        }
        do {
            _ = try await api().refreshedToken(replacing: "old-a1")
            XCTFail("expected notSignedIn")
        } catch {
            XCTAssertEqual(error as? ShareFailure, .notSignedIn)
        }
        XCTAssertEqual(SharedTokens.refreshToken(account: account), "new-r", "the new sign-in's token is not overwritten")
        XCTAssertEqual(SharedTokens.access(account: account)?.token, "new-a")
    }

    func testAClientOfAnOlderSessionUsesNoTokenOfTheNewOne() async {
        let api = api() // made in the session before the sign-out
        SharedTokens.signIn(account: account, accessToken: "new-a", expiresIn: 900, refreshToken: "new-r", sessions: sessions)
        StubProtocol.handler = { _ in XCTFail("no request expected"); return (500, Data()) }
        do {
            _ = try await api.accessToken()
            XCTFail("expected notSignedIn")
        } catch {
            XCTAssertEqual(error as? ShareFailure, .notSignedIn)
        }
    }

    func testAPendingShareOfAnOlderSessionIsGivenUpNotSent() async throws {
        let root = folder.appendingPathComponent("pending", isDirectory: true)
        let generation = SharedTokens.signIn(account: account, accessToken: "a1", expiresIn: 900, refreshToken: "r1", sessions: sessions)
        let store = PendingShareStore(root: root)
        _ = try store.makeFolder("old")
        var share = PendingShareStoreTests.share("old", items: 0)
        share.account = account
        share.generation = generation
        try store.save(share)
        // Signed out and in again before it was sent.
        SharedTokens.signOut(account: account, sessions: sessions)
        SharedTokens.signIn(account: account, accessToken: "a2", expiresIn: 900, refreshToken: "r2", sessions: sessions)
        StubProtocol.handler = { request in
            XCTFail("nothing is sent: \(request.url?.path ?? "")")
            return (500, Data())
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        let session = URLSession(configuration: configuration)
        let sessions = sessions!
        let processor = ShareProcessor(store: store, transport: FakeShareTransport(), sessions: sessions) { share in
            let api = ShareApi(baseUrl: URL(string: share.serverUrl)!, account: share.account, language: "ja", session: session,
                               generation: share.generation ?? 0, sessions: sessions)
            api.lockProvider = { nil }
            return api
        }
        let outcome = await processor.send("old")
        XCTAssertEqual(outcome, .failed(.notSignedIn))
        XCTAssertNil(store.load("old"), "given up")
    }
}
