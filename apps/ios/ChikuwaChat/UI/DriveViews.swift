import SwiftUI

// M166 (docs/DRIVE.md §17.6, §26; MOBILE_UI.md §25): the drive on the phone — the drives, a folder (its path, sort,
// search, pages of 100, pull to refresh), a file's details, its preview in the app's viewers, and download to share or
// save. §29: uploads (photos, camera, files) and new folders where the drive can be written to (DriveUploadsView.swift).
// No rename, move or trash here (the phone stays read-mostly).

/// A drive link opened from a message: its sheet (MainView).
struct DriveLinkTarget: Identifiable, Equatable {
    let id: String
    /// CF3: 「ドライブで表示」 — a file opens on its folder, not its details.
    var inFolder = false
}

/// The listing's order, kept on this device (the desktop keeps its own).
enum DriveSortSetting {
    static let sortKey = "drive.sort"
    static let descendingKey = "drive.descending"
}

/// One folder's listing: a page of 100 at a time (the server's cursor), read again on a signal after 300 ms (several
/// events in a row read once), and what became of it (404: gone — no access any more, in the trash, moved away).
@MainActor
@Observable
final class DriveFolderModel {
    static var reloadDelay: Duration = .milliseconds(300)

    let folderId: String
    private(set) var folder: DriveItemOut?
    private(set) var path: [DriveCrumb] = []
    private(set) var items: [DriveItemOut]?
    private(set) var nextCursor: String?
    private(set) var failure: String?
    private(set) var gone = false
    private(set) var loadingMore = false
    var sort: DriveSort
    var descending: Bool

    @ObservationIgnored private let api: DriveApi?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var reloadTask: Task<Void, Never>?

    init(folderId: String, api: DriveApi?, sort: DriveSort = .name, descending: Bool = false) {
        self.folderId = folderId
        self.api = api
        self.sort = sort
        self.descending = descending
    }

    /// The first page again (a new order, a pull, a signal): what was shown stays until the answer comes.
    func load() async {
        guard let api else { return }
        generation += 1
        let current = generation
        do {
            let page = try await api.driveChildren(folderId: folderId, sort: sort, descending: descending, cursor: nil)
            guard current == generation else { return }
            folder = page.folder
            path = page.path
            items = page.items
            nextCursor = page.nextCursor
            failure = nil
            gone = false
        } catch {
            guard current == generation, !(error is CancellationError) else { return }
            if case ApiError.api(let status, _, _) = error, status == 404 {
                gone = true
                items = nil
            } else if items == nil {
                failure = ErrorMessages.text(for: error)
            }
        }
    }

    /// The next page, once (the bottom row came into view, or 「さらに表示」).
    func loadMore() async {
        guard let api, let cursor = nextCursor, !loadingMore else { return }
        loadingMore = true
        defer { loadingMore = false }
        let current = generation
        do {
            let page = try await api.driveChildren(folderId: folderId, sort: sort, descending: descending, cursor: cursor)
            guard current == generation else { return }
            let have = Set((items ?? []).map(\.id))
            items = (items ?? []) + page.items.filter { !have.contains($0.id) }
            nextCursor = page.nextCursor
        } catch {
            // The row stays at the bottom: scrolling to it (or the button) asks again.
        }
    }

    /// `drive.changed` named this folder, or the connection came back: read it again soon.
    func reloadSoon() {
        reloadTask?.cancel()
        reloadTask = Task { [weak self] in
            try? await Task.sleep(for: Self.reloadDelay)
            guard !Task.isCancelled else { return }
            await self?.load()
        }
    }

    /// The root of this folder's drive (to fall back to when the folder is gone), once the path is known.
    var rootId: String? { path.first?.id }
}

// MARK: the drives

/// 「ドライブ」 (the home tile): 研究室ドライブ, マイドライブ (made when first opened; not for guests) and the drives of my
/// channels; a search over all of them.
struct DriveLocationsView: View {
    static let selectionId = "drive"

    @Bindable var controller: AppController
    let onOpenFolder: (String) -> Void
    @State private var query = ""
    @State private var opening = false

    private var hub: DriveHub? { controller.drive }

