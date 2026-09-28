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

func formatSize(_ bytes: Int64) -> String {
    if bytes >= 1_048_576 { return String(format: "%.1f MB", Double(bytes) / 1_048_576) }
    if bytes >= 1024 { return String(format: "%.0f KB", Double(bytes) / 1024) }
    return "\(bytes) B"
}

/// Images show their thumbnail; documents download with authentication before a local system preview.
struct AttachmentsView: View {
    let attachments: [AttachmentOut]
    @Bindable var controller: AppController

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(attachments) { attachment in
                if attachment.isImage {
                    ThumbnailView(attachment: attachment, controller: controller)
                } else {
                    HStack(spacing: 8) {
                        Image(systemName: "doc").foregroundStyle(.secondary)
                        VStack(alignment: .leading) {
                            Text(attachment.filename).font(.subheadline)
                            Text(formatSize(attachment.sizeBytes)).font(.caption).foregroundStyle(.secondary)
                        }
                        Spacer()
                        AttachmentFileButton(attachment: attachment) { await controller.downloadAttachment(attachment) }
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

/// Shared by conversation attachments and the Files list; no duplicate downloads while one is running.
struct AttachmentFileButton: View {
    let attachment: AttachmentOut
    let download: () async -> URL?
    @State private var loader = AttachmentFileLoader()
    @State private var attempt = 0
    @State private var previewURL: URL?
    @State private var shareURL: URL?

    var body: some View {
        VStack(spacing: 4) {
            if loader.loading {
                ProgressView().accessibilityLabel("\(attachment.filename) を読み込み中")
            } else {
                Button {
                    if let url = loader.url { open(url) } else { attempt += 1 }
                } label: {
                    Label(loader.failed ? "再試行" : "開く", systemImage: loader.failed ? "arrow.clockwise" : "doc.text.magnifyingglass")
                        .font(.footnote)
                }
                .accessibilityLabel("\(attachment.filename) を\(loader.failed ? "再試行" : "開く")")
                if let url = loader.url {
                    ShareLink(item: url) { Image(systemName: "square.and.arrow.up") }
                        .accessibilityLabel("\(attachment.filename) を共有")
                }
                if loader.failed { Text("読み込み失敗").font(.caption2).foregroundStyle(.secondary) }
            }
        }
        .buttonStyle(.borderless)
        .task(id: attempt) {
            guard attempt > 0 else { return }
            await loader.load(download: download)
            guard !Task.isCancelled, let url = loader.url else { return }
            open(url)
        }
        .sheet(item: $previewURL) { url in FilePreviewSheet(url: url, onDismiss: { previewURL = nil }) }
        .sheet(item: $shareURL) { url in ShareSheet(items: [url]) }
    }

    private func open(_ url: URL) {
        if AttachmentPreview.canPreview(url) { previewURL = url } else { shareURL = url }
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
    @State private var loader = AttachmentImageLoader()
    @State private var attempt = 0
    @State private var viewing = false

    var body: some View {
        Group {
            if let image = loader.image {
                Button { viewing = true } label: { Image(uiImage: image).resizable().scaledToFit() }
                    .buttonStyle(.plain)
                    .frame(maxWidth: 280, maxHeight: 240)
                    .accessibilityLabel("写真 \(attachment.filename)")
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
                .frame(width: 160, height: 120)
            }
        }
        .frame(maxWidth: 280, alignment: .leading)
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .contentShape(RoundedRectangle(cornerRadius: 10))
        .task(id: "\(attachment.id):\(attempt)") {
            await loader.load {
                guard let api = controller.api else { throw URLError(.notConnectedToInternet) }
                return try await api.fetchData("/api/v1/attachments/\(attachment.id)/thumbnail")
            }
        }
        .fullScreenCover(isPresented: $viewing) { ImageViewer(attachment: attachment, controller: controller) }
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

/// Chips for uploads waiting in the composer.
struct PendingAttachmentsView: View {
    let items: [AttachmentOut]
    let onRemove: (AttachmentOut) -> Void

    var body: some View {
        if !items.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(items) { item in
                        Button { onRemove(item) } label: {
                            HStack(spacing: 4) {
                                Image(systemName: item.isImage ? "photo" : "doc")
                                Text(item.filename).lineLimit(1)
                                Image(systemName: "xmark").font(.caption2.bold())
                            }
                            .font(.footnote)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 5)
                            .background(Color.accentColor.opacity(0.12), in: Capsule())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("\(item.filename) を取り消す")
                    }
                }
                .padding(.horizontal, 12)
            }
            .padding(.top, 8)
        }
    }
}
