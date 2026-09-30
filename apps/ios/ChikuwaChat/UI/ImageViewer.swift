import SwiftUI
import UIKit

/// Which photos the viewer pages through and where it opens. A message's photos go in together, in the message's
/// order, and the viewer opens on the one tapped (testers, 2026-09-29: with three photos in a message, each opened
/// alone and there was no way to the next one); videos and documents keep their own tiles and stay out.
enum ImageGallery {
    static func pages(for tapped: AttachmentOut, in attachments: [AttachmentOut]) -> (items: [AttachmentOut], start: Int) {
        let photos = attachments.filter(\.isImage)
        guard let start = photos.firstIndex(where: { $0.id == tapped.id }) else { return ([tapped], 0) }
        return (photos, start)
    }

    /// 「2 / 3」 in the header; nil for a lone photo.
    static func position(_ index: Int, of count: Int) -> String? { count > 1 ? "\(index + 1) / \(count)" : nil }

    /// What VoiceOver says for the position.
    static func spokenPosition(_ index: Int, of count: Int) -> String { "\(count)枚中\(index + 1)枚目" }

    /// The pages kept loaded: the one shown first, then the next and the previous, so a swipe finds its photo ready.
    /// The others let their decoded photo go (a phone photo is some 48 MB decoded; the file stays on disk).
    static func window(around index: Int, count: Int) -> [Int] {
        [index, index + 1, index - 1].filter { (0..<count).contains($0) }
    }
}

/// Swipe to close, like Photos and Slack: which drags may close the viewer and when a release does.
enum ViewerDismiss {
    enum Axis: Equatable { case vertical, horizontal }

    /// The drag's close axis, or nil when it is not a close: a zoomed photo pans, a sideways drag between photos pages,
    /// and while the pager still moves (a page just flicked) it is not clear which photo would go. Up or down closes
    /// any photo; sideways closes a lone photo (Slack), or the first / last one dragged off its outer edge.
    static func axis(motion: CGPoint, zoomed: Bool, settled: Bool, index: Int, count: Int) -> Axis? {
        guard !zoomed, settled, motion != .zero else { return nil }
        if abs(motion.y) > abs(motion.x) { return .vertical }
        if count <= 1 { return .horizontal }
        if index == 0 && motion.x > 0 { return .horizontal }
        if index == count - 1 && motion.x < 0 { return .horizontal }
        return nil
    }

    /// M38: a video closes up or down only; sideways the player keeps the drag (its timeline).
    static func videoAxis(motion: CGPoint) -> Axis? {
        axis(motion: motion, zoomed: false, settled: true, index: 0, count: 1) == .vertical ? .vertical : nil
    }

    /// The one way a sideways close may go: either for a lone photo (nil), else off the edge it began at.
    static func horizontalSign(motion: CGPoint, count: Int) -> CGFloat? { count <= 1 ? nil : (motion.x > 0 ? 1 : -1) }

    /// A drag back past where it began stops there (the first photo does not go left of its place).
    static func clamp(_ offset: CGFloat, sign: CGFloat?) -> CGFloat {
        guard let sign else { return offset }
        return offset * sign > 0 ? offset : 0
    }

    /// 0…1: how far the drag has gone, for the background's fade (gone at half the screen).
    static func progress(offset: CGFloat, extent: CGFloat) -> CGFloat {
        extent > 0 ? min(1, abs(offset) / (extent * 0.5)) : 0
    }

    /// How far a slow drag must go to close: about a fifth of the screen, at most 140 pt.
    static func threshold(extent: CGFloat) -> CGFloat { min(140, extent * 0.22) }

    /// pt/s outward that closes whatever the distance (a flick), and back towards the start that keeps it open.
    static let flickSpeed: CGFloat = 900
    static let returnSpeed: CGFloat = 300

    static func shouldClose(offset: CGFloat, velocity: CGFloat, extent: CGFloat) -> Bool {
        guard offset != 0 else { return false }
        let outward = offset > 0 ? velocity : -velocity
        if outward > flickSpeed { return true }
        if outward < -returnSpeed { return false }
        return abs(offset) > threshold(extent: extent)
    }
}