    var body: some View {
        Group {
            if !query.trimmingCharacters(in: .whitespaces).isEmpty {
                DriveSearchList(controller: controller, query: query, locationId: nil, onOpenFolder: onOpenFolder)
            } else {
                list
            }
        }
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "すべてのドライブを検索")
        .navigationTitle("ドライブ")
        .navigationBarTitleDisplayMode(.inline)
        .task { if hub?.locations == nil { await hub?.loadLocations() } }
    }

    private var list: some View {
        let locations = DriveRules.ordered(hub?.locations ?? [])
        let shared = locations.filter { $0.kind != "channel" }
        let channels = locations.filter { $0.kind == "channel" }
        return List {
            Section {
                ForEach(shared.filter { $0.kind == "workspace" }) { row($0) }
                if let mine = shared.first(where: { $0.kind == "user" }) {
                    row(mine)
                } else if !controller.isGuest, hub?.locations != nil {
                    // Not made yet: the first open makes it (POST /drive/locations/resolve).
                    Button { openMyDrive() } label: {
                        DriveLocationLabel(title: tr("マイドライブ"), icon: "person.crop.square", detail: tr("自分だけのファイルを置く場所"))
                    }
                    .disabled(opening)
                }
            }
            if !channels.isEmpty {
                Section("チャンネル") {
                    ForEach(channels) { row($0) }
                }
            }
            if hub?.locations == nil {
                if let failure = hub?.locationsFailure {
                    ContentUnavailableView {
                        Label("ドライブを読み込めませんでした", systemImage: "exclamationmark.triangle")
                    } description: { Text(failure) } actions: {
                        Button("再試行") { Task { await hub?.loadLocations() } }
                    }
                } else {
                    ProgressView().frame(maxWidth: .infinity)
                }
            } else if locations.isEmpty && controller.isGuest {
                ContentUnavailableView("開けるドライブがありません", systemImage: "externaldrive",
                                       description: Text("チャンネルのドライブは、そのチャンネルの「ドライブ」タブから開けます。"))
            }
        }
        .refreshable { await hub?.loadLocations() }
    }

    private func row(_ location: DriveLocationOut) -> some View {
        Button { onOpenFolder(location.rootId) } label: {
            DriveLocationLabel(title: DriveRules.rootName(kind: location.kind, serverName: location.name),
                               icon: location.kind == "workspace" ? "building.2" : location.kind == "user" ? "person.crop.square" : "number",
                               detail: DriveRules.usage(location))
        }
    }

    private func openMyDrive() {
        opening = true
        Task {
            defer { opening = false }
            do {
                guard let mine = try await hub?.resolve(channelId: nil) else { return }
                onOpenFolder(mine.rootId)
            } catch {
                controller.error = controller.describe(error)
            }
        }
    }
}

private struct DriveLocationLabel: View {
    let title: String
    let icon: String
    let detail: String

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: icon).font(.title3).foregroundStyle(.secondary).frame(width: 28)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).foregroundStyle(Color.primary)
                Text(detail).font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
        }
        .contentShape(Rectangle())
    }
}

// MARK: a folder

/// A folder of a drive: its path (each step opens that folder), its order (名前・更新日時・大きさ, 昇順・降順, kept on this
/// device), a search of its drive, its items 100 at a time. A folder opens through `onOpenFolder` (the phone's stack
/// pushes it, or a sheet / a channel's tab shows it in place); a file opens in its viewer, or its details.
/// `embedded`: inside a conversation's tab or a sheet, where there is no navigation bar of its own (the order and the
/// search sit in the list).
struct DriveFolderView: View {
    @Bindable var controller: AppController
    let folderId: String
    var embedded = false
    let onOpenFolder: (String) -> Void
    @State private var model: DriveFolderModel
    @State private var query = ""
    @State private var viewing: DriveViewing?
    @State private var details: DriveItemOut?
    @State private var download: DriveDownloadRequest?
    @State private var opening: String?
    /// §29: the ＋ menu's choice (photos, camera, files, a new folder), the uploads sheet, whether this folder is the
    /// screen on top (only that one asks a name conflict's question).
    @State private var uploadAction: DriveUploadAction?
    @State private var showUploads = false
    @State private var onTop = false
    @AppStorage(DriveSortSetting.sortKey) private var sortRaw = DriveSort.name.rawValue
    @AppStorage(DriveSortSetting.descendingKey) private var descending = false

    init(controller: AppController, folderId: String, embedded: Bool = false, onOpenFolder: @escaping (String) -> Void) {
        _controller = Bindable(controller)
        self.folderId = folderId
        self.embedded = embedded
        self.onOpenFolder = onOpenFolder
        let defaults = UserDefaults.standard
        _model = State(initialValue: DriveFolderModel(
            folderId: folderId, api: controller.api,
            sort: DriveSort(rawValue: defaults.string(forKey: DriveSortSetting.sortKey) ?? "") ?? .name,
            descending: defaults.bool(forKey: DriveSortSetting.descendingKey)))
    }

    private var hub: DriveHub? { controller.drive }
    private var kind: String? { model.folder.flatMap { hub?.location($0.locationId)?.kind } }
    private var searching: Bool { !query.trimmingCharacters(in: .whitespaces).isEmpty }
    private var title: String {
        guard let folder = model.folder else { return tr("ドライブ") }
        return folder.parentId == nil ? DriveRules.rootName(kind: kind, serverName: folder.name) : ChannelFiles.name(folder)
    }

