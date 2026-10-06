import ImageIO
import SwiftUI
import UIKit

/// Square crop of a profile picture (M16g), the same rules as the desktop's avatarCrop.ts and Android's AvatarCrop.kt:
/// at zoom 1 the picture just covers the frame (its shorter side fits); the reader pans and zooms, and the frame's
/// square is what gets uploaded, as a 512 px JPEG whatever the photo was.
struct AvatarCrop: Equatable {
    /// Side of the uploaded picture; the server shrinks it to 256 px.
    static let output: CGFloat = 512
    static let maxZoom: CGFloat = 4

    var zoom: CGFloat = 1
    /// Offset of the picture's centre from the frame's centre, in frame points.
    var offset: CGSize = .zero

    /// Frame points per picture unit.
    static func scale(image: CGSize, frame: CGFloat, zoom: CGFloat) -> CGFloat {
        frame / min(image.width, image.height) * zoom
    }

    /// Keeps the frame covered: no pan or zoom may show anything outside the picture.
    func clamped(image: CGSize, frame: CGFloat) -> AvatarCrop {
        let zoom = min(Self.maxZoom, max(1, self.zoom))
        let scale = Self.scale(image: image, frame: frame, zoom: zoom)
        let maxX = max(0, (image.width * scale - frame) / 2)
        let maxY = max(0, (image.height * scale - frame) / 2)
        return AvatarCrop(zoom: zoom, offset: CGSize(width: min(maxX, max(-maxX, offset.width)), height: min(maxY, max(-maxY, offset.height))))
    }

    /// Zooms around a point of the frame (relative to its centre): the picture under that point stays under it.
    func zoomed(to zoom: CGFloat, at point: CGPoint, image: CGSize, frame: CGFloat) -> AvatarCrop {
        let next = min(Self.maxZoom, max(1, zoom))
        let ratio = next / self.zoom
        let offset = CGSize(width: point.x - (point.x - self.offset.width) * ratio, height: point.y - (point.y - self.offset.height) * ratio)
        return AvatarCrop(zoom: next, offset: offset).clamped(image: image, frame: frame)
    }

    /// The square of the picture, in picture units, that the frame shows.
    func sourceRect(image: CGSize, frame: CGFloat) -> CGRect {
        let scale = Self.scale(image: image, frame: frame, zoom: zoom)
        let side = frame / scale
        return CGRect(x: image.width / 2 - offset.width / scale - side / 2, y: image.height / 2 - offset.height / scale - side / 2, width: side, height: side)
    }

    /// The chosen square as a 512 px JPEG; a transparent picture gets a white background.
    func render(_ image: UIImage, frame: CGFloat) -> Data? {
        let rect = sourceRect(image: image.size, frame: frame)
        let k = Self.output / rect.width
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        format.opaque = true
        let square = CGRect(x: 0, y: 0, width: Self.output, height: Self.output)
        let picture = UIGraphicsImageRenderer(size: square.size, format: format).image { context in
            UIColor.white.setFill()
            context.fill(square)
            image.draw(in: CGRect(x: -rect.minX * k, y: -rect.minY * k, width: image.size.width * k, height: image.size.height * k))
        }
        return picture.jpegData(compressionQuality: 0.9)
    }
}

/// One drag or pinch of the crop screen, from where the fingers came down: every update is worked out from that start
/// (never step on step), so the point of the picture under the fingers stays under them from the first movement on.
/// One finger pans; two pan with their midpoint and zoom by how far apart they spread. A finger added or lifted starts
/// a new gesture from the crop shown at that moment, so nothing jumps either.
struct AvatarCropGesture: Equatable {
    /// The crop when the fingers came down.
    let start: AvatarCrop
    /// Midpoint of the fingers then, relative to the frame's centre.
    let anchor: CGPoint
    /// Mean distance of the fingers from their midpoint then; 0 with one finger (no zoom).
    let spread: CGFloat

    /// The crop for the fingers' midpoint and spread now: zoomed by the spread's ratio and panned so the picture point
    /// that was under the start midpoint is under the current one, then kept covering the frame.
    func crop(centroid: CGPoint, spread: CGFloat, image: CGSize, frame: CGFloat) -> AvatarCrop {
        let factor = self.spread > 0 && spread > 0 ? spread / self.spread : 1
        let zoom = min(AvatarCrop.maxZoom, max(1, start.zoom * factor))
        let ratio = zoom / start.zoom
        let offset = CGSize(
            width: centroid.x - (anchor.x - start.offset.width) * ratio,
            height: centroid.y - (anchor.y - start.offset.height) * ratio
        )
        return AvatarCrop(zoom: zoom, offset: offset).clamped(image: image, frame: frame)
    }

    /// Midpoint and mean spread of the touching fingers.
    static func centroid(of points: [CGPoint]) -> (centroid: CGPoint, spread: CGFloat) {
        guard !points.isEmpty else { return (.zero, 0) }
        let n = CGFloat(points.count)
        let centroid = CGPoint(x: points.map(\.x).reduce(0, +) / n, y: points.map(\.y).reduce(0, +) / n)
        let spread = points.map { hypot($0.x - centroid.x, $0.y - centroid.y) }.reduce(0, +) / n
        return (centroid, spread)
    }
}

extension ImageUpload {
    /// A photo decoded at most `maxPixel` on its longer side and upright (EXIF applied): a 48 MP picture never lands
    /// in memory whole. nil when the bytes are no image this device can read.
    static func downsampled(_ data: Data, maxPixel: Int = 2048) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
        let options = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixel,
        ] as CFDictionary
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options) else { return nil }
        return UIImage(cgImage: image)
    }
}

