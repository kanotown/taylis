import SwiftUI
import XCTest
@testable import ChikuwaChat

// M57: the canvas table editor (docs/CANVAS.md §17). The rules against apps/shared/canvas_table.json (the desktop and
// Android read the same cases), the editor's 「表」 (open, write back, cancel, someone else's edit meanwhile), and
// snapshots of the full-screen editor.

private struct FixtureTable: Decodable {
    let align: [String?]
    let header: [String]
    let rows: [[String]]

    var table: CanvasTable.Table {
        CanvasTable.Table(align: align.map { $0.flatMap(CanvasTable.Align.init(rawValue:)) }, header: header, rows: rows)
    }
}

private struct Fixture: Decodable {
    struct Parse: Decodable { let lines: [String]; let table: FixtureTable }
    struct Serialize: Decodable { let table: FixtureTable; let lines: [String] }
    struct RoundTrip: Decodable { let lines: [String]; let lines_out: [String] }
    struct Find: Decodable {
        struct Case: Decodable { let caret_line: Int; let range: [Int]? }
        let text: String
        let cases: [Case]
    }
    struct Insert: Decodable { let text: String; let caret_line: Int; let text_out: String; let range: [Int] }
    struct Ops: Decodable {
        struct Case: Decodable {
            let op: String
            let args: [Arg]
            let base: FixtureTable?
            let table: FixtureTable
        }
        let base: FixtureTable
        let cases: [Case]
    }
    enum Arg: Decodable {
        case int(Int), string(String)
        init(from decoder: Decoder) throws {
            let c = try decoder.singleValueContainer()
            if let i = try? c.decode(Int.self) { self = .int(i) } else { self = .string(try c.decode(String.self)) }
        }
        var int: Int { if case .int(let i) = self { return i } else { return -1 } }
        var string: String? { if case .string(let s) = self { return s } else { return nil } }
    }

    let parse: [Parse]
    let serialize: [Serialize]
    let round_trip: [RoundTrip]
    let find: Find
    let insert: [Insert]
    let ops: Ops
}

final class CanvasTableFixtureTests: XCTestCase {
    private func fixture() throws -> Fixture {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("shared/canvas_table.json")
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }

    func testParse() throws {
        let cases = try fixture().parse
        XCTAssertGreaterThanOrEqual(cases.count, 6)
        for c in cases { XCTAssertEqual(CanvasTable.parse(c.lines), c.table.table, "\(c.lines)") }
    }

    func testSerialize() throws {
        let cases = try fixture().serialize
        XCTAssertGreaterThanOrEqual(cases.count, 2)
        for c in cases { XCTAssertEqual(CanvasTable.serialize(c.table.table), c.lines) }
    }

    func testRoundTrip() throws {
        let cases = try fixture().round_trip
        XCTAssertGreaterThanOrEqual(cases.count, 6)
        for c in cases { XCTAssertEqual(CanvasTable.serialize(CanvasTable.parse(c.lines)), c.lines_out, "\(c.lines)") }
    }

    func testFind() throws {
        let find = try fixture().find
        XCTAssertGreaterThanOrEqual(find.cases.count, 8)
        for c in find.cases {
            let range = CanvasTable.findTable(find.text, caretLine: c.caret_line)
            XCTAssertEqual(range.map { [$0.lowerBound, $0.upperBound] }, c.range, "caret line \(c.caret_line)")
        }
    }

    func testInsert() throws {
        for c in try fixture().insert {
            let out = CanvasTable.insertTable(c.text, caretLine: c.caret_line)
            XCTAssertEqual(out.text, c.text_out, c.text)
            XCTAssertEqual([out.range.lowerBound, out.range.upperBound], c.range, c.text)
            // The result is a table where it says, and 「表」 there finds it.
            XCTAssertEqual(CanvasTable.findTable(out.text, caretLine: out.range.lowerBound), out.range)
        }
    }

    func testOps() throws {
        let ops = try fixture().ops
        XCTAssertGreaterThanOrEqual(ops.cases.count, 9)
        for c in ops.cases {
            let base = (c.base ?? ops.base).table
            let a = c.args
            let out: CanvasTable.Table
            switch c.op {
            case "add_row": out = CanvasTable.addRow(base, at: a[0].int)
            case "delete_row": out = CanvasTable.deleteRow(base, at: a[0].int)
            case "move_row": out = CanvasTable.moveRow(base, from: a[0].int, to: a[1].int)
            case "add_column": out = CanvasTable.addColumn(base, at: a[0].int)
            case "delete_column": out = CanvasTable.deleteColumn(base, at: a[0].int)
            case "set_align": out = CanvasTable.setAlign(base, column: a[0].int, a[1].string.flatMap(CanvasTable.Align.init(rawValue:)))
            default: XCTFail("unknown op \(c.op)"); continue
            }
            XCTAssertEqual(out, c.table.table, "\(c.op) \(a)")
        }
    }
}

