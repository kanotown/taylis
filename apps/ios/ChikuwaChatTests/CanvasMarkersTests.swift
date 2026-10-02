import UIKit
import XCTest
@testable import ChikuwaChat

// M83 (docs/CANVAS.md §22.8): the task markers ` <!--task:<id>-->` are never shown and survive editing. The rules against
// apps/shared/canvas_task_markers.json (the desktop and Android read the same cases), then the editor through the save loop.

private let ID1 = "0190a2b4-0000-7000-8000-000000000001"
private let ID2 = "0190a2b4-0000-7000-8000-000000000002"
private func mark(_ id: String) -> String { "<!--task:\(id)-->" }

final class CanvasMarkersFixtureTests: XCTestCase {
    private func fixture() throws -> JSONValue {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("shared/canvas_task_markers.json")
        return try JSONDecoder().decode(JSONValue.self, from: Data(contentsOf: url))
    }

    /// The fixture's ⟦n⟧ as the stand-in it stands for (UTF-16, literal: a stand-in joins the character before it).
    private func standIns(_ text: String) -> String {
        let out = NSMutableString(string: text)
        for n in 0..<10 { out.replaceOccurrences(of: "⟦\(n)⟧", with: CanvasMarkers.standIn(n), options: .literal, range: NSRange(location: 0, length: out.length)) }
        return out as String
    }

    /// `|` taken out as a UTF-16 caret.
    private func caret(_ text: String) -> (String, Int) {
        let ns = standIns(text) as NSString
        let at = ns.range(of: "|", options: .literal).location
        return (ns.replacingCharacters(in: NSRange(location: at, length: 1), with: ""), at)
    }

    func testStrip() throws {
        let cases = try XCTUnwrap(fixture()["strip"]?.arrayValue)
        XCTAssertGreaterThanOrEqual(cases.count, 7)
        for item in cases {
            let text = try XCTUnwrap(item["text"]?.stringValue)
            XCTAssertEqual(CanvasMarkers.strip(text), item["expected"]?.stringValue, text)
        }
    }

    func testBlocksLeaveMarkersOut() throws {
        for item in try XCTUnwrap(fixture()["blocks"]?.arrayValue) {
            let body = try XCTUnwrap(item["body"]?.stringValue)
            let blocks = BodyTokenizer.parseBlocks(body, canvas: true).map(CanvasMarkdownFixtureTests.describe)
            XCTAssertEqual(blocks, item["blocks"]?.arrayValue, item["name"]?.stringValue ?? "?")
        }
        // Messages keep their text as it is (only a canvas has markers).
        XCTAssertEqual(BodyTokenizer.parseBlocks("a " + mark(ID1)).map(CanvasMarkdownFixtureTests.describe),
                       [.object(["kind": .string("paragraph"), "lines": .array([.string("a " + mark(ID1))])])])
    }

    func testEditorHidesAndStoresMarkers() throws {
        let cases = try XCTUnwrap(fixture()["editor"]?.arrayValue)
        XCTAssertGreaterThanOrEqual(cases.count, 5)
        for item in cases {
            let name = item["name"]?.stringValue ?? "?"
            let table = CanvasMarkers.Table()
            let wire = try XCTUnwrap(item["wire"]?.stringValue)
            XCTAssertEqual(table.hide(wire), standIns(try XCTUnwrap(item["shown"]?.stringValue)), name)
            XCTAssertEqual(table.show(standIns(try XCTUnwrap(item["edited"]?.stringValue))), item["expected"]?.stringValue, name)
        }
    }

    func testDeletingBesideAStandIn() throws {
        let cases = try XCTUnwrap(fixture()["delete"]?.arrayValue)
        XCTAssertGreaterThanOrEqual(cases.count, 9)
        for item in cases {
            let raw = try XCTUnwrap(item["text"]?.stringValue)
            guard case .bool(let backward)? = item["backward"] else { return XCTFail("no direction") }
            let (text, at) = caret(raw)
            let out = CanvasMarkers.deleteBeside(text, caret: at, backward: backward)
            if let expected = item["expected"]?.stringValue {
                let (want, wantCaret) = caret(expected)
                XCTAssertEqual(out?.text, want, raw)
                XCTAssertEqual(out?.caret, wantCaret, raw)
            } else {
                XCTAssertNil(out, raw)
            }
        }
    }

