import SwiftUI

/// M58 (CANVAS.md §4.8, the desktop's M44 `ui/CanvasSearch.tsx`): the search's 「キャンバス」 tab — canvases of my
/// conversations whose title or body matches (`GET /search/canvases`). The words and typed modifiers (`in:#会話`,
/// `from:@人` = its creator or last editor, `before:` / `after:` / `on:` = when it was updated) are the message search's;
/// the chips add the person, the conversation and the dates. A hit shows the server's plain-text excerpt with the words
/// marked, and opens the canvas.
@MainActor
@Observable
final class CanvasSearchResults {
    static let pageSize = 20

    private(set) var hits: [CanvasSearchHit] = []
    private(set) var keywords: [String] = []
    private(set) var total = 0
    private(set) var capped = false
    private(set) var hasMore = false
    private(set) var unresolved: [String] = []
    private(set) var loading = false
    private(set) var loaded = false
    private(set) var failure: String?
    /// Nothing a canvas could be searched by (no words, person, conversation or dates): nothing is sent.
    private(set) var empty = false
    @ObservationIgnored private var request = 0
    /// The search the results belong to.
    @ObservationIgnored private var key: String?

    init() {}

    /// Results known up front (snapshot tests).
    init(hits: [CanvasSearchHit], keywords: [String], total: Int, unresolved: [String] = []) {
        self.hits = hits
        self.keywords = keywords
        self.total = total
        self.unresolved = unresolved
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
        guard api != nil else { return } // signed out (or results given up front)
        let search = SearchLogic.request(params)
        let key = "\(search.canvasQueryItems(limit: 0, offset: 0))"
        guard key != self.key else { return }
        reset()
        self.key = key
        if search.canvasIsEmpty {
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
        guard !search.canvasIsEmpty else { return }
        await load(search, api: api, more: !hits.isEmpty)
    }

    private func load(_ search: SearchRequest, api: ApiClient?, more: Bool) async {
        guard let api else { return }
        request += 1
        let id = request
        loading = true
        failure = nil
        do {
            let result = try await api.searchCanvases(search, limit: Self.pageSize, offset: more ? hits.count : 0)
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

    /// The server's excerpt is the body's plain text: an image reference reads as 「[画像]」 instead of its id.
    nonisolated static func readableSnippet(_ snippet: String) -> String {
        let ns = snippet as NSString
        var out = ""
        var last = 0
        for match in imageRef.matches(in: snippet, range: NSRange(location: 0, length: ns.length)) {
            out += ns.substring(with: NSRange(location: last, length: match.range.location - last))
            let alt = ns.substring(with: match.range(at: 1))
            out += alt.isEmpty ? "[画像]" : "[画像: \(alt)]"
            last = match.range.location + match.range.length
        }
        return out + ns.substring(from: last)
    }

    nonisolated private static let imageRef = try! NSRegularExpression(pattern: #"!\[([^\]\n]*)\]\(attachment:[0-9a-fA-F-]*\)?"#)
}

/// The 「キャンバス」 tab's list: the count, the hits (conversation · who · when, the title and the excerpt with the words
/// marked, the task progress), endless paging.
struct CanvasSearchList: View {
    @Bindable var controller: AppController
    let results: CanvasSearchResults
    let params: SearchParams
    let onOpen: (CanvasMeta) -> Void

    var body: some View {
        List {
            if results.empty {
                Text("語を入れると、キャンバスの題名と本文から探します。")
                    .font(.subheadline).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 40)
                    .listRowSeparator(.hidden)
            }
            if !results.unresolved.isEmpty {
                Label("キャンバスには使えない条件があります: \(results.unresolved.joined(separator: " "))", systemImage: "exclamationmark.triangle")
                    .font(.footnote).foregroundStyle(.red)
                    .listRowSeparator(.hidden)
            }
            ForEach(results.hits) { hit in
                Button { onOpen(hit.canvas) } label: {
                    CanvasSearchRow(controller: controller, hit: hit, keywords: results.keywords)
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
                ContentUnavailableView("キャンバスは見つかりませんでした", systemImage: "doc.text.magnifyingglass",
                                       description: Text("自分が参加している会話のキャンバスを、題名と本文から探します。"))
            }
        }
        .task { await results.show(params, api: controller.api) }
        .onChange(of: params) { _, next in Task { await results.show(next, api: controller.api) } }
    }
}

/// One canvas hit.
struct CanvasSearchRow: View {
    @Bindable var controller: AppController
    let hit: CanvasSearchHit
    let keywords: [String]

    var body: some View {
        let store = controller.store
        let canvas = hit.canvas
        let channel = store.channel(canvas.channelId)
        let editor = store.users[canvas.updatedBy]?.displayName ?? (store.me?.id == canvas.updatedBy ? store.me?.displayName : nil) ?? "メンバー"
        let snippet = CanvasSearchResults.readableSnippet(Mentions.toNames(hit.snippet, users: store.users, groups: store.groups))
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 5) {
                Text(channel.map { channelTitle($0, store: store) } ?? "会話").font(.caption.weight(.semibold)).lineLimit(1)
                Text("· \(editor)").font(.caption).lineLimit(1)
                Spacer(minLength: 6)
                Text(SearchResultRow.stamp(canvas.updatedAt)).font(.caption).fixedSize()
            }
            .foregroundStyle(.secondary)
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "doc.text")
                    .foregroundStyle(.tint)
                    .frame(width: 34, height: 34)
                    .background(Color.accentColor.opacity(0.12), in: RoundedRectangle(cornerRadius: 8))
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(SearchHighlighter.attributed(canvas.title, keywords: keywords)).font(.subheadline.weight(.semibold)).lineLimit(1)
                        if let progress = CanvasText.taskProgress(total: canvas.taskTotal, done: canvas.taskDone) {
                            Text(progress).font(.caption2).foregroundStyle(.secondary).monospacedDigit()
                        }
                    }
                    if !snippet.isEmpty {
                        Text(SearchHighlighter.attributed(snippet, keywords: keywords)).font(.subheadline).lineLimit(3)
                    }
                }
            }
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityHint("キャンバスを開く")
    }
}
