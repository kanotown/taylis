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

    /// A tapped mention names its person (the row's openURL handler reads the host).
    func testUserLinkCarriesTheId() {
        let url = UserLink.internalLink(userId: alice.id)
        XCTAssertEqual(url?.scheme, UserLink.scheme)
        XCTAssertEqual(url?.host, alice.id)
    }

    /// AI.md §2.1 (2026-10-06): people and AI bots only; once /ai/status was read, only the AI bots it lists.
    func testSuggestionsLeaveOutBotsButAi() {
        func bot(_ id: String, _ username: String, kind: String?, gone: Bool = false) -> UserPublic {
            var user = UserPublic(id: id, username: username, displayName: username, role: "bot", deactivatedAt: gone ? "2026-10-01T00:00:00Z" : nil,
                                  createdAt: "", updatedAt: "")
            user.botKind = kind
            return user
        }
        let ai = bot("u-ai", "ai-chikuwa", kind: "ai")
        let stopped = bot("u-ai2", "ai-old", kind: "ai")
        let feed = bot("u-feed", "feed-news", kind: "feed")
        let hook = bot("u-hook", "hook", kind: nil)
        let reservation = bot("u-res", "reserve", kind: "reservation")
        let gone = bot("u-ai3", "ai-gone", kind: "ai", gone: true)
        let left = UserPublic(id: "u-left", username: "carol", displayName: "Carol", role: "member", deactivatedAt: "2026-10-01T00:00:00Z", createdAt: "", updatedAt: "")
        let everyone = users + [ai, stopped, feed, hook, reservation, gone, left]
        let names = { (ids: Set<String>?) in Mentions.candidates("", users: everyone, aiBotIds: ids, limit: 20).map(\.username) }
        // Before /ai/status: bot_kind decides.
        XCTAssertEqual(names(nil), ["ai-chikuwa", "ai-old", "alice", "bob.k", "channel", "here"])
        // Read: only the agents it lists (a stopped one drops out), marked as AI.
        XCTAssertEqual(names(["u-ai"]), ["ai-chikuwa", "alice", "bob.k", "channel", "here"])
        XCTAssertEqual(Mentions.candidates("ai", users: everyone, aiBotIds: ["u-ai"]).map(\.kind), ["ai"])
        // A server without AI (404): no bots at all.
        XCTAssertEqual(names([]), ["alice", "bob.k", "channel", "here"])
        // A server before bot_kind "ai": the agents still come once the status is read.
        XCTAssertEqual(Mentions.candidates("hook", users: everyone, aiBotIds: ["u-hook"]).map(\.kind), ["ai"])
    }
}

/// MOBILE_UI.md §23: the order of the @ suggestions against apps/shared/mention-rank.json (the desktop and Android read
/// the same file).
final class MentionRankTests: XCTestCase {
    private struct Vectors: Decodable {
        struct Spoken: Decodable {
            let senderId: String, deleted: Bool?, type: String?
            enum CodingKeys: String, CodingKey { case senderId = "sender_id", deleted, type }
        }
        struct Recent: Decodable { let name: String; let cap: Int?; let thread: [Spoken]; let channel: [Spoken]; let speakers: [String] }
        struct User: Decodable {
            let id: String, username: String, displayName: String, ai: Bool?, bot: Bool?, deactivated: Bool?
            enum CodingKeys: String, CodingKey { case id, username, displayName = "display_name", ai, bot, deactivated }
        }
        struct Group: Decodable {
            let id: String, name: String, description: String?, memberIds: [String]
            enum CodingKeys: String, CodingKey { case id, name, description, memberIds = "member_ids" }
        }
        struct Case: Decodable { let name: String; let query: String; let me: String?; let recent: [String]; let members: [String]; let limit: Int; let expected: [String] }
        struct Rank: Decodable { let users: [User]; let groups: [Group]; let cases: [Case] }
        let recentMessages: Int
        let recent: [Recent]
        let rank: Rank
        enum CodingKeys: String, CodingKey { case recentMessages = "recent_messages", recent, rank }
    }

    private func vectors() throws -> Vectors {
        // The repository's own file (the simulator reads the Mac's disk).
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("shared/mention-rank.json")
        return try JSONDecoder().decode(Vectors.self, from: Data(contentsOf: url))
    }

    func testSharedRecentVectors() throws {
        let vectors = try vectors()
        XCTAssertEqual(Mentions.recentMessages, vectors.recentMessages)
        XCTAssertFalse(vectors.recent.isEmpty)
        let spoken = { (m: Vectors.Spoken) in Mentions.Spoken(senderId: m.senderId, deleted: m.deleted ?? false, type: m.type ?? "user") }
        for c in vectors.recent {
            XCTAssertEqual(Mentions.recentSpeakers(channel: c.channel.map(spoken), thread: c.thread.map(spoken), cap: c.cap ?? vectors.recentMessages),
                           c.speakers, c.name)
        }
    }

