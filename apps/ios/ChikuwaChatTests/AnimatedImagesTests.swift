import ImageIO
import UIKit
import UniformTypeIdentifiers
import XCTest
@testable import ChikuwaChat

/// docs/MOBILE_UI.md §22.10: animated GIFs move in the conversation's tiles and the viewer.
@MainActor
final class AnimatedImagesTests: XCTestCase {
    /// 40 × 40, three frames of 0.05 s, written by Pillow with optimisation: frame 1 is only the 10 × 10 blue square at
    /// the top left, frame 2 only the 10 × 10 green one at the bottom right (each kept on the one before, disposal 1),
    /// and no loop count (a browser would play it once; the app loops it anyway).
    static let partialGIF = Data(base64Encoded: """
    R0lGODlhKAAoAIEAAP8AAAAAAAAAAAAAACH5BAQFAAAALAAAAAAoACgAAAhDAAEIHEiwoMGDCBMqXMiwocOHECNKnEixosWLGDNq3Mixo8ePIEOKHEmypMmTKFOqXMmypcuXMGPKnEmzps2bOAkGBAAh+QQFBQACACwAAAAACgAKAIH/AAAAAP8AAAAAAAAIEgADCBxIsKDBgwgTKlzIsGHCgAAh+QQFBQADACweAB4ACgAKAIEA/wD/AAAAAP8AAAAIEgABCBxIsKDBgwgTKlzIsGHCgAA7
    """.replacingOccurrences(of: "\n", with: ""))!

    /// A GIF of `count` frames of `size`, each one colour, written by ImageIO.
    static func gif(count: Int, size: CGSize = CGSize(width: 20, height: 10), delay: Double = 0.02) -> Data {
        let data = NSMutableData()
        let destination = CGImageDestinationCreateWithData(data, UTType.gif.identifier as CFString, count, nil)!
        for i in 0..<count {
            let image = UIGraphicsImageRenderer(size: size, format: { let f = UIGraphicsImageRendererFormat(); f.scale = 1; return f }()).image { context in
                UIColor(hue: CGFloat(i) / CGFloat(max(count, 1)), saturation: 1, brightness: 1, alpha: 1).setFill()
                context.fill(CGRect(origin: .zero, size: size))
            }
            let properties = [kCGImagePropertyGIFDictionary: [kCGImagePropertyGIFDelayTime: delay]] as CFDictionary
            CGImageDestinationAddImage(destination, image.cgImage!, properties)
        }
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        return data as Data
    }

