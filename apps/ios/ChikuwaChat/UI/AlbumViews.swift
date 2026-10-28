import ImageIO
import SwiftUI
import UIKit

// AL3 (docs/ALBUMS.md §10, §12, §18.4; MOBILE_UI.md §25.7): photo albums on the phone. The drives' list starts with the
// albums I can read (covers in a row), an album folder opens as a grid of square thumbnails by capture day (3 columns
// on a phone, more on an iPad), its photos open in the photo viewer at their display size, and a slideshow keeps the
// screen on. Photos are added with the drive's background uploads, from a message's long press, or a new album made.

// MARK: thumbnails

/// The grid's thumbnails (512 px from the server), downsampled to the cell and kept while there is room: scrolling
/// back shows them without asking again, and the heap stays bounded however long the album.
@MainActor
final class AlbumThumbnails {
    static let shared = AlbumThumbnails()

    private let cache: NSCache<NSString, UIImage> = {
        let cache = NSCache<NSString, UIImage>()
        cache.totalCostLimit = 48 * 1024 * 1024
        return cache
    }()
    private var running: [String: Task<UIImage?, Never>] = [:]

    func image(_ attachmentId: String) -> UIImage? { cache.object(forKey: attachmentId as NSString) }

    func load(_ attachmentId: String, pixels: CGFloat, controller: AppController) async -> UIImage? {
        if let known = image(attachmentId) { return known }
        if let task = running[attachmentId] { return await task.value }
        guard let api = controller.api else { return nil }
        let task = Task { () -> UIImage? in
            guard let data = try? await api.fetchData("/api/v1/attachments/\(attachmentId)/thumbnail") else { return nil }
            return await Task.detached(priority: .utility) { Self.downsample(data, pixels: pixels) }.value
        }
        running[attachmentId] = task
        let image = await task.value
        running[attachmentId] = nil
        if let image {
            cache.setObject(image, forKey: attachmentId as NSString, cost: Int(image.size.width * image.size.height * image.scale * image.scale * 4))
        }
        return image
    }

    nonisolated static func downsample(_ data: Data, pixels: CGFloat) -> UIImage? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: max(64, pixels),
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        return UIImage(cgImage: image)
    }
}

/// A square picture: the thumbnail of `attachmentId` cropped to fill, else `icon` on the grey.
struct AlbumThumb: View {
    @Bindable var controller: AppController
    let attachmentId: String?
    var icon = "photo"
    var pixels: CGFloat = 360
    @State private var image: UIImage?

    var body: some View {
        Color(.secondarySystemBackground)
            .overlay {
                if let image {
                    Image(uiImage: image).resizable().scaledToFill()
                } else {
                    Image(systemName: icon).foregroundStyle(.secondary)
                }
            }
            .clipped()
            .task(id: attachmentId) {
                guard let attachmentId else { image = nil; return }
                image = AlbumThumbnails.shared.image(attachmentId)
                if image == nil { image = await AlbumThumbnails.shared.load(attachmentId, pixels: pixels, controller: controller) }
            }
    }
}

// MARK: models

/// One album: its head (folder, album, path, whether I may add, counts) and its photos and videos a page at a time,
/// read again on `drive.changed` for the folder (300 ms after the last), on a reconnect, and when its uploads finish.
@MainActor
@Observable
final class AlbumModel {
    enum Gone: Equatable {
        /// The folder is no album any more (「アルバムをやめる」 elsewhere): shown as a folder.
        case notAlbum
        /// No access any more, in the trash, gone.
        case gone
    }

    static var reloadDelay: Duration = .milliseconds(300)

    let folderId: String
    private(set) var detail: AlbumDetailOut?
    private(set) var items: [DriveItemOut]?
    private(set) var nextCursor: String?
    private(set) var failure: String?
    private(set) var gone: Gone?
    private(set) var loadingMore = false
    /// nil: the album's own order.
    var sort: AlbumSort?
    var descending: Bool?

    @ObservationIgnored private let api: AlbumApi?
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var reloadTask: Task<Void, Never>?

    init(folderId: String, api: AlbumApi?) {
        self.folderId = folderId
        self.api = api
    }

    var shownSort: AlbumSort { sort ?? detail.flatMap { AlbumSort(rawValue: $0.album.sort) } ?? .taken }
    var shownDescending: Bool { descending ?? (detail?.album.sortOrder == "desc") }

    /// The first pages again, as many as were shown (a reload does not drop what was scrolled to).
    func load() async {
        guard let api else { return }
        generation += 1
        let current = generation
        let had = items?.count ?? 0
        do {
            var page = try await api.album(folderId, sort: sort, descending: descending, cursor: nil)
            var all = page.items
            while all.count < had, let cursor = page.nextCursor {
                page = try await api.album(folderId, sort: sort, descending: descending, cursor: cursor)
                all += page.items
            }
            guard current == generation else { return }
            detail = page
            items = all
            nextCursor = page.nextCursor
            failure = nil
            gone = nil
        } catch {
            guard current == generation, !(error is CancellationError) else { return }
            if case ApiError.api(let status, let code, _) = error, status == 404 {
                gone = code == "drive_album_not_found" ? .notAlbum : .gone
                if gone == .gone { items = nil }
            } else if items == nil {
                failure = ErrorMessages.text(for: error)
            }
        }
    }

