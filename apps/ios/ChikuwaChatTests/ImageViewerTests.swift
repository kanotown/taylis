import ImageIO
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

    /// A tap hides the bars and another shows them (2026-10-27); with VoiceOver they stay, and turning it on shows them.
    func testATapTogglesTheBarsExceptWithVoiceOver() {
        XCTAssertTrue(ViewerChrome.afterTap(hidden: false, voiceOver: false))
        XCTAssertFalse(ViewerChrome.afterTap(hidden: true, voiceOver: false))
        XCTAssertFalse(ViewerChrome.afterTap(hidden: false, voiceOver: true))
        XCTAssertFalse(ViewerChrome.afterTap(hidden: true, voiceOver: true))
        XCTAssertFalse(ViewerChrome.whenVoiceOverChanges(hidden: true, voiceOver: true))
        XCTAssertTrue(ViewerChrome.whenVoiceOverChanges(hidden: true, voiceOver: false))
        XCTAssertFalse(ViewerChrome.whenVoiceOverChanges(hidden: false, voiceOver: false))
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

    /// Each photo's single tap reaches the viewer (its bars); a double tap stays the zoom's: both sit on the zoom view.
    func testASingleTapOnAPhotoReachesTheViewer() {
        let pager = makePager(count: 2, start: 0) { _ in }
        var taps = 0
        pager.onTap = { taps += 1 }
        let page = pager.pages[1]
        XCTAssertEqual(page.singleTap.numberOfTapsRequired, 1)
        XCTAssertEqual(page.doubleTap.numberOfTapsRequired, 2)
        XCTAssertTrue(page.scrollView.gestureRecognizers?.contains(page.singleTap) == true)
        XCTAssertTrue(page.scrollView.gestureRecognizers?.contains(page.doubleTap) == true)
        page.onSingleTap()
        pager.pages[0].onSingleTap()
        XCTAssertEqual(taps, 2)
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

/// The squares behind a transparent photo (PREVIEWS.md §15).
final class CheckerboardTests: XCTestCase {
    private func picture(_ size: CGSize, opaque: Bool) -> UIImage {
        let format = UIGraphicsImageRendererFormat.default()
        format.opaque = opaque
        format.scale = 1
        return UIGraphicsImageRenderer(size: size, format: format).image { context in
            UIColor.red.setFill()
            context.fill(CGRect(x: 0, y: 0, width: size.width / 2, height: size.height))
        }
    }

    func testOnlyAPictureWithAnAlphaChannelGetsTheSquares() throws {
        let transparent = picture(CGSize(width: 20, height: 10), opaque: false)
        XCTAssertTrue(Checkerboard.hasAlpha(transparent))
        XCTAssertFalse(Checkerboard.hasAlpha(picture(CGSize(width: 20, height: 10), opaque: true)))
        // Decoded from the files the viewer reads: a PNG keeps its alpha, a JPEG has none.
        XCTAssertTrue(Checkerboard.hasAlpha(UIImage(data: try XCTUnwrap(transparent.pngData()))))
        XCTAssertFalse(Checkerboard.hasAlpha(UIImage(data: try XCTUnwrap(transparent.jpegData(compressionQuality: 0.8)))))
        XCTAssertFalse(Checkerboard.hasAlpha(nil))
    }

    func testTheFittedRectangle() {
        let bounds = CGRect(x: 0, y: 0, width: 390, height: 844)
        XCTAssertEqual(Checkerboard.fittedRect(of: CGSize(width: 200, height: 100), in: bounds), CGRect(x: 0, y: 324.5, width: 390, height: 195))
        XCTAssertEqual(Checkerboard.fittedRect(of: CGSize(width: 100, height: 400), in: bounds), CGRect(x: 89.5, y: 0, width: 211, height: 844))
        XCTAssertEqual(Checkerboard.fittedRect(of: .zero, in: bounds), .zero)
    }

    func testTheSquaresAreThePhotosRectangleAndFollowTheZoom() {
        let page = ImagePageView(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        page.layoutIfNeeded()
        page.state = .shown(picture(CGSize(width: 200, height: 100), opaque: false))
        XCTAssertFalse(page.checker.isHidden)
        XCTAssertEqual(page.checker.frame, CGRect(x: 0, y: 324.5, width: 390, height: 195))
        // Behind the photo, never over it.
        XCTAssertLessThan(page.scrollView.subviews.firstIndex(of: page.checker)!, page.scrollView.subviews.firstIndex(of: page.imageView)!)
        page.scrollView.setZoomScale(2, animated: false)
        XCTAssertEqual(page.checker.frame.width, 780, accuracy: 0.5)
        XCTAssertEqual(page.checker.frame.height, 390, accuracy: 0.5)
        XCTAssertEqual(page.checker.frame.minY, 649, accuracy: 0.5)
        // An opaque photo (and none, while loading) keeps the black.
        page.state = .shown(picture(CGSize(width: 200, height: 100), opaque: true))
        XCTAssertTrue(page.checker.isHidden)
        page.state = .shown(picture(CGSize(width: 200, height: 100), opaque: false))
        XCTAssertFalse(page.checker.isHidden)
        page.state = .loading
        XCTAssertTrue(page.checker.isHidden)
    }
}

/// 2026-11-16 (a hostile-server review): pictures from a server are decoded at the size they are shown, absurd canvases
/// are refused before any pixel is decoded, and a picture's answer is read only up to its cap.
@MainActor
final class ImageDecodingTests: XCTestCase {
    /// A PNG whose header declares `width` × `height` and holds no pixels (a few dozen bytes; decoded whole, gigabytes).
    static func declaredPNG(width: UInt32, height: UInt32) -> Data {
        func crc32(_ bytes: [UInt8]) -> UInt32 {
            var crc: UInt32 = 0xFFFF_FFFF
            for byte in bytes {
                crc ^= UInt32(byte)
                for _ in 0..<8 { crc = crc & 1 == 1 ? (crc >> 1) ^ 0xEDB8_8320 : crc >> 1 }
            }
            return ~crc
        }
        func be(_ value: UInt32) -> [UInt8] { [UInt8(value >> 24), UInt8(value >> 16 & 0xff), UInt8(value >> 8 & 0xff), UInt8(value & 0xff)] }
        func chunk(_ type: String, _ body: [UInt8]) -> [UInt8] {
            let typed = Array(type.utf8) + body
            return be(UInt32(body.count)) + typed + be(crc32(typed))
        }
        let header = be(width) + be(height) + [8, 6, 0, 0, 0] // 8-bit RGBA
        let pixels: [UInt8] = [0x78, 0x9C, 0x63, 0x00, 0x00, 0x00, 0x01, 0x00, 0x01] // zlib of a single byte
        return Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] + chunk("IHDR", header) + chunk("IDAT", pixels) + chunk("IEND", []))
    }

    private func png(_ size: CGSize) -> Data {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: size, format: format).image { context in
            UIColor.systemTeal.setFill()
            context.fill(CGRect(origin: .zero, size: size))
        }.pngData()!
    }

    func testPicturesAreDecodedAtTheSizeShown() throws {
        let wide = png(CGSize(width: 1000, height: 500))
        let icon = try XCTUnwrap(ImageDecoding.downsample(wide, maxPixelSize: ImageDecoding.iconPixels))
        XCTAssertEqual(icon.cgImage?.width, 256)
        XCTAssertEqual(icon.cgImage?.height, 128)
        // Never enlarged.
        let small = try XCTUnwrap(ImageDecoding.downsample(png(CGSize(width: 40, height: 20)), maxPixelSize: 512))
        XCTAssertEqual(small.cgImage?.width, 40)
        XCTAssertNil(ImageDecoding.downsample(Data("<svg/>".utf8), maxPixelSize: 256))
        // A viewer keeps every pixel under its budget and scales a larger one down to it.
        XCTAssertEqual(ImageDecoding.longSide((8064, 6048), maxPixels: ImageDecoding.viewerPixels), 8064, "a 48 MP photo stays whole")
        let scaled = ImageDecoding.longSide((20000, 10000), maxPixels: ImageDecoding.viewerPixels)
        XCTAssertLessThanOrEqual(Double(scaled) * Double(scaled) / 2, Double(ImageDecoding.viewerPixels))
        XCTAssertGreaterThan(scaled, 9000)
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("decode-\(UUID().uuidString).png")
        try wide.write(to: file)
        defer { try? FileManager.default.removeItem(at: file) }
        XCTAssertEqual(ImageDecoding.decode(contentsOf: file)?.cgImage?.width, 1000)
        XCTAssertEqual(ImageDecoding.downsample(contentsOf: file, maxPixelSize: 100)?.cgImage?.width, 100)
    }

    func testAnAbsurdCanvasIsRefusedUndecoded() throws {
        let bomb = Self.declaredPNG(width: 30000, height: 30000) // 900 MP declared in some 70 bytes
        XCTAssertLessThan(bomb.count, 200)
        let source = try XCTUnwrap(CGImageSourceCreateWithData(bomb as CFData, nil))
        XCTAssertNil(ImageDecoding.pixelSize(source))
        XCTAssertNil(ImageDecoding.downsample(bomb, maxPixelSize: 256))
        XCTAssertNil(CustomEmoji.decode(bomb), "an emoji too")
        XCTAssertNil(CustomEmoji.decode(Self.declaredPNG(width: 5000, height: 5000)), "an emoji's own limit")
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("bomb-\(UUID().uuidString).png")
        try bomb.write(to: file)
        defer { try? FileManager.default.removeItem(at: file) }
        XCTAssertNil(ImageDecoding.decode(contentsOf: file))
        XCTAssertNil(ImagePagerController.decode(file))
    }

    /// fetchData's cap: a declared length over it is refused at once, an answer that grows past it as it comes.
    func testAPicturesAnswerIsReadOnlyUpToItsCap() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [StubProtocol.self]
        let api = ApiClient(baseUrl: URL(string: "http://server")!, session: URLSession(configuration: configuration))
        defer { StubProtocol.handler = nil }
        StubProtocol.handler = { _ in (200, Data(count: ApiClient.maxIconBytes + 1)) }
        do {
            _ = try await api.fetchData("/api/v1/users/u/avatar", maxBytes: ApiClient.maxIconBytes)
            XCTFail("an answer over the cap was taken")
        } catch {
            XCTAssertEqual((error as? ApiError)?.code, "response_too_large")
        }
        StubProtocol.handler = { _ in (200, Data(count: 1000)) }
        let fits = try await api.fetchData("/api/v1/users/u/avatar", maxBytes: ApiClient.maxIconBytes)
        XCTAssertEqual(fits.count, 1000)
        // Without a cap (a file's own bytes) nothing changes; an error answer still reads as before.
        StubProtocol.handler = { _ in (200, Data(count: ApiClient.maxIconBytes + 1)) }
        let file = try await api.fetchData("/api/v1/attachments/a/content")
        XCTAssertEqual(file.count, ApiClient.maxIconBytes + 1)
        StubProtocol.handler = { _ in (404, Data(#"{"error":{"code":"attachment_not_found","message":"x","details":{}}}"#.utf8)) }
        do {
            _ = try await api.fetchData("/api/v1/attachments/a/thumbnail", maxBytes: ApiClient.maxImageBytes)
            XCTFail("a 404 was taken")
        } catch {
            XCTAssertEqual((error as? ApiError)?.code, "attachment_not_found")
        }
    }
}
