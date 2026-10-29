import SwiftUI
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

    /// docs/EMOJI.md §9.4: 「よく使う」's rule, the cases shared with the web and Android (apps/shared/emoji-frequent.json).
    func testFrequentEmojiSharedCases() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("shared/emoji-frequent.json")
        let doc = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        XCTAssertEqual((doc["half_life_ms"] as? NSNumber)?.int64Value, EmojiUsage.halfLife)
        XCTAssertEqual(doc["kept"] as? Int, EmojiUsage.kept)
        XCTAssertEqual(doc["rows"] as? Int, EmojiUsage.rows)
        for c in try XCTUnwrap(doc["rank"] as? [[String: Any]]) {
            var usage = EmojiUsage()
            for use in try XCTUnwrap(c["uses"] as? [[Any]]) {
                usage.record(try XCTUnwrap(use[0] as? String), now: try XCTUnwrap(use[1] as? NSNumber).int64Value)
            }
            XCTAssertEqual(usage.frequent, c["ranked"] as? [String], c["name"] as? String ?? "")
        }
        let k = try XCTUnwrap(doc["kept_case"] as? [String: Any])
        var full = EmojiUsage()
        let start = try XCTUnwrap(k["start"] as? NSNumber).int64Value, step = try XCTUnwrap(k["step"] as? NSNumber).int64Value
        for i in 0..<(try XCTUnwrap(k["uses_count"] as? Int)) { full.record("e\(i)", now: start + Int64(i) * step) }
        XCTAssertEqual(full.entries.count, k["count"] as? Int)
        XCTAssertFalse(full.entries.contains { $0.glyph == k["forgotten"] as? String })
        XCTAssertEqual(full.frequent.first, k["first"] as? String)
        for c in try XCTUnwrap(doc["seed"] as? [[String: Any]]) {
            let legacy = try XCTUnwrap(c["legacy"] as? [[String: Any]]).map { ($0["glyph"] as? String ?? "", $0["count"] as? Int) }
            let seeded = EmojiUsage.seed(legacy, now: try XCTUnwrap(c["now"] as? NSNumber).int64Value)
            let expected = try XCTUnwrap(c["entries"] as? [[String: Any]]).map {
                EmojiUsage.Entry(glyph: $0["glyph"] as? String ?? "", score: ($0["score"] as? NSNumber)?.doubleValue ?? 0,
                                 last: ($0["last"] as? NSNumber)?.int64Value ?? 0)
            }
            XCTAssertEqual(seeded.entries, expected, c["name"] as? String ?? "")
        }
        for c in try XCTUnwrap(doc["span"] as? [[String: Any]]) {
            let n = { (key: String) in (c[key] as? NSNumber)?.doubleValue ?? 0 }
            XCTAssertEqual(EmojiUsage.span(pill: n("pill"), cell: n("cell"), gap: n("gap"), columns: c["columns"] as? Int ?? 0), c["span"] as? Int, "\(c)")
        }
        for c in try XCTUnwrap(doc["fill"] as? [[String: Any]]) {
            let items = try XCTUnwrap(c["items"] as? [[String: Any]]).map { ($0["glyph"] as? String ?? "", $0["span"] as? Int ?? 1) }
            let rows = EmojiUsage.fill(items, span: \.1, columns: c["columns"] as? Int ?? 0, rows: c["rows"] as? Int ?? 0)
            XCTAssertEqual(rows.map { $0.map(\.0) }, c["expected"] as? [[String]], c["name"] as? String ?? "")
        }
    }

    /// The stored list starts from what this device kept before (the old counts, else the recent list), and a use is
    /// counted in 「よく使う」 and the quick reactions' recent list alike.
    func testFrequentEmojiStorage() {
        let usage = EmojiUsage(entries: [.init(glyph: "👍", score: 2.5, last: 1_790_000_000_000)])
        XCTAssertEqual(EmojiUsage.decode(usage.encoded), usage)
        XCTAssertEqual(EmojiUsage.decode("", recent: "😂 :party: 👀").frequent, ["😂", ":party:", "👀"])
        XCTAssertEqual(EmojiUsage.decode("{broken", recent: "").frequent, [])
        let old = #"{"entries":[{"glyph":"👀","count":1,"last":9},{"glyph":"👍","count":5,"last":3},{"glyph":"🎉","count":2,"last":7}]}"#
        XCTAssertEqual(EmojiUsage.decode("", legacy: old, recent: "🙏").frequent, ["👍", "🎉", "👀"])

        let defaults = UserDefaults(suiteName: "EmojiUsageTests")!
        defaults.removePersistentDomain(forName: "EmojiUsageTests")
        defaults.set("🎉 👍", forKey: EmojiUsage.recentKey)
        EmojiUsage.note("👍", defaults: defaults, now: 1_790_000_000_000)
        EmojiUsage.note("😂", defaults: defaults, now: 1_790_000_060_000)
        XCTAssertEqual(EmojiUsage.decode(defaults.string(forKey: EmojiUsage.key) ?? "").frequent, ["👍", "😂", "🎉"])
        XCTAssertEqual(defaults.string(forKey: EmojiUsage.recentKey), "😂 👍 🎉")
        defaults.removePersistentDomain(forName: "EmojiUsageTests")
    }

    /// 2026-10-29: 「よく使う」 shows whole rows — 2 × 8 from a longer list, fewer only when there are fewer; a text
    /// emoji's pill takes the cells its width needs (fewer squares come), and a wider list needs fewer for it.
    func testFrequentRowsFillWholeRows() {
        let glyphs = ["😀", "😃", "😄", "😁", "😆", "😅", "🤣", "😂", "🙂", "🙃", "😉", "😊", "😇", "🥰", "😍", "🤩", "😘", "😗"]
        let rows = EmojiPickerLayout.frequentRows(glyphs, byName: [:], width: 393)
        XCTAssertEqual(rows.map(\.items.count), [8, 8])
        XCTAssertEqual(rows.map(\.style), [.spans, .spans])
        XCTAssertEqual(EmojiPickerLayout.frequentRows(Array(glyphs.prefix(5)), byName: [:], width: 393).map(\.items.count), [5])
        // 393 pt: columns of (393 − 32 − 28) / 8 ≈ 41.6 pt, 4 apart; a pill 100 pt wide takes 3.
        let thanks = emoji("t1", "thanks", text: true)
        let withPill = EmojiPickerLayout.frequentRows([":thanks:"] + glyphs, byName: ["thanks": thanks], width: 393, pillWidth: { _ in 100 })
        XCTAssertEqual(withPill.map { $0.spans.reduce(0, +) }, [8, 8])
        XCTAssertEqual(withPill[0].items.first, .custom(thanks))
        XCTAssertEqual(withPill[0].spans, [3, 1, 1, 1, 1, 1])
        XCTAssertEqual(withPill.flatMap(\.items).count, 14)
        // An iPad's wide sheet: columns of about 85 pt, the pill takes 2.
        XCTAssertEqual(EmojiPickerLayout.frequentRows([":thanks:"] + glyphs, byName: ["thanks": thanks], width: 744, pillWidth: { _ in 100 })[0].spans.first, 2)
        // The section uses them.
        let sections = EmojiPickerLayout.sections(frequent: glyphs, custom: [], packs: [], width: 393)
        XCTAssertEqual(sections[0].rows.flatMap(\.items).count, 16)
    }

    /// 2026-10-02 (picking a custom emoji in 「よく使う」 crashed now and then): what the grid draws has each glyph once
    /// (its ForEach ids) and only the custom emoji that exist, whatever the stored usage says.
    @MainActor
    func testFrequentShownSkipsUnknownCustomEmojiAndRepeats() {
        // A stored list with a repeat (written by another build or by hand) and the fallback from a repeating recent list.
        let stored = #"{"entries":[{"glyph":":party:","score":3,"last":3000},{"glyph":"👍","score":2,"last":2000},{"glyph":":party:","score":1,"last":1000},{"glyph":":gone:","score":1,"last":4000},{"glyph":"","score":5,"last":5000}]}"#
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

/// 2026-10-14: a text emoji among the quick reactions (the long-press sheet, 「リアクションの候補」) widens its button into a
/// capsule as wide as its pill, the standard ones stay 44 pt circles, and a row too wide for the phone wraps. It was
/// drawn small to fit the circle, and a long label's 10 pt floor spilled over its neighbours. Run with
/// TEST_RUNNER_SNAPSHOT_DIR=<dir> to look at them.
@MainActor
final class QuickReactionLayoutTests: XCTestCase {
    private func world() -> AppController {
        let controller = AppController()
        let store = controller.store
        let pill = { (id: String, name: String, label: String, color: String) in
            CustomEmojiOut(id: id, name: name, contentType: "", width: 0, height: 0, createdBy: "u", createdAt: "", kind: "text", label: label, color: color)
        }
        let rows = [pill("t1", "thanks", "ありがとうございます", "green"), pill("t2", "ok", "了解", "blue"),
                    CustomEmojiOut(id: "w1", name: "banner", contentType: "image/png", width: 96, height: 32, createdBy: "u", createdAt: "")]
        store.replaceCustomEmoji(rows)
        for row in rows where row.isText { store.emojiImages[row.id] = CustomEmoji.textPill(row, dark: false) }
        store.emojiImages["w1"] = UIGraphicsImageRenderer(size: CGSize(width: 96, height: 32)).image { context in
            UIColor.systemOrange.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 96, height: 32))
        }
        return controller
    }

    private func face(_ controller: AppController, _ emoji: String) -> some View {
        QuickReactionFace(wide: QuickReactions.isWide(emoji, store: controller.store), fill: Color(.secondarySystemBackground)) {
            QuickReactionGlyph(controller: controller, emoji: emoji)
        }
    }

    private func row(_ controller: AppController, _ emoji: [String]) -> some View {
        QuickReactionsRow {
            ForEach(emoji, id: \.self) { self.face(controller, $0) }
            Image(systemName: "face.smiling").font(.system(size: 22)).frame(width: 44, height: 44)
                .background(Color(.secondarySystemBackground), in: Circle())
        }
    }

    private func fitting(_ view: some View, width: CGFloat = .infinity) -> CGSize {
        UIHostingController(rootView: view).sizeThatFits(in: CGSize(width: width, height: .infinity))
    }

    private func snapshot(_ view: some View, width: CGFloat, name: String) throws {
        let renderer = ImageRenderer(content: view.frame(width: width).padding(.vertical, 12).background(Color(.systemBackground))
            .environment(\.colorScheme, .light))
        renderer.scale = 3
        let image = try XCTUnwrap(renderer.uiImage)
        XCTAssertGreaterThan(image.size.height, 0)
        if let dir = ProcessInfo.processInfo.environment["SNAPSHOT_DIR"], let data = image.pngData() {
            let url = URL(fileURLWithPath: dir).appendingPathComponent(name)
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: url)
            print("snapshot written: \(url.path)")
        }
    }

    func testDrawnHeight() {
        XCTAssertEqual(QuickReactionGlyph.drawnHeight(natural: 26, isText: false), 26)
        XCTAssertEqual(QuickReactionGlyph.drawnHeight(natural: 78, isText: false), 12, "a 3:1 image inside the circle")
        XCTAssertEqual(QuickReactionGlyph.drawnHeight(natural: 190, isText: true), 26, "a pill keeps its height")
        XCTAssertEqual(QuickReactionGlyph.drawnHeight(natural: 260, isText: true), 20, "a longer one is scaled down to 200 pt")
    }

    func testATextEmojiWidensItsButtonAndTheRowWraps() throws {
        let controller = world()
        let thanks = CustomEmoji.size(of: try XCTUnwrap(controller.store.customEmoji["thanks"]), height: 26).width
        XCTAssertGreaterThan(thanks, 44, "the label is wider than the circle")

        XCTAssertEqual(fitting(face(controller, "👍")), CGSize(width: 44, height: 44), "a standard emoji: the circle")
        XCTAssertEqual(fitting(face(controller, ":banner:")), CGSize(width: 44, height: 44), "a wide image: inside the circle")
        let wide = fitting(face(controller, ":thanks:"))
        XCTAssertEqual(wide.height, 44)
        XCTAssertEqual(wide.width, min(thanks, QuickReactionGlyph.pillMaxWidth) + 18, accuracy: 0.5, "as wide as the pill and its margins")

        // Six and 「その他」 in a 393 pt sheet: the standard ones fit, with the long pill they wrap.
        let long = [":thanks:", "👍", "❤️", "😂", ":banner:", "🎉"]
        XCTAssertGreaterThanOrEqual(fitting(row(controller, long), width: 393).height, 98, "two lines")
        XCTAssertLessThanOrEqual(fitting(row(controller, long), width: 393).width, 393)
        XCTAssertEqual(fitting(row(controller, ["👍", "❤️", "😂", ":banner:", "🎉", "🙏"]), width: 393).height, 44, "one line")
        // 「リアクションの候補」 (a 313 pt row): a short pill keeps the six on one line, a long one wraps them.
        let short = [":ok:", "👍", "❤️", "😂", ":banner:", "🎉"]
        XCTAssertEqual(fitting(QuickReactionSlots(controller: controller, row: short) { _ in }, width: 313).height, 44, "one line")
        XCTAssertGreaterThanOrEqual(fitting(QuickReactionSlots(controller: controller, row: long) { _ in }, width: 313).height, 98, "two lines")

        try snapshot(row(controller, long), width: 393, name: "ios-sheet-row-long.png")
        try snapshot(row(controller, short), width: 393, name: "ios-sheet-row-short.png")
        try snapshot(QuickReactionSlots(controller: controller, row: long) { _ in }.padding(.horizontal, 20), width: 353, name: "ios-slots-long.png")
        try snapshot(QuickReactionSlots(controller: controller, row: short) { _ in }.padding(.horizontal, 20), width: 353, name: "ios-slots-short.png")
        try snapshot(QuickReactionSlots(controller: controller, row: ["👍", "❤️", "😂"]) { _ in }.padding(.horizontal, 20), width: 353, name: "ios-slots-standard.png")
    }
}
