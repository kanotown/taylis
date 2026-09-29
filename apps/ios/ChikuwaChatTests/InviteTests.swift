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

    /// L7: an invite's lab preset in words on the acceptance screen.
    func testDescribesTheLabPreset() {
        XCTAssertEqual(Invite.labLine(InviteLabPreview(affiliation: "student", grade: "B4", supervisorName: "加納", times: true)),
                       "研究室の名簿に 学生 (B4)・指導教員 加納 として載ります。times を作ります。")
        XCTAssertEqual(Invite.labLine(InviteLabPreview(affiliation: "faculty", rank: "professor")), "研究室の名簿に 教授 として載ります。")
        XCTAssertEqual(Invite.labLine(InviteLabPreview(affiliation: "other")), "研究室の名簿に その他 として載ります。")
    }
}
