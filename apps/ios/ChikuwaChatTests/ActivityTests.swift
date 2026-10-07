import SwiftUI
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
        XCTAssertEqual(page.items[0].message?.body, "スライド v2 です")
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

    // MARK: read in the conversation (MOBILE_UI.md §6.4, 2026-10-06)

    private func conversationItem(_ kind: String, seq: Int, parent: String? = nil, alsoInChannel: Bool = false, read: Bool? = false) -> ActivityItem {
        var item = ActivityItem(kind: kind, at: "2026-10-06T10:00:00Z",
                                message: MessageOut(id: "m\(seq)", channelId: "c1", senderId: "u2", seq: seq, updatedSeq: seq, clientMsgId: nil, body: "b",
                                                    createdAt: "", editedAt: nil, deleted: false, parentId: parent, alsoInChannel: alsoInChannel),
                                actorIds: ["u2"])
        item.read = read
        return item
    }

    func testTheReadFlagDecodesAndIsOptional() throws {
        func page(_ read: String) throws -> ActivityItem {
            let json = """
            {"items": [{"kind": "mention", "at": "2026-09-30T01:00:00Z", "message": \(Self.messageJson), "actor_ids": ["u2"]\(read)}],
             "next_cursor": null, "read_at": "2026-09-30T00:00:00Z"}
            """
            return try XCTUnwrap(JSON.snakeDecoder.decode(ActivityListOut.self, from: Data(json.utf8)).items.first)
        }
        XCTAssertEqual(try page(#", "read": true"#).read, true)
        XCTAssertEqual(try page(#", "read": false"#).read, false)
        XCTAssertNil(try page(#", "read": null"#).read)
        XCTAssertNil(try page("").read) // a server before the rule
    }

    func testAMentionOrReplyIsReadOnceItsConversationsPositionCoversIt() {
        // A timeline row: the conversation's position.
        let top = conversationItem("mention", seq: 10)
        XCTAssertFalse(ActivityRules.conversationRead(top, channelReadSeq: 9, threadReadSeq: nil))
        XCTAssertTrue(ActivityRules.conversationRead(top, channelReadSeq: 10, threadReadSeq: nil))
        XCTAssertFalse(ActivityRules.conversationRead(top, channelReadSeq: nil, threadReadSeq: 99))
        // A reply only in its thread: the thread's position, not the conversation's.
        let reply = conversationItem("thread_reply", seq: 12, parent: "p")
        XCTAssertFalse(ActivityRules.conversationRead(reply, channelReadSeq: 50, threadReadSeq: 11))
        XCTAssertTrue(ActivityRules.conversationRead(reply, channelReadSeq: nil, threadReadSeq: 12))
        let mentionInThread = conversationItem("mention", seq: 12, parent: "p")
        XCTAssertTrue(ActivityRules.conversationRead(mentionInThread, channelReadSeq: 0, threadReadSeq: 30))
        // A reply also sent to the channel: either position.
        let both = conversationItem("thread_reply", seq: 20, parent: "p", alsoInChannel: true)
        XCTAssertTrue(ActivityRules.conversationRead(both, channelReadSeq: 20, threadReadSeq: 0))
        XCTAssertTrue(ActivityRules.conversationRead(both, channelReadSeq: 3, threadReadSeq: 25))
        XCTAssertFalse(ActivityRules.conversationRead(both, channelReadSeq: 19, threadReadSeq: 19))
        // Reactions keep to the activity's read position.
        XCTAssertFalse(ActivityRules.conversationRead(conversationItem("reaction", seq: 1), channelReadSeq: 99, threadReadSeq: 99))
    }

    func testTheDotFollowsReadsInTheConversation() {
        let seenFrom = "2026-10-06T09:00:00Z"
        let item = conversationItem("mention", seq: 10)
        XCTAssertTrue(ActivityRules.isUnread(item, readAt: seenFrom))
        XCTAssertFalse(ActivityRules.isUnread(item, readAt: seenFrom, conversationRead: true))
        // The server's verdict: read although after the page's read position = read in its conversation, or (since
        // 2026-10-07) opened — any kind.
        let pageReadAt = "2026-10-06T08:00:00Z"
        let marked = ActivityRules.markingServerReads([conversationItem("mention", seq: 10, read: true), conversationItem("mention", seq: 11, read: false),
                                                      conversationItem("mention", seq: 12, read: nil), conversationItem("reaction", seq: 13, read: true)],
                                                     readAt: pageReadAt)
        XCTAssertEqual(marked.map(\.readOnServer), [true, false, false, true])
        XCTAssertEqual(marked.map { ActivityRules.isUnread($0, readAt: seenFrom) }, [false, true, true, false])
        // Read by the position itself (at not after it): nothing more is implied.
        let byPosition = ActivityRules.markingServerReads([conversationItem("mention", seq: 10, read: true)], readAt: "2026-10-06T11:00:00Z")
        XCTAssertFalse(byPosition[0].readOnServer)
        XCTAssertTrue(ActivityRules.isUnread(byPosition[0], readAt: seenFrom))
    }

    // MARK: 開いたら既読 (MOBILE_UI.md §6.4, 2026-10-07)

    func testTheItemIdDecodesAndIsOptional() throws {
        func first(_ extra: String) throws -> ActivityItem {
            let json = """
            {"items": [{"kind": "reaction", "at": "2026-09-30T01:00:00Z", "message": \(Self.messageJson), "actor_ids": ["u2"]\(extra)}],
             "next_cursor": null, "read_at": "2026-09-30T00:00:00Z"}
            """
            return try XCTUnwrap(JSON.snakeDecoder.decode(ActivityListOut.self, from: Data(json.utf8)).items.first)
        }
        let current = try first(#", "id": "0b6f8a8e-1111-4c1e-9a55-2d7f6b1c0001", "read": false"#)
        XCTAssertEqual(current.itemId, "0b6f8a8e-1111-4c1e-9a55-2d7f6b1c0001")
        XCTAssertEqual(current.id, "reaction:m1") // the row's key is unchanged
        XCTAssertEqual(ActivityRules.openable([current]).map(\.id), ["0b6f8a8e-1111-4c1e-9a55-2d7f6b1c0001"])
        XCTAssertEqual(ActivityRules.openable([current]).map(\.at), ["2026-09-30T01:00:00Z"]) // the row's own time
        // A server before it: no id, nothing is sent when the row is opened.
        let older = try first("")
        XCTAssertNil(older.itemId)
        XCTAssertTrue(ActivityRules.openable([older]).isEmpty)
    }

    func testAnOpenedItemIsReadUntilItHappensAgain() {
        let readAt = "2026-10-07T00:00:00Z"
        let reaction = item("reaction", at: "2026-10-07T01:00:00Z")
        XCTAssertTrue(ActivityRules.isUnread(reaction, readAt: readAt))
        XCTAssertFalse(ActivityRules.isUnread(reaction, readAt: readAt, openedAt: "2026-10-07T01:00:00Z")) // opened as shown
        XCTAssertFalse(ActivityRules.isUnread(reaction, readAt: readAt, openedAt: "2026-10-07T02:00:00Z"))
        // Someone reacted again after it was opened: its `at` moved on, unread again (as Slack).
        XCTAssertTrue(ActivityRules.isUnread(item("reaction", at: "2026-10-07T03:00:00Z"), readAt: readAt, openedAt: "2026-10-07T02:00:00Z"))
    }

    func testOpenedTimesOnlyMoveForward() {
        let store = Store()
        store.noteActivityItemsRead(["a", "b"], readAt: "2026-10-07T02:00:00Z")
        store.noteActivityItemsRead(["a"], readAt: "2026-10-07T01:00:00Z") // an older time (a late event): kept
        store.noteActivityItemsRead(["b"], readAt: "2026-10-07T03:00:00.5Z")
        XCTAssertEqual(store.openedActivityItems, ["a": "2026-10-07T02:00:00Z", "b": "2026-10-07T03:00:00.5Z"])
    }

    func testTheHeaderAndUnreadOnly() {
        XCTAssertEqual(ActivityRules.unreadHeader(0), "未読はありません")
        XCTAssertEqual(ActivityRules.unreadHeader(3), "未読 3 件")
        XCTAssertEqual(ActivityRules.unreadHeader(99), "未読 99+ 件")
        XCTAssertEqual(ActivityRules.unreadHeader(120), "未読 99+ 件")
        let rows = [item("mention", at: "2026-10-07T01:00:00Z", id: "a"), item("reaction", at: "2026-10-07T02:00:00Z", id: "b")]
        XCTAssertEqual(ActivityRules.shown(rows, unreadOnly: false) { $0.id == "mention:a" }.map(\.id), ["mention:a", "reaction:b"])
        XCTAssertEqual(ActivityRules.shown(rows, unreadOnly: true) { $0.id == "mention:a" }.map(\.id), ["mention:a"])
        // 「すべて既読にする」 reads at least up to the newest row held.
        XCTAssertEqual(ActivityRules.newest(rows), "2026-10-07T02:00:00Z")
        XCTAssertNil(ActivityRules.newest([]))
        XCTAssertTrue(ActivityRules.moves("2026-09-30T03:00:00.25Z", readAt: "2026-09-30T03:00:00Z"))
        XCTAssertFalse(ActivityRules.moves("2026-09-30T03:00:00Z", readAt: "2026-09-30T03:00:00Z"))
        XCTAssertFalse(ActivityRules.moves(nil, readAt: nil))
        XCTAssertTrue(ActivityRules.moves("2026-09-30T03:00:00Z", readAt: nil))
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

    /// MOBILE_POLISH.md X1: the audit's rows (ios/light-32-activity.png) as one clean line — no list markers or code
    /// fences, a mention by display name, what was sent without text, the same for a reaction as for a mention.
    func testExcerptsAreOneCleanLineWithDisplayNames() {
        let android1 = UserPublic(id: "00000000-0000-7000-8000-0000000000a1", username: "android1", displayName: "Android android1", role: "member",
                                  deactivatedAt: nil, createdAt: "", updatedAt: "")
        let users = [android1.id: android1]
        func message(_ body: String, attachments: [AttachmentOut] = [], deleted: Bool = false) -> MessageOut {
            var out = MessageOut(id: "m", channelId: "c1", senderId: "u2", seq: 1, updatedSeq: 1, clientMsgId: nil, body: body, createdAt: "",
                                 editedAt: nil, deleted: deleted)
            out.attachments = attachments
            return out
        }
        XCTAssertEqual(ActivityRules.excerpt(message("今日の議事メモ:\n- 発表順は案 2\n- 次回までに analysis.py を整理\n- 締切は 10/15"), users: users),
                       "今日の議事メモ: 発表順は案 2 次回までに analysis.py を整理 締切は 10/15")
        XCTAssertEqual(ActivityRules.excerpt(message("<@\(android1.id)> 共有ドライブのアクセス権を付けました。確認お願いします"), users: users),
                       "@Android android1 共有ドライブのアクセス権を付けました。確認お願いします")
        XCTAssertEqual(ActivityRules.excerpt(message("```python\nprint(1)\n```\n**太字** と `code`"), users: users), "print(1) 太字 と code")
        XCTAssertEqual(ActivityRules.excerpt(message("> 一行目の引用\n> 二行目の引用"), users: users), "一行目の引用 二行目の引用")
        let photo = AttachmentOut(id: "a", filename: "IMG_0001.jpg", contentType: "image/jpeg", sizeBytes: 1, width: 1, height: 1, hasThumbnail: true,
                                  status: "ready", createdAt: "")
        XCTAssertEqual(ActivityRules.excerpt(message("", attachments: [photo, photo]), users: users), "画像を 2 枚送信しました")
        XCTAssertEqual(ActivityRules.excerpt(message("", deleted: true), users: users), "（削除されたメッセージ）")
        XCTAssertFalse(ActivityRules.excerpt(message(String(repeating: "あ", count: 200)), users: users).contains("\n"))
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

    /// MOBILE_UI.md §6.4 (2026-10-06): reading a mention or a reply in its conversation lowers the server's count, so
    /// the badge is fetched again on read.updated, on thread.updated (reason read) and after this device's own reads.
    func testReadsInTheConversationFetchTheBadgeAgain() async throws {
        let w = makeWorld()
        let mine = try w.server.post(channelId: w.channel.id, senderId: w.bob.id, body: "スライド v2 です").0
        let mention = try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "<@\(w.bob.id)> 見てください").0
        let reply = try w.server.post(channelId: w.channel.id, senderId: w.alice.id, body: "<@\(w.bob.id)> 返信です", parentId: mine.id).0
        w.server.activity[w.bob.id] = ActivitySummary(readAt: "2026-09-30T00:00:00Z", unreadCount: 2, mentionUnread: true)
        await w.engine.start()
        await settle(w.engine)
        let before = summaryCalls(w.api)
        XCTAssertEqual(w.store.activity?.unreadCount, 2)

        // Read in the conversation on another device: read.updated.
        w.server.activity[w.bob.id]?.unreadCount = 1
        try w.server.markRead(userId: w.bob.id, channelId: w.channel.id, seq: mention.seq)
        await settle(w.engine)
        XCTAssertEqual(summaryCalls(w.api), before + 1)
        XCTAssertEqual(w.store.activity?.unreadCount, 1)
        XCTAssertEqual(w.store.activityReadsMovedBack, 0)

        // Read in the thread: thread.updated with reason read.
        w.server.activity[w.bob.id] = ActivitySummary(readAt: "2026-09-30T00:00:00Z", unreadCount: 0, mentionUnread: false)
        try w.server.markThreadRead(userId: w.bob.id, messageId: mine.id, seq: reply.seq)
        await settle(w.engine)
        XCTAssertEqual(summaryCalls(w.api), before + 2)
        XCTAssertEqual(w.store.activity?.unreadCount, 0)

        // 「ここから未読にする」: the position moves back, the lists held are read again.
        w.server.activity[w.bob.id] = ActivitySummary(readAt: "2026-09-30T00:00:00Z", unreadCount: 1, mentionUnread: true)
        try w.server.markRead(userId: w.bob.id, channelId: w.channel.id, seq: mine.seq, mode: "set")
        await settle(w.engine)
        XCTAssertEqual(summaryCalls(w.api), before + 3)
        XCTAssertEqual(w.store.activityReadsMovedBack, 1)
        XCTAssertEqual(w.store.activity?.unreadCount, 1)

        // Read here: once the PUT went through, the badge is fetched again.
        w.engine.isActive = { true }
        w.server.activity[w.bob.id] = ActivitySummary(readAt: "2026-09-30T00:00:00Z", unreadCount: 0, mentionUnread: false)
        let calls = summaryCalls(w.api)
        w.engine.markRead(w.channel.id, seq: mention.seq, force: true)
        await w.engine.flushReads()
        await settle(w.engine)
        XCTAssertGreaterThan(summaryCalls(w.api), calls)
        XCTAssertEqual(w.store.activity?.unreadCount, 0)
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

    /// 2026-10-07 (MOBILE_UI.md §6.4): opening a row reads that item only — its dot goes at once (up to the row's `at`),
    /// PUT /activity/items/read carries only its id, the badge is the server's answer; the other rows keep their dots and
    /// the read position does not move.
    func testOpeningARowReadsOnlyThatItem() async throws {
        let w = makeWorld()
        w.server.activity[w.bob.id] = ActivitySummary(readAt: "2026-10-07T00:00:00Z", unreadCount: 3, mentionUnread: true)
        await w.engine.start()
        await settle(w.engine)
        let tapped = ActivityItem(kind: "mention", at: "2026-10-07T01:00:00Z", message: nil, actorIds: ["u2"], itemId: "i-tapped", read: false)
        let other = ActivityItem(kind: "reaction", at: "2026-10-07T02:00:00Z", message: nil, actorIds: ["u2"], itemId: "i-other", read: false)
        let sent = try await w.engine.markActivityItemsRead(ActivityRules.openable([tapped]))
        XCTAssertTrue(sent)
        XCTAssertEqual(w.server.itemsRead[w.bob.id], ["i-tapped"])
        XCTAssertEqual(w.store.activity, ActivitySummary(readAt: "2026-10-07T00:00:00Z", unreadCount: 2, mentionUnread: true))
        XCTAssertFalse(w.api.calls.contains("markActivityRead")) // the read position is not moved
        let readAt = w.store.activity?.readAt
        XCTAssertFalse(ActivityRules.isUnread(tapped, readAt: readAt, openedAt: w.store.openedActivityItems["i-tapped"]))
        XCTAssertTrue(ActivityRules.isUnread(other, readAt: readAt, openedAt: w.store.openedActivityItems["i-other"]))
        await settle(w.engine)
        // activity.items_read came back with the server's time (not before the row's): still read.
        XCTAssertFalse(ActivityRules.isUnread(tapped, readAt: readAt, openedAt: w.store.openedActivityItems["i-tapped"]))
        w.engine.stop()
    }

    /// The controller's tap: rows without the server's id (a server before 2026-10-07) send nothing and move nothing.
    func testAnOlderServersRowsSendNothingWhenOpened() async throws {
        let w = makeWorld()
        w.server.activity[w.bob.id] = ActivitySummary(readAt: "2026-10-07T00:00:00Z", unreadCount: 1, mentionUnread: false)
        await w.engine.start()
        await settle(w.engine)
        let older = ActivityItem(kind: "mention", at: "2026-10-07T01:00:00Z", message: nil, actorIds: ["u2"])
        let sent = try await w.engine.markActivityItemsRead(ActivityRules.openable([older]))
        XCTAssertFalse(sent)
        XCTAssertFalse(w.api.calls.contains("markActivityItemsRead"))
        XCTAssertFalse(w.api.calls.contains("markActivityRead"))
        XCTAssertTrue(w.store.openedActivityItems.isEmpty)
        // Its dot stays until the read position passes it (「すべて既読にする」, here or on another device).
        XCTAssertTrue(ActivityRules.isUnread(older, readAt: w.store.activity?.readAt))
        w.engine.stop()
    }

    /// 「すべて既読にする」 and the items opened on my other devices clear the dots here live.
    func testMarkAllAndOtherDevicesClearTheDots() async throws {
        let w = makeWorld()
        w.server.activity[w.bob.id] = ActivitySummary(readAt: "2026-10-07T00:00:00Z", unreadCount: 2, mentionUnread: true)
        await w.engine.start()
        await settle(w.engine)
        let a = ActivityItem(kind: "mention", at: "2026-10-07T01:00:00Z", message: nil, actorIds: ["u2"], itemId: "i-a", read: false)
        let b = ActivityItem(kind: "reaction", at: "2026-10-07T02:00:00Z", message: nil, actorIds: ["u2"], itemId: "i-b", read: false)
        func dots() -> [Bool] {
            [a, b].map { ActivityRules.isUnread($0, readAt: w.store.activity?.readAt, openedAt: $0.itemId.flatMap { w.store.openedActivityItems[$0] }) }
        }
        XCTAssertEqual(dots(), [true, true])
        // Opened on my other device: activity.items_read.
        let before = summaryCalls(w.api)
        _ = try w.server.markActivityItemsRead(w.bob.id, itemIds: ["i-a"])
        await settle(w.engine)
        XCTAssertEqual(dots(), [false, true])
        XCTAssertGreaterThan(summaryCalls(w.api), before) // the badge is fetched again
        XCTAssertEqual(w.store.activity?.unreadCount, 1)
        // 「すべて既読にする」 on my other device: activity.read.
        _ = try w.server.markActivityRead(w.bob.id, readAt: "2026-10-07T03:00:00Z")
        await settle(w.engine)
        XCTAssertEqual(dots(), [false, false])
        XCTAssertEqual(w.store.activity?.unreadCount, 0)
        // … and here: the answer is the badge.
        w.server.activity[w.bob.id] = ActivitySummary(readAt: "2026-10-07T03:00:00Z", unreadCount: 4, mentionUnread: true)
        try await w.engine.markActivityRead("2026-10-07T04:00:00Z")
        XCTAssertEqual(w.store.activity, ActivitySummary(readAt: "2026-10-07T04:00:00Z", unreadCount: 0, mentionUnread: false))
        w.engine.stop()
    }

    /// Review v0.1.22 #3 (CANVAS.md §20.8): an erased canvas version blanks the excerpts taken from it; activity.updated
    /// names the items, the list held drops those excerpts (only theirs) and the row shows no excerpt line.
    func testActivityUpdatedBlanksTheNamedCanvasExcerpts() async throws {
        let w = makeWorld()
        await w.engine.start()
        await settle(w.engine)
        XCTAssertEqual(w.store.activityUpdates, 0)
        w.server.emitActivityUpdated(w.bob.id, itemIds: ["i1", "i3"])
        await settle(w.engine)
        XCTAssertEqual(w.store.activityUpdates, 1)
        w.server.emitActivityUpdated(w.bob.id, itemIds: ["i2"])
        await settle(w.engine)
        XCTAssertEqual(w.store.activityUpdates, 2)
        XCTAssertEqual(w.store.takeUpdatedActivityItems(), ["i1", "i2", "i3"]) // both events, taken once
        XCTAssertEqual(w.store.takeUpdatedActivityItems(), [])
        XCTAssertGreaterThanOrEqual(summaryCalls(w.api), 1) // M112: the badge is read again (a reservation to-do may be done)
        w.engine.stop()

        func canvasItem(_ itemId: String, revId: String, excerpt: String) -> ActivityItem {
            ActivityItem(kind: "canvas_mention", at: "2026-10-01T00:00:00Z", message: nil, actorIds: ["u1"],
                         canvas: ActivityCanvas(itemId: itemId, canvasId: "cv", channelId: "c1", title: "議事録", excerpt: excerpt, revId: revId))
        }
        let message = MessageOut(id: "m1", channelId: "c1", senderId: "u1", seq: 1, updatedSeq: 1, clientMsgId: nil, body: "SECRET in a message",
                                 createdAt: "", editedAt: nil, deleted: false)
        let items = [canvasItem("i1", revId: "r1", excerpt: "@Bob SECRET-TO-ERASE"), canvasItem("i9", revId: "r2", excerpt: "@Bob 残る行"),
                     ActivityItem(kind: "mention", at: "2026-10-01T00:00:00Z", message: message, actorIds: ["u1"])]
        let blanked = ActivityRules.blankingExcerpts(items, itemIds: ["i1", "m1"])
        XCTAssertEqual(blanked.map { ActivityRules.excerpt($0, users: [:]) }, ["", "@Bob 残る行", "SECRET in a message"])
        XCTAssertEqual(blanked[0].canvas?.title, "議事録") // the item stays (who mentioned me, and when, is no secret)
        XCTAssertEqual(ActivityRules.blankingExcerpts(items, itemIds: []), items)
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

/// 2026-10-07 (MOBILE_UI.md §6.4 「開いたら既読」): the activity list on screen reads nothing — before, 「すべて」 sent
/// PUT /activity/read about 1.5 s after its rows came on screen.
@MainActor
final class ActivityFeedScreenTests: XCTestCase {
    private final class Recorder: @unchecked Sendable {
        private let lock = NSLock()
        private var items: [String] = []
        func add(_ item: String) { lock.lock(); items.append(item); lock.unlock() }
        var all: [String] { lock.lock(); defer { lock.unlock() }; return items }
    }

    private static let page = Data("""
    {"items": [
      {"id": "00000000-0000-4000-8000-000000000001", "kind": "mention", "at": "2026-10-07T02:00:00Z", "read": false, "actor_ids": ["u2"],
       "message": {"id": "m1", "channel_id": "c1", "sender_id": "u2", "seq": 5, "updated_seq": 5, "client_msg_id": "k1", "body": "見てください",
                   "created_at": "2026-10-07T02:00:00Z", "edited_at": null, "deleted": false}},
      {"id": "00000000-0000-4000-8000-000000000002", "kind": "reaction", "at": "2026-10-07T01:00:00Z", "read": false, "actor_ids": ["u2"], "emojis": ["👍"],
       "message": {"id": "m2", "channel_id": "c1", "sender_id": "u1", "seq": 4, "updated_seq": 4, "client_msg_id": "k2", "body": "スライド",
                   "created_at": "2026-10-07T00:30:00Z", "edited_at": null, "deleted": false}}
     ], "next_cursor": null, "read_at": "2026-10-07T00:00:00Z"}
    """.utf8)

    func testShowingTheListReadsNothing() async throws {
        let server = FakeServer()
        let alice = server.addUser("alice")
        let bob = server.addUser("bob")
        let channel = server.createChannel("general", ownerId: alice.id)
        server.join(channel.id, bob.id)
        server.activity[bob.id] = ActivitySummary(readAt: "2026-10-07T00:00:00Z", unreadCount: 2, mentionUnread: true)
        let store = Store()
        var options = EngineOptions()
        options.reconnectMin = 0
        options.sleep = { _ in }
        options.random = { 0.5 }
        let fake = server.api(for: bob.id)
        let engine = SyncEngine(api: fake, connect: server.connector(for: bob.id), wsUrl: URL(string: "ws://fake")!, store: store,
                                getAccessToken: { "token" }, options: options)
        engine.isActive = { false }
        await engine.start()
        for _ in 0..<50 { await engine.idle(); await Task.yield() }
        XCTAssertEqual(engine.status, .online)

        let recorder = Recorder()
        StubProtocol.handler = { request in
            recorder.add("\(request.httpMethod ?? "") \(request.url?.path ?? "")")
            return request.url?.path == "/api/v1/activity" ? (200, Self.page) : (404, Data(#"{"error": {"code": "not_found", "message": "no"}}"#.utf8))
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        let client = ApiClient(baseUrl: URL(string: "http://server")!, session: URLSession(configuration: configuration))
        client.accessToken = "access"
        let controller = AppController()
        controller.attachForTesting(store: store, engine: engine)
        controller.api = client

        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        let window = scene.map { UIWindow(windowScene: $0) } ?? UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 700))
        window.frame = CGRect(x: 0, y: 0, width: 393, height: 700)
        let host = UIHostingController(rootView: NavigationStack { ActivityFeedView(controller: controller, onOpen: { _ in }) })
        window.rootViewController = host
        window.makeKeyAndVisible()
        // Longer than the old 1.5 s before the rows counted as read.
        let deadline = Date().addingTimeInterval(2.5)
        while Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
            await Task.yield()
        }
        window.isHidden = true

        XCTAssertTrue(recorder.all.contains("GET /api/v1/activity"), "the list loaded: \(recorder.all)")
        XCTAssertFalse(recorder.all.contains { $0.hasPrefix("PUT") }, "nothing is marked read: \(recorder.all)")
        XCTAssertFalse(fake.calls.contains("markActivityRead"))
        XCTAssertFalse(fake.calls.contains("markActivityItemsRead"))
        XCTAssertEqual(store.activity?.unreadCount, 2)
        XCTAssertTrue(store.openedActivityItems.isEmpty)
        engine.stop()
    }
}