    func loadMore() async {
        guard let api, let cursor = nextCursor, !loadingMore else { return }
        loadingMore = true
        defer { loadingMore = false }
        let current = generation
        do {
            let page = try await api.album(folderId, sort: sort, descending: descending, cursor: cursor)
            guard current == generation else { return }
            let have = Set((items ?? []).map(\.id))
            items = (items ?? []) + page.items.filter { !have.contains($0.id) }
            nextCursor = page.nextCursor
        } catch {
            // The last cell stays: scrolling to it asks again.
        }
    }

    /// Every page (a random slideshow shuffles the whole album).
    func loadAll() async {
        var rounds = 0
        while nextCursor != nil, rounds < 100 {
            rounds += 1
            await loadMore()
        }
    }

    func reloadSoon() {
        reloadTask?.cancel()
        reloadTask = Task { [weak self] in
            try? await Task.sleep(for: Self.reloadDelay)
            guard !Task.isCancelled else { return }
            await self?.load()
        }
    }

    /// The album's root (to fall back to when it is gone).
    var rootId: String? { detail?.path.first?.id }
}

/// GET /drive/albums: the albums of every place I can read, newest first. `available` false: a server before AL1.
@MainActor
@Observable
final class AlbumListModel {
    private(set) var entries: [AlbumListEntryOut]?
    private(set) var nextCursor: String?
    private(set) var failure: String?
    private(set) var available: Bool?
    private(set) var loadingMore = false
    @ObservationIgnored private let api: AlbumApi?
    @ObservationIgnored let locationId: String?

    init(api: AlbumApi?, locationId: String? = nil) {
        self.api = api
        self.locationId = locationId
    }

    func load() async {
        guard let api else { return }
        do {
            let page = try await api.albums(locationId: locationId, cursor: nil)
            entries = page.items
            nextCursor = page.nextCursor
            failure = nil
            available = true
        } catch {
            guard !(error is CancellationError) else { return }
            if case ApiError.api(let status, _, _) = error, status == 404 || status == 405 {
                available = false
            } else if entries == nil {
                failure = ErrorMessages.text(for: error)
            }
        }
    }

    func loadMore() async {
        guard let api, let cursor = nextCursor, !loadingMore else { return }
        loadingMore = true
        defer { loadingMore = false }
        if let page = try? await api.albums(locationId: locationId, cursor: cursor) {
            let have = Set((entries ?? []).map(\.id))
            entries = (entries ?? []) + page.items.filter { !have.contains($0.id) }
            nextCursor = page.nextCursor
        }
    }
}

// MARK: the album screen

/// The photos the viewer pages through (an album's loaded photos) and where it opens.
struct AlbumPhotoViewing: Identifiable {
    let id = UUID()
    let attachments: [AttachmentOut]
    let start: Int
    let items: [String: DriveItemOut]
}

/// Where a slideshow starts.
struct AlbumSlideshowStart: Identifiable {
    let id = UUID()
    let items: [DriveItemOut]
    let startId: String?
}

/// An album folder (ALBUMS.md §10.2, §12): its name, dates, counts and description, 「スライドショー」 and 「写真を
/// 追加」, the grid by capture day, its subfolders and other files counted (「ファイルの一覧で見る」). `embedded`: in a
/// conversation's tab or a link's sheet (no bar of its own: the path and the actions sit at the top).
struct AlbumScreen: View {
    @Bindable var controller: AppController
    let folderId: String
    var embedded = false
    let onOpenFolder: (String) -> Void
    /// 「ファイルの一覧で見る」, and the folder is no album any more: the folder's list.
    let onShowList: () -> Void
    let onNotAlbum: () -> Void
    @State private var model: AlbumModel
    @State private var width: CGFloat = 0
    @State private var selecting = false
    @State private var selected: Set<String> = []
    @State private var photos: AlbumPhotoViewing?
    @State private var viewing: DriveViewing?
    @State private var details: DriveItemOut?
    @State private var slideshow: AlbumSlideshowStart?
    @State private var uploadAction: DriveUploadAction?
    @State private var showUploads = false
    @State private var onTop = false
    @State private var opening: String?
    @State private var saving = false
    @State private var expanded = false

    init(controller: AppController, folderId: String, embedded: Bool = false, onOpenFolder: @escaping (String) -> Void,
         onShowList: @escaping () -> Void, onNotAlbum: @escaping () -> Void) {
        _controller = Bindable(controller)
        self.folderId = folderId
        self.embedded = embedded
        self.onOpenFolder = onOpenFolder
        self.onShowList = onShowList
        self.onNotAlbum = onNotAlbum
        _model = State(initialValue: AlbumModel(folderId: folderId, api: controller.api))
    }

