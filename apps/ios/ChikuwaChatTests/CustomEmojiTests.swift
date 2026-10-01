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
}
