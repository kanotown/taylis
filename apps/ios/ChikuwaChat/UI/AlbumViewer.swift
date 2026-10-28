import AVFoundation
import Photos
import SwiftUI
import UIKit

// AL3 (docs/ALBUMS.md §6, §10.3, §12): an album's photos full screen and as a slideshow. Both read the display size
// (2048 px WebP, no metadata) and the original only on 「元の画像」, a zoom past the display size, saving to Photos or
// sharing. Kept per attachment in Caches/drive/display (the system clears caches when it needs the room).

/// What the photo viewer adds for an album (ImageViewer's `extras`).
struct ImageViewerExtras {
    /// The header's second line instead of the size: when it was taken.
    var caption: (AttachmentOut) -> String?
    /// 「位置情報あり」 in the header.
    var hasLocation: (AttachmentOut) -> Bool
    /// The original (「元の画像を開く」, a zoom past the display size); nil: the viewer shows only what it loaded.
    var original: (@MainActor (AttachmentOut) async -> URL?)?
    /// 「写真アプリに保存」: the message to show after it.
    var save: @MainActor (AttachmentOut) async -> String?
    /// 「共有」: the original's file for the share sheet (nil: it could not be fetched; the error says why).
    var share: @MainActor (AttachmentOut) async -> URL?
    /// 「詳細」.
    var details: (AttachmentOut) -> AnyView
}

enum AlbumFiles {
    /// A photo's display size on this device (fetched once per attachment: a version's bytes never change).
    @MainActor
    static func display(_ attachmentId: String, controller: AppController) async -> URL? {
        guard let api = controller.api else { return nil }
        let destination = DriveFiles.directory("display").appendingPathComponent(attachmentId + ".img")
        if FileManager.default.fileExists(atPath: destination.path) { return destination }
        do {
            let data = try await api.fetchData(AlbumRules.displayPath(attachmentId))
            try FileManager.default.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
            try data.write(to: destination, options: .atomic)
            return destination
        } catch {
            return nil
        }
    }

    /// The viewer's additions for the photos of an album (`items` by attachment id).
    @MainActor
    static func extras(items: [String: DriveItemOut], path: [DriveCrumb], kind: String?, controller: AppController) -> ImageViewerExtras {
        ImageViewerExtras(
            caption: { attachment in
                // Short, beside 「位置情報あり」 and 「2 / 60」 in the header: 「2026/9/16 9:12」.
                guard let taken = items[attachment.id]?.file?.takenAt, let date = parseIsoDate(taken) else { return nil }
                return AlbumRules.shortTime(date)
            },
            hasLocation: { items[$0.id]?.file?.hasLocation == true },
            original: { attachment in
                guard let item = items[attachment.id] else { return nil }
                return await DriveFiles.viewFile(item, controller: controller)
            },
            save: { attachment in
                guard let item = items[attachment.id] else { return nil }
                return await PhotoLibrarySaver.save([item], controller: controller)
            },
            share: { attachment in
                guard let item = items[attachment.id] else { return nil }
                return await DriveFiles.viewFile(item, controller: controller)
            },
            details: { attachment in
                if let item = items[attachment.id] {
                    AnyView(AlbumPhotoDetails(controller: controller, item: item, path: path, kind: kind))
                } else {
                    AnyView(EmptyView())
                }
            })
    }
}

