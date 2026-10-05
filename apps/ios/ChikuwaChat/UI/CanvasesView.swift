import SwiftUI

/// M78 (CANVAS.md §21.1): what GET /canvases needs from the client (a fake in the tests).
protocol MyCanvasesApi: AnyObject {
    func myCanvases(cursor: String?, limit: Int) async throws -> CanvasPage
}

/// M78 (CANVAS.md §21.1, the desktop's CanvasesView): 「キャンバス」 of the home — the canvases of all my conversations,
/// most recently updated first, 50 at a time. A failed first page shows the canvases kept on this device (M74) instead,
/// marked offline. Pure over the store apart from the paging.
@MainActor
@Observable
final class CanvasesModel {
    static let pageSize = 50

    /// The pages read so far (nil: nothing yet).
    private(set) var items: [CanvasMeta]?
    private(set) var cursor: String?
    private(set) var loading = false
    /// The first page could not be read: `items` are the canvases kept on this device.
    private(set) var offline = false
    /// A refusal (not a network or server trouble): said in place of the list when there is nothing to show.
    private(set) var failure: String?

    @ObservationIgnored private var request = 0

    init(items: [CanvasMeta]? = nil, cursor: String? = nil, offline: Bool = false) {
        self.items = items
        self.cursor = cursor
        self.offline = offline
    }

    /// The first page (again: pull to refresh, the connection back). What to tell when a refresh failed while the list
    /// read before stays (nil otherwise: the offline mark or the refusal says it).
    @discardableResult
    func reload(api: MyCanvasesApi?, store: Store) async -> String? {
        request += 1
        let id = request
        guard let api else {
            fallBack(store)
            return nil
        }
        loading = true
        defer { if id == request { loading = false } }
        do {
            let page = try await api.myCanvases(cursor: nil, limit: Self.pageSize)
            guard id == request else { return nil }
            items = page.items
            cursor = page.nextCursor
            offline = false
            failure = nil
            return nil
        } catch {
            guard id == request else { return nil }
            if let apiError = error as? ApiError, !apiError.isRetryable {
                // Refused (signed out, …): the cache would hide that; what was shown stays.
                failure = ErrorMessages.text(for: error)
                if items == nil { items = [] }
                return nil
            }
            if items == nil || offline {
                fallBack(store)
                return nil
            }
            // A refresh that failed: the list read before stays (it is the server's, newer than the cache).
            return ErrorMessages.text(for: error)
        }
    }

    /// The next page, when the end of the list comes into view (never offline: the cache is shown whole).
    func loadMore(api: MyCanvasesApi?) async -> String? {
        guard let api, let cursor, !loading, !offline, let current = items else { return nil }
        let id = request
        loading = true
        defer { if id == request { loading = false } }
        do {
            let page = try await api.myCanvases(cursor: cursor, limit: Self.pageSize)
            guard id == request else { return nil }
            let known = Set(current.map(\.id))
            items = current + page.items.filter { !known.contains($0.id) }
            self.cursor = page.nextCursor
            return nil
        } catch {
            return id == request ? ErrorMessages.text(for: error) : nil
        }
    }

    private func fallBack(_ store: Store) {
        items = Self.cached(store)
        cursor = nil
        offline = true
        failure = nil
    }

    /// The canvases kept on this device (M74: only of my conversations), most recently updated first.
    static func cached(_ store: Store) -> [CanvasMeta] {
        Store.sortedCanvases(store.cachedCanvasIds.compactMap { store.cachedCanvasMeta($0) })
    }

    /// What the list shows: newer metadata this device knows (canvas.* events of the conversations opened) wins, a canvas
    /// moved to the trash or of a conversation I left goes, and the title filter (NFKC, any case).
    func rows(store: Store, query: String) -> [CanvasMeta] {
        let live = (items ?? []).map { canvas -> CanvasMeta in
            if let known = store.canvasMeta(canvas.id), known.version >= canvas.version { return known }
            return canvas
        }
        .filter { canvas in
            guard store.channel(canvas.channelId)?.isMember == true else { return false }
            guard let list = store.canvasesOf(canvas.channelId) else { return true }
            return list.contains { $0.id == canvas.id }
        }
        let needle = Self.fold(query.trimmingCharacters(in: .whitespacesAndNewlines))
        let shown = needle.isEmpty ? live : live.filter { Self.fold($0.title).contains(needle) }
        return Store.sortedCanvases(shown)
    }

