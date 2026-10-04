import SwiftUI
import XCTest
@testable import ChikuwaChat

final class CustomEmojiTests: XCTestCase {
    func testExactNamesAndSplitting() {
        XCTAssertEqual(CustomEmoji.name(of: ":party_parrot:"), "party_parrot")
        XCTAssertNil(CustomEmoji.name(of: ":party parrot:"))
        XCTAssertNil(CustomEmoji.name(of: "🎉"))
        let known: Set<String> = ["party_parrot", "ok"]
        XCTAssertEqual(CustomEmoji.split("done :ok: and :party_parrot:!", known: { known.contains($0) }),
                       [.text("done "), .emoji("ok"), .text(" and "), .emoji("party_parrot"), .text("!")])
        XCTAssertEqual(CustomEmoji.split("plain :unknown: text", known: { known.contains($0) }), [.text("plain :unknown: text")])
        XCTAssertEqual(CustomEmoji.split("no colons", known: { known.contains($0) }), [.text("no colons")])
    }

    /// 2026-10-02: a custom emoji in a status showed as its `:name:`. The status views draw the one that exists as its
    /// image; a standard emoji, an unknown name or a longer text stays text.
    func testStatusEmojiFindsTheCustomEmoji() {
        let party = CustomEmojiOut(id: "e1", name: "party_parrot", contentType: "image/gif", width: 32, height: 32, createdBy: "u", createdAt: "")
        let custom = ["party_parrot": party]
        XCTAssertEqual(StatusGlyph.custom(":party_parrot:", in: custom), party)
        XCTAssertEqual(StatusGlyph.custom(" :party_parrot: ", in: custom), party)
        XCTAssertNil(StatusGlyph.custom("🎉", in: custom))
        XCTAssertNil(StatusGlyph.custom(":gone:", in: custom))
        XCTAssertNil(StatusGlyph.custom(":party_parrot: 会議中", in: custom))
        XCTAssertNil(StatusGlyph.custom(":party_parrot:", in: [:]))
        // The DM header and the directory join the status into a line: the custom emoji is a piece of its own there.
        XCTAssertEqual(CustomEmoji.split("オンライン · :party_parrot: 会議中", known: { custom[$0] != nil }),
                       [.text("オンライン · "), .emoji("party_parrot"), .text(" 会議中")])
    }

