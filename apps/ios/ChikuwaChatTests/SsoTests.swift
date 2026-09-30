import CryptoKit
import SwiftUI
import UIKit
import XCTest
@testable import ChikuwaChat

/// A sign-in sheet that answers at once: the URL it was opened with, and a canned callback (or error).
@MainActor
final class FakeWebAuthenticator: WebAuthenticator {
    var opened: [(url: URL, scheme: String)] = []
    var answer: (URL) throws -> URL

    init(answer: @escaping (URL) throws -> URL) { self.answer = answer }

    func authenticate(url: URL, callbackScheme: String) async throws -> URL {
        opened.append((url, callbackScheme))
        return try answer(url)
    }
}

/// M48: Google sign-in on iOS (docs/SSO.md §6).
@MainActor
final class SsoTests: XCTestCase {
    private func makeClient() -> ApiClient {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        return ApiClient(baseUrl: URL(string: "http://server")!, session: URLSession(configuration: configuration))
    }

    private func query(_ url: URL, _ name: String) -> String? {
        URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == name }?.value
    }

    // MARK: verifier and challenge

    func testChallengeIsS256OfTheVerifierInBase64url() {
        // RFC 7636 Appendix B.
        XCTAssertEqual(Sso.challenge(for: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"), "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
        XCTAssertEqual(Sso.base64url(Data([116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186,
                                           22, 212, 37, 77, 105, 214, 191, 240, 91, 88, 5, 88, 83, 132, 141, 121])),
                       "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
        XCTAssertEqual(Sso.base64url(Data([0xfb, 0xff])), "-_8")
    }

    func testVerifierIs43Base64urlCharactersAndFresh() throws {
        let a = try XCTUnwrap(Sso.newVerifier())
        let b = try XCTUnwrap(Sso.newVerifier())
        XCTAssertNotNil(a.range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression))
        XCTAssertNotEqual(a, b)
        XCTAssertNotNil(Sso.challenge(for: a).range(of: "^[A-Za-z0-9_-]{43}$", options: .regularExpression)) // the server's pattern
    }

    func testStartUrl() throws {
        let url = try XCTUnwrap(Sso.startURL(server: URL(string: "https://chat.example.ac.jp/")!, challenge: "abc"))
        XCTAssertEqual(url.absoluteString, "https://chat.example.ac.jp/api/v1/auth/sso/google/start?platform=ios&challenge=abc")
        XCTAssertEqual(Sso.startURL(server: URL(string: "http://127.0.0.1:8000")!, challenge: "x")?.absoluteString,
                       "http://127.0.0.1:8000/api/v1/auth/sso/google/start?platform=ios&challenge=x")
    }

    // MARK: the callback

    func testParsesTheCallback() {
        XCTAssertEqual(Sso.parse(URL(string: "chikuwachat://sso?ticket=T-1_x")!), .ticket("T-1_x"))
        XCTAssertEqual(Sso.parse(URL(string: "chikuwachat://sso?sso_error=domain_not_allowed")!), .error("domain_not_allowed"))
        XCTAssertEqual(Sso.parse(URL(string: "CHIKUWACHAT://SSO?sso_error=expired")!), .error("expired"))
        // An unexpected code reads as a provider error; a ticket wins over an error.
        XCTAssertEqual(Sso.parse(URL(string: "chikuwachat://sso?sso_error=%3Cscript%3E")!), .error("provider_error"))
        XCTAssertEqual(Sso.parse(URL(string: "chikuwachat://sso?ticket=t&sso_error=expired")!), .ticket("t"))
        // Garbage.
        XCTAssertNil(Sso.parse(URL(string: "chikuwachat://sso")!))
        XCTAssertNil(Sso.parse(URL(string: "chikuwachat://sso?ticket=")!))
        XCTAssertNil(Sso.parse(URL(string: "chikuwachat://other?ticket=t")!))
        XCTAssertNil(Sso.parse(URL(string: "https://sso?ticket=t")!))
        XCTAssertNil(Sso.parse(URL(string: "otherapp://sso?ticket=t")!))
    }

    func testErrorCodesReadInJapanese() {
        XCTAssertEqual(Sso.errorText("domain_not_allowed"), "このサーバでは、許可された大学・組織の Google アカウントだけでログインできます")
        XCTAssertEqual(Sso.errorText("not_registered"), "このメールアドレスのアカウントはありません。管理者に登録を依頼してください")
        for code in ["cancelled", "expired", "email_not_verified", "account_disabled", "provider_error", "invalid_ticket"] {
            XCTAssertNotNil(ErrorMessages.byCode[code], code)
        }
        XCTAssertEqual(Sso.errorText("something_new"), Sso.failedText)
    }

    // MARK: the flow, with a fake sheet

    func testFlowReturnsTheTicketWithTheVerifierOfTheChallenge() async throws {
        let sheet = FakeWebAuthenticator { _ in URL(string: "chikuwachat://sso?ticket=tk")! }
        let outcome = await Sso.run(server: URL(string: "https://a.example.ac.jp")!, authenticator: sheet)
        guard case .ticket(let ticket, let verifier) = outcome else { return XCTFail("\(outcome)") }
        XCTAssertEqual(ticket, "tk")
        let opened = try XCTUnwrap(sheet.opened.first)
        XCTAssertEqual(opened.scheme, "chikuwachat")
        XCTAssertEqual(opened.url.host, "a.example.ac.jp")
        XCTAssertEqual(opened.url.path, "/api/v1/auth/sso/google/start")
        XCTAssertEqual(query(opened.url, "platform"), "ios")
        XCTAssertEqual(query(opened.url, "challenge"), Sso.challenge(for: verifier))
        XCTAssertNil(opened.url.absoluteString.range(of: verifier)) // only the hash leaves the app
    }

    func testFlowOutcomes() async {
        let server = URL(string: "https://a.example.ac.jp")!
        let refused = FakeWebAuthenticator { _ in URL(string: "chikuwachat://sso?sso_error=not_registered")! }
        let outcome = await Sso.run(server: server, authenticator: refused)
        XCTAssertEqual(outcome, .failed("このメールアドレスのアカウントはありません。管理者に登録を依頼してください"))
        let closed = FakeWebAuthenticator { _ in throw WebAuthenticationError.cancelled }
        let cancelled = await Sso.run(server: server, authenticator: closed)
        XCTAssertEqual(cancelled, .cancelled)
        let broken = FakeWebAuthenticator { _ in throw WebAuthenticationError.failed(nil) }
        let failed = await Sso.run(server: server, authenticator: broken)
        XCTAssertEqual(failed, .failed(Sso.failedText))
        let garbage = FakeWebAuthenticator { _ in URL(string: "chikuwachat://elsewhere")! }
        let unknown = await Sso.run(server: server, authenticator: garbage)
        XCTAssertEqual(unknown, .failed(Sso.failedText))
    }

    /// The controller: a bad address opens no sheet; a closed sheet says nothing (nil); the ticket goes back to the
    /// server the sheet was opened on, with the verifier whose hash the sheet carried.
    func testControllerExchangesWithTheServerItStartedOn() async throws {
        let controller = AppController(defaults: UserDefaults(suiteName: "sso-tests-\(UUID().uuidString)")!)
        let sheet = FakeWebAuthenticator { _ in throw WebAuthenticationError.cancelled }
        let bad = await controller.signInWithGoogle(server: "http://", authenticator: sheet)
        XCTAssertEqual(bad, .failed("サーバ URL が正しくありません"))
        XCTAssertTrue(sheet.opened.isEmpty)

        URLProtocol.registerClass(StubProtocol.self)
        defer { URLProtocol.unregisterClass(StubProtocol.self); StubProtocol.handler = nil }
        var exchanges: [(host: String?, verifier: String?)] = []
        StubProtocol.handler = { request in
            if request.url?.path == "/api/v1/auth/sso/exchange" {
                let body = request.httpBodyStream.map { stream -> Data in
                    stream.open(); defer { stream.close() }
                    var data = Data(); var buffer = [UInt8](repeating: 0, count: 4096)
                    while stream.hasBytesAvailable { let n = stream.read(&buffer, maxLength: buffer.count); if n <= 0 { break }; data.append(buffer, count: n) }
                    return data
                } ?? request.httpBody ?? Data()
                let json = try? JSONSerialization.jsonObject(with: body) as? [String: Any]
                exchanges.append((request.url?.host, json?["verifier"] as? String))
                return (401, Data(#"{"error":{"code":"invalid_ticket","message":"Invalid ticket","details":{}}}"#.utf8))
            }
            return (404, Data(#"{"detail":"Not Found"}"#.utf8)) // GET /server of a test host: not a verdict on the address
        }
        let cancelled = await controller.signInWithGoogle(server: "https://b.example.ac.jp", authenticator: sheet)
        XCTAssertNil(cancelled)
        XCTAssertTrue(exchanges.isEmpty)

        let returning = FakeWebAuthenticator { _ in URL(string: "chikuwachat://sso?ticket=tk")! }
        let outcome = await controller.signInWithGoogle(server: "B.example.ac.jp/", authenticator: returning)
        XCTAssertEqual(outcome, .failed("ログインの手続きが無効か、期限が切れています。もう一度「Google でログイン」からやり直してください"))
        let opened = try XCTUnwrap(returning.opened.first?.url)
        XCTAssertEqual(opened.host, "b.example.ac.jp")
        XCTAssertEqual(exchanges.count, 1)
        XCTAssertEqual(exchanges.first?.host, "b.example.ac.jp")
        XCTAssertEqual(query(opened, "challenge"), exchanges.first?.verifier.map(Sso.challenge(for:)))
    }

    // MARK: API

    func testMethodsDecideTheButton() async {
        let client = makeClient()
        StubProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/api/v1/auth/methods")
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            return (200, Data(#"{"password":true,"google":{"enabled":true}}"#.utf8))
        }
        let enabled = await client.offersGoogle()
        XCTAssertTrue(enabled)
        StubProtocol.handler = { _ in (200, Data(#"{"password":true,"google":{"enabled":false}}"#.utf8)) }
        let disabled = await client.offersGoogle()
        XCTAssertFalse(disabled)
        // A server before M48: no such endpoint.
        StubProtocol.handler = { _ in (404, Data(#"{"detail":"Not Found"}"#.utf8)) }
        let old = await client.offersGoogle()
        XCTAssertFalse(old)
        StubProtocol.handler = { _ in (200, Data("<html>".utf8)) }
        let notJson = await client.offersGoogle()
        XCTAssertFalse(notJson)
        StubProtocol.handler = { _ in (-1, Data()) }
        let offline = await client.offersGoogle()
        XCTAssertFalse(offline)
        // Tolerant decoding: `password` may be missing.
        XCTAssertEqual(try JSON.snakeDecoder.decode(AuthMethodsOut.self, from: Data(#"{"google":{"enabled":true}}"#.utf8)).googleEnabled, true)
    }

    func testExchangeSendsTicketVerifierAndDeviceAndKeepsTheTokens() async throws {
        let client = makeClient()
        var sent: [String: Any]?
        StubProtocol.handler = { request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/api/v1/auth/sso/exchange")
            let body = request.httpBodyStream.map { stream -> Data in
                stream.open(); defer { stream.close() }
                var data = Data(); var buffer = [UInt8](repeating: 0, count: 4096)
                while stream.hasBytesAvailable { let n = stream.read(&buffer, maxLength: buffer.count); if n <= 0 { break }; data.append(buffer, count: n) }
                return data
            } ?? request.httpBody ?? Data()
            sent = try? JSONSerialization.jsonObject(with: body) as? [String: Any]
            return (200, Data("""
            {"access_token":"a","refresh_token":"r","token_type":"bearer","expires_in":900,"session_id":"s",
             "device":{"id":"d","platform":"ios","device_name":"iPhone","app_version":"0.1.0","enabled":true,"disabled_reason":null,"last_seen_at":null,"created_at":"","updated_at":""},
             "user":{"id":"u","username":"taro","display_name":"山田 太郎","role":"member","deactivated_at":null,"created_at":"","updated_at":"","email":"taro@example.ac.jp","must_change_password":false,"has_password":false}}
            """.utf8))
        }
        var saved: String?
        client.onTokens = { saved = $0.refreshToken }
        let tokens = try await client.ssoExchange(ticket: "tk", verifier: "v", device: DeviceInfo(platform: "ios", deviceName: "iPhone", appVersion: "0.1.0"))
        XCTAssertEqual(sent?["ticket"] as? String, "tk")
        XCTAssertEqual(sent?["verifier"] as? String, "v")
        XCTAssertEqual(sent?["device"] as? [String: String], ["platform": "ios", "device_name": "iPhone", "app_version": "0.1.0"])
        XCTAssertEqual(tokens.user.username, "taro")
        XCTAssertEqual(tokens.user.passwordSet, false)
        XCTAssertEqual(client.refreshToken, "r")
        XCTAssertEqual(saved, "r")
    }

    func testExchangeFailureReadsInJapanese() async {
        let client = makeClient()
        StubProtocol.handler = { _ in (401, Data(#"{"error":{"code":"invalid_ticket","message":"Invalid ticket","details":{}}}"#.utf8)) }
        do {
            _ = try await client.ssoExchange(ticket: "tk", verifier: "v", device: DeviceInfo(platform: "ios", deviceName: nil, appVersion: nil))
            XCTFail("expected failure")
        } catch {
            XCTAssertEqual(ErrorMessages.text(for: error), "ログインの手続きが無効か、期限が切れています。もう一度「Google でログイン」からやり直してください")
        }
    }

    func testUserMeWithoutHasPasswordHasOne() throws {
        let old = Data(#"{"id":"u","username":"alice","display_name":"Alice","role":"member","deactivated_at":null,"created_at":"","updated_at":"","email":null,"must_change_password":false}"#.utf8)
        let me = try JSON.snakeDecoder.decode(UserMe.self, from: old)
        XCTAssertNil(me.hasPassword)
        XCTAssertTrue(me.passwordSet)
        let sso = Data(#"{"id":"u","username":"alice","display_name":"Alice","role":"member","deactivated_at":null,"created_at":"","updated_at":"","email":null,"must_change_password":false,"has_password":false}"#.utf8)
        XCTAssertFalse(try JSON.snakeDecoder.decode(UserMe.self, from: sso).passwordSet)
    }

    // MARK: screens

    private func render<V: View>(_ view: V, size: CGSize, name: String) throws -> UIImage {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        let window = scene.map { UIWindow(windowScene: $0) } ?? UIWindow(frame: CGRect(origin: .zero, size: size))
        window.frame = CGRect(origin: .zero, size: size)
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

    func testLoginScreenOffersGoogleWhenTheServerDoes() throws {
        let controller = AppController(defaults: UserDefaults(suiteName: "sso-snapshot-\(UUID().uuidString)")!)
        var asked: [String] = []
        _ = try render(LoginView(controller: controller, offersGoogle: { asked.append($0); return true }),
                       size: CGSize(width: 393, height: 852), name: "M48-login-google-ios.png")
        XCTAssertEqual(asked, ["http://127.0.0.1:8000"])
    }

    func testAccountSettingsWithoutPasswordHideTheChangeAnd2FA() throws {
        let controller = AppController(defaults: UserDefaults(suiteName: "sso-snapshot-\(UUID().uuidString)")!)
        controller.me = UserMe(id: "u", username: "taro", displayName: "山田 太郎", role: "member", deactivatedAt: nil, createdAt: "", updatedAt: "",
                               email: "taro@example.ac.jp", mustChangePassword: false, hasPassword: false)
        _ = try render(NavigationStack { AccountView(controller: controller) }, size: CGSize(width: 393, height: 600), name: "M48-account-ios.png")
    }
}
