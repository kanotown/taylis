import PDFKit
import SwiftUI
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

    // MARK: pull down to close (as photos)

    func testAPullClosesOnlyDownFromTheTopUnzoomed() {
        XCTAssertTrue(DocumentDismiss.begins(motion: CGPoint(x: 0, y: 20), atTop: true, zoomed: false))
        XCTAssertTrue(DocumentDismiss.begins(motion: CGPoint(x: 5, y: 20), atTop: true, zoomed: false))
        XCTAssertFalse(DocumentDismiss.begins(motion: CGPoint(x: 0, y: -20), atTop: true, zoomed: false)) // scrolls on
        XCTAssertFalse(DocumentDismiss.begins(motion: CGPoint(x: 30, y: 20), atTop: true, zoomed: false)) // sideways
        XCTAssertFalse(DocumentDismiss.begins(motion: CGPoint(x: 0, y: 20), atTop: false, zoomed: false)) // scrolls back up
        XCTAssertFalse(DocumentDismiss.begins(motion: CGPoint(x: 0, y: 20), atTop: true, zoomed: true))   // pans the page
        XCTAssertFalse(DocumentDismiss.begins(motion: .zero, atTop: true, zoomed: false))
    }

    func testThePullFollowsTheFingerDownOnly() {
        XCTAssertEqual(DocumentDismiss.pull(120), 120)
        XCTAssertEqual(DocumentDismiss.pull(-40), 0)
    }

    func testTopAndZoomFromTheScrollViewAndScale() {
        XCTAssertTrue(DocumentDismiss.isAtTop(offsetY: -100, insetTop: 100))
        XCTAssertTrue(DocumentDismiss.isAtTop(offsetY: -99.5, insetTop: 100))
        XCTAssertFalse(DocumentDismiss.isAtTop(offsetY: 40, insetTop: 0))
        XCTAssertFalse(DocumentDismiss.isZoomed(scale: 0.5, fit: 0.5))
        XCTAssertFalse(DocumentDismiss.isZoomed(scale: 0.3, fit: 0.5)) // zoomed out: still closes
        XCTAssertTrue(DocumentDismiss.isZoomed(scale: 1.0, fit: 0.5))
        XCTAssertFalse(DocumentDismiss.isZoomed(scale: 1.0, fit: 0))
    }

    func testReleaseUsesThePhotoViewersThresholdAndFlick() {
        XCTAssertTrue(ViewerDismiss.shouldClose(offset: 200, velocity: 0, extent: 800))
        XCTAssertFalse(ViewerDismiss.shouldClose(offset: 60, velocity: 0, extent: 800))
        XCTAssertTrue(ViewerDismiss.shouldClose(offset: 30, velocity: 1200, extent: 800))
        XCTAssertFalse(ViewerDismiss.shouldClose(offset: 200, velocity: -600, extent: 800))
    }


    /// A real PDFView with five pages, as the viewer shows it (PDFKitView in a hosting controller in the app's window
    /// scene, measured once it is laid out): the pull begins at the top, not after scrolling down, not while zoomed in.
    /// (A bare PDFView added to a window by hand starts 3 pt below its top on iOS 27 — PDFKit's page break margin — which
    /// the viewer never does: the earlier version of this test measured that.)
    func testTheViewersPullFollowsTheRealPDFView() async throws {
        let renderer = UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: 612, height: 792))
        let data = renderer.pdfData { context in
            for i in 1...5 {
                context.beginPage()
                ("Page \(i)" as NSString).draw(at: CGPoint(x: 72, y: 72), withAttributes: [.font: UIFont.systemFont(ofSize: 48)])
            }
        }
        let document = try XCTUnwrap(PDFDocument(data: data))
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previous = scene.windows.first { $0.isKeyWindow }
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 390, height: 700)
        let host = UIHostingController(rootView: PDFKitView(document: document))
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer {
            window.isHidden = true
            previous?.makeKeyAndVisible()
        }
        func find(_ root: UIView) -> PDFView? {
            if let pdf = root as? PDFView { return pdf }
            for child in root.subviews { if let found = find(child) { return found } }
            return nil
        }
        // Laid out: the pages fill the width and the scroll view has its content.
        // The viewer's own controller (the pull's delegate), wired by PDFKitView.
        func controller(_ pdf: PDFView) -> DocumentPullController? {
            pdf.gestureRecognizers?.compactMap { $0.delegate as? DocumentPullController }.first
        }
        var found: (PDFView, DocumentPullController, UIScrollView)?
        for _ in 0..<40 {
            host.view.layoutIfNeeded()
            if let pdf = find(host.view), pdf.scaleFactorForSizeToFit > 0, let pull = controller(pdf), let scroll = pull.scrollView,
               scroll.contentSize.height > pdf.bounds.height {
                found = (pdf, pull, scroll)
                break
            }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        let (pdf, pull, scroll) = try XCTUnwrap(found, "the PDFView laid out")
        XCTAssertTrue(pull.isAtTop, "offset \(scroll.contentOffset.y), inset \(scroll.adjustedContentInset.top)")
        XCTAssertFalse(pull.isZoomed)
        XCTAssertTrue(pull.begins(motion: CGPoint(x: 0, y: 20)))
        XCTAssertFalse(pull.begins(motion: CGPoint(x: 0, y: -20)))

        scroll.contentOffset = CGPoint(x: 0, y: scroll.contentSize.height / 2)
        XCTAssertFalse(pull.isAtTop)
        XCTAssertFalse(pull.begins(motion: CGPoint(x: 0, y: 20)))

        scroll.contentOffset = CGPoint(x: 0, y: -scroll.adjustedContentInset.top)
        XCTAssertTrue(pull.isAtTop)
        pdf.scaleFactor = pdf.scaleFactorForSizeToFit * 3
        XCTAssertTrue(pull.isZoomed)
        XCTAssertFalse(pull.begins(motion: CGPoint(x: 0, y: 20)))
    }
}
