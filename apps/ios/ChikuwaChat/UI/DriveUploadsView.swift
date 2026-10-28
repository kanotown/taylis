import ImageIO
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

// docs/DRIVE.md §29, MOBILE_UI.md §25.4: uploads from the phone into a drive folder I can write to (photos, the camera,
// files) and new folders. The uploads themselves are Share/DriveUploads.swift (a background URLSession per batch, shared
// with the Share Extension); this file is the app's side: staging what was picked, the uploads bar and sheet, the
// name conflict question.

/// Something picked to upload.
enum DriveUploadSource {
    /// A file from the Files picker (security-scoped while it is read).
    case file(URL)
    /// A copy a picker made (a video, a photo's file): removed once staged.
    case temporary(URL, name: String)
    /// Bytes in memory (a photo re-encoded as JPEG, the camera's picture).
    case data(Data, name: String)
}

/// The app's view of the uploads: every batch on disk (the Share Extension's too), the bytes in flight, and the calls.
@MainActor
@Observable
final class DriveUploadCenter {
    static let shared = DriveUploadCenter(processor: .shared)

    private(set) var batches: [DriveUploadBatch] = []
    private(set) var inflight: [String: Int64] = [:]
    /// Picks being staged (a large video takes a moment to cut).
    private(set) var preparing = 0
    /// AL3 (docs/ALBUMS.md §12): photos picked for a folder that are not staged yet (a pick of hundreds goes in groups),
    /// by the folder: the album's band counts them (「312 枚中 120 枚」).
    private(set) var picked: [String: Int] = [:]
    /// The uploads sheet is open: the question is asked there (a view under a sheet cannot present).
    var sheetOpen = false
    @ObservationIgnored private let processor: DriveUploadProcessor?
    @ObservationIgnored private var observer: UUID?
    @ObservationIgnored private var started = false

    init(processor: DriveUploadProcessor?) {
        self.processor = processor
    }

    /// At start and back in front: the batches nobody drives go on (the extension's, the ones a restart left).
    func resume() async {
        guard let processor else { return }
        if !started {
            started = true
            processor.store.sweep()
            observer = await processor.observe { [weak self] batches, inflight in
                Task { @MainActor in
                    self?.batches = batches
                    self?.inflight = inflight
                }
            }
        }
        await processor.resumeAll()
    }

    func online() async { await processor?.online() }

    /// The rows of one account, newest batch first.
    func rows(account: String?) -> [DriveUploadRow] {
        guard let account else { return [] }
        return batches.filter { $0.account == account }.reversed().flatMap { batch in batch.jobs.map { DriveUploadRow(batch: batch, job: $0) } }
    }

    func question(account: String?) -> DriveUploadQuestion? {
        DriveUploadQuestion.first(in: batches.filter { $0.account == account })
    }

    /// Bytes sent of a job (its parts the server has, plus the ones on their way).
    func sent(_ job: DriveUploadJob) -> Int64 {
        guard job.state != .done else { return job.size }
        return min(job.size, job.sentBytes + (job.state == .uploading ? inflight[job.id] ?? 0 : 0))
    }

    /// Bumped when a job into `parentId` is done: the open folder reads itself again (drive.changed says so too).
    func doneCount(parentId: String) -> Int {
        batches.filter { $0.target.parentId == parentId }.reduce(0) { $0 + $1.jobs.filter { $0.state == .done }.count }
    }

    struct Totals: Equatable {
        var active = 0
        var done = 0
        var failed = 0
        var asking = 0
        var bytes: Int64 = 0
        var sent: Int64 = 0
    }

    func totals(account: String?) -> Totals {
        var totals = Totals()
        for row in rows(account: account) {
            switch row.job.state {
            case .done: totals.done += 1
            case .failed: totals.failed += 1
            case .asking: totals.asking += 1
            case .skipped, .cancelled: continue
            default: totals.active += 1
            }
            if row.job.state.isActive || row.job.state == .done {
                totals.bytes += row.job.size
                totals.sent += sent(row.job)
            }
        }
        return totals
    }

    /// AL3: `count` photos picked for `parentId` are on their way to being staged (negative: some were).
    func expect(_ count: Int, parentId: String) {
        let left = (picked[parentId] ?? 0) + count
        picked[parentId] = left > 0 ? left : nil
    }

