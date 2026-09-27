import XCTest
@testable import ChikuwaChat

final class InviteTests: XCTestCase {
    private let token = "Zy9_-abcdefghijklmnopqrstuvwxyz0123456789ABC"

    func testBuildsWithoutDoublingSlashes() {
        XCTAssertEqual(Invite.url(base: URL(string: "https://chat.example.com/")!, token: token), "https://chat.example.com/invite/\(token)")
        XCTAssertEqual(Invite.url(base: URL(string: "http://127.0.0.1:8000")!, token: token), "http://127.0.0.1:8000/invite/\(token)")
    }

    func testParsesAPastedLinkIntoServerAndToken() {
        let parsed = Invite.parse("  https://chat.example.com/invite/\(token)?utm=1 ")
        XCTAssertEqual(parsed?.server.absoluteString, "https://chat.example.com")
        XCTAssertEqual(parsed?.token, token)
        XCTAssertEqual(Invite.parse("http://127.0.0.1:8000/invite/\(token)/")?.server.absoluteString, "http://127.0.0.1:8000")
        XCTAssertNil(Invite.parse("https://chat.example.com/invite/short"))
        XCTAssertNil(Invite.parse("https://chat.example.com/m/\(token)"))
        XCTAssertNil(Invite.parse(token))
    }

    func testExplainsInviteFailuresInWords() {
        XCTAssertEqual(Invite.errorText(ApiError.api(status: 410, code: "invite_expired", message: "Invite is expired")), "この招待リンクは期限切れです")
        XCTAssertEqual(Invite.errorText(ApiError.api(status: 409, code: "username_taken", message: "taken")), "このユーザー名はすでに使われています")
        XCTAssertNil(Invite.errorText(ApiError.api(status: 500, code: "server_error", message: "boom")))
        XCTAssertNil(Invite.errorText(ApiError.network(URLError(.notConnectedToInternet))))
    }
}
