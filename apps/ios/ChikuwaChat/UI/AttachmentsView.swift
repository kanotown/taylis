import AVFoundation
import PhotosUI
import QuickLook
import SwiftUI
import UniformTypeIdentifiers

/// Photo library picks for upload: PNG / JPEG / GIF / WebP go as they are; anything else (HEIC on most iPhones) is
/// re-encoded as JPEG like the camera path, since the server makes thumbnails and avatars from those four only.
enum ImageUpload {
    /// The format of `data` by its magic bytes, when the server takes it as it is.
    static func kind(of data: Data) -> (ext: String, mime: String)? {
        let head = [UInt8](data.prefix(12))
        if head.starts(with: [0x89, 0x50, 0x4E, 0x47]) { return ("png", "image/png") }
        if head.starts(with: [0xFF, 0xD8, 0xFF]) { return ("jpg", "image/jpeg") }
        if head.starts(with: [0x47, 0x49, 0x46, 0x38]) { return ("gif", "image/gif") }
        if head.count == 12, head.starts(with: [0x52, 0x49, 0x46, 0x46]), Array(head[8..<12]) == [0x57, 0x45, 0x42, 0x50] { return ("webp", "image/webp") }
        return nil
    }

    /// nil when the bytes are no image at all.
    static func prepare(_ data: Data) -> (data: Data, ext: String, mime: String)? {
        if let kind = kind(of: data) { return (data, kind.ext, kind.mime) }
        guard let image = UIImage(data: data), let jpeg = image.normalizedUp().jpegData(compressionQuality: 0.85) else { return nil }
        return (jpeg, "jpg", "image/jpeg")
    }
}

/// A video picked from the photo library (testers, 2026-09-29: videos were not offered at all), copied out of the
/// picker's temporary file so it can be uploaded from disk.
struct PickedMovie: Transferable {
    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(contentType: .movie) { SentTransferredFile($0.url) } importing: { received in
            // Its own folder, so the file keeps its name (IMG_1234.MOV) without clashing with another pick.
            let dir = FileManager.default.temporaryDirectory.appendingPathComponent("picked-videos/\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let name = received.file.lastPathComponent.isEmpty ? "video.mov" : received.file.lastPathComponent
            let copy = dir.appendingPathComponent(name)
            try FileManager.default.copyItem(at: received.file, to: copy)
            return PickedMovie(url: copy)
        }
    }
}

enum VideoUpload {
    /// A copy of the video at 1280×720 H.264: a minute of an iPhone's 4K video is about 170 MB, past the server's
    /// limit; at 720p it is about 40 MB. nil when it cannot be exported.
    static func shrink(_ url: URL) async -> URL? {
        guard let session = AVAssetExportSession(asset: AVURLAsset(url: url), presetName: AVAssetExportPreset1280x720) else { return nil }
        let out = url.deletingPathExtension().appendingPathExtension("720p.mp4")
        try? FileManager.default.removeItem(at: out)
        if #available(iOS 18.0, *) {
            do { try await session.export(to: out, as: .mp4) } catch { return nil }
            return out
        }
        session.outputURL = out
        session.outputFileType = .mp4
        await session.export()
        return session.status == .completed ? out : nil
    }
}

func formatSize(_ bytes: Int64) -> String {
    if bytes >= 1_048_576 { return String(format: "%.1f MB", Double(bytes) / 1_048_576) }
    if bytes >= 1024 { return String(format: "%.0f KB", Double(bytes) / 1024) }
    return "\(bytes) B"
}

/// Images show their thumbnail, videos a tile that plays them; documents download with authentication before a local
/// system preview. `present` shows a downloaded file from the conversation (MessageSheet), not from the row.
struct AttachmentsView: View {
    let attachments: [AttachmentOut]
    @Bindable var controller: AppController
    var present: ((URL) -> Void)? = nil

    /// Several photos sit side by side as square tiles (testers, 2026-09-29: they came one under another), two in a
    /// row for two or four, three otherwise; one photo keeps its own shape.
    static func photoColumns(_ count: Int) -> Int { count == 2 || count == 4 ? 2 : 3 }
    static let photoGridWidth: CGFloat = 280

