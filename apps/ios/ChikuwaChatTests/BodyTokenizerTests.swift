import XCTest
@testable import ChikuwaChat

/// 2026-10-05: blank lines are one paragraph gap, not empty lines (apps/shared/body-paragraphs.json, as the desktop's
/// bodySpacing.test.tsx and Android's BodyParagraphsTest read it).
final class BodyParagraphsFixtureTests: XCTestCase {
    private struct Fixture: Decodable {
        struct Paragraph: Decodable, Equatable { let gap_before: Bool; let gap_after: Bool; let groups: [[String]] }
        struct Case: Decodable { let name: String; let body: String; let paragraphs: [Paragraph] }
        let cases: [Case]
    }

    func testTheSharedCases() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("shared/body-paragraphs.json")
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
        XCTAssertFalse(fixture.cases.isEmpty)
        for c in fixture.cases {
            let paragraphs = BodyTokenizer.parseBlocks(c.body).compactMap { block -> Fixture.Paragraph? in
                guard case .paragraph(let lines) = block else { return nil }
                let layout = BodyTokenizer.paragraphLayout(lines)
                return Fixture.Paragraph(gap_before: layout.gapBefore, gap_after: layout.gapAfter,
                                         groups: layout.groups.map { $0.map(CanvasMarkdownFixtureTests.plain) })
            }
            XCTAssertEqual(paragraphs, c.paragraphs, c.name)
        }
    }
}

/// M107: inline markup — `_` emphasis never inside a word, URLs and e-mail addresses never read for emphasis, backslash
/// escapes — against the cases every client and the server share (apps/shared/inline-format.json).
final class InlineFormatFixtureTests: XCTestCase {
    private struct Fixture: Decodable {
        struct Case: Decodable { let name: String; let line: String; let tokens: [[String]]; let plain: String }
        let cases: [Case]
    }

    private func simple(_ tokens: [BodyToken]) -> [[String]] {
        tokens.map { token in
            switch token {
            case .text(let text): return ["text", text]
            case .bold(let text): return ["bold", text]
            case .italic(let text): return ["italic", text]
            case .strike(let text): return ["strike", text]
            case .code(let text): return ["code", text]
            case .codeBlock(let text, _): return ["codeblock", text]
            case .link(let url, let label): return label.map { ["link", url, $0] } ?? ["link", url]
            case .mention(let id): return ["mention", id]
            case .mentionGroup(let id): return ["mention_group", id]
            case .mentionAll(let target): return ["mention_all", target]
            case .newline: return ["newline"]
            }
        }
    }

