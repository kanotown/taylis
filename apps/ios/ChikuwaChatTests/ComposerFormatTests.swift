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
    }

    /// 見出し (the web's tool, parity audit 2026-09-29): 「## 」 at the start of the line, the cursor keeping its place.
    func testHeadingMarksTheLine() {
        let result = ComposerFormat.heading.apply(to: "今日の予定", selection: 2..<2)
        XCTAssertEqual(result.text, "## 今日の予定")
        XCTAssertEqual(result.selection, 5..<5)
    }
}
