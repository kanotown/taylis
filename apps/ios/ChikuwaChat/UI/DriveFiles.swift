import SwiftUI
import UIKit
import UniformTypeIdentifiers

/// M166 (docs/DRIVE.md §7.3, §26): drive files to this device. The bytes go straight to a file (URLSession's download
/// task writes as they come; a 5 GB file never sits in memory), from a download ticket's URL (§21.2: no bearer token
/// in it, each use checked again by the server) or a ZIP's one-shot ticket (§22). The file is kept in the app's caches
/// only while it is shared or saved; 「“ファイル”に保存」 copies it out.
enum DriveFiles {
    /// Caches/drive/<area>: `downloads` (one folder per transfer, removed when its sheet closes) and `view` (a photo's
    /// original for the viewer, per version: the same version is never fetched twice).
    static func directory(_ area: String) -> URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("drive", isDirectory: true).appendingPathComponent(area, isDirectory: true)
    }

    /// An absolute URL for a path the server answered (`/api/v1/drive/download/<token>`).
    static func absolute(_ path: String, base: URL) -> URL? { URL(string: path, relativeTo: base)?.absoluteURL }

    /// Streams `url` into `destination` (its folder made), reporting (received, expected) as it goes. Throws ApiError
    /// for an error answer (its JSON read from the small file the server sent) and CancellationError when cancelled.
    static func download(_ url: URL, to destination: URL, session: URLSession = .shared,
                         progress: @escaping @MainActor (Int64, Int64?) -> Void = { _, _ in }) async throws {
        try FileManager.default.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
        let box = TaskBox()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                let task = session.downloadTask(with: url) { temporary, response, error in
                    // The temporary file goes when this returns: moved (or read for the error) here.
                    if let error {
                        let cancelled = (error as? URLError)?.code == .cancelled
                        continuation.resume(throwing: cancelled ? CancellationError() : ApiError.network(error))
                        return
                    }
                    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                    guard let temporary else {
                        continuation.resume(throwing: ApiError.network(URLError(.cannotCreateFile)))
                        return
                    }
                    guard (200...299).contains(status) else {
                        struct Envelope: Decodable { struct Inner: Decodable { let code: String; let message: String }; let error: Inner }
                        let data = (try? Data(contentsOf: temporary)) ?? Data()
                        let envelope = try? JSON.plainDecoder.decode(Envelope.self, from: data.prefix(64 * 1024))
                        continuation.resume(throwing: ApiError.api(status: status, code: envelope?.error.code ?? "http_\(status)",
                                                                   message: envelope?.error.message ?? "Request failed"))
                        return
                    }
                    do {
                        try? FileManager.default.removeItem(at: destination)
                        try FileManager.default.moveItem(at: temporary, to: destination)
                        continuation.resume()
                    } catch {
                        continuation.resume(throwing: error)
                    }
                }
                box.observation = task.progress.observe(\.completedUnitCount) { progressObject, _ in
                    let received = progressObject.completedUnitCount, total = progressObject.totalUnitCount
                    Task { @MainActor in progress(received, total > 0 ? total : nil) }
                }
                box.task = task
                task.resume()
            }
        } onCancel: {
            box.task?.cancel()
        }
        box.observation?.invalidate()
    }

    /// Holds the running task for the cancellation handler (another thread).
    private final class TaskBox: @unchecked Sendable {
        var task: URLSessionDownloadTask?
        var observation: NSKeyValueObservation?
    }

    /// A photo's original for the viewer: from this device when this version was fetched already.
    @MainActor
    static func viewFile(_ item: DriveItemOut, controller: AppController) async -> URL? {
        guard let api = controller.api, let file = item.file else { return nil }
        let destination = directory("view").appendingPathComponent(file.versionId ?? file.attachmentId, isDirectory: true)
            .appendingPathComponent(DriveRules.fileName(item.name))
        if FileManager.default.fileExists(atPath: destination.path) { return destination }
        do {
            let ticket = try await api.driveDownloadTicket(item.id)
            guard let url = absolute(ticket.url, base: api.baseUrl) else { return nil }
            try await download(url, to: destination)
            return destination
        } catch {
            if !(error is CancellationError) { controller.error = controller.describe(error) }
            return nil
        }
    }
}

/// What to bring to this device: a file, or a folder as a ZIP; then shared (the share sheet: another app, AirDrop,
/// 「“ファイル”に保存」) or saved with the Files picker.
struct DriveDownloadRequest: Identifiable, Equatable {
    enum Then: Equatable { case share, saveToFiles }
    let id = UUID()
    let item: DriveItemOut
    var then: Then = .share

    var isZip: Bool { item.isFolder }
}