    /// Where an upload from here goes: this folder, when its drive can be written to (read-only drives show no upload).
    private var uploadTarget: DriveUploadTarget? {
        guard let folder = model.folder, hub?.location(folder.locationId)?.canWrite == true else { return nil }
        return DriveUploadTarget(parentId: folderId, locationId: folder.locationId,
                                 label: DriveRules.whereLabel(model.path, kind: kind).isEmpty ? title : DriveRules.whereLabel(model.path, kind: kind))
    }

    private var uploads: DriveUploadCenter { .shared }
    private var account: String? { controller.activeWorkspace?.account }

    @ViewBuilder
    private var actions: some View {
        HStack(spacing: 14) {
            if uploadTarget != nil { DriveUploadMenu(action: $uploadAction) }
            sortMenu
        }
    }

    var body: some View {
        content
            .modifier(DriveFolderChrome(embedded: embedded, title: title, query: $query, sortMenu: AnyView(actions)))
            .safeAreaInset(edge: .bottom, spacing: 0) {
                let totals = uploads.totals(account: account)
                if DriveUploadsBar.shows(totals, preparing: uploads.preparing) {
                    DriveUploadsBar(totals: totals, preparing: uploads.preparing) { showUploads = true }
                }
            }
            .modifier(DriveUploadActions(controller: controller, target: uploadTarget, action: $uploadAction,
                                         onFolderMade: { _ in model.reloadSoon() }))
            .sheet(isPresented: $showUploads) { DriveUploadsSheet(controller: controller) }
            .sheet(item: Binding(get: { onTop && !showUploads && !uploads.sheetOpen ? uploads.question(account: account) : nil },
                                 set: { _ in })) { question in
                DriveUploadQuestionView(question: question) { choice, all in uploads.answer(question, choice, all: all) }
            }
            .onAppear { onTop = true }
            .onDisappear { onTop = false }
            .onChange(of: uploads.doneCount(parentId: folderId)) { _, _ in model.reloadSoon() }
            .task { if model.items == nil { await model.load() } }
            .onChange(of: hub?.signal(folderId) ?? 0) { _, _ in model.reloadSoon() }
            .onChange(of: hub?.reconnects ?? 0) { _, _ in model.reloadSoon() }
            .onChange(of: model.gone) { _, gone in
                // No longer readable (left the channel, moved, trashed): its drive's top, as the desktop (§14).
                if gone, let root = model.rootId, root != folderId { onOpenFolder(root) }
            }
            .fullScreenCover(item: $viewing) { DriveViewerView(viewing: $0, controller: controller) }
            .sheet(item: $details) { item in
                DriveItemDetailsSheet(controller: controller, item: item, path: model.path, kind: kind, siblings: model.items ?? [])
            }
            .sheet(item: $download) { DriveDownloadSheet(request: $0, controller: controller) }
    }

    @ViewBuilder
    private var content: some View {
        if searching {
            VStack(spacing: 0) {
                if embedded { inlineSearch.padding(.horizontal, 16).padding(.vertical, 8) }
                DriveSearchList(controller: controller, query: query, locationId: model.folder?.locationId, onOpenFolder: onOpenFolder)
            }
        } else {
            list
        }
    }

    private var list: some View {
        List {
            if embedded {
                Section { inlineSearch }
            }
            if !model.path.isEmpty {
                DriveBreadcrumbs(crumbs: DriveRules.crumbs(model.path, kind: kind), current: folderId, embedded: embedded,
                                 onOpen: onOpenFolder, trailing: embedded ? AnyView(actions) : nil)
                    .listRowInsets(EdgeInsets(top: 4, leading: 12, bottom: 4, trailing: 12))
                    .listRowSeparator(.hidden)
            }
            if let items = model.items {
                if items.isEmpty {
                    ContentUnavailableView("このフォルダは空です", systemImage: "folder")
                        .listRowSeparator(.hidden)
                }
                ForEach(items) { item in
                    DriveItemRow(controller: controller, item: item, busy: opening == item.id, onOpen: { open(item) },
                                 onDetails: { details = item }, onDownload: { download = DriveDownloadRequest(item: item, then: $0) },
                                 link: item.isFolder && !embedded ? .drive(item.id) : nil)
                        .onAppear { if item.id == items.last?.id { Task { await model.loadMore() } } }
                }
                if model.nextCursor != nil {
                    Button { Task { await model.loadMore() } } label: {
                        HStack {
                            Text("さらに表示")
                            if model.loadingMore { Spacer(); ProgressView() }
                        }
                    }
                }
            } else if model.gone {
                ContentUnavailableView("フォルダを表示できません", systemImage: "folder.badge.questionmark",
                                       description: Text("見る権限が無くなったか、移動・削除されました。"))
                    .listRowSeparator(.hidden)
            } else if let failure = model.failure {
                ContentUnavailableView {
                    Label("フォルダを読み込めませんでした", systemImage: "exclamationmark.triangle")
                } description: { Text(failure) } actions: {
                    Button("再試行") { Task { await model.load() } }
                }
                .listRowSeparator(.hidden)
            } else {
                ProgressView().frame(maxWidth: .infinity).listRowSeparator(.hidden)
            }
        }
        .listStyle(.plain)
        .refreshable { await model.load() }
    }

