@testable import ChikuwaChat
import XCTest

/// CANVAS.md §25: the others' carets — the `caret` of `canvas_presence`, its throttle, and its place in the text shown.
@MainActor
final class CanvasCaretPresenceTests: XCTestCase {
    private let t0 = Date(timeIntervalSince1970: 1_800_000_000)

    func testACaretThatOnlyMovedGoesOutEveryQuarterSecondAtMostAndTheSameOneEvery20Seconds() {
        var sender = CanvasPresenceSender()
        let a = CanvasCaret(line: 3, column: 2), b = CanvasCaret(line: 3, column: 5), c = CanvasCaret(line: 7, column: 0)
        XCTAssertEqual(sender.next("c1", editing: true, section: "TODO", caret: a, now: t0),
                       CanvasPresenceOut(canvasId: "c1", editing: true, section: "TODO", caret: a))
        XCTAssertNil(sender.next("c1", editing: true, section: "TODO", caret: b, now: t0.addingTimeInterval(0.1))) // too soon
        XCTAssertEqual(sender.next("c1", editing: true, section: "TODO", caret: b, now: t0.addingTimeInterval(0.3))?.caret, b)
        XCTAssertNil(sender.next("c1", editing: true, section: "TODO", caret: b, now: t0.addingTimeInterval(0.6))) // unchanged
        XCTAssertNil(sender.next("c1", editing: true, section: "TODO", caret: b, now: t0.addingTimeInterval(20.2)))
        XCTAssertEqual(sender.next("c1", editing: true, section: "TODO", caret: b, now: t0.addingTimeInterval(20.3))?.caret, b) // the refresh
        // Another heading goes out at once, whatever the caret did.
        XCTAssertEqual(sender.next("c1", editing: true, section: "決定事項", caret: c, now: t0.addingTimeInterval(20.35)),
                       CanvasPresenceOut(canvasId: "c1", editing: true, section: "決定事項", caret: c))
        // A stop carries no caret.
        XCTAssertEqual(sender.next("c1", editing: false, section: nil, caret: c, now: t0.addingTimeInterval(21)),
                       CanvasPresenceOut(canvasId: "c1", editing: false, section: nil, caret: nil))
    }

    func testTheEditorsKeepTheirCaretUntilTheyStopOrExpire() {
        var editors = CanvasEditors()
        editors.note("c1", userId: "u-a", editing: true, section: nil, caret: CanvasCaret(line: 1, column: 4), now: t0)
        XCTAssertEqual(editors.of("c1", now: t0.addingTimeInterval(1)), [CanvasEditingUser(userId: "u-a", section: nil, caret: CanvasCaret(line: 1, column: 4))])
        editors.note("c1", userId: "u-a", editing: true, section: nil, caret: CanvasCaret(line: 2, column: 0), now: t0.addingTimeInterval(2))
        XCTAssertEqual(editors.of("c1", now: t0.addingTimeInterval(3)).first?.caret, CanvasCaret(line: 2, column: 0))
        XCTAssertEqual(editors.of("c1", now: t0.addingTimeInterval(47)), []) // 45 s without a refresh
        editors.note("c1", userId: "u-a", editing: true, section: nil, caret: CanvasCaret(line: 2, column: 0), now: t0.addingTimeInterval(50))
        editors.note("c1", userId: "u-a", editing: false, section: nil, now: t0.addingTimeInterval(51))
        XCTAssertEqual(editors.of("c1", now: t0.addingTimeInterval(51)), [])
    }