/// A picked photo waiting in the crop screen.
struct PickedPhoto: Identifiable {
    let id = UUID()
    let image: UIImage
}

/// Choose the square of a picked photo for the profile picture (M16g): drag to move; pinch or the slider to zoom.
struct AvatarCropView: View {
    let image: UIImage
    let onCancel: () -> Void
    let onDone: (Data) -> Void

    @State private var crop = AvatarCrop()
    @State private var frame: CGFloat = 0
    /// The drag or pinch under way, if any.
    @State private var gesture: AvatarCropGesture?

    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                GeometryReader { proxy in
                    let side = max(1, min(proxy.size.width, proxy.size.height) - 32)
                    let scale = AvatarCrop.scale(image: image.size, frame: side, zoom: crop.zoom)
                    ZStack {
                        Color.black
                        Image(uiImage: image)
                            .resizable()
                            .frame(width: image.size.width * scale, height: image.size.height * scale)
                            .offset(crop.offset)
                        // The avatar's rounded square; everything outside it is dimmed.
                        Rectangle()
                            .fill(Color.black.opacity(0.55))
                            .mask {
                                ZStack {
                                    Rectangle()
                                    RoundedRectangle(cornerRadius: side * 0.22, style: .continuous)
                                        .frame(width: side, height: side)
                                        .blendMode(.destinationOut)
                                }
                                .compositingGroup()
                            }
                        RoundedRectangle(cornerRadius: side * 0.22, style: .continuous)
                            .stroke(Color.white.opacity(0.9), lineWidth: 2)
                            .frame(width: side, height: side)
                    }
                    .frame(width: proxy.size.width, height: proxy.size.height)
                    .clipped()
                    // Raw touches rather than DragGesture + MagnifyGesture: those only report once the fingers have
                    // moved past a threshold (the first pinch update arrives already zoomed, a visible jump), give no
                    // midpoint to pan with during a pinch, and restart without onEnded when a second finger lands
                    // (the stale step state then threw the picture back).
                    .overlay { CropTouchSurface(onTouches: touches) }
                    .onAppear { layout(side: side) }
                    .onChange(of: side) { _, side in layout(side: side) }
                }
                HStack(spacing: 12) {
                    Image(systemName: "minus").foregroundStyle(.secondary)
                    Slider(value: Binding(
                        get: { crop.zoom },
                        set: { crop = crop.zoomed(to: $0, at: .zero, image: image.size, frame: frame) }
                    ), in: 1...AvatarCrop.maxZoom)
                    .accessibilityLabel("拡大")
                    Image(systemName: "plus").foregroundStyle(.secondary)
                }
                .padding(.horizontal, 24)
                Text("ドラッグで動かし、ピンチやスライダーで拡大できます").font(.footnote).foregroundStyle(.secondary)
            }
            .padding(.bottom, 16)
            .navigationTitle("写真の範囲を選ぶ")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("キャンセル", action: onCancel) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("設定する") {
                        if let jpeg = crop.render(image, frame: frame) { onDone(jpeg) }
                    }
                    .disabled(frame <= 1)
                }
            }
        }
    }

    private func layout(side: CGFloat) {
        frame = side
        gesture = nil
        crop = crop.clamped(image: image.size, frame: side)
    }

    /// The fingers on the picture (relative to the frame's centre): a new set starts a gesture from the crop shown now,
    /// a move updates it, none left ends it.
    private func touches(_ points: [CGPoint], restart: Bool) {
        guard !points.isEmpty else { gesture = nil; return }
        let (centroid, spread) = AvatarCropGesture.centroid(of: points)
        if restart || gesture == nil {
            gesture = AvatarCropGesture(start: crop, anchor: centroid, spread: spread)
        } else if let gesture {
            crop = gesture.crop(centroid: centroid, spread: spread, image: image.size, frame: frame)
        }
    }
}

/// A transparent view over the crop area that reports every finger on it from touch-down, with no movement threshold.
/// `restart` is true when a finger came down or lifted (the set changed), false when they only moved.
private struct CropTouchSurface: UIViewRepresentable {
    let onTouches: (_ points: [CGPoint], _ restart: Bool) -> Void

    func makeUIView(context: Context) -> Surface { Surface() }

    func updateUIView(_ view: Surface, context: Context) { view.onTouches = onTouches }

    final class Surface: UIView {
        var onTouches: ([CGPoint], Bool) -> Void = { _, _ in }
        private var active: [UITouch] = []

        override init(frame: CGRect) {
            super.init(frame: frame)
            isMultipleTouchEnabled = true
            backgroundColor = .clear
        }

        required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

        override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
            // A touch the system ended without telling this view is not held on to.
            active.removeAll { $0.phase == .ended || $0.phase == .cancelled }
            active.append(contentsOf: touches)
            report(restart: true)
        }

        override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent?) { report(restart: false) }

        override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent?) { lift(touches) }

        override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent?) { lift(touches) }

        private func lift(_ touches: Set<UITouch>) {
            active.removeAll { touches.contains($0) }
            report(restart: true)
        }

        private func report(restart: Bool) {
            let centre = CGPoint(x: bounds.midX, y: bounds.midY)
            let points = active.map { touch -> CGPoint in
                let point = touch.location(in: self)
                return CGPoint(x: point.x - centre.x, y: point.y - centre.y)
            }
            onTouches(points, restart)
        }
    }
}
