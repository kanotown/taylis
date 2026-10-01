import AVFoundation
import AVKit
import SwiftUI
import UIKit

/// M38: the box a video takes in a message, in the video's own shape (testers, 2026-09-30: a portrait video showed
/// in a landscape box), within the same bounds as a photo.
enum VideoFit {
    static let maxWidth: CGFloat = 240
    static let maxHeight: CGFloat = 240
    /// Narrower than this and the play button and the size no longer fit: a very tall video is cropped to it.
    static let minWidth: CGFloat = 110
    static let minHeight: CGFloat = 90
    /// Before the video's shape is known: the box it always had (16:9).
    static let unknown = CGSize(width: 240, height: 135)

    /// The largest box of the video's shape within maxWidth × maxHeight (never enlarged past it), kept from getting
    /// too thin; `unknown` without a usable size.
    static func box(for size: CGSize?) -> CGSize {
        guard let size, size.width > 0, size.height > 0, size.width.isFinite, size.height.isFinite else { return unknown }
        let scale = min(maxWidth / size.width, maxHeight / size.height)
        let width = (size.width * scale).rounded(), height = (size.height * scale).rounded()
        return CGSize(width: max(minWidth, width), height: max(minHeight, height))
    }

    /// The size the server recorded, when it did.
    static func recorded(_ attachment: AttachmentOut) -> CGSize? {
        guard let width = attachment.width, let height = attachment.height, width > 0, height > 0 else { return nil }
        return CGSize(width: width, height: height)
    }

    /// The size a video track shows at: its stored size turned by its transform (a phone's portrait video is stored
    /// landscape with a quarter turn).
    static func displaySize(natural: CGSize, transform: CGAffineTransform) -> CGSize {
        let turned = CGRect(origin: .zero, size: natural).applying(transform)
        return CGSize(width: abs(turned.width), height: abs(turned.height))
    }

    /// A video file's shape, read from its header (no frames decoded); nil when it has no video track.
    static func naturalSize(of url: URL) async -> CGSize? {
        let asset = AVURLAsset(url: url)
        guard let track = try? await asset.loadTracks(withMediaType: .video).first,
              let (natural, transform) = try? await track.load(.naturalSize, .preferredTransform) else { return nil }
        let size = displaySize(natural: natural, transform: transform)
        return size.width > 0 && size.height > 0 ? size : nil
    }
}

/// M38: videos' shapes found on this device (from their poster or their downloaded file), by attachment id, so a
/// video's box keeps its shape when its row comes back. Kept across launches: a tile learning its shape from the file
/// again after a restart grew under the rows above it as the conversation opened (testers, 2026-10-01).
@MainActor
enum VideoSizes {
    static let key = "video_sizes"
    /// The newest this many stay (a shape is a few bytes; ids only, no names).
    static let kept = 300
    static var defaults = UserDefaults.standard
    private static var known: [String: CGSize]?
    private static var order: [String] = []

    static func size(_ id: String) -> CGSize? { load()[id] }

    static func note(_ id: String, _ size: CGSize) {
        guard size.width > 0, size.height > 0, load()[id] != size else { return }
        known?[id] = size
        order.removeAll { $0 == id }
        order.append(id)
        while order.count > kept { known?[order.removeFirst()] = nil }
        defaults.set(order.compactMap { id in known?[id].map { [id, "\($0.width)", "\($0.height)"] } }, forKey: key)
    }

    /// Forgets what was loaded (tests).
    static func reset() { known = nil; order = [] }

    private static func load() -> [String: CGSize] {
        if let known { return known }
        var loaded: [String: CGSize] = [:]
        order = []
        for row in defaults.array(forKey: key) as? [[String]] ?? [] {
            guard row.count == 3, let width = Double(row[1]), let height = Double(row[2]), width > 0, height > 0 else { continue }
            loaded[row[0]] = CGSize(width: width, height: height)
            order.append(row[0])
        }
        known = loaded
        return loaded
    }
}

/// M38: a video full screen, like the photo viewer: the system player (play, pause, timeline, sound), share (to save it
/// to Photos), 閉じる, and a swipe up or down that takes the video away (testers, 2026-09-30: Quick Look's sheet had no
/// such swipe).
struct VideoViewer: View {
    let attachment: AttachmentOut
    let url: URL
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// 0…1 while the video is dragged away: the header goes first.
    @State private var dragged: CGFloat = 0

    var body: some View {
        VStack(spacing: 0) {
            header.opacity(1 - min(1, dragged * 4))
            VideoPlayerPage(url: url, reduceMotion: reduceMotion,
                            onDrag: { progress in
                                if progress == 0 { withAnimation(.easeOut(duration: 0.2)) { dragged = 0 } } else { dragged = progress }
                            },
                            onClose: close)
                .ignoresSafeArea(edges: .bottom)
        }
        .background(Color.black.opacity(1 - dragged).ignoresSafeArea())
        // The conversation shows through as the video is dragged away (the cover is otherwise opaque).
        .presentationBackground(.clear)
        .preferredColorScheme(.dark)
    }

