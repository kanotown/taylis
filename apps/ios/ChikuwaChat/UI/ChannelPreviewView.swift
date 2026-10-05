import SwiftUI

/// The preview's join bar (M27): an archived channel offers no 「参加する」 (the server answers 409 channel_archived).
enum PreviewJoin {
    /// In place of the button when the channel is archived.
    static var archivedNote: String { tr("アーカイブされたチャンネルです（読むだけ）") }

    static func canJoin(_ channel: ChannelOut) -> Bool { !channel.archived }

    /// M89 (MEMBERSHIP.md §5 5.): the panel in place of the messages when the workspace turned the preview off (the
    /// errors.json `preview_disabled` words).
    static var refusedTitle: String { tr("参加するとメッセージを読めます") }

    /// Whether the preview shows the panel: the workspace's 「参加前にチャンネルの中を見られる」 is off, or the server
    /// answered 403 preview_disabled (it changed while this device was offline).
    static func refused(previewBeforeJoin: Bool, refusedByServer: Bool) -> Bool { !previewBeforeJoin || refusedByServer }

    /// A refusal of the preview by the server.
    static func isRefusal(_ error: Error) -> Bool {
        if case ApiError.api(403, "preview_disabled", _) = error { return true }
        return false
    }
}

/// The calls a preview makes (ApiClient; the tests' fakes).
@MainActor
protocol PreviewApi: AnyObject {
    func history(channelId: String, beforeSeq: Int?, limit: Int) async throws -> HistoryOut
    func messageContext(_ messageId: String) async throws -> [MessageOut]
    func replies(messageId: String) async throws -> [MessageOut]
    func message(id: String) async throws -> MessageOut
}

extension ApiClient: PreviewApi {}

/// The rows of a preview (M27) and the threads opened from it, kept out of the view so their loads can be checked.
///
/// Review v0.1.22 #6 (MEMBERSHIP.md §4): a page, an older page or a thread asked for before 「参加前にチャンネルの中を見られる」
/// turned off (or before the server refused the preview with 403) writes nothing back when it arrives: no rows, no
/// error. Each load takes the generation, which moves when the setting turns off and on a refusal, and after every await
/// checks the generation, the setting now and the channel before it writes.
@MainActor
@Observable
final class ChannelPreviewModel {
    /// A thread opened from the preview: its parent (when the preview did not hold it) and replies.
    struct ThreadRows: Equatable {
        var parent: MessageState?
        var replies: [MessageState] = []
        var loaded = false
    }

    static let pageSize = 50

    let channelId: String
    /// Oldest first, as the timeline shows them.
    private(set) var messages: [MessageState] = []
    private(set) var hasMore = false
    private(set) var loaded = false
    /// The first page (or a permalink's context) is on its way.
    private(set) var loading = false
    private(set) var loadingOlder = false
    private(set) var failure: String?
    /// The rows are the context of a permalink's message, not the newest page.
    private(set) var showingContext = false
    /// M89: the server answered 403 preview_disabled (the setting changed while offline); cleared when it turns on.
    private(set) var refusedByServer = false
    private(set) var threads: [String: ThreadRows] = [:]
    /// Moves when what was asked for before can no longer be written: the setting turned off, the server refused.
    private(set) var generation = 0

    @ObservationIgnored private let api: () -> PreviewApi?
    @ObservationIgnored private let enabled: () -> Bool
    @ObservationIgnored private let describe: (Error) -> String
    @ObservationIgnored private let report: (String) -> Void

    /// `enabled`: the workspace's preview_before_join now; `report`: an error worth a toast (an older page, a thread).
    init(channelId: String, api: @escaping () -> PreviewApi?, enabled: @escaping () -> Bool, describe: @escaping (Error) -> String,
         report: @escaping (String) -> Void) {
        self.channelId = channelId
        self.api = api
        self.enabled = enabled
        self.describe = describe
        self.report = report
    }

    /// An answer asked for at `generation` for `channelId` may still be written.
    private func current(_ generation: Int, _ channelId: String) -> Bool {
        generation == self.generation && channelId == self.channelId && enabled()
    }

    /// Opened (or back on screen): the first page, unless held, on its way or refused.
    func loadIfNeeded(focus: String?) {
        guard !loaded, !loading, !refusedByServer, enabled() else { return }
        loading = true // at once: a second call before the task starts asks for nothing
        Task { await load(focus: focus) }
    }

