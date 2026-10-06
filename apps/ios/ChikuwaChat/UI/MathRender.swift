import SwiftMath
import SwiftUI
import UIKit

/// TeX math in bodies and canvases (DATA_MODEL.md 「本文の形式」, apps/shared/math.json), drawn with SwiftMath (MIT, a
/// port of iosMath; THIRD_PARTY_NOTICES.md). A formula becomes a template image — it takes the colour of the text around
/// it (a quote's grey, dark mode) — cached by formula, size and style. Inline math sits on the text's baseline inside
/// the Text it is part of; display math is a block of its own that scrolls sideways when wider than the row. A formula
/// SwiftMath cannot read (or one too large to draw) shows its source in a code-like style.
enum MathRender {
    struct Rendered {
        let image: UIImage
        /// How far the formula reaches below its baseline (points).
        let descent: CGFloat
    }

    /// A drawn formula larger than this (points) is shown as its source instead (a bitmap that large helps nobody).
    static let maxSize = CGSize(width: 4000, height: 1200)

    private final class Box {
        let value: Rendered?
        init(_ value: Rendered?) { self.value = value }
    }

    private static let cache: NSCache<NSString, Box> = {
        let cache = NSCache<NSString, Box>()
        cache.countLimit = 400
        return cache
    }()

    /// The body text's size (Dynamic Type), which inline math follows.
    static var bodySize: CGFloat { UIFont.preferredFont(forTextStyle: .body).pointSize }

    /// `tex` drawn black (used as a template), or nil when SwiftMath cannot read or draw it. Main thread (UIKit).
    @MainActor
    static func render(_ tex: String, fontSize: CGFloat, display: Bool) -> Rendered? {
        let key = "\(display ? "D" : "I")\(fontSize)|\(tex)" as NSString
        if let hit = cache.object(forKey: key) { return hit.value }
        let rendered = draw(tex, fontSize: fontSize, display: display)
        cache.setObject(Box(rendered), forKey: key)
        return rendered
    }

    @MainActor
    private static func draw(_ tex: String, fontSize: CGFloat, display: Bool) -> Rendered? {
        let label = MTMathUILabel()
        label.displayErrorInline = false
        label.labelMode = display ? .display : .text
        label.textAlignment = .left
        label.fontSize = fontSize
        label.textColor = .black
        label.backgroundColor = .clear
        label.isOpaque = false
        label.latex = tex
        guard label.error == nil else { return nil }
        let size = label.intrinsicContentSize
        guard size.width > 0, size.height > 0, size.width <= maxSize.width, size.height <= maxSize.height else { return nil }
        label.frame = CGRect(origin: .zero, size: size)
        label.layoutSubviews()
        guard let displayList = label.displayList else { return nil }
        let format = UIGraphicsImageRendererFormat.preferred()
        format.opaque = false
        let image = UIGraphicsImageRenderer(size: size, format: format).image { context in
            // As SwiftMath's MTMathImage: the display list draws in a y-up space (layoutSubviews placed it).
            let cg = context.cgContext
            cg.saveGState()
            cg.translateBy(x: 0, y: size.height)
            cg.scaleBy(x: 1, y: -1)
            displayList.draw(cg)
            cg.restoreGState()
        }
        return Rendered(image: image.withRenderingMode(.alwaysTemplate), descent: displayList.descent)
    }

    /// The source of a formula that could not be drawn, code-like and muted.
    static func sourceText(_ source: String) -> Text {
        MessageBodyView.inlineCode(source).foregroundColor(.secondary)
    }

    /// Inline math as part of a Text: the formula on the baseline, or its source.
    @MainActor
    static func inlineText(_ tex: String, display: Bool = false) -> Text {
        guard let rendered = render(tex, fontSize: bodySize, display: false) else {
            return sourceText(display ? "$$\(tex)$$" : "$\(tex)$")
        }
        return Text(Image(uiImage: rendered.image).renderingMode(.template)).baselineOffset(-rendered.descent)
    }
}

/// Display math (`$$…$$` on lines of its own): centred, scrolling sideways when wider than the row; its source when it
/// cannot be drawn. VoiceOver reads the TeX.
struct MathBlockView: View {
    let tex: String

    var body: some View {
        if let rendered = MathRender.render(tex, fontSize: MathRender.bodySize * 1.1, display: true) {
            let image = Image(uiImage: rendered.image).renderingMode(.template).foregroundStyle(.primary).padding(.vertical, 4)
            ViewThatFits(in: .horizontal) {
                image.frame(maxWidth: .infinity, alignment: .center)
                ScrollView(.horizontal, showsIndicators: false) { image }
            }
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityElement()
            .accessibilityLabel(tex)
        } else {
            MathRender.sourceText("$$\(tex)$$")
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}