    /// AL3: an album's band: its files done and all of them (the jobs into the folder, still listed, and the picks not
    /// staged yet); nil when nothing goes there now.
    func progress(parentId: String, account: String?) -> (done: Int, total: Int)? {
        let jobs = batches.filter { $0.account == account && $0.target.parentId == parentId }.flatMap(\.jobs)
            .filter { $0.state != .skipped && $0.state != .cancelled }
        let waiting = picked[parentId] ?? 0
        guard waiting > 0 || jobs.contains(where: { $0.state.isActive || $0.state == .asking }) else { return nil }
        return (jobs.filter { $0.state == .done }.count, jobs.count + waiting)
    }

    /// Stages the picks (each cut into its parts in the App Group) as one batch into `target`, then starts it. Returns
    /// a message for what could not be read. `onConflict` (AL3): an album keeps both on a name taken (`rename`, ALBUMS.md
    /// §9) instead of asking.
    func add(_ sources: [DriveUploadSource], to target: DriveUploadTarget, workspace: Workspace, onConflict: String = "fail") async -> String? {
        guard let processor, !sources.isEmpty else { return nil }
        preparing += sources.count
        defer { preparing -= sources.count }
        let store = processor.store
        let batchId = UUID().uuidString.lowercased()
        let staged: (jobs: [DriveUploadJob], unreadable: Int) = await Task.detached(priority: .userInitiated) {
            var jobs: [DriveUploadJob] = []
            var unreadable = 0
            for source in sources {
                let jobId = UUID().uuidString.lowercased()
                do {
                    jobs.append(try Self.stage(source, store: store, batchId: batchId, jobId: jobId, onConflict: onConflict))
                } catch {
                    store.removeParts(batchId, jobId)
                    unreadable += 1
                }
            }
            return (jobs, unreadable)
        }.value
        if !staged.jobs.isEmpty {
            let batch = DriveUploadBatch(id: batchId, serverUrl: workspace.serverUrl, account: workspace.account,
                                         generation: AccountSessions.shared.generation(account: workspace.account), target: target,
                                         createdAt: Date(), jobs: staged.jobs)
            do {
                try store.save(batch)
            } catch {
                store.remove(batchId)
                return tr("アップロードの準備ができませんでした。空き容量を確かめてください")
            }
            Task { await processor.add(batch) }
        }
        return staged.unreadable > 0 ? tr("読み込めなかったファイルがあります（\(staged.unreadable)件）") : nil
    }

    nonisolated private static func stage(_ source: DriveUploadSource, store: DriveUploadStore, batchId: String, jobId: String,
                                          onConflict: String) throws -> DriveUploadJob {
        let name: String
        let cut: (size: Int64, parts: Int, sha: [String])
        var modified: Int64?
        switch source {
        case .file(let url):
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            name = url.lastPathComponent
            if let date = try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate {
                modified = Int64(date.timeIntervalSince1970 * 1000)
            }
            cut = try store.stage(file: url, batchId: batchId, jobId: jobId)
        case .temporary(let url, let picked):
            defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
            name = picked
            cut = try store.stage(file: url, batchId: batchId, jobId: jobId)
        case .data(let data, let picked):
            name = picked
            cut = try store.stage(data: data, batchId: batchId, jobId: jobId)
        }
        let type = UTType(filenameExtension: (name as NSString).pathExtension)?.preferredMIMEType
        return DriveUploadJob(id: jobId, clientUploadId: UUID().uuidString.lowercased(), name: name.precomposedStringWithCanonicalMapping,
                              contentType: type, size: cut.size, modifiedMs: modified, onConflict: onConflict, partsTotal: cut.parts, sha: cut.sha)
    }

    func answer(_ question: DriveUploadQuestion, _ choice: DriveConflictChoice, all: Bool) {
        Task { await processor?.answer(batchId: question.batchId, jobId: question.jobId, choice: choice, all: all) }
    }

    func cancel(_ row: DriveUploadRow) { Task { await processor?.cancel(batchId: row.batch.id, jobId: row.job.id) } }
    func retry(_ row: DriveUploadRow) { Task { await processor?.retry(batchId: row.batch.id, jobId: row.job.id) } }
    func discard(_ row: DriveUploadRow) { Task { await processor?.discard(batchId: row.batch.id, jobId: row.job.id) } }
    func clearFinished(account: String) { Task { await processor?.clearFinished(account: account) } }
}