    private var inlineSearch: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
            TextField("このドライブを検索", text: $query).submitLabel(.search)
            if !query.isEmpty {
                Button { query = "" } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }
                    .buttonStyle(.plain)
                    .accessibilityLabel("検索を消す")
            }
        }
    }

    private var sortMenu: some View {
        Menu {
            Picker("並べ替え", selection: Binding(get: { model.sort }, set: { setSort($0, descending: model.descending) })) {
                ForEach(DriveSort.allCases, id: \.self) { Text($0.title).tag($0) }
            }
            Picker("順序", selection: Binding(get: { model.descending }, set: { setSort(model.sort, descending: $0) })) {
                Text("昇順").tag(false)
                Text("降順").tag(true)
            }
        } label: {
            Image(systemName: "arrow.up.arrow.down")
        }
        .accessibilityLabel(tr("並べ替え：\(model.sort.title)"))
    }

    private func setSort(_ sort: DriveSort, descending: Bool) {
        guard sort != model.sort || descending != model.descending else { return }
        model.sort = sort
        model.descending = descending
        sortRaw = sort.rawValue
        self.descending = descending
        Task { await model.load() }
    }

    private func open(_ item: DriveItemOut) {
        if item.isFolder { return onOpenFolder(item.id) }
        guard DriveRules.viewer(item) != nil else {
            details = item
            return
        }
        opening = item.id
        Task {
            defer { opening = nil }
            viewing = await DriveViewing.of(item, siblings: model.items ?? [], controller: controller)
        }
    }
}

/// A folder screen of its own (the phone's stack): its name as the title, the order in the bar, the search field under
/// it. Embedded (a conversation's tab, a sheet) it leaves the screen's bar alone: the list has them.
private struct DriveFolderChrome: ViewModifier {
    let embedded: Bool
    let title: String
    @Binding var query: String
    let sortMenu: AnyView

    func body(content: Content) -> some View {
        if embedded {
            content
        } else {
            content
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .topBarTrailing) { sortMenu } }
                .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .automatic), prompt: Text("このドライブを検索"))
        }
    }
}

/// 「研究室ドライブ › 論文 › 2026年度」: every step opens its folder (the last is where I am). In a tab or a sheet a ‹
/// goes one folder up, as Back does on the phone's stack.
struct DriveBreadcrumbs: View {
    let crumbs: [DriveCrumb]
    let current: String
    var embedded = false
    let onOpen: (String) -> Void
    var trailing: AnyView? = nil

    var body: some View {
        HStack(spacing: 6) {
            if embedded, crumbs.count > 1 {
                Button { onOpen(crumbs[crumbs.count - 2].id) } label: {
                    Image(systemName: "chevron.left").font(.body.weight(.semibold)).frame(width: 32, height: 32).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(tr("\(crumbs[crumbs.count - 2].name) に戻る"))
            }
            ScrollViewReader { proxy in
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 4) {
                        ForEach(Array(crumbs.enumerated()), id: \.element.id) { index, crumb in
                            if index > 0 { Image(systemName: "chevron.compact.right").font(.caption).foregroundStyle(.tertiary) }
                            let last = crumb.id == current
                            Button { if !last { onOpen(crumb.id) } } label: {
                                Text(crumb.name).font(.footnote.weight(last ? .semibold : .regular))
                                    .foregroundStyle(last ? Color.primary : Color.secondary)
                                    .lineLimit(1)
                            }
                            .buttonStyle(.plain)
                            .id(crumb.id)
                        }
                    }
                    .padding(.vertical, 6)
                }
                // A deep folder: its own name in view.
                .onAppear { proxy.scrollTo(current, anchor: .trailing) }
            }
            if let trailing { trailing }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("フォルダの場所")
    }
}

/// A file or folder: its thumbnail (a photo, a video's poster, a document's first page) or icon, its name, when it
/// changed and its size; ⋯ for its details, download and share.
struct DriveItemRow: View {
    @Bindable var controller: AppController
    let item: DriveItemOut
    var busy = false
    var subtitle: String? = nil
    let onOpen: () -> Void
    let onDetails: () -> Void
    let onDownload: (DriveDownloadRequest.Then) -> Void
    /// A folder on a screen of its own: pushed as a navigation link (the iPad's split did not push a folder set on its
    /// path from a pushed folder screen; a link pushes on every stack).
    var link: MainRoute? = nil

