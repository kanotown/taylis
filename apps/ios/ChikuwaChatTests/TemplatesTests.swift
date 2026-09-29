import XCTest
@testable import ChikuwaChat

/// M30: templates' placeholders, their order, and /日程, against apps/shared/templates.json (the web and Android read the
/// same file).
final class TemplatesTests: XCTestCase {
    private struct Vectors: Decodable {
        struct Expand: Decodable { let name: String; let today: String; let input: String; let output: String }
        struct Schedule: Decodable { let name: String; let today: String; let args: String; let question: String; let options: [String] }
        struct Failure: Decodable { let name: String; let today: String; let args: String }
        struct Weekdays: Decodable { let name: String; let today: String; let options: [String] }
        let expand: [Expand]
        let schedule: [Schedule]
        let scheduleErrors: [Failure]
        let weekdays: [Weekdays]
    }

    private func vectors() throws -> Vectors {
        // The repository's own file (the simulator reads the Mac's disk).
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("shared/templates.json")
        return try JSON.snakeDecoder.decode(Vectors.self, from: Data(contentsOf: url))
    }

    private func day(_ text: String) throws -> Templates.Day {
        let parts = text.split(separator: "-").compactMap { Int($0) }
        return try XCTUnwrap(Templates.Day.make(parts[0], parts[1], parts[2]))
    }

    func testSharedVectors() throws {
        let vectors = try vectors()
        XCTAssertFalse(vectors.expand.isEmpty)
        for c in vectors.expand {
            XCTAssertEqual(Templates.expand(c.input, today: try day(c.today)), c.output, c.name)
        }
        for c in vectors.schedule {
            let result = Templates.parseSchedule(c.args, today: try day(c.today))
            XCTAssertEqual(result, Templates.Schedule(question: c.question, options: c.options), c.name)
        }
        for c in vectors.scheduleErrors {
            XCTAssertNil(Templates.parseSchedule(c.args, today: try day(c.today)), c.name)
        }
        for c in vectors.weekdays {
            XCTAssertEqual(Templates.nextWeekdays(after: try day(c.today)), c.options, c.name)
        }
    }

    private func template(_ name: String, scope: String = "workspace", suggestIn: String = "any", position: Int = 0) -> TemplateOut {
        TemplateOut(id: "\(scope)-\(name)", scope: scope, ownerId: scope == "user" ? "me" : nil, name: name, body: "**\(name)** {date}\n- ",
                    suggestIn: suggestIn, position: position, createdAt: "2026-09-29T00:00:00Z", updatedAt: "2026-09-29T00:00:00Z")
    }

    func testOrderLookupAndInsertion() {
        let rows = [template("週報", position: 1), template("日報", suggestIn: "times", position: 0), template("メモ", scope: "user"),
                    template("日報", scope: "user", position: 3)]
        XCTAssertEqual(Templates.ordered(rows, inTimes: false).map(\.id), ["workspace-日報", "workspace-週報", "user-メモ", "user-日報"])
        // In a times channel the ones for times come first.
        XCTAssertEqual(Templates.ordered([template("週報"), template("日報", suggestIn: "times", position: 5)], inTimes: true).map(\.name),
                       ["日報", "週報"])
        // `/name` in any case; mine wins over the workspace's.
        XCTAssertEqual(Templates.named("日報", in: rows)?.scope, "user")
        XCTAssertEqual(Templates.named("週報", in: rows)?.scope, "workspace")
        XCTAssertNil(Templates.named("議事録", in: rows))
        XCTAssertEqual(Templates.candidates(prefix: "日", in: rows, inTimes: false).map(\.id), ["workspace-日報", "user-日報"])
        XCTAssertEqual(Templates.summary("\n**日報 {date}**\n- "), "日報 {date}")
        XCTAssertEqual(Templates.inserted("B", into: "  \n"), "B")
        XCTAssertEqual(Templates.inserted("B", into: "A"), "A\n\nB")
    }

    func testCommandNamesInAnyScript() {
        XCTAssertEqual(SlashCommands.parse("/日報"), SlashCommands.Parsed(name: "日報", args: "", known: false))
        XCTAssertEqual(SlashCommands.parse("/日程 ゼミ 10/3 10/4"), SlashCommands.Parsed(name: "日程", args: "ゼミ 10/3 10/4", known: true))
        XCTAssertEqual(SlashCommands.parse("/Poll a | b | c")?.name, "poll")
        XCTAssertEqual(SlashCommands.typedPrefix("/日"), "日")
        XCTAssertNil(SlashCommands.typedPrefix("/日報 "))
        XCTAssertEqual(SlashCommands.candidates("/日").map(\.name), ["日程"])
        XCTAssertNil(SlashCommands.parse("/usr/bin は"))
    }
}
