import ImageIO
import SwiftUI
import UIKit

/// An animated custom emoji (a GIF, testers 2026-09-29: they did not move): its frames, drawn like the still image,
/// and when each ends within one loop.
struct EmojiAnimation {
    let frames: [UIImage]
    let ends: [TimeInterval]

    var duration: TimeInterval { ends.last ?? 0 }

    /// The frame showing `time` seconds into any loop (all copies of an emoji move together).
    func frame(at time: TimeInterval) -> UIImage {
        guard frames.count > 1, duration > 0 else { return frames.first ?? UIImage() }
        let t = time.truncatingRemainder(dividingBy: duration)
        return frames[ends.firstIndex { t < $0 } ?? frames.count - 1]
    }
}

/// Shows a custom emoji's image, moving when it is animated.
struct EmojiImage: View {
    let still: UIImage
    var animation: EmojiAnimation? = nil

    var body: some View {
        if let animation {
            TimelineView(.animation(minimumInterval: 0.04)) { context in
                Image(uiImage: animation.frame(at: context.date.timeIntervalSinceReferenceDate)).resizable().scaledToFit()
            }
        } else {
            Image(uiImage: still).resizable().scaledToFit()
        }
    }
}

/// Custom emoji (M12f): `:name:` in text and reactions renders as the uploaded image.
enum CustomEmoji {
    static let inlineHeight: CGFloat = 20
    private static let exact = try! NSRegularExpression(pattern: "^:([a-z0-9][a-z0-9_+-]{1,31}):$")
    private static let inline = try! NSRegularExpression(pattern: ":([a-z0-9][a-z0-9_+-]{1,31}):")

    enum Piece: Equatable {
        case text(String)
        case emoji(String)
    }

    /// The custom emoji name when `text` is exactly `:name:` (reactions, picker picks).
    static func name(of text: String) -> String? {
        let ns = text as NSString
        guard let match = exact.firstMatch(in: text, range: NSRange(location: 0, length: ns.length)) else { return nil }
        return ns.substring(with: match.range(at: 1))
    }

    /// Split text into plain runs and known custom emoji names; unknown `:x:` stay text.
    static func split(_ text: String, known: (String) -> Bool) -> [Piece] {
        guard text.contains(":") else { return [.text(text)] }
        let ns = text as NSString
        var pieces: [Piece] = []
        var last = 0
        for match in inline.matches(in: text, range: NSRange(location: 0, length: ns.length)) {
            let name = ns.substring(with: match.range(at: 1))
            guard known(name) else { continue }
            if match.range.location > last { pieces.append(.text(ns.substring(with: NSRange(location: last, length: match.range.location - last)))) }
            pieces.append(.emoji(name))
            last = match.range.location + match.range.length
        }
        if last < ns.length { pieces.append(.text(ns.substring(from: last))) }
        return pieces
    }

    /// The height the cached copy is drawn at: large enough to stay sharp in a heading (testers, 2026-09-29: emoji
    /// in a heading stayed body-sized). `sized(_:height:)` shows it at any height without drawing again.
    static let storedHeight: CGFloat = 48

    /// A copy scaled to `storedHeight` (keeps GIF's first frame; animation is out of scope).
    static func inlineImage(_ image: UIImage) -> UIImage {
        let scale = storedHeight / max(image.size.height, 1)
        let size = CGSize(width: max(image.size.width * scale, 1), height: storedHeight)
        let renderer = UIGraphicsImageRenderer(size: size)
        return renderer.image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
    }