    var body: some View {
        HStack(spacing: 12) {
            if let link {
                NavigationLink(value: link) { label }
                    .buttonStyle(.plain)
            } else {
                Button(action: onOpen) { label }
                    .buttonStyle(.plain)
            }
            Menu {
                DriveItemMenu(item: item, onDetails: onDetails, onDownload: onDownload)
            } label: {
                Image(systemName: "ellipsis").font(.body).foregroundStyle(.secondary).frame(width: 36, height: 36).contentShape(Rectangle())
            }
            .accessibilityLabel(tr("\(item.name) の操作"))
        }
        .contextMenu { DriveItemMenu(item: item, onDetails: onDetails, onDownload: onDownload) }
        .accessibilityAction(named: "詳細", onDetails)
    }

    private var label: some View {
        HStack(spacing: 12) {
            DriveThumbnail(controller: controller, item: item, side: 40)
            VStack(alignment: .leading, spacing: 2) {
                Text(ChannelFiles.name(item)).font(.body).foregroundStyle(Color.primary).fileNameLine(ChannelFiles.name(item))
                HStack(spacing: 4) {
                    // CF3 (docs/CHANNEL_FILES.md §12.2): attached to a message.
                    if item.isPosted {
                        Image(systemName: "bubble.left").font(.caption2).foregroundStyle(.secondary)
                            .accessibilityLabel(Text("メッセージに添付"))
                    }
                    Text(subtitle ?? DriveRules.rowDetail(item)).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            Spacer(minLength: 0)
            if busy { ProgressView() }
        }
        .contentShape(Rectangle())
    }
}

private struct DriveItemMenu: View {
    let item: DriveItemOut
    let onDetails: () -> Void
    let onDownload: (DriveDownloadRequest.Then) -> Void

    var body: some View {
        Button("詳細", systemImage: "info.circle", action: onDetails)
        if item.isFolder {
            Button("ZIP でダウンロード", systemImage: "doc.zipper") { onDownload(.share) }
        } else {
            Button("ダウンロードして共有", systemImage: "square.and.arrow.up") { onDownload(.share) }
            Button("“ファイル”に保存", systemImage: "folder") { onDownload(.saveToFiles) }
        }
    }
}

/// A row's or a card's picture: the server's thumbnail when there is one, else the kind's icon.
struct DriveThumbnail: View {
    @Bindable var controller: AppController
    let item: DriveItemOut
    let side: CGFloat
    @State private var loader = AttachmentImageLoader()

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 6).fill(Color(.secondarySystemBackground))
            if let image = loader.image {
                Image(uiImage: image).resizable().scaledToFill()
                if item.contentType?.hasPrefix("video/") == true {
                    Image(systemName: "play.circle.fill").font(.system(size: side * 0.4)).foregroundStyle(.white.opacity(0.9))
                }
            } else {
                Image(systemName: DriveRules.icon(item)).font(.system(size: side * 0.45)).foregroundStyle(item.isFolder ? Color.accentColor : .secondary)
                    .overlay(alignment: .bottomTrailing) {
                        // CF3 (§12.2): 「投稿のファイル」 is a folder with a speech bubble.
                        if item.isChannelPosts {
                            Image(systemName: "bubble.left.fill").font(.system(size: side * 0.24)).foregroundStyle(Color.accentColor)
                                .background(Circle().fill(Color(.secondarySystemBackground)).padding(-1.5))
                                .offset(x: side * 0.08, y: side * 0.06)
                        }
                    }
            }
        }
        .frame(width: side, height: side)
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .accessibilityHidden(true)
        .task(id: "\(item.id):\(item.file?.versionId ?? ""):\(item.file?.preview?.status ?? "")") {
            guard let path = DriveRules.thumbnailPath(item) else { return }
            await loader.load {
                guard let api = controller.api else { throw URLError(.notConnectedToInternet) }
                return try await api.fetchData(path)
            }
        }
    }
}

// MARK: search

/// File and folder names (PGroonga, Japanese and English parts of words, §12), in one drive or in all I can read; each
/// with where it is.
struct DriveSearchList: View {
    @Bindable var controller: AppController
    let query: String
    let locationId: String?
    let onOpenFolder: (String) -> Void
    @State private var hits: [DriveSearchHitOut]?
    @State private var cursor: String?
    @State private var failure: String?
    @State private var viewing: DriveViewing?
    @State private var details: DriveSearchHitOut?
    @State private var download: DriveDownloadRequest?
    /// CF3 (docs/CHANNEL_FILES.md §12.6): 「投稿のファイルを含む」 (origin all; off: uploads), kept on this device.
    @AppStorage("drive.search.includePosts") private var includePosts = true

    /// A server with channel files (CF1) knows `origin`.
    private var offersOrigin: Bool { controller.store.workspaceSettings.channelFilesToDrive != nil }