    func testSharedRankVectors() throws {
        let rank = try vectors().rank
        let users = rank.users.map { u in
            var user = UserPublic(id: u.id, username: u.username, displayName: u.displayName, role: u.ai == true || u.bot == true ? "bot" : "member",
                                  deactivatedAt: u.deactivated == true ? "2026-01-01T00:00:00Z" : nil, createdAt: "", updatedAt: "")
            user.botKind = u.ai == true ? "ai" : nil
            return user
        }
        let groups = rank.groups.map {
            GroupOut(id: $0.id, name: $0.name, description: $0.description, memberIds: $0.memberIds, createdBy: "u1", createdAt: "", updatedAt: "")
        }
        XCTAssertFalse(rank.cases.isEmpty)
        for c in rank.cases {
            let context = Mentions.Context(recent: c.recent, members: c.members, me: c.me)
            XCTAssertEqual(Mentions.candidates(c.query, users: users, groups: groups, limit: c.limit, context: context).map(\.username), c.expected, c.name)
        }
    }
}

/// MOBILE_UI.md §23: a channel's members, read for the @ list, rank before the others; a failed read keeps the order.
@MainActor
final class MentionMembersTests: XCTestCase {
    private struct Offline: Error {}
    private func person(_ id: String, _ username: String) -> UserPublic {
        UserPublic(id: id, username: username, displayName: username, role: "member", deactivatedAt: nil, createdAt: "", updatedAt: "")
    }

    private func store(type: String = "public") -> Store {
        let store = Store()
        for user in [person("u1", "alice"), person("u2", "bob"), person("u3", "carol")] { store.upsertUser(user) }
        let out = ChannelOut(id: "c1", type: type, name: "general", topic: nil, purpose: nil, archived: false, createdBy: nil, lastSeq: 0,
                             lastMessageAt: nil, createdAt: "2026-01-01T00:00:00Z", updatedAt: "", membership: nil, dmUserIds: type == "public" ? nil : ["u1", "u3"])
        _ = store.upsertChannel(out, isMember: true)
        return store
    }

    private func names(_ store: Store) -> [String] {
        Mentions.candidates("", users: store.users.values, context: Mentions.context(store: store, channelId: "c1", parentId: nil)).map(\.username)
    }

    func testMembersComeBeforeTheOthersOnceRead() async {
        let store = store()
        XCTAssertEqual(names(store), ["alice", "bob", "carol", "channel", "here"])
        var reads = 0
        await Mentions.readMembers(store: store, channelId: "c1") { _ in reads += 1; return ["u3"] }
        XCTAssertEqual(names(store), ["carol", "alice", "bob", "channel", "here"])
        XCTAssertEqual(Mentions.documentContext(store: store, channelId: "c1").members, ["u3"]) // a channel canvas too
        // Held: not read again, until the members change or the read is old.
        await Mentions.readMembers(store: store, channelId: "c1") { _ in reads += 1; return [] }
        XCTAssertEqual(reads, 1)
        store.memberListVersion["c1", default: 0] += 1
        await Mentions.readMembers(store: store, channelId: "c1") { _ in reads += 1; return ["u2", "u3"] }
        XCTAssertEqual(reads, 2)
        XCTAssertEqual(names(store), ["bob", "carol", "alice", "channel", "here"])
        await Mentions.readMembers(store: store, channelId: "c1", now: Date().addingTimeInterval(Mentions.membersMaxAge + 1)) { _ in reads += 1; return ["u2"] }
        XCTAssertEqual(reads, 3)
    }

    func testAFailedReadKeepsTheOrder() async {
        let store = store()
        var reads = 0
        await Mentions.readMembers(store: store, channelId: "c1") { _ in reads += 1; throw Offline() }
        XCTAssertNil(store.mentionMembers["c1"]?.ids)
        XCTAssertEqual(names(store), ["alice", "bob", "carol", "channel", "here"])
        await Mentions.readMembers(store: store, channelId: "c1") { _ in reads += 1; throw Offline() }
        XCTAssertEqual(reads, 1, "not tried again at once")
        // Members held, then a failed read again: what was there stays.
        await Mentions.readMembers(store: store, channelId: "c1", now: Date().addingTimeInterval(Mentions.membersRetry + 1)) { _ in ["u3"] }
        store.memberListVersion["c1", default: 0] += 1
        await Mentions.readMembers(store: store, channelId: "c1", now: Date().addingTimeInterval(Mentions.membersRetry + 2)) { _ in throw Offline() }
        XCTAssertEqual(names(store), ["carol", "alice", "bob", "channel", "here"])
    }

    func testADmIsNotRead() async {
        let store = store(type: "dm")
        await Mentions.readMembers(store: store, channelId: "c1") { _ in XCTFail("read"); return [] }
        XCTAssertEqual(names(store), ["alice", "carol", "bob", "channel", "here"])
    }
}
