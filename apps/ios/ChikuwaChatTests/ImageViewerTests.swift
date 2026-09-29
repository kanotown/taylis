import UIKit
import XCTest
@testable import ChikuwaChat

private func attachment(_ id: String, image: Bool = true) -> AttachmentOut {
    AttachmentOut(id: id, filename: "\(id).\(image ? "jpg" : "pdf")", contentType: image ? "image/jpeg" : "application/pdf",
                  sizeBytes: 1000, width: nil, height: nil, hasThumbnail: image, status: "ready", createdAt: "2026-09-29T00:00:00Z")
}

/// Which photos the viewer pages through, where it opens, and which pages load.
final class ImageGalleryTests: XCTestCase {
    func testMessagePhotosInOrderOpeningOnTheTappedOne() {
        let all = [attachment("a"), attachment("doc", image: false), attachment("b"), attachment("c")]
        let pages = ImageGallery.pages(for: all[2], in: all)
        XCTAssertEqual(pages.items.map(\.id), ["a", "b", "c"])  // the document stays out
        XCTAssertEqual(pages.start, 1)
    }

    func testLonePhotoOrUnknownGalleryOpensAlone() {
        let photo = attachment("a")
        XCTAssertEqual(ImageGallery.pages(for: photo, in: []).items.map(\.id), ["a"])
        XCTAssertEqual(ImageGallery.pages(for: photo, in: [attachment("x")]).items.map(\.id), ["a"])
        XCTAssertEqual(ImageGallery.pages(for: photo, in: [photo]).start, 0)
    }

    func testPosition() {
        XCTAssertNil(ImageGallery.position(0, of: 1))
        XCTAssertEqual(ImageGallery.position(1, of: 3), "2 / 3")
        XCTAssertEqual(ImageGallery.spokenPosition(1, of: 3), "3枚中2枚目")
    }

    func testLoadWindowIsTheShownPageFirstThenItsNeighbours() {
        XCTAssertEqual(ImageGallery.window(around: 0, count: 1), [0])
        XCTAssertEqual(ImageGallery.window(around: 0, count: 3), [0, 1])
        XCTAssertEqual(ImageGallery.window(around: 2, count: 5), [2, 3, 1])
        XCTAssertEqual(ImageGallery.window(around: 4, count: 5), [4, 3])
    }
}

/// Swipe to close: which drags close and when a release does.
final class ViewerDismissTests: XCTestCase {
    func testVerticalDragClosesAnyUnzoomedPhoto() {
        for index in 0..<3 {
            XCTAssertEqual(ViewerDismiss.axis(motion: CGPoint(x: 3, y: 12), zoomed: false, settled: true, index: index, count: 3), .vertical)
            XCTAssertEqual(ViewerDismiss.axis(motion: CGPoint(x: 3, y: -12), zoomed: false, settled: true, index: index, count: 3), .vertical)
        }
    }

    func testZoomedOrMovingPagerNeverCloses() {
        XCTAssertNil(ViewerDismiss.axis(motion: CGPoint(x: 0, y: 30), zoomed: true, settled: true, index: 0, count: 1))
        XCTAssertNil(ViewerDismiss.axis(motion: CGPoint(x: 30, y: 0), zoomed: true, settled: true, index: 0, count: 1))
        XCTAssertNil(ViewerDismiss.axis(motion: CGPoint(x: 0, y: 30), zoomed: false, settled: false, index: 1, count: 3))
        XCTAssertNil(ViewerDismiss.axis(motion: .zero, zoomed: false, settled: true, index: 0, count: 1))
    }

    func testSidewaysClosesALonePhotoEitherWay() {
        XCTAssertEqual(ViewerDismiss.axis(motion: CGPoint(x: 12, y: 2), zoomed: false, settled: true, index: 0, count: 1), .horizontal)
        XCTAssertEqual(ViewerDismiss.axis(motion: CGPoint(x: -12, y: 2), zoomed: false, settled: true, index: 0, count: 1), .horizontal)
        XCTAssertNil(ViewerDismiss.horizontalSign(motion: CGPoint(x: -12, y: 0), count: 1))
    }

    func testSidewaysPagesBetweenPhotosAndClosesOnlyOffTheOuterEdges() {
        // first photo: right closes, left pages
        XCTAssertEqual(ViewerDismiss.axis(motion: CGPoint(x: 12, y: 0), zoomed: false, settled: true, index: 0, count: 3), .horizontal)
        XCTAssertNil(ViewerDismiss.axis(motion: CGPoint(x: -12, y: 0), zoomed: false, settled: true, index: 0, count: 3))
        // middle photo: both page
        XCTAssertNil(ViewerDismiss.axis(motion: CGPoint(x: 12, y: 0), zoomed: false, settled: true, index: 1, count: 3))
        XCTAssertNil(ViewerDismiss.axis(motion: CGPoint(x: -12, y: 0), zoomed: false, settled: true, index: 1, count: 3))
        // last photo: left closes, right pages
        XCTAssertEqual(ViewerDismiss.axis(motion: CGPoint(x: -12, y: 0), zoomed: false, settled: true, index: 2, count: 3), .horizontal)
        XCTAssertNil(ViewerDismiss.axis(motion: CGPoint(x: 12, y: 0), zoomed: false, settled: true, index: 2, count: 3))
        XCTAssertEqual(ViewerDismiss.horizontalSign(motion: CGPoint(x: -12, y: 0), count: 3), -1)
        XCTAssertEqual(ViewerDismiss.clamp(30, sign: -1), 0)
        XCTAssertEqual(ViewerDismiss.clamp(-30, sign: -1), -30)
        XCTAssertEqual(ViewerDismiss.clamp(30, sign: nil), 30)
    }

