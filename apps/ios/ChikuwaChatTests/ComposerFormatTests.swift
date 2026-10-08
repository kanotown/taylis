import SwiftUI
import XCTest
@testable import ChikuwaChat

final class ComposerFormatTests: XCTestCase {
    func testInlineStylesWrapTheSelectionOrLeaveTheCursorBetweenTheMarks() {
        XCTAssertTrue(ComposerFormat.bold.apply(to: "今日は晴れ", selection: 3..<5) == ("今日は**晴れ**", 5..<7))
        XCTAssertTrue(ComposerFormat.code.apply(to: "run ", selection: 4..<4) == ("run ``", 5..<5))
        XCTAssertTrue(ComposerFormat.strike.apply(to: "abc", selection: 0..<3) == ("~~abc~~", 2..<5))
        XCTAssertTrue(ComposerFormat.italic.apply(to: "a", selection: 9..<9) == ("a__", 2..<2)) // out of range: at the end
    }

    func testCodeBlockStartsOnItsOwnLine() {
        XCTAssertTrue(ComposerFormat.codeBlock.apply(to: "見て", selection: 2..<2) == ("見て\n```\n\n```", 7..<7))
        XCTAssertTrue(ComposerFormat.codeBlock.apply(to: "x = 1", selection: 0..<5) == ("```\nx = 1\n```", 4..<9))
    }

    func testLinkPutsTheCursorWhereTheAddressGoes() {
        let (text, selection) = ComposerFormat.link.apply(to: "資料", selection: 0..<2)
        XCTAssertEqual(text, "[資料](https://)")
        XCTAssertEqual(selection, 13..<13)
        XCTAssertTrue(ComposerFormat.link.apply(to: "", selection: 0..<0) == ("[](https://)", 1..<1))
    }

    func testLineStylesMarkEveryLineTheSelectionTouches() {
        XCTAssertTrue(ComposerFormat.bullet.apply(to: "買うもの", selection: 2..<2) == ("- 買うもの", 4..<4))
        XCTAssertTrue(ComposerFormat.numbered.apply(to: "a\nb\nc", selection: 0..<5) == ("1. a\n2. b\n3. c", 0..<14))
        XCTAssertTrue(ComposerFormat.numbered.apply(to: "a\nb\nc", selection: 0..<3) == ("1. a\n2. b\nc", 0..<9)) // the lines it touches
        XCTAssertTrue(ComposerFormat.quote.apply(to: "前置き\n引用する", selection: 5..<5) == ("前置き\n> 引用する", 7..<7))
    }

    /// Testers, 2026-09-29: after a send cleared the input, an emoji went in at the old selection, past the end, and
    /// the app crashed. A selection only serves the text it was made in.
    func testASelectionOnlyServesTheTextItBelongsTo() {
        let box = ComposerSelection()
        box.raw = "selection"
        box.text = "送信する前の文"
        XCTAssertNotNil(box.raw(for: "送信する前の文"))
        XCTAssertNil(box.raw(for: ""))
        XCTAssertNil(box.raw(for: "別の文"))
        box.text = "か\u{3099}" // が as two scalars: equal by `==`, but its indices are not those of "が"
        XCTAssertNil(box.raw(for: "が"))
    }

    /// TestFlight build 93 (iOS 27, 2026-10-05): picking an emoji crashed in `utf16Offset(in:)` with a selection whose
    /// indices were made in a longer text than the one it was paired with. Such indices give nil, never a trap.
    func testSelectionIndicesFromAnotherTextGiveNilInsteadOfCrashing() {
        let longer = "abc あいう😀x"
        let past = longer.index(longer.startIndex, offsetBy: 8)
        XCTAssertNil(ComposerSelection.offsets(past..<past, in: ""))
        XCTAssertNil(ComposerSelection.offsets(past..<past, in: "ab"))
        XCTAssertNil(ComposerSelection.offsets(longer.startIndex..<past, in: "ab"))
        let bridged = NSString(string: longer) as String
        let bridgedPast = bridged.index(bridged.startIndex, offsetBy: 9)
        XCTAssertNil(ComposerSelection.offsets(bridgedPast..<bridgedPast, in: "abc"))
    }