/// Full-screen photo viewer like Slack's and Photos': the message's photos side by side (swipe between them), pinch /
/// double-tap zoom, share, close, and swipe the photo away to close (testers, 2026-09-29: only 閉じる closed it).
struct ImageViewer: View {
    let attachments: [AttachmentOut]
    let start: Int
    @Bindable var controller: AppController
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var index: Int
    /// Downloaded files by attachment id, for the share button.
    @State private var files: [String: URL] = [:]
    /// 0…1 while a photo is dragged away: the header goes first, the background with the distance.
    @State private var dragged: CGFloat = 0

    init(attachments: [AttachmentOut], start: Int = 0, controller: AppController) {
        let start = min(max(start, 0), max(attachments.count - 1, 0))
        self.attachments = attachments
        self.start = start
        _controller = Bindable(controller)
        _index = State(initialValue: start)
    }

    init(attachment: AttachmentOut, controller: AppController) {
        self.init(attachments: [attachment], controller: controller)
    }

    private var current: AttachmentOut? { attachments.indices.contains(index) ? attachments[index] : nil }

    var body: some View {
        ZStack(alignment: .top) {
            ImagePager(items: attachments, start: start, reduceMotion: reduceMotion,
                       load: { await controller.downloadAttachment($0) },
                       onPage: { index = $0 },
                       onFile: { files[$0] = $1 },
                       onDrag: { progress in
                           if progress == 0 { withAnimation(.easeOut(duration: 0.2)) { dragged = 0 } } else { dragged = progress }
                       },
                       onClose: close)
                .ignoresSafeArea()
            header.opacity(1 - min(1, dragged * 4))
        }
        // The conversation shows through as the photo is dragged away, as in Photos (the cover is otherwise opaque).
        .presentationBackground(.clear)
        .preferredColorScheme(.dark)
    }

    private var header: some View {
        HStack {
            Button("閉じる") { dismiss() }
            Spacer()
            if let current, let url = files[current.id] {
                ShareLink(item: url) { Image(systemName: "square.and.arrow.up") }
            }
        }
        .tint(.white)
        .overlay { title }
        .padding(.horizontal, 16)
        .frame(height: 44)
        .background(Color.black.opacity(0.55).ignoresSafeArea(edges: .top))
    }

    @ViewBuilder
    private var title: some View {
        if let current {
            let position = ImageGallery.position(index, of: attachments.count)
            VStack(spacing: 0) {
                Text(current.filename).font(.footnote.weight(.semibold)).lineLimit(1)
                Text([formatSize(current.sizeBytes), position].compactMap { $0 }.joined(separator: " · "))
                    .font(.caption2).foregroundStyle(.secondary)
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 72)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel([current.filename, formatSize(current.sizeBytes),
                                 position == nil ? nil : ImageGallery.spokenPosition(index, of: attachments.count)]
                .compactMap { $0 }.joined(separator: "、"))
        }
    }

    /// After a swipe the photo has already left and the background faded: the cover goes without sliding down again.
    private func close() {
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) { dismiss() }
    }
}

struct ImagePager: UIViewControllerRepresentable {
    let items: [AttachmentOut]
    let start: Int
    let reduceMotion: Bool
    let load: @MainActor (AttachmentOut) async -> URL?
    let onPage: (Int) -> Void
    let onFile: (String, URL) -> Void
    let onDrag: (CGFloat) -> Void
    let onClose: () -> Void

    func makeUIViewController(context: Context) -> ImagePagerController {
        let pager = ImagePagerController(items: items, start: start, load: load)
        updateUIViewController(pager, context: context)
        return pager
    }

    func updateUIViewController(_ pager: ImagePagerController, context: Context) {
        pager.reduceMotion = reduceMotion
        pager.load = load
        pager.onPage = onPage
        pager.onFile = onFile
        pager.onDrag = onDrag
        pager.onClose = onClose
    }
}

