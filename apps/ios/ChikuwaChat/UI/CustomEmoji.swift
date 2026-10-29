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
/// `size`: the box it is shown in (points). A still one is then drawn from a copy made once at the pixels it takes there
/// (`CustomEmoji.displayed`), not the stored 48 pt picture scaled down by the GPU each frame: in the picker's 30 pt cells
/// on a dark background a thin white outline shimmered (2026-10-27, 「よく使う」). An animated one's frames are scaled
/// with high-quality filtering (they change every few frames anyway; copies of each would cost far more memory).
struct EmojiImage: View {
    let still: UIImage
    var animation: EmojiAnimation? = nil
    var size: CGSize? = nil
    @Environment(\.displayScale) private var displayScale

    var body: some View {
        if let animation {
            TimelineView(.animation(minimumInterval: 0.04)) { context in
                Image(uiImage: animation.frame(at: context.date.timeIntervalSinceReferenceDate))
                    .resizable().interpolation(.high).antialiased(true).scaledToFit()
            }
        } else if let size, size.width > 0, size.height > 0 {
            // At its own size (no `resizable`): one image pixel per screen pixel.
            Image(uiImage: CustomEmoji.displayed(still, fitting: size, scale: displayScale))
        } else {
            Image(uiImage: still).resizable().interpolation(.high).antialiased(true).scaledToFit()
        }
    }
}

/// Custom emoji (M12f): `:name:` in text and reactions renders as the uploaded image.
enum CustomEmoji {
    /// A custom emoji (an image or a text emoji's pill) in a message's text is this many times the text's point size
    /// high, as on the desktop (MessageBody.tsx `size="1.375em"`; docs/EMOJI.md §2). 2026-10-16 (「スマホで見たときに
    /// かなり小さく見える」): it was kept under the text's ascent, 16 pt in 17 pt text (0.94×, 15 pt at the testers' one
    /// size smaller), where the desktop draws 20 px in 14.5 px text. It is centred on the text (`baselineOffset`). A line
    /// with one is taller than without (Text(Image) keeps the image's whole height above the baseline and adds the
    /// lowering below: a 20.3 pt body line becomes 29 pt); the desktop overlaps the lines instead, which Text cannot.
    static let inlineScale: CGFloat = 1.375

    /// The point size of `style` at `size` (nil: the size the app runs at).
    static func textSize(_ style: UIFont.TextStyle, _ size: DynamicTypeSize? = nil) -> CGFloat {
        let traits = size.map { UITraitCollection(preferredContentSizeCategory: UIContentSizeCategory($0)) }
        return UIFont.preferredFont(forTextStyle: style, compatibleWith: traits).pointSize
    }

    /// The height of an emoji in text of `textSize` points, in whole points (a placeholder's width is rounded,
    /// `size(of:height:)`, and must equal the image's).
    static func inlineHeight(textSize: CGFloat) -> CGFloat { (textSize * inlineScale + 0.01).rounded(.down) }

    /// In body text (23 pt at the default size, 22 pt one size smaller).
    static var inlineHeight: CGFloat { inlineHeight(textSize: textSize(.body)) }

    /// The text style of a heading of `level` (# to ####: .title, .title2, .title3 bold; h4 is body text, bold).
    static func headingStyle(_ level: Int) -> UIFont.TextStyle {
        [.title1, .title2, .title3, .body][min(max(level, 1), 4) - 1]
    }

    /// `value` (at the default text size) at the text size in use, for that text style, in whole points (down, so it
    /// stays under the ascent): a placeholder's width is rounded (`size(of:height:)`) and must equal the image's.
    static func scaled(_ value: CGFloat, _ style: UIFont.TextStyle) -> CGFloat {
        (UIFontMetrics(forTextStyle: style).scaledValue(for: value) + 0.01).rounded(.down)
    }
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
    /// M101: a pack emoji (LINE-style 180 px pictures) is kept at 60 pt (180 px on a 3× screen): it may be shown as a
    /// stamp (`Jumbo.stamp`, docs/EMOJI.md §7), where 48 pt was blurred.
    static let packStoredHeight: CGFloat = 60