    /// The RGB at (x, y) of `image`, top-left origin.
    static func pixel(_ image: CGImage, _ x: Int, _ y: Int) -> (r: UInt8, g: UInt8, b: UInt8) {
        var bytes = [UInt8](repeating: 0, count: 4)
        let context = CGContext(data: &bytes, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
                                space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.draw(image, in: CGRect(x: -x, y: -(image.height - 1 - y), width: image.width, height: image.height))
        return (bytes[0], bytes[1], bytes[2])
    }

    // MARK: rules

    func testWhichTilesAreGIFs() {
        XCTAssertTrue(AnimatedImageRules.isGIF(contentType: "image/gif", filename: "a.bin"))
        XCTAssertTrue(AnimatedImageRules.isGIF(contentType: "IMAGE/GIF", filename: "a"))
        XCTAssertTrue(AnimatedImageRules.isGIF(contentType: "application/octet-stream", filename: "Party.GIF"))
        XCTAssertFalse(AnimatedImageRules.isGIF(contentType: "image/png", filename: "a.png"))
        XCTAssertFalse(AnimatedImageRules.isGIF(contentType: "image/webp", filename: "a.webp"))
    }

    func testATileMovesOnlyWhenNothingKeepsItStill() {
        typealias C = AnimatedImageRules.Conditions
        func moves(_ conditions: C, size: Int64 = 1 << 20, type: String = "image/gif") -> Bool {
            AnimatedImageRules.tileAnimates(contentType: type, filename: "a.gif", sizeBytes: size, conditions: conditions)
        }
        XCTAssertTrue(moves(C()))
        XCTAssertFalse(moves(C(reduceMotion: true)))
        XCTAssertFalse(moves(C(playAnimatedImages: false)))
        XCTAssertFalse(moves(C(lowPower: true)))
        XCTAssertFalse(moves(C(lowData: true)))
        XCTAssertTrue(moves(C(), size: AnimatedImageRules.tileMaxBytes))
        XCTAssertFalse(moves(C(), size: AnimatedImageRules.tileMaxBytes + 1))
        XCTAssertFalse(moves(C(), size: 0))
        XCTAssertFalse(AnimatedImageRules.tileAnimates(contentType: "image/png", filename: "a.png", sizeBytes: 100, conditions: C()))
    }

    func testFramesAreDecodedWithinTheMemoryCaps() {
        // Small: its own size.
        XCTAssertEqual(AnimatedImageRules.decodePixels(width: 480, height: 270), 480)
        // 2048 × 2048 is exactly 16 MB a frame; 4096 × 4096 is decoded at 2048.
        XCTAssertEqual(AnimatedImageRules.decodePixels(width: 2048, height: 2048), 2048)
        XCTAssertEqual(AnimatedImageRules.decodePixels(width: 4096, height: 4096), 2048)
        let side = AnimatedImageRules.decodePixels(width: 8000, height: 2000)
        let frame = AnimatedImageRules.frameSize(width: 8000, height: 2000, longSide: side)
        XCTAssertLessThanOrEqual(frame.width * frame.height * 4, AnimatedImageRules.maxFrameBytes)
        XCTAssertGreaterThan(frame.width * frame.height * 4, AnimatedImageRules.maxFrameBytes * 9 / 10)
        // A tile: no more than fills its box (a wide GIF in a square tile covers its height).
        XCTAssertEqual(AnimatedImageRules.decodePixels(width: 1000, height: 500, fill: CGSize(width: 300, height: 300)), 600)
        XCTAssertEqual(AnimatedImageRules.decodePixels(width: 200, height: 100, fill: CGSize(width: 840, height: 420)), 200)
        // Kept frames: within the budget only.
        XCTAssertTrue(AnimatedImageRules.keepsFrames(count: 30, width: 400, height: 300, budget: AnimatedImageRules.viewerCacheBytes))
        XCTAssertFalse(AnimatedImageRules.keepsFrames(count: 200, width: 800, height: 600, budget: AnimatedImageRules.viewerCacheBytes))
        XCTAssertFalse(AnimatedImageRules.keepsFrames(count: 10, width: 840, height: 840, budget: AnimatedImageRules.tileCacheBytes))
    }

    // MARK: decoding

    func testAStillImageHasNoAnimation() {
        let png = UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4)).pngData { _ in }
        XCTAssertNil(AnimatedImageSource(data: png))
        XCTAssertNil(AnimatedImageSource(data: Self.gif(count: 1)))
        XCTAssertNil(AnimatedImageSource(data: Data("nope".utf8)))
    }

    func testFramesAreComposedAsBrowsersShowThem() throws {
        let source = try XCTUnwrap(AnimatedImageSource(data: Self.partialGIF))
        XCTAssertEqual(source.count, 3)
        XCTAssertEqual(source.width, 40)
        XCTAssertEqual(source.height, 40)
        XCTAssertEqual(source.delays, [0.05, 0.05, 0.05])
        // Full size: the last frame holds the red ground, the blue square of frame 1 and its own green one.
        let last = try XCTUnwrap(source.frame(2, longSide: 40))
        XCTAssertEqual(last.width, 40)
        XCTAssertEqual(Self.pixel(last, 20, 20).r, 255)
        XCTAssertEqual(Self.pixel(last, 5, 5).b, 255)
        XCTAssertEqual(Self.pixel(last, 35, 35).g, 255)
        // Decoded smaller (the memory cap), the same picture.
        let small = try XCTUnwrap(source.frame(2, longSide: 20))
        XCTAssertEqual(small.width, 20)
        XCTAssertGreaterThan(Self.pixel(small, 10, 10).r, 200)
        XCTAssertGreaterThan(Self.pixel(small, 2, 2).b, 200)
        XCTAssertGreaterThan(Self.pixel(small, 17, 17).g, 200)
    }

    func testThePlayerLoopsAndKeepsFramesOnlyWithinItsBudget() async throws {
        let source = try XCTUnwrap(AnimatedImageSource(data: Self.gif(count: 3)))
        let player = AnimatedImagePlayer(source: source, longSide: 20, cacheBudget: 10_000)
        XCTAssertTrue(player.keepsFrames)
        var shown: [UIImage] = []
        player.onFrame = { shown.append($0) }
        player.play()
        for _ in 0..<200 where shown.count < 7 { try await Task.sleep(nanoseconds: 10_000_000) }
        player.stop()
        XCTAssertGreaterThanOrEqual(shown.count, 7)
        XCTAssertFalse(player.isPlaying)
        XCTAssertEqual(player.keptFrames, 3)
        XCTAssertTrue(shown[3] === shown[0])  // the second loop shows the kept frames
        // Stopped, nothing more comes; played again, it goes on.
        let count = shown.count
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(shown.count, count)

        let tight = AnimatedImagePlayer(source: source, longSide: 20, cacheBudget: 20 * 10 * 4 * 2)
        XCTAssertFalse(tight.keepsFrames)
        var frames = 0
        tight.onFrame = { _ in frames += 1 }
        tight.play()
        for _ in 0..<200 where frames < 4 { try await Task.sleep(nanoseconds: 10_000_000) }
        tight.stop()
        XCTAssertGreaterThanOrEqual(frames, 4)
        XCTAssertEqual(tight.keptFrames, 0)
    }

    // MARK: tiles

    func testOnlySoManyTilesMoveAtOnce() async throws {
        let slots = AnimatedTileSlots(limit: 2)
        let a = UUID(), b = UUID(), c = UUID(), d = UUID()
        let gotA = await slots.acquire(a)
        let gotB = await slots.acquire(b)
        XCTAssertTrue(gotA)
        XCTAssertTrue(gotB)
        var cGot: Bool?
        let waitC = Task { cGot = await slots.acquire(c) }
        let waitD = Task { await slots.acquire(d) }
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertNil(cGot)
        XCTAssertEqual(slots.playing, [a, b])
        // A tile that leaves the screen while waiting gives its turn up.
        waitD.cancel()
        let dGot = await waitD.value
        XCTAssertFalse(dGot)
        slots.release(a)
        await waitC.value
        XCTAssertEqual(cGot, true)
        XCTAssertEqual(slots.playing, [b, c])
        slots.release(b)
        slots.release(c)
        XCTAssertTrue(slots.playing.isEmpty)
    }

    func testATileShowsFramesWhilePlayingAndTheStillAfter() async throws {
        let tile = AnimatedTile(slots: AnimatedTileSlots(limit: 1))
        let data = Self.gif(count: 4, size: CGSize(width: 400, height: 200))
        let task = Task { await tile.run(key: UUID().uuidString, fill: CGSize(width: 100, height: 100)) { data } }
        for _ in 0..<200 where tile.frame == nil { try await Task.sleep(nanoseconds: 10_000_000) }
        let frame = try XCTUnwrap(tile.frame)
        XCTAssertEqual(frame.cgImage?.width, 200)   // decoded to fill the 100 px tile, not at 400
        task.cancel()
        await task.value
        XCTAssertNil(tile.frame)
        XCTAssertFalse(tile.still)

        let still = AnimatedTile(slots: AnimatedTileSlots(limit: 1))
        await still.run(key: UUID().uuidString, fill: CGSize(width: 100, height: 100)) { Self.gif(count: 1) }
        XCTAssertTrue(still.still)
    }

    // MARK: viewer

    func testTheViewerPlaysOnlyTheShownPhoto() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let gif = directory.appendingPathComponent("a.gif")
        try Self.gif(count: 3, size: CGSize(width: 30, height: 20)).write(to: gif)
        let items = ["g0", "g1"].map { id in
            AttachmentOut(id: id, filename: "\(id).gif", contentType: "image/gif", sizeBytes: 100, width: 30, height: 20, hasThumbnail: true,
                          status: "attached", createdAt: "2026-10-29T00:00:00Z")
        }
        let pager = ImagePagerController(items: items, start: 0) { _ in gif }
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        window.rootViewController = pager
        window.makeKeyAndVisible()
        pager.view.layoutIfNeeded()
        for _ in 0..<200 where pager.pages[0].player?.isPlaying != true || pager.pages[1].player == nil {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertEqual(pager.pages[0].player?.isPlaying, true)
        XCTAssertEqual(pager.pages[1].player?.isPlaying, false)  // the neighbour waits on its first frame
        // The frames replace the image in place: the photo moves.
        var seen = Set<ObjectIdentifier>()
        for _ in 0..<100 where seen.count < 3 {
            if let image = pager.pages[0].imageView.image { seen.insert(ObjectIdentifier(image)) }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        XCTAssertGreaterThanOrEqual(seen.count, 3)
        // Turned to the second photo: it moves, the first stops.
        XCTAssertTrue(pager.go(by: 1))
        XCTAssertEqual(pager.pages[1].player?.isPlaying, true)
        XCTAssertEqual(pager.pages[0].player?.isPlaying, false)
        // Zoom still works on a moving photo.
        pager.pages[1].scrollView.setZoomScale(2, animated: false)
        XCTAssertTrue(pager.pages[1].isZoomed)
        XCTAssertEqual(pager.pages[1].player?.isPlaying, true)
        window.isHidden = true
    }
}