/// The photos side by side in a paging UIScrollView, each zooming in its own (SwiftUI's paging TabView and its
/// magnification gesture fight over the drags). A zoomed photo pans and neither pages nor closes; unzoomed, a drag
/// up or down, or sideways off a lone / edge photo, takes the photo with the finger and closes past a distance or on a
/// flick — `closePan` decides first and the scroll views wait for it to give the drag up.
final class ImagePagerController: UIViewController, UIScrollViewDelegate, UIGestureRecognizerDelegate {
    static let gap: CGFloat = 20

    let items: [AttachmentOut]
    private(set) var index: Int
    var reduceMotion = false
    var load: @MainActor (AttachmentOut) async -> URL?
    var onPage: (Int) -> Void = { _ in }
    var onFile: (String, URL) -> Void = { _, _ in }
    var onDrag: (CGFloat) -> Void = { _ in }
    var onClose: () -> Void = {}

    let pager = PagerScrollView()
    private(set) var pages: [ImagePageView] = []
    let closePan = UIPanGestureRecognizer()
    private var files: [Int: URL] = [:]
    private var loads: [Int: Task<Void, Never>] = [:]
    private var closeAxis: ViewerDismiss.Axis?
    private var closeSign: CGFloat?
    private var closing = false
    private var laidOutSize = CGSize.zero

    init(items: [AttachmentOut], start: Int, load: @escaping @MainActor (AttachmentOut) async -> URL?) {
        self.items = items
        self.index = min(max(start, 0), max(items.count - 1, 0))
        self.load = load
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func loadView() {
        let root = ViewerRootView()
        root.backgroundColor = .black
        root.onEscape = { [weak self] in self?.onClose() }
        view = root
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        pager.delegate = self
        pager.isPagingEnabled = true
        pager.showsHorizontalScrollIndicator = false
        pager.showsVerticalScrollIndicator = false
        pager.contentInsetAdjustmentBehavior = .never
        pager.backgroundColor = .clear
        pager.onAccessibilityStep = { [weak self] step in self?.go(by: step) ?? false }
        view.addSubview(pager)
        pages = items.indices.map { i in
            let page = ImagePageView()
            page.onRetry = { [weak self] in self?.fetch(i) }
            page.onZoomChange = { [weak self] in self?.zoomChanged(i) }
            pager.addSubview(page)
            return page
        }
        closePan.addTarget(self, action: #selector(closePanned(_:)))
        closePan.delegate = self
        closePan.maximumNumberOfTouches = 1
        view.addGestureRecognizer(closePan)
        pager.panGestureRecognizer.require(toFail: closePan)
        for page in pages { page.scrollView.panGestureRecognizer.require(toFail: closePan) }
        describePages()
        loadAround()
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        loads.values.forEach { $0.cancel() }
    }

    private var pageWidth: CGFloat { pager.bounds.width }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let size = view.bounds.size
        guard size != laidOutSize, size.width > 0 else { return }
        laidOutSize = size
        // Each page is the screen wide with a gap between them, as in Photos: the pager is one gap wider.
        let width = size.width + Self.gap
        pager.frame = CGRect(x: -Self.gap / 2, y: 0, width: width, height: size.height)
        pager.contentSize = CGSize(width: width * CGFloat(pages.count), height: size.height)
        for (i, page) in pages.enumerated() {
            page.transform = .identity
            page.frame = CGRect(x: width * CGFloat(i) + Self.gap / 2, y: 0, width: size.width, height: size.height)
        }
        pager.contentOffset = CGPoint(x: width * CGFloat(index), y: 0)
    }

    // MARK: pages

    /// The shown photo and its neighbours load (the shown one first); the others let their decoded photo go.
    private func loadAround() {
        for i in ImageGallery.window(around: index, count: pages.count) { show(i) }
        for (i, page) in pages.enumerated() where abs(i - index) > 1 { page.release() }
    }

    private func show(_ i: Int) {
        guard !pages[i].hasImage else { return }
        if let url = files[i], let image = Self.decode(url) { pages[i].state = .shown(image) } else { fetch(i) }
    }

    /// Downloads one photo with the controller's authenticated download (its failure also shows as the app's error);
    /// 再試行 on the page comes back here.
    private func fetch(_ i: Int) {
        guard loads[i] == nil, items.indices.contains(i) else { return }
        pages[i].state = .loading
        let item = items[i]
        let load = self.load
        loads[i] = Task { [weak self] in
            let url = await load(item)
            guard let self, !Task.isCancelled else { return }
            loads[i] = nil
            guard let url, let image = Self.decode(url) else { pages[i].state = .failed; return }
            files[i] = url
            onFile(item.id, url)
            if abs(i - index) <= 1 { pages[i].state = .shown(image) }
        }
    }

    private static func decode(_ url: URL) -> UIImage? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return UIImage(data: data)
    }