    /// The stored copy's box (`storedHeight` high, at most 3:1) and the picture's size inside it, centred, for a picture
    /// of `size` (any unit: only its ratio counts).
    static func storedFit(_ size: CGSize, height storedHeight: CGFloat) -> (box: CGSize, drawn: CGSize) {
        var scale = storedHeight / max(size.height, 1)
        // M100: at most 3:1 (`size(of:height:)`); a wider one is fitted, centred, into that box.
        let width = min(max(size.width * scale, 1), storedHeight * wideMax)
        scale = min(scale, width / max(size.width, 1))
        return (CGSize(width: width, height: storedHeight), CGSize(width: size.width * scale, height: size.height * scale))
    }

    /// A copy scaled to `storedHeight` (keeps GIF's first frame; animation is out of scope). It is a still: shown
    /// smaller, it is drawn from copies at the pixels it takes (`displayed`).
    static func inlineImage(_ image: UIImage, height storedHeight: CGFloat = storedHeight) -> UIImage {
        let (size, drawn) = storedFit(image.size, height: storedHeight)
        let still = UIGraphicsImageRenderer(size: size).image { context in
            context.cgContext.interpolationQuality = .high
            image.draw(in: CGRect(origin: CGPoint(x: (size.width - drawn.width) / 2, y: (size.height - drawn.height) / 2), size: drawn))
        }
        DisplayCopies.attach(to: still)
        return still
    }

