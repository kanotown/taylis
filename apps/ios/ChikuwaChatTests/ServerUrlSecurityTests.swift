import XCTest
@testable import ChikuwaChat

/// M190 (SECURITY.md §6.1): the server URL classes against apps/shared/server-url-security.json (through the login
/// form's normalization), and the confirmation the login form, the Google button and an invite link go through: asked
/// for plain HTTP to a server on the internet, not for https or a LAN server, and never remembered.
@MainActor
final class ServerUrlSecurityTests: XCTestCase {
    private struct Fixture: Decodable {
        struct Input: Decodable { let name: String; let input: String; let expect: String }
        struct Host: Decodable { let host: String; let expect: String }
        let inputs: [Input]
        let hosts: [Host]
    }

    private func fixture() throws -> Fixture {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("shared/server-url-security.json")
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }

    func testTheSharedInputs() throws {
        let cases = try fixture().inputs
        XCTAssertGreaterThan(cases.count, 30)
        for item in cases {
            let normalized = Workspaces.normalize(item.input)
            if item.expect == "invalid" {
                XCTAssertNil(normalized, item.name)
                continue
            }
            guard let normalized else {
                XCTFail("\(item.name): \(item.input) was refused")
                continue
            }
            XCTAssertEqual(ServerUrlSecurity.classify(normalized).rawValue, item.expect, "\(item.name): \(item.input) → \(normalized)")
        }
    }

    func testTheSharedHosts() throws {
        let cases = try fixture().hosts
        XCTAssertGreaterThan(cases.count, 30)
        for item in cases {
            XCTAssertEqual(ServerUrlSecurity.classify(host: item.host).rawValue, item.expect, item.host)
        }
    }

    func testTheHttpsVariantAndAnInviteLinksServer() {
        XCTAssertEqual(ServerUrlSecurity.https("http://chat.example.com:8080/taylis"), "https://chat.example.com:8080/taylis")
        XCTAssertEqual(ServerUrlSecurity.https("HTTP://chat.example.com"), "https://chat.example.com")
        XCTAssertEqual(ServerUrlSecurity.https("https://chat.example.com"), "https://chat.example.com")
        let token = "Zy9_-abcdefghijklmnopqrstuvwxyz0123456789ABC"
        let link = Invite.parse("http://chat.example.com:8000/invite/\(token)")!
        XCTAssertEqual(ServerUrlSecurity.classify(link.server.absoluteString), .insecure)
        XCTAssertEqual(ServerUrlSecurity.classify(Invite.parse("http://192.168.1.10:8000/invite/\(token)")!.server.absoluteString), .local)
        XCTAssertEqual(ServerUrlSecurity.classify("not a url"), .insecure)
    }

    // MARK: the confirmation (LoginView, InviteView)

    func testHttpAcrossTheInternetWaitsForTheChoice() throws {
        let prompt = InsecureServerPrompt()
        var signedIn: [String] = []
        prompt.check("http://Chat.Example.com:8080/") { signedIn.append($0) }
        let request = try XCTUnwrap(prompt.pending, "the alert is shown")
        XCTAssertEqual(request.url, "http://chat.example.com:8080")
        XCTAssertEqual(signedIn, [], "nothing goes to the server before the choice")

        prompt.useHttps(request)
        XCTAssertNil(prompt.pending)
        XCTAssertEqual(signedIn, ["https://chat.example.com:8080"])

        // Not remembered: the next sign-in asks again; 「このまま接続」 goes on with the address as typed.
        prompt.check("http://Chat.Example.com:8080/") { signedIn.append($0) }
        prompt.continueAnyway(try XCTUnwrap(prompt.pending))
        XCTAssertEqual(signedIn, ["https://chat.example.com:8080", "http://Chat.Example.com:8080/"])

        // 「キャンセル」: nothing.
        prompt.check("http://203.0.113.5") { signedIn.append($0) }
        XCTAssertNotNil(prompt.pending)
        prompt.cancel()
        XCTAssertNil(prompt.pending)
        XCTAssertEqual(signedIn.count, 2)
    }

    func testHttpsAndLanServersAreNotAsked() {
        let prompt = InsecureServerPrompt()
        for server in ["http://192.168.1.10:8000", "http://localhost:8000", "http://taylis:8000", "http://100.101.102.103", "https://chat.example.com",
                       "chat.example.com", "", "http://user@chat.example.com"] {
            var signedIn: [String] = []
            prompt.check(server) { signedIn.append($0) }
            XCTAssertNil(prompt.pending, server)
            XCTAssertEqual(signedIn, [server], server)
        }
    }
}