    /// 2026-10-02: until its image came, a custom emoji in a message was its `:name:`, wider than the image: the line
    /// re-wrapped and the row grew or shrank as the channel opened. Its place now takes the image's size from the start.
    @MainActor
    func testPlaceholderTakesTheImagesSize() {
        let wide = CustomEmojiOut(id: "e2", name: "wide", contentType: "image/png", width: 64, height: 32, createdBy: "u", createdAt: "")
        XCTAssertEqual(CustomEmoji.size(of: wide, height: 20), CGSize(width: 40, height: 20))
        let custom = ["wide": wide]
        let image = UIGraphicsImageRenderer(size: CGSize(width: 96, height: 48)).image { context in
            UIColor.orange.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 96, height: 48))
        }
        let text = String(repeating: "あいうえお :wide: かきくけこ ", count: 6)
        var asked = 0
        func size(_ images: [String: UIImage]) -> CGSize {
            let view = CustomEmoji.text(text, custom: custom, images: images, onNeed: { _ in asked += 1 }).frame(width: 300)
            return UIHostingController(rootView: view).sizeThatFits(in: CGSize(width: 300, height: 2000))
        }
        let loaded = size(["e2": CustomEmoji.inlineImage(image)])
        XCTAssertEqual(asked, 0)
        let loading = size([:])
        XCTAssertEqual(loading, loaded)
        XCTAssertGreaterThan(asked, 0) // the missing image is asked for
    }

    /// 2026-10-04 (「高さが違う」): Text(Image) stands on the baseline, and an image taller than the text's ascent made its
    /// line taller than a line without one (by 4 pt in body text). At the heights used, a line with one is as tall.
    @MainActor
    func testInlineImageDoesNotMakeTheLineTaller() {
        let square = CustomEmojiOut(id: "e3", name: "sq", contentType: "image/png", width: 32, height: 32, createdBy: "u", createdAt: "")
        let image = CustomEmoji.inlineImage(UIGraphicsImageRenderer(size: CGSize(width: 48, height: 48)).image { context in
            UIColor.orange.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 48, height: 48))
        })
        func height(_ text: String, font: Font, emojiHeight: CGFloat) -> CGFloat {
            let view = CustomEmoji.text(text, custom: ["sq": square], images: ["e3": image], onNeed: nil, height: emojiHeight)
                .font(font).frame(width: 300)
            return UIHostingController(rootView: view).sizeThatFits(in: CGSize(width: 300, height: 2000)).height
        }
        let fonts: [(Font, CGFloat)] = [(.body, CustomEmoji.inlineHeight), (.title.bold(), CustomEmoji.headingHeights[0]),
                                        (.title2.bold(), CustomEmoji.headingHeights[1]), (.title3.bold(), CustomEmoji.headingHeights[2])]
        for (font, emojiHeight) in fonts {
            XCTAssertEqual(height("あいう :sq: かき", font: font, emojiHeight: emojiHeight), height("あいう 😀 かき", font: font, emojiHeight: emojiHeight), accuracy: 0.5)
            XCTAssertEqual(height("あいう :sq: かき", font: font, emojiHeight: emojiHeight), height("あいう かき", font: font, emojiHeight: emojiHeight), accuracy: 0.5)
        }
    }

    // MARK: M100 (docs/EMOJI.md)

    func testWideEmojiKeepTheirShapeUpToThreeToOne() {
        func emoji(_ w: Int, _ h: Int) -> CustomEmojiOut {
            CustomEmojiOut(id: "w\(w)", name: "w", contentType: "image/png", width: w, height: h, createdBy: "u", createdAt: "")
        }
        XCTAssertEqual(CustomEmoji.size(of: emoji(96, 64), height: 16), CGSize(width: 24, height: 16))
        XCTAssertEqual(CustomEmoji.size(of: emoji(400, 50), height: 16), CGSize(width: 48, height: 16)) // 8:1 capped
    }

    @MainActor
    func testTextEmojiIsAPillAsHighAsAnImageAndAsWideAsItsLabel() throws {
        let json = #"{"id":"t1","name":"kakunin","kind":"text","label":"確認しました","color":"green","content_type":"","width":0,"height":0,"keywords":["了解"],"pack_id":null,"position":0,"created_by":"u","created_at":""}"#
        let text = try JSON.snakeDecoder.decode(CustomEmojiOut.self, from: Data(json.utf8))
        XCTAssertTrue(text.isText)
        XCTAssertEqual(text.keywords, ["了解"])
        let size = CustomEmoji.size(of: text, height: 16)
        XCTAssertEqual(size.height, 16)
        XCTAssertGreaterThan(size.width, 16 * 4) // six characters
        let pill = CustomEmoji.textPill(text, dark: false)
        XCTAssertEqual(pill.size.height, CustomEmoji.storedHeight)
        XCTAssertEqual(pill.size.width / pill.size.height, size.width / size.height, accuracy: 0.1)
        // An older server's row (no kind) is an image.
        let old = try JSON.snakeDecoder.decode(CustomEmojiOut.self, from: Data(#"{"id":"e","name":"e","content_type":"image/png","width":1,"height":1,"created_by":"u","created_at":""}"#.utf8))
        XCTAssertFalse(old.isText)
    }

    /// M101 (docs/EMOJI.md §7): the emoji-only rule's tables and cases shared with the web and Android.
    func testEmojiOnlyFollowsTheSharedCases() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("shared/emoji-only.json")
        let shared = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
        XCTAssertEqual(shared["max_items"] as? Int, EmojiOnly.maxItems)
        XCTAssertEqual((shared["whitespace"] as! [String]).map { UInt32($0, radix: 16)! }, EmojiOnly.whitespace)
        let ranges = (shared["pictographic"] as! [String]).map { range -> ClosedRange<UInt32> in
            let ends = range.split(separator: "-").map { UInt32($0, radix: 16)! }
            return ends[0]...(ends.count > 1 ? ends[1] : ends[0])
        }
        XCTAssertEqual(ranges, EmojiOnly.pictographic)
        let custom = shared["custom"] as! [String: [String: Any]]
        func kind(_ name: String) -> EmojiOnly.Kind? {
            guard let entry = custom[name] else { return nil }
            return entry["kind"] as? String == "text" ? .text : entry["pack"] as? Bool == true ? .pack : .image
        }
        for c in shared["cases"] as! [[String: Any]] {
            let body = c["body"] as! String
            let result = EmojiOnly.parse(body, kind: kind)
            XCTAssertEqual(result != nil, c["jumbo"] as? Bool, body)
            XCTAssertEqual(result?.kinds.map(\.rawValue) ?? [], c["kinds"] as? [String], body)
            XCTAssertEqual(result?.kinds.count ?? 0, c["count"] as? Int, body)
            XCTAssertEqual(result?.stamp ?? false, c["stamp"] as? Bool, body)
        }
        // A real table: kind from the row (text, pack, image).
        var bow = CustomEmojiOut(id: "b", name: "hpd-bow", contentType: "image/png", width: 180, height: 180, createdBy: "u", createdAt: "")
        bow.packId = "p"
        XCTAssertEqual(EmojiOnly.parse(" :hpd-bow: ", custom: ["hpd-bow": bow])?.stamp, true)
        XCTAssertNil(EmojiOnly.parse(":hpd-bow: ok", custom: ["hpd-bow": bow]))
    }

    /// M101: a jumbo body takes the same size before its images come as after; a stamp is `Jumbo.stamp` high; a body
    /// that is not emoji-only, or one drawn without `jumbo` (previews), stays body-sized.
    @MainActor
    func testJumboBodiesHoldTheirSizeAndOnlyWhereAsked() {
        var bow = CustomEmojiOut(id: "b", name: "hpd-bow", contentType: "image/png", width: 180, height: 180, createdBy: "u", createdAt: "")
        bow.packId = "p"
        var wave = CustomEmojiOut(id: "w", name: "hpd-wave", contentType: "image/png", width: 180, height: 180, createdBy: "u", createdAt: "")
        wave.packId = "p"
        let custom = ["hpd-bow": bow, "hpd-wave": wave]
        let picture = CustomEmoji.inlineImage(UIGraphicsImageRenderer(size: CGSize(width: 90, height: 90)).image { context in
            UIColor.orange.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 90, height: 90))
        }, height: CustomEmoji.packStoredHeight)
        func size(_ text: String, images: [String: UIImage], jumbo: Bool = true) -> CGSize {
            let view = MessageBodyView(text: text, users: [:], customEmoji: custom, emojiImages: images, jumbo: jumbo).frame(width: 300)
            return UIHostingController(rootView: view).sizeThatFits(in: CGSize(width: 300, height: 2000))
        }
        let loaded = ["b": picture, "w": picture]
        XCTAssertEqual(size(":hpd-bow:", images: loaded).height, EmojiOnly.Jumbo.stamp, accuracy: 0.5)
        XCTAssertEqual(size(":hpd-bow:", images: [:]).height, EmojiOnly.Jumbo.stamp, accuracy: 0.5)
        XCTAssertEqual(size(":hpd-bow: :hpd-wave: 🎉", images: loaded), size(":hpd-bow: :hpd-wave: 🎉", images: [:]))
        XCTAssertGreaterThanOrEqual(size(":hpd-bow: :hpd-wave:", images: loaded).height, EmojiOnly.Jumbo.pack)
        XCTAssertGreaterThan(size("🎉", images: [:]).height, size("🎉", images: [:], jumbo: false).height + 10)
        XCTAssertEqual(size("🎉 ok", images: [:]).height, size("🎉 ok", images: [:], jumbo: false).height, accuracy: 0.5)
    }

    func testTextPaletteIsTheSharedOne() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("shared/text-emoji.json")
        let shared = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
        let colors = shared["colors"] as! [String: [String: [String: String]]]
        XCTAssertEqual(Set(colors.keys), Set(CustomEmoji.textPalette.keys))
        func hex(_ value: UInt32) -> String { String(format: "#%06X", value) }
        for (key, pair) in CustomEmoji.textPalette {
            XCTAssertEqual(colors[key]?["light"]?["bg"], hex(pair.light.bg), key)
            XCTAssertEqual(colors[key]?["light"]?["fg"], hex(pair.light.fg), key)
            XCTAssertEqual(colors[key]?["dark"]?["bg"], hex(pair.dark.bg), key)
            XCTAssertEqual(colors[key]?["dark"]?["fg"], hex(pair.dark.fg), key)
        }
    }

    func testCustomEmojiAreFoundByLabelAndKeywords() {
        var bow = CustomEmojiOut(id: "b", name: "hpd-bow", contentType: "image/png", width: 1, height: 1, createdBy: "u", createdAt: "")
        bow.label = "おじぎ"
        bow.keywords = ["ありがとう", "ぺこり"]
        let parrot = CustomEmojiOut(id: "p", name: "parrot", contentType: "image/png", width: 1, height: 1, createdBy: "u", createdAt: "")
        XCTAssertEqual(Emoji.customCandidates("ありがとう", custom: [parrot, bow]).map(\.name), ["hpd-bow"])
        XCTAssertEqual(Emoji.customCandidates("アリガトウ", custom: [parrot, bow]).map(\.name), ["hpd-bow"])
        XCTAssertEqual(Emoji.customCandidates("par", custom: [parrot, bow]).map(\.name), ["parrot"])
        XCTAssertEqual(Emoji.query("どうも :ありがとう"), "ありがとう")
        XCTAssertEqual(Emoji.query("：了解"), "了解")
        XCTAssertNil(Emoji.query("例：説明"))
        XCTAssertNil(Emoji.query("hello :t"))
    }
}
