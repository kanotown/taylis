import XCTest
@testable import ChikuwaChat

/// M108 (docs/PREVIEWS.md §5): document cards from the server's preview; older servers keep the plain row.
@MainActor
final class DocumentPreviewTests: XCTestCase {
    private let head = #"{"id":"d","filename":"議事録.docx","content_type":"application/vnd.openxmlformats-officedocument.wordprocessingml.document","size_bytes":2048,"width":null,"height":null,"has_thumbnail":false,"status":"attached","created_at":"2026-10-05T00:00:00Z""#

    private func decode(_ tail: String) throws -> AttachmentOut {
        try JSON.snakeDecoder.decode(AttachmentOut.self, from: Data((head + tail + "}").utf8))
    }

    func testAnOldServersAttachmentHasNoPreviewAndKeepsThePlainRow() throws {
        let old = try decode("")
        XCTAssertNil(old.preview)
        XCTAssertFalse(DocumentFit.showsCard(old))
        XCTAssertNil(DocumentFit.thumbHeight(old.preview))
        let none = try decode(#","preview":null"#)
        XCTAssertFalse(DocumentFit.showsCard(none))
        let failed = try decode(#","preview":{"status":"failed","pages":null,"width":null,"height":null}"#)
        XCTAssertFalse(DocumentFit.showsCard(failed))
        XCTAssertEqual(DocumentFit.detail(failed), "2 KB")
    }

    func testAPendingPreviewSaysItIsBeingMade() throws {
        let pending = try decode(#","preview":{"status":"pending","pages":null,"width":null,"height":null}"#)
        XCTAssertTrue(DocumentFit.showsCard(pending))
        XCTAssertNil(DocumentFit.thumbHeight(pending.preview)) // no box until it is ready
        XCTAssertEqual(DocumentFit.detail(pending), "プレビューを作成中…")
    }

    func testAReadyPreviewHasItsBoxFromTheServersNumbers() throws {
        let page = try decode(#","preview":{"status":"ready","pages":3,"width":800,"height":1132}"#)
        XCTAssertTrue(DocumentFit.showsCard(page))
        XCTAssertEqual(page.preview?.pages, 3)
        XCTAssertEqual(DocumentFit.thumbHeight(page.preview), DocumentFit.maxHeight) // a portrait page: its top
        XCTAssertEqual(DocumentFit.detail(page), "2 KB · 3 ページ")
        let slide = try decode(#","preview":{"status":"ready","pages":1,"width":800,"height":450}"#)
        XCTAssertEqual(DocumentFit.thumbHeight(slide.preview), 146) // 260 × 450 / 800, whole
        // Stored on the device as it came (the message cache round-trips it).
        let encoded = try JSON.snakeEncoder.encode(slide)
        XCTAssertEqual(try JSON.snakeDecoder.decode(AttachmentOut.self, from: encoded), slide)
    }

    func testTheSharedPDFIsNamedAfterTheOriginal() {
        XCTAssertEqual(DocumentPDFLoader.pdfName("議事録.docx"), "議事録.pdf")
        XCTAssertEqual(DocumentPDFLoader.pdfName("paper.pdf"), "paper.pdf")
        XCTAssertEqual(DocumentPDFLoader.pdfName("a/b.pptx"), "a_b.pdf")
    }
}
