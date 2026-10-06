import XCTest
@testable import ChikuwaChat

/// Same cases as the desktop's avatarCrop.test.ts: the three clients crop alike.
final class AvatarCropTests: XCTestCase {
    private let landscape = CGSize(width: 4000, height: 3000)

    func testStartsWithTheCentreSquare() {
        XCTAssertEqual(AvatarCrop().sourceRect(image: landscape, frame: 240), CGRect(x: 500, y: 0, width: 3000, height: 3000))
    }

    func testNeverPansPastTheEdges() {
        // 3000 high fits the 240 frame; 4000 wide shows 320, so 40 of pan each way.
        let crop = AvatarCrop(zoom: 1, offset: CGSize(width: 500, height: 30)).clamped(image: landscape, frame: 240)
        XCTAssertEqual(crop.offset, CGSize(width: 40, height: 0))
        XCTAssertEqual(crop.sourceRect(image: landscape, frame: 240).minX, 0, accuracy: 0.001)
    }

    func testZoomStaysBetweenOneAndFour() {
        XCTAssertEqual(AvatarCrop(zoom: 0.2).clamped(image: landscape, frame: 240).zoom, 1)
        XCTAssertEqual(AvatarCrop(zoom: 9).clamped(image: landscape, frame: 240).zoom, 4)
    }

    func testZoomsAroundThePinchPoint() {
        let before = AvatarCrop().sourceRect(image: landscape, frame: 240)
        let after = AvatarCrop().zoomed(to: 2, at: CGPoint(x: -120, y: -120), image: landscape, frame: 240).sourceRect(image: landscape, frame: 240)
        XCTAssertEqual(after.width, before.width / 2, accuracy: 0.001)
        XCTAssertEqual(after.minX, before.minX, accuracy: 0.001)
        XCTAssertEqual(after.minY, before.minY, accuracy: 0.001)
    }

    // MARK: Gestures follow the fingers from the first movement

    func testAGestureChangesNothingUntilTheFingersMove() {
        let start = AvatarCrop(zoom: 1.5, offset: CGSize(width: 20, height: -10))
        let gesture = AvatarCropGesture(start: start, anchor: CGPoint(x: 30, y: 40), spread: 50)
        XCTAssertEqual(gesture.crop(centroid: CGPoint(x: 30, y: 40), spread: 50, image: landscape, frame: 240), start)
    }

    func testOneFingerPansByExactlyItsMovement() {
        let start = AvatarCrop(zoom: 2, offset: CGSize(width: 10, height: 5))
        let gesture = AvatarCropGesture(start: start, anchor: CGPoint(x: -20, y: 0), spread: 0)
        // The very first step of 1 pt moves the picture 1 pt: no threshold, no slop.
        let first = gesture.crop(centroid: CGPoint(x: -19, y: 0), spread: 0, image: landscape, frame: 240)
        XCTAssertEqual(first, AvatarCrop(zoom: 2, offset: CGSize(width: 11, height: 5)))
        // Totals from the start, not steps: the same position gives the same crop whatever came between.
        let later = gesture.crop(centroid: CGPoint(x: 5, y: 12), spread: 0, image: landscape, frame: 240)
        XCTAssertEqual(later, AvatarCrop(zoom: 2, offset: CGSize(width: 35, height: 17)))
    }

    func testPinchKeepsThePictureUnderTheFingersWhileTheyMove() {
        let start = AvatarCrop(zoom: 1.2, offset: CGSize(width: 15, height: -8))
        let anchor = CGPoint(x: 30, y: -20)
        let gesture = AvatarCropGesture(start: start, anchor: anchor, spread: 40)
        // Spread 1.5×, midpoint moved by (-10, +25).
        let centroid = CGPoint(x: 20, y: 5)
        let crop = gesture.crop(centroid: centroid, spread: 60, image: landscape, frame: 240)
        XCTAssertEqual(crop.zoom, 1.8, accuracy: 0.0001)
        // The picture point that was under the start midpoint is now under the current one.
        let before = pictureUnits(at: anchor, crop: start)
        let after = pictureUnits(at: centroid, crop: crop)
        XCTAssertEqual(after.x, before.x, accuracy: 0.0001)
        XCTAssertEqual(after.y, before.y, accuracy: 0.0001)
    }

