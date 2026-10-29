import ImageIO
import Network
import SwiftUI
import UIKit

/// Animated GIFs (and APNG / animated WebP in the viewer) move on the phone (docs/MOBILE_UI.md §22.10, user report
/// 2026-10-29: GIFs did not play). The server keeps a still JPEG thumbnail of the first frame and no display size for an
/// animated image, so the frames always come from the original file.
enum AnimatedImageRules {
    /// A GIF tile in a conversation reads the original only up to this size; a larger one keeps its still and the badge
    /// (tap to view it moving).
    static let tileMaxBytes: Int64 = 8 << 20
    /// How many tiles move at once; the others show their still and the badge until one stops.
    static let maxPlayingTiles = 3
    /// One decoded frame at most (4 bytes a pixel): 16 MB, 2048 × 2048. A larger GIF plays decoded smaller.
    static let maxFrameBytes = 16 << 20
    /// The decoded frames kept for the next loops. Past this each frame is decoded again as it comes (only one or two
    /// frames are then in memory).
    static let viewerCacheBytes = 48 << 20
    static let tileCacheBytes = 8 << 20

    /// Whether a conversation tile is a GIF (it may move). APNG and WebP are told apart only by reading their file,
    /// so their tiles stay still; the viewer plays them.
    static func isGIF(contentType: String, filename: String) -> Bool {
        contentType.lowercased() == "image/gif" || filename.lowercased().hasSuffix(".gif")
    }

    /// What keeps the tiles still: the accessibility settings (Reduce Motion, Auto-Play Animated Images off), Low
    /// Power Mode and Low Data Mode.
    struct Conditions: Equatable {
        var reduceMotion = false
        var playAnimatedImages = true
        var lowPower = false
        var lowData = false

        var allowsMotion: Bool { !reduceMotion && playAnimatedImages && !lowPower && !lowData }
    }

    /// Whether a tile in a conversation moves (while on the screen and given a slot).
    static func tileAnimates(contentType: String, filename: String, sizeBytes: Int64, conditions: Conditions) -> Bool {
        isGIF(contentType: contentType, filename: filename) && sizeBytes > 0 && sizeBytes <= tileMaxBytes && conditions.allowsMotion
    }

    /// The long side (pixels) to decode frames at: the image's own, less when a frame would pass `maxBytes`, and for a
    /// tile (`fill`, its box in pixels) no more than the tile shows when the image fills it.
    static func decodePixels(width: Int, height: Int, maxBytes: Int = maxFrameBytes, fill: CGSize? = nil) -> Int {
        guard width > 0, height > 0 else { return 1 }
        let long = max(width, height)
        var side = Double(long)
        let pixels = Double(width) * Double(height)
        let allowed = Double(maxBytes) / 4
        if pixels > allowed { side = Double(long) * (allowed / pixels).squareRoot() }
        if let fill, fill.width > 0, fill.height > 0 {
            let cover = max(Double(fill.width) / Double(width), Double(fill.height) / Double(height))
            side = min(side, Double(long) * cover)
        }
        return max(1, min(long, Int(side.rounded(.down))))
    }

    /// The size of a frame decoded at `longSide`.
    static func frameSize(width: Int, height: Int, longSide: Int) -> (width: Int, height: Int) {
        guard width > 0, height > 0 else { return (1, 1) }
        let scale = min(1, Double(longSide) / Double(max(width, height)))
        return (max(1, Int((Double(width) * scale).rounded())), max(1, Int((Double(height) * scale).rounded())))
    }

    /// Whether all the frames fit the budget (kept after the first loop) or are decoded as they come.
    static func keepsFrames(count: Int, width: Int, height: Int, budget: Int) -> Bool {
        Int64(count) * Int64(width) * Int64(height) * 4 <= Int64(budget)
    }
}

/// An image file with more than one frame, read by ImageIO frame by frame (GIF, APNG, animated WebP). ImageIO
/// composes each frame the way browsers show it.
final class AnimatedImageSource: @unchecked Sendable {
    private let source: CGImageSource
    let count: Int
    /// Seconds each frame shows (CustomEmoji.frameDelay: no delay is 0.1 s, as browsers do).
    let delays: [TimeInterval]
    let width: Int
    let height: Int