    func testTheTableAndTheStandIns() {
        let table = CanvasMarkers.Table()
        // The same id is the same character, in any later text of the same editor.
        XCTAssertEqual(table.hide("a " + mark(ID2)), "a" + CanvasMarkers.standIn(0))
        XCTAssertEqual(table.hide("b " + mark(ID1) + "\nc " + mark(ID2)), "b" + CanvasMarkers.standIn(1) + "\nc" + CanvasMarkers.standIn(0))
        // Past 95 markers they stay as text.
        let many = (0..<96).map { String(format: "- [ ] x <!--task:0190a2b4-0000-7000-8000-%012d-->", $0) }.joined(separator: "\n")
        let shown = CanvasMarkers.Table().hide(many)
        XCTAssertEqual(shown.components(separatedBy: "\n")[94], "- [ ] x" + CanvasMarkers.standIn(94))
        XCTAssertEqual(shown.components(separatedBy: "\n")[95], "- [ ] x <!--task:0190a2b4-0000-7000-8000-000000000095-->")
        // A stand-in is two UTF-16 units and joins the character before it into one grapheme.
        let text = "o" + CanvasMarkers.standIn(0)
        XCTAssertEqual((text as NSString).length, 3)
        XCTAssertEqual(text.count, 1)
        XCTAssertTrue(CanvasMarkers.standInAt(text as NSString, 1))
        XCTAssertFalse(CanvasMarkers.standInAt(text as NSString, 2))
        XCTAssertEqual(CanvasMarkers.stripStandIns("a" + CanvasMarkers.standIn(3) + "b"), "ab")
    }

    /// A stand-in is drawn as nothing: the line is as wide with it as without.
    func testAStandInTakesNoRoom() {
        let font = UIFont.preferredFont(forTextStyle: .body)
        let plain = NSAttributedString(string: "- [ ] 資料を集める", attributes: [.font: font]).size().width
        let hidden = NSAttributedString(string: "- [ ] 資料を集める" + CanvasMarkers.standIn(0) + CanvasMarkers.standIn(1), attributes: [.font: font]).size().width
        XCTAssertEqual(hidden, plain, accuracy: 0.5)
    }
}

// MARK: - the rest of the app

@MainActor
final class CanvasMarkersElsewhereTests: XCTestCase {
    func testHistoryNamesTheTaskKind() {
        XCTAssertEqual(CanvasHistoryModel.kindLabel("task"), "タスクと連動")
        XCTAssertEqual(CanvasHistoryModel.kindLabel("save"), "編集")
    }

    func testMakeTaskStripsTheTitleAndKeepsTheLine() throws {
        let line = "- [ ] 資料を集める 📅 2026-10-09 " + mark(ID1)
        let body = "## TODO\n" + line
        let draft = try XCTUnwrap(TaskRules.canvasTaskInit(canvasId: "c1", body: body, line: 1, channel: nil, users: [:], groups: [:], isAdmin: false))
        XCTAssertEqual(draft.title, "資料を集める")
        XCTAssertEqual(draft.dueOn, "2026-10-09")
        XCTAssertEqual(draft.sourceCanvasExcerpt, "資料を集める 📅 2026-10-09")
        XCTAssertEqual(draft.sourceCanvasLine, line) // raw: the server finds the line as it is
    }

    func testOutlineAndDiffLeaveMarkersOut() {
        XCTAssertEqual(CanvasText.outline("## 見出し " + mark(ID1)).map(\.text), ["見出し"])
        // A version that only added a marker compares as unchanged.
        let before = "- [ ] a"
        let after = "- [ ] a " + mark(ID1)
        let rows = CanvasDiff.rows(CanvasDiff.lines(CanvasMarkers.strip(before), CanvasMarkers.strip(after)))
        XCTAssertEqual(CanvasDiff.counts(rows).added, 0)
        XCTAssertEqual(CanvasDiff.counts(rows).removed, 0)
    }
}

// MARK: - the editor through the save loop