    var body: some View {
        let photos = attachments.filter(\.isImage)
        VStack(alignment: .leading, spacing: 6) {
            if photos.count > 1 {
                let columns = Self.photoColumns(photos.count)
                let side = (Self.photoGridWidth - CGFloat(columns - 1) * 4) / CGFloat(columns)
                LazyVGrid(columns: Array(repeating: GridItem(.fixed(side), spacing: 4), count: columns), alignment: .leading, spacing: 4) {
                    ForEach(photos) { photo in ThumbnailView(attachment: photo, controller: controller, square: side, gallery: photos) }
                }
                .frame(width: Self.photoGridWidth, alignment: .leading)
            }
            ForEach(attachments) { attachment in
                if attachment.isImage {
                    if photos.count == 1 { ThumbnailView(attachment: attachment, controller: controller) }
                } else if attachment.isVideo {
                    VideoTile(attachment: attachment, controller: controller)
                } else {
                    HStack(spacing: 8) {
                        Image(systemName: attachment.isVideo ? "film" : "doc").foregroundStyle(.secondary)
                        VStack(alignment: .leading) {
                            Text(attachment.filename).font(.subheadline)
                            Text(formatSize(attachment.sizeBytes)).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        AttachmentFileButton(attachment: attachment, present: present) { await controller.downloadAttachment(attachment) }
                    }
                    .padding(8)
                    .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
                }
            }
        }
        .padding(.top, 2)
    }

}

enum AttachmentFileCache {
    static func destination(for attachment: AttachmentOut, in directory: URL) -> URL {
        directory.appendingPathComponent(attachment.id.replacingOccurrences(of: "/", with: "_"), isDirectory: true)
            .appendingPathComponent(attachment.filename.replacingOccurrences(of: "/", with: "_"))
    }
}

enum AttachmentPreview {
    // Local Quick Look only; active web documents stay download/share-only, like the server's inline policy.
    static func allows(_ url: URL) -> Bool {
        ["pdf", "txt", "md", "csv", "tsv", "json", "log", "rtf", "rtfd", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
         "pages", "numbers", "key", "png", "jpg", "jpeg", "heic", "gif", "webp", "tif", "tiff", "bmp",
         "mp4", "mov", "m4v", "mp3", "wav", "aac", "m4a", "aiff"].contains(url.pathExtension.lowercased())
    }

    static func canPreview(_ url: URL) -> Bool { allows(url) && QLPreviewController.canPreview(url as NSURL) }
}

@MainActor @Observable
final class AttachmentFileLoader {
    var url: URL?
    var loading = false
    var failed = false

    func load(download: () async -> URL?) async {
        guard !loading else { return }
        loading = true
        failed = false
        defer { loading = false }
        let downloaded = await download()
        guard !Task.isCancelled else { return }
        url = downloaded
        failed = downloaded == nil
    }
}

/// Shared by conversation attachments and the Files list; no duplicate downloads while one is running. 「開く」 downloads
/// and shows the file (its share button is in the preview). It was a task keyed on the taps, which ran again whenever
/// the row came back into the list: with the keyboard coming up the video opened again and again (testers,
/// 2026-09-29). `present` shows it from the conversation; without it (the Files list) it is shown from here.
struct AttachmentFileButton: View {
    let attachment: AttachmentOut
    var present: ((URL) -> Void)? = nil
    let download: () async -> URL?
    @State private var loader = AttachmentFileLoader()
    @State private var previewURL: URL?
    @State private var shareURL: URL?

    var body: some View {
        Group {
            if loader.loading {
                ProgressView().accessibilityLabel("\(attachment.filename) を読み込み中")
            } else {
                Button(action: tapped) {
                    Label(loader.failed ? "再試行" : "開く", systemImage: loader.failed ? "arrow.clockwise" : "doc.text.magnifyingglass")
                        .font(.footnote)
                }
                .accessibilityLabel("\(attachment.filename) を\(loader.failed ? "再試行" : "開く")")
            }
        }
        .buttonStyle(.borderless)
        .sheet(item: $previewURL) { url in FilePreviewSheet(url: url, onDismiss: { previewURL = nil }) }
        .sheet(item: $shareURL) { url in ShareSheet(items: [url]) }
    }