    var body: some View {
        List {
            if offersOrigin {
                Toggle("投稿のファイルを含む", isOn: $includePosts).font(.subheadline)
            }
            if let hits {
                if hits.isEmpty {
                    ContentUnavailableView.search(text: query).listRowSeparator(.hidden)
                }
                ForEach(hits, id: \.item.id) { hit in
                    VStack(alignment: .leading, spacing: 2) {
                        DriveItemRow(controller: controller, item: hit.item,
                                     subtitle: DriveRules.whereLabel(hit.path, kind: hit.locationKind),
                                     onOpen: { open(hit) }, onDetails: { details = hit },
                                     onDownload: { download = DriveDownloadRequest(item: hit.item, then: $0) })
                        // §29: the words around a match inside the file, under the name (past the 40 pt picture).
                        if let snippet = DriveSnippetLine.text(hit) {
                            Text(snippet).font(.caption).lineLimit(2).padding(.leading, 52)
                                .onTapGesture { open(hit) }
                        }
                    }
                }
                if cursor != nil {
                    Button("さらに表示") { Task { await load(more: true) } }
                }
            } else if let failure {
                Text(failure).foregroundStyle(.secondary)
            } else {
                ProgressView().frame(maxWidth: .infinity)
            }
        }
        .listStyle(.plain)
        .task(id: "\(locationId ?? "")|\(query)|\(includePosts)") {
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            await load(more: false)
        }
        .fullScreenCover(item: $viewing) { DriveViewerView(viewing: $0, controller: controller) }
        .sheet(item: Binding(get: { details.map { DriveSearchDetails(hit: $0) } }, set: { if $0 == nil { details = nil } })) { entry in
            DriveItemDetailsSheet(controller: controller, item: entry.hit.item, path: entry.hit.path, kind: entry.hit.locationKind,
                                  onShowFolder: { id in details = nil; onOpenFolder(id) })
        }
        .sheet(item: $download) { DriveDownloadSheet(request: $0, controller: controller) }
    }

    private func load(more: Bool) async {
        guard let api = controller.api else { return }
        let words = query.trimmingCharacters(in: .whitespaces)
        do {
            let page = try await api.searchDrive(query: words, locationId: locationId, cursor: more ? cursor : nil,
                                                  origin: offersOrigin && !includePosts ? "uploads" : "all")
            hits = more ? (hits ?? []) + page.items : page.items
            cursor = page.nextCursor
            failure = nil
        } catch {
            if !Task.isCancelled, hits == nil { failure = ErrorMessages.text(for: error) }
        }
    }

    private func open(_ hit: DriveSearchHitOut) {
        if hit.item.isFolder { return onOpenFolder(hit.item.id) }
        guard DriveRules.viewer(hit.item) != nil else {
            details = hit
            return
        }
        Task { viewing = await DriveViewing.of(hit.item, controller: controller) }
    }
}

/// A drive search hit's snippet (docs/DRIVE.md §29): 「中身 · 2 ページ目」 (§29.6: 「12 枚目」 for a slide, 「シート 2」
/// for a sheet), then the text with the found words in bold on a yellow tint. Plain text pieces from the server, never
/// markup.
enum DriveSnippetLine {
    static func pageLabel(_ hit: DriveSearchHitOut) -> String? {
        guard let page = hit.page else { return nil }
        switch hit.pageKind {
        case "slide": return tr("\(page) 枚目")
        case "sheet": return tr("シート \(page)")
        default: return tr("\(page) ページ目")
        }
    }

    static func text(_ hit: DriveSearchHitOut) -> AttributedString? {
        guard let parts = hit.snippet, !parts.isEmpty else { return nil }
        var label = AttributedString(tr("中身"))
        if let page = pageLabel(hit) { label += AttributedString(" · " + page) }
        label += AttributedString("  ")
        label.foregroundColor = .secondary
        var line = label
        for part in parts {
            var piece = AttributedString(part.text)
            if part.isHit {
                piece.font = .caption.bold()
                piece.backgroundColor = Color.yellow.opacity(0.35)
            }
            line += piece
        }
        return line
    }
}

private struct DriveSearchDetails: Identifiable {
    let hit: DriveSearchHitOut
    var id: String { hit.item.id }
}

// MARK: details

/// A file's or folder's details: its picture, name, kind, size, when it changed, who made and changed it, its versions
/// and where it is; open (the viewer), download to share or save, a folder as a ZIP; 「フォルダで表示」 where it was
/// opened from elsewhere (a search, a link).
struct DriveItemDetailsSheet: View {
    @Bindable var controller: AppController
    let item: DriveItemOut
    let path: [DriveCrumb]
    let kind: String?
    var siblings: [DriveItemOut] = []
    var onShowFolder: ((String) -> Void)? = nil
    @Environment(\.dismiss) private var dismiss
    @State private var viewing: DriveViewing?
    @State private var download: DriveDownloadRequest?
    @State private var opening = false