// MARK: - the session: open from the caret, write back, someone else's edit meanwhile

final class CanvasTableSessionTests: XCTestCase {
    private let body = "# 学会\n\n| 名前 | 締切 |\n| --- | --- |\n| 予稿 | 10/3 |\n\n本文"

    func testOpensTheTableAtTheCaretElseANewOne() {
        let inTable = CanvasTable.open(body, caretLine: 4)
        XCTAssertEqual(inTable.range, 2...4)
        XCTAssertFalse(inTable.isNew)
        XCTAssertEqual(inTable.table.header, ["名前", "締切"])
        XCTAssertEqual(inTable.table.rows, [["予稿", "10/3"]])
        let outside = CanvasTable.open(body, caretLine: 0)
        XCTAssertTrue(outside.isNew)
        XCTAssertEqual(outside.table, CanvasTable.newTable)
    }

    func testWritesTheEditedTableOverItsLines() throws {
        let target = CanvasTable.open(body, caretLine: 3)
        var table = CanvasTable.addRow(target.table, at: 1)
        table.rows[1] = ["旅費", "10/10"]
        table = CanvasTable.setAlign(table, column: 1, .right)
        let out = try XCTUnwrap(CanvasTable.writeBack(target, table: table, into: body))
        XCTAssertEqual(out.text, "# 学会\n\n| 名前 | 締切 |\n| --- | ---: |\n| 予稿 | 10/3 |\n| 旅費 | 10/10 |\n\n本文")
        XCTAssertEqual(out.result, .replaced(2...5))
    }

    func testAnUnchangedTableWritesNothing() {
        let compact = "|a|b|\n|-|-|\n|1|2|"
        let target = CanvasTable.open(compact, caretLine: 0)
        XCTAssertNil(CanvasTable.writeBack(target, table: target.table, into: compact)) // not even 「| a | b |」
    }

    func testANewTableGoesInAfterTheCaretLineAtDone() throws {
        let target = CanvasTable.open(body, caretLine: 0)
        let out = try XCTUnwrap(CanvasTable.writeBack(target, table: CanvasTable.newTable, into: body))
        XCTAssertEqual(out.text, CanvasTable.insertTable(body, caretLine: 0).text)
        XCTAssertEqual(out.result, .inserted(2...5))
    }

    func testFindsTheTableAgainWhenLinesAboveChanged() throws {
        let target = CanvasTable.open(body, caretLine: 2)
        let now = "# 学会\n追記 1\n追記 2\n\n| 名前 | 締切 |\n| --- | --- |\n| 予稿 | 10/3 |\n\n本文"
        let table = CanvasTable.addColumn(target.table, at: 2)
        let out = try XCTUnwrap(CanvasTable.writeBack(target, table: table, into: now))
        XCTAssertEqual(out.result, .replaced(4...6))
        XCTAssertEqual(out.text, "# 学会\n追記 1\n追記 2\n\n| 名前 | 締切 | 列3 |\n| --- | --- | --- |\n| 予稿 | 10/3 |  |\n\n本文")
    }

    func testATableSomeoneElseChangedIsKeptAndMineGoesInAfterIt() throws {
        let target = CanvasTable.open(body, caretLine: 2)
        let theirs = "# 学会\n\n| 名前 | 締切 |\n| --- | --- |\n| 予稿 | 10/5 |\n\n本文"
        var table = target.table
        table.rows[0][0] = "予稿 (第 2 版)"
        let out = try XCTUnwrap(CanvasTable.writeBack(target, table: table, into: theirs))
        XCTAssertEqual(out.result, .inserted(6...8))
        XCTAssertEqual(out.text, "# 学会\n\n| 名前 | 締切 |\n| --- | --- |\n| 予稿 | 10/5 |\n\n| 名前 | 締切 |\n| --- | --- |\n| 予稿 (第 2 版) | 10/3 |\n\n本文")
    }