    private var hub: DriveHub? { controller.drive }
    private var uploads: DriveUploadCenter { .shared }
    private var account: String? { controller.activeWorkspace?.account }
    private var detail: AlbumDetailOut? { model.detail }
    private var title: String { detail?.folder.name ?? tr("アルバム") }
    /// The album's path down to itself (the server's `path` stops at its parent, as an item's does).
    private var fullPath: [DriveCrumb] {
        guard let detail else { return [] }
        return detail.path + [DriveCrumb(id: detail.folder.id, name: detail.folder.name)]
    }

    private var uploadTarget: DriveUploadTarget? {
        guard let detail, detail.canWrite else { return nil }
        let label = DriveRules.whereLabel(fullPath, kind: detail.locationKind)
        return DriveUploadTarget(parentId: folderId, locationId: detail.folder.locationId, label: label.isEmpty ? title : label)
    }

    var body: some View {
        content
            .modifier(AlbumChrome(embedded: embedded, title: title, actions: AnyView(actions)))
            .safeAreaInset(edge: .bottom, spacing: 0) { bottomBar }
            .modifier(DriveUploadActions(controller: controller, target: uploadTarget, action: $uploadAction, onFolderMade: { _ in },
                                         maxPhotos: nil, onConflict: "rename"))
            .sheet(isPresented: $showUploads) { DriveUploadsSheet(controller: controller) }
            .sheet(item: Binding(get: { onTop && !showUploads && !uploads.sheetOpen ? uploads.question(account: account) : nil },
                                 set: { _ in })) { question in
                DriveUploadQuestionView(question: question) { choice, all in uploads.answer(question, choice, all: all) }
            }
            .onAppear { onTop = true }
            .onDisappear { onTop = false }
            .task { if model.items == nil { await model.load() } }
            .onChange(of: uploads.doneCount(parentId: folderId)) { _, _ in model.reloadSoon() }
            .onChange(of: hub?.signal(folderId) ?? 0) { _, _ in model.reloadSoon() }
            .onChange(of: hub?.reconnects ?? 0) { _, _ in model.reloadSoon() }
            .onChange(of: model.gone) { _, gone in
                switch gone {
                case .notAlbum?: onNotAlbum()
                case .gone?: if let root = model.rootId, root != folderId { onOpenFolder(root) }
                case nil: break
                }
            }
            .fullScreenCover(item: $photos) { shown in
                ImageViewer(attachments: shown.attachments, start: shown.start, controller: controller,
                            load: { attachment in
                                if let display = await AlbumFiles.display(attachment.id, controller: controller) { return display }
                                guard let item = shown.items[attachment.id] else { return nil }
                                return await DriveFiles.viewFile(item, controller: controller)
                            },
                            extras: AlbumFiles.extras(items: shown.items, path: fullPath, kind: detail?.locationKind, controller: controller))
            }
            .fullScreenCover(item: $viewing) { DriveViewerView(viewing: $0, controller: controller) }
            .fullScreenCover(item: $slideshow) { start in AlbumSlideshow(controller: controller, items: start.items, startId: start.startId) }
            .sheet(item: $details) { item in
                DriveItemDetailsSheet(controller: controller, item: item, path: fullPath, kind: detail?.locationKind,
                                      siblings: model.items ?? [])
            }
    }