    /// The setting turned off: the rows go, and whatever is on its way is stale.
    func turnedOff() {
        generation += 1
        clearRows()
    }

    /// The setting turned on: the page loads.
    func turnedOn(focus: String?) {
        refusedByServer = false
        loadIfNeeded(focus: focus)
    }

    /// The newest page, or (a permalink, unless `latest`) the messages around the linked one.
    func load(focus: String?, latest: Bool = false) async {
        guard let api = api(), enabled() else { return }
        let asked = generation
        let channelId = channelId
        failure = nil
        loading = true
        do {
            if let focus, !latest {
                let rows = try await api.messageContext(focus)
                guard current(asked, channelId) else { return } // turned off or refused meanwhile: nothing written
                messages = Self.rows(rows)
                hasMore = true
                showingContext = true
            } else {
                let page = try await api.history(channelId: channelId, beforeSeq: nil, limit: Self.pageSize)
                guard current(asked, channelId) else { return }
                messages = Self.rows(page.messages)
                hasMore = page.hasMore
                showingContext = false
            }
            loaded = true
            loading = false
        } catch {
            guard current(asked, channelId) else { return } // stale: no error either
            loading = false
            if PreviewJoin.isRefusal(error) {
                refuse()
            } else {
                failure = describe(error)
            }
        }
    }

    func loadOlder() async {
        guard let api = api(), enabled(), !loadingOlder, let oldest = messages.first?.seq else { return }
        let asked = generation
        let channelId = channelId
        loadingOlder = true
        do {
            let page = try await api.history(channelId: channelId, beforeSeq: oldest, limit: Self.pageSize)
            guard current(asked, channelId) else { return }
            loadingOlder = false
            messages = Self.rows(page.messages) + messages
            hasMore = page.hasMore
        } catch {
            guard current(asked, channelId) else { return }
            loadingOlder = false
            if PreviewJoin.isRefusal(error) {
                refuse()
            } else {
                report(describe(error))
            }
        }
    }

    /// A thread opened from the preview: its parent when the preview does not hold it, then its replies.
    func loadThread(_ parentId: String) async {
        guard let api = api(), enabled(), !refusedByServer else { return }
        let asked = generation
        let channelId = channelId
        let held = messages.first { $0.id == parentId }
        do {
            if held == nil {
                let parent = MessageState(try await api.message(id: parentId))
                guard current(asked, channelId) else { return }
                threads[parentId, default: ThreadRows()].parent = parent
            } else {
                threads[parentId, default: ThreadRows()].parent = held
            }
            let replies = Self.rows(try await api.replies(messageId: parentId))
            guard current(asked, channelId) else { return }
            threads[parentId, default: ThreadRows()].replies = replies
            threads[parentId, default: ThreadRows()].loaded = true
        } catch {
            guard current(asked, channelId), !Task.isCancelled else { return }
            if PreviewJoin.isRefusal(error) {
                refuse()
            } else {
                threads[parentId, default: ThreadRows()].loaded = true
                report(describe(error))
            }
        }
    }

    /// The server refused the preview (403 preview_disabled): the panel says to join, anything else on its way is stale.
    private func refuse() {
        generation += 1
        clearRows()
        refusedByServer = true
    }

    private func clearRows() {
        messages = []
        hasMore = false
        loaded = false
        loading = false
        loadingOlder = false
        failure = nil
        showingContext = false
        threads = [:]
    }

    /// A page as the timeline shows it: oldest first, deleted ones left out.
    static func rows(_ page: [MessageOut]) -> [MessageState] {
        page.map(MessageState.init).filter { !$0.deleted }.sorted { ($0.seq ?? 0) < ($1.seq ?? 0) }
    }
}

/// A public channel read before joining (M27, SYNC_PROTOCOL.md §7.6.1; Slack): its messages as they are when opened,
/// read-only, and a bar to join. Only in memory: no cursor, no read position, nothing on disk. Events are for members,
/// so nothing new arrives while it is open; joining turns it into the channel itself (MainView shows ChannelView then).
struct ChannelPreviewView: View {
    @Bindable var controller: AppController
    let channelId: String
    /// A permalink's message: the preview opens around it (its context), 「最新へ」 goes to the newest page.
    var focusMessageId: String? = nil
    /// The rows, the threads opened from them and their loads (Review v0.1.22 #6).
    @State private var model: ChannelPreviewModel
    @State private var thread: ThreadTarget?
    @State private var joining = false
    /// The channel as `GET /channels/{id}` answers it, for the panel's member count when the list gave none.
    @State private var fetched: ChannelOut?
    @AppStorage(Timeline.groupingKey) private var grouping = false  // M47

