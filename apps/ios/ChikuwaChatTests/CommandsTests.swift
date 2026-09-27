import XCTest
@testable import ChikuwaChat

final class CommandsTests: XCTestCase {
    func testParsesACommandAndItsArguments() {
        XCTAssertEqual(SlashCommands.parse("/status 🏖 休暇中"), .init(name: "status", args: "🏖 休暇中", known: true))
        XCTAssertEqual(SlashCommands.parse("  /LEAVE "), .init(name: "leave", args: "", known: true))
        XCTAssertEqual(SlashCommands.parse("/foo bar"), .init(name: "foo", args: "bar", known: false))
        XCTAssertNil(SlashCommands.parse("hello /me"))
        XCTAssertNil(SlashCommands.parse("/"))
        XCTAssertNil(SlashCommands.parse("/path/to/file"))
    }

    func testSuggestsCommandsWhileTheNameIsTyped() {
        XCTAssertEqual(SlashCommands.candidates("/").count, 13)
        XCTAssertEqual(SlashCommands.candidates("/s").map(\.name), ["status", "shrug"])
        XCTAssertEqual(SlashCommands.candidates("/status "), [])
        XCTAssertEqual(SlashCommands.candidates("text /s"), [])
    }

    func testReadsDurationsAndStatusEmoji() {
        let now = Date(timeIntervalSince1970: 1_790_000_000)
        XCTAssertEqual(SlashCommands.duration("30m", now: now), now.addingTimeInterval(1800))
        XCTAssertEqual(SlashCommands.duration("2h", now: now), now.addingTimeInterval(7200))
        XCTAssertEqual(SlashCommands.duration("tomorrow", now: now), SlashCommands.tomorrowMorning(now: now))
        XCTAssertEqual(Calendar.current.component(.hour, from: SlashCommands.tomorrowMorning(now: now)), 8)
        XCTAssertNil(SlashCommands.duration("soon", now: now))
        XCTAssertEqual(SlashCommands.splitStatus("🏖 休暇中").emoji, "🏖")
        XCTAssertEqual(SlashCommands.splitStatus("🏖 休暇中").text, "休暇中")
        XCTAssertEqual(SlashCommands.splitStatus(":coffee: 休憩").emoji, "☕")
        XCTAssertNil(SlashCommands.splitStatus("会議中").emoji)
        XCTAssertEqual(SlashCommands.splitStatus("会議中").text, "会議中")
        XCTAssertEqual(SlashCommands.splitStatus("👩‍💻").emoji, "👩‍💻")
    }
}