    func testATableSomeoneElseRemovedComesBackWhereItWas() throws {
        let target = CanvasTable.open(body, caretLine: 2)
        let theirs = "# 学会\n\n本文"
        var table = target.table
        table.header[0] = "項目"
        let out = try XCTUnwrap(CanvasTable.writeBack(target, table: table, into: theirs))
        XCTAssertEqual(out.text, "# 学会\n\n| 項目 | 締切 |\n| --- | --- |\n| 予稿 | 10/3 |\n\n本文")
        XCTAssertEqual(out.result, .inserted(2...4))
    }

    func testCellsAreWrittenOnOneLineWithPipesEscaped() throws {
        let target = CanvasTable.open(body, caretLine: 2)
        var table = target.table
        table.rows[0][0] = "A|B\n続き"
        let out = try XCTUnwrap(CanvasTable.writeBack(target, table: table, into: body))
        XCTAssertTrue(out.text.contains("| A\\|B 続き | 10/3 |"))
        XCTAssertEqual(CanvasTable.parse(Array(out.text.components(separatedBy: "\n")[2...4])).rows[0][0], "A|B 続き")
    }
}

// MARK: - the canvas editor's 「表」 through the save loop

@MainActor
final class CanvasEditorTableTests: XCTestCase {
    private var cleanups: [() -> Void] = []

    override func tearDown() async throws {
        for cleanup in cleanups { cleanup() }
        cleanups = []
    }

    private let body = "# 学会\n\n| 名前 | 締切 |\n| --- | --- |\n| 予稿 | 10/3 |\n\n本文"

    private func editor(body: String? = nil, sectionLine: Int? = nil) async -> (CanvasEditorModel, CanvasSaver, UITextView) {
        let server = FakeCanvasServer()
        let canvas = server.create(by: "alice", channelId: "lab", body: body ?? self.body)
        let clock = ManualCanvasClock()
        var options = CanvasSaverOptions()
        options.debounce = 2
        let saver = CanvasSaver(id: canvas.id, channelId: "lab", api: FakeCanvasApi(server: server, userId: "bob"), clock: clock, options: options)
        saver.load()
        await saver.settled()
        let model = CanvasEditorModel()
        let tv = UITextView()
        model.textView = tv
        model.attach(saver: saver, store: Store(), sectionLine: sectionLine)
        cleanups.append {
            saver.dispose()
            clock.drain()
        }
        return (model, saver, tv)
    }

    private func caret(_ tv: UITextView, line: Int) {
        tv.selectedRange = NSRange(location: CanvasTable.offset(ofLine: line, in: tv.text), length: 0)
    }

    func testOpensTheTableAtTheCaretAndWritesItBackThroughTheSaveLoop() async throws {
        let (model, saver, tv) = await editor()
        caret(tv, line: 4)
        model.openTable()
        let target = try XCTUnwrap(model.table)
        XCTAssertEqual(target.range, 2...4)
        var table = target.table
        table.rows[0][1] = "10/4"
        XCTAssertEqual(model.finishTable(table), .replaced(2...4))
        XCTAssertNil(model.table)
        let expected = "# 学会\n\n| 名前 | 締切 |\n| --- | --- |\n| 予稿 | 10/4 |\n\n本文"
        XCTAssertEqual(tv.text, expected)
        XCTAssertEqual(model.shown, expected)
        XCTAssertEqual(saver.text, expected)
        XCTAssertEqual(saver.status, .editing) // saved once the pause is over, like typing
        XCTAssertEqual(tv.selectedRange.location, CanvasTable.offset(ofLine: 2, in: expected))
    }

    func testANewTableIsInsertedOnlyAtDoneAndCancelChangesNothing() async throws {
        let (model, saver, tv) = await editor()
        caret(tv, line: 6)
        model.openTable()
        XCTAssertEqual(model.table?.isNew, true)
        XCTAssertEqual(saver.text, body) // nothing in the text while the editor is open
        model.cancelTable()
        XCTAssertNil(model.table)
        XCTAssertEqual(tv.text, body)
        XCTAssertEqual(saver.text, body)
        XCTAssertEqual(saver.status, .saved)

        model.openTable()
        XCTAssertEqual(model.finishTable(try XCTUnwrap(model.table).table), .inserted(8...11))
        XCTAssertEqual(saver.text, body + "\n\n| 列1 | 列2 | 列3 |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |")
    }

    func testCancelOnAnExistingTableChangesNothing() async throws {
        let (model, saver, tv) = await editor()
        caret(tv, line: 3)
        model.openTable()
        XCTAssertEqual(model.table?.range, 2...4)
        model.cancelTable()
        XCTAssertEqual(saver.text, body)
        XCTAssertEqual(saver.status, .saved)
    }