    /// The still image, and for an animated GIF (or APNG / WebP) its frames too (at most 120; a frame with no delay
    /// shows for 0.1 s, as browsers do). Frames are drawn at `animatedHeight`, lighter than the still one.
    /// The still is read by ImageIO already at the stored copy's pixels (`thumbnail`), which averages every source pixel:
    /// a 512 px picture drawn straight into 144 px skipped some of them, and a thin outline came out broken.
    static func decode(_ data: Data, pack: Bool = false) -> (still: UIImage, animation: EmojiAnimation?)? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil), CGImageSourceGetCount(source) > 0,
              let first = CGImageSourceCreateImageAtIndex(source, 0, nil) else { return nil }
        let height = pack ? packStoredHeight : storedHeight
        let drawn = storedFit(CGSize(width: first.width, height: first.height), height: height).drawn
        let pixels = Int((max(drawn.width, drawn.height) * UIGraphicsImageRendererFormat.preferred().scale).rounded(.up))
        let still = inlineImage(UIImage(cgImage: thumbnail(source, maxPixels: pixels) ?? first), height: height)
        let count = min(CGImageSourceGetCount(source), 120)
        guard count > 1 else { return (still, nil) }
        var frames: [UIImage] = [], ends: [TimeInterval] = [], elapsed: TimeInterval = 0
        for index in 0..<count {
            guard let image = CGImageSourceCreateImageAtIndex(source, index, nil) else { continue }
            frames.append(draw(UIImage(cgImage: image), height: pack ? packStoredHeight : animatedHeight))
            elapsed += frameDelay(source, index)
            ends.append(elapsed)
        }
        return (still, frames.count > 1 ? EmojiAnimation(frames: frames, ends: ends) : nil)
    }

    /// The first image of `source` at most `maxPixels` on its longer side (never enlarged), read by ImageIO.
    static func thumbnail(_ source: CGImageSource, maxPixels: Int) -> CGImage? {
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: max(maxPixels, 1),
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
    }

    static let animatedHeight: CGFloat = 36

    private static func draw(_ image: UIImage, height: CGFloat) -> UIImage {
        let scale = height / max(image.size.height, 1)
        let size = CGSize(width: max(image.size.width * scale, 1), height: height)
        return UIGraphicsImageRenderer(size: size).image { context in
            context.cgContext.interpolationQuality = .high
            image.draw(in: CGRect(origin: .zero, size: size))
        }
    }

    // MARK: shown smaller than stored (2026-10-27)

    /// The whole pixels a picture of `imageSize` takes fitted into `box` (points, its ratio kept) at `scale`.
    static func displayPixels(imageSize: CGSize, box: CGSize, scale: CGFloat) -> (width: Int, height: Int) {
        guard imageSize.width > 0, imageSize.height > 0 else { return (1, 1) }
        let fit = min(box.width / imageSize.width, box.height / imageSize.height)
        return (max(Int((imageSize.width * fit * scale).rounded()), 1), max(Int((imageSize.height * fit * scale).rounded()), 1))
    }

    /// `image` to show at its own size fitted into `box` (points) on a screen of `scale`. A still (`inlineImage`, a text
    /// emoji's pill) comes as a copy drawn once at exactly those pixels and kept with it, so the screen shows it pixel
    /// for pixel: the GPU's scaling of the 144 px picture into a 90 px cell dropped some pixels of a thin outline, other
    /// ones at each move by a fraction of a pixel, and on a dark background the outline shimmered (2026-10-27). Any other
    /// image (an animation's frame) comes as the same pixels at that size.
    static func displayed(_ image: UIImage, fitting box: CGSize, scale: CGFloat) -> UIImage {
        let (width, height) = displayPixels(imageSize: image.size, box: box, scale: scale)
        guard let cgImage = image.cgImage else { return image }
        guard let copies = DisplayCopies.of(image) else {
            return UIImage(cgImage: cgImage, scale: CGFloat(cgImage.height) * scale / CGFloat(height), orientation: .up)
        }
        if cgImage.width == width && cgImage.height == height && image.scale == scale { return image }
        return copies.copy(width: width, height: height) {
            guard let scaled = downsampled(cgImage, width: width, height: height) else { return nil }
            return UIImage(cgImage: scaled, scale: scale, orientation: .up)
        } ?? UIImage(cgImage: cgImage, scale: CGFloat(cgImage.height) * scale / CGFloat(height), orientation: .up)
    }

    /// `image` redrawn at `width` × `height` pixels with high-quality filtering.
    static func downsampled(_ image: CGImage, width: Int, height: Int) -> CGImage? {
        let space = image.colorSpace.flatMap { $0.model == .rgb ? $0 : nil } ?? CGColorSpace(name: CGColorSpace.sRGB)!
        guard let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        context.interpolationQuality = .high
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return context.makeImage()
    }

    /// The copies of one still at the pixel sizes it is shown at, kept with the still itself (they go with it when the
    /// store lets it go, a new picture has new ones). Few sizes each: the picker's cells, a reaction chip, a line of text.
    final class DisplayCopies: @unchecked Sendable {
        private let lock = NSLock()
        private var bySize: [Int: UIImage] = [:]
        private static var key: UInt8 = 0

        static func attach(to image: UIImage) {
            objc_setAssociatedObject(image, &key, DisplayCopies(), .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
        }

        static func of(_ image: UIImage) -> DisplayCopies? { objc_getAssociatedObject(image, &key) as? DisplayCopies }

        /// How many sizes are kept (tests).
        var count: Int { lock.lock(); defer { lock.unlock() }; return bySize.count }

        func copy(width: Int, height: Int, make: () -> UIImage?) -> UIImage? {
            let key = width << 20 | height
            lock.lock()
            if let hit = bySize[key] { lock.unlock(); return hit }
            lock.unlock()
            guard let made = make() else { return nil }
            lock.lock()
            bySize[key] = made
            lock.unlock()
            return made
        }
    }

    /// How long frame `index` shows (GIF, APNG, WebP): no delay or one under 0.02 s is 0.1 s, as browsers do.
    static func frameDelay(_ source: CGImageSource, _ index: Int) -> TimeInterval {
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

    /// The image at `height` points (Text(Image) takes an image at its own size): a still as its copy at those pixels
    /// (`displayed`), anything else (an animation's frame) as the same pixels.
    static func sized(_ image: UIImage, height: CGFloat) -> UIImage {
        guard let cgImage = image.cgImage, height > 0 else { return image }
        guard DisplayCopies.of(image) != nil, image.size.height > 0 else {
            return UIImage(cgImage: cgImage, scale: CGFloat(cgImage.height) / height, orientation: .up)
        }
        let box = CGSize(width: image.size.width * height / image.size.height, height: height)
        return displayed(image, fitting: box, scale: UIGraphicsImageRendererFormat.preferred().scale)
    }

    /// A Text made of runs and inline images. Until an image is cached its place is held by a blank of the image's own
    /// size (the server gives it): `:name:` there was wider, and the line re-wrapped and the row changed height when
    /// the image came, moving the conversation as a channel opened (2026-10-02). `height` nil: body text's
    /// (`inlineHeight`); `textSize`: the point size of the text around it (nil: the compact rows' `height` × 17 / 16).
    static func text(_ text: String, custom: [String: CustomEmojiOut], images: [String: UIImage], onNeed: ((CustomEmojiOut) -> Void)?,
                     height: CGFloat? = nil, textSize: CGFloat? = nil, run makeRun: (String) -> Text = { Text($0) }) -> Text {
        guard !custom.isEmpty else { return makeRun(text) }
        let textSize = textSize ?? (height == nil ? Self.textSize(.body) : nil)
        let height = height ?? inlineHeight
        return split(text, known: { custom[$0] != nil }).reduce(Text("")) { acc, piece in
            switch piece {
            case .text(let run): return acc + makeRun(run)
            case .emoji(let name):
                guard let emoji = custom[name] else { return acc + Text(":\(name):") }
                let shown = images[emoji.id].map { sized($0, height: height) } ?? blank(size: size(of: emoji, height: height))
                if images[emoji.id] == nil { onNeed?(emoji) }
                return acc + inlineImageText(shown, height: height, textSize: textSize)
            }
        }
    }

    /// How far an inline image stands below the baseline, so it is centred on the line as a standard emoji and the kana
    /// are (2026-10-06, 「iPhone だけ絵文字が少し上」): standing on the baseline, its middle was 2 pt above theirs. Centred on
    /// the capitals of the text around it: (capHeight - height) / 2, -5.5 pt for a 23 pt image in 17 pt text.
    /// `textSize` nil: the compact rows' rule, where `height` is the text's ascent (14 for 15 pt).
    static func baselineOffset(height: CGFloat, textSize: CGFloat? = nil) -> CGFloat {
        let capHeight = UIFont.systemFont(ofSize: textSize ?? height * 17 / 16).capHeight
        return min(0, (capHeight - height) / 2)
    }

    /// An inline image lowered by `baselineOffset`. `.baselineOffset` moves the run's font with it, and the body font's
    /// descent moved lower made the line taller still; the image's run gets a 1 pt font, whose descent stays inside
    /// the line's.
    static func inlineImageText(_ image: UIImage, height: CGFloat, textSize: CGFloat? = nil) -> Text {
        Text(Image(uiImage: image)).font(.system(size: 1)).baselineOffset(baselineOffset(height: height, textSize: textSize))
    }

    /// M100 (docs/EMOJI.md §2): a wide image emoji is drawn wider at the same height, at most 3:1.
    static let wideMax: CGFloat = 3

    /// The size an emoji's image is drawn at for `height` (its aspect kept, as `inlineImage` keeps it, at most 3:1);
    /// a text emoji's pill as wide as its label.
    static func size(of emoji: CustomEmojiOut, height: CGFloat) -> CGSize {
        if emoji.isText { return textPillSize(emoji.label ?? emoji.name, height: height) }
        let aspect = emoji.width > 0 && emoji.height > 0 ? CGFloat(emoji.width) / CGFloat(emoji.height) : 1
        return CGSize(width: (height * min(max(aspect, 0.25), wideMax)).rounded(), height: height)
    }

    // MARK: text emoji (M100)

    /// apps/shared/text-emoji.json (CustomEmojiTests compares them): light and dark background / text per colour.
    static let textPalette: [String: (light: (bg: UInt32, fg: UInt32), dark: (bg: UInt32, fg: UInt32))] = [
        "gray": ((0xE8E8EC, 0x3A3A44), (0x3A3A44, 0xE8E8EC)),
        "red": ((0xFDE2E1, 0xB3261E), (0x5C1D1A, 0xFFB4AB)),
        "orange": ((0xFFE6CC, 0xA04A00), (0x5A3000, 0xFFC58A)),
        "yellow": ((0xFFF3BF, 0x7A5C00), (0x4D3D00, 0xFFE08A)),
        "green": ((0xDDF4E4, 0x1E6B3A), (0x163D24, 0x9FE0B4)),
        "blue": ((0xDCEBFF, 0x1D4FA0), (0x18325C, 0xA8C8FF)),
        "purple": ((0xECE2FC, 0x5B2DA6), (0x36225A, 0xD2BCFA)),
        "pink": ((0xFCE1EF, 0xA3215F), (0x5A1A3A, 0xFFB0D5)),
    ]

    private static func color(_ rgb: UInt32) -> UIColor {
        UIColor(red: CGFloat((rgb >> 16) & 0xFF) / 255, green: CGFloat((rgb >> 8) & 0xFF) / 255,
                blue: CGFloat(rgb & 0xFF) / 255, alpha: 1)
    }

    private static func pillFont(height: CGFloat) -> UIFont { .systemFont(ofSize: height * 0.68, weight: .semibold) }

    /// A pill `height` high around `label` (the same proportions as the web's TextEmojiPill).
    static func textPillSize(_ label: String, height: CGFloat) -> CGSize {
        let textWidth = (label as NSString).size(withAttributes: [.font: pillFont(height: height)]).width
        return CGSize(width: max(height, (textWidth + height * 0.56).rounded(.up)), height: height)
    }

    private static let pills = NSCache<NSString, UIImage>()

    /// The pill drawn at `storedHeight`, so `sized(_:height:)` shows it sharp at any height like an image emoji. Each
    /// label / colour / look is drawn once: a change of look swaps the cached pills at once (`AppController`).
    static func textPill(_ emoji: CustomEmojiOut, dark: Bool) -> UIImage {
        let key = "\(emoji.color ?? "gray")|\(dark)|\(emoji.label ?? emoji.name)" as NSString
        if let cached = pills.object(forKey: key) { return cached }
        let pill = drawTextPill(emoji, dark: dark)
        DisplayCopies.attach(to: pill)
        pills.setObject(pill, forKey: key)
        return pill
    }

    private static func drawTextPill(_ emoji: CustomEmojiOut, dark: Bool) -> UIImage {
        let label = emoji.label ?? emoji.name
        let height = storedHeight
        let size = textPillSize(label, height: height)
        let colors = textPalette[emoji.color ?? "gray"] ?? textPalette["gray"]!
        let pair = dark ? colors.dark : colors.light
        let format = UIGraphicsImageRendererFormat()
        format.opaque = false
        return UIGraphicsImageRenderer(size: size, format: format).image { _ in
            color(pair.bg).setFill()
            UIBezierPath(roundedRect: CGRect(origin: .zero, size: size), cornerRadius: height * 0.3).fill()
            let attributes: [NSAttributedString.Key: Any] = [.font: pillFont(height: height), .foregroundColor: color(pair.fg)]
            let text = (label as NSString).size(withAttributes: attributes)
            (label as NSString).draw(at: CGPoint(x: (size.width - text.width) / 2, y: (height - text.height) / 2), withAttributes: attributes)
        }
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

extension CustomEmoji {
    /// The height of an inline image in a compact row's `.subheadline` (15 pt) text, no taller than its ascent (see
    /// `inlineHeight`); `.caption` / `.caption2` lines take `captionHeight`.
    static var subheadlineHeight: CGFloat { scaled(14, .subheadline) }
    static var captionHeight: CGFloat { scaled(12, .caption1) }

    /// A one-line excerpt of a message in a compact row (the activity, pins, saved, mentions, search, thread lists, the DM
    /// list, a reply's 「スレッドに返信」 line): custom emoji as their images, standard `:shortcode:`s as their glyphs, as
    /// in the message (2026-10-05: the activity showed `:ckw-yay:`). Images not cached yet hold their room (`text`).
    @MainActor static func excerpt(_ text: String, controller: AppController, height: CGFloat = subheadlineHeight, textSize: CGFloat? = nil,
                                   run: (String) -> Text = { Text($0) }) -> Text {
        CustomEmoji.text(Emoji.replaceShortcodes(text), custom: controller.store.customEmoji, images: controller.store.emojiImages,
                         onNeed: { controller.loadEmojiImage($0) }, height: height, textSize: textSize, run: run)
    }
}

/// A reaction's emoji outside its chip (the activity's headline, who reacted): a custom one as its image in a box of its
/// own size (a wide one wider, a text emoji's pill as wide as its label), held blank until the image is here, as on the
/// chips (2026-10-05: the activity showed `:ckw-yay:` until then); a standard emoji, or a name this workspace does not
/// have, as text.
struct ReactionGlyph: View {
    let controller: AppController
    let emoji: String
    var height: CGFloat = 16

    var body: some View {
        let store = controller.store
        if let name = CustomEmoji.name(of: emoji), let custom = store.customEmoji[name] {
            let box = CustomEmoji.size(of: custom, height: height)
            Group {
                if let image = store.emojiImages[custom.id] {
                    EmojiImage(still: image, animation: store.emojiAnimations[custom.id], size: box).frame(width: box.width, height: height)
                } else {
                    Color.clear.frame(width: box.width, height: height)
                        .onAppear { controller.loadEmojiImage(custom) }
                }
            }
            .accessibilityLabel(custom.label ?? emoji)
        } else if CustomEmoji.name(of: emoji) != nil {
            Text(emoji).font(.caption).lineLimit(1)
        } else {
            Text(emoji).font(.system(size: height * 0.94)).fixedSize().frame(minWidth: height).frame(height: height)
        }
    }
}
