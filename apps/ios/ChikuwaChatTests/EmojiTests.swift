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
    /// Review v0.1.37 (iOS test note): a reaction chip reads its emoji (a custom one by its label, else its name) and its count.
    @MainActor func testReactionChipLabels() {
        XCTAssertEqual(ReactionChipLabel.text("👍", count: 2, custom: nil), "👍、2 人がリアクション")
        let pill = CustomEmojiOut(id: "t", name: "ok", contentType: "", width: 32, height: 32, createdBy: "u", createdAt: "", kind: "text", label: "承認")
        XCTAssertEqual(ReactionChipLabel.text(":ok:", count: 1, custom: pill), "承認、1 人がリアクション")
        let plain = CustomEmojiOut(id: "i", name: "parrot", contentType: "image/png", width: 32, height: 32, createdBy: "u", createdAt: "")
        XCTAssertEqual(ReactionChipLabel.text(":parrot:", count: 3, custom: plain), "parrot、3 人がリアクション")
        XCTAssertEqual(ReactionChipLabel.text(":gone:", count: 1, custom: nil), "gone、1 人がリアクション")
    }

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

    // MARK: - The picker's one scrolling list (docs/EMOJI.md §9)

    private func emoji(_ id: String, _ name: String, pack: String? = nil, position: Int? = nil, text: Bool = false) -> CustomEmojiOut {
        CustomEmojiOut(id: id, name: name, contentType: text ? "" : "image/png", width: 32, height: 32, createdBy: "u", createdAt: "",
                       kind: text ? "text" : "image", label: text ? name : nil, packId: pack, position: position)
    }

    private func pack(_ id: String, _ name: String) -> EmojiPackOut {
        EmojiPackOut(id: id, name: name, position: 0, createdAt: "", updatedAt: "")
    }

    /// 「よく使う」, 「カスタム」, the packs, then the standard categories; empty ones left out; rows of 8 (a pack's of 4).
    func testPickerSectionsOrderAndRows() {
        let custom = [emoji("c2", "zeta"), emoji("c1", "alpha"), emoji("t1", "thanks", text: true),
                      emoji("p2", "bow", pack: "P", position: 2), emoji("p1", "hi", pack: "P", position: 1),
                      emoji("o1", "orphan", pack: "gone")]
        let sections = EmojiPickerLayout.sections(frequent: ["👍", ":alpha:", "🎉"], custom: custom,
                                                  packs: [pack("P", "はんぺん"), pack("E", "空")])
        let standard = EmojiData.categories.map(\.key)
        XCTAssertEqual(sections.map(\.id), ["frequent", "custom", "pack:P"] + standard)
        XCTAssertEqual(sections[0].rows.flatMap(\.items),
                       [.glyph("👍", shortcode: "+1"), .custom(custom[1]), .glyph("🎉", shortcode: "tada")])
        // 「カスタム」: the text one as a row of pills, then the images by name (an unknown pack's too).
        XCTAssertEqual(sections[1].rows.map(\.style), [.chips, .cells])
        XCTAssertEqual(sections[1].rows[0].items, [.custom(custom[2])])
        XCTAssertEqual(sections[1].rows[1].items, [.custom(custom[1]), .custom(custom[5]), .custom(custom[0])])
        XCTAssertEqual(sections[2].pack?.id, "P")
        XCTAssertEqual(sections[2].rows.map(\.style), [.big])
        XCTAssertEqual(sections[2].rows[0].items, [.custom(custom[4]), .custom(custom[3])])
        // Every standard emoji once, in its category, 8 to a row; row ids unique.
        let smileys = sections[3]
        let count = EmojiData.all.filter { $0.category == "smileys" }.count
        XCTAssertEqual(smileys.rows.count, (count + 7) / 8)
        XCTAssertTrue(smileys.rows.dropLast().allSatisfy { $0.items.count == 8 })
        let rows = sections.flatMap(\.rows)
        XCTAssertEqual(rows.count, Set(rows.map(\.id)).count)
        XCTAssertEqual(sections.dropFirst(3).flatMap(\.rows).flatMap(\.items).count, EmojiData.all.count)
        // Nothing used, no custom emoji: the standard categories alone, starting with 顔.
        XCTAssertEqual(EmojiPickerLayout.sections(frequent: [], custom: [], packs: []).map(\.id), standard)
        // A pack row holds 4.
        let many = (0..<9).map { emoji("q\($0)", "q\($0)", pack: "P", position: $0) }
        XCTAssertEqual(EmojiPickerLayout.sections(frequent: [], custom: many, packs: [pack("P", "P")])[0].rows.map(\.items.count), [4, 4, 1])
    }

    /// The highlighted section is that of the first row showing below the pinned header.
    func testPickerActiveSectionFollowsTheTopRow() {
        typealias F = EmojiPickerLayout.RowFrame
        let frames = [F(section: "people", minY: 108, maxY: 148), F(section: "smileys", minY: -12, maxY: 28),
                      F(section: "smileys", minY: 28, maxY: 68), F(section: "people", minY: 68, maxY: 108)]
        XCTAssertEqual(EmojiPickerLayout.activeSection(frames, top: 28), "smileys")
        // The last 顔 row has gone under the header: 人・手.
        XCTAssertEqual(EmojiPickerLayout.activeSection([F(section: "smileys", minY: -12, maxY: 28), frames[3], frames[0]], top: 28), "people")
        XCTAssertNil(EmojiPickerLayout.activeSection([], top: 28))
    }

    /// A tap highlights its section at once; the sections passed on the way do not flicker; scrolling follows again.
    func testPickerHighlightDuringAJump() {
        var highlight = EmojiPickerHighlight(active: nil)
        highlight.observe("frequent")
        XCTAssertEqual(highlight.active, "frequent")
        highlight.jump(to: "food")
        XCTAssertEqual(highlight.active, "food")
        for passing in ["smileys", "people", "nature"] {
            highlight.observe(passing)
            XCTAssertEqual(highlight.active, "food")
        }
        highlight.observe("food") // arrived
        highlight.settle()
        highlight.observe("travel")
        XCTAssertEqual(highlight.active, "travel")

        // 旗 is too short to reach the top: the list stops in 記号; 旗 stays highlighted until the list moves on.
        highlight.jump(to: "flags")
        highlight.observe("objects")
        highlight.observe("symbols")
        highlight.settle()
        XCTAssertEqual(highlight.active, "flags")
        highlight.observe("symbols")
        XCTAssertEqual(highlight.active, "flags")
        highlight.observe("objects")
        XCTAssertEqual(highlight.active, "objects")

        // The person scrolls during a jump: follow the list.
        highlight.jump(to: "smileys")
        highlight.observe("activities")
        highlight.userScrolled()
        XCTAssertEqual(highlight.active, "activities")
        highlight.observe("travel")
        XCTAssertEqual(highlight.active, "travel")
    }
}
