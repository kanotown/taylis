import XCTest
@testable import ChikuwaChat

/// M96: usernames can change — the screen's checks (the server's rules) and the saved workspace's sign-in name.
final class UsernameTests: XCTestCase {
    func testChecksAUsernameAsTheServerDoes() {
        XCTAssertNil(UsernameRules.problem("alice.k"))
        XCTAssertNil(UsernameRules.problem("a_b-c.9"))
        XCTAssertNil(UsernameRules.problem(" Alice "))  // sent as "alice"
        XCTAssertEqual(UsernameRules.normalize("  Alice.K "), "alice.k")
        XCTAssertEqual(UsernameRules.problem(""), "ユーザー名を入力してください")
        XCTAssertEqual(UsernameRules.problem("ab"), "3〜32 文字にしてください")
        XCTAssertEqual(UsernameRules.problem(String(repeating: "x", count: 33)), "3〜32 文字にしてください")
        XCTAssertEqual(UsernameRules.problem("has space"), "使えるのは a-z、0-9、. _ - だけです")
        XCTAssertEqual(UsernameRules.problem("かのうさん"), "使えるのは a-z、0-9、. _ - だけです")
        for reserved in ["here", "channel", "everyone", "all", "group", "deleted-0123abcd"] {
            XCTAssertEqual(UsernameRules.problem(reserved), "このユーザー名は予約されているため使えません", reserved)
        }
        XCTAssertTrue(UsernameRules.hint(hasPassword: true).contains("パスワードでのログインには新しいユーザー名を使います"))
        XCTAssertFalse(UsernameRules.hint(hasPassword: false).contains("パスワード"))
    }

    func testTheSavedWorkspaceShowsTheNewNameAndKeepsTheOldKey() throws {
        var entry = Workspace(serverUrl: "https://chat.example.com", username: "alice", userId: "u1")
        XCTAssertEqual(entry.signInName, "alice")
        entry.loginName = "alice.k"
        XCTAssertEqual(entry.signInName, "alice.k")
        // The Keychain item and the local database keep the name signed in with.
        XCTAssertEqual(entry.account, "https://chat.example.com|alice")
        let data = try JSONEncoder().encode([entry])
        XCTAssertEqual(try JSONDecoder().decode([Workspace].self, from: data), [entry])
        // A list saved before M96 has no loginName.
        let old = #"[{"serverUrl":"https://a.example.com","username":"a"}]"#
        XCTAssertNil(try JSONDecoder().decode([Workspace].self, from: Data(old.utf8))[0].loginName)
    }
}
