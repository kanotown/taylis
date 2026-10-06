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
    /// The height of an image in body text: no taller than the text's ascent, as a standard emoji is (2026-10-04,
    /// 「高さが違う」). Text(Image) stands on the baseline, and everything above the ascent (20 pt was 4 more) made its
    /// line taller than the others; lowering a 20 pt one only added the same to the line below. At this height it is
    /// lowered within the descent to sit centred (`baselineOffset(height:)`). 16 pt at the default text size, scaled
    /// with it: one size smaller (16 pt body, the testers' phones and the plain iPhone 17 simulator) a 16 pt image was
    /// above the ascent and its line 0.7 pt taller.
    static var inlineHeight: CGFloat { scaled(16, .body) }
    /// The same for the headings (.title, .title2, .title3 bold).
    static var headingHeights: [CGFloat] { [scaled(26, .title1), scaled(20, .title2), scaled(18, .title3)] }

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

    /// A copy scaled to `storedHeight` (keeps GIF's first frame; animation is out of scope).
    static func inlineImage(_ image: UIImage, height storedHeight: CGFloat = storedHeight) -> UIImage {
        var scale = storedHeight / max(image.size.height, 1)
        // M100: at most 3:1 (`size(of:height:)`); a wider one is fitted, centred, into that box.
        let width = min(max(image.size.width * scale, 1), storedHeight * wideMax)
        scale = min(scale, width / max(image.size.width, 1))
        let drawn = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        let size = CGSize(width: width, height: storedHeight)
        let renderer = UIGraphicsImageRenderer(size: size)
        return renderer.image { _ in
            image.draw(in: CGRect(origin: CGPoint(x: (size.width - drawn.width) / 2, y: (size.height - drawn.height) / 2), size: drawn))
        }
    }

    /// The still image, and for an animated GIF (or APNG / WebP) its frames too (at most 120; a frame with no delay
    /// shows for 0.1 s, as browsers do). Frames are drawn at `animatedHeight`, lighter than the still one.
    static func decode(_ data: Data, pack: Bool = false) -> (still: UIImage, animation: EmojiAnimation?)? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil), CGImageSourceGetCount(source) > 0,
              let first = CGImageSourceCreateImageAtIndex(source, 0, nil) else { return nil }
        let still = inlineImage(UIImage(cgImage: first), height: pack ? packStoredHeight : storedHeight)
        let count = min(CGImageSourceGetCount(source), 120)
        guard count > 1 else { return (still, nil) }
        var frames: [UIImage] = [], ends: [TimeInterval] = [], elapsed: TimeInterval = 0
        for index in 0..<count {
            guard let image = CGImageSourceCreateImageAtIndex(source, index, nil) else { continue }
            frames.append(draw(UIImage(cgImage: image), height: pack ? packStoredHeight : animatedHeight))
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
                     height: CGFloat = inlineHeight, run makeRun: (String) -> Text = { Text($0) }) -> Text {
        guard !custom.isEmpty else { return makeRun(text) }
        return split(text, known: { custom[$0] != nil }).reduce(Text("")) { acc, piece in
            switch piece {
            case .text(let run): return acc + makeRun(run)
            case .emoji(let name):
                guard let emoji = custom[name] else { return acc + Text(":\(name):") }
                let shown = images[emoji.id].map { sized($0, height: height) } ?? blank(size: size(of: emoji, height: height))
                if images[emoji.id] == nil { onNeed?(emoji) }
                return acc + inlineImageText(shown, height: height)
            }
        }
    }

    /// How far an inline image stands below the baseline, so it is centred on the line as a standard emoji and the kana
    /// are (2026-10-06, 「iPhone だけ絵文字が少し上」): standing on the baseline, its middle was 2 pt above theirs. Centred on
    /// the capitals of the font it is sized for (`height` is that font's ascent, 16 for 17 pt): (capHeight - height) / 2,
    /// -2 pt in body text. It stays inside the line's descent, so the line is no taller (CustomEmojiTests).
    static func baselineOffset(height: CGFloat) -> CGFloat {
        let capHeight = UIFont.systemFont(ofSize: height * 17 / 16).capHeight
        return min(0, (capHeight - height) / 2)
    }

    /// An inline image lowered by `baselineOffset(height:)`. `.baselineOffset` moves the run's font with it, and the
    /// body font's descent moved 2 pt lower made the line 2 pt taller; the image's run gets a 1 pt font, whose
    /// descent stays inside the line's.
    static func inlineImageText(_ image: UIImage, height: CGFloat) -> Text {
        Text(Image(uiImage: image)).font(.system(size: 1)).baselineOffset(baselineOffset(height: height))
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
    @MainActor static func excerpt(_ text: String, controller: AppController, height: CGFloat = subheadlineHeight,
                                   run: (String) -> Text = { Text($0) }) -> Text {
        CustomEmoji.text(Emoji.replaceShortcodes(text), custom: controller.store.customEmoji, images: controller.store.emojiImages,
                         onNeed: { controller.loadEmojiImage($0) }, height: height, run: run)
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
                    EmojiImage(still: image, animation: store.emojiAnimations[custom.id]).frame(width: box.width, height: height)
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
