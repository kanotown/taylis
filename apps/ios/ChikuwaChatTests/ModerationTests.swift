import XCTest
@testable import ChikuwaChat

/// M104 (docs/MODERATION.md): which messages offer 「報告する」, which rows fold for a blocked sender, and the block list
/// from the bootstrap.
final class ModerationTests: XCTestCase {
    private func message(sender: String, pending: Bool = false, deleted: Bool = false, type: String = "user") -> MessageState {
        var state = MessageState(placeholderFor: "c-1", channelId: "ch", senderId: sender, body: "hi", createdAt: "2026-10-05T00:00:00Z")
        state.id = "m-1"
        state.pending = pending
        state.seq = pending ? nil : 1
        state.deleted = deleted
        state.type = type
        return state
    }

    func testReportIsOfferedOnSomeoneElsesStoredMessage() {
        XCTAssertTrue(Moderation.canReport(message(sender: "bob"), meId: "alice"))
        XCTAssertFalse(Moderation.canReport(message(sender: "alice"), meId: "alice"))
        XCTAssertFalse(Moderation.canReport(message(sender: "bob", pending: true), meId: "alice"))
        XCTAssertFalse(Moderation.canReport(message(sender: "bob", deleted: true), meId: "alice"))
        XCTAssertFalse(Moderation.canReport(message(sender: "bob", type: "system"), meId: "alice"))
        XCTAssertEqual(Moderation.reasons.map(\.value), ["spam", "harassment", "inappropriate", "other"])
    }

    func testABlockedSendersRowFoldsUntilShown() {
        let row = message(sender: "bob")
        XCTAssertFalse(Moderation.folds(row, blocked: [], revealed: []))
        XCTAssertTrue(Moderation.folds(row, blocked: ["bob"], revealed: []))
        XCTAssertFalse(Moderation.folds(row, blocked: ["bob"], revealed: ["m-1"]))
        XCTAssertFalse(Moderation.folds(message(sender: "bob", deleted: true), blocked: ["bob"], revealed: []))
    }

    @MainActor
    func testStoreKeepsTheBlockList() {
        let store = Store()
        store.replaceBlocked(["bob", "carol"])
        XCTAssertTrue(store.isBlocked("bob"))
        store.setBlocked("bob", on: false)
        XCTAssertFalse(store.isBlocked("bob"))
        XCTAssertEqual(store.blockedUsers, ["carol"])
    }

    func testBootstrapDecodesTheBlockListAndToleratesItsAbsence() throws {
        let base = """
        {"server_time":"2026-10-05T00:00:00Z","me":{"id":"me","username":"me","display_name":"Me","role":"member","deactivated_at":null,
         "created_at":"2026-10-05T00:00:00Z","updated_at":"2026-10-05T00:00:00Z","email":null,"must_change_password":false},
         "users":[],"channels":[],"limits":{"max_message_length":1,"max_attachment_bytes":1,"max_attachments_per_message":1}
        """
        let with = try JSON.snakeDecoder.decode(BootstrapOut.self, from: Data((base + #","blocked_user_ids":["bob"]}"#).utf8))
        XCTAssertEqual(with.blockedUserIds, ["bob"])
        let without = try JSON.snakeDecoder.decode(BootstrapOut.self, from: Data((base + "}").utf8))
        XCTAssertNil(without.blockedUserIds)
    }
}
