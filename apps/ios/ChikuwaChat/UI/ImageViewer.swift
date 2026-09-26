import SwiftUI
import UIKit

/// Full-screen photo viewer like Slack's: pinch / double-tap zoom, share, close.
struct ImageViewer: View {
    let attachment: AttachmentOut
    @Bindable var controller: AppController
    @Environment(\.dismiss) private var dismiss
    @State private var image: UIImage?
    @State private var fileURL: URL?
    @State private var failed = false

    var body: some View {
        NavigationStack {
            ZStack {
                Color.black.ignoresSafeArea()
                if let image {
                    ZoomableImage(image: image).ignoresSafeArea()
                } else if failed {
                    Text("画像を読み込めませんでした").foregroundStyle(.white)
                } else {
                    ProgressView().tint(.white)
                }
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("閉じる") { dismiss() } }
                ToolbarItem(placement: .principal) {
                    VStack(spacing: 0) {
                        Text(attachment.filename).font(.footnote.weight(.semibold)).lineLimit(1)
                        Text(formatSize(attachment.sizeBytes)).font(.caption2).foregroundStyle(.secondary)
                    }
                }
                ToolbarItem(placement: .primaryAction) {
                    if let fileURL { ShareLink(item: fileURL) { Image(systemName: "square.and.arrow.up") } }
                }
            }
            .toolbarBackground(.visible, for: .navigationBar)
            .toolbarBackground(Color.black, for: .navigationBar)
            .toolbarColorScheme(.dark, for: .navigationBar)
            .task {
                fileURL = await controller.downloadAttachment(attachment)
                if let fileURL, let data = try? Data(contentsOf: fileURL), let loaded = UIImage(data: data) { image = loaded } else { failed = true }
            }
        }
        .preferredColorScheme(.dark)
    }
}

/// UIScrollView-backed zoom (SwiftUI has no reliable pinch-to-zoom for images).
struct ZoomableImage: UIViewControllerRepresentable {
    let image: UIImage

    func makeUIViewController(context: Context) -> ZoomableImageController { ZoomableImageController(image: image) }
    func updateUIViewController(_ controller: ZoomableImageController, context: Context) { controller.imageView.image = image }
}

final class ZoomableImageController: UIViewController, UIScrollViewDelegate {
    let scrollView = UIScrollView()
    let imageView = UIImageView()

    init(image: UIImage) {
        super.init(nibName: nil, bundle: nil)
        imageView.image = image
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        scrollView.delegate = self
        scrollView.minimumZoomScale = 1
        scrollView.maximumZoomScale = 5
        scrollView.showsVerticalScrollIndicator = false
        scrollView.showsHorizontalScrollIndicator = false
        scrollView.contentInsetAdjustmentBehavior = .never
        imageView.contentMode = .scaleAspectFit
        scrollView.addSubview(imageView)
        view.addSubview(scrollView)
        let doubleTap = UITapGestureRecognizer(target: self, action: #selector(toggleZoom(_:)))
        doubleTap.numberOfTapsRequired = 2
        scrollView.addGestureRecognizer(doubleTap)
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        scrollView.frame = view.bounds
        if scrollView.zoomScale == 1 {
            imageView.frame = view.bounds
            scrollView.contentSize = view.bounds.size
        }
        centerImage()
    }

    func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }
    func scrollViewDidZoom(_ scrollView: UIScrollView) { centerImage() }

    private func centerImage() {
        let bounds = scrollView.bounds.size
        let content = scrollView.contentSize
        let x = max(0, (bounds.width - content.width) / 2)
        let y = max(0, (bounds.height - content.height) / 2)
        scrollView.contentInset = UIEdgeInsets(top: y, left: x, bottom: y, right: x)
    }

    @objc private func toggleZoom(_ gesture: UITapGestureRecognizer) {
        if scrollView.zoomScale > 1 {
            scrollView.setZoomScale(1, animated: true)
        } else {
            let point = gesture.location(in: imageView)
            let size = CGSize(width: scrollView.bounds.width / 2.5, height: scrollView.bounds.height / 2.5)
            scrollView.zoom(to: CGRect(x: point.x - size.width / 2, y: point.y - size.height / 2, width: size.width, height: size.height), animated: true)
        }
    }
}

extension UIImage {
    /// Re-renders the pixels upright so encoders and servers that ignore EXIF orientation show the photo as taken.
    func normalizedUp() -> UIImage {
        guard imageOrientation != .up else { return self }
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = scale
        return UIGraphicsImageRenderer(size: size, format: format).image { _ in draw(in: CGRect(origin: .zero, size: size)) }
    }
}
