import SwiftUI

// docs/DRIVE.md §29, MOBILE_UI.md §21.6: 「ドライブに保存」 in the share sheet. The shared files go into a drive folder
// I can write to, through the same uploads as the app's (Share/DriveUploads.swift): cut into parts in the App Group,
// sent by a background URLSession, so closing the sheet does not stop them; the app finishes what is left.

/// The drive's shapes the picker reads (the app's Api/DriveModels.swift is not in the extension).
struct ShareDriveLocation: Decodable, Identifiable, Equatable {
    let id: String
    let kind: String
    let rootId: String
    let name: String
    var canWrite: Bool? = nil

    /// 研究室ドライブ / マイドライブ by kind in the sheet's language, a channel's drive by the channel's name.
    var title: String {
        switch kind {
        case "workspace": localized("研究室ドライブ")
        case "user": localized("マイドライブ")
        default: name
        }
    }

    var symbol: String { kind == "workspace" ? "building.2" : kind == "user" ? "person.crop.square" : "number" }
}

struct ShareDriveItem: Decodable, Identifiable, Equatable {
    let id: String
    let kind: String
    let name: String
    /// AL3 (docs/ALBUMS.md §12): an album folder (its mark in the list); only whether there is one is read.
    var album: AlbumMark? = nil

    struct AlbumMark: Decodable, Equatable {}

    var symbol: String { album != nil ? "photo.on.rectangle" : "folder" }
}

struct ShareDriveCrumb: Decodable, Equatable {
    let id: String
    let name: String
}

extension ShareApi {
    struct DriveLocations: Decodable { let locations: [ShareDriveLocation] }
    struct DriveChildren: Decodable {
        let folder: ShareDriveItem
        let path: [ShareDriveCrumb]
        let items: [ShareDriveItem]
        let nextCursor: String?
    }

    func driveLocations() async throws -> [ShareDriveLocation] {
        let out: DriveLocations = try await getJSON("/api/v1/drive/locations")
        return out.locations
    }

    /// マイドライブ, made on first use (idempotent).
    func myDrive() async throws -> ShareDriveLocation {
        let (data, status) = try await driveCall("POST", "/api/v1/drive/locations/resolve", json: ["kind": "me"])
        guard (200..<300).contains(status), let out = try? JSON.snakeDecoder.decode(ShareDriveLocation.self, from: data) else {
            throw Self.failure(status: status, data: data)
        }
        return out
    }

    func driveFolders(_ folderId: String, cursor: String?) async throws -> DriveChildren {
        var path = "/api/v1/drive/folders/\(folderId)/children?sort=name&order=asc&limit=100"
        if let cursor, let escaped = cursor.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) { path += "&cursor=\(escaped)" }
        return try await getJSON(path)
    }

    func makeDriveFolder(parentId: String, name: String) async throws -> ShareDriveItem {
        let (data, status) = try await driveCall("POST", "/api/v1/drive/folders",
                                                 json: ["parent_id": parentId, "name": name, "client_op_id": UUID().uuidString.lowercased()])
        guard (200..<300).contains(status), let out = try? JSON.snakeDecoder.decode(ShareDriveItem.self, from: data) else {
            throw Self.failure(status: status, data: data)
        }
        return out
    }
}

