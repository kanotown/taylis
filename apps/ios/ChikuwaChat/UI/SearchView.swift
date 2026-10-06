import SwiftUI
import UIKit

/// Where a search result is opened: its conversation, pushed inside the search screen so that going back returns
/// to the same results.
struct SearchRoute: Hashable {
    let messageId: String
    let channelId: String
    let parentId: String?
}

enum SearchTab: String, CaseIterable, Identifiable {
    case messages, files, canvases // M58: 「キャンバス」 beside メッセージ / ファイル (CANVAS.md §4.8)

    var id: String { rawValue }
    var label: String {
        switch self {
        case .messages: tr("メッセージ")
        case .files: tr("ファイル")
        case .canvases: tr("キャンバス")
        }
    }
}

/// M58: a canvas search result opened inside the search screen (back returns to the results).
struct SearchCanvasRoute: Hashable {
    let canvasId: String
}

/// The filter pickers that need more room than a menu.
enum SearchPicker: String, Identifiable {
    case sender, channel, dates

    var id: String { rawValue }
}

/// M16b: the results on screen (messages page by page, and the files tab), kept while a result is open.
@MainActor
@Observable
final class SearchModel {
    static let pageSize = 30

    private(set) var params: SearchParams?
    var tab: SearchTab = .messages

    private(set) var hits: [SearchHit] = []
    private(set) var keywords: [String] = []
    private(set) var total = 0
    private(set) var capped = false
    private(set) var hasMore = false
    private(set) var unresolved: [String] = []
    /// L8: the hits' channels I am not a member of (SearchOut.channels: public times found with is:times), by id.
    private(set) var channels: [String: ChannelOut] = [:]
    private(set) var loading = false
    private(set) var loaded = false
    private(set) var failure: String?

    private(set) var files: [FileItem] = []
    private(set) var fileCursor: String?
    private(set) var filesLoading = false
    private(set) var filesLoaded = false
    private(set) var filesFailure: String?

    /// M58: the 「キャンバス」 tab's results (read when the tab shows).
    var canvases = CanvasSearchResults()

    @ObservationIgnored private var nextOffset = 0
    @ObservationIgnored private var request = 0
    @ObservationIgnored private var fileRequest = 0
    /// The words and conversation the file list belongs to (the files tab ignores the other filters).
    @ObservationIgnored private var filesKey: String?

    init() {}

    /// Results known up front (snapshot tests).
    init(params: SearchParams, hits: [SearchHit], keywords: [String], total: Int, capped: Bool = false, unresolved: [String] = []) {
        self.params = params
        self.hits = hits
        self.keywords = keywords
        self.total = total
        self.capped = capped
        self.unresolved = unresolved
        loaded = true
    }

    /// Back to the start page (no search).
    func clear() {
        request += 1
        fileRequest += 1
        params = nil
        resetMessages()
        resetFiles()
        canvases.reset()
    }

    /// A new search takes the screen at once; `load` fetches its first page.
    func begin(_ params: SearchParams) {
        request += 1
        fileRequest += 1
        self.params = params
        resetMessages()
        resetFiles()
        canvases.reset()
    }

    func load(api: ApiClient?) async {
        if tab == .files { await loadFiles(api: api, more: false) }
        await loadMessages(api: api, more: false)
    }

    /// The next page, when the end of the list comes into view.
    func loadMore(api: ApiClient?) async {
        guard hasMore, loaded, !loading else { return }
        await loadMessages(api: api, more: true)
    }

    func retry(api: ApiClient?) async {
        if tab == .files { await loadFiles(api: api, more: false) } else { await loadMessages(api: api, more: !hits.isEmpty) }
    }

    /// The files tab reads GET /files for the words (file names) and the conversation filter.
    func showFiles(api: ApiClient?) async {
        guard let params, filesKey != Self.filesKey(params) else { return }
        await loadFiles(api: api, more: false)
    }

    func loadMoreFiles(api: ApiClient?) async {
        guard fileCursor != nil, filesLoaded, !filesLoading else { return }
        await loadFiles(api: api, more: true)
    }

    private func resetMessages() {
        hits = []
        keywords = []
        total = 0
        capped = false
        hasMore = false
        unresolved = []
        channels = [:]
        loading = false
        loaded = false
        failure = nil
        nextOffset = 0
    }

    private func resetFiles() {
        files = []
        fileCursor = nil
        filesLoading = false
        filesLoaded = false
        filesFailure = nil
        filesKey = nil
    }

    private static func filesKey(_ params: SearchParams) -> String { "\(params.words)|\(params.channelId ?? "")" }

    private func loadMessages(api: ApiClient?, more: Bool) async {
        guard let api, let params, !params.isEmpty else { return }
        request += 1
        let id = request
        let offset = more ? nextOffset : 0
        loading = true
        failure = nil
        do {
            let result = try await api.searchMessages(SearchLogic.request(params), limit: Self.pageSize, offset: offset)
            guard id == request else { return }
            let known = Set(hits.map(\.id))
            hits = more ? hits + result.hits.filter { !known.contains($0.id) } : result.hits
            nextOffset = offset + result.hits.count
            keywords = result.keywords
            total = result.total ?? hits.count
            capped = result.totalCapped ?? false
            hasMore = result.hasMore
            unresolved = result.filters?.unresolved ?? []
            if !more { channels = [:] }
            for channel in result.channels ?? [] { channels[channel.id] = channel }
            loaded = true
        } catch {
            guard id == request else { return }
            failure = ErrorMessages.text(for: error)
        }
        loading = false
    }