struct DriveUploadRow: Identifiable, Equatable {
    let batch: DriveUploadBatch
    let job: DriveUploadJob
    var id: String { job.id }
}

/// What a row says about its job (the panel's status line).
enum DriveUploadTexts {
    static func status(_ job: DriveUploadJob, sent: Int64) -> String {
        switch job.state {
        case .queued: return tr("待機中")
        case .asking: return tr("同じ名前のファイルがあります")
        case .uploading: return "\(driveSize(sent)) / \(driveSize(job.size))"
        case .waiting: return job.error == "auth" ? tr("サインインし直すと続けます") : tr("接続を待っています")
        case .completing: return tr("サーバで仕上げています…")
        case .done: return tr("完了")
        case .skipped: return tr("スキップしました")
        case .cancelled: return tr("取りやめました")
        case .failed: return tr("失敗：\(reason(job.error))")
        }
    }

    static func reason(_ code: String?) -> String {
        switch code {
        case "read_failed": return tr("ファイルを読み込めませんでした")
        case "network", nil: return ErrorMessages.network
        case let code?: return ErrorMessages.byCode[code] ?? ErrorMessages.unknown
        }
    }
}

// MARK: in a folder

/// The folder's upload actions and what they open: 「写真を選ぶ」 (the photo library, several), 「写真を撮る」 (the camera),
/// 「ファイルを選ぶ」 (the Files picker), 「新しいフォルダ」; only where the location can be written to.
struct DriveUploadActions: ViewModifier {
    @Bindable var controller: AppController
    let target: DriveUploadTarget?
    @Binding var action: DriveUploadAction?
    let onFolderMade: (DriveItemOut) -> Void
    /// AL3 (docs/ALBUMS.md §12): an album takes any number of photos at once (nil: no limit) and keeps both on a name
    /// taken.
    var maxPhotos: Int? = 50
    var onConflict = "fail"
    @State private var photoItems: [PhotosPickerItem] = []
    @State private var showPhotos = false
    @State private var showCamera = false
    @State private var showFiles = false
    @State private var newFolder = false
    @State private var folderName = ""
    @State private var making = false

    func body(content: Content) -> some View {
        content
            .onChange(of: action) { _, next in
                guard let next else { return }
                action = nil
                switch next {
                case .photos: showPhotos = true
                case .camera: showCamera = true
                case .files: showFiles = true
                case .folder:
                    folderName = ""
                    newFolder = true
                }
            }
            .photosPicker(isPresented: $showPhotos, selection: $photoItems, maxSelectionCount: maxPhotos, matching: .any(of: [.images, .videos]))
            .onChange(of: photoItems) { _, items in
                guard !items.isEmpty else { return }
                photoItems = []
                Task { await uploadPicked(items) }
            }
            .fullScreenCover(isPresented: $showCamera) {
                CameraPicker { image in
                    guard let data = image.normalizedUp().jpegData(compressionQuality: 0.9) else { return }
                    Task { await upload(([.data(data, name: DriveUploadRules.photoName())], 0)) }
                }
                .ignoresSafeArea()
            }
            .fileImporter(isPresented: $showFiles, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
                guard case .success(let urls) = result, !urls.isEmpty else { return }
                Task { await upload((urls.map(DriveUploadSource.file), 0)) }
            }
            .alert("新しいフォルダ", isPresented: $newFolder) {
                TextField("フォルダの名前", text: $folderName)
                Button("キャンセル", role: .cancel) {}
                Button("作成") { makeFolder() }
                    .disabled(folderName.trimmingCharacters(in: .whitespaces).isEmpty || making)
            }
    }

    /// AL3: the library's picks in groups of `DriveUploadRules.pickGroup`, each group staged (copied into the App Group)
    /// and started before the next is read: hundreds of photos never sit in memory, and the first ones go up at once.
    private func uploadPicked(_ items: [PhotosPickerItem]) async {
        guard let target else { return }
        let center = DriveUploadCenter.shared
        center.expect(items.count, parentId: target.parentId)
        var unreadable = 0
        var problem: String?
        for start in stride(from: 0, to: items.count, by: DriveUploadRules.pickGroup) {
            let group = Array(items[start..<min(items.count, start + DriveUploadRules.pickGroup)])
            let loaded = await Self.load(group)
            unreadable += loaded.unreadable
            if let workspace = controller.activeWorkspace {
                problem = await center.add(loaded.sources, to: target, workspace: workspace, onConflict: onConflict) ?? problem
            }
            center.expect(-group.count, parentId: target.parentId)
        }
        if unreadable > 0 {
            controller.error = tr("読み込めなかったファイルがあります（\(unreadable)件）")
        } else if let problem {
            controller.error = problem
        }
    }

