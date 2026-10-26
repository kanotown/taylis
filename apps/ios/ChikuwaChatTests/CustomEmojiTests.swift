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
    /// line taller than a line without one. In the compact rows' text (an excerpt's 14 pt image in 15 pt text) a line
    /// with one is as tall. 2026-10-16: in a message's text the emoji is 1.375 × the text (as on the desktop), and its
    /// line grows to hold it (never cut), by no more than the image and its lowering need.
    @MainActor
    func testInlineImageGrowsTheLineOnlyAsMuchAsItNeeds() {
        let square = CustomEmojiOut(id: "e3", name: "sq", contentType: "image/png", width: 32, height: 32, createdBy: "u", createdAt: "")
        let image = CustomEmoji.inlineImage(UIGraphicsImageRenderer(size: CGSize(width: 48, height: 48)).image { context in
            UIColor.orange.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 48, height: 48))
        })
        func height(_ text: String, font: Font, emojiHeight: CGFloat, textSize: CGFloat?) -> CGFloat {
            let view = CustomEmoji.text(text, custom: ["sq": square], images: ["e3": image], onNeed: nil, height: emojiHeight, textSize: textSize)
                .font(font).frame(width: 300)
            return UIHostingController(rootView: view).sizeThatFits(in: CGSize(width: 300, height: 2000)).height
        }
        // Compact rows (`excerpt`): no taller.
        XCTAssertEqual(height("あいう :sq: かき", font: .subheadline, emojiHeight: CustomEmoji.subheadlineHeight, textSize: nil),
                       height("あいう かき", font: .subheadline, emojiHeight: CustomEmoji.subheadlineHeight, textSize: nil), accuracy: 0.5)
        // A message's text and headings.
        let fonts: [(Font, UIFont.TextStyle)] = [(.body, .body), (.title.bold(), .title1), (.title2.bold(), .title2), (.title3.bold(), .title3)]
        for (font, style) in fonts {
            let size = CustomEmoji.textSize(style)
            let emojiHeight = CustomEmoji.inlineHeight(textSize: size)
            XCTAssertEqual(emojiHeight, (size * 1.375).rounded(.down))
            let plain = height("あいう かき", font: font, emojiHeight: emojiHeight, textSize: size)
            let with = height("あいう :sq: かき", font: font, emojiHeight: emojiHeight, textSize: size)
            // Text(Image) keeps the image's whole height above the baseline for the line, and the lowering that centres
            // it is added below (measured: a 23 pt image makes a 20.3 pt body line 27.3 pt standing on the baseline,
            // 29 pt centred). The line is no taller than that.
            let lowered = -CustomEmoji.baselineOffset(height: emojiHeight, textSize: size)
            XCTAssertGreaterThanOrEqual(with, emojiHeight, "\(style.rawValue)")
            XCTAssertGreaterThan(with, plain, "\(style.rawValue)")
            XCTAssertLessThanOrEqual(with, emojiHeight + lowered + 1, "\(style.rawValue)")
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
        let fonts: [(Font, CGFloat, CGFloat?)] = [(.body, CustomEmoji.inlineHeight, CustomEmoji.textSize(.body)),
                                                  (.title.bold(), CustomEmoji.inlineHeight(textSize: CustomEmoji.textSize(.title1)), CustomEmoji.textSize(.title1)),
                                                  (.subheadline, CustomEmoji.subheadlineHeight, nil)]
        for (font, emojiHeight, textSize) in fonts {
            let view = CustomEmoji.text("確認しました:sq:", custom: ["sq": square], images: ["e3": image], onNeed: nil, height: emojiHeight, textSize: textSize)
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

    // MARK: inline size (2026-10-16, 「スマホで見たときにかなり小さく見える」)

    struct InlineMeasure { let pack: CGFloat; let pill: CGFloat; let ink: CGFloat; let height: CGFloat; let image: UIImage }

    /// `body` drawn by MessageBodyView with a pack emoji (an orange picture, `:chikuwa:`) and a text emoji (a green pill,
    /// `:thanks:`): the drawn heights (points) of the first ones found within `rows` (points from the top), of the
    /// text's ink there, and of the whole view.
    @MainActor
    static func measureInline(_ body: String, size: DynamicTypeSize?, rows: ClosedRange<CGFloat> = 0...60, width: CGFloat = 360) throws -> InlineMeasure {
        let pack = CustomEmojiOut(id: "p1", name: "chikuwa", contentType: "image/png", width: 180, height: 180, createdBy: "u", createdAt: "", packId: "k")
        let pillJSON = #"{"id":"t1","name":"thanks","kind":"text","label":"ありがとう","color":"green","content_type":"","width":0,"height":0,"created_by":"u","created_at":""}"#
        let pill = try JSON.snakeDecoder.decode(CustomEmojiOut.self, from: Data(pillJSON.utf8))
        let orange = UIGraphicsImageRenderer(size: CGSize(width: 60, height: 60)).image { context in
            UIColor(red: 1, green: 0.5, blue: 0, alpha: 1).setFill()
            context.fill(CGRect(x: 0, y: 0, width: 60, height: 60))
        }
        var view = AnyView(MessageBodyView(text: body, users: [:], customEmoji: ["chikuwa": pack, "thanks": pill],
                                           emojiImages: ["p1": CustomEmoji.inlineImage(orange, height: CustomEmoji.packStoredHeight),
                                                         "t1": CustomEmoji.textPill(pill, dark: false)])
            .frame(width: width).background(Color.white).foregroundStyle(.black).environment(\.colorScheme, .light))
        if let size { view = AnyView(view.environment(\.dynamicTypeSize, size)) }
        let renderer = ImageRenderer(content: view)
        renderer.scale = 3
        let cg = try XCTUnwrap(renderer.cgImage)
        let w = cg.width, h = cg.height
        var data = [UInt8](repeating: 0, count: w * h * 4)
        let context = try XCTUnwrap(CGContext(data: &data, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                              space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
        var ink = (Int.max, -1), orangeBox = (Int.max, -1), pillBox = (Int.max, -1)
        for y in max(0, Int(rows.lowerBound * 3))..<min(h, Int(rows.upperBound * 3)) {
            for x in 0..<w {
                let p = (y * w + x) * 4
                let r = Int(data[p]), g = Int(data[p + 1]), b = Int(data[p + 2])
                if r > 220, g > 100, g < 160, b < 40 { orangeBox = (min(orangeBox.0, y), max(orangeBox.1, y)) }
                else if abs(r - 0xDD) < 8, abs(g - 0xF4) < 8, abs(b - 0xE4) < 8 { pillBox = (min(pillBox.0, y), max(pillBox.1, y)) }
                else if r < 90, g < 90, b < 90 { ink = (min(ink.0, y), max(ink.1, y)) }
            }
        }
        func pt(_ box: (Int, Int)) -> CGFloat { box.1 < 0 ? 0 : CGFloat(box.1 - box.0 + 1) / 3 }
        return InlineMeasure(pack: pt(orangeBox), pill: pt(pillBox), ink: pt(ink), height: CGFloat(h) / 3,
                             image: UIImage(cgImage: cg, scale: 3, orientation: .up))
    }

    /// Writes a render into CHIKUWA_RENDER_DIR (xcodebuild passes TEST_RUNNER_CHIKUWA_RENDER_DIR) for a person to look at.
    static func saveRender(_ image: UIImage, _ name: String) {
        guard let dir = ProcessInfo.processInfo.environment["CHIKUWA_RENDER_DIR"], let png = image.pngData() else { return }
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        try? png.write(to: URL(fileURLWithPath: dir).appendingPathComponent(name + ".png"))
    }

    /// 2026-10-16 (「PCではそれなりに適切なサイズに見えるけど、スマホで見たときにかなり小さく見える」): a pack emoji and a
    /// text emoji's pill in a message were 16 pt in 17 pt text (15 pt in 16 pt, one size smaller); the desktop draws them
    /// 1.375 × the text. Now as on the desktop, in body text, headings (#### included) and at the text size in use.
    @MainActor
    func testInlineEmojiAreOneAndThreeEighthsOfTheText() throws {
        for (size, name) in [(DynamicTypeSize.large, "default"), (.medium, "M")] {
            let body = CustomEmoji.textSize(.body, size)
            XCTAssertEqual(body, size == .large ? 17 : 16)
            let line = try Self.measureInline("確認しました :chikuwa: どうも :thanks: です", size: size)
            XCTAssertEqual(line.pack, (body * 1.375).rounded(.down), accuracy: 0.7, name) // 23 / 22
            XCTAssertEqual(line.pill, line.pack, accuracy: 0.7, name)
            for (level, style) in [(2, UIFont.TextStyle.title2), (4, .body)] {
                let heading = try Self.measureInline(String(repeating: "#", count: level) + " 見出し :chikuwa: :thanks:", size: size)
                let expected = (CustomEmoji.textSize(style, size) * 1.375).rounded(.down)
                XCTAssertEqual(heading.pack, expected, accuracy: 0.7, "h\(level) \(name)")
                XCTAssertEqual(heading.pill, expected, accuracy: 0.7, "h\(level) \(name)")
            }
            let page = try Self.measureInline("確認しました :chikuwa: どうも :thanks: です\n\n## 見出し :chikuwa: :thanks:\n\n#### 小見出し :chikuwa: :thanks:\n\n- 箇条書き :chikuwa: です", size: size)
            Self.saveRender(page.image, "ios-after-\(name)")
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

/// docs/EMOJI.md §10 (2026-10-15, 「毎回読み込みに結構時間かかる」): custom emoji pictures kept on disk per server,
/// decoded once in memory, one request per emoji at a time and a few at once.
final class EmojiImageCacheTests: XCTestCase {
    private var directories: [URL] = []

    override func tearDown() {
        for directory in directories { try? FileManager.default.removeItem(at: directory) }
        super.tearDown()
    }

    private func directory() -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("emoji-cache-test-\(UUID().uuidString)", isDirectory: true)
        directories.append(url)
        return url
    }

    private static func png(_ color: UIColor, size: CGFloat = 8) -> Data {
        UIGraphicsImageRenderer(size: CGSize(width: size, height: size)).pngData { context in
            color.setFill()
            context.fill(CGRect(x: 0, y: 0, width: size, height: size))
        }
    }

    private let decode: (Data) -> DecodedEmoji? = { data in
        CustomEmoji.decode(data).map { DecodedEmoji(still: $0.still, animation: $0.animation) }
    }

    /// Counts the requests a fetch closure makes (from any thread).
    private final class Requests: @unchecked Sendable {
        private let lock = NSLock()
        private var count = 0, inFlight = 0, maxInFlight = 0
        var total: Int { lock.withLock { count } }
        var most: Int { lock.withLock { maxInFlight } }
        func fetch(_ data: Data, delay: UInt64 = 0) async throws -> Data {
            lock.withLock { count += 1; inFlight += 1; maxInFlight = max(maxInFlight, inFlight) }
            if delay > 0 { try? await Task.sleep(nanoseconds: delay) }
            lock.withLock { inFlight -= 1 }
            return data
        }
    }

    /// The next launch (a new cache on the same directory) draws a picture fetched before without asking the server,
    /// even before the token refresh (no request at all). The request it made went through the API client with the
    /// session's token, to the picture's version.
    @MainActor
    func testANewLaunchServesFromDiskWithoutTheNetwork() async throws {
        var paths: [String] = []
        StubProtocol.handler = { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer access")
            paths.append(request.url!.path + "?" + (request.url!.query ?? ""))
            return (200, Self.png(.red))
        }
        defer { StubProtocol.handler = nil }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        let api = ApiClient(baseUrl: URL(string: "http://server")!, session: URLSession(configuration: configuration))
        api.accessToken = "access"
        let path = EmojiImageCache.imagePath(id: "e1", version: "v1")
        let directory = directory()

        let first = EmojiImageCache(directory: directory)
        let fetched = await first.image(id: "e1", version: "v1", variant: "inline", decode: decode, fetch: { try await api.fetchData(path) })
        XCTAssertNotNil(fetched)
        XCTAssertEqual(paths, ["/api/v1/emoji/e1/image?v=v1"])
        XCTAssertNotNil(first.cached(id: "e1", version: "v1", variant: "inline")) // decoded once, in memory

        let relaunched = EmojiImageCache(directory: directory)
        XCTAssertNil(relaunched.cached(id: "e1", version: "v1", variant: "inline"))
        let fromDisk = await relaunched.image(id: "e1", version: "v1", variant: "inline", decode: decode,
                                              fetch: { XCTFail("no request"); throw URLError(.notConnectedToInternet) })
        XCTAssertEqual(fromDisk?.stale, false)
        XCTAssertEqual(fromDisk?.image.still.size, fetched?.image.still.size)
        XCTAssertEqual(paths.count, 1)
        // Offline too, and for a server that sends no version (younger than a day: not stale).
        let unversioned = await relaunched.image(id: "e1", version: nil, variant: "pack", decode: decode,
                                                 fetch: { throw URLError(.notConnectedToInternet) })
        XCTAssertEqual(unversioned?.stale, false)
    }

    /// A new version is fetched; a picture with no version is fetched again behind the old one after `revalidateAfter`.
    func testVersionsAndRevalidation() async throws {
        let directory = directory(), requests = Requests()
        let red = Self.png(.red), blue = Self.png(.blue)
        let cache = EmojiImageCache(directory: directory, revalidateAfter: 0)
        _ = await cache.image(id: "e1", version: "v1", variant: "inline", decode: decode, fetch: { try await requests.fetch(red) })
        _ = await cache.image(id: "e1", version: "v1", variant: "inline", decode: decode, fetch: { try await requests.fetch(red) })
        XCTAssertEqual(requests.total, 1)
        let second = await cache.image(id: "e1", version: "v2", variant: "inline", decode: decode, fetch: { try await requests.fetch(blue) })
        XCTAssertEqual(requests.total, 2)
        XCTAssertEqual(second?.stale, false) // a version is trusted for good

        let relaunched = EmojiImageCache(directory: directory, revalidateAfter: 0)
        let stale = await relaunched.image(id: "e1", version: nil, variant: "inline", decode: decode, fetch: { try await requests.fetch(blue) })
        XCTAssertEqual(stale?.stale, true)
        XCTAssertEqual(requests.total, 2) // shown from the disk first
        let unchanged = await relaunched.revalidate(id: "e1", variant: "inline", decode: decode, fetch: { try await requests.fetch(blue) })
        XCTAssertNil(unchanged)
        let replaced = await relaunched.revalidate(id: "e1", variant: "inline", decode: decode, fetch: { try await requests.fetch(red) })
        XCTAssertNotNil(replaced) // a preset's picture replaced on the server (§8.2)
        XCTAssertTrue(relaunched.cached(id: "e1", version: nil, variant: "inline") === replaced)
        XCTAssertEqual(requests.total, 4)
    }

    /// Workspaces never share pictures; signing out of one (or removing it) deletes its pictures, in memory and on disk.
    @MainActor
    func testServersAreApartAndSignOutClearsOne() async throws {
        let a = "https://a.example.test", b = "https://b.example.test"
        defer { EmojiImageCache.remove(server: a); EmojiImageCache.remove(server: b) }
        let requests = Requests(), red = Self.png(.red)
        XCTAssertNotEqual(EmojiImageCache.directory(server: a), EmojiImageCache.directory(server: b))
        XCTAssertTrue(EmojiImageCache.forServer(a) === EmojiImageCache.forServer(a))

        _ = await EmojiImageCache.forServer(a).image(id: "e1", version: "1", variant: "inline", decode: decode, fetch: { try await requests.fetch(red) })
        _ = await EmojiImageCache.forServer(b).image(id: "e1", version: "1", variant: "inline", decode: decode, fetch: { try await requests.fetch(red) })
        XCTAssertEqual(requests.total, 2) // the same id on another server is another picture
        let directoryA = EmojiImageCache.directory(server: a)
        XCTAssertTrue(FileManager.default.fileExists(atPath: directoryA.appendingPathComponent("e1").path))

        let before = EmojiImageCache.forServer(a)
        EmojiImageCache.remove(server: a)
        XCTAssertFalse(FileManager.default.fileExists(atPath: directoryA.path))
        XCTAssertNil(before.cached(id: "e1", version: "1", variant: "inline"))
        XCTAssertFalse(EmojiImageCache.forServer(a) === before)
        _ = await EmojiImageCache.forServer(a).image(id: "e1", version: "1", variant: "inline", decode: decode, fetch: { try await requests.fetch(red) })
        XCTAssertEqual(requests.total, 3) // signed in again: fetched again
        // The other workspace kept its own.
        _ = await EmojiImageCache(directory: EmojiImageCache.directory(server: b))
            .image(id: "e1", version: "1", variant: "inline", decode: decode, fetch: { try await requests.fetch(red) })
        XCTAssertEqual(requests.total, 3)
        // A load under way when the workspace goes writes nothing back.
        let leaving = EmojiImageCache.forServer(b)
        async let late = leaving.image(id: "e2", version: "1", variant: "inline", decode: decode,
                                       fetch: { try await requests.fetch(red, delay: 100_000_000) })
        try await Task.sleep(nanoseconds: 20_000_000)
        EmojiImageCache.remove(server: b)
        _ = await late
        XCTAssertFalse(FileManager.default.fileExists(atPath: EmojiImageCache.directory(server: b).path))
    }

    /// Many views asking for the same picture at once (a conversation full of the same reaction) make one request; a
    /// picker full of new ones runs a few at a time.
    func testOneRequestPerPictureAndAFewAtOnce() async throws {
        let cache = EmojiImageCache(directory: directory(), maxConcurrent: 3), requests = Requests(), red = Self.png(.red)
        let decode = self.decode
        let same = await withTaskGroup(of: Bool.self) { group -> [Bool] in
            for _ in 0..<20 {
                group.addTask {
                    await cache.image(id: "e1", version: nil, variant: "inline", decode: decode,
                                      fetch: { try await requests.fetch(red, delay: 50_000_000) }) != nil
                }
            }
            return await group.reduce(into: []) { $0.append($1) }
        }
        XCTAssertEqual(same, Array(repeating: true, count: 20))
        XCTAssertEqual(requests.total, 1)

        let many = await withTaskGroup(of: Bool.self) { group -> [Bool] in
            for index in 0..<12 {
                group.addTask {
                    await cache.image(id: "m\(index)", version: nil, variant: "inline", decode: decode,
                                      fetch: { try await requests.fetch(red, delay: 20_000_000) }) != nil
                }
            }
            return await group.reduce(into: []) { $0.append($1) }
        }
        XCTAssertEqual(many.filter { $0 }.count, 12)
        XCTAssertEqual(requests.total, 13)
        XCTAssertLessThanOrEqual(requests.most, 3)
        // A failed request is not remembered: the next view asks again.
        let failed = await cache.image(id: "x", version: nil, variant: "inline", decode: decode, fetch: { throw URLError(.timedOut) })
        XCTAssertNil(failed)
        let retried = await cache.image(id: "x", version: nil, variant: "inline", decode: decode, fetch: { try await requests.fetch(red) })
        XCTAssertNotNil(retried)
    }

    /// Over its cap the cache keeps the most recently used pictures.
    func testTheCapDropsTheLeastRecentlyUsed() async throws {
        let directory = directory()
        let picture = Self.png(.red, size: 64)
        let cache = EmojiImageCache(directory: directory, capacity: (picture.count + 1) * 4) // four files (an empty version line each)
        for index in 0..<4 {
            _ = await cache.image(id: "e\(index)", version: nil, variant: "inline", decode: decode, fetch: { picture })
            // Older uses, oldest first (e0 the least recently used).
            try FileManager.default.setAttributes([.modificationDate: Date(timeIntervalSinceNow: Double(index - 10) * 60)],
                                                  ofItemAtPath: directory.appendingPathComponent("e\(index)").path)
        }
        _ = await cache.image(id: "e4", version: nil, variant: "inline", decode: decode, fetch: { picture })
        let kept = Set((try FileManager.default.contentsOfDirectory(atPath: directory.path)))
        XCTAssertEqual(kept, ["e2", "e3", "e4"]) // down to three quarters of the cap, newest first
    }

    /// The emoji and packs last known come back with the store (a launch draws them before the bootstrap), and a new
    /// picture version drops the drawn one.
    @MainActor
    func testTheListsAreKeptAndANewVersionIsDrawnAgain() throws {
        let row = CustomEmojiOut(id: "e1", name: "party", contentType: "image/png", width: 8, height: 8, createdBy: "u", createdAt: "",
                                 packId: "p1", imageVersion: "v1")
        let pack = EmojiPackOut(id: "p1", name: "Pack", position: 0, tabVersion: "t", createdAt: "", updatedAt: "")
        let store = Store()
        store.replaceCustomEmoji([row])
        store.replaceEmojiPacks([pack])
        let restored = Store.fromSnapshot(store.snapshot())
        XCTAssertEqual(restored.customEmoji, ["party": row])
        XCTAssertEqual(restored.emojiPacks, ["p1": pack])

        store.emojiImages["e1"] = UIImage()
        var renamed = row
        renamed.keywords = ["お祝い"]
        store.applyCustomEmoji(renamed, deleted: false)
        XCTAssertNotNil(store.emojiImages["e1"]) // same picture
        var replaced = renamed
        replaced.imageVersion = "v2"
        store.applyCustomEmoji(replaced, deleted: false)
        XCTAssertNil(store.emojiImages["e1"])
        // The server's field.
        let json = #"{"id":"e1","name":"party","content_type":"image/png","width":8,"height":8,"created_by":"u","created_at":"","image_version":"abc"}"#
        XCTAssertEqual(try JSON.snakeDecoder.decode(CustomEmojiOut.self, from: Data(json.utf8)).imageVersion, "abc")
    }
}

/// 2026-10-27 (「よく使う」 on a dark background): a custom emoji with a thin white outline shimmered in the picker's 30 pt
/// cells. A still is shown from a copy at the pixels it takes, made once per size.
final class CustomEmojiDisplayTests: XCTestCase {
    private func pixels(_ image: CGSize, _ box: CGSize, _ scale: CGFloat) -> [Int] {
        let (width, height) = CustomEmoji.displayPixels(imageSize: image, box: box, scale: scale)
        return [width, height]
    }

    func testDisplayPixelsFitTheBoxInWholePixels() {
        XCTAssertEqual(pixels(CGSize(width: 48, height: 48), CGSize(width: 30, height: 30), 3), [90, 90])
        XCTAssertEqual(pixels(CGSize(width: 144, height: 48), CGSize(width: 30, height: 30), 3), [90, 30]) // 3:1
        XCTAssertEqual(pixels(CGSize(width: 144, height: 48), CGSize(width: 48, height: 16), 3), [144, 48]) // a chip
        XCTAssertEqual(pixels(CGSize(width: 48, height: 48), CGSize(width: 30, height: 30), 2), [60, 60])
        XCTAssertEqual(pixels(CGSize(width: 70, height: 48), CGSize(width: 30, height: 30), 3), [90, 62])
        XCTAssertEqual(pixels(.zero, CGSize(width: 30, height: 30), 3), [1, 1])
    }

    func testAStillIsShownFromACopyAtItsPixelsMadeOncePerSize() throws {
        let still = CustomEmoji.inlineImage(UIGraphicsImageRenderer(size: CGSize(width: 64, height: 64)).image { context in
            UIColor.orange.setFill(); context.fill(CGRect(x: 0, y: 0, width: 64, height: 64))
        })
        let copies = try XCTUnwrap(CustomEmoji.DisplayCopies.of(still))
        let cell = CustomEmoji.displayed(still, fitting: CGSize(width: 30, height: 30), scale: 3)
        XCTAssertEqual(cell.cgImage?.width, 90)
        XCTAssertEqual(cell.cgImage?.height, 90)
        XCTAssertEqual(cell.size, CGSize(width: 30, height: 30)) // shown at its own size: no scaling on screen
        XCTAssertTrue(CustomEmoji.displayed(still, fitting: CGSize(width: 30, height: 30), scale: 3) === cell)
        let chip = CustomEmoji.displayed(still, fitting: CGSize(width: 16, height: 16), scale: 3)
        XCTAssertEqual(chip.cgImage?.height, 48)
        XCTAssertEqual(copies.count, 2)

        // Not a still (an animation's frame, a pack's tab icon): the same pixels at the fitted size, nothing kept.
        let frame = UIGraphicsImageRenderer(size: CGSize(width: 36, height: 36)).image { _ in }
        XCTAssertNil(CustomEmoji.DisplayCopies.of(frame))
        let shown = CustomEmoji.displayed(frame, fitting: CGSize(width: 30, height: 30), scale: 3)
        XCTAssertEqual(shown.cgImage?.height, frame.cgImage?.height)
        XCTAssertEqual(shown.size.height, 30, accuracy: 0.01)
    }

    /// A 512 px picture with a 4 px white ring, as uploaded, read and shown in a picker cell (30 pt at 3×): the ring is
    /// there evenly on every row it crosses (a pixel-skipping scale-down leaves gaps in it).
    func testAThinOutlineSurvivesEvenly() throws {
        let side: CGFloat = 512
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let source = UIGraphicsImageRenderer(size: CGSize(width: side, height: side), format: format).image { context in
            UIColor.white.setStroke()
            context.cgContext.setLineWidth(4)
            context.cgContext.stroke(CGRect(x: 40, y: 40, width: side - 80, height: side - 80))
        }
        let decoded = try XCTUnwrap(CustomEmoji.decode(try XCTUnwrap(source.pngData())))
        XCTAssertNotNil(CustomEmoji.DisplayCopies.of(decoded.still))
        let cell = try XCTUnwrap(CustomEmoji.displayed(decoded.still, fitting: CGSize(width: 30, height: 30), scale: 3).cgImage)
        XCTAssertEqual(cell.width, 90)
        let alpha = try alphas(cell)
        // The ring's left side: in each row between its top and bottom sides, the strongest pixel near x = 7.
        let ringRows = (12..<78).map { y in (3..<12).map { alpha[y * cell.width + $0] }.max() ?? 0 }
        let weakest = try XCTUnwrap(ringRows.min()), strongest = try XCTUnwrap(ringRows.max())
        XCTAssertGreaterThan(weakest, 0.2)
        XCTAssertGreaterThan(weakest / strongest, 0.8, "the ring fades on some rows: \(ringRows)")
    }

    private func alphas(_ image: CGImage) throws -> [CGFloat] {
        let width = image.width, height = image.height
        var bytes = [UInt8](repeating: 0, count: width * height * 4)
        let context = try XCTUnwrap(CGContext(data: &bytes, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                              space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return (0..<(width * height)).map { CGFloat(bytes[$0 * 4 + 3]) / 255 }
    }
}
