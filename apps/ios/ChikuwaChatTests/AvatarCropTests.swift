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