    @ViewBuilder
    private var content: some View {
        if let items = model.items {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    header
                    if items.isEmpty {
                        empty
                    } else {
                        grid(items)
                    }
                    footer
                }
                .padding(.bottom, 16)
            }
            .onGeometryChange(for: CGFloat.self, of: { $0.size.width }) { width = $0 }
            .refreshable { await model.load() }
        } else if model.gone == .gone {
            ContentUnavailableView("フォルダを表示できません", systemImage: "folder.badge.questionmark",
                                   description: Text("見る権限が無くなったか、移動・削除されました。"))
        } else if let failure = model.failure {
            ContentUnavailableView {
                Label("アルバムを読み込めませんでした", systemImage: "exclamationmark.triangle")
            } description: { Text(failure) } actions: {
                Button("再試行") { Task { await model.load() } }
            }
        } else {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    // MARK: header

    @ViewBuilder
    private var header: some View {
        if let detail {
            VStack(alignment: .leading, spacing: 8) {
                if embedded {
                    DriveBreadcrumbs(crumbs: DriveRules.crumbs(fullPath, kind: detail.locationKind), current: folderId, embedded: true,
                                     onOpen: onOpenFolder, trailing: AnyView(actions))
                    Text(detail.folder.name).font(.title2.weight(.bold)).lineLimit(2)
                } else {
                    Text(DriveRules.whereLabel(detail.path, kind: detail.locationKind))
                        .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                Text(AlbumRules.summary(detail.album)).font(.subheadline).foregroundStyle(.secondary)
                if !detail.album.description.isEmpty {
                    Text(detail.album.description).font(.subheadline)
                        .lineLimit(expanded ? nil : 3)
                        .fixedSize(horizontal: false, vertical: true)
                    if !expanded, detail.album.description.count > 90 || detail.album.description.contains("\n") {
                        Button("もっと見る") { expanded = true }.font(.subheadline)
                    }
                }
                HStack(spacing: 10) {
                    Button { startSlideshow(from: nil) } label: { Label("スライドショー", systemImage: "play.rectangle") }
                        .buttonStyle(.borderedProminent).prominentTint()
                        .disabled((model.items ?? []).isEmpty)
                    if uploadTarget != nil {
                        Button { uploadAction = .photos } label: { Label("写真を追加", systemImage: "plus") }
                            .buttonStyle(.bordered)
                    }
                }
                .font(.subheadline)
                .padding(.top, 2)
            }
            .padding(.horizontal, 16)
            .padding(.top, embedded ? 4 : 8)
        }
    }

    private var empty: some View {
        ContentUnavailableView {
            Label("写真はまだありません", systemImage: "photo.on.rectangle")
        } description: {
            if uploadTarget != nil { Text("「写真を追加」で端末の写真をまとめて上げられます。") }
        }
        .padding(.top, 24)
    }

    // MARK: the grid

    private func grid(_ items: [DriveItemOut]) -> some View {
        let count = AlbumRules.columns(width: width)
        let columns = Array(repeating: GridItem(.flexible(), spacing: 2), count: count)
        let side = width > 0 ? width / CGFloat(count) : 130
        let sections = AlbumRules.sections(items, sort: model.shownSort)
        return LazyVGrid(columns: columns, spacing: 2, pinnedViews: [.sectionHeaders]) {
            ForEach(sections) { section in
                Section {
                    ForEach(section.items) { item in
                        cell(item, pixels: side * (UIScreen.main.scale))
                            .onAppear { if item.id == items.last?.id { Task { await model.loadMore() } } }
                    }
                } header: {
                    if let title = section.title {
                        Text(title).font(.subheadline.weight(.semibold))
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 16).padding(.vertical, 6)
                            .background(.bar)
                            .accessibilityAddTraits(.isHeader)
                    }
                }
            }
        }
    }

    private func cell(_ item: DriveItemOut, pixels: CGFloat) -> some View {
        let video = AlbumRules.isVideo(item)
        let picture = item.file?.hasThumbnail == true || item.file?.hasPoster == true
        let chosen = selected.contains(item.id)
        return Button { tapped(item) } label: {
            Color.clear
                .aspectRatio(1, contentMode: .fit)
                .overlay {
                    AlbumThumb(controller: controller, attachmentId: picture ? item.file?.attachmentId : nil,
                               icon: DriveRules.icon(item), pixels: pixels)
                }
                .clipped()
                .overlay(alignment: .bottomLeading) {
                    if video {
                        HStack(spacing: 3) {
                            Image(systemName: "play.fill").font(.system(size: 9))
                            if let length = VideoDuration.text(item.file?.durationMs) { Text(length).font(.caption2.monospacedDigit()) }
                        }
                        .foregroundStyle(.white)
                        .padding(.horizontal, 5).padding(.vertical, 2)
                        .background(Color.black.opacity(0.55), in: Capsule())
                        .padding(4)
                    }
                }
                .overlay(alignment: .topTrailing) {
                    if selecting {
                        Image(systemName: chosen ? "checkmark.circle.fill" : "circle")
                            .font(.title3)
                            .foregroundStyle(chosen ? Color.accentColor : .white)
                            .background(Circle().fill(chosen ? Color.white : Color.black.opacity(0.25)).padding(2))
                            .padding(5)
                    }
                }
                .overlay { if opening == item.id { ProgressView() } }
                .opacity(selecting && !chosen ? 0.85 : 1)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(cellLabel(item)))
        .accessibilityAddTraits(chosen ? .isSelected : [])
        .contextMenu {
            Button("詳細", systemImage: "info.circle") { details = item }
            Button("写真アプリに保存", systemImage: "square.and.arrow.down") { save([item]) }
            Button("スライドショー（ここから）", systemImage: "play.rectangle") { startSlideshow(from: item.id) }
        }
    }

    private func cellLabel(_ item: DriveItemOut) -> String {
        var parts = [AlbumRules.isVideo(item) ? tr("動画 \(item.name)") : tr("写真 \(item.name)")]
        if let taken = item.file?.takenAt { parts.append(Timeline.fullLabel(taken)) }
        if AlbumRules.isVideo(item), let length = VideoDuration.text(item.file?.durationMs) { parts.append(length) }
        return parts.joined(separator: tr("、"))
    }

    @ViewBuilder
    private var footer: some View {
        if model.nextCursor != nil {
            HStack { Spacer(); ProgressView(); Spacer() }
                .padding(.vertical, 12)
                .onAppear { Task { await model.loadMore() } }
        }
        if let detail, detail.folderCount + detail.otherCount > 0 {
            Button(action: onShowList) {
                HStack(spacing: 10) {
                    Image(systemName: "folder").foregroundStyle(.secondary)
                    Text(AlbumScreen.othersLabel(folders: detail.folderCount, others: detail.otherCount))
                        .foregroundStyle(Color.primary)
                    Spacer(minLength: 0)
                    Text("ファイルの一覧で見る").font(.footnote).foregroundStyle(.secondary)
                    Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
                }
                .padding(12)
                .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(Color.secondary.opacity(0.18), lineWidth: 0.5))
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 16)
        }
    }

    /// 「フォルダ 2 件 · ほかのファイル 3 件」.
    static func othersLabel(folders: Int, others: Int) -> String {
        var parts: [String] = []
        if folders > 0 { parts.append(tr("フォルダ \(folders) 件")) }
        if others > 0 { parts.append(tr("ほかのファイル \(others) 件")) }
        return parts.joined(separator: " · ")
    }

    // MARK: bars and menus

    @ViewBuilder
    private var bottomBar: some View {
        if selecting {
            HStack(spacing: 12) {
                Text(tr("\(selected.count) 件を選択中")).font(.subheadline.weight(.medium)).monospacedDigit()
                Spacer(minLength: 0)
                if saving { ProgressView() }
                Button { save((model.items ?? []).filter { selected.contains($0.id) }) } label: {
                    Label("写真アプリに保存", systemImage: "square.and.arrow.down")
                }
                .disabled(selected.isEmpty || saving)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .background(.bar)
            .overlay(alignment: .top) { Divider() }
        } else {
            let totals = uploads.totals(account: account)
            let album = uploads.progress(parentId: folderId, account: account)
            if album != nil || DriveUploadsBar.shows(totals, preparing: uploads.preparing) {
                DriveUploadsBar(totals: totals, preparing: uploads.preparing, album: album) { showUploads = true }
            }
        }
    }

    @ViewBuilder
    private var actions: some View {
        HStack(spacing: 14) {
            if selecting {
                Button("完了") { selecting = false; selected = [] }
            } else {
                if uploadTarget != nil { DriveUploadMenu(action: $uploadAction, includesFolder: false) }
                moreMenu
            }
        }
    }

    private var moreMenu: some View {
        Menu {
            Button("選択", systemImage: "checkmark.circle") { selecting = true; selected = [] }
                .disabled((model.items ?? []).isEmpty)
            Picker("並べ替え", selection: Binding(get: { model.shownSort }, set: { setSort($0, descending: model.shownDescending) })) {
                ForEach(AlbumSort.allCases, id: \.self) { Text($0.title).tag($0) }
            }
            Picker("順序", selection: Binding(get: { model.shownDescending }, set: { setSort(model.shownSort, descending: $0) })) {
                Text(model.shownSort == .name ? "昇順" : "古い順").tag(false)
                Text(model.shownSort == .name ? "降順" : "新しい順").tag(true)
            }
            Divider()
            Button("ファイルの一覧で見る", systemImage: "list.bullet", action: onShowList)
            Button("リンクをコピー", systemImage: "link") { controller.copyDriveLink(folderId) }
        } label: {
            Image(systemName: "ellipsis.circle")
        }
        .accessibilityLabel(Text("アルバムの操作"))
    }

    private func setSort(_ sort: AlbumSort, descending: Bool) {
        guard sort != model.shownSort || descending != model.shownDescending else { return }
        model.sort = sort
        model.descending = descending
        Task { await model.load() }
    }

    // MARK: actions

    private func tapped(_ item: DriveItemOut) {
        if selecting {
            if selected.contains(item.id) { selected.remove(item.id) } else { selected.insert(item.id) }
            return
        }
        switch DriveRules.viewer(item) {
        case .image?:
            let shown = (model.items ?? []).filter { DriveRules.viewer($0) == .image }
            let attachments = shown.compactMap(DriveRules.attachment)
            let byAttachment = Dictionary(shown.compactMap { photo in photo.file.map { ($0.attachmentId, photo) } }, uniquingKeysWith: { a, _ in a })
            let start = attachments.firstIndex { $0.id == item.file?.attachmentId } ?? 0
            photos = AlbumPhotoViewing(attachments: attachments, start: start, items: byAttachment)
        case .video?, .document?:
            opening = item.id
            Task {
                defer { opening = nil }
                viewing = await DriveViewing.of(item, controller: controller)
            }
        case nil:
            // A HEIC from a desktop, a RAW: no thumbnail, no viewer (ALBUMS.md §6.3): its details.
            details = item
        }
    }

    private func startSlideshow(from id: String?) {
        Task {
            // Random order shuffles the whole album: the rest is read first.
            if UserDefaults.standard.bool(forKey: SlideshowSettings.randomKey) { await model.loadAll() }
            slideshow = AlbumSlideshowStart(items: model.items ?? [], startId: id)
        }
    }

    private func save(_ items: [DriveItemOut]) {
        guard !items.isEmpty else { return }
        saving = true
        Task {
            let message = await PhotoLibrarySaver.save(items, controller: controller)
            saving = false
            selecting = false
            selected = []
            controller.notice = message
        }
    }
}

