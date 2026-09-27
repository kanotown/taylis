import XCTest
@testable import ChikuwaChat

final class MentionsTests: XCTestCase {
    private let alice = UserPublic(id: "00000000-0000-7000-8000-000000000001", username: "alice", displayName: "Alice", role: "member", deactivatedAt: nil, createdAt: "", updatedAt: "")
    private let bob = UserPublic(id: "00000000-0000-7000-8000-000000000002", username: "bob.k", displayName: "Bob K", role: "member", deactivatedAt: nil, createdAt: "", updatedAt: "")
    private var users: [UserPublic] { [alice, bob] }

    func testEncodesHandlesToTokens() {
        XCTAssertEqual(Mentions.encode("hi @bob.k and @channel, mail me@x.io @nobody", users: users), "hi <@\(bob.id)> and <!channel>, mail me@x.io @nobody")
        XCTAssertEqual(Mentions.encode("@Alice", users: users), "<@\(alice.id)>")
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