    /// The still image, and for an animated GIF (or APNG / WebP) its frames too (at most 120; a frame with no delay
    /// shows for 0.1 s, as browsers do). Frames are drawn at `animatedHeight`, lighter than the still one.
    static func decode(_ data: Data) -> (still: UIImage, animation: EmojiAnimation?)? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil), CGImageSourceGetCount(source) > 0,
              let first = CGImageSourceCreateImageAtIndex(source, 0, nil) else { return nil }
        let still = inlineImage(UIImage(cgImage: first))
        let count = min(CGImageSourceGetCount(source), 120)
        guard count > 1 else { return (still, nil) }
        var frames: [UIImage] = [], ends: [TimeInterval] = [], elapsed: TimeInterval = 0
        for index in 0..<count {
            guard let image = CGImageSourceCreateImageAtIndex(source, index, nil) else { continue }
            frames.append(draw(UIImage(cgImage: image), height: animatedHeight))
            elapsed += delay(source, index)
            ends.append(elapsed)
        }
        return (still, frames.count > 1 ? EmojiAnimation(frames: frames, ends: ends) : nil)
    }

    static let animatedHeight: CGFloat = 36

    private static func draw(_ image: UIImage, height: CGFloat) -> UIImage {
        let scale = height / max(image.size.height, 1)
        let size = CGSize(width: max(image.size.width * scale, 1), height: height)
        return UIGraphicsImageRenderer(size: size).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
    }

    private static func delay(_ source: CGImageSource, _ index: Int) -> TimeInterval {
        let properties = CGImageSourceCopyPropertiesAtIndex(source, index, nil) as? [CFString: Any] ?? [:]
        let gif = properties[kCGImagePropertyGIFDictionary] as? [CFString: Any]
        let png = properties[kCGImagePropertyPNGDictionary] as? [CFString: Any]
        let webp = properties[kCGImagePropertyWebPDictionary] as? [CFString: Any]
        let value = gif?[kCGImagePropertyGIFUnclampedDelayTime] ?? gif?[kCGImagePropertyGIFDelayTime]
            ?? png?[kCGImagePropertyAPNGUnclampedDelayTime] ?? png?[kCGImagePropertyAPNGDelayTime]
            ?? webp?[kCGImagePropertyWebPUnclampedDelayTime] ?? webp?[kCGImagePropertyWebPDelayTime]
        let seconds = (value as? NSNumber)?.doubleValue ?? 0.1
        return seconds < 0.02 ? 0.1 : seconds
    }

    /// The same pixels at `height` points (Text(Image) takes an image at its own size).
    static func sized(_ image: UIImage, height: CGFloat) -> UIImage {
        guard let cgImage = image.cgImage, height > 0 else { return image }
        return UIImage(cgImage: cgImage, scale: CGFloat(cgImage.height) / height, orientation: .up)
    }

    /// A Text made of runs and inline images. Until an image is cached its place is held by a blank of the image's own
    /// size (the server gives it): `:name:` there was wider, and the line re-wrapped and the row changed height when
    /// the image came, moving the conversation as a channel opened (2026-10-02).
    static func text(_ text: String, custom: [String: CustomEmojiOut], images: [String: UIImage], onNeed: ((CustomEmojiOut) -> Void)?,
                     height: CGFloat = inlineHeight) -> Text {
        guard !custom.isEmpty else { return Text(text) }
        return split(text, known: { custom[$0] != nil }).reduce(Text("")) { acc, piece in
            switch piece {
            case .text(let run): return acc + Text(run)
            case .emoji(let name):
                guard let emoji = custom[name] else { return acc + Text(":\(name):") }
                if let image = images[emoji.id] { return acc + Text(Image(uiImage: sized(image, height: height))) }
                onNeed?(emoji)
                return acc + Text(Image(uiImage: blank(size: size(of: emoji, height: height))))
            }
        }
    }

    /// The size an emoji's image is drawn at for `height` (its aspect kept, as `inlineImage` keeps it).
    static func size(of emoji: CustomEmojiOut, height: CGFloat) -> CGSize {
        let aspect = emoji.width > 0 && emoji.height > 0 ? CGFloat(emoji.width) / CGFloat(emoji.height) : 1
        return CGSize(width: (height * min(max(aspect, 0.25), 4)).rounded(), height: height)
    }

    private static let blanks = NSCache<NSString, UIImage>()

    /// A transparent image of `size` points, made once per size.
    static func blank(size: CGSize) -> UIImage {
        let key = "\(size.width)x\(size.height)" as NSString
        if let cached = blanks.object(forKey: key) { return cached }
        let format = UIGraphicsImageRendererFormat()
        format.opaque = false
        format.scale = 1
        let image = UIGraphicsImageRenderer(size: size, format: format).image { _ in }
        blanks.setObject(image, forKey: key)
        return image
    }
}