/// The album's own screen: its name in the bar, the ＋ and ⋯ there. Embedded, the list's top holds them.
private struct AlbumChrome: ViewModifier {
    let embedded: Bool
    let title: String
    let actions: AnyView

    func body(content: Content) -> some View {
        if embedded {
            content
        } else {
            content
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .topBarTrailing) { actions } }
        }
    }
}

// MARK: the drives' list: albums in a row

/// The top of 「ドライブ」 (ALBUMS.md §12): the albums I can read, newest first, as covers in a row; the first tile makes
/// a new one where I can write. Hidden on a server without albums.
struct AlbumsStrip: View {
    @Bindable var controller: AppController
    let model: AlbumListModel
    let onOpenFolder: (String) -> Void
    let onNew: (() -> Void)?

    static let side: CGFloat = 116

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            LazyHStack(alignment: .top, spacing: 12) {
                if let onNew {
                    Button(action: onNew) {
                        VStack(alignment: .leading, spacing: 4) {
                            RoundedRectangle(cornerRadius: 10).stroke(Color.secondary.opacity(0.35), style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
                                .frame(width: Self.side, height: Self.side)
                                .overlay { Image(systemName: "plus").font(.title2).foregroundStyle(Color.accentColor) }
                            Text("新しいアルバム").font(.footnote.weight(.medium)).foregroundStyle(Color.primary).lineLimit(1)
                        }
                        .frame(width: Self.side)
                    }
                    .buttonStyle(.plain)
                }
                ForEach(model.entries ?? []) { entry in
                    Button { onOpenFolder(entry.folder.id) } label: { AlbumTile(controller: controller, entry: entry, side: Self.side) }
                        .buttonStyle(.plain)
                        .onAppear { if entry.id == model.entries?.last?.id { Task { await model.loadMore() } } }
                }
                if model.entries == nil {
                    ProgressView().frame(width: Self.side, height: Self.side)
                } else if model.entries?.isEmpty == true {
                    Text("アルバムはまだありません").font(.footnote).foregroundStyle(.secondary)
                        .frame(height: Self.side)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
        }
        // A lazy row in a list row is measured before its tiles: the cover and its three lines (Dynamic Type grows them).
        .frame(height: Self.side + 16 + lines)
    }

    @ScaledMetric(relativeTo: .footnote) private var lines: CGFloat = 58
}

/// An album's cover, name and 「312 枚 · 2026/9/16〜9/19」.
struct AlbumTile: View {
    @Bindable var controller: AppController
    let entry: AlbumListEntryOut
    let side: CGFloat

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            AlbumThumb(controller: controller, attachmentId: entry.album.cover?.attachmentId ?? entry.album.previewAttachmentIds.first,
                       icon: "photo.on.rectangle", pixels: side * 3)
                .frame(width: side, height: side)
                .clipShape(RoundedRectangle(cornerRadius: 10))
            Text(entry.folder.name).font(.footnote.weight(.medium)).foregroundStyle(Color.primary).lineLimit(1)
            Text(AlbumRules.countLabel(entry.album)).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
            Text(DriveRules.rootName(kind: entry.locationKind, serverName: entry.path.first?.name ?? ""))
                .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
        }
        .frame(width: side, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text([entry.folder.name, AlbumRules.summary(entry.album)].joined(separator: tr("、"))))
        .accessibilityAddTraits(.isButton)
    }
}

