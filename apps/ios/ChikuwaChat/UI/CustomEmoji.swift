import SwiftUI
import UIKit

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

    /// The same pixels at `height` points (Text(Image) takes an image at its own size).
    static func sized(_ image: UIImage, height: CGFloat) -> UIImage {
        guard let cgImage = image.cgImage, height > 0 else { return image }
        return UIImage(cgImage: cgImage, scale: CGFloat(cgImage.height) / height, orientation: .up)
    }

    /// A Text made of runs and inline images; falls back to `:name:` until the image is cached.
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
                return acc + Text(":\(name):")
            }
        }
    }
}