extension ShareModel {
    /// 保存: the files are cut into their parts (the copies the sheet made go), the batch is saved in the App Group,
    /// then its uploads start here; the sheet shows them until they are done (or is closed: they go on).
    func saveToDrive() async {
        guard canSave, let workspace, let target = driveTarget, let processor = DriveUploadProcessor.shared else { return }
        phase = .saving
        let batchId = UUID().uuidString.lowercased()
        let files = self.files
        let store = processor.store
        let jobs: [DriveUploadJob]? = await Task.detached(priority: .userInitiated) {
            var jobs: [DriveUploadJob] = []
            for file in files {
                let jobId = UUID().uuidString.lowercased()
                guard let cut = try? store.stage(file: file.url, batchId: batchId, jobId: jobId) else {
                    store.remove(batchId)
                    return nil
                }
                try? FileManager.default.removeItem(at: file.url)
                jobs.append(DriveUploadJob(id: jobId, clientUploadId: UUID().uuidString.lowercased(),
                                           name: file.filename.precomposedStringWithCanonicalMapping, contentType: file.contentType,
                                           size: cut.size, partsTotal: cut.parts, sha: cut.sha))
            }
            return jobs
        }.value
        // The sheet's own copies are no longer needed (the parts are in DriveUploads/).
        releaseStaging()
        guard let jobs else {
            phase = .failed(localized("ファイルを読み込めませんでした"))
            return
        }
        let batch = DriveUploadBatch(id: batchId, serverUrl: workspace.serverUrl, account: workspace.account,
                                     generation: generation(workspace), target: target, createdAt: Date(), jobs: jobs)
        do {
            try store.save(batch)
        } catch {
            store.remove(batchId)
            phase = .failed(localized("共有を保存できませんでした。空き容量を確かめてください"))
            return
        }
        driveBatchId = batchId
        driveBatch = batch
        driveObserver = await processor.observe { [weak self] batches, inflight in
            let mine = batches.first { $0.id == batchId }
            Task { @MainActor in self?.driveChanged(mine, inflight) }
        }
        await processor.add(batch)
    }

    func driveChanged(_ batch: DriveUploadBatch?, _ inflight: [String: Int64]) {
        guard let batch else { return }
        driveBatch = batch
        driveInflight = inflight
        guard phase == .saving, batch.isFinished else { return }
        phase = .saved
        if batch.jobs.allSatisfy({ $0.state == .done || $0.state == .skipped }) {
            Task {
                try? await Task.sleep(nanoseconds: 900_000_000)
                self.close()
            }
        }
    }

    func answerDrive(_ question: DriveUploadQuestion, _ choice: DriveConflictChoice, all: Bool) {
        Task { await DriveUploadProcessor.shared?.answer(batchId: question.batchId, jobId: question.jobId, choice: choice, all: all) }
    }

    /// 閉じる while the parts are still going up: they go on in the background and Taylis completes the files.
    func closeWhileSaving() {
        Task {
            if let id = driveBatchId { await DriveUploadProcessor.shared?.detach(id) }
            close()
        }
    }

    /// Bytes sent of a job (the parts the server has, and the ones on their way).
    func driveSent(_ job: DriveUploadJob) -> Int64 {
        guard job.state != .done else { return job.size }
        return min(job.size, job.sentBytes + (job.state == .uploading ? driveInflight[job.id] ?? 0 : 0))
    }

    static func driveStatus(_ job: DriveUploadJob, sent: Int64) -> String {
        switch job.state {
        case .queued: return localized("待機中")
        case .asking: return localized("同じ名前のファイルがあります")
        case .uploading: return "\(formatSize(sent)) / \(formatSize(job.size))"
        case .waiting: return job.error == "auth" ? localized("Taylis を開いてサインインしてください") : localized("接続を待っています")
        case .completing: return localized("サーバで仕上げています…")
        case .done: return localized("保存しました")
        case .skipped: return localized("スキップしました")
        case .cancelled: return localized("取りやめました")
        case .failed:
            let reason = job.error == "read_failed" ? localized("ファイルを読み込めませんでした")
                : job.error == "network" ? ErrorMessages.network : ErrorMessages.byCode[job.error ?? ""] ?? ErrorMessages.unknown
            return localized("保存できませんでした：\(reason)")
        }
    }
}

/// The drive part of the form: where the files go.
struct ShareDriveSection: View {
    @Bindable var model: ShareModel
    @State private var picking = false