@MainActor
@Observable
final class DriveDownload {
    enum State: Equatable {
        case preparing, running, done(URL), failed(String), cancelled
    }

    private(set) var state: State = .preparing
    private(set) var received: Int64 = 0
    private(set) var expected: Int64?
    /// The file's name on this device (a folder's ZIP: the server's 「名前.zip」).
    private(set) var name: String
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var folder: URL?

    init(name: String) { self.name = name }

    var fraction: Double? {
        guard let expected, expected > 0 else { return nil }
        return min(1, Double(received) / Double(expected))
    }

    func start(_ request: DriveDownloadRequest, controller: AppController) {
        guard task == nil, let api = controller.api else {
            if controller.api == nil { state = .failed(ErrorMessages.network) }
            return
        }
        let folder = DriveFiles.directory("downloads").appendingPathComponent(UUID().uuidString, isDirectory: true)
        self.folder = folder
        expected = request.isZip ? nil : request.item.sizeBytes
        task = Task {
            do {
                let path: String
                if request.isZip {
                    let zip = try await api.driveZip([request.item.id])
                    name = DriveRules.fileName(zip.filename)
                    expected = zip.zipBytes
                    path = zip.url
                } else {
                    path = try await api.driveDownloadTicket(request.item.id).url
                }
                guard let url = DriveFiles.absolute(path, base: api.baseUrl) else { throw ApiError.network(URLError(.badURL)) }
                let destination = folder.appendingPathComponent(name)
                state = .running
                try await DriveFiles.download(url, to: destination) { [weak self] received, total in
                    guard let self, self.state == .running else { return }
                    self.received = received
                    if let total { self.expected = total }
                }
                state = .done(destination)
            } catch is CancellationError {
                state = .cancelled
            } catch {
                state = .failed(controller.describe(error))
            }
        }
    }

    func cancel() {
        task?.cancel()
        if case .done = state { return }
        state = .cancelled
    }

    /// The transfer's folder goes with its sheet (a copy saved to Files or another app stays there).
    func discard() {
        task?.cancel()
        if let folder { try? FileManager.default.removeItem(at: folder) }
    }
}

/// The transfer's sheet: the name, how far it is (bytes, a bar), 取りやめる; once on the device, 「共有・ほかのアプリで
/// 開く」 and 「“ファイル”に保存」 (the one asked for opens by itself).
struct DriveDownloadSheet: View {
    let request: DriveDownloadRequest
    @Bindable var controller: AppController
    @Environment(\.dismiss) private var dismiss
    @State private var download: DriveDownload
    @State private var sharing: URL?
    @State private var exporting: URL?
    @State private var offered = false

    init(request: DriveDownloadRequest, controller: AppController) {
        self.request = request
        _controller = Bindable(controller)
        let name = request.isZip ? DriveRules.fileName(request.item.name) + ".zip" : DriveRules.fileName(request.item.name)
        _download = State(initialValue: DriveDownload(name: name))
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 18) {
                Image(systemName: request.isZip ? "doc.zipper" : DriveRules.icon(request.item))
                    .font(.system(size: 40)).foregroundStyle(.secondary)
                    .padding(.top, 8)
                Text(download.name).font(.headline).fileNameLine(download.name)
                    .padding(.horizontal)
                status
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity)
            .padding()
            .navigationTitle(request.isZip ? tr("ZIP でダウンロード") : tr("ダウンロード"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(isFinished ? tr("閉じる") : tr("取りやめる")) {
                        download.cancel()
                        dismiss()
                    }
                }
            }
        }
        .presentationDetents([.medium])
        .interactiveDismissDisabled(isRunning)
        .task { download.start(request, controller: controller) }
        .onChange(of: download.state) { _, state in
            guard case .done(let url) = state, !offered else { return }
            offered = true
            if request.then == .saveToFiles { exporting = url } else { sharing = url }
        }
        .onDisappear { download.discard() }
        .sheet(item: $sharing) { url in ShareSheet(items: [url]) }
        .sheet(item: $exporting) { url in FileExporter(url: url) { exporting = nil } }
    }

    private var isRunning: Bool { download.state == .running || download.state == .preparing }
    private var isFinished: Bool { if case .done = download.state { true } else { false } }

    @ViewBuilder
    private var status: some View {
        switch download.state {
        case .preparing:
            ProgressView(request.isZip ? tr("ZIP を用意しています…") : tr("準備しています…"))
        case .running:
            VStack(spacing: 6) {
                if let fraction = download.fraction { ProgressView(value: fraction) } else { ProgressView() }
                Text(progressText).font(.footnote).foregroundStyle(.secondary).monospacedDigit()
            }
            .padding(.horizontal, 24)
            .accessibilityElement(children: .combine)
        case .done(let url):
            VStack(spacing: 10) {
                Label("ダウンロードしました", systemImage: "checkmark.circle").foregroundStyle(.secondary)
                Button { sharing = url } label: { Label("共有・ほかのアプリで開く", systemImage: "square.and.arrow.up").frame(maxWidth: .infinity) }
                    .buttonStyle(.borderedProminent).prominentTint()
                Button { exporting = url } label: { Label("“ファイル”に保存", systemImage: "folder").frame(maxWidth: .infinity) }
                    .buttonStyle(.bordered)
            }
            .padding(.horizontal, 24)
        case .failed(let message):
            VStack(spacing: 10) {
                Label(message, systemImage: "exclamationmark.triangle").foregroundStyle(.secondary).multilineTextAlignment(.center)
                Button("やり直す") {
                    download.discard()
                    download = DriveDownload(name: download.name)
                    offered = false
                    download.start(request, controller: controller)
                }
            }
            .padding(.horizontal, 24)
        case .cancelled:
            Text("取りやめました").foregroundStyle(.secondary)
        }
    }

    private var progressText: String {
        let received = driveSize(download.received)
        guard let expected = download.expected else { return received }
        return "\(received) / \(driveSize(expected))"
    }
}