    /// The page the pager came to rest on: the photos that left the screen go back to unzoomed.
    private func settle() {
        guard pageWidth > 0 else { return }
        let settled = min(max(Int((pager.contentOffset.x / pageWidth).rounded()), 0), max(pages.count - 1, 0))
        guard settled != index else { return }
        index = settled
        for (i, page) in pages.enumerated() where i != index { page.resetZoom() }
        pager.isScrollEnabled = true
        loadAround()
        describePages()
        onPage(index)
    }

    /// VoiceOver's next / previous photo (three-finger swipe or the actions on the photo).
    @discardableResult
    func go(by step: Int) -> Bool {
        let target = index + step
        guard pages.indices.contains(target), pageWidth > 0 else { return false }
        pages[index].resetZoom()
        pager.setContentOffset(CGPoint(x: CGFloat(target) * pageWidth, y: 0), animated: false)
        settle()
        UIAccessibility.post(notification: .pageScrolled, argument: "写真 \(ImageGallery.spokenPosition(index, of: pages.count))")
        return true
    }

    private func zoomChanged(_ i: Int) {
        guard i == index else { return }
        // Zoomed in, a sideways drag pans the photo instead of turning the page.
        pager.isScrollEnabled = !pages[i].isZoomed
    }

    private func describePages() {
        for (i, page) in pages.enumerated() {
            let element = page.imageView
            element.accessibilityLabel = "写真 \(items[i].filename)"
            element.accessibilityValue = pages.count > 1 ? ImageGallery.spokenPosition(i, of: pages.count) : nil
            var actions: [UIAccessibilityCustomAction] = []
            if i + 1 < pages.count {
                actions.append(UIAccessibilityCustomAction(name: "次の写真") { [weak self] _ in self?.go(by: 1) ?? false })
            }
            if i > 0 {
                actions.append(UIAccessibilityCustomAction(name: "前の写真") { [weak self] _ in self?.go(by: -1) ?? false })
            }
            element.accessibilityCustomActions = actions
        }
    }

    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) { settle() }
    func scrollViewDidEndScrollingAnimation(_ scrollView: UIScrollView) { settle() }
    func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) { if !decelerate { settle() } }

    // MARK: swipe to close

    /// The close axis for a drag that has just moved this far; exposed for tests.
    func closeAxis(for motion: CGPoint) -> ViewerDismiss.Axis? {
        guard !closing, pages.indices.contains(index) else { return nil }
        let atRest = !pager.isDragging && !pager.isDecelerating && abs(pager.contentOffset.x - CGFloat(index) * pageWidth) < 1
        return ViewerDismiss.axis(motion: motion, zoomed: pages[index].isZoomed, settled: atRest, index: index, count: pages.count)
    }

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard gestureRecognizer === closePan else { return true }
        var motion = closePan.translation(in: view)
        if motion == .zero { motion = closePan.velocity(in: view) }
        closeAxis = closeAxis(for: motion)
        closeSign = closeAxis == .horizontal ? ViewerDismiss.horizontalSign(motion: motion, count: pages.count) : nil
        return closeAxis != nil
    }

    @objc private func closePanned(_ pan: UIPanGestureRecognizer) {
        guard let axis = closeAxis, pages.indices.contains(index), !closing else { return }
        let page = pages[index]
        let translation = pan.translation(in: view)
        let extent = axis == .vertical ? view.bounds.height : view.bounds.width
        let offset = axis == .vertical ? translation.y : ViewerDismiss.clamp(translation.x, sign: closeSign)
        switch pan.state {
        case .began, .changed:
            // Up or down, the photo follows the finger both ways, as in Photos; sideways it stays on its line.
            page.transform = axis == .vertical ? CGAffineTransform(translationX: translation.x, y: translation.y)
                                               : CGAffineTransform(translationX: offset, y: 0)
            fade(ViewerDismiss.progress(offset: offset, extent: extent))
        case .ended:
            let velocity = pan.velocity(in: view)
            let speed = axis == .vertical ? velocity.y : velocity.x
            if ViewerDismiss.shouldClose(offset: offset, velocity: speed, extent: extent) {
                flyOff(page, axis: axis, offset: offset, velocity: velocity, extent: extent)
            } else {
                springBack(page)
            }
        default:
            springBack(page)
        }
    }

    private func fade(_ progress: CGFloat) {
        view.backgroundColor = UIColor.black.withAlphaComponent(1 - progress)
        onDrag(progress)
    }

    /// The photo carries on off the screen the way it was going and the background clears; then the cover goes.
    /// With Reduce Motion it fades where it is instead.
    private func flyOff(_ page: ImagePageView, axis: ViewerDismiss.Axis, offset: CGFloat, velocity: CGPoint, extent: CGFloat) {
        closing = true
        onDrag(1)
        if reduceMotion {
            UIView.animate(withDuration: 0.2, animations: { self.view.alpha = 0 }, completion: { _ in self.onClose() })
            return
        }
        let direction: CGFloat = offset >= 0 ? 1 : -1
        let speed = abs(axis == .vertical ? velocity.y : velocity.x)
        let duration = min(0.3, max(0.12, Double((extent - abs(offset)) / max(speed, 1500))))
        let start = page.transform
        UIView.animate(withDuration: duration, delay: 0, options: [.curveEaseOut, .beginFromCurrentState], animations: {
            page.transform = axis == .vertical
                ? CGAffineTransform(translationX: start.tx + velocity.x * duration, y: direction * extent)
                : CGAffineTransform(translationX: direction * extent, y: 0)
            self.view.backgroundColor = .clear
        }, completion: { _ in self.onClose() })
    }

    private func springBack(_ page: ImagePageView) {
        onDrag(0)
        let back = {
            page.transform = .identity
            self.view.backgroundColor = .black
        }
        if reduceMotion {
            UIView.animate(withDuration: 0.2, animations: back)
        } else {
            UIView.animate(withDuration: 0.4, delay: 0, usingSpringWithDamping: 0.85, initialSpringVelocity: 0,
                           options: [.allowUserInteraction, .beginFromCurrentState], animations: back)
        }
    }
}