/// 「詳細」 of an album's photo: when it was taken, its size and shape, its type, whether the original holds a
/// location, who added it, where it is.
struct AlbumPhotoDetails: View {
    @Bindable var controller: AppController
    let item: DriveItemOut
    let path: [DriveCrumb]
    let kind: String?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    LabeledContent("名前", value: item.name)
                    if let taken = item.file?.takenAt { LabeledContent("撮影日時", value: Timeline.fullLabel(taken)) }
                    LabeledContent("大きさ", value: driveSize(item.sizeBytes ?? 0))
                    if let width = item.file?.width, let height = item.file?.height {
                        LabeledContent("縦横", value: "\(width) × \(height)")
                    }
                    LabeledContent("種類", value: item.contentType ?? "")
                    if item.file?.hasLocation == true {
                        LabeledContent("位置情報", value: tr("位置情報あり"))
                    }
                }
                Section {
                    if let id = item.createdBy { LabeledContent("追加した人", value: controller.store.users[id]?.displayName ?? tr("だれか")) }
                    LabeledContent("追加した日時", value: Timeline.fullLabel(item.createdAt))
                    if !path.isEmpty { LabeledContent("場所", value: DriveRules.whereLabel(path, kind: kind)) }
                } footer: {
                    if item.file?.hasLocation == true {
                        Text("元の写真には撮影場所の情報が含まれています。研究室の中ではそのまま渡ります。学外への共有リンクでは、既定で位置情報を含まない表示用の画像だけが渡ります。")
                    }
                }
            }
            .navigationTitle("詳細")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("閉じる") { dismiss() } } }
        }
    }
}

/// 「写真アプリに保存」 (§12): the originals streamed to files (never held whole in memory), then added to the library
/// with the add-only permission (NSPhotoLibraryAddUsageDescription). Photos and videos; a file the library refuses
/// (a RAW, a PDF) is counted as not saved.
enum PhotoLibrarySaver {
    enum Outcome: Equatable {
        case saved(Int, failed: Int)
        case denied
    }

    /// The message after saving `items`.
    @MainActor
    static func save(_ items: [DriveItemOut], controller: AppController) async -> String {
        let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
        guard status == .authorized || status == .limited else { return message(.denied) }
        var files: [(URL, Bool)] = []
        var failed = 0
        for item in items {
            if let url = await DriveFiles.viewFile(item, controller: controller) {
                files.append((url, AlbumRules.isVideo(item)))
            } else {
                failed += 1
            }
        }
        var saved = 0
        for (url, video) in files {
            do {
                try await PHPhotoLibrary.shared().performChanges {
                    let request = PHAssetCreationRequest.forAsset()
                    request.addResource(with: video ? .video : .photo, fileURL: url, options: nil)
                }
                saved += 1
            } catch {
                failed += 1
            }
        }
        return message(.saved(saved, failed: failed))
    }

    static func message(_ outcome: Outcome) -> String {
        switch outcome {
        case .denied:
            return tr("写真アプリへの追加が許可されていません。設定 › Taylis › 写真 で「写真を追加のみ」を許可してください")
        case .saved(let saved, let failed):
            if saved == 0 { return tr("写真アプリに保存できませんでした") }
            let done = tr("\(saved) 件を写真アプリに保存しました")
            return failed > 0 ? done + tr("（\(failed) 件は保存できませんでした）") : done
        }
    }
}

// MARK: slideshow

/// The slideshow's settings, kept on this device.
enum SlideshowSettings {
    static let intervalKey = "album.slideshow.interval"
    static let randomKey = "album.slideshow.random"
    static let skipVideosKey = "album.slideshow.skipVideos"
}

/// AL3 (§8, §10.3, §12): full screen, black, the display sizes one after another (a cross-fade), the next two read
/// ahead; a video plays muted to its end, at most a minute. The screen stays on while it shows
/// (`isIdleTimerDisabled`). A tap shows or hides its controls (close, back, pause, next, the settings).
struct AlbumSlideshow: View {
    @Bindable var controller: AppController
    let items: [DriveItemOut]
    let startId: String?
    @Environment(\.dismiss) private var dismiss
    @AppStorage(SlideshowSettings.intervalKey) private var interval = 5
    @AppStorage(SlideshowSettings.randomKey) private var random = false
    @AppStorage(SlideshowSettings.skipVideosKey) private var skipVideos = false
    @State private var order: [DriveItemOut] = []
    @State private var index = 0
    @State private var playing = true
    @State private var controls = true
    @State private var images: [String: UIImage] = [:]
    @State private var video: AVPlayer?
    /// Bumped to restart the current item's timer (a step by hand, a setting changed).
    @State private var tick = 0

