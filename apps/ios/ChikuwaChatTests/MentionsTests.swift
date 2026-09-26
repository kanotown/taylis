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
}