    var body: some View {
        Section {
            Button { picking = true } label: {
                HStack {
                    Text("保存先").foregroundStyle(Color.primary)
                    Spacer()
                    if let target = model.driveTarget {
                        Text(target.label).foregroundStyle(.secondary).lineLimit(1).truncationMode(.head)
                    } else {
                        Text("選んでください").foregroundStyle(.secondary)
                    }
                    Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("share.driveTarget")
            .sheet(isPresented: $picking) {
                NavigationStack {
                    if let api = model.api {
                        ShareDriveLocationsView(api: api, selection: $model.driveTarget) { picking = false }
                    }
                }
            }
        } footer: {
            Text("同じ名前のファイルがあるときは、保存する前に聞きます。")
        }
    }
}

/// The drives I can write to: 研究室ドライブ, マイドライブ, my channels' drives.
struct ShareDriveLocationsView: View {
    let api: ShareApi
    @Binding var selection: DriveUploadTarget?
    let done: () -> Void
    @State private var locations: [ShareDriveLocation]?
    @State private var failure: String?
    @State private var mine: ShareDriveLocation?
    @State private var opening = false
    @State private var isGuest = false

    var body: some View {
        List {
            if let locations {
                let shared = locations.filter { $0.kind != "channel" }
                let channels = locations.filter { $0.kind == "channel" }
                Section {
                    ForEach(shared.filter { $0.kind == "workspace" }) { row($0) }
                    if let me = shared.first(where: { $0.kind == "user" }) ?? mine {
                        row(me)
                    } else if !isGuest {
                        Button { Task { await openMine() } } label: {
                            Label(localized("マイドライブ"), systemImage: "person.crop.square")
                        }
                        .disabled(opening)
                    }
                }
                if !channels.isEmpty {
                    Section("チャンネル") { ForEach(channels) { row($0) } }
                }
                if locations.isEmpty, isGuest {
                    Text("保存できるドライブがありません").foregroundStyle(.secondary)
                }
            } else if let failure {
                Text(failure).foregroundStyle(.secondary)
            } else {
                HStack { Spacer(); ProgressView(); Spacer() }
            }
        }
        .navigationTitle("保存先")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar { ToolbarItem(placement: .cancellationAction) { Button("キャンセル", action: done) } }
        .task { await load() }
    }

    private func row(_ location: ShareDriveLocation) -> some View {
        NavigationLink {
            ShareDriveFolderView(api: api, location: location, folderId: location.rootId, selection: $selection, done: done)
        } label: {
            Label(location.title, systemImage: location.symbol)
        }
    }

    private func load() async {
        do {
            async let list = api.driveLocations()
            async let me = api.me()
            isGuest = (try? await me)?.role == "guest"
            // Read-only drives (archived channels, announcement channels for members) take no upload: not listed.
            let all = try await list
            locations = all.filter { $0.canWrite != false }
            failure = nil
        } catch {
            failure = localized("ドライブを読み込めませんでした")
        }
    }

    private func openMine() async {
        opening = true
        defer { opening = false }
        mine = try? await api.myDrive()
    }
}

/// A folder of a drive: its folders (into each), 「ここに保存」 and 「新しいフォルダ」.
struct ShareDriveFolderView: View {
    let api: ShareApi
    let location: ShareDriveLocation
    let folderId: String
    @Binding var selection: DriveUploadTarget?
    let done: () -> Void
    @State private var folders: [ShareDriveItem]?
    @State private var path: [ShareDriveCrumb] = []
    @State private var cursor: String?
    @State private var failure: String?
    @State private var newFolder = false
    @State private var folderName = ""

    private var title: String {
        guard path.count > 1, let last = path.last else { return location.title }
        return last.name
    }

    /// 「研究室ドライブ › 論文」.
    private var label: String {
        ([location.title] + path.dropFirst().map(\.name)).joined(separator: " › ")
    }

    var body: some View {
        List {
            if let folders {
                if folders.isEmpty {
                    Text("フォルダはありません").foregroundStyle(.secondary)
                }
                ForEach(folders) { folder in
                    NavigationLink {
                        ShareDriveFolderView(api: api, location: location, folderId: folder.id, selection: $selection, done: done)
                    } label: {
                        Label(folder.name, systemImage: folder.symbol)
                    }
                }
                if cursor != nil {
                    Button("さらに表示") { Task { await load(more: true) } }
                }
            } else if let failure {
                Text(failure).foregroundStyle(.secondary)
            } else {
                HStack { Spacer(); ProgressView(); Spacer() }
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .safeAreaInset(edge: .bottom) {
            Button {
                selection = DriveUploadTarget(parentId: folderId, locationId: location.id, label: label)
                done()
            } label: {
                Text("ここに保存").frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent).tint(Color.taylisSolid)
            .padding()
            .background(.bar)
            .disabled(folders == nil && failure == nil)
            .accessibilityIdentifier("share.driveHere")
        }
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button { folderName = ""; newFolder = true } label: { Image(systemName: "folder.badge.plus") }
                    .accessibilityLabel("新しいフォルダ")
            }
        }
        .alert("新しいフォルダ", isPresented: $newFolder) {
            TextField("フォルダの名前", text: $folderName)
            Button("キャンセル", role: .cancel) {}
            Button("作成") { Task { await makeFolder() } }
        }
        .task { await load(more: false) }
    }

    private func load(more: Bool) async {
        do {
            let page = try await api.driveFolders(folderId, cursor: more ? cursor : nil)
            let found = page.items.filter { $0.kind == "folder" }
            folders = more ? (folders ?? []) + found : found
            path = page.path
            cursor = page.nextCursor
            failure = nil
        } catch {
            if folders == nil { failure = localized("フォルダを読み込めませんでした") }
        }
    }

    private func makeFolder() async {
        let name = folderName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return }
        do {
            let made = try await api.makeDriveFolder(parentId: folderId, name: name)
            folders = ((folders ?? []) + [made]).sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        } catch {
            failure = ShareModel.failureText(ShareProcessor.failure(error))
        }
    }
}

/// While the files go up (and after): each file's progress and state, and 閉じる（保存は続きます）.
struct ShareDriveSavingView: View {
    @Bindable var model: ShareModel