    private var current: DriveItemOut? { order.indices.contains(index) ? order[index] : nil }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if let current {
                slide(current)
                    .id(current.id)
                    .transition(.opacity)
                    .ignoresSafeArea()
            } else {
                Text("スライドショーにする写真がありません").foregroundStyle(.white.opacity(0.8))
            }
            if controls { overlay.transition(.opacity) }
        }
        .contentShape(Rectangle())
        .onTapGesture { withAnimation(.easeInOut(duration: ViewerChrome.fade)) { controls.toggle() } }
        .statusBarHidden(!controls)
        .persistentSystemOverlays(controls ? .automatic : .hidden)
        .modifier(DarkPresentation())
        .onAppear {
            UIApplication.shared.isIdleTimerDisabled = true
            rebuild(keeping: startId)
            // The controls go after a moment, as in Photos.
            Task {
                try? await Task.sleep(for: .seconds(2))
                withAnimation(.easeInOut(duration: ViewerChrome.fade)) { controls = false }
            }
        }
        .onDisappear {
            UIApplication.shared.isIdleTimerDisabled = false
            video?.pause()
            video = nil
        }
        .onChange(of: random) { _, _ in rebuild(keeping: current?.id) }
        .onChange(of: skipVideos) { _, _ in rebuild(keeping: current?.id) }
        .onChange(of: interval) { _, _ in tick += 1 }
        .task(id: "\(current?.id ?? "")|\(playing)|\(tick)") { await run() }
    }

    @ViewBuilder
    private func slide(_ item: DriveItemOut) -> some View {
        if AlbumRules.isVideo(item) {
            if let video { SlideshowVideoView(player: video) } else { ProgressView().tint(.white) }
        } else if let image = images[item.id] {
            Image(uiImage: image).resizable().scaledToFit()
                .accessibilityLabel(Text(tr("写真 \(item.name)")))
        } else {
            ProgressView().tint(.white)
        }
    }

    private var overlay: some View {
        VStack {
            HStack {
                Button("閉じる") { dismiss() }
                Spacer()
                if let current {
                    Text("\(index + 1) / \(order.count)").font(.footnote.monospacedDigit()).foregroundStyle(.white.opacity(0.8))
                        .accessibilityLabel(Text(ImageGallery.spokenPosition(index, of: order.count)))
                        .accessibilityHint(Text(current.name))
                }
                Spacer()
                Menu {
                    Picker("間隔", selection: $interval) {
                        ForEach(SlideshowRules.intervals, id: \.self) { Text(tr("\($0) 秒")).tag($0) }
                    }
                    Picker("順番", selection: $random) {
                        Text("順番どおり").tag(false)
                        Text("ランダム").tag(true)
                    }
                    Toggle("動画を飛ばす", isOn: $skipVideos)
                } label: {
                    Image(systemName: "gearshape").frame(width: 36, height: 36).contentShape(Rectangle())
                }
                .accessibilityLabel(Text("スライドショーの設定"))
            }
            .padding(.horizontal, 16)
            .frame(height: 44)
            .background(Color.black.opacity(0.55).ignoresSafeArea(edges: .top))
            Spacer()
            HStack(spacing: 44) {
                Button { step(-1) } label: { Image(systemName: "backward.fill") }
                    .accessibilityLabel(Text("前の写真"))
                Button { playing.toggle() } label: { Image(systemName: playing ? "pause.fill" : "play.fill") }
                    .accessibilityLabel(playing ? Text("一時停止") : Text("再生"))
                Button { step(1) } label: { Image(systemName: "forward.fill") }
                    .accessibilityLabel(Text("次の写真"))
            }
            .font(.title2)
            .padding(.horizontal, 28).padding(.vertical, 12)
            .background(Color.black.opacity(0.55), in: Capsule())
            .padding(.bottom, 24)
        }
        .tint(.white)
        .foregroundStyle(.white)
    }

    private func rebuild(keeping id: String?) {
        order = SlideshowRules.sequence(items, skipVideos: skipVideos, random: random, start: random ? nil : id)
        index = 0
        if random, let id, let found = order.firstIndex(where: { $0.id == id }) { order.swapAt(0, found) }
        tick += 1
    }

    private func step(_ by: Int) {
        guard !order.isEmpty else { return }
        withAnimation(.easeInOut(duration: 0.4)) {
            index = by > 0 ? SlideshowRules.next(index, count: order.count) : SlideshowRules.previous(index, count: order.count)
        }
        tick += 1
    }

    /// Shows the current item (its photo read, or its video started muted), reads the next two, waits its time, goes on.
    private func run() async {
        guard let current else { return }
        if AlbumRules.isVideo(current) {
            await startVideo(current)
        } else {
            video?.pause()
            video = nil
            if images[current.id] == nil { await fetch(current) }
        }
        for ahead in SlideshowRules.ahead(index, count: order.count) { await fetch(order[ahead]) }
        // Only the shown and the next two stay decoded.
        let keep = Set(([index] + SlideshowRules.ahead(index, count: order.count)).map { order[$0].id })
        images = images.filter { keep.contains($0.key) }
        guard playing else {
            video?.pause()
            return
        }
        video?.play()
        let wait = SlideshowRules.duration(current, interval: interval)
        if AlbumRules.isVideo(current), let item = video?.currentItem {
            // Its end or the minute, whichever comes first.
            await withTaskGroup(of: Void.self) { group in
                group.addTask {
                    for await _ in NotificationCenter.default.notifications(named: AVPlayerItem.didPlayToEndTimeNotification, object: item) { break }
                }
                group.addTask { try? await Task.sleep(for: .seconds(wait)) }
                await group.next()
                group.cancelAll()
            }
        } else {
            try? await Task.sleep(for: .seconds(wait))
        }
        guard !Task.isCancelled, playing else { return }
        step(1)
    }

    private func fetch(_ item: DriveItemOut) async {
        guard !AlbumRules.isVideo(item), images[item.id] == nil, let attachmentId = item.file?.attachmentId,
              let url = await AlbumFiles.display(attachmentId, controller: controller) else { return }
        let image = await Task.detached(priority: .userInitiated) { () -> UIImage? in
            guard let data = try? Data(contentsOf: url), let image = UIImage(data: data) else { return nil }
            return image.preparingForDisplay() ?? image
        }.value
        if let image { images[item.id] = image }
    }

    private func startVideo(_ item: DriveItemOut) async {
        video?.pause()
        video = nil
        guard let api = controller.api, let ticket = try? await api.driveDownloadTicket(item.id),
              let url = DriveFiles.absolute(ticket.url, base: api.baseUrl), !Task.isCancelled else { return }
        let player = AVPlayer(url: url)
        player.isMuted = true
        video = player
    }
}

/// A video in the slideshow: the picture alone (no controls), fitted to the screen.
struct SlideshowVideoView: UIViewRepresentable {
    let player: AVPlayer

    func makeUIView(context: Context) -> PlayerView {
        let view = PlayerView()
        view.playerLayer.videoGravity = .resizeAspect
        view.playerLayer.player = player
        view.isAccessibilityElement = true
        view.accessibilityLabel = tr("動画")
        return view
    }

    func updateUIView(_ view: PlayerView, context: Context) {
        if view.playerLayer.player !== player { view.playerLayer.player = player }
    }

    final class PlayerView: UIView {
        override class var layerClass: AnyClass { AVPlayerLayer.self }
        var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }
    }
}