    func testFramesCarryTheCaretBothWays() throws {
        let out = try JSON.plainDecoder.decode([String: JSONValue].self,
                                               from: Data(ClientFrame.canvasPresence(canvasId: "c1", editing: true, section: nil, caret: CanvasCaret(line: 2, column: 5)).utf8))
        XCTAssertEqual(out["caret"], .object(["line": .number(2), "column": .number(5)]))
        XCTAssertEqual(out["section"], .null)
        let stop = try JSON.plainDecoder.decode([String: JSONValue].self,
                                                from: Data(ClientFrame.canvasPresence(canvasId: "c1", editing: false, section: nil, caret: CanvasCaret(line: 2, column: 5)).utf8))
        XCTAssertEqual(stop["caret"], .null)

        XCTAssertEqual(ServerFrame.parse(#"{"type":"canvas_presence","canvas_id":"c1","channel_id":"ch","user_id":"u-a","editing":true,"section":"TODO","caret":{"line":4,"column":12}}"#),
                       .canvasPresence(canvasId: "c1", channelId: "ch", userId: "u-a", editing: true, section: "TODO", caret: CanvasCaret(line: 4, column: 12)))
        XCTAssertEqual(ServerFrame.parse(#"{"type":"canvas_presence","canvas_id":"c1","user_id":"u-a","editing":true,"section":null,"caret":null}"#),
                       .canvasPresence(canvasId: "c1", channelId: nil, userId: "u-a", editing: true, section: nil, caret: nil))
        // A caret that is not two whole numbers ≥ 0 is left out; the frame still counts.
        XCTAssertEqual(ServerFrame.parse(#"{"type":"canvas_presence","canvas_id":"c1","user_id":"u-a","editing":true,"caret":{"line":"x"}}"#),
                       .canvasPresence(canvasId: "c1", channelId: nil, userId: "u-a", editing: true, section: nil, caret: nil))
        XCTAssertEqual(ServerFrame.parse(#"{"type":"canvas_presence","canvas_id":"c1","user_id":"u-a","editing":true,"caret":{"line":-1,"column":0}}"#),
                       .canvasPresence(canvasId: "c1", channelId: nil, userId: "u-a", editing: true, section: nil, caret: nil))
        // A stop has no caret.
        XCTAssertEqual(ServerFrame.parse(#"{"type":"canvas_presence","canvas_id":"c1","user_id":"u-a","editing":false,"caret":{"line":1,"column":1}}"#),
                       .canvasPresence(canvasId: "c1", channelId: nil, userId: "u-a", editing: false, section: nil, caret: nil))
    }

    // Mentions: `<@u-bob>` stored, `@bob` shown.
    private let encode: (String) -> String = { $0.replacingOccurrences(of: "@bob", with: "<@u-bob>") }
    private let decode: (String) -> String = { $0.replacingOccurrences(of: "<@u-bob>", with: "@bob") }

    func testMyCaretGoesOutInTheStoredBodysTerms() {
        let shown = "# 議事録\n- [ ] @bob さんの資料"
        let offset = (shown as NSString).length - 3 // before 「の資料」
        XCTAssertEqual(CanvasPresence.storedCaret(shown: shown, offset: offset, encodeLine: encode),
                       CanvasCaret(line: 1, column: ("- [ ] <@u-bob> さん" as NSString).length))
        // In a section, lines count from the section's heading in the body.
        XCTAssertEqual(CanvasPresence.storedCaret(shown: "## TODO\nabc", offset: 9, lineOffset: 6, encodeLine: encode), CanvasCaret(line: 7, column: 1))
        XCTAssertEqual(CanvasPresence.storedCaret(shown: "a\n", offset: 99, encodeLine: encode), CanvasCaret(line: 1, column: 0)) // clamped
    }

    func testTheirCaretIsPlacedOnTheSameLineThroughTheMentionsAndClamped() {
        let stored = "# 議事録\n- [ ] <@u-bob> さんの資料\n短い"
        let shown = "# 議事録\n- [ ] @bob さんの資料\n短い"
        let column = ("- [ ] <@u-bob> さん" as NSString).length
        XCTAssertEqual(CanvasPresence.shownOffset(stored: stored, shown: shown, caret: CanvasCaret(line: 1, column: column), decodeLine: decode),
                       ("# 議事録\n- [ ] @bob さん" as NSString).length)
        // Past the end of the line: its end (their unsaved typing is not here yet).
        XCTAssertEqual(CanvasPresence.shownOffset(stored: stored, shown: shown, caret: CanvasCaret(line: 2, column: 40), decodeLine: decode),
                       (shown as NSString).length)
        XCTAssertNil(CanvasPresence.shownOffset(stored: stored, shown: shown, caret: CanvasCaret(line: 9, column: 0), decodeLine: decode))
        // A section shows lines 6… of the body: a caret above it is not here.
        let body = "a\nb\nc\nd\ne\nf\n## TODO\n- x"
        XCTAssertEqual(CanvasPresence.shownOffset(stored: body, shown: "## TODO\n- x", caret: CanvasCaret(line: 7, column: 2), lineOffset: 6, decodeLine: decode), 10)
        XCTAssertNil(CanvasPresence.shownOffset(stored: body, shown: "## TODO\n- x", caret: CanvasCaret(line: 2, column: 0), lineOffset: 6, decodeLine: decode))
    }

    func testAPersonKeepsTheDesktopsColour() {
        XCTAssertEqual(CanvasPresence.caretColor("u-a"), 0x0090FF) // (117·31 + 45)·31 + 97 = 113929; 113929 mod 8 = 1
        XCTAssertEqual(CanvasPresence.caretColor("u-a"), CanvasPresence.caretColor("u-a"))
        XCTAssertTrue(CanvasPresence.caretColors.contains(CanvasPresence.caretColor("01a16dd5-b7db-7655-be05-9a1b2c3d4e5f")))
    }
}
