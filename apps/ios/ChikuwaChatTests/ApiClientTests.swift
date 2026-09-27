import XCTest
@testable import ChikuwaChat

/// URLProtocol stub so the client can be exercised without a network.
final class StubProtocol: URLProtocol {
    nonisolated(unsafe) static var handler: ((URLRequest) -> (Int, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let (status, data) = Self.handler?(request) ?? (500, Data())
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
        let tokens = try await client.acceptInvite(token: "t_k", username: "tanaka", displayName: "田中", password: "pw",
                                                   device: .init(platform: "ios", deviceName: nil, appVersion: nil))
        XCTAssertEqual(tokens.user.username, "alice")
        XCTAssertEqual(client.refreshToken, "refresh-3")
        XCTAssertEqual(seen.map(\.path), ["/api/v1/invites/t_k", "/api/v1/invites/t_k/accept"])
        XCTAssertEqual(seen.map(\.auth), [nil, nil])
        XCTAssertTrue(seen[1].body.contains(#""display_name":"田中""#), seen[1].body)
    }
}