    private func loadFiles(api: ApiClient?, more: Bool) async {
        guard let api, let params else { return }
        fileRequest += 1
        let id = fileRequest
        if !more {
            filesKey = Self.filesKey(params)
            files = []
            fileCursor = nil
            filesLoaded = false
        }
        filesLoading = true
        filesFailure = nil
        do {
            let page = try await api.listFiles(channelId: params.channelId, query: params.words.isEmpty ? nil : params.words, cursor: more ? fileCursor : nil)
            guard id == fileRequest else { return }
            files = more ? files + page.items : page.items
            fileCursor = page.nextCursor
            filesLoaded = true
        } catch {
            guard id == fileRequest else { return }
            filesFailure = ErrorMessages.text(for: error)
            if !more { filesKey = nil }
        }
        filesLoading = false
    }
}

/// M16b: search. The field takes the words and, as tokens, a sender and a conversation. Suggestions offer recent
/// searches and quick filters when it is empty, and the words, people and conversations while typing. The results
/// show the count, メッセージ / ファイル, filter chips and the order; a result opens its conversation here.
struct SearchView: View {
    @Bindable var controller: AppController
    /// M37: a search to run at once (「"語" をメッセージ検索」 or a recent search chosen in 移動・検索).
    var initial: SearchParams? = nil
    /// M78: the results tab `initial` shows first (the home's 「キャンバス」 searches the canvases' bodies).
    var initialTab: SearchTab? = nil
    @Environment(\.dismiss) private var dismiss

    @State private var model = SearchModel()
    @State private var path = NavigationPath()
    @State private var text = ""
    @State private var tokens: [SearchToken] = []
    @State private var searchPresented = false
    /// Suggestions show while the words are being edited; running a search hides them to show its results.
    @State private var editing = true
    /// Words the screen put into the field itself: that change does not reopen the suggestions.
    @State private var echo: String?
    @State private var recent: [SearchParams] = []
    @State private var picker: SearchPicker?
    /// Messages revealed from here: their focus goes when the screen closes.
    @State private var revealed: Set<String> = []
    /// M71: the 「AI に聞く」 sheet, and a cited message to open once it has gone.
    @State private var askSheet: AskSheetMode?
    @State private var askOpen: AiSourceOut?

    private var store: Store { controller.store }
    private var recentKey: String { controller.recentSearchKey }

    /// The field (words and tokens) over the filters of the search on screen.
    private var draft: SearchParams {
        var params = (model.params ?? SearchParams()).applying(tokens)
        params.q = text
        return params
    }

