import XCTest
@testable import ChikuwaChat

/// M37: 移動・検索's matching rule against apps/shared/jump-match.json (the web, Android and the desktop's ⌘K read the
/// same file), and what the jump view and the ✏️ picker offer.
final class JumpMatchTests: XCTestCase {
    private struct Vectors: Decodable {
        struct Normalize: Decodable { let input: String; let output: String }
        struct Score: Decodable { let query: String; let names: [String]; let score: Int? }
        struct Item: Decodable { let id: String; let title: String; let names: [String]; let unread: Bool? }
        struct Case: Decodable { let query: String; let ids: [String] }
        struct Rank: Decodable { let items: [Item]; let cases: [Case] }
        struct PickUser: Decodable {
            let id: String, displayName: String, username: String, role: String, deactivated: Bool?, ai: Bool?
            enum CodingKeys: String, CodingKey { case id, displayName = "display_name", username, role, deactivated, ai }
        }
        struct PickCase: Decodable { let query: String; let people: [String]; let bots: [String] }
        struct Pick: Decodable { let users: [PickUser]; let cases: [PickCase] }
        let normalize: [Normalize]
        let score: [Score]
        let rank: Rank
        let pick: Pick
    }

    private func vectors() throws -> Vectors {
        // The repository's own file (the simulator reads the Mac's disk).
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("shared/jump-match.json")
        return try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
    }

    func testSharedVectors() throws {
        let vectors = try vectors()
        XCTAssertFalse(vectors.normalize.isEmpty)
        for c in vectors.normalize {
            XCTAssertEqual(JumpMatch.normalize(c.input), c.output, c.input)
        }
        XCTAssertFalse(vectors.score.isEmpty)
        for c in vectors.score {
            XCTAssertEqual(JumpMatch.score(c.query, names: c.names), c.score, "\(c.query) in \(c.names)")
        }
        let items = vectors.rank.items.map { JumpMatch.Item(id: $0.id, title: $0.title, names: $0.names, unread: $0.unread ?? false) }
        XCTAssertFalse(vectors.rank.cases.isEmpty)
        for c in vectors.rank.cases {
            XCTAssertEqual(JumpMatch.rank(c.query, items).map(\.id), c.ids, c.query)
        }
    }