    var body: some View {
        VStack(spacing: 0) {
            List {
                if let batch = model.driveBatch {
                    Section {
                        ForEach(batch.jobs) { job in
                            let sent = model.driveSent(job)
                            VStack(alignment: .leading, spacing: 4) {
                                Text(job.name).lineLimit(1).truncationMode(.middle)
                                if job.state == .uploading || job.state == .completing, job.size > 0 {
                                    ProgressView(value: min(1, Double(sent) / Double(job.size)))
                                }
                                Text(ShareModel.driveStatus(job, sent: sent)).font(.caption)
                                    .foregroundStyle(job.state == .failed ? Color.red : .secondary)
                                    .monospacedDigit()
                            }
                        }
                    } header: {
                        Text(batch.target.label)
                    }
                } else {
                    HStack { Spacer(); ProgressView(); Spacer() }
                }
            }
            if model.phase == .saving {
                Button("閉じる（保存は続きます）") { model.closeWhileSaving() }
                    .buttonStyle(.bordered)
                    .padding()
                    .accessibilityIdentifier("share.driveCloseEarly")
            } else {
                Button("閉じる") { model.close() }
                    .buttonStyle(.borderedProminent).tint(Color.taylisSolid)
                    .padding()
                    .accessibilityIdentifier("share.driveClose")
            }
        }
        .sheet(item: Binding(get: { model.driveBatch.flatMap { DriveUploadQuestion.first(in: [$0]) } }, set: { _ in })) { question in
            DriveUploadQuestionView(question: question) { choice, all in model.answerDrive(question, choice, all: all) }
        }
    }
}