    var body: some View {
        NavigationStack(path: $path) {
            content
                .navigationTitle("検索")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("閉じる") { dismiss() } } }
                .searchable(text: $text, tokens: $tokens, isPresented: $searchPresented, placement: .navigationBarDrawer(displayMode: .always),
                            prompt: Text("メッセージ、人、チャンネルを検索")) { token in
                    Label(tokenTitle(token), systemImage: tokenImage(token))
                }
                .onSubmit(of: .search) { run(draft, remember: true) }
                .onChange(of: text) { _, value in
                    if let echo, echo == value { self.echo = nil; return }
                    echo = nil
                    editing = true
                }
                .onChange(of: tokens) { _, value in tokensEdited(value) }
                .onChange(of: searchPresented) { _, presented in
                    // The field's cancel button: back to the start page (閉じる closes the screen).
                    guard !presented, path.isEmpty else { return }
                    if model.params != nil || !text.isEmpty || !tokens.isEmpty { reset() }
                }
                .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
                    // The field got the focus again: suggestions for what is in it. Changed after the keyboard's
                    // animation has been set up, not inside it.
                    DispatchQueue.main.async {
                        if path.isEmpty && picker == nil && searchPresented { editing = true }
                    }
                }
                .navigationDestination(for: SearchRoute.self) { route in
                    SearchConversationView(controller: controller, route: route)
                }
                .navigationDestination(for: SearchCanvasRoute.self) { route in
                    CanvasOpenView(controller: controller, canvasId: route.canvasId, onTrashed: { if !path.isEmpty { path.removeLast() } })
                }
                // M71: the answer stays with the hub when the sheet goes (the row above the results brings it back); a
                // cited message opens here like a result, once the sheet is gone.
                .sheet(item: $askSheet, onDismiss: {
                    guard let source = askOpen else { return }
                    askOpen = nil
                    open(messageId: source.messageId, channelId: source.channelId, parentId: source.parentId)
                }) { mode in
                    AiAskSheet(controller: controller, hub: controller.aiHub ?? AiHub(api: nil), startInHistory: mode == .history) { source in
                        askOpen = source
                        askSheet = nil
                    }
                }
        }
        .overlay(alignment: .bottom) { ErrorToast(controller: controller) }
        .sheet(item: $picker) { which in
            switch which {
            case .sender:
                SearchPersonPicker(controller: controller, selected: draft.fromUserId) { id in update { $0.fromUserId = id } }
            case .channel:
                SearchChannelPicker(controller: controller, selected: draft.channelId) { id in update { $0.channelId = id } }
            case .dates:
                SearchDateRangeSheet(initial: draft.date) { date in update { $0.date = date } }
            }
        }
        .task {
            // The field is not activated by code: activating it shortly after the sheet comes up crashes inside UIKit
            // now and then on a cold start (iOS 27, keyframe animation over a _SwiftUILayerDelegate layer). The start
            // page offers recent searches and quick filters; a tap on the field starts typing.
            recent = RecentSearches.read(key: recentKey)
            if let initial, model.params == nil, !initial.isEmpty {
                if let initialTab { model.tab = initialTab }
                run(initial, remember: true)
            }
        }
        .onDisappear {
            if let focus = controller.messageFocus, revealed.contains(focus.messageId) { controller.messageFocus = nil }
            controller.aiHub?.closeAsk() // M71: only the asker sees it, and only while the search is open
        }
    }

    @ViewBuilder
    private var content: some View {
        if searchPresented && editing {
            // Suggestions as the screen's own list, not `.searchSuggestions`: that one is a results controller UIKit
            // animates in alongside the first keyboard, which crashes inside UIKit (iOS 27, _SwiftUILayerDelegate).
            List { suggestionRows }
                .listStyle(.insetGrouped)
                .scrollDismissesKeyboard(.immediately)
        } else if model.params != nil {
            SearchResultsView(controller: controller, model: model,
                              onUpdate: { change in update(change) },
                              onPick: { picker = $0 },
                              onOpen: { messageId, channelId, parentId in open(messageId: messageId, channelId: channelId, parentId: parentId) },
                              onOpenCanvas: { canvas in path.append(SearchCanvasRoute(canvasId: canvas.id)) },
                              onAskSheet: { askSheet = $0 })
        } else {
            List { startRows }
                .listStyle(.insetGrouped)
                .scrollDismissesKeyboard(.immediately)
        }
    }

    // MARK: suggestions and the start page

    @ViewBuilder
    private var suggestionRows: some View {
        let rows = SearchSuggestions.build(text, users: Array(store.users.values), channels: Array(store.channels.values), recent: recent,
                                           title: { channelTitle($0, store: store) })
        ForEach(SearchSuggestions.grouped(rows)) { section in
            Section {
                ForEach(section.rows) { row in suggestionRow(row) }
                if section.group == .recent && text.trimmingCharacters(in: .whitespaces).isEmpty { clearRecentButton }
            } header: {
                if let heading = section.group.heading { Text(heading) }
            }
        }
    }

    /// Without a search: the same rows as the empty field's suggestions, and a hint about typed conditions.
    @ViewBuilder
    private var startRows: some View {
        let rows = SearchSuggestions.build("", users: [], channels: [], recent: recent, title: { _ in "" })
        ForEach(SearchSuggestions.grouped(rows)) { section in
            Section {
                ForEach(section.rows) { row in suggestionRow(row) }
                if section.group == .recent { clearRecentButton }
            } header: {
                if let heading = section.group.heading { Text(heading) }
            }
        }
        Section {
            Text("語の中で from:@名前、in:#チャンネル、before:2026-09-01、has:file、is:thread、is:times のような条件も使えます。is:times は参加していない公開の times も探します。")
                .font(.footnote).foregroundStyle(.secondary)
        }
    }

    private var clearRecentButton: some View {
        Button("履歴を消去", role: .destructive) {
            RecentSearches.clear(key: recentKey)
            recent = []
        }
        .font(.subheadline)
    }

    @ViewBuilder
    private func suggestionRow(_ row: SearchSuggestion) -> some View {
        if case .recent(let params) = row {
            HStack(spacing: 12) {
                Button { choose(row) } label: {
                    Label { Text(describe(params)).lineLimit(1) } icon: { Image(systemName: "clock").foregroundStyle(.secondary) }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.borderless)
                .foregroundStyle(.primary)
                Button { recent = RecentSearches.remove(params, key: recentKey) } label: {
                    Image(systemName: "xmark").font(.footnote)
                }
                .buttonStyle(.borderless)
                .tint(.secondary)
                .accessibilityLabel("履歴から消す")
            }
        } else {
            Button { choose(row) } label: {
                SearchSuggestionLabel(row: row, controller: controller)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .foregroundStyle(.primary)
        }
    }

    private func describe(_ params: SearchParams) -> String {
        SearchLogic.describe(params, userName: { store.users[$0]?.displayName },
                             channelTitle: { id in store.channel(id).map { channelTitle($0, store: store) } })
    }

    private func tokenTitle(_ token: SearchToken) -> String {
        switch token {
        case .sender(let id): return store.users[id]?.displayName ?? "?"
        case .channel(let id):
            guard let channel = store.channel(id) else { return "?" }
            let title = channelTitle(channel, store: store)
            return channel.channel.isDm ? title : String(title.drop(while: { $0 == "#" }))
        }
    }

    private func tokenImage(_ token: SearchToken) -> String {
        switch token {
        case .sender: return "person"
        case .channel(let id):
            guard let channel = store.channel(id)?.channel else { return "number" }
            return channel.isDm ? "person.2" : channel.type == "private" ? "lock" : "number"
        }
    }

    // MARK: running searches

    /// A suggestion: people and conversations become the sender / conversation filter (the words named them), quick
    /// filters join the conditions on screen, a recent search comes back as it was.
    private func choose(_ row: SearchSuggestion) {
        var next = draft
        switch row {
        case .search(let words):
            next.q = words
        case .recent(let params):
            next = params
        case .user(let user):
            next.q = ""
            next.fromUserId = user.id
        case .channel(let id, _, _):
            next.q = ""
            next.channelId = id
        case .has(let flag):
            if !next.has.contains(flag) { next.has.append(flag) }
        case .thread:
            next.isThread = true
        case .times:
            next.isTimes = true
        }
        run(next, remember: true)
    }

    /// A chip or picker changed a filter of the search on screen.
    private func update(_ change: (inout SearchParams) -> Void) {
        var next = draft
        change(&next)
        run(next, remember: false)
    }

    /// A token was deleted in the field: the filter goes with it.
    private func tokensEdited(_ value: [SearchToken]) {
        guard let current = model.params else { return }
        var next = current.applying(value)
        guard next.fromUserId != current.fromUserId || next.channelId != current.channelId else { return }
        next.q = text
        run(next, remember: false, closeKeyboard: false)
    }

    private func run(_ params: SearchParams, remember: Bool, closeKeyboard: Bool = true) {
        var next = params
        next.q = params.words
        editing = false
        if text != next.q {
            echo = next.q
            text = next.q
        }
        if tokens != next.tokens { tokens = next.tokens }
        if closeKeyboard { UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil) }
        guard !next.isEmpty else {
            model.clear()
            return
        }
        if remember { recent = RecentSearches.push(next, key: recentKey) }
        model.begin(next)
        Task { await model.load(api: controller.api) }
    }

    private func reset() {
        model.clear()
        editing = true
        if !text.isEmpty {
            echo = ""
            text = ""
        }
        if !tokens.isEmpty { tokens = [] }
    }

    /// A result: its conversation around the message (or the thread for a reply), pushed on this screen. A channel I am
    /// not in (a public times found with is:times, L8) opens as its preview (M27) on the main screen, around the message.
    private func open(messageId: String, channelId: String, parentId: String?) {
        if store.channel(channelId)?.isMember != true {
            if store.channel(channelId) == nil {
                guard let channel = model.channels[channelId] else {
                    controller.error = tr("この会話は開けません")
                    return
                }
                store.upsertChannel(channel, isMember: false)
            }
            NotificationCenter.default.post(name: .chikuwaOpenChannel, object: nil, userInfo: ["id": channelId, "messageId": messageId])
            return
        }
        Task {
            guard await controller.revealMessage(id: messageId, channelId: channelId, parentId: parentId) else { return }
            revealed.insert(messageId)
            path.append(SearchRoute(messageId: messageId, channelId: channelId, parentId: parentId))
        }
    }
}