@MainActor
final class CanvasMarkersEditorTests: XCTestCase {
    private var cleanups: [() -> Void] = []

    override func tearDown() async throws {
        for cleanup in cleanups { cleanup() }
        cleanups = []
    }

    private let body = "## TODO\n- [ ] foo <!--task:\(ID1)-->\n- [x] bar <!--task:\(ID2)-->\n\n## メモ\n本文"

    private func editor(body: String? = nil, sectionLine: Int? = nil) async -> (CanvasEditorModel, CanvasSaver, CanvasUITextView) {
        let server = FakeCanvasServer()
        let canvas = server.create(by: "alice", channelId: "lab", body: body ?? self.body)
        let clock = ManualCanvasClock()
        var options = CanvasSaverOptions()
        options.debounce = 2
        let saver = CanvasSaver(id: canvas.id, channelId: "lab", api: FakeCanvasApi(server: server, userId: "bob"), clock: clock, options: options)
        saver.load()
        await saver.settled()
        let model = CanvasEditorModel()
        let tv = CanvasUITextView()
        tv.model = model
        model.textView = tv
        model.attach(saver: saver, store: Store(), sectionLine: sectionLine)
        cleanups.append {
            saver.dispose()
            clock.drain()
        }
        return (model, saver, tv)
    }

    private let s0 = CanvasMarkers.standIn(0)
    private let s1 = CanvasMarkers.standIn(1)

    private func end(of line: Int, _ tv: UITextView) -> Int {
        let lines = tv.text.components(separatedBy: "\n")
        return (lines[0...line].joined(separator: "\n") as NSString).length
    }

    func testShowsStandInsAndStoresTheBodyUnchanged() async {
        let (model, saver, tv) = await editor()
        XCTAssertEqual(tv.text, "## TODO\n- [ ] foo\(s0)\n- [x] bar\(s1)\n\n## メモ\n本文")
        XCTAssertEqual(model.shown, tv.text)
        // Typing after the item: stored with the marker at the end of its line, one space before it.
        let at = end(of: 1, tv)
        tv.selectedRange = NSRange(location: at, length: 0)
        tv.insertText(" を直す")
        model.userChanged(tv.text)
        XCTAssertEqual(saver.text, "## TODO\n- [ ] foo を直す <!--task:\(ID1)-->\n- [x] bar <!--task:\(ID2)-->\n\n## メモ\n本文")
    }

    func testBackspaceAfterAStandInKeepsTheMarkerAndUndoBringsTheCharacterBack() async throws {
        let (model, saver, tv) = await editor()
        let at = end(of: 1, tv)
        tv.selectedRange = NSRange(location: at, length: 0)
        // UIKit's Backspace takes the grapheme: the "o" with its stand-in.
        XCTAssertTrue(model.deletePressed(in: tv, range: NSRange(location: at - 3, length: 3)))
        XCTAssertEqual(tv.text, "## TODO\n- [ ] fo\(s0)\n- [x] bar\(s1)\n\n## メモ\n本文")
        XCTAssertEqual(tv.selectedRange, NSRange(location: at - 1, length: 0))
        XCTAssertEqual(saver.text, "## TODO\n- [ ] fo <!--task:\(ID1)-->\n- [x] bar <!--task:\(ID2)-->\n\n## メモ\n本文")
        // Delete (forward) before the last letter: the letter goes, the caret ends after the stand-in.
        tv.selectedRange = NSRange(location: at - 4, length: 0)
        XCTAssertTrue(model.deletePressed(in: tv, range: NSRange(location: at - 4, length: 3)))
        XCTAssertEqual(tv.text, "## TODO\n- [ ] f\(s0)\n- [x] bar\(s1)\n\n## メモ\n本文")
        // No stand-in beside: the text view's own deletion.
        tv.selectedRange = NSRange(location: 3, length: 0)
        XCTAssertFalse(model.deletePressed(in: tv, range: NSRange(location: 2, length: 1)))
        // A word deleted at once is the text view's.
        let wordEnd = end(of: 2, tv)
        tv.selectedRange = NSRange(location: wordEnd, length: 0)
        XCTAssertFalse(model.deletePressed(in: tv, range: NSRange(location: wordEnd - 5, length: 5)))

        // Both deletions came in one turn of the run loop here, so one undo step takes both back (a person's presses are one each).
        let undo = try XCTUnwrap(tv.undoManager)
        undo.undo()
        model.userChanged(tv.text)
        XCTAssertEqual(tv.text, "## TODO\n- [ ] foo\(s0)\n- [x] bar\(s1)\n\n## メモ\n本文")
        XCTAssertEqual(saver.text, "## TODO\n- [ ] foo <!--task:\(ID1)-->\n- [x] bar <!--task:\(ID2)-->\n\n## メモ\n本文")
    }

