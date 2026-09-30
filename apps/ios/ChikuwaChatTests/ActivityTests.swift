import XCTest
@testable import ChikuwaChat

/// M39: the activity (MOBILE_UI.md §6.4 stage B, §7.2) — parsing, the badge, the dots, the read position and what
/// fetches the badge again (the same rules as the web's tests/activity.test.ts).
@MainActor
final class ActivityTests: XCTestCase {
    // MARK: parsing

    private func bootstrapJson(me extraMe: String = "", _ extra: String = "") -> Data {
        Data("""
        {"server_time": "2026-09-30T00:00:00Z",
         "me": {"id": "u1", "username": "kano", "display_name": "加納", "role": "member", "deactivated_at": null, "created_at": "",
                "updated_at": "", "email": null, "must_change_password": false\(extraMe)},
         "users": [], "channels": [],
         "limits": {"max_message_length": 20000, "max_attachment_bytes": 1, "max_attachments_per_message": 10}\(extra)}
        """.utf8)
    }

    private static let messageJson = """
    {"id": "m1", "channel_id": "c1", "sender_id": "u1", "seq": 5, "updated_seq": 7, "client_msg_id": "k", "body": "スライド v2 です",
     "created_at": "2026-09-30T01:00:00.123456Z", "edited_at": null, "deleted": false}
    """