/// One suggestion row's content (the recent-search row has its own, with a remove button).
struct SearchSuggestionLabel: View {
    let row: SearchSuggestion
    @Bindable var controller: AppController

    var body: some View {
        switch row {
        case .search(let words):
            Label {
                Text("「\(Text(words).bold())」を検索").lineLimit(1)
            } icon: {
                Image(systemName: "magnifyingglass").foregroundStyle(.secondary)
            }
        case .recent(let params):
            Label(params.words, systemImage: "clock")
        case .user(let user):
            HStack(spacing: 10) {
                AvatarView(id: user.id, name: user.displayName, size: 26, presence: controller.store.presenceOf(user.id))
                Text(user.displayName).lineLimit(1)
                Text("@\(user.username)").font(.footnote).foregroundStyle(.secondary).lineLimit(1)
            }
        case .channel(_, let title, let type):
            Label {
                Text(type == "public" || type == "private" ? String(title.drop(while: { $0 == "#" })) : title).lineLimit(1)
            } icon: {
                Image(systemName: type == "private" ? "lock" : type == "public" ? "number" : "person.2").foregroundStyle(.secondary)
            }
        case .has(let flag):
            Label { Text("\(flag.label)のメッセージ") } icon: { Image(systemName: flag.systemImage).foregroundStyle(.secondary) }
        case .thread:
            Label { Text("スレッド内のメッセージ") } icon: { Image(systemName: "bubble.left.and.bubble.right").foregroundStyle(.secondary) }
        case .times:
            Label { Text("Times の投稿（is:times）") } icon: { Image(systemName: "newspaper").foregroundStyle(.secondary) }
        }
    }
}

// MARK: results

/// The results of the search on screen: tabs, filter chips, the count and order, and the endless list.
struct SearchResultsView: View {
    @Bindable var controller: AppController
    @Bindable var model: SearchModel
    let onUpdate: ((inout SearchParams) -> Void) -> Void
    let onPick: (SearchPicker) -> Void
    let onOpen: (_ messageId: String, _ channelId: String, _ parentId: String?) -> Void
    /// M58: a canvas hit of the 「キャンバス」 tab.
    var onOpenCanvas: (CanvasMeta) -> Void = { _ in }
    /// M71: the 「AI に聞く」 sheet, on the answer or on the past questions.
    var onAskSheet: (AskSheetMode) -> Void = { _ in }
    /// M71: where the question on screen would go (GET /ai/ask/target), for the question it was read for.
    @State private var askRead: AskTargetRead?

    private var params: SearchParams { model.params ?? SearchParams() }

    /// M71 (docs/AI.md §13.1): the words and the chips' filters as modifiers; the conversation goes as channel_id.
    private var askQuestion: String { AskRules.question(params, usernameOf: { controller.store.users[$0]?.username }) }
    private var askKey: String { "\(askQuestion)|\(params.channelId ?? "")" }

    var body: some View {
        VStack(spacing: 0) {
            Picker("表示", selection: $model.tab) {
                ForEach(SearchTab.allCases) { tab in Text(tab.label).tag(tab) }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal)
            .padding(.top, 8)
            SearchFilterBar(controller: controller, params: params, tab: model.tab, onUpdate: onUpdate, onPick: onPick)
            if model.tab != .files {
                let canvases = model.canvases
                let loaded = model.tab == .messages ? model.loaded : canvases.loaded
                HStack {
                    Text(loaded ? (model.tab == .messages ? SearchLogic.totalLabel(model.total, capped: model.capped)
                                                          : SearchLogic.totalLabel(canvases.total, capped: canvases.capped)) : " ")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Spacer()
                    sortMenu
                }
                .padding(.horizontal)
                .padding(.bottom, 6)
            }
            Divider()
            switch model.tab {
            case .messages:
                askRow
                messages
            case .files: files
            case .canvases: CanvasSearchList(controller: controller, results: model.canvases, params: params, onOpen: onOpenCanvas)
            }
        }
        .onChange(of: model.tab) { _, tab in
            if tab == .files { Task { await model.showFiles(api: controller.api) } }
        }
        // M71: where the question would go, read again when the question, the AI status or the connection changes, and
        // after a question was refused for an AI reason.
        .task(id: "\(askKey)|\(controller.aiHub?.summaryAvailable == true)|\(controller.engine?.status.rawValue ?? "")|\(controller.aiHub?.askTargetEpoch ?? 0)") {
            guard let hub = controller.aiHub, hub.summaryAvailable, !askQuestion.isEmpty else { return }
            let key = askKey
            let target = await hub.loadAskTarget(question: askQuestion, channelId: params.channelId)
            guard !Task.isCancelled else { return }
            askRead = AskTargetRead(key: key, target: target)
        }
    }