    /// nil for a still image (one frame) or one ImageIO cannot read.
    init?(data: Data) {
        let options = [kCGImageSourceShouldCache: false] as CFDictionary
        guard let source = CGImageSourceCreateWithData(data as CFData, options) else { return nil }
        let count = CGImageSourceGetCount(source)
        guard count > 1,
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue,
              let height = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue,
              width > 0, height > 0 else { return nil }
        self.source = source
        self.count = count
        self.width = width
        self.height = height
        delays = (0..<count).map { CustomEmoji.frameDelay(source, $0) }
    }

    /// The frame at `index`, at most `longSide` pixels on its longer side. Not cached by ImageIO (the player decides).
    func frame(_ index: Int, longSide: Int) -> CGImage? {
        if longSide >= max(width, height) {
            let options: [CFString: Any] = [kCGImageSourceShouldCache: false, kCGImageSourceShouldCacheImmediately: true]
            return CGImageSourceCreateImageAtIndex(source, index, options as CFDictionary)
        }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCache: false,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: max(longSide, 1),
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, index, options as CFDictionary)
    }
}

/// Plays an animated image's frames (looping, whatever loop count the file asks for) into `onFrame`, each decoded off
/// the main thread. The frames are kept when they all fit `cacheBudget`, else decoded again each loop. Stopped, it
/// resumes at the frame it stopped at.
@MainActor
final class AnimatedImagePlayer {
    let source: AnimatedImageSource
    let longSide: Int
    let keepsFrames: Bool
    var onFrame: (UIImage) -> Void = { _ in }
    private var frames: [Int: UIImage] = [:]
    private(set) var index = 0
    private var task: Task<Void, Never>?
    private var memoryWarning: NSObjectProtocol?

    var isPlaying: Bool { task != nil }
    var keptFrames: Int { frames.count }

    init(source: AnimatedImageSource, longSide: Int, cacheBudget: Int) {
        self.source = source
        self.longSide = longSide
        let size = AnimatedImageRules.frameSize(width: source.width, height: source.height, longSide: longSide)
        keepsFrames = AnimatedImageRules.keepsFrames(count: source.count, width: size.width, height: size.height, budget: cacheBudget)
        memoryWarning = NotificationCenter.default.addObserver(forName: UIApplication.didReceiveMemoryWarningNotification,
                                                               object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.frames.removeAll() }
        }
    }

    deinit {
        task?.cancel()
        if let memoryWarning { NotificationCenter.default.removeObserver(memoryWarning) }
    }

    func play() {
        guard task == nil else { return }
        task = Task { [weak self] in await self?.run() }
    }

    func stop() {
        task?.cancel()
        task = nil
    }

    /// The loop, until the calling task is cancelled.
    func run() async {
        let clock = ContinuousClock()
        var deadline = clock.now
        while !Task.isCancelled {
            let i = index
            let image: UIImage
            if let kept = frames[i] {
                image = kept
            } else {
                let source = source, side = longSide
                guard let decoded = await Task.detached(priority: .utility, operation: { source.frame(i, longSide: side) }).value else { return }
                image = UIImage(cgImage: decoded)
                if keepsFrames { frames[i] = image }
            }
            guard !Task.isCancelled else { return }
            try? await clock.sleep(until: deadline, tolerance: .milliseconds(5))
            guard !Task.isCancelled else { return }
            onFrame(image)
            // Behind (a slow decode), it goes on from now rather than rushing through the frames it missed.
            deadline = max(deadline.advanced(by: .milliseconds(Int(source.delays[i] * 1000))), clock.now)
            index = (i + 1) % source.count
        }
    }
}

/// The tiles moving at once (`AnimatedImageRules.maxPlayingTiles`); the others wait in the order they asked.
@MainActor
final class AnimatedTileSlots {
    static let shared = AnimatedTileSlots(limit: AnimatedImageRules.maxPlayingTiles)
    let limit: Int
    private(set) var playing: Set<UUID> = []
    private var waiting: [(UUID, CheckedContinuation<Bool, Never>)] = []

    init(limit: Int) { self.limit = limit }

    /// true once the tile has a slot; false when its task was cancelled while waiting.
    func acquire(_ id: UUID) async -> Bool {
        if playing.contains(id) { return true }
        if playing.count < limit && waiting.isEmpty {
            playing.insert(id)
            return true
        }
        return await withTaskCancellationHandler {
            await withCheckedContinuation { continuation in
                if Task.isCancelled { continuation.resume(returning: false) } else { waiting.append((id, continuation)) }
            }
        } onCancel: {
            Task { @MainActor in self.cancel(id) }
        }
    }

