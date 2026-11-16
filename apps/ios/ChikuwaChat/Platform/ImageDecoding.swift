import ImageIO
import UIKit

/// Pictures from a server decoded at the size they are shown (2026-11-16, a hostile-server review): `UIImage(data:)`
/// decodes at the file's own size when drawn, so a small file declaring a huge canvas (a PNG of 30,000 × 30,000 is a
/// few kilobytes) took gigabytes and the app with it. ImageIO reads the dimensions from the header first, refuses
/// absurd ones, and makes the picture at the size asked for (never larger than the source). Compiled into the app and
/// the widgets (the workspace icons in their headers).
enum ImageDecoding {
    /// More pixels than this (width × height) is no picture of ours: refused undecoded. The largest phone photos are
    /// some 200 megapixels.
    static let maxSourcePixels = 250_000_000

    /// Display sizes (pixels on the longer side): a workspace icon's tile, a profile picture, a link card's image.
    static let iconPixels = 256
    static let avatarPixels = 512
    static let previewPixels = 256
    /// A thumbnail or an album's display size (the server makes them at most 2048 px).
    static let thumbnailPixels = 2048
    /// A photo opened full screen (and zoomed): up to this many pixels in all (48 MP iPhone photos stay whole).
    static let viewerPixels = 50_000_000

    /// `data` at most `maxPixelSize` on its longer side; nil when it is no image or its dimensions are absurd.
    static func downsample(_ data: Data, maxPixelSize: Int) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
        return thumbnail(source, maxPixelSize: maxPixelSize)
    }

    /// The same off the main thread (a large canvas takes a while to scale down).
    static func downsampleOff(_ data: Data, maxPixelSize: Int) async -> UIImage? {
        await Task.detached(priority: .userInitiated) { downsample(data, maxPixelSize: maxPixelSize) }.value
    }

    /// The same from a file (not read into memory first).
    static func downsample(contentsOf url: URL, maxPixelSize: Int) -> UIImage? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
        return thumbnail(source, maxPixelSize: maxPixelSize)
    }

    /// A file's picture with at most `maxPixels` pixels in all: its own size when it has fewer (a zoom shows every
    /// pixel), else scaled down to that.
    static func decode(contentsOf url: URL, maxPixels: Int = viewerPixels) -> UIImage? {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
              let size = pixelSize(source) else { return nil }
        return thumbnail(source, maxPixelSize: longSide(size, maxPixels: maxPixels))
    }

    /// The longer side a picture of `size` may have so that it holds at most `maxPixels` pixels.
    static func longSide(_ size: (width: Int, height: Int), maxPixels: Int) -> Int {
        let pixels = Double(size.width) * Double(size.height)
        let long = max(size.width, size.height)
        guard pixels > Double(maxPixels), pixels > 0 else { return long }
        return max(1, Int((Double(long) * (Double(maxPixels) / pixels).squareRoot()).rounded(.down)))
    }

    /// The first image's dimensions from the header (orientation not applied); nil when they cannot be read or are
    /// absurd (zero, or more than `maxSourcePixels`).
    static func pixelSize(_ source: CGImageSource) -> (width: Int, height: Int)? {
        guard CGImageSourceGetCount(source) > 0,
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue,
              let height = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue,
              width > 0, height > 0, Double(width) * Double(height) <= Double(maxSourcePixels) else { return nil }
        return (width, height)
    }

    private static func thumbnail(_ source: CGImageSource, maxPixelSize: Int) -> UIImage? {
        guard let size = pixelSize(source) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: max(1, min(maxPixelSize, max(size.width, size.height))),
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        return UIImage(cgImage: image)
    }
}
