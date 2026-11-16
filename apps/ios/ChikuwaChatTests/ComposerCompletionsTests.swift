import XCTest
@testable import ChikuwaChat

/// M187 (MOBILE_UI.md §30): the candidates and the insertion the composer and the message editor share.
final class ComposerCompletionsTests: XCTestCase {
    func testEmojiCandidatesPutTheWorkspacesOwnFirst() {
        let bow = CustomEmojiOut(id: "e1", name: "hpd-bow", contentType: "image/png", width: 32, height: 32, createdBy: "u",
                                 createdAt: "", label: "おじぎ")
        let tada = CustomEmojiOut(id: "e2", name: "tada_party", contentType: "image/png", width: 32, height: 32, createdBy: "u",
                                  createdAt: "")
        let hits = ComposerCompletions.emoji("できた :tad", custom: [bow, tada])
        XCTAssertEqual(hits.first?.glyph, ":tada_party:")
        XCTAssertEqual(hits.first?.category, "custom")
        XCTAssertTrue(hits.contains { $0.glyph == "🎉" })
        XCTAssertLessThanOrEqual(hits.count, 8)
        // By the label too (M100), and with its label kept for the chip.
        let byLabel = ComposerCompletions.emoji(":おじ", custom: [bow, tada])
        XCTAssertEqual(byLabel.first?.glyph, ":hpd-bow:")
        XCTAssertEqual(byLabel.first?.keywords, "おじぎ")
        // Nothing being typed after a colon: no candidates.
        XCTAssertTrue(ComposerCompletions.emoji("10:30 に", custom: [bow, tada]).isEmpty)
        XCTAssertTrue(ComposerCompletions.emoji("できた", custom: [bow, tada]).isEmpty)
    }

    func testInsertGoesInPlaceOfTheSelection() {
        // At the cursor in the middle of an edited message.
        let middle = ComposerSelection.insert("🎉", into: "了解です", at: 2..<2)
        XCTAssertEqual(middle.text, "了解🎉です")
        XCTAssertEqual(middle.selection, 3..<3)
        // In place of a selection.
        let replaced = ComposerSelection.insert(":hpd-bow:", into: "ありがとう!", at: 5..<6)
        XCTAssertEqual(replaced.text, "ありがとう:hpd-bow:")
        XCTAssertEqual(replaced.selection, 14..<14)
        // A range past the end (a stale cursor) is clamped, never a crash.
        let past = ComposerSelection.insert("@", into: "abc", at: 7..<9)
        XCTAssertEqual(past.text, "abc@")
        XCTAssertEqual(past.selection, 4..<4)
    }

    /// The editor reads the text before the cursor (Android's Completions.typed) and completes there, keeping the rest.
    func testCompletionAtTheCursorKeepsTheRest() {
        XCTAssertEqual(ComposerCompletions.typed("了解です :tad 明日", range: 9..<9), "了解です :tad")
        XCTAssertEqual(ComposerCompletions.typed("abc", range: 1..<2), "")  // a selection: nothing
        XCTAssertEqual(ComposerCompletions.typed("abc", range: 9..<9), "abc")
        let middle = ComposerCompletions.complete("了解です :tad 明日", cursor: 9) { Emoji.complete($0, glyph: "🎉") }
        XCTAssertEqual(middle.text, "了解です 🎉 明日")  // no second space before 「明日」
        XCTAssertEqual(middle.selection, 7..<7)  // after the space, as on the desktop
        // Before a line break the completion keeps its own space (only a space is taken).
        let line = ComposerCompletions.complete("確認 @yam\n次", cursor: 7) { Mentions.complete($0, username: "yamada") }
        XCTAssertEqual(line.text, "確認 @yamada \n次")
        let end = ComposerCompletions.complete("確認 @yam", cursor: 7) { Mentions.complete($0, username: "yamada") }
        XCTAssertEqual(end.text, "確認 @yamada ")
        XCTAssertEqual(end.selection, 11..<11)
    }

    func testTheCursorIsTheEndWithoutAReportedSelection() {
        let selection = ComposerSelection()
        XCTAssertEqual(selection.range(in: "こんにちは"), 5..<5)
        // A selection made for another text is not used for this one.
        selection.select(1..<2, in: "abc")
        XCTAssertEqual(selection.range(in: "abcd"), 4..<4)
        if #available(iOS 26.0, *) {
            XCTAssertEqual(selection.range(in: "abc"), 1..<2)
        }
    }
}