    func release(_ id: UUID) {
        guard playing.remove(id) != nil else { cancel(id); return }
        while playing.count < limit, !waiting.isEmpty {
            let (next, continuation) = waiting.removeFirst()
            playing.insert(next)
            continuation.resume(returning: true)
        }
    }

    private func cancel(_ id: UUID) {
        guard let at = waiting.firstIndex(where: { $0.0 == id }) else { return }
        waiting.remove(at: at).1.resume(returning: false)
    }
}

/// The originals of GIF tiles read lately (24 MB), so scrolling back does not fetch them again.
enum AnimatedImageData {
    private static let cache: NSCache<NSString, NSData> = {
        let cache = NSCache<NSString, NSData>()
        cache.totalCostLimit = 24 << 20
        return cache
    }()

    static func load(_ key: String, fetch: () async throws -> Data) async throws -> Data {
        if let kept = cache.object(forKey: key as NSString) { return kept as Data }
        let data = try await fetch()
        cache.setObject(data as NSData, forKey: key as NSString, cost: data.count)
        return data
    }
}

/// Low Power Mode and Low Data Mode, as they change (they keep the tiles still).
@MainActor @Observable
final class DeviceSavings {
    static let shared = DeviceSavings()
    private(set) var lowPower = ProcessInfo.processInfo.isLowPowerModeEnabled
    private(set) var lowData = false
    @ObservationIgnored private let monitor = NWPathMonitor()

    private init() {
        NotificationCenter.default.addObserver(forName: .NSProcessInfoPowerStateDidChange, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { DeviceSavings.shared.lowPower = ProcessInfo.processInfo.isLowPowerModeEnabled }
        }
        monitor.pathUpdateHandler = { path in
            let constrained = path.isConstrained
            Task { @MainActor in DeviceSavings.shared.lowData = constrained }
        }
        monitor.start(queue: DispatchQueue(label: "DeviceSavings"))
    }
}

/// One conversation tile's moving frames: while it plays it holds a slot, its original's bytes come from
/// `AnimatedImageData`, and frames are decoded at the tile's pixels.
@MainActor @Observable
final class AnimatedTile {
    private(set) var frame: UIImage?
    /// The file turned out to be still (one frame) or unreadable: no badge, no second try.
    private(set) var still = false
    @ObservationIgnored private let token = UUID()
    @ObservationIgnored private let slots: AnimatedTileSlots

    init(slots: AnimatedTileSlots? = nil) { self.slots = slots ?? .shared }

    /// Plays until the calling task is cancelled (the tile leaves the screen, a setting changes); then the still shows again.
    func run(key: String, fill: CGSize, fetch: () async throws -> Data) async {
        guard !still, await slots.acquire(token) else { return }
        defer {
            slots.release(token)
            frame = nil
        }
        guard let data = try? await AnimatedImageData.load(key, fetch: fetch), !Task.isCancelled else { return }
        guard let source = AnimatedImageSource(data: data) else {
            still = true
            return
        }
        let side = AnimatedImageRules.decodePixels(width: source.width, height: source.height, fill: fill)
        let player = AnimatedImagePlayer(source: source, longSide: side, cacheBudget: AnimatedImageRules.tileCacheBytes)
        player.onFrame = { [weak self] in self?.frame = $0 }
        await player.run()
    }
}

/// The small 「GIF」 mark on a tile that is not moving (a setting keeps it still, it waits for a slot, it is too large).
/// `compact`: on a drive row's small thumbnail (40–64 pt).
struct GIFBadge: View {
    var compact = false

    var body: some View {
        Text(verbatim: "GIF")
            .font(compact ? .system(size: 8, weight: .bold) : .caption2.weight(.bold))
            .foregroundStyle(.white)
            .padding(.horizontal, compact ? 3 : 5)
            .padding(.vertical, compact ? 0 : 1)
            .background(Color.black.opacity(0.55), in: RoundedRectangle(cornerRadius: compact ? 3 : 4))
            .padding(compact ? 2 : 6)
            .accessibilityHidden(true)
    }
}