// MARK: a new album

/// 「新しいアルバム」 (ALBUMS.md §17 Q2): its name, where (a place I can write; it goes under that place's 「アルバム」
/// folder, made when missing), a description and the event's dates. Who sees it is who reads the place.
struct AlbumCreateSheet: View {
    @Bindable var controller: AppController
    let locations: [DriveLocationOut]
    let onCreated: (AlbumCreatedOut) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var locationId: String
    @State private var description = ""
    @State private var dated = false
    @State private var starts = Date()
    @State private var ends = Date()
    @State private var making = false
    @State private var failure: String?
    /// The same for every try of this sheet: a retry after a lost answer makes no second album.
    @State private var clientOpId = UUID().uuidString.lowercased()

    init(controller: AppController, locations: [DriveLocationOut], locationId: String?, name: String = "",
         onCreated: @escaping (AlbumCreatedOut) -> Void) {
        _controller = Bindable(controller)
        self.locations = locations
        self.onCreated = onCreated
        _name = State(initialValue: name)
        _locationId = State(initialValue: locationId.flatMap { id in locations.contains { $0.id == id } ? id : nil } ?? locations.first?.id ?? "")
    }

    private var location: DriveLocationOut? { locations.first { $0.id == locationId } }
    private func placeName(_ location: DriveLocationOut) -> String { DriveRules.rootName(kind: location.kind, serverName: location.name) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("アルバムの名前", text: $name)
                    if locations.count > 1 {
                        Picker("場所", selection: $locationId) {
                            ForEach(locations) { Text(placeName($0)).tag($0.id) }
                        }
                    } else if let location {
                        LabeledContent("場所", value: placeName(location))
                    }
                } footer: {
                    if let location {
                        Text(tr("「\(placeName(location)) › アルバム」に作ります。見られるのは、その場所を見られる人です。"))
                    }
                }
                Section("説明") {
                    TextField("学会・行事の説明（任意）", text: $description, axis: .vertical)
                        .lineLimit(2...6)
                }
                Section {
                    Toggle("日付を指定", isOn: $dated)
                    if dated {
                        DatePicker("始まり", selection: $starts, displayedComponents: .date)
                        DatePicker("終わり", selection: $ends, in: starts..., displayedComponents: .date)
                    }
                } footer: {
                    Text("指定しなければ、写真の撮影日の範囲を出します。")
                }
                if let failure {
                    Section { Text(failure).foregroundStyle(.red) }
                }
            }
            .navigationTitle("新しいアルバム")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("キャンセル") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    if making { ProgressView() } else {
                        Button("作成") { create() }
                            .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || location == nil)
                    }
                }
            }
            .onChange(of: starts) { _, start in if ends < start { ends = start } }
        }
        .interactiveDismissDisabled(making)
    }

    private func create() {
        guard let api = controller.api, let location else { return }
        let draft = AlbumDraft(name: name.trimmingCharacters(in: .whitespacesAndNewlines), locationId: location.id, parentId: nil,
                               description: description,
                               startsOn: dated ? AlbumRules.dayString(starts) : nil, endsOn: dated ? AlbumRules.dayString(ends) : nil)
        making = true
        failure = nil
        Task {
            defer { making = false }
            do {
                let made = try await api.createAlbum(draft, clientOpId: clientOpId)
                dismiss()
                onCreated(made)
            } catch {
                failure = controller.describe(error)
            }
        }
    }
}