/// The viewer's root: VoiceOver's escape (two-finger scrub) closes it like 閉じる.
final class ViewerRootView: UIView {
    var onEscape: (() -> Void)?
    override func accessibilityPerformEscape() -> Bool {
        guard let onEscape else { return false }
        onEscape()
        return true
    }
}

/// The pager's VoiceOver three-finger swipe turns one photo, and says which.
final class PagerScrollView: UIScrollView {
    var onAccessibilityStep: ((Int) -> Bool)?
    override func accessibilityScroll(_ direction: UIAccessibilityScrollDirection) -> Bool {
        switch direction {
        case .left, .next: return onAccessibilityStep?(1) ?? false
        case .right, .previous: return onAccessibilityStep?(-1) ?? false
        default: return super.accessibilityScroll(direction)
        }
    }
}

/// A photo's zoom scroll view: unzoomed, VoiceOver's three-finger swipe goes on to the pager (there is nothing to scroll).
final class ZoomScrollView: UIScrollView {
    override func accessibilityScroll(_ direction: UIAccessibilityScrollDirection) -> Bool {
        zoomScale > minimumZoomScale + 0.01 ? super.accessibilityScroll(direction) : false
    }
}

/// One photo of the viewer: pinch / double-tap zoom in a UIScrollView (SwiftUI has no reliable pinch-to-zoom for
/// images), or a spinner while it downloads, or the failure with 再試行.
final class ImagePageView: UIView, UIScrollViewDelegate {
    enum State { case loading, failed, shown(UIImage) }

