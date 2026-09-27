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
}