    var body: some View {
        NavigationStack {
            DriveItemDetailsList(controller: controller, item: item, path: path, kind: kind, opening: opening,
                                 onOpen: DriveRules.viewer(item) == nil ? nil : open,
                                 onDownload: { download = DriveDownloadRequest(item: item, then: $0) },
                                 onShowFolder: onShowFolder.map { show in { show(item.isFolder ? item.id : (item.parentId ?? item.id)) } })
                .navigationTitle("詳細")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("閉じる") { dismiss() } } }
        }
        .fullScreenCover(item: $viewing) { DriveViewerView(viewing: $0, controller: controller) }
        .sheet(item: $download) { DriveDownloadSheet(request: $0, controller: controller) }
    }

    private func open() {
        opening = true
        Task {
            defer { opening = false }
            viewing = await DriveViewing.of(item, siblings: siblings, controller: controller)
        }
    }
}

/// The details' list (also the file's own screen in a link's sheet).
struct DriveItemDetailsList: View {
    @Bindable var controller: AppController
    let item: DriveItemOut
    let path: [DriveCrumb]
    let kind: String?
    var opening = false
    let onOpen: (() -> Void)?
    let onDownload: (DriveDownloadRequest.Then) -> Void
    let onShowFolder: (() -> Void)?
    @Environment(\.dismiss) private var dismiss
    @State private var posts: [DrivePostOut]?

    var body: some View {
        let users = controller.store.users
        List {
            Section {
                HStack(spacing: 14) {
                    DriveThumbnail(controller: controller, item: item, side: 64)
                    VStack(alignment: .leading, spacing: 4) {
                        Text(ChannelFiles.name(item)).font(.headline).fileNameLine(ChannelFiles.name(item))
                        Text(item.isFolder ? tr("フォルダ") : driveSize(item.sizeBytes ?? 0)).font(.subheadline).foregroundStyle(.secondary)
                    }
                }
                .padding(.vertical, 4)
            }
            Section {
                if let onOpen {
                    Button(action: onOpen) {
                        HStack {
                            Label("プレビュー", systemImage: "eye")
                            if opening { Spacer(); ProgressView() }
                        }
                    }
                    .disabled(opening)
                }
                if item.isFolder {
                    Button { onDownload(.share) } label: { Label("ZIP でダウンロード", systemImage: "doc.zipper") }
                } else {
                    Button { onDownload(.share) } label: { Label("ダウンロードして共有", systemImage: "square.and.arrow.up") }
                    Button { onDownload(.saveToFiles) } label: { Label("“ファイル”に保存", systemImage: "folder") }
                }
                if let onShowFolder {
                    Button(action: onShowFolder) { Label(item.isFolder ? tr("フォルダを開く") : tr("フォルダで表示"), systemImage: "folder") }
                }
            }
            Section {
                if !item.isFolder {
                    LabeledContent("種類", value: item.contentType ?? "")
                    LabeledContent("大きさ", value: driveSize(item.sizeBytes ?? 0))
                }
                LabeledContent("更新日時", value: Timeline.fullLabel(item.shownDate))
                if let id = item.updatedBy { LabeledContent("更新した人", value: users[id]?.displayName ?? tr("だれか")) }
                if let id = item.createdBy { LabeledContent("作った人", value: users[id]?.displayName ?? tr("だれか")) }
                if !item.isFolder, item.versionCount > 1 { LabeledContent("バージョン", value: tr("\(item.versionCount) バージョン")) }
                if !path.isEmpty { LabeledContent("場所", value: DriveRules.whereLabel(path, kind: kind)) }
                if item.file?.preview?.isPending == true { LabeledContent("プレビュー", value: tr("作成中…")) }
            }
            // CF3 (docs/CHANNEL_FILES.md §12.2): the messages this file is attached to (that I can read), each with
            // 「メッセージを表示」.
            if let posts = posts ?? item.posts, !posts.isEmpty {
                Section("投稿") {
                    ForEach(posts, id: \.messageId) { post in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(ChannelFiles.postLine(post, sender: users[post.senderId]?.displayName ?? tr("だれか"),
                                                       channel: controller.store.channel(post.channelId)?.channel.name))
                                .font(.subheadline)
                            Button("メッセージを表示") {
                                dismiss()
                                Task { await controller.openPermalink(post.messageId) }
                            }
                            .font(.subheadline)
                            .buttonStyle(.borderless)
                        }
                    }
                }
            }
        }
        .task(id: item.id) {
            // Only GET /drive/items/{id} says which messages (a list's row does not).
            guard item.isPosted, item.posts == nil, case .item(let detail)? = await controller.drive?.resolveLink(item.id) else { return }
            posts = detail.item.posts
        }
    }
}