    func testTheSharedCases() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("shared/inline-format.json")
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
        XCTAssertGreaterThan(fixture.cases.count, 20)
        for c in fixture.cases {
            XCTAssertEqual(simple(BodyTokenizer.tokenizeInline(c.line)), c.tokens, c.name)
            XCTAssertEqual(simple(BodyTokenizer.tokenize(c.line)), c.tokens, "\(c.name) (whole body)")
            XCTAssertEqual(Timeline.plainText(c.line, limit: 200), c.plain, "\(c.name) (plain)")
        }
    }
}

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

    func testTablesWithAlignmentEscapesAndRaggedRows() {  // M15g
        let body = "予定:\n| 項目 | 担当 | 期限 |\n| :--- | :-: | ---: |\n| API | <@01234567-89ab-cdef-0123-456789abcdef> | 10/2 |\n| a \\| b | **UI** |\n| x | y | z | extra |\n後書き"
        let blocks = BodyTokenizer.parseBlocks(body)
        XCTAssertEqual(blocks.count, 3)
        guard case .table(let align, let header, let rows) = blocks[1] else { return XCTFail("no table: \(blocks)") }
        XCTAssertEqual(align, [.left, .center, .right])
        XCTAssertEqual(header, [[.text("項目")], [.text("担当")], [.text("期限")]])
        XCTAssertEqual(rows.count, 3)
        XCTAssertEqual(rows[0][1], [.mention("01234567-89ab-cdef-0123-456789abcdef")])
        XCTAssertEqual(rows[1][0], [.text("a | b")])
        XCTAssertEqual(rows[1][1], [.bold("UI")])
        XCTAssertEqual(rows[1][2], [])
        XCTAssertEqual(rows[2].count, 3)
        // Without a matching separator the pipes are text.
        if case .paragraph = BodyTokenizer.parseBlocks("a | b\nc | d")[0] {} else { XCTFail("expected a paragraph") }
        XCTAssertEqual(BodyTokenizer.parseBlocks("| a | b |\n| --- |").count, 1)
        XCTAssertEqual(Timeline.excerpt("| 項目 | 担当 |\n| --- | --- |\n| API | 田中 |", attachments: [], users: [:]), "項目 担当 API 田中")
    }

    /// The one-line excerpt matches the web and Android (parity audit 2026-09-29): italics and links keep their text,
    /// and it stops at 80 characters.
    func testExcerptDropsItalicsAndLinkMarkersAndStopsAtEighty() {
        XCTAssertEqual(Timeline.excerpt("*強調* と _斜体_ と [資料](https://example.com/a)", attachments: [], users: [:]), "強調 と 斜体 と 資料")
        let long = String(repeating: "あ", count: 100)
        let excerpt = Timeline.excerpt(long, attachments: [], users: [:])
        XCTAssertEqual(excerpt.count, 80)
        XCTAssertTrue(excerpt.hasSuffix("…"))
    }

    /// M28d: keyword pieces, case-insensitive, the longest keyword first, the rest of the text kept.
    func testKeywordPiecesCutTheTextWhereTheKeywordsAre() {
        let pieces = NotifyKeywords.pieces("Deadline は来週。deadline extension は無し", ["deadline", "deadline extension"])
        XCTAssertEqual(pieces.map(\.text), ["Deadline", " は来週。", "deadline extension", " は無し"])
        XCTAssertEqual(pieces.map(\.hit), [true, false, true, false])
        XCTAssertEqual(NotifyKeywords.pieces("plain", nil).map(\.hit), [false])
        XCTAssertEqual(NotifyKeywords.pieces("plain", [" "]).map(\.text), ["plain"])
    }

    /// A message without text says what was sent (tester, 2026-09-30); the same words as the server's push.
    func testExcerptOfAMessageWithoutTextSaysWhatWasSent() {
        func files(_ types: String...) -> [AttachmentOut] {
            types.enumerated().map { AttachmentOut(id: "\($0.offset)", filename: "f", contentType: $0.element, sizeBytes: 1, width: nil, height: nil,
                                                   hasThumbnail: false, status: "attached", createdAt: "") }
        }
        XCTAssertEqual(Timeline.excerpt("", attachments: [], users: [:]), "")
        XCTAssertEqual(Timeline.excerpt("", attachments: files("image/png"), users: [:]), "画像を送信しました")
        XCTAssertEqual(Timeline.excerpt("", attachments: files("image/png", "image/jpeg", "image/heic"), users: [:]), "画像を 3 枚送信しました")
        XCTAssertEqual(Timeline.excerpt("", attachments: files("video/mp4"), users: [:]), "動画を送信しました")
        XCTAssertEqual(Timeline.excerpt("", attachments: files("video/mp4", "video/quicktime"), users: [:]), "動画を 2 本送信しました")
        XCTAssertEqual(Timeline.excerpt("", attachments: files("application/pdf"), users: [:]), "ファイルを送信しました")
        XCTAssertEqual(Timeline.excerpt("", attachments: files("image/png", "video/mp4"), users: [:]), "ファイルを 2 件送信しました")
        XCTAssertEqual(Timeline.excerpt("写真です", attachments: files("image/png"), users: [:]), "写真です")
    }
}
