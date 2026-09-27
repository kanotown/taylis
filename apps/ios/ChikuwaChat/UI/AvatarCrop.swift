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

    /// Moved by a drag, still covering the frame.
    func moved(by delta: CGSize, image: CGSize, frame: CGFloat) -> AvatarCrop {
        AvatarCrop(zoom: zoom, offset: CGSize(width: offset.width + delta.width, height: offset.height + delta.height)).clamped(image: image, frame: frame)
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
    @State private var viewSize: CGSize = .zero
    // Gestures report totals since they began; these turn them into steps, so a drag and a pinch can run together.
    @State private var lastTranslation: CGSize = .zero
    @State private var lastMagnification: CGFloat = 1

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
                    .contentShape(Rectangle())
                    .gesture(drag.simultaneously(with: pinch))
                    .onAppear { layout(side: side, size: proxy.size) }
                    .onChange(of: proxy.size) { _, size in layout(side: side, size: size) }
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

    private func layout(side: CGFloat, size: CGSize) {
        frame = side
        viewSize = size
        crop = crop.clamped(image: image.size, frame: side)
    }

    private var drag: some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                let delta = CGSize(width: value.translation.width - lastTranslation.width, height: value.translation.height - lastTranslation.height)
                lastTranslation = value.translation
                crop = crop.moved(by: delta, image: image.size, frame: frame)
            }
            .onEnded { _ in lastTranslation = .zero }
    }

    private var pinch: some Gesture {
        MagnifyGesture()
            .onChanged { value in
                let factor = value.magnification / lastMagnification
                lastMagnification = value.magnification
                let point = CGPoint(x: value.startLocation.x - viewSize.width / 2, y: value.startLocation.y - viewSize.height / 2)
                crop = crop.zoomed(to: crop.zoom * factor, at: point, image: image.size, frame: frame)
            }
            .onEnded { _ in lastMagnification = 1 }
    }
}