    static func fold(_ text: String) -> String { text.precomposedStringWithCompatibilityMapping.lowercased() }

    /// The words to look for in the canvases' bodies (the search's 「キャンバス」 tab): nil when the field is blank.
    static func bodySearch(_ query: String) -> SearchParams? {
        let words = query.trimmingCharacters(in: .whitespacesAndNewlines)
        return words.isEmpty ? nil : SearchParams(q: words)
    }

    // MARK: a row's words

    static func title(_ canvas: CanvasMeta) -> String {
        let title = canvas.title.trimmingCharacters(in: .whitespacesAndNewlines)
        return title.isEmpty ? tr("無題のキャンバス") : title
    }

    /// Who saved it last (me too; someone this device does not know as 「メンバー」).
    static func editor(_ canvas: CanvasMeta, store: Store) -> String {
        store.users[canvas.updatedBy]?.displayName ?? (store.me?.id == canvas.updatedBy ? store.me?.displayName : nil) ?? tr("メンバー")
    }

    static func conversation(_ canvas: CanvasMeta, store: Store) -> String {
        store.channel(canvas.channelId).map { channelTitle($0, store: store) } ?? tr("会話")
    }

    /// VoiceOver: the title, the conversation's tab, where, who and when, the tasks.
    static func spoken(_ canvas: CanvasMeta, store: Store, now: Date = Date()) -> String {
        var parts = [title(canvas)]
        if canvas.isChannelTab { parts.append(tr("会話のタブ")) }
        parts.append(conversation(canvas, store: store))
        parts.append(tr("\(editor(canvas, store: store)) が更新"))
        let stamp = SearchResultRow.stamp(canvas.updatedAt, now: now)
        if !stamp.isEmpty { parts.append(stamp) }
        if canvas.taskTotal > 0 { parts.append(tr("タスク \(canvas.taskTotal) 件中 \(canvas.taskDone) 件完了")) }
        return parts.joined(separator: tr("、"))
    }
}

extension AppController {
    /// M78 (CANVAS.md §21.1): a row of the home's 「キャンバス」. As an activity row (M77): the canvas is chosen for its
    /// conversation's 「キャンバス」 tab and true says the caller pushes that conversation on its own stack (the home's);
    /// a conversation not on this device (or not mine any more) opens the canvas's own sheet, false.
    func openListedCanvas(_ canvas: CanvasMeta) async -> Bool {
        await openCanvas(canvas.id, channelId: canvas.channelId, navigate: false)
        return canvasOpen == CanvasOpen(canvasId: canvas.id, channelId: canvas.channelId)
    }
}

/// M78: the home tile's page.
struct CanvasesView: View {
    static let selectionId = "canvases"

    @Bindable var controller: AppController
    let onOpen: (CanvasMeta) -> Void
    /// Submitting the filter: the words searched in the canvases' bodies.
    let onSearch: (SearchParams) -> Void
    @State private var model = CanvasesModel()
    @State private var query = ""

    private var store: Store { controller.store }