    /// M71 (docs/AI.md §13.6): 「AI に聞く」 above the message results — while AI can be used and the server told where
    /// this question would go, or while a question is followed. Above the list, so 「見つかりませんでした」 does not hide
    /// it (the AI searches with each word on its own and may find what the search did not).
    @ViewBuilder
    private var askRow: some View {
        if let hub = controller.aiHub {
            let question = askQuestion
            let target = askRead?.key == askKey ? askRead?.target : nil
            let usable = hub.summaryAvailable && !question.isEmpty && target != nil
            if usable || hub.ask != nil {
                AiAskBar(hub: hub, target: usable ? target : nil, canAsk: usable && AskRules.canAsk(target) && hub.ask?.phase.inProgress != true,
                         onAsk: {
                             Task { await hub.startAsk(AiAskRequest(question: question, channelId: params.channelId)) }
                             onAskSheet(.answer)
                         },
                         onSheet: onAskSheet)
                    .padding(.horizontal)
                    .padding(.vertical, 6)
                    .background(Color.accentColor.opacity(0.06))
                Divider()
            }
        }
    }

    private var messages: some View {
        List {
            ForEach(model.hits) { hit in
                Button { onOpen(hit.message.id, hit.message.channelId, hit.message.parentId) } label: {
                    SearchResultRow(controller: controller, message: hit.message, keywords: model.keywords,
                                    otherChannel: model.channels[hit.message.channelId])
                }
                .buttonStyle(.plain)
                .onAppear {
                    if hit.id == model.hits.last?.id { Task { await model.loadMore(api: controller.api) } }
                }
            }
            if model.loading { loadingRow(model.hits.isEmpty ? tr("検索しています…") : tr("続きを読み込んでいます…")) }
            if let failure = model.failure { failureRow(failure) }
        }
        .listStyle(.plain)
        .scrollDismissesKeyboard(.immediately)
        .overlay {
            if model.loaded && model.hits.isEmpty && !model.loading && model.failure == nil { emptyState }
        }
    }

    private var sortMenu: some View {
        Menu {
            Picker("並び順", selection: Binding(get: { params.effectiveSort }, set: { sort in onUpdate { $0.sort = sort } })) {
                ForEach(SearchSort.allCases) { sort in Text(sort.label).tag(sort) }
            }
        } label: {
            Label(params.effectiveSort.label, systemImage: "arrow.up.arrow.down").font(.subheadline)
        }
        .disabled(params.words.isEmpty)
        .accessibilityHint(params.words.isEmpty ? "語を入れると関連度順にできます" : "")
    }

    private var emptyState: some View {
        ContentUnavailableView {
            Label("見つかりませんでした", systemImage: "magnifyingglass")
        } description: {
            if !model.unresolved.isEmpty {
                Text("理解できない条件があります：\(model.unresolved.joined(separator: " "))\n名前や書き方を確かめてください。")
            } else {
                Text(params.hasFilters ? "条件を減らすと見つかるかもしれません。" : "別の言葉や、より短い言葉で試してください。")
            }
        } actions: {
            if params.hasFilters {
                Button("条件をクリアして検索") { onUpdate { $0 = $0.withoutFilters } }
                    .buttonStyle(.bordered)
            }
        }
    }

    private var files: some View {
        List {
            ForEach(model.files) { item in
                Button { onOpen(item.messageId, item.channelId, item.parentId) } label: { FileRowView(item: item, controller: controller) }
                    .buttonStyle(.plain)
                    .onAppear {
                        if item.id == model.files.last?.id { Task { await model.loadMoreFiles(api: controller.api) } }
                    }
            }
            if model.filesLoading { loadingRow(model.files.isEmpty ? tr("検索しています…") : tr("続きを読み込んでいます…")) }
            if let failure = model.filesFailure { failureRow(failure) }
        }
        .listStyle(.plain)
        .scrollDismissesKeyboard(.immediately)
        .overlay {
            if model.filesLoaded && model.files.isEmpty && !model.filesLoading && model.filesFailure == nil {
                ContentUnavailableView("ファイルは見つかりませんでした", systemImage: "doc", description: Text("ファイル名で探します。"))
            }
        }
        .task { await model.showFiles(api: controller.api) }
    }

    private func loadingRow(_ text: String) -> some View {
        HStack(spacing: 8) {
            Spacer()
            ProgressView()
            Text(text).font(.footnote).foregroundStyle(.secondary)
            Spacer()
        }
        .listRowSeparator(.hidden)
    }

    private func failureRow(_ text: String) -> some View {
        VStack(spacing: 8) {
            Text(text).font(.footnote).foregroundStyle(.red).multilineTextAlignment(.center)
            Button("もう一度") { Task { await model.retry(api: controller.api) } }.buttonStyle(.bordered)
        }
        .frame(maxWidth: .infinity)
        .listRowSeparator(.hidden)
    }
}

/// The filter chips under the tabs: 送信者 / チャンネル / 期間 / 種類 / スレッド内, each with × to remove it.
struct SearchFilterBar: View {
    @Bindable var controller: AppController
    let params: SearchParams
    /// The files tab filters by conversation only (GET /files); the canvases tab by person, conversation and dates (M58).
    let tab: SearchTab
    private var filesOnly: Bool { tab == .files }
    private var canvases: Bool { tab == .canvases }
    let onUpdate: ((inout SearchParams) -> Void) -> Void
    let onPick: (SearchPicker) -> Void