extension DriveHub {
    /// The places a new album may go (I can write there), 研究室ドライブ first.
    var writableLocations: [DriveLocationOut] { DriveRules.ordered(locations ?? []).filter(\.canWrite) }
}

// MARK: a message's photos into an album (§9)

/// 「この投稿の写真をアルバムに」 from a message's long press: the albums I can add to (the conversation's drive first),
/// or a new one (by default in the channel's drive, named 「#学会 2026-09-16」). A posted file already in the album's
/// channel drive is moved, not copied (the message does not change); anything else is copied (the server decides).
struct AlbumPickerSheet: View {
    @Bindable var controller: AppController
    let message: MessageState
    @Environment(\.dismiss) private var dismiss
    @State private var list: AlbumListModel
    @State private var channelLocation: DriveLocationOut?
    @State private var adding: String?
    @State private var creating = false
    @State private var failure: String?
    /// One per sheet: a retry after a lost answer adds nothing twice.
    @State private var clientOpId = UUID().uuidString.lowercased()

    init(controller: AppController, message: MessageState) {
        _controller = Bindable(controller)
        self.message = message
        _list = State(initialValue: AlbumListModel(api: controller.api))
    }

    private var hub: DriveHub? { controller.drive }
    private var media: [AttachmentOut] { AlbumRules.messageMedia(message.attachments) }
    private var channel: ChannelOut? { controller.store.channel(message.channelId)?.channel }
    private var isChannel: Bool { channel?.type == "public" || channel?.type == "private" }

