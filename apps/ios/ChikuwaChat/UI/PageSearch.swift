import SwiftUI

/// M122 (docs/WIKI.md §8.1): the search's 「ドキュメント」 tab — wiki pages I can read whose title or body matches
/// (`GET /search/pages`). The words and typed modifiers (`in:ページの題名` = that page and the ones under it, `from:@人` =
/// who made or last changed it, `before:` / `after:` / `on:` = when it was updated) are the message search's; the chips
/// add the person and the dates. A hit shows the server's plain-text excerpt with the words marked, and opens the page.
@MainActor
@Observable
final class PageSearchResults {
    static let pageSize = 20

    private(set) var hits: [PageSearchHit] = []
    private(set) var keywords: [String] = []
    private(set) var total = 0
    private(set) var capped = false
    private(set) var hasMore = false
    private(set) var unresolved: [String] = []
    private(set) var loading = false
    private(set) var loaded = false
    private(set) var failure: String?
    /// Nothing a page could be searched by (no words, person or dates): nothing is sent.
    private(set) var empty = false
    @ObservationIgnored private var request = 0
    @ObservationIgnored private var key: String?

    init() {}

    /// Results known up front (snapshot tests).
    init(hits: [PageSearchHit], keywords: [String], total: Int) {
        self.hits = hits
        self.keywords = keywords
        self.total = total
        loaded = true
    }

    func reset() {
        request += 1
        hits = []
        keywords = []
        total = 0
        capped = false
        hasMore = false
        unresolved = []
        loading = false
        loaded = false
        failure = nil
        empty = false
        key = nil
    }

    /// The first page for `params`, unless it is already on screen.
    func show(_ params: SearchParams, api: ApiClient?) async {
        guard api != nil else { return }
        let search = SearchLogic.request(params)
        let key = "\(search.pageQueryItems(limit: 0, offset: 0))"
        guard key != self.key else { return }
        reset()
        self.key = key
        if search.pageIsEmpty {
            empty = true
            return
        }
        await load(search, api: api, more: false)
    }

    func loadMore(_ params: SearchParams, api: ApiClient?) async {
        guard hasMore, loaded, !loading else { return }
        await load(SearchLogic.request(params), api: api, more: true)
    }

    func retry(_ params: SearchParams, api: ApiClient?) async {
        let search = SearchLogic.request(params)
        guard !search.pageIsEmpty else { return }
        await load(search, api: api, more: !hits.isEmpty)
    }

    private func load(_ search: SearchRequest, api: ApiClient?, more: Bool) async {
        guard let api else { return }
        request += 1
        let id = request
        loading = true
        failure = nil
        do {
            let result = try await api.searchPages(search, limit: Self.pageSize, offset: more ? hits.count : 0)
            guard id == request else { return }
            let known = Set(hits.map(\.id))
            hits = more ? hits + result.hits.filter { !known.contains($0.id) } : result.hits
            keywords = result.keywords
            total = result.total ?? hits.count
            capped = result.totalCapped ?? false
            hasMore = result.hasMore
            unresolved = result.filters?.unresolved ?? []
            loaded = true
        } catch {
            guard id == request else { return }
            failure = ErrorMessages.text(for: error)
        }
        loading = false
    }
}

/// The 「ドキュメント」 tab's list: the hits (the page's place · who · when, the icon and title, the excerpt with the words
/// marked), endless paging.
struct PageSearchList: View {
    @Bindable var controller: AppController
    let results: PageSearchResults
    let params: SearchParams
    let onOpen: (String) -> Void

    var body: some View {
        List {
            if results.empty {
                Text("語を入れると、ドキュメントの題名と本文から探します。")
                    .font(.subheadline).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 40)
                    .listRowSeparator(.hidden)
            }
            if !results.unresolved.isEmpty {
                Label("ドキュメントには使えない条件があります：\(results.unresolved.joined(separator: " "))", systemImage: "exclamationmark.triangle")
                    .font(.footnote).foregroundStyle(.red)
                    .listRowSeparator(.hidden)
            }
            ForEach(results.hits) { hit in
                Button { onOpen(hit.page.id) } label: {
                    PageSearchRow(controller: controller, hit: hit, keywords: results.keywords)
                }
                .buttonStyle(.plain)
                .onAppear {
                    if hit.id == results.hits.last?.id { Task { await results.loadMore(params, api: controller.api) } }
                }
            }
            if results.loading {
                HStack(spacing: 8) {
                    Spacer()
                    ProgressView()
                    Text(results.hits.isEmpty ? "検索しています…" : "続きを読み込んでいます…").font(.footnote).foregroundStyle(.secondary)
                    Spacer()
                }
                .listRowSeparator(.hidden)
            }
            if let failure = results.failure {
                VStack(spacing: 8) {
                    Text(failure).font(.footnote).foregroundStyle(.red).multilineTextAlignment(.center)
                    Button("もう一度") { Task { await results.retry(params, api: controller.api) } }.buttonStyle(.bordered)
                }
                .frame(maxWidth: .infinity)
                .listRowSeparator(.hidden)
            }
        }
        .listStyle(.plain)
        .scrollDismissesKeyboard(.immediately)
        .overlay {
            if results.loaded && results.hits.isEmpty && !results.loading && results.failure == nil {
                ContentUnavailableView("ドキュメントは見つかりませんでした", systemImage: "doc.text.magnifyingglass",
                                       description: Text("自分が読めるページを、題名と本文から探します。"))
            }
        }
        .task { await results.show(params, api: controller.api) }
        .onChange(of: params) { _, next in Task { await results.show(next, api: controller.api) } }
    }
}

/// One page hit.
struct PageSearchRow: View {
    @Bindable var controller: AppController
    let hit: PageSearchHit
    let keywords: [String]

    var body: some View {
        let store = controller.store
        let page = hit.page
        let editor = store.users[page.updatedBy]?.displayName ?? (store.me?.id == page.updatedBy ? store.me?.displayName : nil) ?? tr("メンバー")
        let place = WikiText.place(page, tree: controller.wiki?.tree)
        let snippet = CanvasSearchResults.readableSnippet(Mentions.toNames(hit.snippet, users: store.users, groups: store.groups))
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 5) {
                Text(place).font(.caption.weight(.semibold)).lineLimit(1)
                Text("· \(editor)").font(.caption).lineLimit(1)
                Spacer(minLength: 6)
                Text(SearchResultRow.stamp(page.updatedAt)).font(.caption).fixedSize()
            }
            .foregroundStyle(.secondary)
            HStack(alignment: .top, spacing: 10) {
                WikiIconView(icon: page.icon, controller: controller, size: 20)
                    .frame(width: 34, height: 34)
                    .background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
                VStack(alignment: .leading, spacing: 3) {
                    Text(SearchHighlighter.attributed(page.displayTitle, keywords: keywords)).font(.subheadline.weight(.semibold)).lineLimit(1)
                    if !snippet.isEmpty {
                        Text(SearchHighlighter.attributed(snippet, keywords: keywords)).font(.subheadline).lineLimit(3)
                    }
                }
            }
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityHint("ページを開く")
    }
}