    var body: some View {
        let rows = model.rows(store: store, query: query)
        let filtering = !query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        List {
            if model.offline {
                Label("オフライン — この端末に保存したキャンバスだけを表示しています", systemImage: "wifi.slash")
                    .font(.footnote)
                    .foregroundStyle(.orange)
                    .listRowSeparator(.hidden)
                    .accessibilityLabel("オフライン。この端末に保存したキャンバスだけを表示しています")
            }
            ForEach(rows) { canvas in
                Button { onOpen(canvas) } label: { CanvasesRow(controller: controller, canvas: canvas) }
                    .buttonStyle(.plain)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(CanvasesModel.spoken(canvas, store: store))
                    .accessibilityHint("会話の「キャンバス」で開きます")
                    .accessibilityAddTraits(.isButton)
            }
            if model.cursor != nil && !model.offline {
                if filtering {
                    Button("さらに読み込む") { Task { await more() } }
                        .frame(maxWidth: .infinity)
                } else {
                    HStack {
                        Spacer()
                        ProgressView()
                        Spacer()
                    }
                    .listRowSeparator(.hidden)
                    .onAppear { Task { await more() } }
                    .accessibilityLabel("続きを読み込んでいます")
                }
            }
            if filtering, !rows.isEmpty, let params = CanvasesModel.bodySearch(query) {
                Button("「\(params.q)」をキャンバスの本文からも検索") { onSearch(params) }
                    .font(.footnote)
                    .frame(maxWidth: .infinity)
                    .listRowSeparator(.hidden)
            }
        }
        .listStyle(.plain)
        .overlay {
            if model.items == nil {
                ProgressView()
            } else if rows.isEmpty {
                emptyState(filtering: filtering)
            }
        }
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "題名で絞り込む")
        .onSubmit(of: .search) { if let params = CanvasesModel.bodySearch(query) { onSearch(params) } }
        .navigationTitle("キャンバス")
        .navigationBarTitleDisplayMode(.inline)
        // Read again when the connection comes back (as the desktop does), which also clears the offline mark.
        .task(id: controller.engine?.status.rawValue ?? "") { await model.reload(api: controller.api, store: store) }
        .refreshable {
            if let error = await model.reload(api: controller.api, store: store) { controller.error = error }
        }
    }

    @ViewBuilder
    private func emptyState(filtering: Bool) -> some View {
        if let failure = model.failure {
            ContentUnavailableView("読み込めませんでした", systemImage: "exclamationmark.triangle", description: Text(failure))
        } else if filtering {
            ContentUnavailableView {
                Label("題名に一致するキャンバスはありません", systemImage: "doc.text.magnifyingglass")
            } description: {
                Text(model.offline ? "オフラインのため、この端末に保存したものだけを探しました。" : "本文に含まれる語は検索で探せます。")
            } actions: {
                if let params = CanvasesModel.bodySearch(query) {
                    Button("本文も検索する") { onSearch(params) }.buttonStyle(.bordered)
                }
            }
        } else if model.offline {
            ContentUnavailableView("オフラインです", systemImage: "wifi.slash",
                                   description: Text("この端末に保存したキャンバスはありません。接続すると一覧を読み込みます。"))
        } else {
            ContentUnavailableView("まだキャンバスはありません", systemImage: "doc.text",
                                   description: Text("会話の「キャンバス」から作れます。参加している会話のキャンバスがここに集まります。"))
        }
    }

    private func more() async {
        if let error = await model.loadMore(api: controller.api) { controller.error = error }
    }
}

/// One canvas: the title (and 「タブ」 for the conversation's tab), where · who · when, the tasks.
struct CanvasesRow: View {
    @Bindable var controller: AppController
    let canvas: CanvasMeta

    var body: some View {
        let store = controller.store
        HStack(spacing: 12) {
            Image(systemName: "doc.text")
                .font(.system(size: 17))
                .foregroundStyle(Color.accentColor)
                .frame(width: 36, height: 36)
                .background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(CanvasesModel.title(canvas)).font(.subheadline.weight(.semibold)).lineLimit(1)
                    if canvas.isChannelTab {
                        Text("タブ")
                            .font(.caption2.weight(.semibold))
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(Color.accentColor.opacity(0.15), in: Capsule())
                    }
                }
                Text("\(CanvasesModel.conversation(canvas, store: store)) · \(CanvasesModel.editor(canvas, store: store)) · \(SearchResultRow.stamp(canvas.updatedAt))")
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Spacer(minLength: 6)
            if let progress = CanvasText.taskProgress(total: canvas.taskTotal, done: canvas.taskDone) {
                Text(progress).font(.caption).foregroundStyle(.secondary).fixedSize()
            }
        }
        .padding(.vertical, 2)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
    }
}