    private var entries: [AlbumListEntryOut] {
        AlbumRules.pickable(list.entries ?? [], writable: { hub?.location($0)?.canWrite == true }, channelLocationId: channelLocation?.id)
    }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Button { creating = true } label: {
                        Label("新しいアルバム", systemImage: "rectangle.stack.badge.plus")
                    }
                    .disabled(adding != nil || hub?.writableLocations.isEmpty != false)
                } footer: {
                    Text(tr("この投稿の写真・動画 \(media.count) 件をアルバムに入れます。"))
                }
                if let failure {
                    Section { Text(failure).foregroundStyle(.red) }
                }
                if list.available == false {
                    Text("このサーバはアルバムに対応していません").foregroundStyle(.secondary)
                } else if list.entries == nil {
                    if let error = list.failure {
                        Text(error).foregroundStyle(.secondary)
                    } else {
                        HStack { Spacer(); ProgressView(); Spacer() }
                    }
                } else if entries.isEmpty {
                    Text("追加できるアルバムはまだありません").foregroundStyle(.secondary)
                } else {
                    let own = entries.filter { $0.folder.locationId == channelLocation?.id }
                    let others = entries.filter { $0.folder.locationId != channelLocation?.id }
                    if !own.isEmpty {
                        Section(tr("#\(channel?.name ?? "") のドライブ")) { ForEach(own) { row($0) } }
                    }
                    if !others.isEmpty {
                        Section(own.isEmpty ? tr("アルバム") : tr("ほかのアルバム")) { ForEach(others) { row($0) } }
                    }
                    if list.nextCursor != nil {
                        Button("さらに表示") { Task { await list.loadMore() } }
                    }
                }
            }
            .navigationTitle("アルバムに追加")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("キャンセル") { dismiss() } } }
        }
        .interactiveDismissDisabled(adding != nil)
        .task {
            if hub?.locations == nil { await hub?.loadLocations() }
            if isChannel, let hub {
                channelLocation = hub.locations?.first { $0.kind == "channel" && $0.channelId == message.channelId }
                if channelLocation == nil { channelLocation = try? await hub.resolve(channelId: message.channelId) }
            }
            await list.load()
        }
        .sheet(isPresented: $creating) {
            AlbumCreateSheet(controller: controller, locations: hub?.writableLocations ?? [], locationId: defaultLocationId,
                             name: AlbumRules.defaultName(channelName: isChannel ? channel?.name : nil, postedAt: message.createdAt)) { made in
                add(to: made.folder.id, name: made.folder.name)
            }
        }
    }

    /// The channel's drive for a channel's message, else 研究室ドライブ (a DM has no drive of its own).
    private var defaultLocationId: String? {
        if let channelLocation, channelLocation.canWrite { return channelLocation.id }
        return hub?.writableLocations.first { $0.kind == "workspace" }?.id ?? hub?.writableLocations.first?.id
    }

    private func row(_ entry: AlbumListEntryOut) -> some View {
        Button { add(to: entry.folder.id, name: entry.folder.name) } label: {
            HStack(spacing: 12) {
                AlbumThumb(controller: controller, attachmentId: entry.album.cover?.attachmentId, icon: "photo.on.rectangle", pixels: 132)
                    .frame(width: 44, height: 44)
                    .clipShape(RoundedRectangle(cornerRadius: 6))
                VStack(alignment: .leading, spacing: 2) {
                    Text(entry.folder.name).foregroundStyle(Color.primary).lineLimit(1)
                    Text([AlbumRules.countLabel(entry.album), DriveRules.whereLabel(entry.path, kind: entry.locationKind)]
                        .filter { !$0.isEmpty }.joined(separator: " · "))
                        .font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
                Spacer(minLength: 0)
                if adding == entry.folder.id { ProgressView() }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(adding != nil)
    }

    private func add(to folderId: String, name: String) {
        guard let api = controller.api, !media.isEmpty else { return }
        adding = folderId
        failure = nil
        Task {
            defer { adding = nil }
            do {
                let out = try await api.addToAlbum(folderId, attachmentIds: media.map(\.id), itemIds: [], clientOpId: clientOpId)
                controller.notice = AlbumRules.addedNotice(out, album: name)
                dismiss()
            } catch {
                failure = controller.describe(error)
            }
        }
    }
}

// MARK: the `/d/` card of an album (§10.4)

/// A message's link to an album: four photos (2 × 2), its name, 「312 枚 · 2026/9/16〜9/19」 and where it is.
struct AlbumCardFace: View {
    @Bindable var controller: AppController
    let detail: DriveItemDetailOut
    let album: AlbumOut

    static let side: CGFloat = 64

    var body: some View {
        HStack(spacing: 10) {
            mosaic
            VStack(alignment: .leading, spacing: 2) {
                Text(detail.item.name).font(.subheadline.weight(.medium)).foregroundStyle(Color.primary).lineLimit(2)
                Text(AlbumRules.summary(album)).font(.caption).foregroundStyle(.secondary).lineLimit(1)
                let place = DriveRules.whereLabel(detail.path, kind: detail.locationKind)
                if !place.isEmpty {
                    Label(place, systemImage: "photo.on.rectangle").font(.caption).foregroundStyle(.secondary).lineLimit(1)
                }
            }
        }
    }

    private var mosaic: some View {
        let ids = Array(album.previewAttachmentIds.prefix(4))
        let half = (Self.side - 2) / 2
        return Group {
            if ids.count >= 2 {
                VStack(spacing: 2) {
                    ForEach(0..<2, id: \.self) { row in
                        HStack(spacing: 2) {
                            ForEach(0..<2, id: \.self) { column in
                                let i = row * 2 + column
                                AlbumThumb(controller: controller, attachmentId: ids.indices.contains(i) ? ids[i] : nil, icon: "photo", pixels: half * 3)
                                    .frame(width: half, height: half)
                            }
                        }
                    }
                }
            } else {
                AlbumThumb(controller: controller, attachmentId: ids.first, icon: "photo.on.rectangle", pixels: Self.side * 3)
                    .frame(width: Self.side, height: Self.side)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .accessibilityHidden(true)
    }
}
