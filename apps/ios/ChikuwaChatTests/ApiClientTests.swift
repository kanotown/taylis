import ImageIO
import UIKit
import UniformTypeIdentifiers
import XCTest
@testable import ChikuwaChat

/// URLProtocol stub so the client can be exercised without a network.
final class StubProtocol: URLProtocol {
    nonisolated(unsafe) static var handler: ((URLRequest) -> (Int, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let (status, data) = Self.handler?(request) ?? (500, Data())
        if status < 0 { // no answer at all (the connection dropped)
            client?.urlProtocol(self, didFailWithError: URLError(.networkConnectionLost))
            return
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

@MainActor
final class ApiClientTests: XCTestCase {
    private func makeClient() -> ApiClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        return ApiClient(baseUrl: URL(string: "http://server")!, session: URLSession(configuration: configuration))
    }

    private func tokens(_ n: Int) -> Data {
        Data("""
        {"access_token":"access-\(n)","refresh_token":"refresh-\(n)","token_type":"bearer","expires_in":900,"session_id":"s",
         "device":{"id":"d","platform":"ios","device_name":null,"app_version":null,"enabled":true,"disabled_reason":null,"last_seen_at":null,"created_at":"","updated_at":""},
         "user":{"id":"u","username":"alice","display_name":"Alice","role":"member","deactivated_at":null,"created_at":"","updated_at":"","email":null,"must_change_password":false}}
        """.utf8)
    }

    func testRefreshesOnceOnTokenExpiredAndRetries() async throws {
        var refreshed = 0
        var auths: [String?] = []
        StubProtocol.handler = { [self] request in
            auths.append(request.value(forHTTPHeaderField: "Authorization"))
            if request.url!.path == "/api/v1/auth/refresh" {
                refreshed += 1
                return (200, tokens(2))
            }
            if request.value(forHTTPHeaderField: "Authorization") == "Bearer access-1" {
                return (401, Data(#"{"error":{"code":"token_expired","message":"expired","details":{}}}"#.utf8))
            }
            return (200, Data(#"{"id":"u","username":"alice","display_name":"Alice","role":"member","deactivated_at":null,"created_at":"","updated_at":"","email":null,"must_change_password":false}"#.utf8))
        }
        let client = makeClient()
        client.accessToken = "access-1"
        client.refreshToken = "refresh-1"
        let me = try await client.me()
        XCTAssertEqual(me.username, "alice")
        XCTAssertEqual(refreshed, 1)
        XCTAssertEqual(client.refreshToken, "refresh-2")
        XCTAssertEqual(auths, ["Bearer access-1", nil, "Bearer access-2"])
    }

    func testSignsOutWhenRefreshFails() async throws {
        StubProtocol.handler = { request in
            if request.url!.path.hasSuffix("/auth/refresh") {
                return (401, Data(#"{"error":{"code":"session_revoked","message":"revoked","details":{}}}"#.utf8))
            }
            return (401, Data(#"{"error":{"code":"token_expired","message":"expired","details":{}}}"#.utf8))
        }
        let client = makeClient()
        var signedOut = false
        client.onSignedOut = { signedOut = true }
        client.accessToken = "a"
        client.refreshToken = "r"
        do {
            _ = try await client.me()
            XCTFail("expected failure")
        } catch let ApiError.api(status, code, _) {
            XCTAssertEqual(status, 401)
            XCTAssertEqual(code, "session_revoked")
        }
        XCTAssertTrue(signedOut)
        XCTAssertNil(client.accessToken)
    }

    func testRestoredSessionRefreshesBeforeAuthenticatedRequest() async throws {
        var paths: [String] = []
        StubProtocol.handler = { [self] request in
            paths.append(request.url!.path)
            if request.url!.path.hasSuffix("/auth/refresh") { return (200, tokens(2)) }
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer access-2")
            return (200, Data(#"{"id":"u","username":"alice","display_name":"Alice","role":"member","created_at":"","updated_at":"","must_change_password":false}"#.utf8))
        }
        let client = makeClient()
        client.refreshToken = "refresh-1"
        _ = try await client.me()
        XCTAssertEqual(paths, ["/api/v1/auth/refresh", "/api/v1/users/me"])
    }

    func testLateRefreshDoesNotRestoreSignedOutCredentials() async {
        let received = expectation(description: "refresh requested")
        let gate = DispatchSemaphore(value: 0)
        let response = tokens(2)
        StubProtocol.handler = { _ in
            received.fulfill()
            _ = gate.wait(timeout: .now() + 5)
            return (200, response)
        }
        let client = makeClient()
        client.refreshToken = "refresh-1"
        var saved = false
        client.onTokens = { _ in saved = true }
        let task = Task { try await client.refresh() }
        await fulfillment(of: [received], timeout: 3)
        client.signOut()
        gate.signal()
        do { _ = try await task.value; XCTFail("expected cancelled session") } catch {}
        XCTAssertNil(client.accessToken)
        XCTAssertNil(client.refreshToken)
        XCTAssertFalse(saved)
    }

    func testErrorClassification() {
        XCTAssertTrue(ApiError.network(URLError(.notConnectedToInternet)).isRetryable)
        XCTAssertTrue(ApiError.api(status: 503, code: "unavailable", message: "").isRetryable)
        XCTAssertFalse(ApiError.api(status: 422, code: "validation_error", message: "").isRetryable)
        XCTAssertEqual(ApiClient(baseUrl: URL(string: "https://chat.example.com")!).wsUrl.absoluteString, "wss://chat.example.com/api/v1/ws")
        XCTAssertEqual(ApiClient(baseUrl: URL(string: "http://127.0.0.1:8000")!).wsUrl.absoluteString, "ws://127.0.0.1:8000/api/v1/ws")
    }

    func testAcceptingAnInviteNeedsNoTokenAndLogsIn() async throws {
        var seen: [(path: String, auth: String?, body: String)] = []
        StubProtocol.handler = { [self] request in
            let body = request.httpBodyStream.map { stream -> String in
                stream.open(); defer { stream.close() }
                var data = Data(); var buffer = [UInt8](repeating: 0, count: 4096)
                while stream.hasBytesAvailable { let n = stream.read(&buffer, maxLength: buffer.count); if n <= 0 { break }; data.append(buffer, count: n) }
                return String(decoding: data, as: UTF8.self)
            } ?? ""
            seen.append((request.url!.path, request.value(forHTTPHeaderField: "Authorization"), body))
            if request.url!.path.hasSuffix("/accept") { return (201, tokens(3)) }
            return (200, Data(#"{"invited_by":"Root","role":"member","channels":["general"],"expires_at":"2026-10-04T00:00:00Z","password_min_length":8}"#.utf8))
        }
        let client = makeClient()
        let preview = try await client.invitePreview(token: "t_k")
        XCTAssertEqual(preview.invitedBy, "Root")
        XCTAssertEqual(preview.channels, ["general"])
        let accepted = try await client.acceptInvite(token: "t_k", username: "tanaka", displayName: "田中", password: "pw",
                                                   device: .init(platform: "ios", deviceName: nil, appVersion: nil))
        XCTAssertEqual(accepted.user.username, "alice")
        XCTAssertEqual(client.refreshToken, "refresh-3")
        XCTAssertEqual(seen.map(\.path), ["/api/v1/invites/t_k", "/api/v1/invites/t_k/accept"])
        XCTAssertEqual(seen.map(\.auth), [nil, nil])
        XCTAssertTrue(seen[1].body.contains(#""display_name":"田中""#), seen[1].body)
    }

    func testLoginSendsTheTotpCodeOnlyWhenGiven() async throws {
        var bodies: [String] = []
        StubProtocol.handler = { [self] request in
            let body = request.httpBodyStream.map { stream -> String in
                stream.open(); defer { stream.close() }
                var data = Data(); var buffer = [UInt8](repeating: 0, count: 4096)
                while stream.hasBytesAvailable { let n = stream.read(&buffer, maxLength: buffer.count); if n <= 0 { break }; data.append(buffer, count: n) }
                return String(decoding: data, as: UTF8.self)
            } ?? ""
            bodies.append(body)
            if request.url!.path == "/api/v1/auth/totp" {
                return (200, Data(#"{"enabled":true,"enabled_at":"2026-09-27T00:00:00Z","recovery_codes_left":7}"#.utf8))
            }
            if body.contains("totp_code") { return (200, tokens(5)) }
            return (401, Data(#"{"error":{"code":"totp_required","message":"Two-factor code required","details":{}}}"#.utf8))
        }
        let client = makeClient()
        let device = DeviceInfo(platform: "ios", deviceName: nil, appVersion: nil)
        do {
            _ = try await client.login(username: "alice", password: "pw", device: device)
            XCTFail("expected totp_required")
        } catch {
            XCTAssertEqual((error as? ApiError)?.code, "totp_required")
        }
        let signedIn = try await client.login(username: "alice", password: "pw", device: device, totpCode: "123456")
        XCTAssertEqual(signedIn.refreshToken, "refresh-5")
        XCTAssertFalse(bodies[0].contains("totp_code"))
        XCTAssertTrue(bodies[1].contains(#""totp_code":"123456""#), bodies[1])
        let status = try await client.totpStatus()
        XCTAssertEqual(status, TotpStatusOut(enabled: true, enabledAt: "2026-09-27T00:00:00Z", recoveryCodesLeft: 7))
    }

    func testMessageRevisionsDecode() async throws {
        var paths: [String] = []
        StubProtocol.handler = { request in
            paths.append(request.url!.path)
            return (200, Data(#"[{"body":"old","written_at":"2026-09-27T00:00:00Z","replaced_at":"2026-09-27T00:05:00Z"}]"#.utf8))
        }
        let client = makeClient()
        client.accessToken = "a"
        let rows = try await client.messageRevisions("m1")
        XCTAssertEqual(rows, [MessageRevisionOut(body: "old", writtenAt: "2026-09-27T00:00:00Z", replacedAt: "2026-09-27T00:05:00Z")])
        XCTAssertEqual(paths, ["/api/v1/messages/m1/revisions"])
    }

    func testSidebarSectionCallsReturnTheWholeList() async throws {
        var calls: [String] = []
        StubProtocol.handler = { request in
            calls.append("\(request.httpMethod ?? "GET") \(request.url!.path)")
            return (200, Data(#"[{"id":"s1","name":"プロジェクト","position":0,"channel_ids":["c1"]}]"#.utf8))
        }
        let client = makeClient()
        client.accessToken = "a"
        _ = try await client.createSidebarSection(name: "プロジェクト")
        _ = try await client.updateSidebarSection("s1", position: 1)
        _ = try await client.placeInSidebarSection("s1", channelId: "c1")
        _ = try await client.removeFromSidebarSection("c1")
        let rows = try await client.deleteSidebarSection("s1")
        XCTAssertEqual(rows, [SidebarSectionOut(id: "s1", name: "プロジェクト", position: 0, channelIds: ["c1"])])
        XCTAssertEqual(calls, [
            "POST /api/v1/sidebar/sections", "PATCH /api/v1/sidebar/sections/s1", "PUT /api/v1/sidebar/sections/s1/channels/c1",
            "DELETE /api/v1/sidebar/channels/c1", "DELETE /api/v1/sidebar/sections/s1",
        ])
    }

    func testSectionsCarryTheirIconAndFoldAndTakeConversationsWhenMade() async throws {  // M26
        var sent: [(call: String, body: [String: Any])] = []
        StubProtocol.handler = { request in
            let data = request.httpBodyStream.map { stream -> Data in
                stream.open(); defer { stream.close() }
                var data = Data(); var buffer = [UInt8](repeating: 0, count: 4096)
                while stream.hasBytesAvailable { let n = stream.read(&buffer, maxLength: buffer.count); if n <= 0 { break }; data.append(buffer, count: n) }
                return data
            } ?? Data()
            let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
            sent.append(("\(request.httpMethod ?? "GET") \(request.url!.path)", body))
            return (200, Data(#"""
            [{"id":"s1","name":"研究","emoji":":chikuwa:","collapsed":true,"position":0,"channel_ids":["c1","c2"]},
             {"id":"s2","name":"古い","position":1}]
            """#.utf8))
        }
        let client = makeClient()
        client.accessToken = "a"
        let rows = try await client.createSidebarSection(name: "研究", emoji: ":chikuwa:", channelIds: ["c1", "c2"])
        XCTAssertEqual(rows[0], SidebarSectionOut(id: "s1", name: "研究", position: 0, channelIds: ["c1", "c2"], emoji: ":chikuwa:", collapsed: true))
        // A server before M26 sends neither field (nor, here, the list).
        XCTAssertEqual(rows[1], SidebarSectionOut(id: "s2", name: "古い", position: 1))
        _ = try await client.editSidebarSection("s1", name: "研究室", emoji: nil)
        _ = try await client.updateSidebarSection("s1", collapsed: false)
        _ = try await client.createSidebarSection(name: "空")
        XCTAssertEqual(sent.map(\.call), ["POST /api/v1/sidebar/sections", "PATCH /api/v1/sidebar/sections/s1",
                                           "PATCH /api/v1/sidebar/sections/s1", "POST /api/v1/sidebar/sections"])
        XCTAssertEqual(sent[0].body["emoji"] as? String, ":chikuwa:")
        XCTAssertEqual(sent[0].body["channel_ids"] as? [String], ["c1", "c2"])
        XCTAssertEqual(sent[1].body["name"] as? String, "研究室")
        XCTAssertTrue(sent[1].body["emoji"] is NSNull, "an explicit null takes the icon off")
        XCTAssertEqual(sent[2].body as NSDictionary, ["collapsed": false] as NSDictionary)
        XCTAssertEqual(sent[3].body as NSDictionary, ["name": "空"] as NSDictionary)  // what a server before M26 accepts
    }

    func testEnsureTimesPostsAndReturnsTheChannel() async throws {  // M24: 201 made, 200 existing
        var calls: [String] = []
        StubProtocol.handler = { request in
            calls.append("\(request.httpMethod ?? "GET") \(request.url!.path)")
            return (calls.count == 1 ? 201 : 200, Data(#"""
            {"id":"t1","type":"public","name":"times-alice","topic":null,"purpose":"Alice の作業ログ","archived":false,"created_by":"u","last_seq":0,
             "last_message_at":null,"created_at":"","updated_at":"","membership":{"role":"owner","joined_at":""},"dm_user_ids":null,
             "member_count":1,"posting_policy":"everyone","times_owner_id":"u"}
            """#.utf8))
        }
        let client = makeClient()
        client.accessToken = "a"
        let made = try await client.ensureTimes()
        let again = try await client.ensureTimes()
        XCTAssertEqual(calls, ["POST /api/v1/times", "POST /api/v1/times"])
        XCTAssertEqual(made, again)
        XCTAssertEqual(made.timesOwnerId, "u")
        XCTAssertEqual(made.membership?.role, "owner")
    }

    // MARK: release fixes

    func testQueryStringsEncodePlus() async throws {  // "C++" must not reach the server as "C  "
        var queries: [String] = []
        StubProtocol.handler = { request in
            queries.append(URLComponents(url: request.url!, resolvingAgainstBaseURL: false)!.percentEncodedQuery ?? "")
            if request.url!.path.hasSuffix("/link-previews") {
                return (200, Data(#"{"url":"u","status":"failed","title":null,"description":null,"image_url":null,"site_name":null,"fetched_at":""}"#.utf8))
            }
            return (200, Data(#"{"hits":[],"keywords":[],"limit":20,"offset":0,"has_more":false}"#.utf8))
        }
        let client = makeClient()
        client.accessToken = "a"
        _ = try await client.searchMessages(SearchLogic.request(SearchParams(q: "C++ a&b")))
        _ = try await client.linkPreview(url: "https://example.com/?q=1+1")
        XCTAssertTrue(queries[0].contains("q=C%2B%2B%20a%26b"), queries[0])
        XCTAssertTrue(queries[1].contains("url=https://example.com/?q%3D1%2B1") || queries[1].contains("url=https://example.com/?q=1%2B1"), queries[1])
        XCTAssertFalse(queries[1].contains("+"), queries[1])
        XCTAssertEqual(ApiClient.pathWithQuery("/api/v1/files", [URLQueryItem(name: "q", value: "a+b")]), "/api/v1/files?q=a%2Bb")
    }

    func testRefreshOnlyWhenNeededAndRetriedQuicklyAfterANetworkFailure() async throws {  // SYNC_PROTOCOL.md §7.2
        var attempts = 0
        StubProtocol.handler = { [self] _ in
            attempts += 1
            return attempts == 1 ? (-1, Data()) : (200, tokens(2)) // the first answer is lost
        }
        let client = makeClient()
        client.refreshRetryDelays = [0.01]
        client.refreshToken = "refresh-1"
        XCTAssertTrue(client.needsRefresh())
        let refreshed = try await client.refresh()
        XCTAssertEqual(refreshed.refreshToken, "refresh-2")
        XCTAssertEqual(attempts, 2)
        XCTAssertFalse(client.needsRefresh()) // 900 s left: the next connection keeps this token
        XCTAssertTrue(client.needsRefresh(margin: 1000))

        // Still no answer after the retries: the error comes back and the session is kept for the next attempt.
        StubProtocol.handler = { _ in (-1, Data()) }
        attempts = 0
        do {
            _ = try await client.refresh()
            XCTFail("expected a network error")
        } catch ApiError.network {}
        XCTAssertEqual(client.refreshToken, "refresh-2")
    }

    func testLogoutRefreshesAnExpiredTokenSoTheServerSessionEnds() async throws {  // SYNC_PROTOCOL.md §11
        var calls: [String] = []
        StubProtocol.handler = { [self] request in
            calls.append("\(request.url!.path) \(request.value(forHTTPHeaderField: "Authorization") ?? "-")")
            if request.url!.path.hasSuffix("/auth/refresh") { return (200, tokens(2)) }
            if request.value(forHTTPHeaderField: "Authorization") == "Bearer access-1" {
                return (401, Data(#"{"error":{"code":"token_expired","message":"expired","details":{}}}"#.utf8))
            }
            return (204, Data())
        }
        let client = makeClient()
        var signedOut = false
        client.onSignedOut = { signedOut = true }
        client.accessToken = "access-1"
        client.refreshToken = "refresh-1"
        await client.logout()
        XCTAssertEqual(calls, ["/api/v1/auth/logout Bearer access-1", "/api/v1/auth/refresh -", "/api/v1/auth/logout Bearer access-2"])
        XCTAssertTrue(signedOut)
        XCTAssertNil(client.refreshToken)
    }

    func testErrorTextComesFromTheSharedJapaneseTable() {  // ARCHITECTURE.md §9
        XCTAssertEqual(ErrorMessages.text(for: ApiError.api(status: 403, code: "not_a_member", message: "You are not a member of this channel")),
                       "このチャンネルのメンバーではありません")
        XCTAssertEqual(ErrorMessages.text(for: ApiError.api(status: 502, code: "http_502", message: "Request failed")), ErrorMessages.byStatus["5xx"])
        XCTAssertEqual(ErrorMessages.text(for: ApiError.api(status: 409, code: "brand_new_code", message: "English text")), ErrorMessages.byStatus["409"])
        XCTAssertEqual(ErrorMessages.text(for: ApiError.network(URLError(.notConnectedToInternet))), ErrorMessages.network)
        XCTAssertEqual(ErrorMessages.text(for: ApiError.api(status: 0, code: "decode_error", message: "Unexpected response: keyNotFound(…)")), ErrorMessages.unknown)
        XCTAssertEqual(AppController().describe(ApiError.api(status: 401, code: "invalid_credentials", message: "Invalid credentials")),
                       "ユーザー名またはパスワードが違います")
    }

    func testLargeFilesStreamFromDiskAndPhotosGoInServerFormats() throws {
        let source = FileManager.default.temporaryDirectory.appendingPathComponent("source-\(UUID().uuidString)")
        try Data(repeating: 7, count: 3 << 20).write(to: source) // 3 MB: several 1 MB chunks
        defer { try? FileManager.default.removeItem(at: source) }
        let body = try Multipart.write(head: Multipart.head(boundary: "b", filename: "a\"b.bin", contentType: "application/octet-stream"),
                                       file: source, tail: Multipart.tail(boundary: "b"))
        defer { try? FileManager.default.removeItem(at: body) }
        let written = try Data(contentsOf: body)
        let head = String(decoding: written.prefix(120), as: UTF8.self)
        XCTAssertTrue(head.hasPrefix("--b\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a_b.bin\""), head)
        XCTAssertEqual(String(decoding: written.suffix(9), as: UTF8.self), "\r\n--b--\r\n")
        XCTAssertEqual(written.count, Multipart.head(boundary: "b", filename: "a\"b.bin", contentType: "application/octet-stream").count + (3 << 20) + 9)

        let image = UIGraphicsImageRenderer(size: CGSize(width: 8, height: 8)).image { context in
            UIColor.red.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 8, height: 8))
        }
        let png = try XCTUnwrap(image.pngData())
        XCTAssertEqual(ImageUpload.prepare(png)?.mime, "image/png") // PNG / JPEG / GIF / WebP go as they are
        XCTAssertEqual(ImageUpload.prepare(png)?.data, png)
        var others = [try XCTUnwrap(encode(image, as: .tiff))]
        if let heic = image.heicData() { others.append(heic) } // the simulator may lack an HEIC encoder
        for data in others {
            let converted = try XCTUnwrap(ImageUpload.prepare(data))
            XCTAssertEqual(converted.mime, "image/jpeg")
            XCTAssertEqual(converted.ext, "jpg")
            XCTAssertEqual(ImageUpload.kind(of: converted.data)?.mime, "image/jpeg")
        }
        XCTAssertNil(ImageUpload.prepare(Data("not an image".utf8)))
    }

    private func encode(_ image: UIImage, as type: UTType) -> Data? {
        guard let cgImage = image.cgImage else { return nil }
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data, type.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(destination, cgImage, nil)
        return CGImageDestinationFinalize(destination) ? data as Data : nil
    }
}