    private var store: Store { controller.store }

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                if !filesOnly {
                    let sender = params.fromUserId.map { store.users[$0]?.displayName ?? "?" }
                    SearchChip(active: sender != nil, onClear: { onUpdate { $0.fromUserId = nil } }) {
                        Button { onPick(.sender) } label: {
                            // A canvas's person is who made it or changed it last.
                            SearchChipLabel(title: sender.map { (canvases ? tr("作成・更新：") : tr("送信者：")) + $0 } ?? (canvases ? tr("作成・更新した人") : tr("送信者")),
                                            systemImage: "person", active: sender != nil)
                        }
                    }
                }
                let channel = params.channelId.map { id in store.channel(id).map { channelTitle($0, store: store) } ?? "?" }
                SearchChip(active: channel != nil, onClear: { onUpdate { $0.channelId = nil } }) {
                    Button { onPick(.channel) } label: { SearchChipLabel(title: channel ?? tr("チャンネル"), systemImage: "number", active: channel != nil) }
                }
                if !filesOnly {
                    let date = SearchLogic.dateLabel(params.date)
                    SearchChip(active: date != nil, onClear: { onUpdate { $0.date = nil } }) {
                        Menu {
                            ForEach(SearchDatePreset.allCases) { preset in
                                Button { onUpdate { $0.date = .preset(preset) } } label: {
                                    if params.date == .preset(preset) { Label(preset.label, systemImage: "checkmark") } else { Text(preset.label) }
                                }
                            }
                            Divider()
                            Button("日付を指定…", systemImage: "calendar") { onPick(.dates) }
                        } label: {
                            SearchChipLabel(title: date ?? tr("期間"), systemImage: "calendar", active: date != nil)
                        }
                    }
                }
                if !filesOnly && !canvases {
                    SearchChip(active: !params.has.isEmpty, onClear: { onUpdate { $0.has = [] } }) {
                        Menu {
                            ForEach(SearchHasFlag.allCases) { flag in
                                Toggle(isOn: Binding(get: { params.has.contains(flag) }, set: { on in
                                    onUpdate { next in
                                        if on { if !next.has.contains(flag) { next.has.append(flag) } } else { next.has.removeAll { $0 == flag } }
                                    }
                                })) {
                                    Label(flag.label, systemImage: flag.systemImage)
                                }
                            }
                        } label: {
                            SearchChipLabel(title: params.has.isEmpty ? tr("種類") : params.has.map(\.label).joined(separator: tr("・")), systemImage: "paperclip",
                                            active: !params.has.isEmpty)
                        }
                        .menuActionDismissBehavior(.disabled)
                    }
                    SearchChip(active: params.isThread, onClear: nil) {
                        Button { onUpdate { $0.isThread.toggle() } } label: {
                            SearchChipLabel(title: tr("スレッド内"), systemImage: "bubble.left.and.bubble.right", active: params.isThread, menu: false)
                        }
                        .accessibilityAddTraits(params.isThread ? .isSelected : [])
                    }
                    // L8 (TIMES_FEED.md §6): only times, the ones I am not in too.
                    SearchChip(active: params.isTimes, onClear: nil) {
                        Button { onUpdate { $0.isTimes.toggle() } } label: {
                            SearchChipLabel(title: "Times", systemImage: "newspaper", active: params.isTimes, menu: false)
                        }
                        .accessibilityAddTraits(params.isTimes ? .isSelected : [])
                    }
                }
                if filesOnly ? params.channelId != nil : params.hasFilters {
                    Button("条件をクリア") { onUpdate { $0 = $0.withoutFilters } }
                        .font(.subheadline)
                        .buttonStyle(.borderless)
                }
            }
            .padding(.horizontal)
            .padding(.vertical, 8)
        }
    }
}

/// A capsule for one filter: the control that sets it, and × once it is set.
struct SearchChip<Control: View>: View {
    let active: Bool
    let onClear: (() -> Void)?
    @ViewBuilder let control: () -> Control

    var body: some View {
        HStack(spacing: 2) {
            control()
                .buttonStyle(.plain)
            if active, let onClear {
                Button(action: onClear) {
                    Image(systemName: "xmark.circle.fill").imageScale(.medium)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("この条件を外す")
            }
        }
        .foregroundStyle(active ? Color.accentColor : Color.primary)
        .tint(active ? Color.accentColor : Color.primary)
        .padding(.leading, 12)
        .padding(.trailing, active && onClear != nil ? 7 : 12)
        .padding(.vertical, 6)
        .background(active ? Color.accentColor.opacity(0.14) : Color(.secondarySystemFill), in: Capsule())
    }
}

struct SearchChipLabel: View {
    let title: String
    let systemImage: String
    let active: Bool
    /// A chevron marks a chip that opens a choice.
    var menu = true

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: systemImage).imageScale(.small)
            Text(title).lineLimit(1)
            if menu && !active { Image(systemName: "chevron.down").imageScale(.small).foregroundStyle(.secondary) }
        }
        .font(.subheadline.weight(active ? .semibold : .regular))
        .frame(maxWidth: 240)
        .fixedSize(horizontal: true, vertical: false)
        .contentShape(Rectangle())
    }
}

/// One hit: the conversation, the thread mark, when, who, the highlighted words and the attachments.
struct SearchResultRow: View {
    @Bindable var controller: AppController
    let message: MessageOut
    let keywords: [String]
    /// L8: the hit's channel when the store does not know it (SearchOut.channels: an archived public times).
    var otherChannel: ChannelOut? = nil