    let scrollView = ZoomScrollView()
    let imageView = UIImageView()
    private let spinner = UIActivityIndicatorView(style: .large)
    private let failure = UIStackView()
    var onRetry: () -> Void = {}
    var onZoomChange: () -> Void = {}
    private var laidOutSize = CGSize.zero

    var state: State = .loading { didSet { apply() } }
    var hasImage: Bool { imageView.image != nil }
    var isZoomed: Bool { scrollView.zoomScale > scrollView.minimumZoomScale + 0.01 }

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        scrollView.delegate = self
        scrollView.minimumZoomScale = 1
        scrollView.maximumZoomScale = 5
        scrollView.showsVerticalScrollIndicator = false
        scrollView.showsHorizontalScrollIndicator = false
        scrollView.contentInsetAdjustmentBehavior = .never
        scrollView.backgroundColor = .clear
        imageView.contentMode = .scaleAspectFit
        imageView.isAccessibilityElement = true
        imageView.accessibilityTraits = .image
        scrollView.addSubview(imageView)
        addSubview(scrollView)
        let doubleTap = UITapGestureRecognizer(target: self, action: #selector(toggleZoom(_:)))
        doubleTap.numberOfTapsRequired = 2
        scrollView.addGestureRecognizer(doubleTap)

        spinner.color = .white
        spinner.hidesWhenStopped = true
        let message = UILabel()
        message.text = "画像を読み込めませんでした"
        message.textColor = .white
        message.font = .preferredFont(forTextStyle: .body)
        message.adjustsFontForContentSizeCategory = true
        message.numberOfLines = 0
        message.textAlignment = .center
        var retry = UIButton.Configuration.borderedProminent()
        retry.title = "再試行"
        let retryButton = UIButton(configuration: retry, primaryAction: UIAction { [weak self] _ in self?.onRetry() })
        failure.axis = .vertical
        failure.alignment = .center
        failure.spacing = 12
        failure.addArrangedSubview(message)
        failure.addArrangedSubview(retryButton)
        for overlay in [spinner, failure] as [UIView] {
            overlay.translatesAutoresizingMaskIntoConstraints = false
            addSubview(overlay)
            NSLayoutConstraint.activate([
                overlay.centerXAnchor.constraint(equalTo: centerXAnchor),
                overlay.centerYAnchor.constraint(equalTo: centerYAnchor),
                overlay.widthAnchor.constraint(lessThanOrEqualTo: widthAnchor, constant: -40),
            ])
        }
        apply()
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    /// Lets the decoded photo go when the page is two or more away; it is decoded again from the file on the way back.
    func release() {
        if hasImage { state = .loading }
    }

    func resetZoom() {
        if scrollView.zoomScale != scrollView.minimumZoomScale { scrollView.setZoomScale(scrollView.minimumZoomScale, animated: false) }
    }

    private func apply() {
        resetZoom()
        switch state {
        case .loading:
            imageView.image = nil
            spinner.startAnimating()
            failure.isHidden = true
        case .failed:
            imageView.image = nil
            spinner.stopAnimating()
            failure.isHidden = false
        case .shown(let image):
            imageView.image = image
            spinner.stopAnimating()
            failure.isHidden = true
        }
        imageView.isAccessibilityElement = hasImage
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard bounds.size != laidOutSize else { return }
        laidOutSize = bounds.size
        resetZoom()
        scrollView.frame = bounds
        imageView.frame = bounds
        scrollView.contentSize = bounds.size
        centerImage()
    }

    func viewForZooming(in scrollView: UIScrollView) -> UIView? { hasImage ? imageView : nil }

    func scrollViewDidZoom(_ scrollView: UIScrollView) {
        centerImage()
        onZoomChange()
    }

    private func centerImage() {
        let bounds = scrollView.bounds.size
        let content = scrollView.contentSize
        let x = max(0, (bounds.width - content.width) / 2)
        let y = max(0, (bounds.height - content.height) / 2)
        scrollView.contentInset = UIEdgeInsets(top: y, left: x, bottom: y, right: x)
    }

    @objc private func toggleZoom(_ gesture: UITapGestureRecognizer) {
        guard hasImage else { return }
        if isZoomed {
            scrollView.setZoomScale(scrollView.minimumZoomScale, animated: true)
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
