import XCTest
@testable import ChikuwaChat

final class BodyTokenizerTests: XCTestCase {
    func testInlineSubsetMentionsLinksAndNewlines() {
        let body = "hi *bold* and _it_ `code` <@00000000-0000-7000-8000-000000000001> <!channel>\nhttps://example.com/x?y=1 done"
        XCTAssertEqual(BodyTokenizer.tokenize(body), [
            .text("hi "), .bold("bold"), .text(" and "), .italic("it"), .text(" "), .code("code"), .text(" "),
            .mention("00000000-0000-7000-8000-000000000001"), .text(" "), .mentionAll("channel"), .newline,
            .link("https://example.com/x?y=1"), .text(" done"),
        ])
    }

    func testCodeBlocksAndUnmatchedMarkers() {
        XCTAssertEqual(BodyTokenizer.tokenize("```\nlet *x* = 1\n```"), [.codeBlock("let *x* = 1")])
        XCTAssertEqual(BodyTokenizer.tokenize("```py\nprint(1)\n```"), [.codeBlock("print(1)", lang: "py")])
        XCTAssertEqual(BodyTokenizer.tokenize("<script>alert(1)</script>"), [.text("<script>alert(1)</script>")])
        XCTAssertEqual(BodyTokenizer.tokenizeInline("**both** ~~gone~~ [docs](https://example.com/d) 2 * 3"), [
            .bold("both"), .text(" "), .strike("gone"), .text(" "), .link("https://example.com/d", label: "docs"), .text(" 2 * 3"),
        ])
    }

    func testBlocksQuotesListsAndFences() {
        let body = ["plan:", "- one **strong**", "- two", "  - nested", "1. first", "2. second", "> quoted _q_", "> more", "```ts", "const x = 1;", "```", "tail"].joined(separator: "\n")
        let blocks = BodyTokenizer.parseBlocks(body)
        XCTAssertEqual(blocks.count, 6)
        XCTAssertEqual(blocks[0], .paragraph([[.text("plan:")]]))
        XCTAssertEqual(blocks[1], .list(ordered: false, start: 1, items: [
            BodyListItem(level: 0, tokens: [.text("one "), .bold("strong")]),
            BodyListItem(level: 0, tokens: [.text("two")]),
            BodyListItem(level: 1, tokens: [.text("nested")]),
        ]))
        XCTAssertEqual(blocks[2], .list(ordered: true, start: 1, items: [BodyListItem(level: 0, tokens: [.text("first")]), BodyListItem(level: 0, tokens: [.text("second")])]))
        XCTAssertEqual(blocks[3], .quote([[.text("quoted "), .italic("q")], [.text("more")]]))
        XCTAssertEqual(blocks[4], .codeBlock("const x = 1;", lang: "ts"))
        XCTAssertEqual(blocks[5], .paragraph([[.text("tail")]]))
        XCTAssertEqual(BodyTokenizer.parseBlocks("```\nopen"), [.paragraph([[.text("```")], [.text("open")]])])
        XCTAssertEqual(BodyTokenizer.parseBlocks("# Title\n## Sub **b**\n#### not"), [
            .heading(1, [.text("Title")]), .heading(2, [.text("Sub "), .bold("b")]), .paragraph([[.text("#### not")]]),
        ])
    }

    func testIsoDatesWithMicroseconds() {
        XCTAssertNotNil(parseIsoDate("2026-09-25T13:00:00.123456Z"))
        XCTAssertNotNil(parseIsoDate("2026-09-25T13:00:00Z"))
        XCTAssertNotNil(parseIsoDate("2026-09-25T13:00:00.5+00:00"))
    }

    func testGroupMentionTokens() {
        XCTAssertEqual(BodyTokenizer.tokenize("<@group:00000000-0000-7000-8000-00000000000a> and <@00000000-0000-7000-8000-000000000001>"), [
            .mentionGroup("00000000-0000-7000-8000-00000000000a"), .text(" and "), .mention("00000000-0000-7000-8000-000000000001"),
        ])
    }
}