    /// jump-match.json `pick`: a new DM's people, then only the AI bots (no webhook, feed or reservation bot).
    func testSharedPickVectors() throws {
        let pick = try vectors().pick
        XCTAssertFalse(pick.cases.isEmpty)
        let users = pick.users.map {
            UserPublic(id: $0.id, username: $0.username, displayName: $0.displayName, role: $0.role,
                       deactivatedAt: $0.deactivated == true ? "2026-01-01T00:00:00Z" : nil,
                       createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z")
        }
        let ai = Set(pick.users.filter { $0.ai == true }.map(\.id))
        for c in pick.cases {
            XCTAssertEqual(JumpMatch.destinationPeople(c.query, users: users, meId: nil), c.people, c.query)
            XCTAssertEqual(JumpMatch.bots(c.query, users: users, aiBotIds: ai), c.bots, c.query)
            if !c.query.isEmpty { XCTAssertEqual(JumpMatch.people(c.query, users: users), Array(c.people.prefix(10)), c.query) }
        }
    }

    func testIdeographicSpaceAndMiddleDotAreWordBoundaries() {
        XCTAssertEqual(JumpMatch.score("透", names: ["加納　透"]), 1)
        XCTAssertEqual(JumpMatch.score("ゼミ", names: ["研究室・ゼミ"]), 1)
        XCTAssertEqual(JumpMatch.score("ｾﾞﾐ", names: ["ゼミ連絡"]), 0) // half-width katakana
    }

    // MARK: what the lists offer

    private func user(_ id: String, _ name: String, deactivated: Bool = false) -> UserPublic {
        UserPublic(id: id, username: id, displayName: name, role: "member", deactivatedAt: deactivated ? "2026-01-01T00:00:00Z" : nil,
                   createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z")
    }

    private func channel(_ id: String, name: String? = nil, type: String = "public", member: Bool = true, archived: Bool = false,
                         dm: [String]? = nil, unread: Int = 0) -> ChannelState {
        let out = ChannelOut(id: id, type: type, name: name ?? (dm == nil ? id : nil), topic: nil, purpose: nil, archived: archived, createdBy: nil,
                             lastSeq: 0, lastMessageAt: nil, createdAt: "2026-01-01T00:00:00Z", updatedAt: "", membership: nil, dmUserIds: dm)
        return ChannelState(channel: out, isMember: member, syncedSeq: nil, lastSeq: 0, unreadCount: unread, hasOlder: true)
    }

    func testConversationsMatchChannelNamesAndPeopleInDMs() {
        let users = ["me": user("me", "加納"), "sato": user("sato", "佐藤 花子"), "gen": user("gen", "源")]
        let channels = [
            channel("general"),
            channel("gen-z", unread: 2),
            channel("old-gen", archived: true),
            channel("genki", member: false),
            channel("dm-sato", type: "dm", dm: ["me", "sato"]),
            channel("dm-gen", type: "dm", dm: ["me", "gen"]),
            channel("notes", type: "dm", dm: ["me"]),
        ]
        // Unread first among the same score, then the title in code-unit order; archived and not joined are left
        // out; a DM by the other's username.
        XCTAssertEqual(JumpMatch.conversations("gen", channels: channels, users: users, me: users["me"]), ["gen-z", "general", "dm-gen"])
        XCTAssertEqual(JumpMatch.conversations("花子", channels: channels, users: users, me: users["me"]), ["dm-sato"])
        // My DM with myself goes by my own name.
        XCTAssertEqual(JumpMatch.conversations("加納", channels: channels, users: users, me: users["me"]), ["notes"])
        XCTAssertEqual(JumpMatch.conversations("", channels: channels, users: users, me: users["me"]), [])
        XCTAssertEqual(JumpMatch.conversations("e", channels: channels, users: users, me: users["me"], limit: 2).count, 2)
    }

    func testPeopleLeaveOutTheDeactivated() {
        let users = [user("me", "加納"), user("kana", "カナ"), user("gone", "かなえ", deactivated: true)]
        XCTAssertEqual(JumpMatch.people("かな", users: users), ["kana"])
        XCTAssertEqual(JumpMatch.people("me", users: users), ["me"])
    }

    func testNewMessageDestinations() {
        let channels = [
            channel("zeta"), channel("alpha"), channel("beta", member: false), channel("secret", type: "private", member: false),
            channel("arch", archived: true), channel("dm", type: "dm", dm: ["me", "a"]),
        ]
        // Mine first, then the public ones to join; a guest joins nothing.
        XCTAssertEqual(JumpMatch.destinationChannels("", channels: channels), ["alpha", "zeta", "beta"])
        XCTAssertEqual(JumpMatch.destinationChannels("", channels: channels, joinable: false), ["alpha", "zeta"])
        XCTAssertEqual(JumpMatch.destinationChannels("ta", channels: channels), ["zeta", "beta"])
        let users = [user("b", "Bob"), user("me", "Me"), user("a", "Amy"), user("x", "Xavier", deactivated: true)]
        XCTAssertEqual(JumpMatch.destinationPeople("", users: users, meId: "me"), ["me", "a", "b"])
        XCTAssertEqual(JumpMatch.destinationPeople("b", users: users, meId: "me"), ["b"])
    }

    func testRecentConversationsNewestFirstTenAtMost() {
        let defaults = UserDefaults(suiteName: "JumpMatchTests")!
        defaults.removePersistentDomain(forName: "JumpMatchTests")
        let key = RecentConversations.key(account: "http://x|me")
        XCTAssertEqual(RecentConversations.read(key: key, defaults: defaults), [])
        RecentConversations.push("a", key: key, defaults: defaults)
        RecentConversations.push("b", key: key, defaults: defaults)
        XCTAssertEqual(RecentConversations.push("a", key: key, defaults: defaults), ["a", "b"])
        for index in 0..<12 { RecentConversations.push("c\(index)", key: key, defaults: defaults) }
        let list = RecentConversations.read(key: key, defaults: defaults)
        XCTAssertEqual(list.count, RecentConversations.limit)
        XCTAssertEqual(list.first, "c11")
        // Each workspace account has its own.
        XCTAssertEqual(RecentConversations.read(key: RecentConversations.key(account: "http://y|me"), defaults: defaults), [])
        defaults.removePersistentDomain(forName: "JumpMatchTests")
    }
}
