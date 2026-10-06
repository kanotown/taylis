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
        XCTAssertEqual(Moderation.reasons.map(\.value), ["child_safety", "spam", "harassment", "inappropriate", "other"])
    }

    // MARK: M119 「問題を報告・ご意見」 (MODERATION.md §3.1)

    func testReportCategoriesStartWithChildSafety() {
        XCTAssertEqual(Moderation.reportCategories.map(\.value), ["child_safety", "harassment", "inappropriate", "spam", "feedback", "other"])
    }

    func testReportNeedsACategoryAndOneToFourThousandCharacters() {
        var form = GeneralReportForm()
        XCTAssertFalse(form.canSend)
        form.note = "困っています"
        XCTAssertFalse(form.canSend, "no category yet")
        form.category = "feedback"
        XCTAssertTrue(form.canSend)
        form.note = "  \n "
        XCTAssertFalse(form.canSend, "blank after trimming")
        XCTAssertEqual(form.noteLength, 0)
        form.note = " " + String(repeating: "あ", count: 4000) + "\n"
        XCTAssertEqual(form.noteLength, 4000)
        XCTAssertTrue(form.canSend)
        form.note = String(repeating: "a", count: 4001)
        XCTAssertTrue(form.tooLong)
        XCTAssertFalse(form.canSend)
        // Counted as the server counts (code points): a flag is two.
        form.note = "🇯🇵"
        XCTAssertEqual(form.noteLength, 2)
    }

    func testReportBodyCarriesTheTrimmedNoteThePersonAndTheRetryKey() {
        var general = GeneralReportForm()
        general.category = "child_safety"
        general.note = "  見てください \n"
        XCTAssertEqual(general.body, [
            "category": .string("child_safety"),
            "note": .string("見てください"),
            "client_report_id": .string(general.clientReportId),
        ])
        var person = GeneralReportForm(userId: "u-2")
        person.category = "harassment"
        person.note = "x"
        XCTAssertEqual(person.body["user_id"], .string("u-2"))
        XCTAssertNotNil(UUID(uuidString: person.clientReportId))
        XCTAssertNotEqual(general.clientReportId, person.clientReportId)
    }

    func testRetryKeyStaysUntilTheServerTookTheReport() {
        var form = GeneralReportForm(userId: "u-2")
        let key = form.clientReportId
        form.category = "spam"
        form.note = "first try"
        _ = form.body  // a failed attempt
        form.note = "edited after the failure"
        XCTAssertEqual(form.clientReportId, key, "a resend after a lost response must return the first report")
        form.sent()
        XCTAssertNotEqual(form.clientReportId, key)
        XCTAssertEqual(form.note, "")
        XCTAssertNil(form.category)
        XCTAssertEqual(form.userId, "u-2")
    }

    /// 「その他」 of a report reads "Other", not the overflow buttons' "More".
    func testOtherReadsAsAKindOfReport() {
        let language = UILanguage.shared
        let before = language.choice
        defer { language.set(before) }
        language.set(.en)
        XCTAssertEqual(Moderation.otherLabel, "Other")
        language.set(.zhHans)
        XCTAssertEqual(Moderation.otherLabel, "其他")
        language.set(.ja)
        XCTAssertEqual(Moderation.otherLabel, "その他")
    }

    func testReportAckDecodes() throws {
        let json = #"{"id":"r-1","category":"feedback","user_id":null,"created_at":"2026-10-06T00:00:00Z"}"#
        let ack = try JSON.snakeDecoder.decode(GeneralReportAck.self, from: Data(json.utf8))
        XCTAssertEqual(ack.category, "feedback")
        XCTAssertNil(ack.userId)
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