    private func tapped() {
        if let url = loader.url { show(url); return }
        Task {
            await loader.load(download: download)
            if let url = loader.url { show(url) }
        }
    }

    private func show(_ url: URL) {
        if let present { present(url) } else if AttachmentPreview.canPreview(url) { previewURL = url } else { shareURL = url }
    }
}

/// A video in a message (testers, 2026-09-29): a dark tile with a play button, the name and the size; a tap downloads
/// it and plays it full screen (VideoViewer, M38; it was Quick Look's sheet), whose share button saves it to Photos.
/// M38: the tile has the video's shape (VideoFit): the size the server recorded, else its poster's, else the
/// downloaded file's once there is one; a landscape box until then.
struct VideoTile: View {
    let attachment: AttachmentOut
    @Bindable var controller: AppController
    @State private var loader = AttachmentFileLoader()
    @State private var playing: URL?
    @State private var poster: UIImage?
    @State private var found: CGSize?

    private var shape: CGSize? { VideoFit.recorded(attachment) ?? found }

    var body: some View {
        let box = VideoFit.box(for: shape)
        Button(action: tapped) {
            ZStack {
                RoundedRectangle(cornerRadius: 10).fill(Color.black.opacity(0.85))
                if let poster {
                    Image(uiImage: poster).resizable().scaledToFill().frame(width: box.width, height: box.height).clipped()
                        .overlay(Color.black.opacity(0.15))
                }
                if loader.loading {
                    ProgressView().tint(.white)
                } else {
                    Image(systemName: loader.failed ? "arrow.clockwise.circle.fill" : "play.circle.fill")
                        .font(.system(size: 44)).foregroundStyle(.white.opacity(0.9))
                }
                VStack {
                    Spacer()
                    HStack(spacing: 6) {
                        Image(systemName: "film")
                        Text(attachment.filename).lineLimit(1)
                        Spacer(minLength: 4)
                        Text(formatSize(attachment.sizeBytes)).lineLimit(1).fixedSize() // a narrow (portrait) tile cuts the name, not the size
                    }
                    .font(.caption2).foregroundStyle(.white.opacity(0.85))
                    .padding(.horizontal, 10).padding(.bottom, 8)
                }
            }
            .frame(width: box.width, height: box.height)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .contentShape(RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
        .disabled(loader.loading)
        .accessibilityLabel("動画 \(attachment.filename) を\(loader.failed ? "再試行" : "再生")")
        .fullScreenCover(item: $playing) { url in VideoViewer(attachment: attachment, url: url) }
        .task(id: attachment.id) { await findShape() }
    }

    /// The poster (a server thumbnail, when it makes one) and the video's shape where the server did not record it.
    private func findShape() async {
        if found == nil, let known = VideoSizes.size(attachment.id) { found = known }
        if attachment.hasThumbnail, poster == nil, let api = controller.api,
           let data = try? await api.fetchData("/api/v1/attachments/\(attachment.id)/thumbnail"), let image = UIImage(data: data) {
            poster = image
            if found == nil { remember(image.size) }
        }
        guard VideoFit.recorded(attachment) == nil, found == nil else { return }
        // Downloaded before (this launch or an earlier one): its header says.
        let file = AttachmentFileCache.destination(for: attachment, in: FileManager.default.temporaryDirectory.appendingPathComponent("attachments", isDirectory: true))
        if FileManager.default.fileExists(atPath: file.path), let size = await VideoFit.naturalSize(of: file) { remember(size) }
    }

    private func remember(_ size: CGSize) {
        VideoSizes.note(attachment.id, size)
        withAnimation(.easeOut(duration: 0.2)) { found = size }
    }

    private func tapped() {
        if let url = loader.url { playing = url; return }
        Task {
            await loader.load { await controller.downloadAttachment(attachment) }
            guard let url = loader.url else { return }
            if VideoFit.recorded(attachment) == nil, found == nil, let size = await VideoFit.naturalSize(of: url) { remember(size) }
            playing = url
        }
    }
}

/// System document rendering and share actions, with a visible way back to the conversation.
struct FilePreviewSheet: UIViewControllerRepresentable {
    let url: URL
    let onDismiss: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(url: url) }
    func makeUIViewController(context: Context) -> UINavigationController {
        let preview = QLPreviewController()
        preview.dataSource = context.coordinator
        preview.navigationItem.leftBarButtonItem = UIBarButtonItem(systemItem: .done, primaryAction: UIAction { _ in onDismiss() })
        return UINavigationController(rootViewController: preview)
    }
    func updateUIViewController(_ controller: UINavigationController, context: Context) {
        if context.coordinator.url != url {
            context.coordinator.url = url
            (controller.viewControllers.first as? QLPreviewController)?.reloadData()
        }
    }

    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        var url: URL
        init(url: URL) { self.url = url }
        func numberOfPreviewItems(in controller: QLPreviewController) -> Int { 1 }
        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem { url as NSURL }
    }
}

@MainActor @Observable
final class AttachmentImageLoader {
    var image: UIImage?
    var failed = false
    private var request = UUID()