// MARK: in a sheet or a conversation's tab

/// A drive shown in place (a conversation's 「ドライブ」 tab, a link's sheet): one folder at a time, its path leading up.
struct DriveEmbeddedBrowser: View {
    @Bindable var controller: AppController
    @State var folderId: String
    /// In a conversation's tab: the folder is recorded for the other layout's view (LayoutCarry, MOBILE_UI.md §26).
    var channelId: String? = nil

    var body: some View {
        DriveFolderView(controller: controller, folderId: folderId, embedded: true, onOpenFolder: { folderId = $0 })
            .id(folderId)
            .onChange(of: folderId, initial: true) { _, folder in
                if let channelId { controller.layoutCarry.update(channelId) { $0.driveFolderId = folder } }
            }
    }
}

/// M166 (DRIVE.md §13.3): a public or private channel's 「ドライブ」 tab: its drive (made on first use, idempotent), read
/// only on the phone.
struct DriveChannelPane: View {
    @Bindable var controller: AppController
    let channel: ChannelState
    @State private var location: DriveLocationOut?
    @State private var failure: String?

    var body: some View {
        Group {
            if let location {
                // The folder this conversation's view (or the other layout's, LayoutCarry) had open, else the drive's top.
                DriveEmbeddedBrowser(controller: controller, folderId: controller.layoutCarry.current(channel.id)?.driveFolderId ?? location.rootId,
                                     channelId: channel.id)
            } else if let failure {
                ContentUnavailableView {
                    Label("ドライブを開けませんでした", systemImage: "externaldrive.badge.exclamationmark")
                } description: { Text(failure) } actions: {
                    Button("再試行") { Task { await resolve() } }
                }
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task(id: channel.id) { await resolve() }
    }

    private func resolve() async {
        failure = nil
        if let known = controller.drive?.locations?.first(where: { $0.channelId == channel.id }) {
            location = known
            return
        }
        do {
            guard let hub = controller.drive else { throw ApiError.network(URLError(.notConnectedToInternet)) }
            location = try await hub.resolve(channelId: channel.id)
        } catch {
            failure = ErrorMessages.text(for: error)
        }
    }
}

/// M166: a `/d/<id>` link tapped in a message: a folder opens in place; a file shows its details (its preview, when it
/// has one, opens from the card straight away instead); an item I cannot read says only 「表示できないファイル」.
struct DriveLinkSheet: View {
    @Bindable var controller: AppController
    let itemId: String
    /// CF3: 「ドライブで表示」 from a message: a file's folder at once.
    var inFolder = false
    @Environment(\.dismiss) private var dismiss
    @State private var state: DriveHub.LinkState?
    @State private var browsing: String?
    @State private var viewing: DriveViewing?
    @State private var download: DriveDownloadRequest?
    @State private var opening = false

    var body: some View {
        NavigationStack {
            Group {
                if let browsing {
                    DriveEmbeddedBrowser(controller: controller, folderId: browsing)
                } else {
                    switch state {
                    case .item(let detail)?:
                        DriveItemDetailsList(controller: controller, item: detail.item, path: detail.path, kind: detail.locationKind, opening: opening,
                                             onOpen: DriveRules.viewer(detail.item) == nil ? nil : { open(detail.item) },
                                             onDownload: { download = DriveDownloadRequest(item: detail.item, then: $0) },
                                             onShowFolder: { browsing = detail.item.parentId ?? detail.item.id })
                    case .unreadable?:
                        ContentUnavailableView("表示できないファイル", systemImage: "lock",
                                               description: Text("このファイルを見る権限が無いか、ゴミ箱に移されたか削除されました。"))
                    case .failed?:
                        ContentUnavailableView {
                            Label("ファイルを読み込めませんでした", systemImage: "exclamationmark.triangle")
                        } actions: {
                            Button("再試行") { Task { await load(force: true) } }
                        }
                    case nil:
                        ProgressView()
                    }
                }
            }
            .navigationTitle("ドライブ")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("閉じる") { dismiss() } } }
        }
        .task { await load(force: false) }
        .fullScreenCover(item: $viewing) { DriveViewerView(viewing: $0, controller: controller) }
        .sheet(item: $download) { DriveDownloadSheet(request: $0, controller: controller) }
    }

    private func load(force: Bool) async {
        guard let hub = controller.drive else { state = .failed; return }
        let found = await hub.resolveLink(itemId, force: force)
        state = found
        if case .item(let detail) = found, detail.item.isFolder { browsing = detail.item.id }
        if case .item(let detail) = found, inFolder, !detail.item.isFolder, let parent = detail.item.parentId { browsing = parent }
    }

    private func open(_ item: DriveItemOut) {
        opening = true
        Task {
            defer { opening = false }
            viewing = await DriveViewing.of(item, controller: controller)
        }
    }
}