    var body: some View {
        let store = controller.store
        let channel = store.channel(message.channelId)
        let sender = store.users[message.senderId]?.displayName ?? "?"
        let text = Timeline.excerpt(message.body, attachments: [], users: store.users, groups: store.groups)
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 5) {
                Image(systemName: conversationImage(channel?.channel ?? otherChannel)).imageScale(.small).foregroundStyle(.secondary)
                Text(conversationName(channel)).font(.caption.weight(.semibold)).foregroundStyle(.secondary).lineLimit(1)
                if channel?.isMember != true && (channel != nil || otherChannel != nil) {
                    Text("未参加")
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 6).padding(.vertical, 1)
                        .background(Color(.tertiarySystemFill), in: Capsule())
                        .fixedSize()
                }
                if message.parentId != nil {
                    Text("スレッドの返信")
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 6).padding(.vertical, 1)
                        .background(Color(.tertiarySystemFill), in: Capsule())
                        .fixedSize()
                }
                Spacer(minLength: 6)
                Text(Self.stamp(message.createdAt)).font(.caption).foregroundStyle(.secondary).fixedSize()
            }
            HStack(alignment: .top, spacing: 10) {
                AvatarView(id: message.senderId, name: sender, size: 34)
                VStack(alignment: .leading, spacing: 3) {
                    Text(sender).font(.subheadline.weight(.semibold)).lineLimit(1)
                    if !text.isEmpty {
                        CustomEmoji.excerpt(text, controller: controller, run: { Text(SearchHighlighter.attributed($0, keywords: keywords)) })
                            .font(.subheadline).lineLimit(3)
                    }
                    ForEach(message.attachments.prefix(3)) { attachment in
                        HStack(spacing: 4) {
                            Image(systemName: attachment.contentType.hasPrefix("image/") ? "photo" : "doc")
                            Text(SearchHighlighter.attributed(attachment.filename, keywords: keywords)).lineLimit(1)
                        }
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    }
                    if message.attachments.count > 3 {
                        Text("ほか \(message.attachments.count - 3) 件のファイル").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
    }

    private func conversationName(_ channel: ChannelState?) -> String {
        guard let channel else { return SearchLogic.otherChannelName(otherChannel) }
        let title = channelTitle(channel, store: controller.store)
        return channel.channel.isDm ? title : String(title.drop(while: { $0 == "#" }))
    }

    private func conversationImage(_ channel: ChannelOut?) -> String {
        guard let channel else { return "questionmark" }
        return channel.isDm ? (channel.type == "group_dm" ? "person.2" : "person") : channel.type == "private" ? "lock" : "number"
    }

    /// 「今日 15:30」「昨日 9:05」「9月26日 (金) 14:00」「2025年12月31日 (水) 14:00」 (MOBILE_POLISH.md S1: the rule
    /// Android's results follow too). The day is the conversation's date separator (Timeline.dayLabel), the time 24-hour
    /// as in the activity and the DM list, whatever the region's clock.
    static func stamp(_ iso: String, now: Date = Date(), calendar: Calendar = .current) -> String {
        guard let date = parseIsoDate(iso) else { return "" }
        let parts = calendar.dateComponents([.hour, .minute], from: date)
        return "\(Timeline.dayLabel(date, now: now, calendar: calendar)) " + String(format: "%d:%02d", parts.hour ?? 0, parts.minute ?? 0)
    }
}

/// A result's conversation inside the search screen, focused on the message (a reply opens its thread).
struct SearchConversationView: View {
    @Bindable var controller: AppController
    let route: SearchRoute
    @State private var threadId: String?
    @State private var previous: String?
    @State private var opened = false

    init(controller: AppController, route: SearchRoute) {
        self.controller = controller
        self.route = route
        _threadId = State(initialValue: route.parentId)
    }

    var body: some View {
        Group {
            if controller.store.channel(route.channelId) != nil {
                ChannelView(controller: controller, channelId: route.channelId, pendingThreadId: $threadId)
            } else {
                ContentUnavailableView("会話を開けません", systemImage: "bubble.left", description: Text("この会話のメンバーではなくなった可能性があります。"))
            }
        }
        .task {
            guard !opened, let engine = controller.engine else { return }
            opened = true
            previous = engine.currentChannelId
            await engine.openChannel(route.channelId)
        }
        .onDisappear {
            // Back to the results: the conversation behind the search is the open one again (notifications, §7).
            if let engine = controller.engine, engine.currentChannelId == route.channelId { engine.currentChannelId = previous }
        }
    }
}

// MARK: pickers

/// 送信者: the people I can see (deactivated accounts are left out), filtered by name.
struct SearchPersonPicker: View {
    @Bindable var controller: AppController
    let selected: String?
    let onPick: (String?) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    private var people: [UserPublic] {
        let needle = SearchSuggestions.fold(query.trimmingCharacters(in: .whitespaces))
        let japanese = Locale(identifier: "ja")
        return controller.store.users.values
            .filter { $0.deactivatedAt == nil && (needle.isEmpty || SearchSuggestions.fold($0.displayName).contains(needle) || SearchSuggestions.fold($0.username).contains(needle)) }
            .sorted { $0.displayName.compare($1.displayName, locale: japanese) == .orderedAscending }
    }

    var body: some View {
        NavigationStack {
            List {
                ForEach(people) { user in
                    Button {
                        onPick(user.id == selected ? nil : user.id)
                        dismiss()
                    } label: {
                        HStack(spacing: 12) {
                            AvatarView(id: user.id, name: user.displayName, size: 30)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(user.displayName).lineLimit(1)
                                Text("@\(user.username)").font(.caption).foregroundStyle(.secondary)
                            }
                            Spacer()
                            if user.id == selected { Image(systemName: "checkmark").foregroundStyle(Color.accentColor) }
                        }
                        .contentShape(Rectangle())
                    }
                    .foregroundStyle(.primary)
                }
                if people.isEmpty { Text("見つかりません").foregroundStyle(.secondary) }
            }
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "名前で絞り込む")
            .navigationTitle("送信者")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("キャンセル") { dismiss() } } }
        }
    }
}