    func testBootstrapWithAndWithoutTheActivityFields() throws {
        // A server before M39: no summary (stage A stays) and no reaction setting (the switch is hidden).
        let older = try JSON.snakeDecoder.decode(BootstrapOut.self, from: bootstrapJson())
        XCTAssertNil(older.activity)
        XCTAssertNil(older.me.notifyReactions)
        XCTAssertFalse(older.me.reactionBanners)

        let current = try JSON.snakeDecoder.decode(BootstrapOut.self, from: bootstrapJson(
            me: #", "notify_reactions": true"#,
            #", "activity": {"read_at": "2026-09-30T02:08:30.487484Z", "unread_count": 3, "mention_unread": true}"#))
        XCTAssertEqual(current.activity, ActivitySummary(readAt: "2026-09-30T02:08:30.487484Z", unreadCount: 3, mentionUnread: true))
        XCTAssertEqual(current.me.notifyReactions, true)
        XCTAssertTrue(current.me.reactionBanners)
    }

    func testActivityPageDecodesEveryKindWithAndWithoutEmojis() throws {
        let json = """
        {"items": [
          {"kind": "reaction", "at": "2026-09-30T02:00:00.5Z", "message": \(Self.messageJson), "actor_ids": ["u2", "u3", "u4"], "emojis": ["👍", ":party:"]},
          {"kind": "thread_reply", "at": "2026-09-30T01:30:00Z", "message": \(Self.messageJson), "actor_ids": ["u2"], "emojis": []},
          {"kind": "mention", "at": "2026-09-30T01:00:00Z", "message": \(Self.messageJson), "actor_ids": ["u2"]}
         ], "next_cursor": "2026-09-30T01:00:00Z", "read_at": "2026-09-30T00:00:00Z"}
        """
        let page = try JSON.snakeDecoder.decode(ActivityListOut.self, from: Data(json.utf8))
        XCTAssertEqual(page.items.map(\.kind), ["reaction", "thread_reply", "mention"])
        XCTAssertEqual(page.items[0].actorIds, ["u2", "u3", "u4"])
        XCTAssertEqual(page.items[0].emojis, ["👍", ":party:"])
        XCTAssertEqual(page.items[2].emojis, []) // absent: none
        XCTAssertEqual(page.items[0].id, "reaction:m1")
        XCTAssertEqual(page.items[0].message.body, "スライド v2 です")
        XCTAssertEqual(page.nextCursor, "2026-09-30T01:00:00Z")
        XCTAssertEqual(page.readAt, "2026-09-30T00:00:00Z")

        let last = try JSON.snakeDecoder.decode(ActivityListOut.self, from: Data(#"{"items": [], "next_cursor": null, "read_at": "2026-09-30T00:00:00Z"}"#.utf8))
        XCTAssertNil(last.nextCursor)
    }

    func testAReactionPushOpensItsMessage() {
        let reaction = PushPayload(userInfo: ["aps": ["alert": ["title": "佐藤 がリアクションしました", "body": "👍 「スライド」"], "badge": 2],
                                              "kind": "reaction", "workspace_id": "w", "channel_id": "c1", "message_id": "m1"])
        XCTAssertEqual(reaction, PushPayload(workspaceId: "w", channelId: "c1", messageId: "m1", badge: 2, kind: "reaction"))
        XCTAssertTrue(reaction.opensMessage)
        // A message push opens its conversation (and a reply's thread) as before; a reaction without its message too.
        XCTAssertFalse(PushPayload(userInfo: ["kind": "message", "channel_id": "c1", "message_id": "m1"]).opensMessage)
        XCTAssertFalse(PushPayload(userInfo: ["channel_id": "c1", "message_id": "m1"]).opensMessage)
        XCTAssertFalse(PushPayload(userInfo: ["kind": "reaction", "channel_id": "c1"]).opensMessage)
    }

    // MARK: the badge

    func testTheBadgeIsTheUnreadItemsRedWithAMention() {
        let none = ThreadSummary(unreadCount: 4, mentionCount: 1)
        func badge(_ summary: ActivitySummary?) -> (Int, Bool) {
            let result = TabBadges.activity([], threads: none, activity: summary)
            return (result.count, result.mention)
        }
        XCTAssertTrue(badge(ActivitySummary(readAt: "2026-09-30T00:00:00Z", unreadCount: 3, mentionUnread: true)) == (3, true))
        XCTAssertTrue(badge(ActivitySummary(readAt: "2026-09-30T00:00:00Z", unreadCount: 3, mentionUnread: false)) == (3, false))
        XCTAssertTrue(badge(ActivitySummary(readAt: "2026-09-30T00:00:00Z", unreadCount: 0, mentionUnread: true)) == (0, false))
        // No summary (a server before M39): stage A's rule, the followed threads here.
        XCTAssertTrue(badge(nil) == (4, true))
    }

    // MARK: the dots and the read position

    private func item(_ kind: String, at: String, id: String = "m1", actors: [String] = ["u2"], emojis: [String] = []) -> ActivityItem {
        ActivityItem(kind: kind, at: at, message: MessageOut(id: id, channelId: "c1", senderId: "u1", seq: 1, updatedSeq: 1, clientMsgId: nil, body: "b",
                                                             createdAt: at, editedAt: nil, deleted: false),
                     actorIds: actors, emojis: emojis)
    }

    func testADotIsAnItemAfterTheReadPosition() {
        let readAt = "2026-09-30T02:08:12.606353Z"
        XCTAssertTrue(ActivityRules.isUnread(item("mention", at: "2026-09-30T02:08:12.638620Z"), readAt: readAt))
        XCTAssertFalse(ActivityRules.isUnread(item("mention", at: readAt), readAt: readAt)) // at the position: read
        XCTAssertFalse(ActivityRules.isUnread(item("mention", at: "2026-09-30T02:08:12.606352Z"), readAt: readAt))
        XCTAssertTrue(ActivityRules.isUnread(item("mention", at: "2026-09-30T03:00:00Z"), readAt: "2026-09-30T02:59:59.999+00:00"))
        XCTAssertFalse(ActivityRules.isUnread(item("mention", at: "2026-09-30T03:00:00Z"), readAt: nil)) // no position: no dots
    }

    func testBeingOnScreenReadsUpToTheNewestRowOnlyOnAll() {
        let rows = [item("mention", at: "2026-09-30T01:00:00Z", id: "a"), item("reaction", at: "2026-09-30T03:00:00.25Z", id: "b"),
                    item("thread_reply", at: "2026-09-30T02:00:00Z", id: "c")]
        XCTAssertEqual(ActivityRules.newest(rows), "2026-09-30T03:00:00.25Z")
        XCTAssertNil(ActivityRules.newest([]))
        XCTAssertTrue(ActivityRules.moves("2026-09-30T03:00:00.25Z", readAt: "2026-09-30T03:00:00Z"))
        XCTAssertFalse(ActivityRules.moves("2026-09-30T03:00:00Z", readAt: "2026-09-30T03:00:00Z"))
        XCTAssertFalse(ActivityRules.moves(nil, readAt: nil))
        XCTAssertTrue(ActivityRules.moves("2026-09-30T03:00:00Z", readAt: nil))
        // One position covers every kind: a filtered list must not read what the others hold unseen.
        XCTAssertEqual(ActivityRules.filters.filter { ActivityRules.readsOnScreen(filter: $0) }, ["all"])
    }

    func testTheReadPositionOnlyMovesForward() {
        let store = Store()
        let first = ActivitySummary(readAt: "2026-09-30T02:00:00Z", unreadCount: 3, mentionUnread: true)
        store.setActivity(first)
        // A GET answered after a newer PUT: stale, dropped.
        store.setActivity(ActivitySummary(readAt: "2026-09-30T01:59:59.999999Z", unreadCount: 5, mentionUnread: true))
        XCTAssertEqual(store.activity, first)
        // The same position with new activity: taken.
        let more = ActivitySummary(readAt: "2026-09-30T02:00:00Z", unreadCount: 4, mentionUnread: true)
        store.setActivity(more)
        XCTAssertEqual(store.activity, more)
        // activity.read from another device moves the position (the count follows with the next summary) …
        store.advanceActivityRead("2026-09-30T02:30:00Z")
        XCTAssertEqual(store.activity?.readAt, "2026-09-30T02:30:00Z")
        XCTAssertEqual(store.activity?.unreadCount, 4)
        // … but never back.
        store.advanceActivityRead("2026-09-30T02:10:00Z")
        XCTAssertEqual(store.activity?.readAt, "2026-09-30T02:30:00Z")
        // Kept with `me` (an offline start shows the last badge).
        XCTAssertEqual(Store.fromSnapshot(store.snapshot()).activity, store.activity)
        // A bootstrap without it (a server before M39): stage A again.
        store.setActivity(nil)
        XCTAssertNil(store.activity)
        store.advanceActivityRead("2026-09-30T03:00:00Z")
        XCTAssertNil(store.activity)
    }

    // MARK: rows

    func testPagesDoNotListARowTwiceAndSkipUnknownKinds() {
        let held = [item("mention", at: "2026-09-30T03:00:00Z", id: "a"), item("reaction", at: "2026-09-30T02:00:00Z", id: "b")]
        let page = [item("reaction", at: "2026-09-30T02:00:00Z", id: "b"), item("reaction", at: "2026-09-30T01:00:00Z", id: "a"),
                    item("poll_vote", at: "2026-09-30T00:30:00Z", id: "c"), item("thread_reply", at: "2026-09-30T00:00:00Z", id: "d")]
        XCTAssertEqual(ActivityRules.append(held, page).map(\.id), ["mention:a", "reaction:b", "reaction:a", "thread_reply:d"])
    }

    func testHeadlines() {
        let names = ["u2": "山田", "u3": "佐藤", "u4": "鈴木"]
        let nameOf: (String) -> String = { names[$0] ?? "メンバー" }
        XCTAssertEqual(ActivityRules.headlineText(item("mention", at: "2026-09-30T00:00:00Z"), nameOf: nameOf), "山田 がメンション")
        XCTAssertEqual(ActivityRules.headlineText(item("thread_reply", at: "2026-09-30T00:00:00Z"), nameOf: nameOf), "山田 がスレッドに返信")
        XCTAssertEqual(ActivityRules.headlineText(item("reaction", at: "2026-09-30T00:00:00Z", emojis: ["👍"]), nameOf: nameOf), "山田 が 👍")
        let several = item("reaction", at: "2026-09-30T00:00:00Z", actors: ["u3", "u2", "u4"], emojis: ["👍", "🎉"])
        XCTAssertTrue(ActivityRules.headline(several, nameOf: nameOf) == ("佐藤 ほか 2 人", "が"))
        XCTAssertEqual(ActivityRules.headlineText(several, nameOf: nameOf), "佐藤 ほか 2 人が 👍🎉")
        XCTAssertEqual(ActivityRules.whereText(item("thread_reply", at: "2026-09-30T00:00:00Z"), conversation: "#輪講"), "#輪講 のスレッド")
        XCTAssertEqual(ActivityRules.whereText(item("mention", at: "2026-09-30T00:00:00Z"), conversation: "#輪講"), "#輪講")
        XCTAssertEqual(ActivityRules.filters.map(ActivityRules.filterLabel), ["すべて", "メンション", "スレッド", "リアクション"])
        XCTAssertEqual(ActivityRules.emptyText("reactions"), "自分の投稿へのリアクションはまだありません")
    }

    // MARK: what fetches the badge again

    private func me(keywords: [String]? = nil) -> UserMe {
        UserMe(id: "me", username: "me", displayName: "Me", role: "member", deactivatedAt: nil, createdAt: "", updatedAt: "", email: nil,
               mustChangePassword: false, notifyKeywords: keywords)
    }

    private func message(from sender: String, body: String = "hi", mentions: [String] = [], all: Bool = false, parent: String? = nil) -> MessageOut {
        MessageOut(id: "x", channelId: "c1", senderId: sender, seq: 1, updatedSeq: 1, clientMsgId: nil, body: body, createdAt: "", editedAt: nil,
                   deleted: false, mentionedUserIds: mentions, mentionAll: all, parentId: parent)
    }

    func testANewMessageFetchesTheBadgeWhenItIsActivityOfMine() {
        let me = me(keywords: ["輪講"])
        let followers = ParentThread(id: "p", replyCount: 2, lastReplyAt: nil, updatedSeq: 3, participantIds: ["a", "me"])
        let others = ParentThread(id: "p", replyCount: 2, lastReplyAt: nil, updatedSeq: 3, participantIds: ["a"])
        func refreshes(_ message: MessageOut, thread: ParentThread? = nil, followed: Bool = false) -> Bool {
            ActivityRules.refreshesBadge(on: message, me: me, thread: thread, followed: followed)
        }
        XCTAssertTrue(refreshes(message(from: "a", mentions: ["me"])))
        XCTAssertTrue(refreshes(message(from: "a", all: true)))
        XCTAssertTrue(refreshes(message(from: "a", body: "明日の輪講")))  // a keyword of mine
        XCTAssertTrue(refreshes(message(from: "a", parent: "p"), thread: followers))
        XCTAssertTrue(refreshes(message(from: "a", parent: "p"), thread: others, followed: true)) // my thread row says so
        XCTAssertFalse(refreshes(message(from: "a", parent: "p"), thread: others))
        XCTAssertFalse(refreshes(message(from: "a")))
        XCTAssertFalse(refreshes(message(from: "me", mentions: ["me"])))                  // my own
        XCTAssertFalse(refreshes(message(from: "me", parent: "p"), thread: followers))
        XCTAssertFalse(ActivityRules.refreshesBadge(on: message(from: "a", mentions: ["me"]), me: nil, thread: nil, followed: false))
    }

    // MARK: the engine

    private struct World {
        let server: FakeServer
        let alice: UserPublic
        let bob: UserPublic
        let channel: ChannelOut
        let store: Store
        let engine: SyncEngine
        let api: FakeServer.Api
    }

    private func makeWorld(activity: Bool = true) -> World {
        let server = FakeServer()
        let alice = server.addUser("alice")
        let bob = server.addUser("bob")
        let channel = server.createChannel("general", ownerId: alice.id)
        server.join(channel.id, bob.id)
        if activity { server.activity[bob.id] = ActivitySummary(readAt: "2026-09-30T00:00:00Z", unreadCount: 0, mentionUnread: false) }
        let store = Store()
        var options = EngineOptions()
        options.reconnectMin = 0
        options.sleep = { _ in }
        options.random = { 0.5 }
        let api = server.api(for: bob.id)
        let engine = SyncEngine(api: api, connect: server.connector(for: bob.id), wsUrl: URL(string: "ws://fake")!, store: store,
                                getAccessToken: { "token" }, options: options)
        engine.isActive = { false }
        return World(server: server, alice: alice, bob: bob, channel: channel, store: store, engine: engine, api: api)
    }

    private func settle(_ engine: SyncEngine) async {
        for _ in 0..<50 {
            await engine.idle()
            await Task.yield()
        }
        await engine.flushActivity()
    }

    private func summaryCalls(_ api: FakeServer.Api) -> Int { api.calls.filter { $0 == "activitySummary" }.count }

    func testTheBadgeFollowsReactionsMentionsAndFollowedReplies() async throws {
        let w = makeWorld()
        await w.engine.start()
        await settle(w.engine)
        XCTAssertEqual(w.store.activity?.unreadCount, 0)
        XCTAssertEqual(summaryCalls(w.api), 0)

        // reaction.added: the server's count, fetched again.
        let mine = try w.server.post(channelId: w.channel.id, senderId: w.bob.id, body: "スライド v2 です").0
        await settle(w.engine)
        XCTAssertEqual(summaryCalls(w.api), 0) // my own post is no activity of mine
        w.server.activity[w.bob.id]?.unreadCount = 1
        w.server.emitReactionAdded(to: w.bob.id, channelId: w.channel.id, messageId: mine.id, by: w.alice.id, emoji: "👍")
        await settle(w.engine)
        XCTAssertEqual(summaryCalls(w.api), 1)
        XCTAssertEqual(w.store.activity?.unreadCount, 1)
        XCTAssertEqual(w.store.activity?.mentionUnread, false)

        // A message that is not activity of mine fetches nothing; a mention does.
        try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "おはよう")
        await settle(w.engine)
        XCTAssertEqual(summaryCalls(w.api), 1)
        w.server.activity[w.bob.id] = ActivitySummary(readAt: "2026-09-30T00:00:00Z", unreadCount: 2, mentionUnread: true)
        try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "<@\(w.bob.id)> 見てください")
        await settle(w.engine)
        XCTAssertEqual(summaryCalls(w.api), 2)
        XCTAssertEqual(w.store.activity, ActivitySummary(readAt: "2026-09-30T00:00:00Z", unreadCount: 2, mentionUnread: true))

        // Someone's reply in my thread (I follow it: its author).
        try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "返信です", parentId: mine.id)
        await settle(w.engine)
        XCTAssertEqual(summaryCalls(w.api), 3)

        // Read on another device: activity.read moves the position at once, and the count follows.
        _ = try w.server.markActivityRead(w.bob.id, readAt: "2026-09-30T05:00:00Z")
        await settle(w.engine)
        XCTAssertEqual(summaryCalls(w.api), 4)
        XCTAssertEqual(w.store.activity, ActivitySummary(readAt: "2026-09-30T05:00:00Z", unreadCount: 0, mentionUnread: false))
        w.engine.stop()
    }

    func testMarkingReadTakesTheServersAnswer() async throws {
        let w = makeWorld()
        w.server.activity[w.bob.id] = ActivitySummary(readAt: "2026-09-30T00:00:00Z", unreadCount: 7, mentionUnread: true)
        await w.engine.start()
        await settle(w.engine)
        XCTAssertEqual(w.store.activity?.unreadCount, 7)
        try await w.engine.markActivityRead("2026-09-30T06:00:00.123456Z")
        XCTAssertEqual(w.store.activity, ActivitySummary(readAt: "2026-09-30T06:00:00.123456Z", unreadCount: 0, mentionUnread: false))
        // The server only moves forward: an older position answers with the one held.
        try await w.engine.markActivityRead("2026-09-30T01:00:00Z")
        XCTAssertEqual(w.store.activity?.readAt, "2026-09-30T06:00:00.123456Z")
        await settle(w.engine)
        w.engine.stop()
    }

    func testAServerBeforeM39KeepsStageA() async throws {
        let w = makeWorld(activity: false)
        await w.engine.start()
        await settle(w.engine)
        XCTAssertNil(w.store.activity)
        let mine = try w.server.post(channelId: w.channel.id, senderId: w.bob.id, body: "mine").0
        try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "<@\(w.bob.id)> hi")
        w.server.emitReactionAdded(to: w.bob.id, channelId: w.channel.id, messageId: mine.id, by: w.alice.id, emoji: "👍")
        await settle(w.engine)
        XCTAssertEqual(summaryCalls(w.api), 0)
        XCTAssertNil(w.store.activity)
        w.engine.stop()
    }
}