    func load(fetch: () async throws -> Data) async {
        let current = UUID()
        request = current
        image = nil
        failed = false
        do {
            let data = try await fetch()
            try Task.checkCancellation()
            guard current == request else { return }
            image = UIImage(data: data)
            failed = image == nil
        } catch {
            guard !Task.isCancelled, current == request else { return }
            failed = true
        }
    }
}

struct ThumbnailView: View {
    let attachment: AttachmentOut
    @Bindable var controller: AppController
    /// A square tile of this side, the photo cropped to fill it (several photos in one message).
    var square: CGFloat? = nil
    /// The message's attachments: the viewer pages through its photos, opening on this one.
    var gallery: [AttachmentOut] = []
    @State private var loader = AttachmentImageLoader()
    @State private var attempt = 0
    @State private var viewing = false

    var body: some View {
        Group {
            if let image = loader.image, let square {
                Button { viewing = true } label: {
                    Image(uiImage: image).resizable().scaledToFill().frame(width: square, height: square).clipped()
                }
                .buttonStyle(.plain)
                .accessibilityLabel("写真 \(attachment.filename)")
            } else if let image = loader.image {
                Button { viewing = true } label: { Image(uiImage: image).resizable().scaledToFit() }
                    .buttonStyle(.plain)
                    .frame(maxWidth: 280, maxHeight: 240)
                    .accessibilityLabel("写真 \(attachment.filename)")
            } else if loader.failed, let square {
                Button { attempt += 1 } label: {
                    Image(systemName: "arrow.clockwise").foregroundStyle(.secondary)
                        .frame(width: square, height: square).background(Color.secondary.opacity(0.12))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(attachment.filename) を再読み込み")
            } else if loader.failed {
                VStack(alignment: .leading, spacing: 8) {
                    Text(attachment.filename).lineLimit(2)
                    Label("画像を読み込めませんでした", systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.secondary)
                    HStack {
                        Button("再試行") { attempt += 1 }
                        Spacer()
                        Button("元の画像を開く") { viewing = true }
                    }
                }
                .font(.footnote)
                .padding(12)
                .background(Color.secondary.opacity(0.12))
            } else {
                ZStack {
                    Color.secondary.opacity(0.12)
                    ProgressView()
                }
                .frame(width: square ?? 160, height: square ?? 120)
            }
        }
        .frame(maxWidth: square ?? 280, alignment: .leading)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .contentShape(RoundedRectangle(cornerRadius: 10))
        .task(id: "\(attachment.id):\(attempt)") {
            await loader.load {
                guard let api = controller.api else { throw URLError(.notConnectedToInternet) }
                return try await api.fetchData("/api/v1/attachments/\(attachment.id)/thumbnail")
            }
        }
        .fullScreenCover(isPresented: $viewing) {
            let pages = ImageGallery.pages(for: attachment, in: gallery)
            ImageViewer(attachments: pages.items, start: pages.start, controller: controller)
        }
    }
}

extension URL: @retroactive Identifiable {
    public var id: String { absoluteString }
}

struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]
    func makeUIViewController(context: Context) -> UIActivityViewController { UIActivityViewController(activityItems: items, applicationActivities: nil) }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

/// Uploads waiting in the composer, as Slack and Mattermost show them (testers, 2026-09-29): small square thumbnails
/// with a × to take one out; a tap previews it (a photo full screen, a video or document with Quick Look). They were
/// chips with the file name, and a tap took the file out. `uploading` adds a tile with a spinner meanwhile.
struct PendingAttachmentsView: View {
    let items: [AttachmentOut]
    var uploading = 0
    var controller: AppController? = nil
    let onRemove: (AttachmentOut) -> Void