    func testSomeoneElsesEditToTheTableMeanwhileIsNotOverwritten() async throws {
        let (model, saver, tv) = await editor() // keep tv: the model holds it weakly
        caret(tv, line: 2)
        model.openTable()
        var table = try XCTUnwrap(model.table).table
        table.rows[0][0] = "本番"
        let theirs = "# 学会\n\n| 名前 | 締切 |\n| --- | --- |\n| 予稿 | 10/5 |\n\n本文"
        saver.edit(theirs, external: true) // a merge the loop took while the table editor was open
        XCTAssertEqual(model.finishTable(table), .inserted(6...8))
        XCTAssertEqual(saver.text, "# 学会\n\n| 名前 | 締切 |\n| --- | --- |\n| 予稿 | 10/5 |\n\n| 名前 | 締切 |\n| --- | --- |\n| 本番 | 10/3 |\n\n本文")
    }

    func testInASectionTheTableIsWrittenIntoTheWholeBody() async throws {
        let full = "# 学会\n\n## 締切\n| 名前 | 締切 |\n| --- | --- |\n| 予稿 | 10/3 |\n\n## 旅費\nあとで"
        let (model, saver, tv) = await editor(body: full, sectionLine: 2)
        XCTAssertEqual(tv.text, "## 締切\n| 名前 | 締切 |\n| --- | --- |\n| 予稿 | 10/3 |\n")
        caret(tv, line: 1)
        model.openTable()
        let table = CanvasTable.deleteRow(try XCTUnwrap(model.table).table, at: 0)
        XCTAssertEqual(model.finishTable(table), .replaced(1...2))
        XCTAssertEqual(saver.text, "# 学会\n\n## 締切\n| 名前 | 締切 |\n| --- | --- |\n\n## 旅費\nあとで")
    }
}

// MARK: - snapshots

/// The table editor, light and dark: the cards (an existing table with an aligned column), the grid, and a new table.
/// Run with TEST_RUNNER_SNAPSHOT_DIR=<dir> to look at them.
@MainActor
final class CanvasTableSnapshotTests: XCTestCase {
    private func render<V: View>(_ view: V, size: CGSize = CGSize(width: 393, height: 852), style: UIUserInterfaceStyle, name: String) throws -> UIImage {
        let scene = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first
        let window = scene.map { UIWindow(windowScene: $0) } ?? UIWindow(frame: CGRect(origin: .zero, size: size))
        window.frame = CGRect(origin: .zero, size: size)
        window.overrideUserInterfaceStyle = style
        let host = UIHostingController(rootView: view)
        host.view.backgroundColor = .systemBackground
        window.rootViewController = host
        window.makeKeyAndVisible()
        host.view.frame = window.bounds
        host.view.layoutIfNeeded()
        RunLoop.current.run(until: Date().addingTimeInterval(0.8))
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { context in
            if !window.drawHierarchy(in: window.bounds, afterScreenUpdates: true) { window.layer.render(in: context.cgContext) }
        }
        window.isHidden = true
        if let dir = ProcessInfo.processInfo.environment["SNAPSHOT_DIR"], let data = image.pngData() {
            let url = URL(fileURLWithPath: dir).appendingPathComponent(name)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: url)
            print("snapshot written: \(url.path)")
        }
        return image
    }

    private let text = """
    ## 学会の締切
    | 項目 | 締切 | 担当 | 金額 |
    | --- | :---: | --- | ---: |
    | 予稿の提出 | 10/3 | 加納 | 0 |
    | 参加登録 (早期割引) | 10/10 | 海老原 | 12,000 |
    | 旅費の申請 | 10/17 | @佐藤 | 48,500 |
    """

    func testTableEditor() throws {
        let existing = CanvasTable.open(text, caretLine: 2)
        XCTAssertEqual(existing.range, 1...5)
        let fresh = CanvasTable.open("本文", caretLine: 0)
        for (style, suffix) in [(UIUserInterfaceStyle.light, "light"), (.dark, "dark")] {
            for (target, layout, name) in [(existing, CanvasTableEditor.Layout.cards, "cards"), (existing, .grid, "grid"), (fresh, .cards, "new")] {
                let image = try render(CanvasTableEditor(target: target, layout: layout, onDone: { _ in }, onCancel: {}),
                                       style: style, name: "canvas-table-\(name)-\(suffix).png")
                XCTAssertGreaterThan(image.size.width, 0)
            }
        }
    }
}