    private func upload(_ picked: (sources: [DriveUploadSource], unreadable: Int)) async {
        guard let target, let workspace = controller.activeWorkspace else { return }
        let problem = await DriveUploadCenter.shared.add(picked.sources, to: target, workspace: workspace, onConflict: onConflict)
        if picked.unreadable > 0 {
            controller.error = tr("読み込めなかったファイルがあります（\(picked.unreadable)件）")
        } else if let problem {
            controller.error = problem
        }
    }

    /// The photo library's picks: videos as their files, photos as files too (AL3: never all in memory) and re-encoded
    /// as JPEG when the server would keep no thumbnail of them (HEIC, as the composer does) with their metadata kept
    /// (the capture time orders an album, ALBUMS.md §4.2; the location stays inside the lab, §7), under their own names
    /// (IMG_1234.jpg).
    static func load(_ items: [PhotosPickerItem]) async -> (sources: [DriveUploadSource], unreadable: Int) {
        var sources: [DriveUploadSource] = []
        var unreadable = 0
        for item in items {
            if item.supportedContentTypes.contains(where: { $0.conforms(to: .movie) }) {
                if let movie = try? await item.loadTransferable(type: PickedMovie.self) {
                    sources.append(.temporary(movie.url, name: movie.url.lastPathComponent))
                } else {
                    unreadable += 1
                }
                continue
            }
            let picked = try? await item.loadTransferable(type: PickedPhotoFile.self)
            if let picked, let file = await Task.detached(priority: .userInitiated, operation: { PhotoTranscode.uploadable(picked.url) }).value {
                sources.append(.temporary(file.url, name: file.name))
                continue
            }
            var data = picked.flatMap { try? Data(contentsOf: $0.url) }
            if data == nil { data = (try? await item.loadTransferable(type: Data.self)) ?? nil }
            if let picked { try? FileManager.default.removeItem(at: picked.url.deletingLastPathComponent()) }
            guard let data, let photo = ImageUpload.prepare(data) else {
                unreadable += 1
                continue
            }
            let base = picked.map { ($0.url.lastPathComponent as NSString).deletingPathExtension } ?? ""
            let name = base.isEmpty ? DriveUploadRules.photoName(ext: photo.ext) : base + "." + photo.ext
            sources.append(.data(photo.data, name: name))
        }
        return (sources, unreadable)
    }

    private func makeFolder() {
        let name = folderName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let target, let api = controller.api, !name.isEmpty else { return }
        making = true
        Task {
            defer { making = false }
            do {
                let folder = try await api.createDriveFolder(parentId: target.parentId, name: name, clientOpId: UUID().uuidString.lowercased())
                onFolderMade(folder)
            } catch {
                controller.error = controller.describe(error)
            }
        }
    }
}

enum DriveUploadAction: Equatable {
    case photos, camera, files, folder
}

/// A photo's file from the library, to learn its name (IMG_1234.HEIC); its bytes are read and re-encoded when needed.
struct PickedPhotoFile: Transferable {
    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(contentType: .image) { SentTransferredFile($0.url) } importing: { received in
            let dir = FileManager.default.temporaryDirectory.appendingPathComponent("picked-photos/\(UUID().uuidString)", isDirectory: true)
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let name = received.file.lastPathComponent.isEmpty ? "photo" : received.file.lastPathComponent
            let copy = dir.appendingPathComponent(name)
            try FileManager.default.copyItem(at: received.file, to: copy)
            return PickedPhotoFile(url: copy)
        }
    }
}

/// The ＋ menu of a folder I can write to.
struct DriveUploadMenu: View {
    @Binding var action: DriveUploadAction?
    /// AL3: an album's ＋ has no 「新しいフォルダ」; a folder's offers 「新しいアルバム」 when `onNewAlbum` is set.
    var includesFolder = true
    var onNewAlbum: (() -> Void)? = nil