    private static let margin: CGFloat = 12
    private var channel: ChannelState? { controller.store.channel(channelId) }
    private var previewBeforeJoin: Bool { controller.store.workspaceSettings.previewBeforeJoin }
    private var refused: Bool { PreviewJoin.refused(previewBeforeJoin: previewBeforeJoin, refusedByServer: model.refusedByServer) }
    private var messages: [MessageState] { model.messages }

    init(controller: AppController, channelId: String, focusMessageId: String? = nil) {
        _controller = Bindable(controller)
        self.channelId = channelId
        self.focusMessageId = focusMessageId
        _model = State(initialValue: ChannelPreviewModel(
            channelId: channelId,
            api: { [weak controller] in controller?.api },
            enabled: { [weak controller] in controller?.store.workspaceSettings.previewBeforeJoin ?? false },
            describe: { [weak controller] error in controller?.describe(error) ?? ErrorMessages.text(for: error) },
            report: { [weak controller] text in controller?.error = text }))
    }

    var body: some View {
        Group {
            if refused {
                refusedPanel
            } else {
                preview
            }
        }
        .navigationTitle(channel.map { channelTitle($0, store: controller.store) } ?? "")
        .navigationBarTitleDisplayMode(.inline)
        // Not `.task`: opened after going back from another conversation, the view went away and came back once as it
        // appeared, which cancelled the load, and a view that stays is not given its task again (it spun for ever).
        .onAppear { model.loadIfNeeded(focus: focusMessageId) }
        // M89: the setting changed while open: off, the rows go and the panel shows (and what is on its way is dropped,
        // Review v0.1.22 #6); on, the page loads.
        .onChange(of: previewBeforeJoin) { _, on in
            if on {
                model.turnedOn(focus: focusMessageId)
            } else {
                model.turnedOff()
            }
        }
        // Refused (the setting or the server): an open thread closes with the rows.
        .onChange(of: refused) { _, now in
            if now { thread = nil }
        }
        .sheet(item: $thread) { target in
            PreviewThreadView(controller: controller, model: model, parentId: target.id)
        }
    }