    func testGesturesStayWithinZoomLimitsAndCoverTheFrame() {
        let gesture = AvatarCropGesture(start: AvatarCrop(), anchor: .zero, spread: 30)
        let pinchedIn = gesture.crop(centroid: CGPoint(x: 200, y: 200), spread: 10, image: landscape, frame: 240)
        XCTAssertEqual(pinchedIn.zoom, 1)
        XCTAssertEqual(pinchedIn.offset, CGSize(width: 40, height: 0))
        let pinchedOut = gesture.crop(centroid: .zero, spread: 300, image: landscape, frame: 240)
        XCTAssertEqual(pinchedOut.zoom, AvatarCrop.maxZoom)
        // Every update is clamped, not only the first or the last.
        for step in 1...20 {
            let crop = gesture.crop(centroid: CGPoint(x: CGFloat(step) * 30, y: CGFloat(step) * -25), spread: 30 + CGFloat(step), image: landscape, frame: 240)
            XCTAssertEqual(crop, crop.clamped(image: landscape, frame: 240))
        }
    }

    func testCentroidAndSpreadOfTheFingers() {
        XCTAssertEqual(AvatarCropGesture.centroid(of: []).spread, 0)
        let one = AvatarCropGesture.centroid(of: [CGPoint(x: 4, y: -2)])
        XCTAssertEqual(one.centroid, CGPoint(x: 4, y: -2))
        XCTAssertEqual(one.spread, 0)
        let two = AvatarCropGesture.centroid(of: [CGPoint(x: -30, y: 10), CGPoint(x: 10, y: 40)])
        XCTAssertEqual(two.centroid, CGPoint(x: -10, y: 25))
        XCTAssertEqual(two.spread, 25, accuracy: 0.0001)
    }

    /// The picture point (picture units from its centre) shown at a point of the frame (relative to its centre).
    private func pictureUnits(at point: CGPoint, crop: AvatarCrop) -> CGPoint {
        let scale = AvatarCrop.scale(image: landscape, frame: 240, zoom: crop.zoom)
        return CGPoint(x: (point.x - crop.offset.width) / scale, y: (point.y - crop.offset.height) / scale)
    }

    func testRendersA512PixelJpegOfTheChosenSquare() throws {
        // Left half red, right half blue: panning fully right shows the red half only.
        let size = CGSize(width: 400, height: 200)
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        let image = UIGraphicsImageRenderer(size: size, format: format).image { context in
            UIColor.red.setFill(); context.fill(CGRect(x: 0, y: 0, width: 200, height: 200))
            UIColor.blue.setFill(); context.fill(CGRect(x: 200, y: 0, width: 200, height: 200))
        }
        let crop = AvatarCrop(zoom: 1, offset: CGSize(width: 1000, height: 0)).clamped(image: size, frame: 240)
        let data = try XCTUnwrap(crop.render(image, frame: 240))
        let picture = try XCTUnwrap(UIImage(data: data)?.cgImage)
        XCTAssertEqual(picture.width, 512)
        XCTAssertEqual(picture.height, 512)
        let (red, _, blue) = centrePixel(picture)
        XCTAssertGreaterThan(red, 200)
        XCTAssertLessThan(blue, 60)
    }

    /// The middle pixel, read through a known RGBA layout (a decoded JPEG may come in any byte order).
    private func centrePixel(_ image: CGImage) -> (UInt8, UInt8, UInt8) {
        var pixel = [UInt8](repeating: 0, count: 4)
        pixel.withUnsafeMutableBytes { buffer in
            let context = CGContext(data: buffer.baseAddress, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
            context.draw(image, in: CGRect(x: -CGFloat(image.width) / 2, y: -CGFloat(image.height) / 2, width: CGFloat(image.width), height: CGFloat(image.height)))
        }
        return (pixel[0], pixel[1], pixel[2])
    }

    func testDownsamplesALargePhoto() throws {
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        let big = UIGraphicsImageRenderer(size: CGSize(width: 4000, height: 3000), format: format).image { context in
            UIColor.orange.setFill(); context.fill(CGRect(x: 0, y: 0, width: 4000, height: 3000))
        }
        let data = try XCTUnwrap(big.jpegData(compressionQuality: 0.8))
        let small = try XCTUnwrap(ImageUpload.downsampled(data, maxPixel: 1024))
        XCTAssertEqual(max(small.size.width, small.size.height), 1024)
        XCTAssertNil(ImageUpload.downsampled(Data("not an image".utf8)))
    }
}