    /// TestFlight build 98 (iOS 27, 2026-10-06): typing text, an emoji and a space crashed in `samePosition(in:)` itself.
    /// The field reported a selection made in its own (bridged, UTF-16) copy of the text, one unit past the end of the
    /// draft it was paired with (stored as UTF-8): converting the index trapped. An ASCII draft never did.
    func testAFieldIndexPastTheEndOfAJapaneseOrEmojiDraftGivesNilInsteadOfCrashing() {
        for typed in ["了解です👍", "abc👍", "家族👨‍👩‍👧", "了解"] {
            let field = NSString(string: typed + " ") as String  // the field's text after the space
            let draft = String(decoding: Array(typed.utf8), as: UTF8.self)  // the draft, a step behind
            let cursor = field.endIndex
            XCTAssertFalse(ComposerSelection.fits(cursor, in: draft), typed)
            XCTAssertNil(ComposerSelection.characterOffset(cursor, in: draft), typed)
            XCTAssertNil(ComposerSelection.offsets(cursor..<cursor, in: draft), typed)
            XCTAssertNil(ComposerSelection.offsets(field.startIndex..<cursor, in: draft), typed)
            // Paired with its own text, the same index is the end.
            let caught = String(decoding: Array((typed + " ").utf8), as: UTF8.self)
            XCTAssertEqual(ComposerSelection.offsets(cursor..<cursor, in: caught), caught.count..<caught.count, typed)
            XCTAssertEqual(ComposerSelection.offsets(cursor..<cursor, in: field), field.count..<field.count, typed)
        }
    }

    @available(iOS 26.0, *)
    func testAStoredFieldSelectionPastTheEndOfTheDraftIsDropped() {
        let field = NSString(string: "了解です👍 ") as String
        let draft = String(decoding: Array("了解です👍".utf8), as: UTF8.self)
        let box = ComposerSelection()
        box.raw = TextSelection(insertionPoint: field.endIndex)
        box.text = draft  // the setter ran before the draft caught up
        XCTAssertNil(box.selection(for: draft))
        box.raw = TextSelection(range: field.startIndex..<field.endIndex)
        XCTAssertNil(box.selection(for: draft))
    }

    /// `fits` reads `String.Index`'s bits: an index counted in UTF-8 (a native text) is checked in UTF-8, one counted in
    /// UTF-16 (a bridged text) in UTF-16, so a valid end of a Japanese text is not refused.
    func testFitsReadsTheIndexUnit() {
        let native = String(decoding: Array("了解です👍".utf8), as: UTF8.self)  // 16 UTF-8 bytes, 6 UTF-16 units
        XCTAssertTrue(ComposerSelection.fits(native.endIndex, in: native))
        XCTAssertEqual(ComposerSelection.characterOffset(native.endIndex, in: native), 5)
        let bridged = NSString(string: "了解です👍") as String
        XCTAssertTrue(ComposerSelection.fits(bridged.endIndex, in: native))
        XCTAssertEqual(ComposerSelection.characterOffset(bridged.endIndex, in: native), 5)
        XCTAssertFalse(ComposerSelection.fits(native.endIndex, in: "了解"))  // 16 bytes in a 6-byte text
        XCTAssertNil(ComposerSelection.characterOffset(native.endIndex, in: "了解"))
        XCTAssertFalse(ComposerSelection.fits(native.endIndex, in: "abc"))
    }

    /// A position inside a character (between the scalars of a ZWJ family, or in the middle of a surrogate pair) counts as
    /// the start of that character, never as a crash.
    func testAnIndexInsideAnEmojiRoundsDown() {
        let text = "a👨‍👩‍👧b"
        let inFamily = text.unicodeScalars.index(text.unicodeScalars.startIndex, offsetBy: 2)  // after 👨
        XCTAssertEqual(ComposerSelection.characterOffset(inFamily, in: text), 1)
        let bridged = NSString(string: "a👍b") as String
        let midSurrogate = String.Index(utf16Offset: 2, in: bridged)
        XCTAssertEqual(ComposerSelection.characterOffset(midSurrogate, in: "a👍b") ?? 1, 1)
    }