    var body: some View {
        Menu {
            Button("写真を選ぶ", systemImage: "photo.on.rectangle") { action = .photos }
            if UIImagePickerController.isSourceTypeAvailable(.camera) {
                Button("写真を撮る", systemImage: "camera") { action = .camera }
            }
            Button("ファイルを選ぶ", systemImage: "doc") { action = .files }
            if includesFolder || onNewAlbum != nil { Divider() }
            if includesFolder {
                Button("新しいフォルダ", systemImage: "folder.badge.plus") { action = .folder }
            }
            if let onNewAlbum {
                Button("新しいアルバム", systemImage: "rectangle.stack.badge.plus", action: onNewAlbum)
            }
        } label: {
            Image(systemName: "plus")
        }
        .accessibilityLabel("アップロード")
        .accessibilityIdentifier("drive.upload")
    }
}

/// Under a folder's list while there are uploads: how many and how far; tapping it opens the uploads.
struct DriveUploadsBar: View {
    let totals: DriveUploadCenter.Totals
    let preparing: Int
    /// AL3: in an album, its own files: 「312 枚中 120 枚をアップロードしました」.
    var album: (done: Int, total: Int)? = nil
    let open: () -> Void

    var body: some View {
        Button(action: open) {
            HStack(spacing: 10) {
                Image(systemName: icon).foregroundStyle(totals.failed > 0 && totals.active == 0 ? Color.orange : Color.accentColor)
                VStack(alignment: .leading, spacing: 4) {
                    Text(title).font(.subheadline.weight(.medium)).foregroundStyle(Color.primary)
                    if totals.active > 0, totals.bytes > 0 {
                        ProgressView(value: min(1, Double(totals.sent) / Double(totals.bytes)))
                    }
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.up").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(.bar)
        .overlay(alignment: .top) { Divider() }
        .accessibilityIdentifier("drive.uploads.bar")
    }

    private var icon: String {
        if totals.active > 0 || preparing > 0 { return "arrow.up.circle" }
        if totals.failed > 0 || totals.asking > 0 { return "exclamationmark.circle" }
        return "checkmark.circle"
    }

    private var title: String {
        if let album { return tr("\(album.total) 枚中 \(album.done) 枚をアップロードしました") }
        if preparing > 0, totals.active == 0 { return tr("アップロードの準備をしています…") }
        if totals.asking > 0 { return tr("確認が必要なアップロードがあります") }
        if totals.active > 0 {
            return tr("\(totals.active) 件をアップロード中 · \(driveSize(totals.sent)) / \(driveSize(totals.bytes))")
        }
        if totals.failed > 0 { return tr("\(totals.failed) 件のアップロードが失敗しました") }
        return tr("\(totals.done) 件をアップロードしました")
    }

    static func shows(_ totals: DriveUploadCenter.Totals, preparing: Int) -> Bool {
        preparing > 0 || totals.active > 0 || totals.done > 0 || totals.failed > 0 || totals.asking > 0
    }
}

/// Every upload of this account: name, where it goes, how far, and 取りやめる / 再試行 / 取り除く; the question.
struct DriveUploadsSheet: View {
    @Bindable var controller: AppController
    @Environment(\.dismiss) private var dismiss
    private var center: DriveUploadCenter { .shared }
    private var account: String? { controller.activeWorkspace?.account }

    var body: some View {
        NavigationStack {
            List {
                let rows = center.rows(account: account)
                if rows.isEmpty {
                    ContentUnavailableView("アップロードはありません", systemImage: "arrow.up.circle")
                        .listRowSeparator(.hidden)
                }
                ForEach(rows) { row in
                    DriveUploadRowView(row: row, sent: center.sent(row.job))
                        .swipeActions {
                            if row.job.state.isFinished || row.job.state == .asking {
                                Button("取り除く", role: .destructive) { center.discard(row) }
                            }
                        }
                        .contextMenu { menu(row) }
                }
            }
            .listStyle(.plain)
            .navigationTitle("アップロード")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("閉じる") { dismiss() } }
                ToolbarItem(placement: .bottomBar) {
                    Button("完了したものを消す") { if let account { center.clearFinished(account: account) } }
                        .disabled(!center.rows(account: account).contains { [.done, .skipped, .cancelled].contains($0.job.state) })
                }
            }
        }
        .onAppear { center.sheetOpen = true }
        .onDisappear { center.sheetOpen = false }
        .sheet(item: Binding(get: { center.question(account: account) }, set: { _ in })) { question in
            DriveUploadQuestionView(question: question) { choice, all in center.answer(question, choice, all: all) }
        }
    }

    @ViewBuilder
    private func menu(_ row: DriveUploadRow) -> some View {
        if row.job.state.isActive || row.job.state == .asking {
            Button("取りやめる", systemImage: "xmark", role: .destructive) { center.cancel(row) }
        }
        if row.job.state == .failed || row.job.state == .waiting {
            Button("再試行", systemImage: "arrow.clockwise") { center.retry(row) }
        }
        if row.job.state.isFinished || row.job.state == .asking {
            Button("取り除く", systemImage: "trash") { center.discard(row) }
        }
    }
}

private struct DriveUploadRowView: View {
    let row: DriveUploadRow
    let sent: Int64
    private var center: DriveUploadCenter { .shared }

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: icon).font(.title3).foregroundStyle(tint).frame(width: 28)
            VStack(alignment: .leading, spacing: 3) {
                Text(row.job.name).fileNameLine(row.job.name)
                Text(row.batch.target.label).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                if row.job.state == .uploading || row.job.state == .completing, row.job.size > 0 {
                    ProgressView(value: min(1, Double(sent) / Double(row.job.size)))
                }
                Text(DriveUploadTexts.status(row.job, sent: sent)).font(.caption).foregroundStyle(row.job.state == .failed ? Color.red : .secondary)
                    .monospacedDigit()
            }
            Spacer(minLength: 0)
            if row.job.state.isActive || row.job.state == .asking {
                Button { center.cancel(row) } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }
                    .buttonStyle(.plain)
                    .accessibilityLabel(tr("\(row.job.name) のアップロードを取りやめる"))
            } else if row.job.state == .failed {
                Button { center.retry(row) } label: { Image(systemName: "arrow.clockwise.circle.fill").foregroundStyle(Color.accentColor) }
                    .buttonStyle(.plain)
                    .accessibilityLabel(tr("\(row.job.name) をもう一度アップロード"))
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .contain)
    }

    private var icon: String {
        switch row.job.state {
        case .done: "checkmark.circle"
        case .failed: "exclamationmark.triangle"
        case .asking: "questionmark.circle"
        case .skipped, .cancelled: "minus.circle"
        default: "arrow.up.circle"
        }
    }

    private var tint: Color {
        switch row.job.state {
        case .done: .green
        case .failed, .asking: .orange
        case .skipped, .cancelled: .secondary
        default: .accentColor
        }
    }
}

