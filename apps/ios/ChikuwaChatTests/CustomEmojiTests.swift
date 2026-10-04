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
}
