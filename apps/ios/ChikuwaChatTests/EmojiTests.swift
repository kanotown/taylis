import UIKit
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

    /// 2026-10-02 (picking a custom emoji in 「よく使う」 crashed now and then): what the grid draws has each glyph once
    /// (its ForEach ids) and only the custom emoji that exist, whatever the stored usage says.
    @MainActor
    func testFrequentShownSkipsUnknownCustomEmojiAndRepeats() {
        // A stored list with a repeat (written by another build or by hand) and the fallback from a repeating recent list.
        let stored = #"{"entries":[{"glyph":":party:","count":3,"last":3},{"glyph":"👍","count":2,"last":2},{"glyph":":party:","count":1,"last":1},{"glyph":":gone:","count":1,"last":4},{"glyph":"","count":5,"last":5}]}"#
        let frequent = EmojiUsage.decode(stored).frequent
        XCTAssertEqual(EmojiUsage.shown(frequent, customNames: ["party"]), [":party:", "👍"])
        XCTAssertEqual(EmojiUsage.shown(EmojiUsage.decode("", recent: "🎉 :party: 🎉").frequent, customNames: ["party"]), ["🎉", ":party:"])
        // The custom list not loaded yet (or another workspace's): standard emoji only.
        XCTAssertEqual(EmojiUsage.shown(frequent, customNames: []), ["👍"])

        // A custom emoji list with a name twice no longer traps (Dictionary(uniqueKeysWithValues:)).
        let store = Store()
        let row = { (id: String) in CustomEmojiOut(id: id, name: "party", contentType: "image/png", width: 32, height: 32, createdBy: "u", createdAt: "") }
        store.replaceCustomEmoji([row("a"), row("b")])
        XCTAssertEqual(store.customEmoji["party"]?.id, "b")
    }

    /// Review v0.1.37 #7: a text emoji changed (or removed) while offline, its emoji.updated missed: the bootstrap's list
    /// drops the drawn pill so it is drawn again with the new label and colour, like the event would. Unchanged ones keep theirs.
    @MainActor func testABootstrapListDropsTheImagesItChanged() {
        func emoji(_ id: String, _ name: String, kind: String = "text", label: String? = "承認", color: String? = "#2e7d32", packId: String? = nil) -> CustomEmojiOut {
            CustomEmojiOut(id: id, name: name, contentType: kind == "text" ? "" : "image/png", width: 32, height: 32, createdBy: "u", createdAt: "",
                           kind: kind, label: label, color: color, packId: packId)
        }
        let drawn = UIImage()
        let store = Store()
        store.replaceCustomEmoji([emoji("t1", "ok"), emoji("t2", "same"), emoji("t3", "gone"), emoji("i1", "pic", kind: "image", label: nil, color: nil),
                                  emoji("t4", "moved")])
        for id in ["t1", "t2", "t3", "i1", "t4"] { store.emojiImages[id] = drawn }
        store.replaceCustomEmoji([emoji("t1", "ok", label: "差戻し", color: "#c62828"), emoji("t2", "same"),
                                  emoji("i1", "pic", kind: "image", label: nil, color: nil), emoji("t4", "moved", packId: "p1")])
        XCTAssertEqual(store.customEmoji["ok"]?.label, "差戻し")
        XCTAssertNil(store.emojiImages["t1"]) // label and colour changed: drawn again
        XCTAssertNil(store.emojiImages["t3"]) // removed
        XCTAssertTrue(store.emojiImages["t2"] === drawn) // unchanged
        XCTAssertTrue(store.emojiImages["i1"] === drawn) // an image emoji keeps its picture
        XCTAssertTrue(store.emojiImages["t4"] === drawn) // only its pack moved: the pill looks the same
        // a kind change swaps pill and picture
        store.replaceCustomEmoji([emoji("t2", "same", kind: "image", label: nil, color: nil)])
        XCTAssertNil(store.emojiImages["t2"])
        // the event path agrees
        store.replaceCustomEmoji([emoji("t5", "ev")])
        store.emojiImages["t5"] = drawn
        store.applyCustomEmoji(emoji("t5", "ev", color: "#000000"), deleted: false)
        XCTAssertNil(store.emojiImages["t5"])
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