/// AL3 (docs/ALBUMS.md §6.3, §12): a photo picked for the drive, made ready as a file. A JPEG, PNG, GIF or WebP goes as
/// it is (its EXIF kept, as before); any other image (HEIC) becomes a JPEG beside it through ImageIO with its metadata
/// copied (the capture time orders an album, the location stays inside the lab, the orientation tag is applied by the
/// server's thumbnails). Never decoded into a UIImage here: one photo at a time on disk, not in memory.
enum PhotoTranscode {
    static let quality = 0.9

    /// The file to stage and its name; nil when it is no image ImageIO can read (the caller falls back to the bytes).
    static func uploadable(_ url: URL) -> (url: URL, name: String)? {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
        let head = (try? handle.read(upToCount: 12)) ?? Data()
        try? handle.close()
        let base = (url.lastPathComponent as NSString).deletingPathExtension
        let stem = base.isEmpty ? "photo" : base
        if let kind = ImageUpload.kind(of: head) { return (url, stem + "." + kind.ext) }
        let jpeg = url.deletingLastPathComponent().appendingPathComponent(stem + ".jpg")
        guard jpegCopy(of: url, to: jpeg) else { return nil }
        try? FileManager.default.removeItem(at: url)
        return (jpeg, jpeg.lastPathComponent)
    }

    /// The first image of `source` as a JPEG at `destination`, its properties (EXIF, GPS, TIFF, orientation) kept.
    static func jpegCopy(of source: URL, to destination: URL) -> Bool {
        guard let image = CGImageSourceCreateWithURL(source as CFURL, nil), CGImageSourceGetCount(image) > 0,
              let out = CGImageDestinationCreateWithURL(destination as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else { return false }
        let options: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: quality]
        CGImageDestinationAddImageFromSource(out, image, 0, options as CFDictionary)
        return CGImageDestinationFinalize(out)
    }
}