/// The Files app's picker, saving a copy of the downloaded file where I choose.
struct FileExporter: UIViewControllerRepresentable {
    let url: URL
    let onDone: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onDone: onDone) }

    func makeUIViewController(context: Context) -> UIDocumentPickerViewController {
        let picker = UIDocumentPickerViewController(forExporting: [url], asCopy: true)
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ controller: UIDocumentPickerViewController, context: Context) {}

    final class Coordinator: NSObject, UIDocumentPickerDelegate {
        let onDone: () -> Void
        init(onDone: @escaping () -> Void) { self.onDone = onDone }
        func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) { onDone() }
        func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { onDone() }
    }
}

/// A drive file in the app's viewer: its folder's photos side by side, a video streamed from its ticket (Range: it
/// seeks without being downloaded), a document's server preview (PDF and Office).
struct DriveViewing: Identifiable {
    enum Kind {
        case images([AttachmentOut], start: Int, items: [String: DriveItemOut])
        case video(AttachmentOut, URL, poster: UIImage?)
        /// A PDF or an Office file (§27, §29): its preview, the PDF itself, or why there are no pages yet.
        case document(AttachmentOut, DriveItemOut)
    }

    let id = UUID()
    let kind: Kind

    /// What `item` opens in (nil: no viewer, its details instead); a photo pages through the photos of `siblings`.
    @MainActor
    static func of(_ item: DriveItemOut, siblings: [DriveItemOut] = [], controller: AppController) async -> DriveViewing? {
        guard let kind = DriveRules.viewer(item), let attachment = DriveRules.attachment(item) else { return nil }
        switch kind {
        case .image:
            let photos = (siblings.contains { $0.id == item.id } ? siblings : [item]).filter { DriveRules.viewer($0) == .image }
            let attachments = photos.compactMap(DriveRules.attachment)
            let items = Dictionary(photos.compactMap { photo in photo.file.map { ($0.attachmentId, photo) } }, uniquingKeysWith: { a, _ in a })
            return DriveViewing(kind: .images(attachments, start: attachments.firstIndex { $0.id == attachment.id } ?? 0, items: items))
        case .video:
            guard let api = controller.api else { return nil }
            do {
                let ticket = try await api.driveDownloadTicket(item.id)
                guard let url = DriveFiles.absolute(ticket.url, base: api.baseUrl) else { return nil }
                var poster: UIImage?
                if item.file?.hasPoster == true, let data = try? await api.fetchData("/api/v1/attachments/\(attachment.id)/thumbnail") {
                    poster = UIImage(data: data)
                }
                return DriveViewing(kind: .video(attachment, url, poster: poster))
            } catch {
                controller.error = controller.describe(error)
                return nil
            }
        case .document:
            return DriveViewing(kind: .document(attachment, item))
        }
    }
}

struct DriveViewerView: View {
    let viewing: DriveViewing
    @Bindable var controller: AppController

    var body: some View {
        switch viewing.kind {
        case .images(let attachments, let start, let items):
            ImageViewer(attachments: attachments, start: start, controller: controller) { attachment in
                guard let item = items[attachment.id] else { return nil }
                return await DriveFiles.viewFile(item, controller: controller)
            }
        case .video(let attachment, let url, let poster):
            // Streamed: the share button would hand out the ticket's URL, so the download is in the file's details.
            VideoViewer(attachment: attachment, url: url, poster: poster, shares: false)
        case .document(let attachment, let item):
            DocumentPDFViewer(attachment: attachment, controller: controller, driveItem: item)
        }
    }
}