    private var header: some View {
        HStack {
            Button("閉じる") { dismiss() }
            Spacer()
            ShareLink(item: url) { Image(systemName: "square.and.arrow.up") }
                .accessibilityLabel("共有")
        }
        .tint(.white)
        .overlay {
            VStack(spacing: 0) {
                Text(attachment.filename).font(.footnote.weight(.semibold)).lineLimit(1)
                Text(formatSize(attachment.sizeBytes)).font(.caption2).foregroundStyle(.secondary)
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 72)
            .accessibilityElement(children: .combine)
        }
        .padding(.horizontal, 16)
        .frame(height: 44)
    }

    /// After a swipe the video has already left: the cover goes without sliding down again.
    private func close() {
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) { dismiss() }
    }
}

struct VideoPlayerPage: UIViewControllerRepresentable {
    let url: URL
    let reduceMotion: Bool
    var onDrag: (CGFloat) -> Void = { _ in }
    var onClose: () -> Void = {}

    func makeUIViewController(context: Context) -> VideoPlayerPageController {
        let page = VideoPlayerPageController(url: url)
        page.reduceMotion = reduceMotion
        page.onDrag = onDrag
        page.onClose = onClose
        return page
    }

    func updateUIViewController(_ page: VideoPlayerPageController, context: Context) {
        page.reduceMotion = reduceMotion
        page.onDrag = onDrag
        page.onClose = onClose
    }
}

/// The system player in a page of its own, and the swipe that closes it (the photo viewer's rules, ViewerDismiss).
final class VideoPlayerPageController: UIViewController, UIGestureRecognizerDelegate {
    var reduceMotion = false
    var onDrag: (CGFloat) -> Void = { _ in }
    var onClose: () -> Void = {}

    let player: AVPlayer
    let playerController = AVPlayerViewController()
    let closePan = UIPanGestureRecognizer()
    private var closing = false

    init(url: URL) {
        player = AVPlayer(url: url)
        super.init(nibName: nil, bundle: nil)
    }

    @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }

    override func loadView() {
        let root = ViewerRootView()
        root.backgroundColor = .clear // the SwiftUI side draws the black that fades
        root.onEscape = { [weak self] in self?.onClose() }
        view = root
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        playerController.player = player
        playerController.view.backgroundColor = .clear
        playerController.entersFullScreenWhenPlaybackBegins = false
        addChild(playerController)
        playerController.view.frame = view.bounds
        playerController.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(playerController.view)
        playerController.didMove(toParent: self)
        closePan.addTarget(self, action: #selector(closePanned(_:)))
        closePan.delegate = self
        closePan.maximumNumberOfTouches = 1
        view.addGestureRecognizer(closePan)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        // Sound as in Photos, also with the ring switch off.
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
        player.play()
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        player.pause()
    }

    // MARK: swipe to close

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard gestureRecognizer === closePan else { return true }
        guard !closing else { return false }
        var motion = closePan.translation(in: view)
        if motion == .zero { motion = closePan.velocity(in: view) }
        return ViewerDismiss.videoAxis(motion: motion) != nil
    }

    /// The player's own drags (its timeline, its zoom) wait until this one knows it is not a close.
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer,
                           shouldBeRequiredToFailBy other: UIGestureRecognizer) -> Bool {
        gestureRecognizer === closePan && other is UIPanGestureRecognizer && other.view?.isDescendant(of: playerController.view) == true
    }

    @objc private func closePanned(_ pan: UIPanGestureRecognizer) {
        guard !closing else { return }
        let moved = playerController.view!
        let translation = pan.translation(in: view)
        let extent = view.bounds.height
        switch pan.state {
        case .began, .changed:
            moved.transform = CGAffineTransform(translationX: translation.x, y: translation.y)
            onDrag(ViewerDismiss.progress(offset: translation.y, extent: extent))
        case .ended:
            let velocity = pan.velocity(in: view)
            if ViewerDismiss.shouldClose(offset: translation.y, velocity: velocity.y, extent: extent) {
                flyOff(moved, offset: translation.y, velocity: velocity, extent: extent)
            } else {
                springBack(moved)
            }
        default:
            springBack(moved)
        }
    }

    private func flyOff(_ moved: UIView, offset: CGFloat, velocity: CGPoint, extent: CGFloat) {
        closing = true
        player.pause()
        onDrag(1)
        if reduceMotion {
            UIView.animate(withDuration: 0.2, animations: { self.view.alpha = 0 }, completion: { _ in self.onClose() })
            return
        }
        let direction: CGFloat = offset >= 0 ? 1 : -1
        let duration = min(0.3, max(0.12, Double((extent - abs(offset)) / max(abs(velocity.y), 1500))))
        let start = moved.transform
        UIView.animate(withDuration: duration, delay: 0, options: [.curveEaseOut, .beginFromCurrentState], animations: {
            moved.transform = CGAffineTransform(translationX: start.tx + velocity.x * duration, y: direction * extent)
        }, completion: { _ in self.onClose() })
    }

    private func springBack(_ moved: UIView) {
        onDrag(0)
        let back = { moved.transform = .identity }
        if reduceMotion {
            UIView.animate(withDuration: 0.2, animations: back)
        } else {
            UIView.animate(withDuration: 0.4, delay: 0, usingSpringWithDamping: 0.85, initialSpringVelocity: 0,
                           options: [.allowUserInteraction, .beginFromCurrentState], animations: back)
        }
    }
}