    func testCopyLeavesMarkersOutAndACutPastedBackKeepsThem() async {
        let (model, saver, tv) = await editor()
        let lineStart = end(of: 0, tv) + 1
        let lineEnd = end(of: 1, tv) + 1 // with its newline
        tv.selectedRange = NSRange(location: lineStart, length: lineEnd - lineStart)
        tv.copy(nil)
        XCTAssertEqual(UIPasteboard.general.string, "- [ ] foo\n")

        tv.cut(nil)
        XCTAssertEqual(UIPasteboard.general.string, "- [ ] foo\n")
        XCTAssertEqual(tv.text, "## TODO\n- [x] bar\(s1)\n\n## メモ\n本文")
        XCTAssertEqual(saver.text, "## TODO\n- [x] bar <!--task:\(ID2)-->\n\n## メモ\n本文")
        // Pasted at the end of the section: the line keeps its task.
        tv.selectedRange = NSRange(location: end(of: 1, tv) + 1, length: 0)
        tv.paste(nil)
        XCTAssertEqual(tv.text, "## TODO\n- [x] bar\(s1)\n- [ ] foo\(s0)\n\n## メモ\n本文")
        XCTAssertEqual(saver.text, "## TODO\n- [x] bar <!--task:\(ID2)-->\n- [ ] foo <!--task:\(ID1)-->\n\n## メモ\n本文")
        XCTAssertEqual(model.shown, tv.text)

        // Something copied elsewhere afterwards replaces the cut: a plain paste (UIKit's own), no markers.
        UIPasteboard.general.string = "- [ ] baz\n"
        XCTAssertFalse(UIPasteboard.general.contains(pasteboardTypes: [CanvasUITextView.pasteboardType]))
    }

    func testAMergeComingInShowsItsMarkersAsStandIns() async {
        let (model, saver, tv) = await editor(body: "## TODO\n- [ ] foo\n- [ ] bar")
        XCTAssertEqual(tv.text, "## TODO\n- [ ] foo\n- [ ] bar")
        saver.edit("## TODO\n- [ ] foo\n- [ ] bar <!--task:\(ID2)-->", external: true) // the server put a marker in
        model.external()
        XCTAssertEqual(tv.text, "## TODO\n- [ ] foo\n- [ ] bar\(s0)")
        // Swapping the lines takes the marker with its line.
        tv.text = "## TODO\n- [ ] bar\(s0)\n- [ ] foo"
        model.userChanged(tv.text)
        XCTAssertEqual(saver.text, "## TODO\n- [ ] bar <!--task:\(ID2)-->\n- [ ] foo")
    }

    func testTheSectionEditorKeepsMarkersToo() async throws {
        let (model, saver, tv) = await editor(sectionLine: 0)
        XCTAssertEqual(tv.text, "## TODO\n- [ ] foo\(s0)\n- [x] bar\(s1)\n")
        tv.text = "## TODO\n- [ ] foo\(s0)\n- [x] bar\(s1)\n- [ ] baz\n"
        model.userChanged(tv.text)
        XCTAssertEqual(saver.text, "## TODO\n- [ ] foo <!--task:\(ID1)-->\n- [x] bar <!--task:\(ID2)-->\n- [ ] baz\n\n## メモ\n本文")
        // 「タスクにする」 on the item: the stored line, marker and all.
        XCTAssertEqual(model.checklistLine(at: 10), 1)
        XCTAssertNil(model.checklistLine(at: end(of: 2, tv) - 1)) // done
    }
}
