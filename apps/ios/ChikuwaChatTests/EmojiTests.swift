import XCTest
@testable import ChikuwaChat

final class EmojiTests: XCTestCase {
    func testReplacesKnownShortcodesOnly() {
        XCTAssertEqual(Emoji.replaceShortcodes("done :tada: :+1:"), "done 🎉 👍")
        XCTAssertEqual(Emoji.replaceShortcodes("time is 10:30 and :unknown_thing: stays"), "time is 10:30 and :unknown_thing: stays")
        XCTAssertEqual(Emoji.replaceShortcodes("no colons"), "no colons")
        XCTAssertEqual(Emoji.byShortcode("bento")?.glyph, "🍱")
    }

    /// MOBILE_POLISH.md C10: 「よく使う」 is the most used first, the latest among equals; it starts from the recent list.
    func testFrequentEmojiRanksByUseThenRecency() {
        var usage = EmojiUsage()
        XCTAssertEqual(usage.frequent, [])
        for glyph in ["👍", "🎉", "👍", "❤️", "🎉", "👍"] { usage.record(glyph) }
        XCTAssertEqual(usage.frequent, ["👍", "🎉", "❤️"])
        usage.record("❤️")
        usage.record("❤️") // 3 uses, as 👍, and later
        XCTAssertEqual(usage.frequent, ["❤️", "👍", "🎉"])
        usage.record("")
        XCTAssertEqual(usage.entries.count, 3)

        // Stored and read back; an unreadable value starts from 「emoji.recent」 (newest first), once each.
        XCTAssertEqual(EmojiUsage.decode(usage.encoded), usage)
        XCTAssertEqual(EmojiUsage.decode("", recent: "😂 :party: 👀").frequent, ["😂", ":party:", "👀"])
        XCTAssertEqual(EmojiUsage.decode("{broken", recent: "").frequent, [])

        // Past the limit the least used go; what was just used stays.
        var full = EmojiUsage()
        full.record("⭐️")
        full.record("⭐️")
        for index in 0..<EmojiUsage.kept { full.record("e\(index)") }
        XCTAssertEqual(full.entries.count, EmojiUsage.kept)
        XCTAssertEqual(full.frequent.first, "⭐️")
        XCTAssertTrue(full.entries.contains { $0.glyph == "e\(EmojiUsage.kept - 1)" })
        XCTAssertFalse(full.entries.contains { $0.glyph == "e0" })
        XCTAssertEqual(full.frequent.count, EmojiUsage.shown)

        // A quick reaction counts in the stored usage (per device: UserDefaults).
        let defaults = UserDefaults(suiteName: "EmojiUsageTests")!
        defaults.removePersistentDomain(forName: "EmojiUsageTests")
        defaults.set("🎉 👍", forKey: EmojiUsage.recentKey)
        EmojiUsage.note("👍", defaults: defaults)
        XCTAssertEqual(EmojiUsage.decode(defaults.string(forKey: EmojiUsage.key) ?? "").frequent, ["👍", "🎉"])
        defaults.removePersistentDomain(forName: "EmojiUsageTests")
    }

    func testQueryAndCompletion() {
        XCTAssertEqual(Emoji.query("hello :ta"), "ta")
        XCTAssertNil(Emoji.query("hello :t"))
        XCTAssertNil(Emoji.query("10:30"))
        XCTAssertEqual(Emoji.query("(:sm"), "sm")
        XCTAssertNil(Emoji.query("hello :tada: done"))
        XCTAssertEqual(Emoji.complete("hi :tad", glyph: "🎉"), "hi 🎉 ")
        XCTAssertEqual(Emoji.candidates("ta").first?.shortcode.hasPrefix("ta"), true)
        XCTAssertEqual(Emoji.candidates("弁当").first?.glyph, "🍱")
        XCTAssertTrue(Emoji.search("").count > 200)
        XCTAssertTrue(Emoji.search("乾杯").map(\.glyph).contains("🍻"))
    }
}