    /// M89 (MEMBERSHIP.md §5 5.): the preview is off: what the channel is (its description and member count) and one
    /// 「参加」 button; no history is asked for, and the join bar below is not shown (one button).
    private var refusedPanel: some View {
        let out = channel?.channel ?? fetched
        let count = channel?.channel.memberCount ?? fetched?.memberCount
        return ScrollView {
            VStack(spacing: 14) {
                Image(systemName: "lock.open").font(.largeTitle).foregroundStyle(.secondary)
                Text(PreviewJoin.refusedTitle).font(.headline)
                if let text = out?.purpose ?? out?.topic, !text.isEmpty {
                    Text(text).font(.subheadline).multilineTextAlignment(.center)
                }
                if let count { Text("メンバー \(count) 人").font(.subheadline).foregroundStyle(.secondary) }
                if let out, !PreviewJoin.canJoin(out) {
                    Text(PreviewJoin.archivedNote).font(.subheadline).foregroundStyle(.secondary)
                } else {
                    Button {
                        Task { await join() }
                    } label: {
                        Text(joining ? "参加しています…" : "参加").frame(minWidth: 120)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .disabled(joining || channel == nil)
                }
            }
            .padding(24)
            .frame(maxWidth: .infinity)
            .containerRelativeFrame(.horizontal)
        }
        .task {
            guard channel?.channel.memberCount == nil, fetched == nil, let api = controller.api else { return }
            fetched = try? await api.channel(id: channelId)
        }
    }

    private var preview: some View {
        VStack(spacing: 0) {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if model.hasMore {
                        Group {
                            if model.loadingOlder {
                                ProgressView().controlSize(.small)
                            } else {
                                Button("以前のメッセージを読み込む") { Task { await model.loadOlder() } }
                            }
                        }
                        .frame(maxWidth: .infinity)
                        .font(.footnote)
                        .padding(.vertical, 8)
                    } else if model.loaded, let channel {
                        ChannelIntroView(controller: controller, channel: channel).padding(.horizontal, Self.margin)
                    }
                    ForEach(Timeline.build(messages, firstUnreadAfterSeq: nil, meId: controller.store.me?.id, grouping: grouping)) { item in
                        switch item {
                        case .date(let label, _):
                            DaySeparator(label: label).padding(.horizontal, Self.margin)
                        case .unread:
                            EmptyView()
                        case .message(let message, let compact):
                            MessageRow(message: message, controller: controller, compact: compact, margin: Self.margin,
                                       onOpenThread: { thread = ThreadTarget(id: message.parentId ?? message.id) }, readOnly: true)
                        }
                    }
                }
                .padding(.vertical, 8)
                .containerRelativeFrame(.horizontal) // never wider than the list (ChannelView)
            }
            .defaultScrollAnchor(model.showingContext ? .center : .bottom)
            .overlay(alignment: .bottomTrailing) {
                if model.showingContext {
                    Button { Task { await model.load(focus: focusMessageId, latest: true) } } label: {
                        Label("最新へ", systemImage: "arrow.down").font(.footnote.bold())
                            .padding(.horizontal, 12).padding(.vertical, 8).background(.thinMaterial, in: Capsule())
                    }
                    .padding(12)
                }
            }
            .overlay {
                if let failure = model.failure {
                    ContentUnavailableView {
                        Label("読み込めませんでした", systemImage: "exclamationmark.triangle")
                    } description: {
                        Text(failure)
                    } actions: {
                        Button("再読み込み") { Task { await model.load(focus: focusMessageId) } }
                    }
                } else if !model.loaded {
                    ProgressView()
                }
            }
            joinBar
        }
    }

    private var joinBar: some View {
        VStack(spacing: 6) {
            if let channel, !PreviewJoin.canJoin(channel.channel) {
                Text(PreviewJoin.archivedNote).font(.subheadline).foregroundStyle(.secondary).frame(maxWidth: .infinity)
            } else {
                Text("プレビュー中です。参加すると投稿やリアクションができます。").font(.footnote).foregroundStyle(.secondary)
                Button {
                    Task { await join() }
                } label: {
                    Text(joining ? "参加しています…" : "#\(channel?.channel.name ?? "") に参加する").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(joining || channel == nil)
            }
        }
        .padding(12)
        .background(.bar)
    }

    private func join() async {
        guard let api = controller.api else { return }
        joining = true
        defer { joining = false }
        do {
            let joined = try await api.joinChannel(id: channelId)
            controller.store.upsertChannel(joined, isMember: true)
            await controller.engine?.openChannel(channelId)
        } catch { controller.error = controller.describe(error) }
    }
}

/// A thread read from a channel's preview (M27): the parent and its replies, fetched when opened (by the preview's
/// model, so a load from before the preview turned off writes nothing, Review v0.1.22 #6), and no input.
struct PreviewThreadView: View {
    @Bindable var controller: AppController
    let model: ChannelPreviewModel
    let parentId: String
    @Environment(\.dismiss) private var dismiss

    private static let margin: CGFloat = 16

    var body: some View {
        let thread = model.threads[parentId]
        let replies = thread?.replies ?? []
        let loaded = thread?.loaded ?? false
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if let parent = thread?.parent ?? model.messages.first(where: { $0.id == parentId }) {
                        MessageRow(message: parent, controller: controller, margin: Self.margin, readOnly: true)
                        Text(replies.isEmpty ? (loaded ? "返信はまだありません" : "読み込み中…") : "\(replies.count) 件の返信")
                            .font(.caption).foregroundStyle(.secondary).padding(.horizontal, Self.margin)
                        Divider().padding(.horizontal, Self.margin)
                        ForEach(replies) { reply in
                            MessageRow(message: reply, controller: controller, margin: Self.margin, readOnly: true)
                        }
                    } else if loaded {
                        Text("メッセージが見つかりません").foregroundStyle(.secondary).padding(.horizontal, Self.margin)
                    }
                }
                .padding(.vertical)
                .containerRelativeFrame(.horizontal)
            }
            .navigationTitle("スレッド")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("閉じる") { dismiss() } } }
            .task { await model.loadThread(parentId) }
        }
    }
}
