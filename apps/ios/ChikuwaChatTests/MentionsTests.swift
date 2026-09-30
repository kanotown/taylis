import XCTest
@testable import ChikuwaChat

final class MentionsTests: XCTestCase {
    func testJapaneseDisplayNameCompletionKeepsTheWireFormat() {
        let yamada = UserPublic(id: alice.id, username: "yamada", displayName: "山田 太郎", role: "member", deactivatedAt: nil, createdAt: "", updatedAt: "")
        let query = Mentions.query("確認 @山田")
        XCTAssertEqual(query, "山田")
        let candidate = Mentions.candidates(query ?? "", users: [yamada]).first!
        let completed = Mentions.complete("確認 @山田", username: candidate.username)
        XCTAssertEqual(completed, "確認 @yamada ")
        XCTAssertEqual(Mentions.encode(completed, users: [yamada]), "確認 <@\(yamada.id)> ")
        for name in ["やまだ", "ヤマダ", "か\u{3099}", "田中１"] { XCTAssertEqual(Mentions.query("@" + name), name) }
        for text in ["@山田 ", "@山田、", "mail@山田"] { XCTAssertNil(Mentions.query(text)) }
        XCTAssertEqual(Mentions.encode("@山田", users: [yamada]), "@山田")
    }
    private let alice = UserPublic(id: "00000000-0000-7000-8000-000000000001", username: "alice", displayName: "Alice", role: "member", deactivatedAt: nil, createdAt: "", updatedAt: "")
    private let bob = UserPublic(id: "00000000-0000-7000-8000-000000000002", username: "bob.k", displayName: "Bob K", role: "member", deactivatedAt: nil, createdAt: "", updatedAt: "")
    private var users: [UserPublic] { [alice, bob] }

    func testEncodesHandlesToTokens() {
        XCTAssertEqual(Mentions.encode("hi @bob.k and @channel, mail me@x.io @nobody", users: users), "hi <@\(bob.id)> and <!channel>, mail me@x.io @nobody")
        XCTAssertEqual(Mentions.encode("@Alice", users: users), "<@\(alice.id)>")
    }

    /// Right after Japanese text or punctuation too (M46 found 「まとめます。@android2」 left as text); an e-mail address and a
    /// saved token stay as they are.
    func testMentionsRightAfterJapaneseText() {
        XCTAssertEqual(Mentions.encode("まとめます。@bob.k", users: users), "まとめます。<@\(bob.id)>")
        XCTAssertEqual(Mentions.encode("田中さん@alice よろしく", users: users), "田中さん<@\(alice.id)> よろしく")
        XCTAssertEqual(Mentions.encode("alice@example.jp", users: users), "alice@example.jp")
        XCTAssertEqual(Mentions.encode("<@\(alice.id)>", users: users), "<@\(alice.id)>")
        XCTAssertEqual(Mentions.query("確認。@al"), "al")
    }

    func testDecodesTokensToHandles() {
        let byId = Dictionary(uniqueKeysWithValues: users.map { ($0.id, $0) })
        XCTAssertEqual(Mentions.decode("hi <@\(bob.id)> <!unknown> <!here>", users: byId), "hi @bob.k <!unknown> @here")
        XCTAssertEqual(Mentions.decode("<@00000000-0000-7000-8000-000000000009>", users: byId), "<@00000000-0000-7000-8000-000000000009>")
    }

    func testQueryCandidatesAndCompletion() {
        XCTAssertEqual(Mentions.query("hello @bo"), "bo")
        XCTAssertEqual(Mentions.query("@"), "")
        XCTAssertNil(Mentions.query("mail me@x"))
        XCTAssertNil(Mentions.query("done @bob "))
        XCTAssertEqual(Mentions.candidates("bo", users: users).map(\.username), ["bob.k"])
        XCTAssertEqual(Mentions.candidates("", users: users).map(\.username), ["alice", "bob.k", "channel", "here"])
        XCTAssertEqual(Mentions.complete("hello @bo", username: "bob.k"), "hello @bob.k ")
    }

    func testGroupMentionsEncodeDecodeAndSuggest() {
        let design = GroupOut(id: "00000000-0000-7000-8000-00000000000a", name: "design", description: "デザイン担当", memberIds: [alice.id, bob.id], createdBy: alice.id, createdAt: "", updatedAt: "")
        XCTAssertEqual(Mentions.encode("@design please, @alice too", users: users, groups: [design]), "<@group:\(design.id)> please, <@\(alice.id)> too")
        let byId = Dictionary(uniqueKeysWithValues: users.map { ($0.id, $0) })
        XCTAssertEqual(Mentions.decode("<@group:\(design.id)> hi", users: byId, groups: [design.id: design]), "@design hi")
        XCTAssertEqual(Mentions.toNames("<@group:\(design.id)> and <@group:00000000-0000-7000-8000-000000000009>", users: [:], groups: [design.id: design]), "@design and @グループ")
        let rows = Mentions.candidates("de", users: users, groups: [design])
        XCTAssertEqual(rows.map(\.username), ["design"])
        XCTAssertEqual(rows.first?.kind, "group")
        XCTAssertEqual(rows.first?.label, "グループ · 2 人 · デザイン担当")
        XCTAssertEqual(Mentions.candidates("", users: users, groups: [design]).map(\.username), ["alice", "bob.k", "design", "channel", "here"])
    }
}