    var body: some View {
        if !items.isEmpty || uploading > 0 {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    ForEach(items) { item in
                        PendingTile(item: item, gallery: items, controller: controller) { onRemove(item) }
                    }
                    if uploading > 0 {
                        ProgressView()
                            .frame(width: PendingTile.side, height: PendingTile.side)
                            .background(Color.secondary.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
                            .accessibilityLabel("アップロード中")
                    }
                }
                .padding(.horizontal, 12)
                .padding(.top, 10) // room for the × over the corner
            }
            .padding(.top, 4)
        }
    }
}

private struct PendingTile: View {
    static let side: CGFloat = 64
    let item: AttachmentOut
    /// The waiting uploads: the viewer pages through their photos.
    let gallery: [AttachmentOut]
    let controller: AppController?
    let onRemove: () -> Void
    @State private var thumbnail = AttachmentImageLoader()
    @State private var file = AttachmentFileLoader()
    @State private var viewing = false
    @State private var previewURL: URL?

    var body: some View {
        Button(action: open) { face }
            .buttonStyle(.plain)
            .accessibilityLabel("\(item.isImage ? "写真" : item.isVideo ? "動画" : "ファイル") \(item.filename) をプレビュー")
            .overlay(alignment: .topTrailing) {
                Button(action: onRemove) {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 20))
                        .symbolRenderingMode(.palette)
                        .foregroundStyle(.white, Color.black.opacity(0.7))
                }
                .buttonStyle(.plain)
                .offset(x: 7, y: -7)
                .accessibilityLabel("\(item.filename) を取り消す")
            }
            .task(id: item.id) {
                guard item.isImage, let controller else { return }
                await thumbnail.load {
                    guard let api = controller.api else { throw URLError(.notConnectedToInternet) }
                    return try await api.fetchData("/api/v1/attachments/\(item.id)/thumbnail")
                }
            }
            .fullScreenCover(isPresented: $viewing) {
                if let controller {
                    let pages = ImageGallery.pages(for: item, in: gallery)
                    ImageViewer(attachments: pages.items, start: pages.start, controller: controller)
                }
            }
            .sheet(item: $previewURL) { url in FilePreviewSheet(url: url, onDismiss: { previewURL = nil }) }
    }

    @ViewBuilder
    private var face: some View {
        ZStack {
            Color.secondary.opacity(0.12)
            if let image = thumbnail.image {
                Image(uiImage: image).resizable().scaledToFill()
            } else if item.isImage && !thumbnail.failed {
                ProgressView()
            } else {
                VStack(spacing: 3) {
                    Image(systemName: item.isVideo ? "film" : item.isImage ? "photo" : "doc").font(.title3)
                    Text(item.filename).font(.system(size: 9)).lineLimit(2).multilineTextAlignment(.center)
                }
                .foregroundStyle(.secondary)
                .padding(4)
            }
            if file.loading { ProgressView() }
        }
        .frame(width: Self.side, height: Self.side)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .contentShape(RoundedRectangle(cornerRadius: 10))
    }

    private func open() {
        guard let controller else { return }
        if item.isImage { viewing = true; return }
        Task {
            await file.load { await controller.downloadAttachment(item) }
            if let url = file.url, AttachmentPreview.canPreview(url) { previewURL = url }
        }
    }
}