    func testReleaseClosesPastTheThresholdOrOnAFlick() {
        let height: CGFloat = 844
        XCTAssertEqual(ViewerDismiss.threshold(extent: height), 140)
        XCTAssertEqual(ViewerDismiss.threshold(extent: 390), 390 * 0.22, accuracy: 0.001)
        XCTAssertFalse(ViewerDismiss.shouldClose(offset: 60, velocity: 100, extent: height))   // short, slow: back
        XCTAssertTrue(ViewerDismiss.shouldClose(offset: 200, velocity: 0, extent: height))    // far, let go: close
        XCTAssertTrue(ViewerDismiss.shouldClose(offset: -200, velocity: 0, extent: height))   // upward too
        XCTAssertTrue(ViewerDismiss.shouldClose(offset: 20, velocity: 1500, extent: height))  // flick down
        XCTAssertTrue(ViewerDismiss.shouldClose(offset: -20, velocity: -1500, extent: height)) // flick up
        XCTAssertFalse(ViewerDismiss.shouldClose(offset: 200, velocity: -800, extent: height)) // thrown back
        XCTAssertFalse(ViewerDismiss.shouldClose(offset: 0, velocity: 2000, extent: height))
    }

    func testProgressFadesTheBackgroundByHalfTheScreen() {
        XCTAssertEqual(ViewerDismiss.progress(offset: 0, extent: 800), 0)
        XCTAssertEqual(ViewerDismiss.progress(offset: -200, extent: 800), 0.5, accuracy: 0.001)
        XCTAssertEqual(ViewerDismiss.progress(offset: 900, extent: 800), 1)
    }
}

/// The pager itself: opens on the start page, loads lazily, pages and closes only as the rules say.
@MainActor
final class ImagePagerControllerTests: XCTestCase {
    private func makePager(count: Int, start: Int, requested: @escaping (String) -> Void) -> ImagePagerController {
        let items = (0..<count).map { attachment("p\($0)") }
        let pager = ImagePagerController(items: items, start: start) { item in
            requested(item.id)
            return nil  // failed: the page shows 再試行
        }
        pager.view.frame = CGRect(x: 0, y: 0, width: 390, height: 844)
        pager.view.layoutIfNeeded()
        return pager
    }

    func testOpensOnTheStartPageAndLoadsOnlyItAndItsNeighbours() async throws {
        var requested: [String] = []
        let pager = makePager(count: 5, start: 2) { requested.append($0) }
        XCTAssertEqual(pager.index, 2)
        XCTAssertEqual(pager.pages.count, 5)
        XCTAssertEqual(pager.pager.contentOffset.x, CGFloat(2) * (390 + ImagePagerController.gap))
        for _ in 0..<20 where requested.count < 3 { try await Task.sleep(nanoseconds: 20_000_000) }
        XCTAssertEqual(requested, ["p2", "p3", "p1"])
    }

    func testPagingMovesTheIndexAndLoadsTheNextNeighbour() async throws {
        var requested: [String] = []
        let pager = makePager(count: 4, start: 0) { requested.append($0) }
        for _ in 0..<20 where requested.count < 2 { try await Task.sleep(nanoseconds: 20_000_000) }
        XCTAssertTrue(pager.go(by: 1))
        XCTAssertEqual(pager.index, 1)
        XCTAssertFalse(pager.go(by: -2))
        for _ in 0..<20 where !requested.contains("p2") { try await Task.sleep(nanoseconds: 20_000_000) }
        XCTAssertTrue(requested.contains("p2"))
        XCTAssertFalse(requested.contains("p3"))
    }

    func testCloseDragsFollowThePageAndZoom() {
        let pager = makePager(count: 3, start: 0) { _ in }
        XCTAssertEqual(pager.closeAxis(for: CGPoint(x: 0, y: 20)), .vertical)
        XCTAssertEqual(pager.closeAxis(for: CGPoint(x: 20, y: 0)), .horizontal)   // off the first photo's left edge
        XCTAssertNil(pager.closeAxis(for: CGPoint(x: -20, y: 0)))                 // to the second photo
        pager.go(by: 2)
        XCTAssertEqual(pager.closeAxis(for: CGPoint(x: -20, y: 0)), .horizontal)  // off the last photo's right edge
        XCTAssertNil(pager.closeAxis(for: CGPoint(x: 20, y: 0)))
        // Zoomed in, nothing closes and the pager does not turn (the photo pans).
        let page = pager.pages[2]
        page.state = .shown(UIGraphicsImageRenderer(size: CGSize(width: 10, height: 10)).image { _ in })
        page.layoutIfNeeded()
        page.scrollView.setZoomScale(2, animated: false)
        XCTAssertTrue(page.isZoomed)
        XCTAssertFalse(pager.pager.isScrollEnabled)
        XCTAssertNil(pager.closeAxis(for: CGPoint(x: 0, y: 20)))
        // Leaving the page resets its zoom.
        pager.go(by: -1)
        XCTAssertFalse(page.isZoomed)
        XCTAssertTrue(pager.pager.isScrollEnabled)
    }
}
