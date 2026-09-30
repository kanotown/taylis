import XCTest
@testable import ChikuwaChat

/// The wire and persisted shapes of a message keep every field the UI needs.
final class MessageCodingTests: XCTestCase {
    private let wire = """
    {"id": "m2", "channel_id": "c1", "sender_id": "u1", "parent_id": "m1", "also_in_channel": true, "seq": 7, "updated_seq": 8,
     "client_msg_id": null, "type": "user", "body": "📊 どこにする?", "mentioned_user_ids": [], "mention_all": false, "reactions": [],
     "attachments": [], "reply_count": 0, "last_reply_at": null, "created_at": "2026-09-27T04:00:00Z", "edited_at": null, "deleted": false,
     "pinned_at": null, "pinned_by": null, "priority": "urgent", "ack_requested": true,
     "acks": [{"user_id": "u3", "acked_at": "2026-09-27T04:05:00Z"}],
     "poll": {"question": "どこにする?", "options": ["焼き鳥", "中華"], "multiple": false, "closed_at": null, "votes": [["u1"], []]}}
    """

    func testPollAndSharedReplyDecodeAndSurvivePersistence() throws {
        let message = try JSON.snakeDecoder.decode(MessageOut.self, from: Data(wire.utf8))
        XCTAssertTrue(message.alsoInChannel)  // M15c
        XCTAssertEqual(message.poll?.options, ["焼き鳥", "中華"])  // M14b: the poll used to be dropped on decode
        XCTAssertEqual(message.poll?.votes, [["u1"], []])

        let state = MessageState(message)
        XCTAssertTrue(state.inTimeline)
        let persisted = try JSON.plainDecoder.decode(MessageState.self, from: JSON.plainEncoder.encode(state))
        XCTAssertEqual(persisted.poll, message.poll)
        XCTAssertTrue(persisted.alsoInChannel)
        XCTAssertEqual(MessageOut(persisted)?.poll, message.poll)
        XCTAssertEqual(MessageOut(persisted)?.alsoInChannel, true)
        // M15e
        XCTAssertEqual([message.priority, persisted.priority, MessageOut(persisted)?.priority], ["urgent", "urgent", "urgent"])
        XCTAssertTrue(persisted.ackRequested)
        XCTAssertEqual(persisted.acks.map(\.userId), ["u3"])
        XCTAssertEqual(MessageOut(persisted)?.acks, message.acks)
    }

    /// §10.1 12.: a held row keeps its type, so counts made from held rows leave system rows out as the server does.
    /// Rows persisted before M17 have none and are user rows.
    func testTypeSurvivesPersistence() throws {
        var message = try JSON.snakeDecoder.decode(MessageOut.self, from: Data(wire.utf8))
        message.type = "system"
        let persisted = try JSON.plainDecoder.decode(MessageState.self, from: JSON.plainEncoder.encode(MessageState(message)))
        XCTAssertEqual(persisted.type, "system")
        XCTAssertEqual(MessageOut(persisted)?.type, "system")
        XCTAssertFalse(persisted.countsAsUnread(meId: "someone else"))
        var old = try XCTUnwrap(JSONSerialization.jsonObject(with: JSON.plainEncoder.encode(MessageState(message))) as? [String: Any])
        old["type"] = nil
        let legacy = try JSON.plainDecoder.decode(MessageState.self, from: JSONSerialization.data(withJSONObject: old))
        XCTAssertEqual(legacy.type, "user")
        XCTAssertTrue(legacy.countsAsUnread(meId: "someone else"))
        XCTAssertFalse(legacy.countsAsUnread(meId: "u1")) // my own
    }

    /// C3 (THREADS.md §3.1): who replied, on the wire, persisted and back; none from an older server or an older row.
    func testReplyUserIdsDecodeTolerantlyAndSurvivePersistence() throws {
        let older = try JSON.snakeDecoder.decode(MessageOut.self, from: Data(wire.utf8))
        XCTAssertEqual(older.replyUserIds, [])
        var object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(wire.utf8)) as? [String: Any])
        object["reply_user_ids"] = ["u3", "u1"]
        let message = try JSON.snakeDecoder.decode(MessageOut.self, from: JSONSerialization.data(withJSONObject: object))
        XCTAssertEqual(message.replyUserIds, ["u3", "u1"])
        let persisted = try JSON.plainDecoder.decode(MessageState.self, from: JSON.plainEncoder.encode(MessageState(message)))
        XCTAssertEqual(persisted.replyUserIds, ["u3", "u1"])
        XCTAssertEqual(MessageOut(persisted)?.replyUserIds, ["u3", "u1"])
        var row = try XCTUnwrap(JSONSerialization.jsonObject(with: JSON.plainEncoder.encode(persisted)) as? [String: Any])
        row["replyUserIds"] = nil
        XCTAssertEqual(try JSON.plainDecoder.decode(MessageState.self, from: JSONSerialization.data(withJSONObject: row)).replyUserIds, [])

        // parent_thread: the list when sent, nil (not []) when not.
        let thread = #"{"id":"p","reply_count":2,"last_reply_at":null,"updated_seq":9,"participant_ids":[],"reply_user_ids":["u2"]}"#
        XCTAssertEqual(try JSON.snakeDecoder.decode(ParentThread.self, from: Data(thread.utf8)).replyUserIds, ["u2"])
        let oldThread = #"{"id":"p","reply_count":2,"last_reply_at":null,"updated_seq":9}"#
        XCTAssertNil(try JSON.snakeDecoder.decode(ParentThread.self, from: Data(oldThread.utf8)).replyUserIds)
    }

    /// C3: a reply's parent_thread moves the parent's repliers as the web's applyParentThread does: the new list when
    /// sent (an empty one too, all replies deleted), the old one kept when an older server sends none.
    @MainActor
    func testParentThreadMovesTheRepliers() {
        let store = Store()
        var parent = MessageOut(id: "p", channelId: "c1", senderId: "u1", seq: 1, updatedSeq: 1, clientMsgId: nil, body: "親",
                                createdAt: "2026-09-27T04:00:00Z", editedAt: nil, deleted: false)
        parent.replyCount = 1
        parent.replyUserIds = ["u2"]
        store.upsertMessage(parent)
        store.applyParentThread("c1", ParentThread(id: "p", replyCount: 2, lastReplyAt: "2026-09-27T05:00:00Z", updatedSeq: 3, replyUserIds: ["u3", "u2"]))
        XCTAssertEqual(store.message("c1", id: "p")?.replyUserIds, ["u3", "u2"])
        XCTAssertEqual(store.message("c1", id: "p")?.replyCount, 2)
        store.applyParentThread("c1", ParentThread(id: "p", replyCount: 3, lastReplyAt: "2026-09-27T06:00:00Z", updatedSeq: 5))
        XCTAssertEqual(store.message("c1", id: "p")?.replyUserIds, ["u3", "u2"]) // an older server: kept
        XCTAssertEqual(store.message("c1", id: "p")?.replyCount, 3)
        store.applyParentThread("c1", ParentThread(id: "p", replyCount: 9, lastReplyAt: nil, updatedSeq: 4, replyUserIds: ["x"]))
        XCTAssertEqual(store.message("c1", id: "p")?.replyUserIds, ["u3", "u2"]) // stale (updated_seq 4 < 5): ignored
        store.applyParentThread("c1", ParentThread(id: "p", replyCount: 0, lastReplyAt: nil, updatedSeq: 6, replyUserIds: []))
        XCTAssertEqual(store.message("c1", id: "p")?.replyUserIds, [])
    }
}
