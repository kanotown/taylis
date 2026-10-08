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

    /// 2026-10-06 (「iPhone だけ絵文字が少し上」): standing on the baseline, an inline image's middle was 2 pt above the
    /// kana's. It is centred on the line now, in body text and in headings (an orange square beside black text).
    @MainActor
    func testInlineImageIsCentredOnTheText() throws {
        let square = CustomEmojiOut(id: "e3", name: "sq", contentType: "image/png", width: 32, height: 32, createdBy: "u", createdAt: "")
        let image = CustomEmoji.inlineImage(UIGraphicsImageRenderer(size: CGSize(width: 48, height: 48)).image { context in
            UIColor.orange.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 48, height: 48))
        })
        let fonts: [(Font, CGFloat)] = [(.body, CustomEmoji.inlineHeight), (.title.bold(), CustomEmoji.headingHeights[0])]
        for (font, emojiHeight) in fonts {
            let view = CustomEmoji.text("確認しました:sq:", custom: ["sq": square], images: ["e3": image], onNeed: nil, height: emojiHeight)
                .font(font).foregroundStyle(.black).padding(4).background(Color.white)
            let renderer = ImageRenderer(content: view)
            renderer.scale = 2
            let cg = try XCTUnwrap(renderer.cgImage)
            let w = cg.width, h = cg.height
            var data = [UInt8](repeating: 0, count: w * h * 4)
            let context = try XCTUnwrap(CGContext(data: &data, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                                  space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
            context.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
            var text = (top: Int.max, bottom: -1), emoji = (top: Int.max, bottom: -1)
            for y in 0..<h {
                for x in 0..<w {
                    let p = (y * w + x) * 4
                    let top = max(data[p], data[p + 1], data[p + 2]), low = min(data[p], data[p + 1], data[p + 2])
                    if top - low > 60 { emoji = (min(emoji.top, y), max(emoji.bottom, y)) } else if top < 100 { text = (min(text.top, y), max(text.bottom, y)) }
                }
            }
            XCTAssertGreaterThan(emoji.bottom, 0)
            XCTAssertEqual(CGFloat(emoji.top + emoji.bottom) / 4, CGFloat(text.top + text.bottom) / 4, accuracy: 0.75, "\(font)")
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

    /// The background of a pill: an RGB pixel near its left end, halfway down (inside the rounded corner).
    private func pillBackground(_ image: UIImage) -> UInt32 {
        let cg = image.cgImage!
        var pixel = [UInt8](repeating: 0, count: 4)
        pixel.withUnsafeMutableBytes { buffer in
            let context = CGContext(data: buffer.baseAddress, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
                                    space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
            context.draw(cg, in: CGRect(x: -3, y: -CGFloat(cg.height / 2), width: CGFloat(cg.width), height: CGFloat(cg.height)))
        }
        return UInt32(pixel[0]) << 16 | UInt32(pixel[1]) << 8 | UInt32(pixel[2])
    }

    /// 2026-10-05 (build 95): in light mode a pill could keep the dark palette. The look flips for a moment while iOS
    /// takes the app-switcher snapshot, and a pill whose deferred drawing straddled a change kept the look captured
    /// before it. Now only an active scene's look counts, a pending pill reads the look when it is drawn, and a change
    /// swaps the cached pills at once.
    @MainActor
    func testTextPillsFollowTheActiveLookAndSwapAtOnce() async throws {
        let json = #"{"id":"t1","name":"thanks","kind":"text","label":"ありがとう","color":"green","content_type":"","width":0,"height":0,"created_by":"u","created_at":""}"#
        let emoji = try JSON.snakeDecoder.decode(CustomEmojiOut.self, from: Data(json.utf8))
        let light = CustomEmoji.textPalette["green"]!.light.bg, dark = CustomEmoji.textPalette["green"]!.dark.bg
        XCTAssertEqual(pillBackground(CustomEmoji.textPill(emoji, dark: false)), light)
        XCTAssertEqual(pillBackground(CustomEmoji.textPill(emoji, dark: true)), dark)
        XCTAssertTrue(CustomEmoji.textPill(emoji, dark: true) === CustomEmoji.textPill(emoji, dark: true)) // drawn once

        let controller = AppController()
        controller.store.customEmoji = ["thanks": emoji]
        // A pill asked for in light, the look changing before it is drawn: it is drawn in the new look.
        controller.loadEmojiImage(emoji)
        controller.appearanceChanged(dark: true, active: true)
        for _ in 0..<5 where controller.store.emojiImages["t1"] == nil { await Task.yield() }
        XCTAssertEqual(pillBackground(try XCTUnwrap(controller.store.emojiImages["t1"])), dark)
        // Back to light: swapped at once, no blank, no redraw to wait for.
        controller.appearanceChanged(dark: false, active: true)
        XCTAssertEqual(pillBackground(try XCTUnwrap(controller.store.emojiImages["t1"])), light)
        // The snapshot's flip in the background is ignored; becoming active reports the look again.
        controller.appearanceChanged(dark: true, active: false)
        XCTAssertEqual(pillBackground(try XCTUnwrap(controller.store.emojiImages["t1"])), light)
        controller.appearanceChanged(dark: false, active: true)
        XCTAssertFalse(controller.textEmojiDark)
        XCTAssertEqual(pillBackground(try XCTUnwrap(controller.store.emojiImages["t1"])), light)
    }

    /// 2026-10-08 (TestFlight build 109): opening the threads list crashed once in AttributeGraph. `onNeed` runs inside
    /// a view's body (`CustomEmoji.text`), and `loadEmojiImage` read and wrote the controller's in-flight set there:
    /// the set was observation-tracked, so the write invalidated the very view being drawn. The set is bookkeeping only
    /// and must not be observed; a body asking for a second image must not invalidate one that asked for the first.
    @MainActor
    func testAskingForAnEmojiImageInvalidatesNoView() throws {
        func emoji(_ id: String) throws -> CustomEmojiOut {
            let json = #"{"id":"\#(id)","name":"\#(id)","kind":"text","label":"ok","color":"green","content_type":"","width":0,"height":0,"created_by":"u","created_at":""}"#
            return try JSON.snakeDecoder.decode(CustomEmojiOut.self, from: Data(json.utf8))
        }
        let first = try emoji("e1"), second = try emoji("e2")
        let controller = AppController()
        controller.store.customEmoji = ["e1": first, "e2": second]
        var invalidated = false
        withObservationTracking { controller.loadEmojiImage(first) } onChange: { invalidated = true }
        controller.loadEmojiImage(second) // another row's body, before the deferred pills are drawn
        XCTAssertFalse(invalidated)
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

    /// 2026-10-05: the activity showed a pack emoji reaction as `:ckw-yay:` (until its image came) and the excerpts kept
    /// `:name:`. Outside the chips a reaction takes its box from the start (a wide one wider, a text emoji's pill), and an
    /// excerpt draws the images in place, the same size loading or loaded.
    @MainActor
    func testCompactRowsDrawCustomEmojiInTheirBoxes() throws {
        let controller = AppController()
        let wide = CustomEmojiOut(id: "y", name: "ckw-yay", contentType: "image/png", width: 96, height: 32, createdBy: "u", createdAt: "")
        let json = #"{"id":"t","name":"ok-text","kind":"text","label":"了解","color":"blue","content_type":"","width":0,"height":0,"created_by":"u","created_at":""}"#
        let pill = try JSON.snakeDecoder.decode(CustomEmojiOut.self, from: Data(json.utf8))
        controller.store.customEmoji = ["ckw-yay": wide, "ok-text": pill]
        func size<V: View>(_ view: V) -> CGSize { UIHostingController(rootView: view).sizeThatFits(in: CGSize(width: 300, height: 2000)) }

        let loading = size(ReactionGlyph(controller: controller, emoji: ":ckw-yay:", height: 16))
        XCTAssertEqual(loading, CGSize(width: 48, height: 16))
        let pillLoading = size(ReactionGlyph(controller: controller, emoji: ":ok-text:", height: 16))
        XCTAssertEqual(pillLoading, CustomEmoji.size(of: pill, height: 16))

        let line = String(repeating: "やった :ckw-yay: :ok-text: :+1: ", count: 5)
        let excerptLoading = size(CustomEmoji.excerpt(line, controller: controller).font(.subheadline).frame(width: 300))
        let image = UIGraphicsImageRenderer(size: CGSize(width: 96, height: 32)).image { context in
            UIColor.orange.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 96, height: 32))
        }
        controller.store.emojiImages = ["y": CustomEmoji.inlineImage(image), "t": CustomEmoji.textPill(pill, dark: false)]
        XCTAssertEqual(size(ReactionGlyph(controller: controller, emoji: ":ckw-yay:", height: 16)), loading)
        XCTAssertEqual(size(CustomEmoji.excerpt(line, controller: controller).font(.subheadline).frame(width: 300)), excerptLoading)
        // The standard shortcode is its glyph, the custom names are not text.
        XCTAssertEqual(Emoji.replaceShortcodes(":+1:"), "👍")
    }

    /// M114: section letter badges parse as apps/shared/section-icons.json says, in the text emoji colours.
    func testSectionLetterIconsFollowTheSharedCases() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("shared/section-icons.json")
        let shared = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as! [String: Any]
        let cases = shared["cases"] as! [[String: Any]]
        XCTAssertGreaterThan(cases.count, 10)
        for item in cases {
            let icon = item["icon"] as! String
            let expected = (item["letter"] as? [String: String]).map { SectionLetterIcon(text: $0["text"]!, color: $0["color"]!) }
            XCTAssertEqual(SectionLetterIcon.parse(icon), expected, icon)
            if let expected { XCTAssertEqual(expected.icon, icon) }
        }
        XCTAssertEqual(Set(SectionLetterIcon.colors.map(\.key)), Set(CustomEmoji.textPalette.keys))
        XCTAssertEqual(SectionLetterIcon.normalize(" Ｍ "), "M")
        XCTAssertEqual(SectionLetterIcon.normalize("ｱ"), "ア")
    }
}