/// チャンネル: the conversations I am in, filtered by name.
struct SearchChannelPicker: View {
    @Bindable var controller: AppController
    let selected: String?
    let onPick: (String?) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    private var conversations: [(state: ChannelState, title: String)] {
        let store = controller.store
        let needle = SearchSuggestions.fold(query.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: #"^[#@]"#, with: "", options: .regularExpression))
        let japanese = Locale(identifier: "ja")
        return store.channels.values
            .filter(\.isMember)
            .map { (state: $0, title: channelTitle($0, store: store)) }
            .filter { needle.isEmpty || SearchSuggestions.fold($0.title).contains(needle) }
            .sorted { $0.title.compare($1.title, locale: japanese) == .orderedAscending }
    }

    var body: some View {
        NavigationStack {
            List {
                ForEach(conversations, id: \.state.id) { row in
                    Button {
                        onPick(row.state.id == selected ? nil : row.state.id)
                        dismiss()
                    } label: {
                        HStack(spacing: 12) {
                            Image(systemName: row.state.channel.isDm ? "person.2" : row.state.channel.type == "private" ? "lock" : "number")
                                .foregroundStyle(.secondary).frame(width: 24)
                            Text(row.state.channel.isDm ? row.title : String(row.title.drop(while: { $0 == "#" }))).lineLimit(1)
                            Spacer()
                            if row.state.id == selected { Image(systemName: "checkmark").foregroundStyle(Color.accentColor) }
                        }
                        .contentShape(Rectangle())
                    }
                    .foregroundStyle(.primary)
                }
                if conversations.isEmpty { Text("見つかりません").foregroundStyle(.secondary) }
            }
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "会話の名前で絞り込む")
            .navigationTitle("チャンネル")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("キャンセル") { dismiss() } } }
        }
    }
}

/// 「日付を指定」: first and last day in this device's time zone (both included); either end may stay open.
struct SearchDateRangeSheet: View {
    let initial: SearchDate?
    let onApply: (SearchDate) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var useFrom = true
    @State private var useTo = true
    @State private var from = Date()
    @State private var to = Date()
    @State private var prepared = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Toggle("開始日", isOn: $useFrom)
                    if useFrom { DatePicker("開始日", selection: $from, displayedComponents: .date) }
                    Toggle("終了日", isOn: $useTo)
                    if useTo { DatePicker("終了日", selection: $to, displayedComponents: .date) }
                } footer: {
                    Text("この端末のタイムゾーンの日付で絞り込みます。開始日と終了日の当日も含みます。")
                }
            }
            .navigationTitle("日付を指定")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("キャンセル") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("絞り込む") {
                        let (start, end) = useFrom && useTo && from > to ? (to, from) : (from, to)
                        onApply(.range(from: useFrom ? SearchLogic.dayString(start) : nil, to: useTo ? SearchLogic.dayString(end) : nil))
                        dismiss()
                    }
                    .disabled(!useFrom && !useTo)
                }
            }
            .onAppear {
                guard !prepared else { return }
                prepared = true
                if case .range(let start, let end) = initial {
                    useFrom = start != nil
                    useTo = end != nil
                    if let day = SearchLogic.day(start) { from = day }
                    if let day = SearchLogic.day(end) { to = day }
                } else {
                    from = Calendar.current.date(byAdding: .day, value: -7, to: Date()) ?? Date()
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

/// Client-side keyword highlighting (the server only returns the keywords PGroonga matched).
enum SearchHighlighter {
    /// Sorted, non-overlapping ranges of every case-insensitive keyword occurrence, as UTF-16 offsets.
    static func ranges(in text: String, keywords: [String]) -> [Range<Int>] {
        let lower = text.lowercased() as NSString
        var found: [Range<Int>] = []
        for keyword in keywords.map({ $0.lowercased() }).filter({ !$0.isEmpty }).sorted(by: { $0.count > $1.count }) {
            var search = NSRange(location: 0, length: lower.length)
            while search.location < lower.length {
                let range = lower.range(of: keyword, options: [], range: search)
                if range.location == NSNotFound { break }
                found.append(range.location..<(range.location + range.length))
                search = NSRange(location: range.location + range.length, length: lower.length - range.location - range.length)
            }
        }
        found.sort { $0.lowerBound < $1.lowerBound }
        var merged: [Range<Int>] = []
        for range in found {
            if let last = merged.last, range.lowerBound <= last.upperBound {
                if range.upperBound > last.upperBound { merged[merged.count - 1] = last.lowerBound..<range.upperBound }
            } else {
                merged.append(range)
            }
        }
        return merged
    }

    static func attributed(_ text: String, keywords: [String]) -> AttributedString {
        var result = AttributedString(text)
        for range in ranges(in: text, keywords: keywords) {
            guard let swiftRange = Range(NSRange(location: range.lowerBound, length: range.count), in: text) else { continue }
            if let lower = AttributedString.Index(swiftRange.lowerBound, within: result), let upper = AttributedString.Index(swiftRange.upperBound, within: result) {
                result[lower..<upper].backgroundColor = .yellow.opacity(0.4)
                result[lower..<upper].inlinePresentationIntent = .stronglyEmphasized
            }
        }
        return result
    }
}