    /// Every position the field could report (each UTF-8, UTF-16 and scalar index of its text, as a native and as a
    /// bridged string), paired with a draft a step behind or ahead: Japanese IME composition (romaji turning into kana,
    /// marked text growing and shrinking), emoji typed and deleted, the text replaced while the selection is held. None
    /// may trap, and an offset that comes back is a position in the draft.
    func testNoFieldPositionPairedWithAnotherDraftTraps() {
        let steps: [(field: String, draft: String)] = [
            ("k", ""), ("ky", "k"), ("きょ", "ky"), ("きょう", "きょ"), ("きょうは", "きょう"), ("今日は", "きょうは"),
            ("今日は", "今日は"), ("今日は ", "今日は"), ("", "今日は"), ("今", "今日は"),
            ("abc👍", "abc"), ("abc👍 ", "abc👍"), ("abc", "abc👍"), ("ab", "abc👍 "),
            ("👨‍👩‍👧", "👨‍👩"), ("👨‍👩", "👨‍👩‍👧"), ("🇯🇵", "🇯"), ("が", "か\u{3099}"), ("か\u{3099}", "が"),
            ("了解です👍 ", "了解です👍"), ("x", "了解です👍"), ("了解です👍", "x"),
        ]
        func positions(_ text: String) -> [String.Index] {
            Array(text.utf8.indices) + Array(text.utf16.indices) + Array(text.unicodeScalars.indices) + Array(text.indices)
                + [text.endIndex] + (0...text.utf16.count).map { String.Index(utf16Offset: $0, in: text) }
        }
        for (typed, behind) in steps {
            let fields = [typed, NSString(string: typed) as String, String(decoding: Array(typed.utf8), as: UTF8.self)]
            let drafts = [behind, NSString(string: behind) as String, String(decoding: Array(behind.utf8), as: UTF8.self)]
            for field in fields {
                let indices = positions(field)
                for draft in drafts {
                    for index in indices {
                        if let offset = ComposerSelection.characterOffset(index, in: draft) {
                            XCTAssertTrue((0...draft.count).contains(offset), "\(field) → \(draft)")
                        }
                    }
                    for (lower, upper) in zip(indices, indices.reversed()) {
                        if let range = ComposerSelection.offsets(lower..<max(lower, upper), in: draft) {
                            XCTAssertTrue(range.lowerBound >= 0 && range.upperBound <= draft.count, "\(field) → \(draft)")
                        }
                    }
                }
            }
        }
    }

    /// The composer's own path: a selection stored by the field's setter, read back for the draft it was paired with,
    /// while IME composition or a deletion leaves the draft a step behind. It is either dropped or a position in the draft.
    @available(iOS 26.0, *)
    func testAStoredSelectionHeldWhileTheTextChangesIsDroppedOrInRange() {
        let steps: [(field: String, draft: String)] = [
            ("きょう", "きょ"), ("今日は", "きょうは"), ("abc👍 ", "abc👍"), ("abc", "abc👍"), ("", "今日は"), ("👨‍👩‍👧", "👨‍👩"),
        ]
        for (typed, behind) in steps {
            let field = NSString(string: typed) as String
            let draft = String(decoding: Array(behind.utf8), as: UTF8.self)
            let box = ComposerSelection()
            for selection in [TextSelection(insertionPoint: field.endIndex), TextSelection(insertionPoint: field.startIndex),
                              TextSelection(range: field.startIndex..<field.endIndex)] {
                box.raw = selection
                box.text = draft  // the setter ran before the draft caught up
                guard let kept = box.selection(for: draft) else { continue }
                guard case .selection(let range) = kept.indices,
                      let offsets = ComposerSelection.offsets(range, in: draft) else { return XCTFail("\(typed) → \(behind)") }
                XCTAssertTrue(offsets.upperBound <= draft.count, "\(typed) → \(behind)")
                box.text = "別の文"  // replaced while the selection was held
                XCTAssertNil(box.selection(for: draft))
            }
        }
    }

    func testSelectionIndicesInTheirOwnTextGiveCharacterOffsets() {
        let text = "abc あいう😀x"
        func at(_ k: Int) -> String.Index { text.index(text.startIndex, offsetBy: k) }
        XCTAssertEqual(ComposerSelection.offsets(at(0)..<at(0), in: text), 0..<0)
        XCTAssertEqual(ComposerSelection.offsets(at(5)..<at(8), in: text), 5..<8) // after the emoji (two UTF-16 units)
        XCTAssertEqual(ComposerSelection.offsets(at(9)..<at(9), in: text), 9..<9) // the end
        XCTAssertEqual(ComposerSelection.offsets(text.endIndex..<text.endIndex, in: ""), nil)
        XCTAssertEqual(ComposerSelection.offsets("".startIndex..<"".endIndex, in: ""), 0..<0)
    }

    @available(iOS 26.0, *)
    func testAStoredSelectionPastTheEndOfItsTextIsDropped() {
        let box = ComposerSelection()
        let typed = "abc"
        box.raw = TextSelection(insertionPoint: typed.endIndex)
        box.text = "ab" // paired with the wrong text
        XCTAssertNil(box.selection(for: "ab"))
        box.text = typed
        XCTAssertNotNil(box.selection(for: typed))
    }

    /// 見出し (the web's tool, parity audit 2026-09-29): 「## 」 at the start of the line, the cursor keeping its place.
    func testHeadingMarksTheLine() {
        let result = ComposerFormat.heading.apply(to: "今日の予定", selection: 2..<2)
        XCTAssertEqual(result.text, "## 今日の予定")
        XCTAssertEqual(result.selection, 5..<5)
    }
}
