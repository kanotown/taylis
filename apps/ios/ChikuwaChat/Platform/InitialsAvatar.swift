import UIKit

/// The default avatar of a person without a profile picture: initials on a colour derived from the user id, the same
/// rule on every client (apps/shared/avatar-initials.json). The app's AvatarView draws it, and the Notification Service
/// Extension renders it as the sender's picture of a communication notification (PUSH_NOTIFICATIONS.md §16.1); this file
/// is compiled into both.
enum InitialsAvatar {
    /// One or two characters: "Toru Kano" → "TK", "かのう" → "か", "" → "?".
    static func initials(_ name: String) -> String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let first = trimmed.first else { return "?" }
        let words = trimmed.split(whereSeparator: { $0.isWhitespace })
        if words.count >= 2, let a = words[0].first, let b = words[1].first, a.isASCII, a.isLetter, b.isASCII, b.isLetter {
            return String([a, b]).uppercased()
        }
        return String(first).uppercased()
    }

    /// Stable hue in 0..<360 per user id (the same colour on every device and client).
    static func hue(_ id: String) -> Int {
        var hash: UInt32 = 0
        for unit in id.utf16 { hash = hash &* 31 &+ UInt32(unit) }
        return Int(hash % 360)
    }

    /// hsl(hue, 55%, 45%) in sRGB, each 0...1.
    static func rgb(_ id: String) -> (red: Double, green: Double, blue: Double) {
        let h = Double(hue(id)) / 60
        let saturation = 0.55, lightness = 0.45
        let chroma = (1 - abs(2 * lightness - 1)) * saturation
        let x = chroma * (1 - abs(h.truncatingRemainder(dividingBy: 2) - 1))
        let m = lightness - chroma / 2
        let (r, g, b): (Double, Double, Double)
        switch h {
        case ..<1: (r, g, b) = (chroma, x, 0)
        case ..<2: (r, g, b) = (x, chroma, 0)
        case ..<3: (r, g, b) = (0, chroma, x)
        case ..<4: (r, g, b) = (0, x, chroma)
        case ..<5: (r, g, b) = (x, 0, chroma)
        default: (r, g, b) = (chroma, 0, x)
        }
        return (r + m, g + m, b + m)
    }

    static func color(_ id: String) -> UIColor {
        let c = rgb(id)
        return UIColor(red: c.red, green: c.green, blue: c.blue, alpha: 1)
    }

    /// The side of the notification picture in pixels (iOS shows it at most about 60 pt, cut to a circle).
    static let notificationSide: CGFloat = 180

    /// The avatar as a PNG of `side` × `side` pixels: a full square (iOS cuts a communication notification's picture
    /// to a circle itself) with the letters as AvatarView draws them (bold, 42% of the side, white).
    static func png(id: String, name: String, side: CGFloat = notificationSide) -> Data {
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: side, height: side), format: format)
        return renderer.pngData { context in
            color(id).setFill()
            context.fill(CGRect(x: 0, y: 0, width: side, height: side))
            let text = NSAttributedString(string: initials(name), attributes: [
                .font: UIFont.systemFont(ofSize: side * 0.42, weight: .bold),
                .foregroundColor: UIColor.white,
            ])
            let size = text.size()
            text.draw(at: CGPoint(x: (side - size.width) / 2, y: (side - size.height) / 2))
        }
    }
}
